import type { IceServer } from "node-datachannel";
import type { PairingResult } from "./gateway-http-client.js";
import { fetchTurnCredentials, json, postJson } from "./gateway-http-client.js";
import type { KeyPair } from "./pairing.js";
import { nodeAuthorization, pairingMessage, sign } from "./pairing.js";
import type { NodeId } from "./protocol.js";
import { toNodeDatachannelIceServers } from "./turn-credentials.js";

/** One node process owns its credentials and shares discovery across concurrent peer attempts. */
export function createNodeTurnResolver(gatewayUrl: string, nodeId: string, key: KeyPair) {
  let cached: { servers: IceServer[]; refreshAt: number } | undefined;
  let pending: Promise<IceServer[]> | undefined;
  return async (): Promise<IceServer[]> => {
    if (cached && performance.now() < cached.refreshAt)
      return cached.servers.map((server) => ({ ...server }));
    if (!pending) {
      cached = undefined;
      // Use monotonic elapsed time, starting before the request, so latency or an NTP clock
      // adjustment cannot extend the server's credential lifetime. REST expiry rounds to seconds.
      const startedAt = performance.now();
      pending = fetchTurnCredentials(gatewayUrl, nodeAuthorization(key, nodeId), nodeId)
        .then((turn) => {
          if (!turn) return [];
          const refreshAt =
            startedAt + Math.min(300_000, Math.max(0, turn.ttl * 1000 - 1000) * 0.75);
          if (performance.now() >= refreshAt) return [];
          const servers = toNodeDatachannelIceServers(turn);
          cached = { servers, refreshAt };
          return servers;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    // Native RTC implementations may retain or mutate their configuration. Peers get copies.
    return (await pending).map((server) => ({ ...server }));
  };
}

export type { PairingResult, Session } from "./gateway-http-client.js";
export { listNodes, openSession, startPairing, unpairNode } from "./gateway-http-client.js";
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
