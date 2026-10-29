import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import type { NodeFrame, NodeId, RelayRequest, RelayResponse } from "./protocol.js";
import { decodeNodeFrame, encodeFrame } from "./protocol.js";

export interface GatewayOptions {
  port: number;
  host?: string;
  nodeTokens: Map<NodeId, string>;
  requestTimeoutMs?: number;
}
export interface Gateway {
  url: string;
  close(): Promise<void>;
  connectedNodes(): NodeId[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1 << 20;
const MAX_PENDING_SIGNALS = 32;
const CLOSE_BAD_FRAME = 1003;
const CLOSE_UNAUTHORIZED = 4401;
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "content-length", "transfer-encoding"]);

interface PendingRequest {
  nodeId: NodeId;
  timer: NodeJS.Timeout;
  settle(status: number, response?: RelayResponse): void;
}

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function tokenMatches(expected: string | undefined, given: string): boolean {
  return expected !== undefined && timingSafeEqual(digest(expected), digest(given));
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function respond(res: ServerResponse, status: number, text: string): number {
  res.writeHead(status, { "content-type": "text/plain" }).end(text);
  return status;
}

function relayRequestHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || DROPPED_REQUEST_HEADERS.has(k)) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

export async function startGateway(o: GatewayOptions): Promise<Gateway> {
  const timeoutMs = o.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nodes = new Map<NodeId, WebSocket>();
  const peers = new Map<string, WebSocket>();
  const queuedSignals = new Map<string, string[]>();
  const pending = new Map<string, PendingRequest>();
  const wss = new WebSocketServer({ noServer: true });

  const deliverSignal = (to: string, raw: string): void => {
    const target = peers.get(to) ?? nodes.get(to);
    if (target?.readyState === WebSocket.OPEN) {
      target.send(raw);
      return;
    }
    const queue = queuedSignals.get(to) ?? [];
    if (queue.length < MAX_PENDING_SIGNALS) queue.push(raw);
    queuedSignals.set(to, queue);
  };

  const flushSignals = (id: string, socket: WebSocket): void => {
    for (const raw of queuedSignals.get(id) ?? []) socket.send(raw);
    queuedSignals.delete(id);
  };

  const relaySignal = (from: string, frame: NodeFrame): void => {
    if (frame.kind === "signal") deliverSignal(frame.to, encodeFrame({ ...frame, from }));
  };

  const onFrames = (socket: WebSocket, handle: (raw: string) => void): void => {
    socket.on("message", (data: RawData) => {
      try {
        handle(data.toString());
      } catch {
        socket.close(CLOSE_BAD_FRAME, "bad frame");
      }
    });
  };

  const onAgent = (socket: WebSocket): void => {
    let nodeId: NodeId | undefined;
    const helloTimer = setTimeout(
      () => socket.close(CLOSE_UNAUTHORIZED, "hello timeout"),
      HELLO_TIMEOUT_MS,
    );
    onFrames(socket, (raw) => {
      const frame = decodeNodeFrame(raw);
      if (nodeId === undefined) {
        if (frame.kind !== "hello" || !tokenMatches(o.nodeTokens.get(frame.nodeId), frame.token)) {
          socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
          return;
        }
        clearTimeout(helloTimer);
        nodeId = frame.nodeId;
        nodes.get(nodeId)?.close(1000, "replaced");
        nodes.set(nodeId, socket);
        socket.send(encodeFrame({ kind: "welcome", nodeId }));
        flushSignals(nodeId, socket);
      } else if (frame.kind === "response") {
        pending.get(frame.id)?.settle(frame.status, frame);
      } else {
        relaySignal(nodeId, frame);
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (nodeId === undefined || nodes.get(nodeId) !== socket) return;
      nodes.delete(nodeId);
      for (const p of pending.values()) if (p.nodeId === nodeId) p.settle(502);
    });
  };

  const onSignal = (socket: WebSocket, peer: string): void => {
    peers.get(peer)?.close(1000, "replaced");
    peers.set(peer, socket);
    flushSignals(peer, socket);
    onFrames(socket, (raw) => relaySignal(peer, decodeNodeFrame(raw)));
    socket.on("close", () => {
      if (peers.get(peer) === socket) peers.delete(peer);
    });
  };

  const relayHttp = async (
    req: IncomingMessage,
    res: ServerResponse,
    encodedNodeId: string,
    path: string,
  ): Promise<number> => {
    const nodeId = decodeURIComponent(encodedNodeId);
    const node = nodes.get(nodeId);
    if (node === undefined) return respond(res, 502, "node offline");
    const body = await readBody(req);
    if (body === null) return respond(res, 413, "body too large");
    const relay: RelayRequest = {
      kind: "request",
      id: randomUUID(),
      method: req.method ?? "GET",
      path,
      headers: relayRequestHeaders(req),
      body: body.toString("base64"),
    };
    const answer = await new Promise<{ status: number; response?: RelayResponse }>((resolve) => {
      const settle = (status: number, response?: RelayResponse): void => {
        clearTimeout(entry.timer);
        pending.delete(relay.id);
        resolve({ status, response });
      };
      const timer = setTimeout(() => settle(504), timeoutMs);
      const entry: PendingRequest = { nodeId, settle, timer };
      pending.set(relay.id, entry);
      node.send(encodeFrame(relay));
    });
    if (answer.response === undefined) {
      return respond(res, answer.status, answer.status === 504 ? "node timeout" : "node offline");
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(answer.response.headers)) {
      if (!DROPPED_RESPONSE_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    res.writeHead(answer.response.status, headers).end(Buffer.from(answer.response.body, "base64"));
    return answer.response.status;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const method = req.method ?? "GET";
    const log = (status: number): void => console.log(`${method} ${url.pathname} ${status}`);
    const route = /^\/nodes\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (url.pathname === "/healthz") {
      log(respond(res, 200, "ok"));
    } else if (route?.[1] !== undefined) {
      const path = (route[2] ?? "/") + url.search;
      relayHttp(req, res, route[1], path).then(log, () => {
        if (!res.headersSent) respond(res, 500, "relay failed");
        log(500);
      });
    } else {
      log(respond(res, 404, "not found"));
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    const peer = url.searchParams.get("peer");
    const isAgent = url.pathname === "/agent";
    if (!isAgent && !(url.pathname === "/signal" && peer)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (isAgent) onAgent(ws);
      else onSignal(ws, peer as string);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", resolve);
  });
  const { address, port } = server.address() as AddressInfo;

  return {
    url: `http://${address.includes(":") ? `[${address}]` : address}:${port}`,
    connectedNodes: () => [...nodes.keys()],
    close: async () => {
      for (const p of pending.values()) p.settle(502);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
