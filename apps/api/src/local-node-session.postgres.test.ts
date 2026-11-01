import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { LOCAL_NODE_SESSION_PATH, LOCAL_SETTINGS_TOKEN_HEADER } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const token = "ab".repeat(32);
const origin = "http://127.0.0.1:5173";

it.skipIf(!databaseUrl)(
  "a native node with no password, SSO or mail signs in the verified address",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-local-session-"));
    const handles = await createApp({
      databaseUrl: databaseUrl!,
      dataDir,
      sandboxProvider: "fake",
      sandbox: new FakeSandboxProvider(),
      desktopStackToken: token,
      passwordAuth: false,
      emailAllowlist: true,
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      signupAllowlist: "",
      webOrigin: origin,
      authUrl: origin,
    });
    const email = `local-node-${Date.now()}@example.test`;
    const mint = (headers: Record<string, string>, address = email) =>
      handles.app.request(LOCAL_NODE_SESSION_PATH, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: address }),
      });
    try {
      expect((await mint({})).status).toBe(401);
      expect((await mint({ [LOCAL_SETTINGS_TOKEN_HEADER]: token, origin })).status).toBe(403);
      // The server-only endpoint is not reachable through the public auth route.
      expect(
        (
          await handles.app.request("/api/auth/local-node-session", {
            method: "POST",
            headers: { "content-type": "application/json", origin },
            body: JSON.stringify({ email }),
          })
        ).status,
      ).toBe(404);
      const signUp = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, password: "test-password-123", name: "No" }),
      });
      expect(signUp.status).toBeGreaterThanOrEqual(400);
      const capabilities = await handles.app.request("/api/auth/capabilities");
      expect(await capabilities.json()).toMatchObject({ passwordAuth: false, emailCode: false });

      const minted = await mint({ [LOCAL_SETTINGS_TOKEN_HEADER]: token });
      expect(minted.status).toBe(200);
      const cookie = sessionCookieHeader(minted);
      expect(cookie).not.toBe("");
      const session = await handles.app.request("/api/auth/get-session", {
        headers: { cookie },
      });
      expect((await session.json()).user).toMatchObject({ email, emailVerified: true });
      const me = await handles.app.request("/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin },
        body: JSON.stringify({ json: {} }),
      });
      expect(me.status).toBe(200);
      // A second launch reuses the same account.
      expect((await mint({ [LOCAL_SETTINGS_TOKEN_HEADER]: token })).status).toBe(200);
      expect((await mint({ [LOCAL_SETTINGS_TOKEN_HEADER]: token }, "not-an-email")).status).toBe(
        403,
      );
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
