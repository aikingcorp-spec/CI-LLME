import type { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { NodeAgent } from "./node-agent.js";
import { startNodeAgent } from "./node-agent.js";
import { generateKeyPair } from "./pairing.js";
import type { SignalPayload } from "./protocol.js";
import { encodeFrame } from "./protocol.js";
import type { PeerOptions } from "./webrtc-peer.js";
import { connectPeer } from "./webrtc-peer.js";

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    send = vi.fn();
    ping = vi.fn();
    terminate() {
      this.readyState = 3;
      this.emit("close", 1006);
    }
    close() {
      this.readyState = 3;
      this.emit("close", 1000);
    }
  }
  function MockWebSocket() {
    return new Socket();
  }
  return { WebSocket: vi.fn(MockWebSocket) };
});
vi.mock("./webrtc-peer.js", () => ({ connectPeer: vi.fn() }));
vi.mock("./node-channel-server.js", () => ({
  createNodeChannelServer: () => ({ accept: () => new Promise(() => {}), onRevoke: vi.fn() }),
}));

let agent: NodeAgent;
let socket: EventEmitter;
let resolveIce: (servers: NonNullable<PeerOptions["iceServers"]>) => void;
let received: SignalPayload[];
const iceServers = vi.fn<() => Promise<NonNullable<PeerOptions["iceServers"]>>>();
function signal(payload: SignalPayload) {
  socket.emit(
    "message",
    Buffer.from(encodeFrame({ kind: "signal", from: "peer", to: "node", payload })),
  );
}
const offer = { type: "offer", sdp: "dummy-sdp", attemptId: "attempt-1" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(WebSocket, { OPEN: 1, CLOSED: 3 });
  received = [];
  iceServers.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveIce = resolve;
      }),
  );
  vi.mocked(connectPeer).mockImplementation(async (options) => {
    options.signaling?.listen((payload) => received.push(payload));
    return {
      close: vi.fn(),
      closeGracefully: vi.fn(async () => {}),
      open: Promise.resolve(),
      send: vi.fn(),
      messages: { async *[Symbol.asyncIterator]() {} },
      isClosed: () => false,
      selectedPair: () => null,
      localCandidates: [],
    };
  });
  const key = generateKeyPair();
  agent = startNodeAgent({
    gatewayUrl: "http://127.0.0.1:1",
    nodeId: "node",
    keyPair: key,
    iceServers,
    handler: async () => ({ status: 404, headers: {}, body: new Uint8Array() }),
    channel: {
      gatewayPublicKey: key.publicKey,
      allowedUsers: ["fake-user"],
      handler: {
        call: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
        async *subscribe() {},
      },
    },
  });
  socket = vi.mocked(WebSocket).mock.results[0]?.value;
});
afterEach(async () => {
  await agent.close();
  vi.useRealTimers();
});

it("keeps the agent link alive and reconnects when a heartbeat is not answered", async () => {
  vi.useFakeTimers();
  socket.emit("open");
  socket.emit("message", Buffer.from(encodeFrame({ kind: "welcome", nodeId: "node" })));
  const current = socket as EventEmitter & { send: ReturnType<typeof vi.fn> };
  await vi.advanceTimersByTimeAsync(20_000);
  expect(current.send.mock.calls.filter(([frame]) => frame === "ping")).toHaveLength(1);
  socket.emit("message", Buffer.from("pong"));
  await vi.advanceTimersByTimeAsync(20_000);
  expect(current.send.mock.calls.filter(([frame]) => frame === "ping")).toHaveLength(2);
  expect(vi.mocked(WebSocket)).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_500);
  expect(vi.mocked(WebSocket)).toHaveBeenCalledTimes(2);
});

it("does not mistake a transport pong for a live gateway application", async () => {
  vi.useFakeTimers();
  socket.emit("open");
  socket.emit("message", Buffer.from(encodeFrame({ kind: "welcome", nodeId: "node" })));
  await vi.advanceTimersByTimeAsync(20_000);
  // An intermediary can keep the transport alive after the room loses its socket.
  socket.emit("pong");
  await vi.advanceTimersByTimeAsync(20_500);
  expect(WebSocket).toHaveBeenCalledTimes(2);
  expect(agent.connected()).toBe(false);
});

it("retries an open socket that never receives welcome, ignoring events from the old attempt", async () => {
  vi.useFakeTimers();
  socket.emit("open");
  expect(agent.connected()).toBe(false);
  await vi.advanceTimersByTimeAsync(10_500);
  expect(WebSocket).toHaveBeenCalledTimes(2);
  const replacement = vi.mocked(WebSocket).mock.results[1]?.value as EventEmitter;
  replacement.emit("open");
  replacement.emit("message", Buffer.from(encodeFrame({ kind: "welcome", nodeId: "node" })));
  expect(agent.connected()).toBe(true);
  socket.emit("close", 1006);
  socket.emit("message", Buffer.from("malformed stale frame"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(agent.connected()).toBe(true);
  expect(WebSocket).toHaveBeenCalledTimes(2);
});

it("bounds upgrade time and honors service retry-after without adding parallel attempts", async () => {
  vi.useFakeTimers();
  expect(vi.mocked(WebSocket).mock.calls[0]?.[1]).toEqual({ handshakeTimeout: 10_000 });
  socket.emit(
    "unexpected-response",
    {},
    { statusCode: 503, headers: { "retry-after": "60" }, resume: vi.fn() },
  );
  await vi.advanceTimersByTimeAsync(59_999);
  expect(WebSocket).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(WebSocket).toHaveBeenCalledTimes(2);
  socket.emit("close", 1006);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(WebSocket).toHaveBeenCalledTimes(2);
});

it("routes the signed agent connection to the hosted node room", () => {
  expect(vi.mocked(WebSocket).mock.calls[0]?.[0]).toBe("ws://127.0.0.1:1/agent?node=node");
});

it("waits for fresh ICE servers and preserves candidates received during discovery", async () => {
  const candidate = {
    type: "candidate",
    candidate: "dummy-candidate",
    mid: "0",
    attemptId: "attempt-1",
  } as const;
  signal(offer);
  signal(candidate);
  expect(iceServers).toHaveBeenCalledTimes(1);
  expect(connectPeer).not.toHaveBeenCalled();
  const servers = ["stun:stun.example.test:3478"];
  resolveIce(servers);
  await vi.waitFor(() => expect(connectPeer).toHaveBeenCalledOnce());
  expect(vi.mocked(connectPeer).mock.calls[0]?.[0].iceServers).toEqual(servers);
  expect(received).toEqual([offer, candidate]);
  signal({ type: "cancel", attemptId: "attempt-1" });
  signal({ ...offer, attemptId: "attempt-2" });
  expect(iceServers).toHaveBeenCalledTimes(2);
  resolveIce([]);
  await vi.waitFor(() => expect(connectPeer).toHaveBeenCalledTimes(2));
});

it.each(["cancel", "stop"])("does not create RTC after %s during discovery", async (action) => {
  signal(offer);
  if (action === "cancel") signal({ type: "cancel", attemptId: "attempt-1" });
  else await agent.close();
  resolveIce([]);
  await Promise.resolve();
  await Promise.resolve();
  expect(connectPeer).not.toHaveBeenCalled();
});
