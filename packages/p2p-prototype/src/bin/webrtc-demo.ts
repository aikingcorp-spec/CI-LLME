import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connectPeer } from "../webrtc-peer.js";

const TIMEOUT_MS = 20_000;
const LINGER_MS = 500;

const gatewayUrl = process.env.GATEWAY_URL;
if (!gatewayUrl) {
  console.error("GATEWAY_URL is required, e.g. GATEWAY_URL=http://127.0.0.1:8787");
  process.exit(1);
}

async function runPeer(side: string): Promise<void> {
  const self = side === "a";
  const outgoing = self ? "ping from a" : "pong from b";
  const peer = await connectPeer({
    signalUrl: `${gatewayUrl}/signal`,
    selfId: `peer-${side}`,
    remoteId: self ? "peer-b" : "peer-a",
    initiator: self,
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

function spawnPeer(side: string): Promise<number | null> {
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...process.execArgv, script, "peer", side], {
    stdio: "inherit",
  });
  return new Promise((resolve) => child.on("exit", resolve));
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
  const codes = await Promise.all([spawnPeer("a"), spawnPeer("b")]);
  process.exit(codes.every((code) => code === 0) ? 0 : 1);
}
