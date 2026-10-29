import { completePairing } from "../gateway-client.js";
import type { NodeKeyFile } from "../key-file.js";
import { readKeyFile, writeKeyFile } from "../key-file.js";
import type { LocalHandler } from "../node-agent.js";
import { httpForwardHandler, startNodeAgent } from "../node-agent.js";
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

const json = (status: number, value: unknown): Awaited<ReturnType<LocalHandler>> => ({
  status,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(value)),
});

const demoHandler: LocalHandler = async (req) => {
  const url = new URL(req.path, "http://node");
  if (req.method === "GET" && url.pathname === "/hello") {
    return json(200, { from: nodeId, pid: process.pid, echo: url.search.slice(1) });
  }
  if (req.method === "POST" && url.pathname === "/echo") {
    return { status: 200, headers: { "content-type": "application/octet-stream" }, body: req.body };
  }
  return json(404, { error: "not found" });
};

const target = process.env.NODE_TARGET;
const agent = startNodeAgent({
  gatewayUrl,
  nodeId,
  keyPair: identity,
  handler: target ? httpForwardHandler(target) : demoHandler,
});
console.log(`node agent ${nodeId} dialing ${gatewayUrl}`);

process.on("SIGINT", () => void agent.close().then(() => process.exit(0)));
