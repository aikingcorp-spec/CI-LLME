import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface MinimalWebSocket {
  readonly open: boolean;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

function encodeWsFrame(opcode: number, payload: Buffer, maskClient: boolean): Buffer {
  const len = payload.length;
  const maskBit = maskClient ? 0x80 : 0;
  let headerLen = 2;
  if (len >= 126 && len <= 65535) headerLen = 4;
  else if (len > 65535) headerLen = 10;
  const maskKey = maskClient ? randomBytes(4) : null;
  const out = Buffer.allocUnsafe(headerLen + (maskKey ? 4 : 0) + len);
  out[0] = 0x80 | (opcode & 0x0f);
  let offset = 2;
  if (len < 126) {
    out[1] = maskBit | len;
  } else if (len <= 65535) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    out[1] = maskBit | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }
  if (maskKey) {
    maskKey.copy(out, offset);
    offset += 4;
    for (let i = 0; i < len; i += 1) {
      out[offset + i] = payload[i]! ^ maskKey[i & 3]!;
    }
  } else if (len > 0) {
    payload.copy(out, offset);
  }
  return out;
}

function attachWsStream(
  socket: Duplex,
  options: {
    isClient: boolean;
    maxPayloadBytes: number;
    initialChunk?: Buffer;
  },
): MinimalWebSocket {
  let closed = false;
  const messageListeners = new Set<(text: string) => void>();
  const closeListeners = new Set<() => void>();
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let fragments: Buffer<ArrayBufferLike>[] = [];
  let fragmentBytes = 0;
  let fragmentOpcode = 0;

  const notifyClose = () => {
    if (closed) return;
    closed = true;
    fragments = [];
    buffer = Buffer.alloc(0);
    for (const fn of closeListeners) {
      try {
        fn();
      } catch {
        /* ignore listener errors */
      }
    }
  };

  const failSocket = (code = 1002) => {
    if (!closed && !socket.destroyed && socket.writable) {
      const payload = Buffer.allocUnsafe(2);
      payload.writeUInt16BE(code, 0);
      socket.write(encodeWsFrame(0x8, payload, options.isClient));
    }
    socket.destroy();
    notifyClose();
  };

  const processBuffer = () => {
    while (!closed && buffer.length >= 2) {
      const first = buffer[0]!;
      const second = buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      if (rsv !== 0) {
        failSocket(1002);
        return;
      }
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if (!options.isClient && !masked) {
        failSocket(1002);
        return;
      }
      let payloadLen = second & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        const bigLen = buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(options.maxPayloadBytes)) {
          failSocket(1009);
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }
      if (payloadLen > options.maxPayloadBytes) {
        failSocket(1009);
        return;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + payloadLen) return;

      const payload = Buffer.from(buffer.subarray(offset, offset + payloadLen));
      if (masked) {
        for (let i = 0; i < payloadLen; i += 1) {
          payload[i] = payload[i]! ^ buffer[maskOffset + (i & 3)]!;
        }
      }
      buffer =
        offset + payloadLen === buffer.length
          ? Buffer.alloc(0)
          : Buffer.from(buffer.subarray(offset + payloadLen));

      if (opcode >= 0x8) {
        // Control frames (Close=0x8, Ping=0x9, Pong=0xA)
        if (!fin || payloadLen > 125) {
          failSocket(1002);
          return;
        }
        if (opcode === 0x8) {
          if (!socket.destroyed && socket.writable) {
            socket.write(encodeWsFrame(0x8, payload.subarray(0, 2), options.isClient));
          }
          socket.end();
          notifyClose();
          return;
        }
        if (opcode === 0x9 && !socket.destroyed && socket.writable) {
          socket.write(encodeWsFrame(0xa, payload, options.isClient));
        }
        continue;
      }

      if (opcode === 0x0) {
        if (fragmentOpcode === 0) {
          failSocket(1002);
          return;
        }
        fragmentBytes += payload.length;
        if (fragmentBytes > options.maxPayloadBytes) {
          failSocket(1009);
          return;
        }
        fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(fragments, fragmentBytes);
          fragments = [];
          fragmentBytes = 0;
          fragmentOpcode = 0;
          const text = full.toString("utf8");
          for (const fn of messageListeners) fn(text);
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fragmentOpcode !== 0) {
          failSocket(1002);
          return;
        }
        if (fin) {
          const text = payload.toString("utf8");
          for (const fn of messageListeners) fn(text);
        } else {
          fragmentOpcode = opcode;
          fragments = [payload];
          fragmentBytes = payload.length;
        }
      } else {
        failSocket(1003);
        return;
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    processBuffer();
  });
  socket.once("close", notifyClose);
  socket.once("end", notifyClose);
  socket.once("error", () => {
    socket.destroy();
    notifyClose();
  });

  if (options.initialChunk && options.initialChunk.length > 0) {
    buffer = Buffer.from(options.initialChunk);
    queueMicrotask(processBuffer);
  }

  return {
    get open() {
      return !closed && !socket.destroyed && socket.writable;
    },
    send(data) {
      if (closed || socket.destroyed || !socket.writable) return;
      const isBinary = typeof data !== "string";
      const payload = isBinary ? Buffer.from(data) : Buffer.from(data, "utf8");
      socket.write(encodeWsFrame(isBinary ? 0x2 : 0x1, payload, options.isClient));
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      if (!socket.destroyed && socket.writable) {
        const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 120);
        const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
        payload.writeUInt16BE(code, 0);
        reasonBytes.copy(payload, 2);
        socket.write(encodeWsFrame(0x8, payload, options.isClient));
        socket.end();
      } else {
        socket.destroy();
      }
      notifyClose();
    },
    onMessage(listener) {
      messageListeners.add(listener);
    },
    onClose(listener) {
      if (closed) queueMicrotask(listener);
      else closeListeners.add(listener);
    },
  };
}

