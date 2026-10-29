import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startFakeAuthServer } from "./fake-auth-server.js";
import type { Gateway } from "./gateway.js";
import { startGateway } from "./gateway.js";
import { openSession } from "./gateway-client.js";
import type { LocalHandler, NodeAgent } from "./node-agent.js";
import { startNodeAgent } from "./node-agent.js";
import { generateKeyPair, nodeAuthorization, signNodeProof } from "./pairing.js";
import { encodeFrame, toWsUrl } from "./protocol.js";
import { waitFor } from "./test-util.js";
import type { TurnCredentials } from "./turn-credentials.js";

const TOKEN = "test-token";
const keyPair = generateKeyPair();
const headers = { authorization: `Bearer ${TOKEN}` };
const options = () => ({
  userVerifier: authServer.verifier,
  registry: new Map(
    ["n1", "b"].map((id) => [
      id,
      { user: "user", email: "user@example.test", publicKey: keyPair.publicKey, revoked: false },
    ]),
  ),
});
async function assertionHeaders(gateway: Gateway, peerId = "peer-a", nodeId = "n1") {
  const { assertion } = await openSession(gateway.url, TOKEN, nodeId, peerId);
  return { authorization: `Assertion ${assertion}` };
}

const echoHandler: LocalHandler = async (req) => ({
  status: 200,
  headers: { "content-type": "text/plain", "x-seen-path": req.path },
  body: new TextEncoder().encode(`${req.method} ${new TextDecoder().decode(req.body)}`),
});

describe("gateway and node agent", () => {
  let gateway: Gateway;
  let agent: NodeAgent | undefined;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    gateway = await startGateway({
      port: 0,
      ...options(),
      requestTimeoutMs: 300,
    });
  });

  afterEach(async () => {
    await agent?.close();
    agent = undefined;
    await gateway.close();
    vi.restoreAllMocks();
  });

  async function connectAgent(handler: LocalHandler): Promise<void> {
    agent = startNodeAgent({
      gatewayUrl: gateway.url,
      nodeId: "n1",
      keyPair,
      handler,
      reconnectMs: 50,
    });
    await waitFor(() => agent?.connected() === true);
  }

  it("answers a request through the node", async () => {
    await connectAgent(echoHandler);
    expect(gateway.connectedNodes()).toEqual(["n1"]);

    const res = await fetch(`${gateway.url}/nodes/n1/some/path?q=1`, {
      method: "POST",
      body: "hello",
      headers,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("POST hello");
    expect(res.headers.get("x-seen-path")).toBe("/some/path?q=1");
  });

  it("returns 502 when the node is offline", async () => {
    const res = await fetch(`${gateway.url}/nodes/n1/anything`, { headers });
    expect(res.status).toBe(502);
  });

  it("rejects a bad signature", async () => {
    const ws = new WebSocket(`${toWsUrl(gateway.url)}/agent`);
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(encodeFrame({ kind: "hello", ...signNodeProof(generateKeyPair(), "agent", "n1") }));
    const code = await new Promise<number>((resolve) => ws.once("close", resolve));

    expect(code).toBe(4401);
    expect(gateway.connectedNodes()).toEqual([]);
  });

  it("returns 504 when the node does not answer in time", async () => {
    await connectAgent(() => new Promise(() => {}));
    const res = await fetch(`${gateway.url}/nodes/n1/slow`, { headers });
    expect(res.status).toBe(504);
  });

  it("reconnects after the gateway link drops", async () => {
    await connectAgent(echoHandler);
    await waitFor(() => gateway.connectedNodes().length === 1);
    await gateway.close();
    await waitFor(() => agent?.connected() === false);
    gateway = await startGateway({
      port: Number(new URL(gateway.url).port),
      ...options(),
    });
    await waitFor(() => agent?.connected() === true);
  });
});

