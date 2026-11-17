import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addAllowlistEmail } from "@rakazo/auth";
import { WEB_APP_NOT_INCLUDED } from "@rakazo/contracts";
import { runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

describe.skipIf(!hasDb)("a free account on the hosted server", () => {
  let app: App;
  let stop: () => Promise<void>;
  const suffix = Date.now();
  const free = `free-${suffix}@rakazo.test`;
  const team = `team-${suffix}@rakazo.test`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-editions-"));

  beforeAll(async () => {
    const { createApp } = await import("./app.js");
    const handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      emailAllowlist: true,
    });
    app = handles.app;
    stop = handles.stop;
    await runAsSystem("list the test addresses", async () => {
      await addAllowlistEmail(handles.prisma, free, { edition: "free" });
      await addAllowlistEmail(handles.prisma, team);
    });
  });

  afterAll(async () => {
    await stop?.();
  });

  it("keeps the web app and the download page for team accounts while allowing portal host listing for free accounts", async () => {
    const freeCookie = await signup(app, free);
    const teamCookie = await signup(app, team);

    const refused = await rpc(app, freeCookie, "spaces/list");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ json: { code: WEB_APP_NOT_INCLUDED } });
    expect((await rpc(app, teamCookie, "spaces/list")).status).toBe(200);

    const freePortal = await rpc(app, freeCookie, "remoteHosts/list");
    expect(freePortal.status).toBe(200);
    expect(await freePortal.json()).toMatchObject({
      json: { kind: "empty", devices: [], edition: "free" },
    });

    expect((await app.request("/api/desktop-downloads")).status).toBe(401);
    const downloads = await app.request("/api/desktop-downloads", {
      headers: { cookie: freeCookie },
    });
    expect(downloads.status).toBe(403);
  });
});

async function signup(app: App, email: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password: "test-password-123", name: "Edition User" }),
  });
  expect(response.status).toBeLessThan(400);
  return sessionCookieHeader(response);
}

function rpc(app: App, cookie: string, proc: string, body: unknown = {}) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: body }),
  });
}
