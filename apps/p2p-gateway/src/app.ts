import { ASSERTION_SUBPROTOCOL_PREFIX, SIGNAL_SUBPROTOCOL } from "@rakazo/p2p-prototype/protocol";

import { mintTurnCredentials } from "../../../packages/p2p-prototype/src/turn-credentials.js";

import type { TokenScope } from "./app-token.js";
import { verifyAppToken } from "./app-token.js";
import type { Config } from "./config.js";
import { isPublicKey, verify } from "./crypto.js";
import {
  ASSERTION_TTL_MS,
  hashPairingCode,
  ID_PATTERN,
  newPairingCode,
  pairingMessage,
  parseNodeProof,
  signAssertion,
  verifyAssertion,
  verifyNodeProof,
} from "./pairing.js";
import { turnRateLimit } from "./rate-limit.js";
import { withAdmission } from "./room-link.js";
import type { NodeKind, PairedUser } from "./store.js";
import {
  activeNode,
  insertNode,
  issuePairCode,
  listUserNodes,
  NODE_KINDS,
  ownedActiveNode,
  redeemPairCode,
  revokeNode,
  useTokenId,
} from "./store.js";

export { ASSERTION_SUBPROTOCOL_PREFIX, SIGNAL_SUBPROTOCOL } from "@rakazo/p2p-prototype/protocol";

/** The room of one node, as the Worker sees it. */
export interface RoomStub {
  fetch(request: Request): Promise<Response>;
  online(): Promise<boolean>;
  kick(): Promise<void>;
}
export interface Deps {
  db: D1Database;
  config: Config;
  room(nodeId: string): RoomStub;
  now(): number;
}

const MAX_BODY_CHARS = 4096;
const MAX_NAME_CHARS = 64;
const MAX_CODE_CHARS = 32;

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const unauthorized = (code: "NO_SESSION" | "TOKEN_REPLAYED"): Response => json(401, { code });
const forbidden = (): Response => json(403, { code: "FORBIDDEN" });

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await request.text();
    if (body.length > MAX_BODY_CHARS) return undefined;
    const v: unknown = JSON.parse(body);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The credential of an `Authorization: <scheme> <credential>` header, scheme matched case-insensitively. */
function credential(request: Request, scheme: string): string | undefined {
  const [given, value, ...rest] = (request.headers.get("authorization") ?? "").split(" ");
  const ok = given?.toLowerCase() === scheme.toLowerCase() && rest.length === 0;
  return ok && value ? value : undefined;
}

interface AuthOptions {
  /** The token id may be used only once: for routes that change state. */
  once?: boolean;
  /** The node the request names. A token limited to one node is refused anywhere else. */
  nodeId?: string;
}

/** The signed-in user, or the response that refuses the request. */
async function authenticate(
  request: Request,
  deps: Deps,
  scope: TokenScope,
  options: AuthOptions = {},
): Promise<PairedUser | Response> {
  const token = credential(request, "Bearer");
  const claims =
    token === undefined
      ? undefined
      : await verifyAppToken(token, {
          keys: deps.config.appKeys,
          issuer: deps.config.issuer,
          audience: deps.config.audience,
          nowMs: deps.now(),
        });
  if (claims === undefined) return unauthorized("NO_SESSION");
  if (!claims.scope.includes(scope)) return forbidden();
  if (claims.nodeId !== undefined && claims.nodeId !== options.nodeId) return forbidden();
  if (options.once === true && !(await useTokenId(deps.db, claims.jti, claims.expMs, deps.now()))) {
    return unauthorized("TOKEN_REPLAYED");
  }
  return { id: claims.sub, email: claims.email };
}

async function pairStart(request: Request, deps: Deps): Promise<Response> {
  const user = await authenticate(request, deps, "pair", { once: true });
  if (user instanceof Response) return user;
  const code = newPairingCode();
  const expiresAt = await issuePairCode(deps.db, await hashPairingCode(code), user, deps.now());
  return json(200, { code, expiresAt });
}

