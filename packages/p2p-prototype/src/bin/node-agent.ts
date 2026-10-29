import { completePairing } from "../gateway-client.js";
import type { NodeKeyFile } from "../key-file.js";
import { readKeyFile, writeKeyFile } from "../key-file.js";
import { httpForwardHandler, startNodeAgent } from "../node-agent.js";
import { channelHttpHandler, demoHandler, forwardChannelHandler } from "../node-channel-server.js";
import { generateKeyPair } from "../pairing.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const gatewayUrl = required("GATEWAY_URL");
const nodeId = required("NODE_ID");
const keyFile = required("NODE_KEY_FILE");

async function loadIdentity(): Promise<NodeKeyFile> {
  const saved = readKeyFile(keyFile);
  if (saved) return saved;
  const code = process.env.PAIR_CODE;
  if (!code) {
    console.error("no key file yet: set PAIR_CODE to a code from POST /pair/start");
    process.exit(1);
  }
  const keyPair = generateKeyPair();
  const { gatewayPublicKey, user } = await completePairing(gatewayUrl, code, nodeId, keyPair);
  // Saved only after the gateway accepted the pairing, so a failed attempt leaves nothing behind.
  const identity = { ...keyPair, gatewayPublicKey, user };
  writeKeyFile(keyFile, identity);
  console.log(`paired node ${nodeId} to user ${user}; key saved`);
  return identity;
}

const identity = await loadIdentity().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "pairing failed");
  process.exit(1);
});

if (!identity.gatewayPublicKey || !identity.user)
  throw new Error("paired node identity requires a gateway key and user");
const target = process.env.NODE_TARGET;
const handler = target ? forwardChannelHandler(target) : demoHandler();

const relay = channelHttpHandler(handler);
const agent = startNodeAgent({
  gatewayUrl,
  nodeId,
  keyPair: identity,
  handler: target
    ? httpForwardHandler(target)
    : async (req) => {
        const url = new URL(req.path, "http://node");
        if (req.method === "GET" && url.pathname === "/hello") {
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: new TextEncoder().encode(
              JSON.stringify({ from: nodeId, pid: process.pid, echo: url.search.slice(1) }),
            ),
          };
        }
        return relay(req);
      },
  channel: {
    gatewayPublicKey: identity.gatewayPublicKey,
    allowedUsers: [identity.user],
    handler,
  },
});
console.log(`node agent ${nodeId} dialing ${gatewayUrl}`);

const stop = (): void => void agent.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
