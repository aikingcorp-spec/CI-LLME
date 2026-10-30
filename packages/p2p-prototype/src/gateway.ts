import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { RawData } from "ws";
import { WebSocket, WebSocketServer } from "ws";
import type { KeyPair } from "./pairing.js";
import {
  createPairingCodes,
  generateKeyPair,
  isPublicKey,
  nodeProofMessage,
  pairingMessage,
  parseNodeProof,
  signAssertion,
  verify,
  verifyAssertion,
} from "./pairing.js";
import type { Hello, NodeFrame, NodeId, RelayRequest, RelayResponse } from "./protocol.js";
import { decodeNodeFrame, encodeFrame } from "./protocol.js";
import type { UserVerifier } from "./session-verifier.js";
import type { TurnConfig } from "./turn-credentials.js";
import { mintTurnCredentials } from "./turn-credentials.js";

export interface NodeRecord {
  user: string;
  email: string;
  publicKey: string;
  revoked: boolean;
}
export interface GatewayOptions {
  port: number;
  host?: string;
  userVerifier: UserVerifier;
  /** Generated at start when omitted, so assertions do not survive a restart. */
  gatewayKey?: KeyPair;
  /** Paired nodes. Pass the same map to a restarted gateway to keep pairings. */
  registry?: Map<NodeId, NodeRecord>;
  clock?: () => number;
  requestTimeoutMs?: number;
  turn?: TurnConfig;
  pendingSignalTtlMs?: number;
  /**
   * Test-only. Enables the v0 HTTP relay, which forwards request and response bodies through the
   * gateway in plaintext. Off by default; no environment variable or entrypoint sets it. Real
   * traffic must use the end-to-end data channel.
   */
  unsafeTestOnlyPlaintextHttpRelay?: boolean;
}
export interface Gateway {
  url: string;
  /** Pinned by nodes at pairing; verifies assertions. */
  publicKey: string;
  close(): Promise<void>;
  connectedNodes(): NodeId[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1 << 20;
const MAX_PENDING_SIGNALS = 32;
const DEFAULT_PENDING_SIGNAL_TTL_MS = 15_000;
const ASSERTION_TTL_MS = 60_000;
const HELLO_SKEW_MS = 30_000;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const CLOSE_BAD_FRAME = 1003;
const CLOSE_FORBIDDEN_TARGET = 1008;
const CLOSE_UNAUTHORIZED = 4401;
const LOGGED_PATHS = new Set([
  "/agent",
  "/signal",
  "/healthz",
  "/pair/start",
  "/pair/complete",
  "/sessions",
  "/turn-credentials",
]);
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
]);
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "content-length", "transfer-encoding"]);

interface QueuedSignal {
  nodeId: NodeId;
  from: string;
  raw: string;
  expiresAt: number;
}

interface PeerEntry {
  socket: WebSocket;
  owner: string;
  nodeId: NodeId;
}

type Caller =
  | { kind: "client"; user: string; nodeId: NodeId; peerId: string; exp: number }
  | { kind: "node"; nodeId: NodeId; peerId: string };

interface PendingRequest {
  nodeId: NodeId;
  timer: NodeJS.Timeout;
  settle(status: number, response?: RelayResponse): void;
}