async function pairComplete(request: Request, deps: Deps): Promise<Response> {
  const { code, nodeId, nodePublicKey, sig, name, kind } = (await readJson(request)) ?? {};
  if (
    typeof code !== "string" ||
    code.length > MAX_CODE_CHARS ||
    typeof nodeId !== "string" ||
    typeof nodePublicKey !== "string" ||
    typeof sig !== "string" ||
    !ID_PATTERN.test(nodeId) ||
    !(await isPublicKey(nodePublicKey)) ||
    (name !== undefined && (typeof name !== "string" || name.length > MAX_NAME_CHARS)) ||
    (kind !== undefined && !NODE_KINDS.includes(kind as NodeKind))
  ) {
    return text(400, "bad request");
  }
  // The code is only spent once the node has proved it holds the key it is registering.
  const user = (await verify(nodePublicKey, pairingMessage(code, nodeId), sig))
    ? await redeemPairCode(deps.db, await hashPairingCode(code), deps.now())
    : undefined;
  if (user === undefined) return text(401, "unauthorized");
  const paired = await insertNode(
    deps.db,
    {
      nodeId,
      user,
      publicKey: nodePublicKey,
      name: typeof name === "string" ? name.trim() : "",
      kind: (kind as NodeKind | undefined) ?? "unknown",
      gatewayKeyId: deps.config.gatewayKeyId,
    },
    deps.now(),
  );
  if (!paired) return text(409, "node id taken");
  return json(200, {
    gatewayPublicKey: deps.config.gatewayKey.publicKey,
    gatewayKeyId: deps.config.gatewayKeyId,
    user: user.id,
  });
}

async function openSession(request: Request, deps: Deps): Promise<Response> {
  const body = await readJson(request);
  const { nodeId, peerId } = body ?? {};
  const user = await authenticate(request, deps, "session", {
    nodeId: typeof nodeId === "string" ? nodeId : undefined,
  });
  if (user instanceof Response) return user;
  if (
    typeof nodeId !== "string" ||
    typeof peerId !== "string" ||
    !ID_PATTERN.test(nodeId) ||
    !ID_PATTERN.test(peerId)
  ) {
    return text(400, "bad request");
  }
  // A peer id must not collide with a node id, or a client could pose as that node.
  if ((await activeNode(deps.db, peerId)) !== undefined || peerId === nodeId) {
    return text(400, "bad request");
  }
  if ((await ownedActiveNode(deps.db, user.id, nodeId)) === undefined) {
    return text(404, "unknown node");
  }
  const exp = deps.now() + ASSERTION_TTL_MS;
  const assertion = await signAssertion(deps.config.gatewayKey, {
    nodeId,
    user: user.id,
    peerId,
    exp,
  });
  return json(200, { assertion, nodeId, peerId, exp });
}

async function listNodes(request: Request, deps: Deps): Promise<Response> {
  const user = await authenticate(request, deps, "nodes");
  if (user instanceof Response) return user;
  const rows = await listUserNodes(deps.db, user.id);
  const online = await Promise.all(
    rows.map((row) =>
      deps
        .room(row.node_id)
        .online()
        .catch(() => false),
    ),
  );
  return json(200, {
    nodes: rows.map((row, i) => ({
      nodeId: row.node_id,
      name: row.name,
      kind: row.kind,
      pairedAt: row.paired_at,
      lastSeenAt: row.last_seen_at,
      online: online[i] === true,
    })),
  });
}

async function unpair(request: Request, deps: Deps, nodeId: string): Promise<Response> {
  const user = await authenticate(request, deps, "nodes", { once: true, nodeId });
  if (user instanceof Response) return user;
  if (!(await revokeNode(deps.db, user.id, nodeId, deps.now()))) return text(404, "unknown node");
  await deps.room(nodeId).kick();
  return new Response(null, { status: 204 });
}

/** The assertion of a browser client, or the signed proof of a node acting as a signaling peer. */
async function signalCaller(request: Request, deps: Deps) {
  const now = deps.now();
  const offered = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((p) => p.trim());
  const fromSubprotocol = offered.includes(SIGNAL_SUBPROTOCOL)
    ? offered.find((p) => p.startsWith(ASSERTION_SUBPROTOCOL_PREFIX))
    : undefined;
  const assertion =
    credential(request, "Assertion") ?? fromSubprotocol?.slice(ASSERTION_SUBPROTOCOL_PREFIX.length);
  if (assertion !== undefined) {
    const claims = await verifyAssertion(deps.config.gatewayKey.publicKey, assertion, now);
    if (claims === undefined) return undefined;
    return (await ownedActiveNode(deps.db, claims.user, claims.nodeId)) === undefined
      ? undefined
      : { role: "signal" as const, ...claims };
  }
  const proof = parseNodeProof(credential(request, "Node") ?? "");
  const node = proof === undefined ? undefined : await activeNode(deps.db, proof.nodeId);
  if (proof === undefined || node === undefined) return undefined;
  return (await verifyNodeProof(node.node_pubkey, "signal", proof, now))
    ? { role: "signal" as const, nodeId: proof.nodeId, peerId: proof.nodeId }
    : undefined;
}

