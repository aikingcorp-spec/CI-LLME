import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeSandboxProvider } from "@rakazo/adapters";
import { LOCAL_COMPUTER_HOST_PATH, LOCAL_SETTINGS_TOKEN_HEADER } from "@rakazo/contracts";
import { asSystem, bootstrapUserSpace, runAsSystem } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.js";
import { createApp } from "./app.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const origin = "http://127.0.0.1:5173";
const osToken = "ab".repeat(32);
const bridgeToken = "cd".repeat(32);
const authSecret = "native-host-choice-test-secret-32-characters";

it.skipIf(!databaseUrl).each([
  { sandboxProvider: "docker", nativeToken: true, bridge: true, expected: true },
  { sandboxProvider: "docker", nativeToken: false, bridge: false, expected: false },
  { sandboxProvider: "fake", nativeToken: true, bridge: true, expected: false },
  { sandboxProvider: "none", nativeToken: true, bridge: true, expected: true },
  { sandboxProvider: "none", nativeToken: true, bridge: false, expected: false },
  { sandboxProvider: "none", nativeToken: false, bridge: true, expected: false },
  { sandboxProvider: "e2b", nativeToken: true, bridge: true, expected: false },
])("derives native host choice from the configured bridge and actor (%j)", async (fixture) => {
  vi.stubEnv("SANDBOX_HOST_URL", fixture.bridge ? "http://127.0.0.1:45175" : "");
  vi.stubEnv("SANDBOX_HOST_TOKEN", fixture.bridge ? bridgeToken : "");
  const dataDir = await mkdtemp(join(tmpdir(), "vnbot-host-choice-"));
  const email = `host-choice-${randomUUID()}@example.test`;
  const userIds: string[] = [];
  const organizationIds: string[] = [];
  const handles = await createApp({
    databaseUrl: databaseUrl!,
    dataDir,
    sandboxProvider: fixture.sandboxProvider,
    sandbox: new FakeSandboxProvider(),
    desktopStackToken: fixture.nativeToken ? osToken : undefined,
    authSecret,
    agentRuntime: "scripted",
    wakeupDriver: "memory",
    signupsEnabled: "true",
    signupAllowlist: "",
    webOrigin: origin,
    authUrl: origin,
  });
  const system = asSystem(handles.prisma);
  async function profile(cookie: string, spaceId?: string) {
    for (const procedure of ["me", "bootstrap"]) {
      const response = await handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          origin,
          ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
        },
        body: JSON.stringify({ json: {} }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(JSON.stringify(payload)).not.toContain(bridgeToken);
      expect(JSON.stringify(payload)).not.toContain(osToken);
      const me = procedure === "me" ? payload.json : payload.json.me;
      expect(me.canChooseHostComputer).toBe(fixture.expected);
      yieldProfile.push(me);
    }
  }
  const yieldProfile: Array<{ sandboxProvider: string; computerHost: string | null }> = [];
  try {
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password: "test-password-123", name: "Host tester" }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const user = await system.user.findUniqueOrThrow({ where: { email } });
    userIds.push(user.id);
    await system.user.update({ where: { id: user.id }, data: { emailVerified: true } });
    const ownSpaces = await system.space.findMany({
      where: { createdByUserId: user.id },
      select: { id: true, organizationId: true },
    });
    organizationIds.push(...ownSpaces.map((s) => s.organizationId));
    await profile(cookie);
    if (fixture.sandboxProvider === "none" && fixture.bridge && fixture.nativeToken) {
      const selectHost = async (computerHost: "this-mac" | "docker") => {
        const response = await handles.app.request(LOCAL_COMPUTER_HOST_PATH, {
          method: "POST",
          headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: osToken },
          body: JSON.stringify({ computerHost }),
        });
        expect(response.status).toBe(200);
      };
      await selectHost("this-mac");
      yieldProfile.length = 0;
      await profile(cookie);
      expect(yieldProfile).toEqual([
        expect.objectContaining({ sandboxProvider: "desktop", computerHost: "this-mac" }),
        expect.objectContaining({ sandboxProvider: "desktop", computerHost: "this-mac" }),
      ]);
      const guestId = randomUUID();
      userIds.push(guestId);
      await system.user.create({
        data: { id: guestId, email: `${guestId}@example.test`, emailVerified: true, name: "Guest" },
      });
      const guestSpace = await runAsSystem(
        "seed own personal Space for native access refusal",
        () =>
          bootstrapUserSpace(handles.prisma, { id: guestId }),
      );
      const guestOrganization = await system.space.findUniqueOrThrow({
        where: { id: guestSpace.spaceId },
        select: { organizationId: true },
      });
      organizationIds.push(guestOrganization.organizationId);
      const token = randomUUID();
      await system.session.create({
        data: { id: token, token, userId: guestId, expiresAt: new Date(Date.now() + 3600000) },
      });
      const signed = token + "." + createHmac("sha256", authSecret).update(token).digest("base64");
      const guestCookie = "better-auth.session_token=" + encodeURIComponent(signed);
      for (const procedure of ["me", "bootstrap"]) {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie: guestCookie },
          body: JSON.stringify({ json: {} }),
        });
        expect(response.status).toBe(200);
        const payload = await response.json();
        const me = procedure === "me" ? payload.json : payload.json.me;
        expect(me).toMatchObject({
          canChooseHostComputer: false,
          sandboxProvider: "none",
          computerHost: null,
        });
      }
      await selectHost("docker");
      yieldProfile.length = 0;
      await profile(cookie);
      expect(yieldProfile.every((me) => me.sandboxProvider === "none")).toBe(true);
    }
  } finally {
    try {
      await system.organization.deleteMany({ where: { id: { in: organizationIds } } });
      await system.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }
});
