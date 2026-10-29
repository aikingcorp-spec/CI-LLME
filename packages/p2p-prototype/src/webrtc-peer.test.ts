import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup } from "node-datachannel";
import type { Gateway } from "./gateway.js";
import { startGateway } from "./gateway.js";
import { connectPeer } from "./webrtc-peer.js";

describe("webrtc peer", () => {
  let gateway: Gateway;

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    gateway = await startGateway({ port: 0, nodeTokens: new Map() });
  });

  afterAll(async () => {
    await gateway.close();
    cleanup();
    vi.restoreAllMocks();
  });

  it("exchanges a message both ways through gateway signaling", async () => {
    const signalUrl = `${gateway.url}/signal`;
    const a = await connectPeer({ signalUrl, selfId: "a", remoteId: "b", initiator: true });
    const b = await connectPeer({ signalUrl, selfId: "b", remoteId: "a", initiator: false });
    await Promise.all([a.open, b.open]);

    a.send("ping");
    b.send("pong");
    const [fromA, fromB] = await Promise.all([
      b.messages[Symbol.asyncIterator]().next(),
      a.messages[Symbol.asyncIterator]().next(),
    ]);

    expect(fromA.value).toBe("ping");
    expect(fromB.value).toBe("pong");
    a.close();
    b.close();
  }, 20_000);
});
