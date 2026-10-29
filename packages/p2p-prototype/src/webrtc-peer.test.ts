import { cleanup } from "node-datachannel";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startFakeAuthServer } from "./fake-auth-server.js";
import type { Gateway } from "./gateway.js";
import { startGateway } from "./gateway.js";
import { openSession } from "./gateway-client.js";
import { generateKeyPair, nodeAuthorization } from "./pairing.js";
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
    a.close();
    b.close();
  }, 20_000);
});

let authServer: Awaited<ReturnType<typeof startFakeAuthServer>>;
beforeAll(async () => {
  authServer = await startFakeAuthServer();
});
afterAll(async () => {
  await authServer.close();
});
