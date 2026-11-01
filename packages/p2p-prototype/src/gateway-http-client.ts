import type { NodeId, PairedNode } from "./protocol.js";
import type { TurnIceServer } from "./turn-credentials.js";
import { MAX_TTL_SECONDS, toNodeDatachannelIceServers } from "./turn-credentials.js";

/** Optional relay discovery. Keep credentials in memory and bound a stalled gateway. */
export async function fetchTurnCredentials(
  gatewayUrl: string,
  authorization: string,
  peerId: string,
  signal?: AbortSignal,
): Promise<TurnIceServer | undefined> {
  try {
    const timeout = AbortSignal.timeout(3_000);
    const res = await fetch(`${gatewayUrl}/turn-credentials?peer=${encodeURIComponent(peerId)}`, {
      headers: { authorization },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Partial<TurnIceServer> | null;
    if (
      !body ||
      !Array.isArray(body.urls) ||
      body.urls.length === 0 ||
      !body.urls.every((url) => typeof url === "string") ||
      typeof body.username !== "string" ||
      !body.username ||
      typeof body.credential !== "string" ||
      !body.credential ||
      typeof body.ttl !== "number" ||
      !Number.isInteger(body.ttl) ||
      body.ttl < 1 ||
      body.ttl > MAX_TTL_SECONDS
    )
      return undefined;
    const turn = {
      urls: body.urls,
      username: body.username,
      credential: body.credential,
      ttl: body.ttl,
    };
    toNodeDatachannelIceServers(turn);
    return turn;
  } catch {
    return undefined;
  }
}
export interface PairingResult {
  gatewayPublicKey: string;
  user: string;
}
export interface Session {
  assertion: string;
  nodeId: NodeId;
  peerId: string;
  exp: number;
}

export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    signal,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

export async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status}`);
  return (await res.json()) as T;
}

const bearer = (sessionToken: string): Record<string, string> => ({
  authorization: `Bearer ${sessionToken}`,
});

/** Signed-in user: asks the gateway for a one-time pairing code. */
export async function startPairing(
  gatewayUrl: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<{ code: string; expiresAt: number }> {
  const res = await postJson(`${gatewayUrl}/pair/start`, {}, bearer(sessionToken), signal);
  return json(res, "pair/start");
}

/** Signed-in user: asks for a short-lived assertion to signal their node as `peerId`. */
export async function openSession(
  gatewayUrl: string,
  sessionToken: string,
  nodeId: NodeId,
  peerId: string,
  signal?: AbortSignal,
): Promise<Session> {
  const res = await postJson(
    `${gatewayUrl}/sessions`,
    { nodeId, peerId },
    bearer(sessionToken),
    signal,
  );
  return json(res, "sessions");
}

export async function unpairNode(
  gatewayUrl: string,
  sessionToken: string,
  nodeId: NodeId,
): Promise<void> {
  const res = await fetch(`${gatewayUrl}/nodes/${encodeURIComponent(nodeId)}`, {
    method: "DELETE",
    headers: bearer(sessionToken),
  });
  if (!res.ok) throw new Error(`unpair failed: ${res.status}`);
}

export async function listNodes(
  gatewayUrl: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<{ nodes: PairedNode[] }> {
  return json(
    await fetch(`${gatewayUrl}/nodes`, {
      headers: bearer(sessionToken),
      cache: "no-store",
      credentials: "omit",
      signal,
    }),
    "nodes",
  );
}
