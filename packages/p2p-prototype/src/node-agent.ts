import type { RawData } from "ws";
import { WebSocket } from "ws";
import type { NodeAuth } from "./node-auth.js";
import { createNodeAuth } from "./node-auth.js";
import type { NodeChannelHandler } from "./node-channel-server.js";
import { createNodeChannelServer } from "./node-channel-server.js";
import type { KeyPair } from "./pairing.js";
import { signNodeProof } from "./pairing.js";
import type { NodeId, RelayRequest, SignalPayload } from "./protocol.js";
import { decodeGatewayFrame, encodeFrame, toWsUrl } from "./protocol.js";
import type { DataPeer, PeerOptions } from "./webrtc-peer.js";
import { connectPeer } from "./webrtc-peer.js";

export type LocalHandler = (req: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
  signal?: AbortSignal;
}) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;

export interface NodeAgentOptions {
  gatewayUrl: string;
  nodeId: NodeId;
  /** The node's own key pair; the hello is signed with it on every connect. */
  keyPair: KeyPair;
  /** Fresh relay credentials for each incoming attempt, resolved before constructing RTC. */
  iceServers?: () => Promise<NonNullable<PeerOptions["iceServers"]>>;
  handler: LocalHandler;
  channel?: {
    gatewayPublicKey: string;
    allowedUsers: Iterable<string>;
    handler: NodeChannelHandler;
  };
  reconnectMs?: number;
  clock?: () => number;
}
export interface NodeAgent {
  close(): Promise<void>;
  connected(): boolean;
  auth?: NodeAuth;
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
  const clock = o.clock ?? Date.now;
  let socket: WebSocket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let failures = 0;
  let welcomed = false;
  let stopped = false;

  const receivers = new Map<string, (payload: SignalPayload) => void>();
  const peers = new Set<DataPeer>();
  const attempts = new Map<string, { id: string; timer: NodeJS.Timeout; peer?: DataPeer }>();
  const attemptTimeoutMs = 15_000;
  const auth = o.channel
    ? createNodeAuth({
        nodeId: o.nodeId,
        keyPair: o.keyPair,
        gatewayPublicKey: o.channel.gatewayPublicKey,
        allowedUsers: o.channel.allowedUsers,
        clock,
        onRevoke: (session) => server?.onRevoke(session),
      })
    : undefined;
  const server = auth && o.channel ? createNodeChannelServer(auth, o.channel.handler) : undefined;
  const stopPeers = (): void => {
    for (const controller of requests.values()) controller.abort();
    for (const peer of peers) peer.close();
    peers.clear();
    receivers.clear();
    for (const attempt of attempts.values()) clearTimeout(attempt.timer);
    attempts.clear();
  };
  const signalPeer = (ws: WebSocket, from: string, payload: SignalPayload): void => {
    if (payload.type === "cancel") {
      const active = attempts.get(from);
      if (active?.id === payload.attemptId) {
        active.peer?.close();
        clearTimeout(active.timer);
        attempts.delete(from);
        receivers.delete(from);
      }
      return;
    }
    const attemptId = payload.attemptId;
    if (attemptId === undefined) return;
    const active = attempts.get(from);
    if (active !== undefined && active.id !== attemptId) {
      active.peer?.close();
      clearTimeout(active.timer);
      attempts.delete(from);
      receivers.delete(from);
    }
    const receive = receivers.get(from);
    if (receive) {
      receive(payload);
      return;
    }
    if (!server) return;
    const timer = setTimeout(() => {
      const current = attempts.get(from);
      if (current?.id !== attemptId) return;
      current.peer?.close();
      attempts.delete(from);
      receivers.delete(from);
    }, attemptTimeoutMs);
    attempts.set(from, { id: attemptId, timer });
    const pending: SignalPayload[] = [payload];
    receivers.set(from, (next) => pending.push(next));
    void (async () => {
      const iceServers = await o.iceServers?.();
      if (stopped || attempts.get(from)?.id !== attemptId || ws.readyState !== WebSocket.OPEN)
        return undefined;
      return connectPeer({
        iceServers,
        signalUrl: `${o.gatewayUrl}/signal`,
        selfId: o.nodeId,
        remoteId: from,
        initiator: false,
        attemptId,
        signaling: {
          send: (answer) => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(encodeFrame({ kind: "signal", from: o.nodeId, to: from, payload: answer }));
          },
          listen: (listener) => {
            receivers.set(from, listener);
            for (const queued of pending) listener(queued);
            return () => {
              if (receivers.get(from) === listener) receivers.delete(from);
            };
          },
        },
      });
    })()
      .then(async (peer) => {
        if (!peer) return;
        const current = attempts.get(from);
        if (current?.id !== attemptId) {
          clearTimeout(timer);
          peer.close();
          return;
        }
        current.peer = peer;
        if (stopped || ws.readyState !== WebSocket.OPEN) {
          clearTimeout(timer);
          attempts.delete(from);
          peer.close();
          return;
        }
        peers.add(peer);
        try {
          await server.accept(peer);
        } finally {
          peers.delete(peer);
          clearTimeout(timer);
          if (attempts.get(from)?.id === attemptId) attempts.delete(from);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        if (attempts.get(from)?.id === attemptId) {
          attempts.delete(from);
          receivers.delete(from);
        }
      });
  };

