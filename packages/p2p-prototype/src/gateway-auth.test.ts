import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Gateway } from "./gateway.js";
import { startGateway } from "./gateway.js";
import { completePairing, openSession, startPairing, unpairNode } from "./gateway-client.js";
import type { KeyPair } from "./pairing.js";
import {
  generateKeyPair,
  nodeAuthorization,
  pairingMessage,
  sign,
  signNodeProof,
} from "./pairing.js";
import { encodeFrame, toWsUrl } from "./protocol.js";
import { waitFor } from "./test-util.js";
import type { TurnCredentials } from "./turn-credentials.js";

const TOKEN = "test-token";
const turn = { secret: "test-secret", urls: ["turn:192.0.2.1:3478"], ttlSeconds: 600 };

describe("gateway authentication", () => {
  let gateway: Gateway;
  let key: KeyPair;
  let now: number;
  const sockets: WebSocket[] = [];
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    now = 1_800_000_000_123;
    key = generateKeyPair();
    gateway = await startGateway({
      port: 0,
      userTokens: new Map([
        ["user", TOKEN],
        ["other", "other-token"],
      ]),
      clock: () => now,
      turn,
    });
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await gateway.close();
    vi.restoreAllMocks();
  });
  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${gateway.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  async function pair() {
    const { code } = await startPairing(gateway.url, TOKEN);
    expect(await completePairing(gateway.url, code, "node", key)).toEqual({
      gatewayPublicKey: gateway.publicKey,
      user: "user",
    });
  }
  const complete = (code: string, signingKey = key) =>
    post("/pair/complete", {
      code,
      nodeId: "node",
      nodePublicKey: key.publicKey,
      sig: sign(signingKey, pairingMessage(code, "node")),
    });
  function ws(path: string, authorization?: string) {
    const socket = new WebSocket(`${toWsUrl(gateway.url)}${path}`, {
      headers: authorization ? { authorization } : {},
    });
    sockets.push(socket);
    return socket;
  }
  async function rejected(path: string, authorization?: string): Promise<number> {
    const socket = ws(path, authorization);
    return new Promise((resolve, reject) => {
      socket.once("unexpected-response", (_req, res) => {
        res.resume();
        socket.terminate();
        resolve(res.statusCode ?? 0);
      });
      socket.on("error", () => {});
      socket.once("open", () => reject(new Error("unexpected successful upgrade")));
    });
  }
  async function badAgent(nodeId = "node", signingKey = key, ts = now) {
    const socket = ws("/agent");
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(encodeFrame({ kind: "hello", ...signNodeProof(signingKey, "agent", nodeId, ts) }));
    return closed;
  }
  const turnRequest = (assertion: string, peer = "peer") =>
    fetch(`${gateway.url}/turn-credentials?peer=${peer}`, {
      headers: { authorization: `Assertion ${assertion}` },
    });

  it("returns 401 on /signal without auth", async () => {
    expect(await rejected("/signal?peer=peer")).toBe(401);
  });
  it("returns 401 on /turn-credentials without auth", async () => {
    expect((await fetch(`${gateway.url}/turn-credentials?peer=peer`)).status).toBe(401);
  });
  it("returns 401 on /agent without auth and closes an unsigned hello with 4401", async () => {
    expect((await fetch(`${gateway.url}/agent`)).status).toBe(401);
    const socket = ws("/agent");
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ kind: "hello", nodeId: "node" }));
    expect(await closed).toBe(4401);
  });
  it("returns 401 on /sessions without auth", async () => {
    expect((await post("/sessions", { nodeId: "node", peerId: "peer" })).status).toBe(401);
  });
  it("returns 401 on /pair/start without auth", async () => {
    expect((await post("/pair/start", {})).status).toBe(401);
  });
  it("rejects a wrong pairing code", async () => {
    expect((await complete("WRONG123")).status).toBe(401);
  });
  it("rejects an expired pairing code with a fake clock", async () => {
    const { code, expiresAt } = await startPairing(gateway.url, TOKEN);
    expect(expiresAt).toBe(now + 120_000);
    now = expiresAt;
    expect((await complete(code)).status).toBe(401);
  });
  it("rejects a replayed pairing code", async () => {
    const { code } = await startPairing(gateway.url, TOKEN);
    expect((await complete(code)).status).toBe(200);
    expect((await complete(code)).status).toBe(401);
  });
  it("rejects a wrong pairing signature without spending the code", async () => {
    const { code } = await startPairing(gateway.url, TOKEN);
    expect((await complete(code, generateKeyPair())).status).toBe(401);
    expect((await complete(code)).status).toBe(200);
  });
  it("rejects an unknown node agent", async () => {
    expect(await badAgent("unknown")).toBe(4401);
  });
  it("rejects a stale agent hello", async () => {
    await pair();
    expect(await badAgent("node", key, now - 30_001)).toBe(4401);
  });
  it("rejects a wrong agent signature", async () => {
    await pair();
    expect(await badAgent("node", generateKeyPair())).toBe(4401);
  });
  it("closes sockets on DELETE and rejects revoked agents and sessions", async () => {
    await pair();
    const agent = ws("/agent");
    await new Promise((resolve) => agent.once("open", resolve));
    agent.send(encodeFrame({ kind: "hello", ...signNodeProof(key, "agent", "node", now) }));
    await waitFor(() => gateway.connectedNodes().length === 1);
    const { assertion } = await openSession(gateway.url, TOKEN, "node", "peer");
    const client = ws("/signal?peer=peer", `Assertion ${assertion}`);
    await new Promise((resolve) => client.once("open", resolve));
    const node = ws("/signal?peer=node", nodeAuthorization(key, "node", now));
    await new Promise((resolve) => node.once("open", resolve));
    const closed = [agent, client, node].map(
      (s) => new Promise<number>((resolve) => s.once("close", resolve)),
    );
    await unpairNode(gateway.url, TOKEN, "node");
    expect(await Promise.all(closed)).toEqual([4401, 4401, 4401]);
    expect(await badAgent()).toBe(4401);
    expect((await post("/sessions", { nodeId: "node", peerId: "peer" }, TOKEN)).status).toBe(404);
    expect(await rejected("/signal?peer=peer", `Assertion ${assertion}`)).toBe(401);
    expect(await rejected("/signal?peer=node", nodeAuthorization(key, "node", now))).toBe(401);
  });
  it("rejects expired assertions", async () => {
    await pair();
    const { assertion, exp } = await openSession(gateway.url, TOKEN, "node", "peer");
    now = exp;
    expect(await rejected("/signal?peer=peer", `Assertion ${assertion}`)).toBe(401);
    expect((await turnRequest(assertion)).status).toBe(401);
  });
  it("rejects tampered assertions", async () => {
    await pair();
    const { assertion } = await openSession(gateway.url, TOKEN, "node", "peer");
    const [body, signature] = assertion.split(".");
    const claims = JSON.parse(Buffer.from(body ?? "", "base64url").toString()) as Record<
      string,
      unknown
    >;
    const tampered = `${Buffer.from(JSON.stringify({ ...claims, peerId: "attacker" })).toString("base64url")}.${signature}`;
    expect(await rejected("/signal?peer=attacker", `Assertion ${tampered}`)).toBe(401);
    expect((await turnRequest(tampered, "attacker")).status).toBe(401);
  });
  it("caps TURN ttl at the assertion remaining lifetime", async () => {
    await pair();
    const { assertion, exp } = await openSession(gateway.url, TOKEN, "node", "peer");
    now += 12_345;
    const res = await turnRequest(assertion);
    const credentials = (await res.json()) as TurnCredentials;
    expect(res.status).toBe(200);
    expect(credentials.ttlSeconds).toBe(47);
    expect(credentials.expiresAt * 1000).toBeLessThanOrEqual(exp);
  });
  it("rejects a peer id different from the assertion", async () => {
    await pair();
    const { assertion } = await openSession(gateway.url, TOKEN, "node", "peer");
    expect(await rejected("/signal?peer=other", `Assertion ${assertion}`)).toBe(403);
    expect((await turnRequest(assertion, "other")).status).toBe(403);
  });
  it("rejects another user's session and unpair requests", async () => {
    await pair();
    expect(
      (await post("/sessions", { nodeId: "node", peerId: "peer" }, "other-token")).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${gateway.url}/nodes/node`, {
          method: "DELETE",
          headers: { authorization: "Bearer other-token" },
        })
      ).status,
    ).toBe(404);
    expect((await post("/sessions", { nodeId: "node", peerId: "peer" }, TOKEN)).status).toBe(200);
  });
  it("closes signaling when a frame is sent after assertion expiry", async () => {
    await pair();
    const { assertion, exp } = await openSession(gateway.url, TOKEN, "node", "peer");
    const socket = ws("/signal?peer=peer", `Assertion ${assertion}`);
    await new Promise((resolve) => socket.once("open", resolve));
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    now = exp;
    socket.send(
      encodeFrame({
        kind: "signal",
        from: "peer",
        to: "node",
        payload: { type: "offer", sdp: "expired" },
      }),
    );
    expect(await closed).toBe(4401);
  });
});
