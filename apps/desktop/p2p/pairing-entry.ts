/**
 * Entry of the pairing bundle (`scripts/build-p2p-agent.mjs`). It has no native dependency,
 * so the main process can load it; the WebRTC code runs in the agent process instead.
 */
export { completePairing } from "../../../packages/p2p-prototype/src/gateway-client.js";
export { readKeyFile, writeKeyFile } from "../../../packages/p2p-prototype/src/key-file.js";
export { generateKeyPair, sign } from "../../../packages/p2p-prototype/src/pairing.js";
