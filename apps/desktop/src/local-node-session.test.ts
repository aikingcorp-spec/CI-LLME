import { describe, expect, it, vi } from "vitest";
import { ensureLocalNodeSession, parseSessionCookie } from "./local-node-session.js";

const ORIGIN = "http://127.0.0.1:43103";
const TOKEN = "ab".repeat(32);

function fixture(input: { session?: unknown; mint?: Response; stored?: boolean } = {}) {
  const set = vi.fn(async () => undefined);
  const cookies = {
    get: vi.fn(async () => (input.stored ? [{ name: "s", value: "old" }] : [])),
    set,
  };
  const request = vi.fn(async (url: string) =>
    url.endsWith("/get-session")
      ? Response.json(input.session ?? null)
      : (input.mint ??
        new Response('{"ok":true}', {
          headers: {
            "set-cookie":
              "better-auth.session_token=abc%2E1; Max-Age=600; Path=/; HttpOnly; SameSite=Lax",
          },
        })),
  );
  const run = (email: string | null = "e2e@example.com", origin = ORIGIN) =>
    ensureLocalNodeSession({
      origin,
      token: TOKEN,
      email,
      cookies,
      request: request as unknown as typeof fetch,
    });
  return { run, request, set };
}

describe("ensureLocalNodeSession", () => {
  it("opens a session with the private token and stores its cookie", async () => {
    const f = fixture();
    await f.run();
    const [url, init] = f.request.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/desktop-settings/session`);
    expect((init.headers as Record<string, string>)["x-rakazo-local-settings-token"]).toBe(TOKEN);
    expect(init.body).toBe('{"email":"e2e@example.com"}');
    expect(f.set).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        url: ORIGIN,
        name: "better-auth.session_token",
        value: "abc%2E1",
        httpOnly: true,
        sameSite: "lax",
      }),
    );
  });

  it("keeps a session already open for the same address", async () => {
    const f = fixture({ session: { user: { email: "E2E@example.com" } }, stored: true });
    await f.run();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.set).not.toHaveBeenCalled();
  });

  it("replaces a session that belongs to another address", async () => {
    const f = fixture({ session: { user: { email: "other@example.com" } }, stored: true });
    await f.run();
    expect(f.set).toHaveBeenCalledOnce();
  });

  it("keeps an earlier session when this install has no verified address, and fails without one", async () => {
    await fixture({ session: { user: { email: "old@example.com" } } }).run(null);
    const f = fixture();
    await expect(f.run(null)).rejects.toThrow("No verified address");
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("never sends the token beyond this computer", async () => {
    const f = fixture();
    await expect(f.run("e2e@example.com", "https://vnbot.example.com")).rejects.toThrow(
      "Invalid local node target",
    );
    expect(f.request).not.toHaveBeenCalled();
  });

  it("fails when the node refuses or returns no session", async () => {
    await expect(fixture({ mint: new Response("{}", { status: 401 }) }).run()).rejects.toThrow(
      "refused",
    );
    await expect(fixture({ mint: new Response("{}") }).run()).rejects.toThrow("no session");
  });
});

it("reads a Set-Cookie line, with an expiry from Max-Age", () => {
  expect(
    parseSessionCookie("a=b; Max-Age=60; Path=/x; Secure; SameSite=None", ORIGIN, 1000),
  ).toEqual({
    url: ORIGIN,
    name: "a",
    value: "b",
    path: "/x",
    secure: true,
    sameSite: "no_restriction",
    expirationDate: 61,
  });
  expect(parseSessionCookie("nonsense", ORIGIN)).toBeNull();
});
