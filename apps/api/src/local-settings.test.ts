import {
  LOCAL_COMPUTER_HOST_PATH,
  LOCAL_NODE_SESSION_PATH,
  LOCAL_SETTINGS_TOKEN_HEADER,
} from "@rakazo/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  mountLocalComputerHost,
  mountLocalNodeSession,
  validLocalSettingsToken,
} from "./local-settings.js";

const token = "ab".repeat(32);
function fixture(sandboxProvider = "docker") {
  const upsert = vi.fn(async () => ({}));
  const app = new Hono();
  mountLocalComputerHost(app, {
    token,
    sandboxProvider,
    prisma: { deploymentSettings: { upsert } } as never,
  });
  const request = (body = "{}", supplied: string | null = token) =>
    app.request(LOCAL_COMPUTER_HOST_PATH, {
      method: "POST",
      headers: {
        ...(supplied === null ? {} : { [LOCAL_SETTINGS_TOKEN_HEADER]: supplied }),
        cookie: "session=fake",
      },
      body,
    });
  return { app, request, upsert };
}

describe("native computer host capability", () => {
  it("refuses session cookies without the private native token", async () => {
    const f = fixture();
    for (const supplied of [null, "", "cd".repeat(32), `${token}x`]) {
      expect((await f.request('{"computerHost":"this-mac"}', supplied)).status).toBe(401);
    }
    expect(f.upsert).not.toHaveBeenCalled();
    expect(validLocalSettingsToken(undefined, token)).toBe(false);
    expect(validLocalSettingsToken(token, token)).toBe(true);
  });
  it("does not grant account settings or server administration even with the native token", async () => {
    const f = fixture();
    for (const procedure of [
      "me",
      "models/list",
      "models/connect",
      "deployment/update",
      "integrationSetup/save",
      "security/events",
      "updater/apply",
    ]) {
      expect(
        (
          await f.app.request(`/api/desktop-settings/rpc/${procedure}`, {
            method: "POST",
            headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: token },
            body: "{}",
          })
        ).status,
      ).toBe(403);
    }
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it("saves only a bounded host choice on the app-managed Docker instance", async () => {
    const f = fixture();
    expect((await f.request('{"computerHost":"this-mac"}')).status).toBe(200);
    expect(f.upsert).toHaveBeenCalledWith({
      where: { id: "default" },
      create: { id: "default", computerHost: "this-mac" },
      update: { computerHost: "this-mac" },
    });
    for (const body of ["null", "{", '{"computerHost":"remote"}'])
      expect((await f.request(body)).status).toBe(400);
    expect((await f.request("x".repeat(1025))).status).toBe(413);
    expect((await fixture("e2b").request('{"computerHost":"this-mac"}')).status).toBe(403);
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("local node session", () => {
  function session(webOrigin = "http://127.0.0.1:5173", configured: string | null = token) {
    const mint = vi.fn(async (_email: string) => ["better-auth.session_token=abc; Path=/"]);
    const app = new Hono();
    mountLocalNodeSession(app, { token: configured ?? undefined, webOrigin, mint });
    const request = (supplied: string | null = token, body = '{"email":"e2e@example.com"}') =>
      app.request(LOCAL_NODE_SESSION_PATH, {
        method: "POST",
        headers: supplied === null ? {} : { [LOCAL_SETTINGS_TOKEN_HEADER]: supplied },
        body,
      });
    return { mint, request };
  }

  it("mints a session for the verified address with the private token", async () => {
    const f = session();
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual(["better-auth.session_token=abc; Path=/"]);
    expect(f.mint).toHaveBeenCalledExactlyOnceWith("e2e@example.com");
  });

  it("rejects any request without the private token", async () => {
    const f = session();
    for (const supplied of [null, "", "cd".repeat(32), `${token}x`]) {
      const response = await f.request(supplied);
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(f.mint).not.toHaveBeenCalled();
  });

  it("is closed on a node with no token", async () => {
    const f = session("http://127.0.0.1:5173", null);
    expect((await f.request()).status).toBe(401);
    expect(f.mint).not.toHaveBeenCalled();
  });

  it("is closed on a node served beyond loopback, even with the token", async () => {
    const f = session("https://vnbot.example.com");
    expect((await f.request()).status).toBe(403);
    expect(f.mint).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const f = session();
    expect((await f.request(token, "not json")).status).toBe(400);
    expect((await f.request(token, '{"email":1}')).status).toBe(400);
    expect((await f.request(token, JSON.stringify({ email: "a".repeat(2000) }))).status).toBe(413);
    expect((await f.request(token, JSON.stringify({ email: "a".repeat(300) }))).status).toBe(400);
    expect(f.mint).not.toHaveBeenCalled();
  });

  it("does not reveal why the node refused the address", async () => {
    const f = session();
    f.mint.mockRejectedValueOnce(new Error("Registration is closed"));
    const response = await f.request();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Could not open a session" });
  });
});
