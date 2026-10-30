import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeAuthServer } from "./fake-auth-server.js";
import type { Gateway, NodeRecord } from "./gateway.js";
import { startGateway } from "./gateway.js";
import { completePairing, startPairing } from "./gateway-client.js";
import type { NodeAgent } from "./node-agent.js";
import { startNodeAgent } from "./node-agent.js";
import { generateKeyPair } from "./pairing.js";
import { waitFor } from "./test-util.js";

describe("gateway Better Auth sessions", () => {
  let auth: Awaited<ReturnType<typeof startFakeAuthServer>>;
  let gateway: Gateway;
  let agent: NodeAgent | undefined;
  const registry = new Map<string, NodeRecord>();
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    registry.clear();
    auth = await startFakeAuthServer();
    auth.sessions.set("expired", "expired");
    auth.sessions.set("not-invited", "not-invited");
    auth.sessions.set("down", "down");
    gateway = await startGateway({ port: 0, userVerifier: auth.verifier, registry });
  });
  afterEach(async () => {
    await agent?.close();
    agent = undefined;
    await gateway.close();
    await auth.close();
    vi.restoreAllMocks();
  });
  it.each([
    [undefined, 401, "NO_SESSION"],
    ["expired", 401, "NO_SESSION"],
    ["not-invited", 401, "EMAIL_NOT_INVITED"],
    ["down", 502, "AUTH_UNAVAILABLE"],
  ] as const)(
    "returns structured errors for %s on every user route",
    async (token, status, code) => {
      for (const [method, path] of [
        ["POST", "/pair/start"],
        ["POST", "/sessions"],
        ["DELETE", "/nodes/node"],
        ["POST", "/nodes/node/rpc/echo"],
      ]) {
        const res = await fetch(`${gateway.url}${path}`, {
          method,
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ code });
      }
    },
  );
  it("pairs an invited cookie user, stores display email, and strips credentials from relay", async () => {
    const cookie = "other=value; better-auth.session_token=token";
    const started = await fetch(`${gateway.url}/pair/start`, {
      method: "POST",
      headers: { cookie },
    });
    expect(started.status).toBe(200);
    const { code } = (await started.json()) as { code: string };
    const keyPair = generateKeyPair();
    await completePairing(gateway.url, code, "node", keyPair);
    expect(registry.get("node")).toMatchObject({ user: "user", email: "user@example.test" });
    agent = startNodeAgent({
      gatewayUrl: gateway.url,
      nodeId: "node",
      keyPair,
      handler: async (req) => {
        expect(req.headers).not.toHaveProperty("cookie");
        expect(req.headers).not.toHaveProperty("authorization");
        return { status: 200, headers: {}, body: req.body };
      },
    });
    await waitFor(() => agent?.connected() === true);
    const res = await fetch(`${gateway.url}/nodes/node/rpc/echo`, {
      method: "POST",
      headers: { cookie, authorization: "Bearer token" },
      body: "hello",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });
  it("keeps HTTP relay ownership checks by user id", async () => {
    const { code } = await startPairing(gateway.url, "token");
    await completePairing(gateway.url, code, "node", generateKeyPair());
    const res = await fetch(`${gateway.url}/nodes/node/rpc/echo`, {
      headers: { authorization: "Bearer other-token" },
    });
    expect(res.status).toBe(404);
  });
});
