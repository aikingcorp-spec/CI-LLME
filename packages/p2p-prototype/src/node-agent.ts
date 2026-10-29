import type { RawData } from "ws";
import { WebSocket } from "ws";
import type { NodeId, RelayRequest } from "./protocol.js";
import { decodeGatewayFrame, encodeFrame, toWsUrl } from "./protocol.js";

export type LocalHandler = (req: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;

export interface NodeAgentOptions {
  gatewayUrl: string;
  nodeId: NodeId;
  token: string;
  handler: LocalHandler;
  reconnectMs?: number;
}
export interface NodeAgent {
  close(): Promise<void>;
  connected(): boolean;
}

const DEFAULT_RECONNECT_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const CLOSE_UNAUTHORIZED = 4401;
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const DECODED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

export function startNodeAgent(o: NodeAgentOptions): NodeAgent {
  const baseMs = o.reconnectMs ?? DEFAULT_RECONNECT_MS;
  let socket: WebSocket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let failures = 0;
  let welcomed = false;
  let stopped = false;

  const answer = async (ws: WebSocket, req: RelayRequest): Promise<void> => {
    const { status, headers, body } = await o
      .handler({
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: Buffer.from(req.body, "base64"),
      })
      .catch(() => ({ status: 500, headers: {}, body: new Uint8Array() }));
    if (ws.readyState === WebSocket.OPEN) {
      const encoded = Buffer.from(body).toString("base64");
      ws.send(encodeFrame({ kind: "response", id: req.id, status, headers, body: encoded }));
    }
  };

  const connect = (): void => {
    const ws = new WebSocket(`${toWsUrl(o.gatewayUrl)}/agent`);
    socket = ws;
    ws.on("open", () => ws.send(encodeFrame({ kind: "hello", nodeId: o.nodeId, token: o.token })));
    ws.on("message", (data: RawData) => {
      try {
        const frame = decodeGatewayFrame(data.toString());
        if (frame.kind === "welcome") {
          welcomed = true;
          failures = 0;
        } else if (frame.kind === "request") {
          void answer(ws, frame);
        }
      } catch {
        ws.close(1003, "bad frame");
      }
    });
    ws.on("error", () => {});
    ws.on("close", (code) => {
      welcomed = false;
      if (stopped || code === CLOSE_UNAUTHORIZED) return;
      const delay = Math.min(baseMs * 2 ** failures, Math.max(baseMs, MAX_BACKOFF_MS));
      failures += 1;
      timer = setTimeout(connect, delay);
    });
  };

  connect();

  return {
    connected: () => welcomed,
    close: async () => {
      stopped = true;
      clearTimeout(timer);
      const ws = socket;
      if (ws === undefined || ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close();
      });
    },
  };
}

export function httpForwardHandler(targetOrigin: string): LocalHandler {
  return async (req) => {
    const headers = { ...req.headers };
    delete headers.host;
    const res = await fetch(new URL(req.path, targetOrigin), {
      method: req.method,
      headers,
      body: BODYLESS_METHODS.has(req.method) ? undefined : req.body,
    });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (!DECODED_RESPONSE_HEADERS.has(k)) out[k] = v;
    });
    return { status: res.status, headers: out, body: new Uint8Array(await res.arrayBuffer()) };
  };
}
