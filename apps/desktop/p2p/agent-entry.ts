/**
 * Entry of the separately built node-agent bundle (`scripts/build-p2p-agent.mjs`). The main
 * bundle loads it with a dynamic import, so node-datachannel's native addon is only touched
 * when P2P is configured and its binary exists.
 */
export { completePairing } from "../../../packages/p2p-prototype/src/gateway-client.js";
export { readKeyFile, writeKeyFile } from "../../../packages/p2p-prototype/src/key-file.js";
export { startNodeAgent } from "../../../packages/p2p-prototype/src/node-agent.js";
export { forwardChannelHandler } from "../../../packages/p2p-prototype/src/node-channel-server.js";
export { generateKeyPair } from "../../../packages/p2p-prototype/src/pairing.js";
