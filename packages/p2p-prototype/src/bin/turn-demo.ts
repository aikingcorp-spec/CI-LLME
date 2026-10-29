import { parseArgs } from "node:util";
import type { IceServer } from "node-datachannel";
import type { TurnCredentials } from "../turn-credentials.js";
import { toNodeDatachannelIceServers } from "../turn-credentials.js";
import { connectPeer } from "../webrtc-peer.js";

const TIMEOUT_MS = 30_000;
const LINGER_MS = 500;
const PINGS = 5;
const STUN_PORT = 3478;

const gatewayUrl = process.env.GATEWAY_URL;
const { values } = parseArgs({
  options: {
    self: { type: "string" },
    remote: { type: "string" },
    initiator: { type: "boolean", default: false },
    relay: { type: "boolean", default: false },
  },
});
if (!gatewayUrl || !values.self || !values.remote) {
  console.error(
    "usage: GATEWAY_URL=http://127.0.0.1:8787 turn-demo.ts --self <id> --remote <id> [--initiator] [--relay]",
  );
  process.exit(1);
}
const { self, remote, initiator, relay } = values;

const timer = setTimeout(() => {
  console.error(`[${self}] timed out`);
  process.exit(1);
}, TIMEOUT_MS);

function candidateType(candidate: string): string {
  return /\btyp (\w+)/.exec(candidate)?.[1] ?? "unknown";
}

function summarize(candidates: string[]): string {
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(candidateType(c), (counts.get(candidateType(c)) ?? 0) + 1);
  return ["host", "srflx", "relay"].map((t) => `${t}=${counts.get(t) ?? 0}`).join(" ");
}

const res = await fetch(`${gatewayUrl}/turn-credentials?peer=${encodeURIComponent(self)}`);
if (!res.ok) {
  console.error(`[${self}] turn-credentials failed: ${res.status}`);
  process.exit(1);
}
const creds = (await res.json()) as TurnCredentials;
console.log(`[${self}] turn username=${creds.username} ttl=${creds.ttlSeconds}s`);

const turnServers = toNodeDatachannelIceServers(creds);
const stunHost = turnServers[0]?.hostname;
const iceServers: Array<string | IceServer> = [...turnServers];
if (stunHost) iceServers.push(`stun:${stunHost}:${STUN_PORT}`);

const peer = await connectPeer({
  signalUrl: `${gatewayUrl}/signal`,
  selfId: self,
  remoteId: remote,
  initiator,
  iceServers,
  iceTransportPolicy: relay ? "relay" : "all",
});
await peer.open;

const reportSelected = (): void => {
  console.log(`[${self}] local candidates: ${summarize(peer.localCandidates)}`);
  const pair = peer.selectedPair();
  if (!pair) {
    console.log(`[${self}] SELECTED none`);
    return;
  }
  console.log(
    `SELECTED local=${pair.local} (${candidateType(pair.local)}) remote=${pair.remote} (${candidateType(pair.remote)})`,
  );
};

if (initiator) {
  const inbox = peer.messages[Symbol.asyncIterator]();
  for (let n = 1; n <= PINGS; n++) {
    const sentAt = Date.now();
    peer.send(`ping ${n} ${sentAt}`);
    const reply = await inbox.next();
    if (reply.done) throw new Error("channel closed before pong");
    console.log(
      `[${self}] ${reply.value.split(" ").slice(0, 2).join(" ")} rtt=${Date.now() - sentAt}ms`,
    );
  }
  reportSelected();
} else {
  let handled = 0;
  for await (const text of peer.messages) {
    const [kind, n, ts] = text.split(" ");
    if (kind !== "ping") continue;
    peer.send(`pong ${n} ${ts}`);
    if (++handled === PINGS) break;
  }
  reportSelected();
}

await new Promise((resolve) => setTimeout(resolve, LINGER_MS));
peer.close();
clearTimeout(timer);
process.exit(0);
