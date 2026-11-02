import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DataPeer, PeerChannel, PeerTransport } from "./peer-core.js";
import { connectPeer } from "./peer-core.js";

let peer: DataPeer;
let emitState: (state: string) => void;
let closeTransport: ReturnType<typeof vi.fn<() => void>>;
const onClose = vi.fn();

beforeEach(async () => {
  vi.useFakeTimers();
  onClose.mockClear();
  closeTransport = vi.fn<() => void>();
  const channel: PeerChannel = {
    onMessage: () => {},
    onClosed: () => {},
    onOpen: () => {},
    isOpen: () => true,
    sendMessage: () => true,
    sendMessageBinary: () => true,
    close: () => {},
  };
  const connection: PeerTransport = {
    onStateChange: (receive) => {
      emitState = receive;
    },
    onIceStateChange: () => {},
    onGatheringStateChange: () => {},
    onSignalingStateChange: () => {},
    onLocalDescription: () => {},
    onLocalCandidate: () => {},
    onDataChannel: () => {},
    setRemoteDescription: () => {},
    addRemoteCandidate: () => {},
    createDataChannel: () => channel,
    getSelectedCandidatePair: () => null,
    close: closeTransport,
  };
  peer = await connectPeer(
    {
      signalUrl: "",
      selfId: "fixture-client",
      remoteId: "fixture-node",
      initiator: true,
      signaling: { send: () => {}, listen: () => () => {} },
      onClose,
    },
    {
      socket: () => {
        throw new Error("fixture uses injected signaling");
      },
      connection: () => connection,
    },
  );
  await peer.open;
});
afterEach(() => {
  peer.close();
  vi.useRealTimers();
});

it("keeps the same established channel after a brief ICE disconnection recovers", async () => {
  emitState("disconnected");
  await vi.advanceTimersByTimeAsync(5000);
  emitState("connected");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(peer.isClosed()).toBe(false);
  expect(closeTransport).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it("releases the peer once after the recovery deadline without extending it for repeated events", async () => {
  emitState("disconnected");
  await vi.advanceTimersByTimeAsync(14_000);
  emitState("disconnected");
  expect(peer.isClosed()).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(peer.isClosed()).toBe(true);
  expect(closeTransport).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("closes immediately on explicit closure and ignores late disconnection events", async () => {
  emitState("disconnected");
  peer.close();
  emitState("disconnected");
  expect(peer.isClosed()).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(closeTransport).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("releases a terminally failed connection immediately during the grace period", async () => {
  emitState("disconnected");
  emitState("failed");
  await vi.advanceTimersByTimeAsync(0);
  expect(peer.isClosed()).toBe(true);
  expect(closeTransport).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
