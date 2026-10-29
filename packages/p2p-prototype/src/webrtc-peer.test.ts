import { cleanup, PeerConnection } from "node-datachannel";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeAuthServer } from "./fake-auth-server.js";
import type { Gateway } from "./gateway.js";
import { startGateway } from "./gateway.js";
import { openSession } from "./gateway-client.js";
import { generateKeyPair, nodeAuthorization } from "./pairing.js";
import type { SignalPayload } from "./protocol.js";
import { connectPeer } from "./webrtc-peer.js";

describe("webrtc peer", () => {
  let gateway: Gateway;
  const keyPair = generateKeyPair();

  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    gateway = await startGateway({
      port: 0,
      userVerifier: authServer.verifier,
      registry: new Map([
        [
          "b",
          {
            user: "user",
            email: "user@example.test",
            publicKey: keyPair.publicKey,
            revoked: false,
          },
        ],
      ]),
    });
  });

  afterAll(async () => {
    await gateway.close();
    cleanup();
    vi.restoreAllMocks();
  });

  it("exchanges a message both ways through gateway signaling", async () => {
    const signalUrl = `${gateway.url}/signal`;
    const { assertion } = await openSession(gateway.url, "token", "b", "a");
    const a = await connectPeer({
      signalUrl,
      selfId: "a",
      remoteId: "b",
      initiator: true,
      authorization: `Assertion ${assertion}`,
    });
    const b = await connectPeer({
      signalUrl,
      selfId: "b",
      remoteId: "a",
      initiator: false,
      authorization: nodeAuthorization(keyPair, "b"),
    });
    await Promise.all([a.open, b.open]);

    a.send("ping");
    b.send("pong");
    const [fromA, fromB] = await Promise.all([
      b.messages[Symbol.asyncIterator]().next(),
      a.messages[Symbol.asyncIterator]().next(),
    ]);

    expect(fromA.value).toBe("ping");
    expect(fromB.value).toBe("pong");
    // A queued terminal message must arrive before the remote observes closure.
    const terminal = "x".repeat(256 * 1024);
    a.send(terminal);
    const closing = a.closeGracefully();
    const messages = b.messages[Symbol.asyncIterator]();
    expect(await messages.next()).toEqual({ value: terminal, done: false });
    expect((await messages.next()).done).toBe(true);
    await closing;
    b.close();
  }, 20_000);

  it("closes after the fallback when the remote never acknowledges BYE", async () => {
    const raw = new PeerConnection("raw", { iceServers: [] });
    let toPeer: (payload: SignalPayload) => void = () => {};
    const a = await connectPeer({
      signalUrl: "http://unused.invalid",
      selfId: "a",
      remoteId: "raw",
      initiator: true,
      closeAckTimeoutMs: 300,
      signaling: {
        send: (p) => {
          if (p.type === "candidate") raw.addRemoteCandidate(p.candidate, p.mid);
          else raw.setRemoteDescription(p.sdp, p.type);
        },
        listen: (receive) => {
          toPeer = receive;
          return () => {};
        },
      },
    });
    raw.onLocalDescription((sdp, type) =>
      toPeer({ type: type === "offer" ? "offer" : "answer", sdp }),
    );
    raw.onLocalCandidate((candidate, mid) => toPeer({ type: "candidate", candidate, mid }));
    const received: unknown[] = [];
    raw.onDataChannel((dc) => dc.onMessage((m) => received.push(m)));
    await a.open;

    const started = Date.now();
    await a.closeGracefully();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect((await a.messages[Symbol.asyncIterator]().next()).done).toBe(true);
    raw.close();
  }, 20_000);
});

let authServer: Awaited<ReturnType<typeof startFakeAuthServer>>;
beforeAll(async () => {
  authServer = await startFakeAuthServer();
});
afterAll(async () => {
  await authServer.close();
});
