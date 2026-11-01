import { afterEach, describe, expect, it, vi } from "vitest";
import { serveHostedApp } from "./hosted-app.js";

describe("hosted app boundary", () => {
  afterEach(() => vi.unstubAllGlobals());
  const assets = {
    fetch: vi.fn(
      async () =>
        new Response("<div id='root'></div>", { headers: { "content-type": "text/html" } }),
    ),
  };
  const env = {
    ASSETS: assets as unknown as Fetcher,
    AUTH_ORIGIN: "https://accounts.example.test",
    P2P_GATEWAY_URL: "https://p2p.example.test",
  };
  const request = (path: string, init?: RequestInit) =>
    new Request(`https://app.example.test${path}`, init);
  it("serves real assets with the configured signaling CSP", async () => {
    const response = await serveHostedApp(request("/app"), env);
    expect(await response.text()).toContain("id='root'");
    expect(response.headers.get("content-security-policy")).toContain("wss://p2p.example.test");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });
  it.each([
    "/rpc/bots/list",
    "/api/voice/speak",
    "/api/auth/admin/list-users",
    "/novnc",
    "/assets/index.js.map",
  ])("refuses node or private path %s", async (path) => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    expect((await serveHostedApp(request(path), env)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("forwards only account credentials and preserves host-only session cookies", async () => {
    const upstream = vi.fn(
      async () =>
        new Response("{}", {
          headers: { "set-cookie": "session=example; Path=/; HttpOnly; Secure; SameSite=Lax" },
        }),
    );
    vi.stubGlobal("fetch", upstream);
    const response = await serveHostedApp(
      request("/api/auth/sign-in/email-otp", {
        method: "POST",
        headers: {
          origin: "https://app.example.test",
          "content-type": "application/json",
          authorization: "do-not-forward",
          "x-forwarded-host": "untrusted.example.test",
        },
        body: '{"email":"person@example.test","otp":"123456"}',
      }),
      env,
    );
    expect(response.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe(env.AUTH_ORIGIN);
    expect(new Headers(init.headers).get("authorization")).toBe("do-not-forward");
    expect(new Headers(init.headers).get("x-forwarded-host")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
  it("rejects foreign origins before forwarding OTP requests", async () => {
    expect(
      (
        await serveHostedApp(
          request("/api/auth/sign-out", {
            method: "POST",
            headers: { origin: "https://evil.example.test" },
          }),
          env,
        )
      ).status,
    ).toBe(403);
  });
  it("fails closed without a separate HTTPS account service", async () => {
    expect(
      (
        await serveHostedApp(request("/api/auth/get-session"), {
          ...env,
          AUTH_ORIGIN: "https://app.example.test",
        })
      ).status,
    ).toBe(503);
  });
});
