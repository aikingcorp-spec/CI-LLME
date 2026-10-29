import { networkInterfaces } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanup } from "node-datachannel";
import { openSession } from "../gateway-client.js";
import { readKeyFile } from "../key-file.js";
import { nodeAuthorization } from "../pairing.js";
import type { CloseHandshakeEvent, DataPeer } from "../webrtc-peer.js";
import { connectPeer } from "../webrtc-peer.js";

type Role = "node" | "client";
type Frame = { t: "req"; id: string; method: string } | { t: "res"; id: string; result: unknown };
type Connect = (hook: (event: CloseHandshakeEvent) => void) => Promise<DataPeer>;
type SessionEnd = "remote-bye" | "channel-closed" | "heartbeat-timeout" | "local-shutdown";

const LINGER_MS = 200;

const role = process.argv[2];
if (role !== "node" && role !== "client") {
  console.error("usage: two-machine-peer.ts node|client");
  process.exit(1);
}
const self: Role = role;

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
const machine = process.env.MACHINE ?? self;
const clientId = process.env.CLIENT_ID ?? "peer-a";
const heartbeatMs = Number(process.env.HEARTBEAT_MS ?? 500);
const deadAfterMs = Number(process.env.DEAD_AFTER_MS ?? 3_000);
const connectTimeoutMs = Number(process.env.CONNECT_TIMEOUT_MS ?? 10_000);
const retryMs = Number(process.env.RETRY_MS ?? 500);

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      role: self,
      machine,
      pid: process.pid,
      event,
      ...fields,
    }),
  );
};

const addresses = (): string[] =>
  Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => a.family === "IPv4")
    .map((a) => a.address);

const within = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });

function parseFrame(raw: string): Frame | undefined {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null) return undefined;
  const f = value as Record<string, unknown>;
  if (typeof f.id !== "string") return undefined;
  if (f.t === "req" && typeof f.method === "string")
    return { t: "req", id: f.id, method: f.method };
  if (f.t === "res") return { t: "res", id: f.id, result: f.result };
  return undefined;
}

function trackHandshake(session: number) {
  const seen = new Set<CloseHandshakeEvent>();
  return {
    seen,
    hook: (event: CloseHandshakeEvent): void => {
      seen.add(event);
      log(event.replaceAll("-", "_"), { session });
    },
  };
}

let stopping = false;
let current: DataPeer | undefined;
let attempt = 0;

async function runSession(
  peer: DataPeer,
  session: number,
  handshake: Set<CloseHandshakeEvent>,
): Promise<SessionEnd> {
  let seq = 0;
  let lastInbound = Date.now();
  let timedOut = false;
  const pending = new Map<string, string>();
  const identity = { role: self, machine, pid: process.pid, session };
  const send = (frame: Frame): boolean => {
    try {
      peer.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  };
  const ask = (method: string): void => {
    seq += 1;
    const id = `${self}-${session}-${seq}`;
    pending.set(id, method);
    if (send({ t: "req", id, method }) && method === "whoami") {
      log("request_sent", { session, id, method });
    }
  };
  const beat = setInterval(() => {
    if (Date.now() - lastInbound > deadAfterMs) {
      timedOut = true;
      peer.close();
      return;
    }
    ask("ping");
  }, heartbeatMs);

  ask("whoami");
  try {
    for await (const raw of peer.messages) {
      lastInbound = Date.now();
      const frame = parseFrame(raw);
      if (frame?.t === "req") {
        send({ t: "res", id: frame.id, result: identity });
        if (frame.method === "whoami") {
          log("request_received", { session, id: frame.id, method: frame.method });
          log("response_sent", { session, id: frame.id, method: frame.method });
        }
      } else if (frame?.t === "res") {
        const method = pending.get(frame.id);
        pending.delete(frame.id);
        if (method === "whoami") {
          log("response_received", { session, id: frame.id, method, from: frame.result });
          log("selected_pair", { session, pair: peer.selectedPair() });
        }
      }
    }
  } finally {
    clearInterval(beat);
  }
  const remoteBye = handshake.has("bye-received");
  if (remoteBye) await sleep(LINGER_MS);
  peer.close();
  if (stopping) return "local-shutdown";
  if (remoteBye) return "remote-bye";
  return timedOut ? "heartbeat-timeout" : "channel-closed";
}

async function serve(
  attemptNumber: number,
  connect: Connect,
  openTimeoutMs?: number,
): Promise<void> {
  const handshake = trackHandshake(attemptNumber);
  log(self === "node" ? "listening" : "connecting", { session: attemptNumber });
  const peer = await connect(handshake.hook);
  current = peer;
  try {
    await (openTimeoutMs === undefined ? peer.open : within(peer.open, openTimeoutMs));
  } catch (error) {
    peer.close();
    current = undefined;
    throw error;
  }
  log("channel_open", {
    session: attemptNumber,
    localCandidates: peer.localCandidates,
    pair: peer.selectedPair(),
  });
  const reason = await runSession(peer, attemptNumber, handshake.seen);
  current = undefined;
  log("session_end", { session: attemptNumber, reason });
}

async function loop(connect: Connect, openTimeoutMs?: number): Promise<void> {
  while (!stopping) {
    attempt += 1;
    try {
      await serve(attempt, connect, openTimeoutMs);
    } catch (error) {
      if (stopping) break;
      log("connect_failed", {
        session: attempt,
        error: error instanceof Error ? error.message : "failed",
      });
    }
    if (!stopping) await sleep(retryMs);
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  log("shutdown");
  await current?.closeGracefully();
  await sleep(50);
  cleanup();
  log("exit");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

log("started", { nodeId, addresses: addresses() });

if (self === "node") {
  const identity = readKeyFile(required("NODE_KEY_FILE"));
  if (!identity) throw new Error("NODE_KEY_FILE does not exist");
  await loop((onCloseHandshake) =>
    connectPeer({
      signalUrl: `${gatewayUrl}/signal`,
      selfId: nodeId,
      remoteId: clientId,
      initiator: false,
      authorization: nodeAuthorization(identity, nodeId),
      onCloseHandshake,
    }),
  );
} else {
  const sessionToken = required("SESSION_TOKEN");
  await loop(async (onCloseHandshake) => {
    const { assertion } = await openSession(gatewayUrl, sessionToken, nodeId, clientId);
    return connectPeer({
      signalUrl: `${gatewayUrl}/signal`,
      selfId: clientId,
      remoteId: nodeId,
      initiator: true,
      authorization: `Assertion ${assertion}`,
      onCloseHandshake,
    });
  }, connectTimeoutMs);
}
