import type { AddressInfo } from "node:net";
import { cleanup } from "node-datachannel";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { SignalPayload } from "./protocol.js";
import { waitFor } from "./test-util.js";
import { connectPeer } from "./webrtc-peer.js";

const pcClose = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node-datachannel", async (importOriginal) => {
  const real = await importOriginal<typeof import("node-datachannel")>();
  class CountingPeerConnection extends real.PeerConnection {
    override close(): void {
      pcClose.calls += 1;
      super.close();
    }
  }
  return { ...real, PeerConnection: CountingPeerConnection };
});

afterAll(() => cleanup());
beforeEach(() => {
  pcClose.calls = 0;
});

const signaling = () => ({
  send: (_p: SignalPayload) => {},
  listen: () => () => {},
});

// TURN allocations live as long as the PeerConnection; every exit path must close it.
describe("PeerConnection release", () => {
  it("closes the PeerConnection exactly once on close()", async () => {
    const peer = await connectPeer({
      signalUrl: "",
      signaling: signaling(),
      selfId: "a",
      remoteId: "b",
      initiator: true,
    });
    peer.close();
    peer.close();
    expect(pcClose.calls).toBe(1);
    expect(peer.isClosed()).toBe(true);
  });

  it("closes the PeerConnection when an abort signal fires", async () => {
    const ac = new AbortController();
    const peer = await connectPeer({
      signalUrl: "",
      signaling: signaling(),
      selfId: "a",
      remoteId: "b",
      initiator: true,
      signal: ac.signal,
    });
    ac.abort();
    expect(pcClose.calls).toBe(1);
    await expect(peer.open).rejects.toThrow();
  });

  it("closes the PeerConnection when signaling drops before the channel opens", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (sock) => setTimeout(() => sock.terminate(), 50));
    await new Promise((resolve) => wss.once("listening", resolve));
    try {
      const { port } = wss.address() as AddressInfo;
      const peer = await connectPeer({
        signalUrl: `http://127.0.0.1:${port}`,
        selfId: "a",
        remoteId: "b",
        initiator: true,
      });
      await expect(peer.open).rejects.toThrow();
      await waitFor(() => peer.isClosed(), 5_000);
      expect(pcClose.calls).toBe(1);
    } finally {
      wss.close();
    }
  });
});