describe("gateway turn credentials", () => {
  const turn = { secret: "s3cret", urls: ["turn:192.0.2.10:3478?transport=udp"], ttlSeconds: 600 };
  let gateway: Gateway | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
    vi.restoreAllMocks();
  });

  it("binds to loopback by default", async () => {
    gateway = await startGateway({ port: 0, ...options(), turn });
    expect(new URL(gateway.url).hostname).toBe("127.0.0.1");
  });

  it("issues short-lived credentials without caching", async () => {
    gateway = await startGateway({ port: 0, ...options(), turn });
    const res = await fetch(`${gateway.url}/turn-credentials?peer=peer-a`, {
      headers: await assertionHeaders(gateway),
    });
    const body = (await res.json()) as TurnCredentials;

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.username).toMatch(/^\d+:peer-a$/);
    expect(body.credential).toMatch(/^[A-Za-z0-9+/]{27}=$/);
    expect(body.urls).toEqual(turn.urls);
    expect(body.ttlSeconds).toBeGreaterThan(0);
    expect(body.ttlSeconds).toBeLessThanOrEqual(60);
    expect(JSON.stringify(body)).not.toContain(turn.secret);
  });

  it.each([600, 15])(
    "caps node TURN credentials at session and configured TTL (%i)",
    async (ttlSeconds) => {
      gateway = await startGateway({ port: 0, ...options(), turn: { ...turn, ttlSeconds } });
      const res = await fetch(`${gateway.url}/turn-credentials?peer=n1`, {
        headers: { authorization: nodeAuthorization(keyPair, "n1") },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as TurnCredentials;
      expect(body.ttlSeconds).toBeGreaterThan(0);
      expect(body.ttlSeconds).toBeLessThanOrEqual(60);
      expect(body.ttlSeconds).toBeLessThanOrEqual(ttlSeconds);
    },
  );

  it("returns 404 when turn is not configured", async () => {
    gateway = await startGateway({ port: 0, ...options() });
    const res = await fetch(`${gateway.url}/turn-credentials?peer=peer-a`, {
      headers: await assertionHeaders(gateway),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a missing or mismatched peer", async () => {
    gateway = await startGateway({ port: 0, ...options(), turn });
    for (const query of ["", "?peer=", "?peer=a%3Ab"]) {
      const res = await fetch(`${gateway.url}/turn-credentials${query}`, {
        headers: await assertionHeaders(gateway),
      });
      expect(res.status).toBe(query === "?peer=a%3Ab" ? 403 : 400);
    }
  });
});

describe("gateway pending signals", () => {
  let gateway: Gateway | undefined;
  const sockets: WebSocket[] = [];

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const ws of sockets.splice(0)) ws.terminate();
    await gateway?.close();
    gateway = undefined;
    vi.restoreAllMocks();
  });

  async function connectPeer(peer: string): Promise<{ ws: WebSocket; received: string[] }> {
    if (!gateway) throw new Error("gateway missing");
    const authorization =
      peer === "b"
        ? nodeAuthorization(keyPair, "b")
        : (await assertionHeaders(gateway, peer, "b")).authorization;
    const ws = new WebSocket(`${toWsUrl(gateway.url)}/signal?peer=${peer}`, {
      headers: { authorization },
    });
    sockets.push(ws);
    const received: string[] = [];
    ws.on("message", (data) => received.push(data.toString()));
    await new Promise((resolve) => ws.once("open", resolve));
    return { ws, received };
  }

  const signal = (to: string, sdp: string): string =>
    encodeFrame({ kind: "signal", from: "", to, payload: { type: "offer", sdp } });

  it("drops queued signals that outlive the ttl", async () => {
    gateway = await startGateway({ port: 0, ...options(), pendingSignalTtlMs: 100 });
    const a = await connectPeer("a");
    a.ws.send(signal("b", "stale"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    a.ws.send(signal("b", "fresh"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const b = await connectPeer("b");
    await waitFor(() => b.received.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(b.received.map((raw) => JSON.parse(raw).payload.sdp)).toEqual(["fresh"]);
  });

  it("delivers queued signals within the ttl", async () => {
    gateway = await startGateway({ port: 0, ...options() });
    const a = await connectPeer("a");
    a.ws.send(signal("b", "offer"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const b = await connectPeer("b");
    await waitFor(() => b.received.length === 1);

    expect(JSON.parse(b.received[0] ?? "")).toMatchObject({ from: "a", to: "b" });
  });

  it("drops signals a peer queued for others when its socket closes", async () => {
    gateway = await startGateway({ port: 0, ...options() });
    const a = await connectPeer("a");
    a.ws.send(signal("b", "dead-session"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    a.ws.close();
    await new Promise((resolve) => a.ws.once("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const b = await connectPeer("b");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(b.received).toEqual([]);
  });
});

let authServer: Awaited<ReturnType<typeof startFakeAuthServer>>;
beforeAll(async () => {
  authServer = await startFakeAuthServer();
});
afterAll(async () => {
  await authServer.close();
});