const isUpgrade = (request: Request): boolean =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

async function signal(request: Request, url: URL, deps: Deps): Promise<Response> {
  if (!isUpgrade(request)) return text(426, "expected websocket");
  const caller = await signalCaller(request, deps);
  if (caller === undefined) return text(401, "unauthorized");
  if (url.searchParams.get("peer") !== caller.peerId) return text(403, "forbidden");
  const forwarded = withAdmission(request, {
    role: "signal",
    nodeId: caller.nodeId,
    peerId: caller.peerId,
    ...("user" in caller ? { user: caller.user, exp: caller.exp } : {}),
  });
  // The credential rode in the subprotocol; the room only sees the neutral name.
  if (request.headers.has("sec-websocket-protocol")) {
    forwarded.headers.set("sec-websocket-protocol", SIGNAL_SUBPROTOCOL);
  }
  return deps.room(caller.nodeId).fetch(forwarded);
}

async function agent(request: Request, url: URL, deps: Deps): Promise<Response> {
  if (!isUpgrade(request)) return text(426, "expected websocket");
  const nodeId = url.searchParams.get("node") ?? "";
  // The node proves its key with the signed hello, checked by its room. Unknown and revoked nodes fail alike.
  const node = ID_PATTERN.test(nodeId) ? await activeNode(deps.db, nodeId) : undefined;
  if (node === undefined) return text(401, "unauthorized");
  return deps
    .room(nodeId)
    .fetch(withAdmission(request, { role: "agent", nodeId, nodeKey: node.node_pubkey }));
}

async function turnCredentials(request: Request, url: URL, deps: Deps): Promise<Response> {
  const caller = await signalCaller(request, deps);
  if (caller === undefined) return unauthorized("NO_SESSION");
  if (deps.config.turn === undefined) return text(501, "not enabled");
  if (url.searchParams.get("peer") !== caller.peerId) return forbidden();
  const now = deps.now();
  const identity = "user" in caller ? `user:${caller.user}` : `node:${caller.nodeId}`;
  const retryAfter = await turnRateLimit(deps.db, identity, now);
  if (retryAfter > 0) {
    const response = json(429, { code: "RATE_LIMITED" });
    response.headers.set("retry-after", String(retryAfter));
    return response;
  }
  const ttlSeconds =
    "exp" in caller
      ? Math.min(deps.config.turn.ttlSeconds, Math.floor((caller.exp - now) / 1000))
      : deps.config.turn.ttlSeconds;
  if (ttlSeconds < 1) return unauthorized("NO_SESSION");
  const {
    urls,
    username,
    credential,
    ttlSeconds: ttl,
  } = await mintTurnCredentials({ ...deps.config.turn, ttlSeconds }, caller.peerId, now);
  return json(200, { urls, username, credential, ttl });
}

async function route(request: Request, url: URL, deps: Deps): Promise<Response> {
  const method = request.method;
  const path = url.pathname;
  if (path === "/healthz") return text(200, "ok");
  if (path === "/agent") return agent(request, url, deps);
  if (path === "/signal") return signal(request, url, deps);
  if (path === "/pair/start" && method === "POST") return pairStart(request, deps);
  if (path === "/pair/complete" && method === "POST") return pairComplete(request, deps);
  if (path === "/sessions" && method === "POST") return openSession(request, deps);
  if (path === "/nodes" && method === "GET") return listNodes(request, deps);
  if (path === "/turn-credentials" && method === "GET") return turnCredentials(request, url, deps);
  const node = /^\/nodes\/([^/]+)$/.exec(path)?.[1];
  if (node !== undefined && method === "DELETE") {
    const nodeId = decodeURIComponent(node);
    return ID_PATTERN.test(nodeId) ? unpair(request, deps, nodeId) : text(404, "unknown node");
  }
  return text(404, "not found");
}

function withCors(request: Request, response: Response, config: Config): Response {
  const origin = request.headers.get("origin");
  if (origin === null || response.status === 101 || !config.allowedOrigins.includes(origin)) {
    return response;
  }
  const out = new Response(response.body, response);
  out.headers.set("access-control-allow-origin", origin);
  out.headers.append("vary", "origin");
  return out;
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && !deps.config.allowedOrigins.includes(origin)) return forbidden();
  if (request.method === "OPTIONS") {
    return withCors(
      request,
      new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "600",
        },
      }),
      deps.config,
    );
  }
  try {
    return withCors(request, await route(request, new URL(request.url), deps), deps.config);
  } catch {
    return text(500, "request failed");
  }
}
