import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeAuthServer } from "./fake-auth-server.js";
import { createHttpSessionVerifier } from "./session-verifier.js";

describe("HTTP session verifier", () => {
  let auth: Awaited<ReturnType<typeof startFakeAuthServer>>;
  let now: number;
  beforeEach(async () => {
    auth = await startFakeAuthServer();
    now = Date.now();
  });
  afterEach(async () => {
    await auth.close();
  });
  const credentials = { authorization: "Bearer token" };
  const verifier = (options = {}) =>
    createHttpSessionVerifier({ authBaseUrl: auth.url, clock: () => now, ...options });
  it("forwards cookie verbatim and only Bearer authorization", async () => {
    const cookie = "other=value; better-auth.session_token=token";
    const req = { cookie, authorization: "Bearer token", secret: "do-not-forward" };
    expect(await verifier().verify(req)).toEqual({
      ok: true,
      user: { id: "user", email: "user@example.test" },
    });
    expect(auth.requests[0]).toMatchObject({ cookie, authorization: "Bearer token" });
    expect(auth.requests[0]).not.toHaveProperty("secret");
    expect(await verifier().verify({ cookie, authorization: "Basic secret" })).toMatchObject({
      ok: true,
    });
    expect(auth.requests[1]).not.toHaveProperty("authorization");
    expect(await verifier().verify({ cookie })).toMatchObject({ ok: true });
  });
  it("does not call auth for missing or unsupported credentials", async () => {
    for (const req of [{}, { authorization: "Basic secret" }])
      expect(await verifier().verify(req)).toEqual({ ok: false, status: 401, code: "NO_SESSION" });
    expect(auth.requests).toHaveLength(0);
  });
  it("caches positives until TTL expiry", async () => {
    const v = verifier();
    await v.verify(credentials);
    await v.verify(credentials);
    expect(auth.requests).toHaveLength(1);
    now += 30_000;
    await v.verify(credentials);
    expect(auth.requests).toHaveLength(2);
  });
  it("caps the positive TTL at session expiry", async () => {
    auth.sessions.set("token", { id: "user", email: "user@example.test", expiresAt: now + 100 });
    const v = verifier();
    await v.verify(credentials);
    now += 100;
    expect(await v.verify(credentials)).toEqual({ ok: false, status: 401, code: "NO_SESSION" });
    expect(auth.requests).toHaveLength(2);
  });
  it.each(["expired", "not-invited"] as const)("negative caches %s", async (state) => {
    auth.sessions.set("token", state);
    const v = verifier();
    const expected = {
      ok: false,
      status: 401,
      code: state === "expired" ? "NO_SESSION" : "EMAIL_NOT_INVITED",
    };
    expect(await v.verify(credentials)).toEqual(expected);
    expect(await v.verify(credentials)).toEqual(expected);
    expect(auth.requests).toHaveLength(1);
    now += 5_000;
    await v.verify(credentials);
    expect(auth.requests).toHaveLength(2);
  });
  it("isolates credential combinations", async () => {
    const v = verifier();
    await v.verify(credentials);
    expect(await v.verify({ authorization: "Bearer other-token" })).toMatchObject({
      user: { id: "other" },
    });
    await v.verify({ cookie: "better-auth.session_token=token" });
    await v.verify({ ...credentials, cookie: "better-auth.session_token=token" });
    expect(auth.requests).toHaveLength(4);
  });
  it("does not cache server errors", async () => {
    auth.sessions.set("token", "down");
    const v = verifier();
    for (let i = 0; i < 2; i++)
      expect(await v.verify(credentials)).toEqual({
        ok: false,
        status: 502,
        code: "AUTH_UNAVAILABLE",
      });
    expect(auth.requests).toHaveLength(2);
  });
  it("does not cache network errors", async () => {
    let calls = 0;
    const v = verifier({
      fetch: async () => {
        calls++;
        throw new Error("offline");
      },
    });
    await v.verify(credentials);
    await v.verify(credentials);
    expect(calls).toBe(2);
  });
  it("times out without caching", async () => {
    auth.sessions.set("token", "timeout");
    const v = verifier({ timeoutMs: 30 });
    for (let i = 0; i < 2; i++)
      expect(await v.verify(credentials)).toMatchObject({ status: 502, code: "AUTH_UNAVAILABLE" });
    expect(auth.requests).toHaveLength(2);
  });
  it("honors custom cache TTLs and disabling the cache", async () => {
    const v = verifier({ cacheTtlMs: 100, negativeCacheTtlMs: 10 });
    await v.verify(credentials);
    now += 100;
    await v.verify(credentials);
    expect(auth.requests).toHaveLength(2);
    const missing = { authorization: "Bearer missing" };
    await v.verify(missing);
    now += 10;
    await v.verify(missing);
    expect(auth.requests).toHaveLength(4);
    const uncached = verifier({ cacheTtlMs: 0, negativeCacheTtlMs: 0 });
    await uncached.verify(credentials);
    await uncached.verify(credentials);
    await uncached.verify(missing);
    await uncached.verify(missing);
    expect(auth.requests).toHaveLength(8);
  });
  it.each([
    {},
    { user: { id: "user", email: "user@example.test" }, session: { expiresAt: "invalid" } },
    {
      user: { id: "", email: "user@example.test" },
      session: { expiresAt: "2099-01-01T00:00:00Z" },
    },
  ])("fails closed without caching malformed session responses", async (body) => {
    let calls = 0;
    const v = verifier({
      fetch: async () => {
        calls++;
        return Response.json(body);
      },
    });
    for (let i = 0; i < 2; i++)
      expect(await v.verify(credentials)).toEqual({
        ok: false,
        status: 502,
        code: "AUTH_UNAVAILABLE",
      });
    expect(calls).toBe(2);
  });
  it("evicts the oldest cache entry", async () => {
    const v = verifier();
    await v.verify(credentials);
    for (let i = 0; i < 1_000; i++) await v.verify({ authorization: `Bearer missing-${i}` });
    await v.verify(credentials);
    expect(auth.requests).toHaveLength(1_002);
  });
  it.each(["", "ftp://example.test", "https://user:password@example.test"])(
    "rejects invalid URL %s",
    (authBaseUrl) => {
      expect(() => createHttpSessionVerifier({ authBaseUrl })).toThrow();
    },
  );
});
