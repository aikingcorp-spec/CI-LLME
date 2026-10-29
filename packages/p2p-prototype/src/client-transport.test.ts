import { randomUUID } from "node:crypto";
import { cleanup } from "node-datachannel";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeChannelFrame } from "./channel-protocol.js";
import type { ClientCall, ClientTransport } from "./client-transport.js";
import { DataChannelClientTransport, HttpClientTransport } from "./client-transport.js";
import type { Gateway } from "./gateway.js";
import { startGateway } from "./gateway.js";
import { openSession } from "./gateway-client.js";
import type { NodeAgent } from "./node-agent.js";
import { startNodeAgent } from "./node-agent.js";
import { channelHttpHandler, demoHandler } from "./node-channel-server.js";
import { generateKeyPair, signAssertion } from "./pairing.js";
import { waitFor } from "./test-util.js";
import type { DataPeer } from "./webrtc-peer.js";
import { connectPeer } from "./webrtc-peer.js";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (body: Uint8Array) => new TextDecoder().decode(body);
const request = (
  procedure = "echo",
  body = "hello",
  signal = new AbortController().signal,
): ClientCall => ({
  procedure,
  body: encode(body),
  headers: { "content-type": "text/plain" },
  signal,
});

describe("ClientTransport over a real gateway and node agent", () => {
  const keyPair = generateKeyPair();
  const gatewayKey = generateKeyPair();
  let gateway: Gateway;
  let agent: NodeAgent;
  let activeSubscriptions = 0;
  let startedSubscriptions = 0;
  const peers: DataPeer[] = [];
  const clients: DataChannelClientTransport[] = [];
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    gateway = await startGateway({
      port: 0,
      gatewayKey,
      userTokens: new Map([["user", "token"]]),
      registry: new Map([["node", { user: "user", publicKey: keyPair.publicKey, revoked: false }]]),
    });
    const demo = demoHandler();
    const handler = {
      call: demo.call,
      async *subscribe(...args: Parameters<typeof demo.subscribe>) {
        activeSubscriptions++;
        startedSubscriptions++;
        try {
          yield* demo.subscribe(...args);
        } finally {
          activeSubscriptions--;
        }
      },
    };
    activeSubscriptions = 0;
    startedSubscriptions = 0;
    agent = startNodeAgent({
      gatewayUrl: gateway.url,
      nodeId: "node",
      keyPair,
      handler: channelHttpHandler(handler),
      channel: { gatewayPublicKey: gateway.publicKey, allowedUsers: ["user"], handler },
    });
    await waitFor(() => agent.connected());
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const peer of peers.splice(0)) peer.close();
    await agent.close();
    await gateway.close();
    vi.restoreAllMocks();
  });
  afterAll(() => cleanup());
  async function peerConnection() {
    const peerId = randomUUID();
    const session = await openSession(gateway.url, "token", "node", peerId);
    const peer = await connectPeer({
      signalUrl: `${gateway.url}/signal`,
      selfId: peerId,
      remoteId: "node",
      initiator: true,
      authorization: `Assertion ${session.assertion}`,
    });
    peers.push(peer);
    await peer.open;
    return { peer, session };
  }
  async function transport(kind: string): Promise<ClientTransport> {
    if (kind === "http")
      return new HttpClientTransport({ baseUrl: gateway.url, nodeId: "node", userToken: "token" });
    const { peer, session } = await peerConnection();
    const client = new DataChannelClientTransport(peer, session.assertion);
    clients.push(client);
    await client.ready;
    expect(client.selectedPair()).not.toBeNull();
    return client;
  }
  for (const kind of ["http", "data-channel"]) {
    it(`${kind}: echo round-trip preserves bytes and headers`, async () => {
      const client = await transport(kind);
      const req = request();
      req.body = new Uint8Array([0, 255, 1, 2]);
      const response = await client.call(req);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("text/plain");
      expect(response.body).toEqual(req.body);
    });
    it(`${kind}: subscription yields ordered event-stream bytes`, async () => {
      const client = await transport(kind);
      const chunks: string[] = [];
      for await (const chunk of client.subscribe(
        request("ticks", JSON.stringify({ count: 3, intervalMs: 2 })),
      ))
        chunks.push(decode(chunk));
      expect(chunks.join("")).toBe("data: tick 0\n\ndata: tick 1\n\ndata: tick 2\n\n");
      expect(chunks).toHaveLength(kind === "http" ? 1 : 3);
    });
    it(`${kind}: abort stops consumption and node subscription work`, async () => {
      const client = await transport(kind);
      const controller = new AbortController();
      const stream = client
        .subscribe(
          request("ticks", JSON.stringify({ count: 100, intervalMs: 20 }), controller.signal),
        )
        [Symbol.asyncIterator]();
      const next = stream.next();
      if (kind === "data-channel") {
        expect(decode((await next).value as Uint8Array)).toBe("data: tick 0\n\n");
      } else {
        // Buffered relay has no first chunk until completion.
        void next.catch(() => {});
        await waitFor(() => startedSubscriptions > 0);
      }
      controller.abort();
      await expect(kind === "http" ? next : stream.next()).rejects.toThrow();
      await waitFor(() => activeSubscriptions === 0);
      expect((await client.call(request())).status).toBe(200);
    });
    it(`${kind}: pre-aborted requests reject`, async () => {
      const client = await transport(kind);
      const controller = new AbortController();
      controller.abort();
      await expect(client.call(request("echo", "", controller.signal))).rejects.toThrow();
      await expect(
        client
          .subscribe(request("ticks", "", controller.signal))
          [Symbol.asyncIterator]()
          .next(),
      ).rejects.toThrow();
    });
  }
  it.each(["bad", "expired"])("denies a %s assertion on the data channel", async (mode) => {
    const { peer } = await peerConnection();
    const assertion =
      mode === "bad"
        ? "invalid"
        : signAssertion(gatewayKey, {
            nodeId: "node",
            user: "user",
            peerId: "expired",
            exp: Date.now() - 1000,
          });
    peer.send(JSON.stringify({ t: "hello", assertion }));
    const messages = peer.messages[Symbol.asyncIterator]();
    expect(decodeChannelFrame((await messages.next()).value as string)).toEqual({ t: "denied" });
    expect((await messages.next()).done).toBe(true);
  });
  it("closes a channel when its bearer is revoked", async () => {
    const { peer, session } = await peerConnection();
    peer.send(JSON.stringify({ t: "hello", assertion: session.assertion }));
    const messages = peer.messages[Symbol.asyncIterator]();
    const welcome = decodeChannelFrame((await messages.next()).value as string);
    expect(welcome.t).toBe("welcome");
    if (welcome.t !== "welcome") throw new Error("missing welcome");
    expect(agent.auth?.revokeBearer(welcome.bearer)).toBe(true);
    expect((await messages.next()).done).toBe(true);
    expect(() =>
      peer.send(
        JSON.stringify({
          t: "call",
          bearer: welcome.bearer,
          id: "after",
          procedure: "echo",
          headers: {},
          body: "",
        }),
      ),
    ).toThrow();
  });
  it("rejects pending subscriptions and subsequent calls after revocation", async () => {
    const client = await transport("data-channel");
    const stream = client
      .subscribe(request("ticks", JSON.stringify({ count: 100, intervalMs: 10 })))
      [Symbol.asyncIterator]();
    await stream.next();
    expect(agent.auth?.revokeUser("user")).toBe(1);
    await expect(stream.next()).rejects.toThrow("channel closed");
    await expect(client.call(request())).rejects.toThrow("channel closed");
    await waitFor(() => activeSubscriptions === 0);
  });
  it("multiplexes clients and concurrent calls independently", async () => {
    const a = await transport("data-channel");
    const b = await transport("data-channel");
    const results = await Promise.all([
      a.call(request("echo", "a")),
      b.call(request("echo", "b")),
      a.call(request("echo", "c")),
    ]);
    expect(results.map((res) => decode(res.body))).toEqual(["a", "b", "c"]);
  });
});
