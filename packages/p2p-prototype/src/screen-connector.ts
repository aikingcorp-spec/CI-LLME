import { once } from "node:events";
import { createWebSocketStream, WebSocket } from "ws";
import { isScreenSocketPath } from "./screen-path.js";
import type { ScreenSocket } from "./socket-session.js";

/** Only sealed screen capabilities at the configured local web service can be opened. */
export function createScreenConnector(webUrl: string, localHeaders: Record<string, string> = {}) {
  const origin = new URL(webUrl);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password)
    throw new Error("invalid local screen origin");
  return async (path: string, signal: AbortSignal): Promise<ScreenSocket> => {
    signal.throwIfAborted();
    if (!isScreenSocketPath(path)) throw new Error("invalid screen capability path");
    const target = new URL(path, origin);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(target, ["binary"], {
      headers: localHeaders,
      followRedirects: false,
      handshakeTimeout: 10000,
      maxPayload: 1024 * 1024,
    });
    const stream = createWebSocketStream(ws, { highWaterMark: 16384 });
    const close = () => {
      stream.destroy();
      ws.terminate();
    };
    signal.addEventListener("abort", close, { once: true });
    ws.once("close", () => signal.removeEventListener("abort", close));
    // All stream errors are also observed by its async iterator after the handshake.
    stream.on("error", () => {});
    try {
      await once(ws, "open", { signal });
    } catch {
      close();
      throw new Error("screen unavailable");
    }
    return {
      read: stream,
      write: (data) =>
        new Promise<void>((resolve, reject) =>
          stream.write(Buffer.from(data), (error) => (error ? reject(error) : resolve())),
        ),
      close,
    };
  };
}