export function acceptWebSocketUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  maxPayloadBytes = 256 * 1024,
): MinimalWebSocket | null {
  const upgrade = String(request.headers.upgrade ?? "").toLowerCase();
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  if (
    upgrade !== "websocket" ||
    typeof key !== "string" ||
    !key.trim() ||
    version !== "13" ||
    socket.destroyed
  ) {
    socket.destroy();
    return null;
  }
  if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") {
    socket.setNoDelay(true);
  }
  const accept = createHash("sha1")
    .update(key.trim() + WS_GUID)
    .digest("base64");
  const protocolHeader = request.headers["sec-websocket-protocol"];
  const chosenProtocol =
    typeof protocolHeader === "string"
      ? protocolHeader
          .split(",")
          .map((item) => item.trim())
          .find(Boolean)
      : undefined;
  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    ...(chosenProtocol ? [`Sec-WebSocket-Protocol: ${chosenProtocol}`] : []),
    "",
    "",
  ];
  socket.write(lines.join("\r\n"));
  return attachWsStream(socket, {
    isClient: false,
    maxPayloadBytes,
    initialChunk: head,
  });
}

export async function connectLocalWebSocket(
  wsUrl: string,
  options: { signal?: AbortSignal; maxPayloadBytes?: number } = {},
): Promise<MinimalWebSocket> {
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== "ws:") {
    throw new Error(`Unsupported local WebSocket protocol: ${parsed.protocol}`);
  }
  const port = Number(parsed.port || 80);
  const host = parsed.hostname;
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

  return new Promise<MinimalWebSocket>((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    let settled = false;
    let headerBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(error);
    };
    const onAbort = () => {
      fail(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error("WebSocket connect aborted"),
      );
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    socket.once("error", fail);
    socket.once("close", () => fail(new Error("WebSocket closed during handshake")));
    socket.once("connect", () => {
      const pathAndQuery = `${parsed.pathname || "/"}${parsed.search || ""}`;
      socket.write(
        [
          `GET ${pathAndQuery} HTTP/1.1`,
          `Host: ${host}:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });

    const onHandshakeData = (chunk: Buffer) => {
      headerBuf = headerBuf.length === 0 ? chunk : Buffer.concat([headerBuf, chunk]);
      if (headerBuf.length > 32 * 1024) {
        fail(new Error("WebSocket handshake header too large"));
        return;
      }
      const endIdx = headerBuf.indexOf("\r\n\r\n");
      if (endIdx < 0) return;
      socket.off("data", onHandshakeData);
      const headerText = headerBuf.subarray(0, endIdx).toString("latin1");
      const remainder = headerBuf.subarray(endIdx + 4);
      const lines = headerText.split("\r\n");
      if (!/^HTTP\/1\.1 101\b/i.test(lines[0] ?? "")) {
        fail(new Error(`WebSocket upgrade rejected: ${lines[0] ?? "empty"}`));
        return;
      }
      const acceptLine = lines.find((line) => /^sec-websocket-accept:/i.test(line));
      const actualAccept = acceptLine?.split(":").slice(1).join(":").trim();
      if (actualAccept !== expectedAccept) {
        fail(new Error("Invalid Sec-WebSocket-Accept header"));
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      socket.removeListener("error", fail);
      resolve(
        attachWsStream(socket, {
          isClient: true,
          maxPayloadBytes: options.maxPayloadBytes ?? 48 * 1024 * 1024,
          initialChunk: remainder,
        }),
      );
    };
    socket.on("data", onHandshakeData);
  });
}
