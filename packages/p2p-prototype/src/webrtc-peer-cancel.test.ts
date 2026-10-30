import { cleanup } from "node-datachannel";
import { afterAll, describe, expect, it } from "vitest";
import type { SignalPayload } from "./protocol.js";
import { waitFor } from "./test-util.js";
import { connectPeer } from "./webrtc-peer.js";

afterAll(() => cleanup());

const fakeSignaling = () => {
  const sent: SignalPayload[] = [];
  let deliver: (p: SignalPayload) => void = () => {};
  return {
    sent,
    deliver: (p: SignalPayload) => deliver(p),
    signaling: {
      send: (p: SignalPayload) => sent.push(p),
      listen: (receive: (p: SignalPayload) => void) => {
        deliver = receive;
        return () => {};
      },
    },
  };
};

describe("attempt cancel", () => {
  it("cancels its attempt on the remote when closed before the channel opens", async () => {
    const s = fakeSignaling();
    const peer = await connectPeer({
      signalUrl: "",
      signaling: s.signaling,
      selfId: "a",
      remoteId: "b",
      initiator: true,
    });
    await waitFor(() => s.sent.some((p) => p.type === "offer"), 5_000);
    peer.close();
    const offer = s.sent.find((p) => p.type === "offer");
    expect(offer?.attemptId).toBeTruthy();
    expect(s.sent).toContainEqual({ type: "cancel", attemptId: offer?.attemptId });
  });

  it("does not echo a cancel back to the remote that cancelled", async () => {
    const s = fakeSignaling();
    const peer = await connectPeer({
      signalUrl: "",
      signaling: s.signaling,
      selfId: "a",
      remoteId: "b",
      initiator: true,
    });
    await waitFor(() => s.sent.some((p) => p.type === "offer"), 5_000);
    const attemptId = s.sent.find((p) => p.type === "offer")?.attemptId ?? "";
    s.deliver({ type: "cancel", attemptId });
    await expect(peer.open).rejects.toThrow();
    expect(s.sent.filter((p) => p.type === "cancel")).toEqual([]);
  });
});
