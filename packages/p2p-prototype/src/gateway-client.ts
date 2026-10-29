import type { KeyPair } from "./pairing.js";
import { pairingMessage, sign } from "./pairing.js";
import type { NodeId } from "./protocol.js";

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

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function json<T>(res: Response, what: string): Promise<T> {
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
): Promise<{ code: string; expiresAt: number }> {
  const res = await postJson(`${gatewayUrl}/pair/start`, {}, bearer(sessionToken));
  return json(res, "pair/start");
}

/** Node: registers its public key under the code's user and learns the gateway key to pin. */
export async function completePairing(
  gatewayUrl: string,
  code: string,
  nodeId: NodeId,
  keyPair: KeyPair,
): Promise<PairingResult> {
  const res = await postJson(
    `${gatewayUrl}/pair/complete`,
    {
      code,
      nodeId,
      nodePublicKey: keyPair.publicKey,
      sig: sign(keyPair, pairingMessage(code, nodeId)),
    },
    {},
  );
  return json(res, "pair/complete");
}

/** Signed-in user: asks for a short-lived assertion to signal their node as `peerId`. */
export async function openSession(
  gatewayUrl: string,
  sessionToken: string,
  nodeId: NodeId,
  peerId: string,
): Promise<Session> {
  const res = await postJson(`${gatewayUrl}/sessions`, { nodeId, peerId }, bearer(sessionToken));
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