  const requests = new Map<string, AbortController>();
  const answer = async (ws: WebSocket, req: RelayRequest): Promise<void> => {
    const controller = new AbortController();
    requests.set(req.id, controller);
    const { status, headers, body } = await o
      .handler({
        signal: controller.signal,
        method: req.method,
        path: req.path,
        headers: req.headers,
        body: Buffer.from(req.body, "base64"),
      })
      .catch(() => ({ status: 500, headers: {}, body: new Uint8Array() }));
    requests.delete(req.id);
    if (!controller.signal.aborted && ws.readyState === WebSocket.OPEN) {
      const encoded = Buffer.from(body).toString("base64");
      ws.send(encodeFrame({ kind: "response", id: req.id, status, headers, body: encoded }));
    }
  };

  const connect = (): void => {
    // Workers selects the node's Durable Object before accepting the signed hello.
    const ws = new WebSocket(`${toWsUrl(o.gatewayUrl)}/agent?node=${encodeURIComponent(o.nodeId)}`);
    socket = ws;
    ws.on("open", () => {
      const { ts, sig } = signNodeProof(o.keyPair, "agent", o.nodeId, clock());
      ws.send(encodeFrame({ kind: "hello", nodeId: o.nodeId, ts, sig }));
    });
    ws.on("message", (data: RawData) => {
      try {
        const frame = decodeGatewayFrame(data.toString());
        if (frame.kind === "welcome") {
          welcomed = true;
          failures = 0;
        } else if (frame.kind === "cancel") {
          requests.get(frame.id)?.abort();
        } else if (frame.kind === "signal") {
          signalPeer(ws, frame.from, frame.payload);
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
      stopPeers();
      if (stopped || code === CLOSE_UNAUTHORIZED) return;
      const delay = Math.min(baseMs * 2 ** failures, Math.max(baseMs, MAX_BACKOFF_MS));
      failures += 1;
      timer = setTimeout(connect, delay);
    });
  };

  connect();

  return {
    connected: () => welcomed,
    auth,
    close: async () => {
      stopped = true;
      stopPeers();
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
      signal: req.signal,
      headers,
      body: BODYLESS_METHODS.has(req.method) ? undefined : new Uint8Array(req.body),
    });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (!DECODED_RESPONSE_HEADERS.has(k)) out[k] = v;
    });
    return { status: res.status, headers: out, body: new Uint8Array(await res.arrayBuffer()) };
  };
}