/** The credential of an `Authorization: <scheme> <credential>` header, scheme matched case-insensitively. */
function credential(req: IncomingMessage, scheme: string): string | undefined {
  const [given, value, ...rest] = (req.headers.authorization ?? "").split(" ");
  const ok = given?.toLowerCase() === scheme.toLowerCase() && rest.length === 0;
  return ok && value ? value : undefined;
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

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const body = await readBody(req);
  if (body === null) return undefined;
  try {
    const v: unknown = JSON.parse(body.toString());
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function respond(res: ServerResponse, status: number, text: string): number {
  res.writeHead(status, { "content-type": "text/plain" }).end(text);
  return status;
}

function respondJson(res: ServerResponse, status: number, body: unknown): number {
  res
    .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify(body));
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
  const signalTtlMs = o.pendingSignalTtlMs ?? DEFAULT_PENDING_SIGNAL_TTL_MS;
  const clock = o.clock ?? Date.now;
  const gatewayKey = o.gatewayKey ?? generateKeyPair();
  const registry = o.registry ?? new Map<NodeId, NodeRecord>();
  const pairing = createPairingCodes<{ id: string; email: string }>({ clock });
  const nodes = new Map<NodeId, WebSocket>();
  const peers = new Map<string, PeerEntry>();
  const queuedSignals = new Map<string, QueuedSignal[]>();
  const pending = new Map<string, PendingRequest>();
  const wss = new WebSocketServer({ noServer: true });

  // A signal for an offline peer belongs to a session that may already be dead; a stale offer or
  // candidate delivered to the next session's responder breaks ICE (ufrag mismatch).
  const liveQueue = (id: string): QueuedSignal[] => {
    const now = clock();
    const live = (queuedSignals.get(id) ?? []).filter((q) => q.expiresAt > now);
    if (live.length > 0) queuedSignals.set(id, live);
    else queuedSignals.delete(id);
    return live;
  };

  const deliverSignal = (from: string, to: string, raw: string, nodeId: NodeId): void => {
    // Prefer a dedicated signaling peer; otherwise wake the node agent.
    const entry = peers.get(to);
    if (entry !== undefined && entry.nodeId !== nodeId) return;
    const target = entry?.socket ?? (to === nodeId ? nodes.get(nodeId) : undefined);
    if (target?.readyState === WebSocket.OPEN) {
      target.send(raw);
      return;
    }
    const queue = liveQueue(to);
    if (queue.length < MAX_PENDING_SIGNALS) {
      queue.push({ nodeId, from, raw, expiresAt: clock() + signalTtlMs });
      queuedSignals.set(to, queue);
    }
  };

  const flushSignals = (id: string, socket: WebSocket, nodeId: NodeId): void => {
    for (const q of liveQueue(id)) if (q.nodeId === nodeId) socket.send(q.raw);
    queuedSignals.delete(id);
  };

  const dropSignalsFrom = (from: string): void => {
    for (const [to, queue] of queuedSignals) {
      const kept = queue.filter((q) => q.from !== from);
      if (kept.length > 0) queuedSignals.set(to, kept);
      else queuedSignals.delete(to);
    }
  };

  const relaySignal = (from: string, frame: NodeFrame, nodeId: NodeId): void => {
    if (frame.kind === "signal")
      deliverSignal(from, frame.to, encodeFrame({ ...frame, from }), nodeId);
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

  const decodeHello = (raw: string): Hello | undefined => {
    try {
      const frame = decodeNodeFrame(raw);
      return frame.kind === "hello" ? frame : undefined;
    } catch {
      return undefined;
    }
  };

  // Unknown and revoked nodes fail the same way as a bad signature.
  const nodeProofValid = (scope: "agent" | "signal", nodeId: NodeId, ts: number, sig: string) => {
    const record = registry.get(nodeId);
    return (
      record !== undefined &&
      !record.revoked &&
      Math.abs(clock() - ts) <= HELLO_SKEW_MS &&
      verify(record.publicKey, nodeProofMessage(scope, nodeId, ts), sig)
    );
  };

  const userFor = async (req: IncomingMessage, res: ServerResponse) => {
    const result = await o.userVerifier.verify({
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
    });
    if (!result.ok) {
      respondJson(res, result.status, { code: result.code });
      return undefined;
    }
    return result.user;
  };

  const ownedNode = (user: string, nodeId: NodeId): NodeRecord | undefined => {
    const record = registry.get(nodeId);
    return record !== undefined && !record.revoked && record.user === user ? record : undefined;
  };

  const authenticate = (req: IncomingMessage): Caller | undefined => {
    const assertion = credential(req, "Assertion");
    if (assertion !== undefined) {
      const claims = verifyAssertion(gatewayKey.publicKey, assertion, clock());
      if (claims === undefined || ownedNode(claims.user, claims.nodeId) === undefined) {
        return undefined;
      }
      return { kind: "client", ...claims };
    }
    const proof = parseNodeProof(credential(req, "Node") ?? "");
    if (proof === undefined || !nodeProofValid("signal", proof.nodeId, proof.ts, proof.sig)) {
      return undefined;
    }
    return { kind: "node", nodeId: proof.nodeId, peerId: proof.nodeId };
  };

  const ownerOf = (caller: Caller): string =>
    caller.kind === "client" ? `user:${caller.user}` : `node:${caller.nodeId}`;

  const onAgent = (socket: WebSocket): void => {
    let nodeId: NodeId | undefined;
    const helloTimer = setTimeout(
      () => socket.close(CLOSE_UNAUTHORIZED, "hello timeout"),
      HELLO_TIMEOUT_MS,
    );
    onFrames(socket, (raw) => {
      if (nodeId === undefined) {
        const hello = decodeHello(raw);
        if (hello === undefined || !nodeProofValid("agent", hello.nodeId, hello.ts, hello.sig)) {
          socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
          return;
        }
        clearTimeout(helloTimer);
        nodeId = hello.nodeId;
        nodes.get(nodeId)?.close(1000, "replaced");
        nodes.set(nodeId, socket);
        socket.send(encodeFrame({ kind: "welcome", nodeId }));
        return;
      }
      const frame = decodeNodeFrame(raw);
      if (frame.kind === "response") {
        const request = pending.get(frame.id);
        if (request?.nodeId === nodeId) request.settle(frame.status, frame);
      } else relaySignal(nodeId, frame, nodeId);
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (nodeId === undefined || nodes.get(nodeId) !== socket) return;
      nodes.delete(nodeId);
      for (const p of pending.values()) if (p.nodeId === nodeId) p.settle(502);
    });
  };

  // A client may only signal the node its assertion names; a node may answer any peer.
  const onSignal = (socket: WebSocket, caller: Caller): void => {
    const peer = caller.peerId;
    peers.get(peer)?.socket.close(1000, "replaced");
    peers.set(peer, { socket, owner: ownerOf(caller), nodeId: caller.nodeId });
    flushSignals(peer, socket, caller.nodeId);
    const expiryTimer =
      caller.kind === "client"
        ? setTimeout(
            () => socket.close(CLOSE_UNAUTHORIZED, "assertion expired"),
            caller.exp - clock(),
          )
        : undefined;
    onFrames(socket, (raw) => {
      if (
        registry.get(caller.nodeId)?.revoked ||
        (caller.kind === "client" && caller.exp <= clock())
      ) {
        socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
        return;
      }
      const frame = decodeNodeFrame(raw);
      if (caller.kind === "client" && frame.kind === "signal" && frame.to !== caller.nodeId) {
        socket.close(CLOSE_FORBIDDEN_TARGET, "forbidden target");
        return;
      }
      relaySignal(peer, frame, caller.nodeId);
    });
    socket.on("close", () => {
      clearTimeout(expiryTimer);
      if (peers.get(peer)?.socket !== socket) return;
      peers.delete(peer);
      dropSignalsFrom(peer);
    });
  };

  const disconnectNode = (nodeId: NodeId): void => {
    nodes.get(nodeId)?.close(CLOSE_UNAUTHORIZED, "unpaired");
    for (const entry of peers.values()) {
      if (entry.nodeId === nodeId) entry.socket.close(CLOSE_UNAUTHORIZED, "unpaired");
    }
  };

  const pairStart = async (req: IncomingMessage, res: ServerResponse): Promise<number> => {
    const user = await userFor(req, res);
    if (user === undefined) return res.statusCode;
    return respondJson(res, 200, pairing.issue(user));
  };

  const pairComplete = async (req: IncomingMessage, res: ServerResponse): Promise<number> => {
    const body = await readJson(req);
    const { code, nodeId, nodePublicKey, sig } = body ?? {};
    if (
      typeof code !== "string" ||
      typeof nodeId !== "string" ||
      typeof nodePublicKey !== "string" ||
      typeof sig !== "string" ||
      !ID_PATTERN.test(nodeId) ||
      !isPublicKey(nodePublicKey)
    ) {
      return respond(res, 400, "bad request");
    }
    // The code is only spent once the node has proved it holds the key it is registering.
    const user = verify(nodePublicKey, pairingMessage(code, nodeId), sig)
      ? pairing.redeem(code)
      : undefined;
    if (user === undefined) return respond(res, 401, "unauthorized");
    if (registry.has(nodeId)) return respond(res, 409, "node id taken");
    registry.set(nodeId, {
      user: user.id,
      email: user.email,
      publicKey: nodePublicKey,
      revoked: false,
    });
    return respondJson(res, 200, { gatewayPublicKey: gatewayKey.publicKey, user: user.id });
  };

  const openSession = async (req: IncomingMessage, res: ServerResponse): Promise<number> => {
    const user = await userFor(req, res);
    if (user === undefined) return res.statusCode;
    const body = await readJson(req);
    const { nodeId, peerId } = body ?? {};
    if (
      typeof nodeId !== "string" ||
      typeof peerId !== "string" ||
      !ID_PATTERN.test(nodeId) ||
      !ID_PATTERN.test(peerId) ||
      registry.has(peerId)
    ) {
      return respond(res, 400, "bad request");
    }
    if (ownedNode(user.id, nodeId) === undefined) return respond(res, 404, "unknown node");
    const exp = clock() + ASSERTION_TTL_MS;
    const assertion = signAssertion(gatewayKey, { nodeId, user: user.id, peerId, exp });
    return respondJson(res, 200, { assertion, nodeId, peerId, exp });
  };

  const unpair = async (
    req: IncomingMessage,
    res: ServerResponse,
    nodeId: NodeId,
  ): Promise<number> => {
    const user = await userFor(req, res);
    if (user === undefined) return res.statusCode;
    const record = registry.get(nodeId);
    if (record?.user !== user.id) return respond(res, 404, "unknown node");
    record.revoked = true;
    disconnectNode(nodeId);
    return respond(res, 204, "");
  };

  const relayHttp = async (
    req: IncomingMessage,
    res: ServerResponse,
    nodeId: NodeId,
    path: string,
  ): Promise<number> => {
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
        res.off("close", cancel);
        if (!response && node.readyState === WebSocket.OPEN)
          node.send(encodeFrame({ kind: "cancel", id: relay.id }));
        pending.delete(relay.id);
        resolve({ status, response });
      };
      const cancel = (): void => settle(499);
      res.once("close", cancel);
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

  const turnCredentials = (req: IncomingMessage, res: ServerResponse, peer: string | null) => {
    const caller = authenticate(req);
    if (caller === undefined) return respond(res, 401, "unauthorized");
    if (o.turn === undefined) return respond(res, 404, "turn not configured");
    if (!peer) return respond(res, 400, "bad peer");
    if (peer !== caller.peerId) return respond(res, 403, "peer does not match credentials");
    const now = clock();
    let config = { ...o.turn, ttlSeconds: Math.min(o.turn.ttlSeconds, ASSERTION_TTL_MS / 1000) };
    if (caller.kind === "client") {
      // TURN access must not outlive the assertion that authorised it.
      const remainingSeconds = Math.floor((caller.exp - now) / 1000);
      if (remainingSeconds < 1) return respond(res, 401, "unauthorized");
      config = { ...config, ttlSeconds: Math.min(config.ttlSeconds, remainingSeconds) };
    }
    try {
      return respondJson(res, 200, mintTurnCredentials(config, peer, now));
    } catch {
      return respond(res, 400, "bad peer");
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<number> => {
    const method = req.method ?? "GET";
    const route = /^\/nodes\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (url.pathname === "/agent" || url.pathname === "/signal")
      return respond(res, 401, "unauthorized");
    if (url.pathname === "/healthz") return respond(res, 200, "ok");
    if (url.pathname === "/pair/start" && method === "POST") return pairStart(req, res);
    if (url.pathname === "/pair/complete" && method === "POST") return pairComplete(req, res);
    if (url.pathname === "/sessions" && method === "POST") return openSession(req, res);
    if (url.pathname === "/turn-credentials" && method === "GET") {
      return turnCredentials(req, res, url.searchParams.get("peer"));
    }
    if (route?.[1] !== undefined) {
      const nodeId = decodeURIComponent(route[1]);
      if (route[2] === undefined && method === "DELETE") return unpair(req, res, nodeId);
      if (o.unsafeTestOnlyPlaintextHttpRelay !== true) return respond(res, 404, "not found");
      const user = await userFor(req, res);
      if (user === undefined) return res.statusCode;
      if (ownedNode(user.id, nodeId) === undefined) return respond(res, 404, "unknown node");
      return relayHttp(req, res, nodeId, (route[2] ?? "/") + url.search);
    }
    return respond(res, 404, "not found");
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    // Node ids and relay paths can carry user data, so only fixed routes are logged by name.
    const logged = url.pathname.startsWith("/nodes/")
      ? "/nodes/*"
      : LOGGED_PATHS.has(url.pathname)
        ? url.pathname
        : "*";
    const log = (status: number): void => console.log(`${req.method ?? "GET"} ${logged} ${status}`);
    handle(req, res, url).then(log, () => {
      if (!res.headersSent) respond(res, 500, "request failed");
      log(500);
    });
  });

  const rejectUpgrade = (socket: Duplex, status: number, reason: string): void => {
    console.log(`UPGRADE ${status}`);
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    if (url.pathname === "/agent") {
      wss.handleUpgrade(req, socket, head, onAgent);
      return;
    }
    if (url.pathname !== "/signal") {
      socket.destroy();
      return;
    }
    const caller = authenticate(req);
    if (caller === undefined) return rejectUpgrade(socket, 401, "Unauthorized");
    if (url.searchParams.get("peer") !== caller.peerId) {
      return rejectUpgrade(socket, 403, "Forbidden");
    }
    const holder = peers.get(caller.peerId);
    if (holder?.socket.readyState === WebSocket.OPEN && holder.owner !== ownerOf(caller)) {
      return rejectUpgrade(socket, 409, "Conflict");
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSignal(ws, caller));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", resolve);
  });
  const { address, port } = server.address() as AddressInfo;

  return {
    url: `http://${address.includes(":") ? `[${address}]` : address}:${port}`,
    publicKey: gatewayKey.publicKey,
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
