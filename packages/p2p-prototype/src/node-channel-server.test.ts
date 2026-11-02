import { expect, it, vi } from "vitest";
import { createNodeAuth } from "./node-auth.js";
import { createNodeChannelServer } from "./node-channel-server.js";
import { generateKeyPair, signAssertion } from "./pairing.js";
import type { DataPeer } from "./peer-core.js";

it("contains a failed response send to its channel and revokes the session", async () => {
  const key = generateKeyPair();
  const auth = createNodeAuth({
    nodeId: "node",
    keyPair: generateKeyPair(),
    gatewayPublicKey: key.publicKey,
    allowedUsers: ["user"],
  });
  const assertion = signAssertion(key, {
    nodeId: "node",
    peerId: "peer",
    user: "user",
    exp: Date.now() + 60000,
  });
  let bearer = "";
  let release!: () => void;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const close = vi.fn(async () => {
    release();
  });
  const peer: DataPeer = {
    open: Promise.resolve(),
    localCandidates: [],
    selectedPair: () => null,
    close: () => {},
    closeGracefully: close,
    isClosed: () => false,
    send(raw) {
      const frame = JSON.parse(raw);
      if (frame.t === "welcome") bearer = frame.bearer;
      else throw new Error("data channel is not open");
    },
    messages: {
      async *[Symbol.asyncIterator]() {
        yield JSON.stringify({ t: "hello", assertion });
        yield JSON.stringify({
          t: "call",
          bearer,
          id: "request",
          procedure: "echo",
          headers: {},
          body: "",
        });
        await closed;
      },
    },
  };
  const server = createNodeChannelServer(auth, {
    call: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    async *subscribe() {},
  });
  await server.accept(peer);
  expect(close).toHaveBeenCalledOnce();
  expect(auth.checkBearer(bearer)).toBeUndefined();
});
