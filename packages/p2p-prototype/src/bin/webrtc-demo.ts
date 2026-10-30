import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { completePairing, openSession, startPairing, unpairNode } from "../gateway-client.js";
import { generateKeyPair, nodeAuthorization } from "../pairing.js";
import { connectPeer } from "../webrtc-peer.js";

const TIMEOUT_MS = 20_000;
const LINGER_MS = 500;
const CLIENT_PEER = "peer-a";

const gatewayUrl = process.env.GATEWAY_URL;
if (!gatewayUrl) {
  console.error("GATEWAY_URL is required, e.g. GATEWAY_URL=http://127.0.0.1:8787");
  process.exit(1);
}

// Side a is a remote client holding an assertion; side b is the paired node signing with its key.
async function runPeer(side: string): Promise<void> {
  const nodeId = process.env.DEMO_NODE_ID;
  const authorization = process.env.DEMO_AUTHORIZATION;
  if (!nodeId || !authorization) throw new Error("run through webrtc-demo.ts, not directly");
  const client = side === "a";
  const outgoing = client ? "ping from a" : "pong from b";
  const peer = await connectPeer({
    signalUrl: `${gatewayUrl}/signal`,
    selfId: client ? CLIENT_PEER : nodeId,
    remoteId: client ? nodeId : CLIENT_PEER,
    initiator: client,
    authorization,
  });
  await peer.open;
  peer.send(outgoing);
  for await (const received of peer.messages) {
    console.log(`[pid ${process.pid}] peer ${side} received: ${received}`);
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, LINGER_MS));
  peer.close();
}

function spawnPeer(side: string, authorization: string, nodeId: string): Promise<number | null> {
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...process.execArgv, script, "peer", side], {
    stdio: "inherit",
    env: { ...process.env, DEMO_NODE_ID: nodeId, DEMO_AUTHORIZATION: authorization },
  });
  return new Promise((resolve) => child.on("exit", resolve));
}

// Pairs a throwaway node with the signed-in user, runs both sides, then unpairs it again.
async function runDemo(url: string): Promise<number> {
  const sessionToken = process.env.SESSION_TOKEN;
  if (!sessionToken) {
    console.error(
      "SESSION_TOKEN is required, use the signed Better Auth session token from sign-in",
    );
    return 1;
  }
  const nodeId = `demo-${randomBytes(3).toString("hex")}`;
  const keyPair = generateKeyPair();
  const { code } = await startPairing(url, sessionToken);
  await completePairing(url, code, nodeId, keyPair);
  try {
    const { assertion } = await openSession(url, sessionToken, nodeId, CLIENT_PEER);
    const codes = await Promise.all([
      spawnPeer("a", `Assertion ${assertion}`, nodeId),
      spawnPeer("b", nodeAuthorization(keyPair, nodeId), nodeId),
    ]);
    return codes.every((c) => c === 0) ? 0 : 1;
  } finally {
    await unpairNode(url, sessionToken, nodeId);
  }
}

const [mode, side] = process.argv.slice(2);
if (mode === "peer" && (side === "a" || side === "b")) {
  const timer = setTimeout(() => {
    console.error(`peer ${side} timed out`);
    process.exit(1);
  }, TIMEOUT_MS);
  await runPeer(side);
  clearTimeout(timer);
  process.exit(0);
} else {
  process.exit(await runDemo(gatewayUrl));
}
