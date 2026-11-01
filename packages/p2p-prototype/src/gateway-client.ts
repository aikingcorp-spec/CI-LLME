import type { PairingResult } from "./gateway-http-client.js";
import { fetchTurnCredentials, json, postJson } from "./gateway-http-client.js";
import type { KeyPair } from "./pairing.js";
import { nodeAuthorization, pairingMessage, sign } from "./pairing.js";
import type { NodeId } from "./protocol.js";
import { toNodeDatachannelIceServers } from "./turn-credentials.js";

/** Native runtime adapter: signed node auth and structured ICE servers. */
export async function fetchNodeTurnServers(gatewayUrl: string, nodeId: string, key: KeyPair) {
  const turn = await fetchTurnCredentials(gatewayUrl, nodeAuthorization(key, nodeId), nodeId);
  return turn ? toNodeDatachannelIceServers(turn) : [];
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
