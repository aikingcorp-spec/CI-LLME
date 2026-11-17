import { createHmac, generateKeyPairSync } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { emailOTP } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signedBearer } from "./account-security.js";
import type { IdentityExchangeConfig } from "./identity-exchange.js";
import { identityExchange, issueIdentityProof, verifyIdentityProof } from "./identity-exchange.js";
import { createRemoteDeviceKey } from "./remote-device-key.js";
import { issueRemoteEnterTicket } from "./remote-enter-ticket.js";

const keys = generateKeyPairSync("ed25519");
const issuer = {
  kind: "issuer",
  issuer: "https://identity.example.test",
  audience: "local-session",
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
} satisfies IdentityExchangeConfig;
const local = {
  kind: "local",
  issuer: issuer.issuer,
  audience: issuer.audience,
  publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  deviceId: "test-device",
  centralAuthUrl: "https://identity.example.test/api/auth",
  centralOrigin: "https://app.example.test",
} satisfies IdentityExchangeConfig;
const source = { id: "subject", email: "test@example.test", emailVerified: true };
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("identity proof", () => {
  it("verifies real Ed25519 signatures and rejects an unverified source", async () => {
    const proof = await issueIdentityProof(issuer, source, {
      device: local.deviceId,
      nonce: "nonce",
    });
    expect(await verifyIdentityProof(local, proof, "nonce")).toMatchObject({ subject: source.id });
    await expect(
      issueIdentityProof(
        issuer,
        { ...source, emailVerified: false },
        { device: local.deviceId, nonce: "nonce" },
      ),
    ).rejects.toThrow();
  });
  it.each(["issuer", "audience", "deviceId", "publicKey"] as const)(
    "rejects a different %s",
    async (field) => {
      const proof = await issueIdentityProof(issuer, source, {
        device: local.deviceId,
        nonce: "nonce",
      });
      await expect(
        verifyIdentityProof({ ...local, [field]: "wrong" }, proof, "nonce"),
      ).rejects.toThrow();
    },
  );
  it("rejects wrong nonce, tampering and expiration", async () => {
    const proof = await issueIdentityProof(issuer, source, {
      device: local.deviceId,
      nonce: "nonce",
    });
    await expect(verifyIdentityProof(local, proof, "wrong")).rejects.toThrow();
    await expect(
      verifyIdentityProof(local, `${proof.slice(0, -10)}tampered`, "nonce"),
    ).rejects.toThrow();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    await expect(verifyIdentityProof(local, proof, "nonce")).rejects.toThrow();
  });
});

function servers(
  devicePrivateKey?: string,
  resolveRemoteEnter?: (input: {
    accountId: string;
    email?: string;
    inviteToken?: string;
    createUser: (email: string) => Promise<string | null>;
  }) => Promise<string | null>,
  legacyAccountsClaimable?: boolean,
) {
  const enrolled: { accountId: string; deviceId: string; publicKey: string }[] = [];
  const centralData: Record<
    "user" | "session" | "account" | "verification",
    Record<string, unknown>[]
  > = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const localData: typeof centralData = { user: [], session: [], account: [], verification: [] };
  let code = "";
  let failAccount = false;
  const options = {
    secret: "offline-test-secret-with-at-least-32-characters",
    trustedOrigins: [local.centralOrigin, "https://local.example.test"],
    rateLimit: { enabled: false },
  };
  const central = betterAuth({
    ...options,
    baseURL: issuer.issuer,
    database: memoryAdapter(centralData),
    plugins: [
      signedBearer,
      emailOTP({
        sendVerificationOTP: async (value) => {
          code = value.otp;
        },
      }),
      identityExchange(issuer, {
        enrollRemoteDevice: async (input) => {
          enrolled.push(input);
          return { kind: "enrolled" };
        },
      }),
    ],
  });
  const receiver = betterAuth({
    ...options,
    baseURL: "https://local.example.test",
    database: memoryAdapter(localData),
    databaseHooks: {
      account: {
        create: {
          before: async () => {
            if (failAccount) throw new Error("offline binding persistence failure");
          },
        },
      },
    },
    plugins: [
      signedBearer,
      identityExchange(devicePrivateKey ? { ...local, devicePrivateKey } : local, {
        resolveRemoteEnter,
        legacyAccountsClaimable,
      }),
    ],
  });
  const seen: { url: string; authorization: string | null; locale: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    seen.push({
      url,
      authorization: request.headers.get("authorization"),
      locale: request.headers.get("x-rakazo-locale"),
    });
    return central.handler(request);
  });
  const call = (path: string, body: unknown, cookie?: string) =>
    receiver.handler(
      new Request(`https://local.example.test/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://local.example.test",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  return {
    central,
    receiver,
    centralData,
    localData,
    seen,
    enrolled,
    call,
    code: () => code,
    failAccount: (value: boolean) => {
      failAccount = value;
    },
  };
}

it("runs in-app OTP through the issuer and local session caller, then logs out locally", async () => {
  const f = servers();
  expect((await f.call("/email-otp/send-verification-otp", { email: source.email })).status).toBe(
    200,
  );
  const response = await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() });
  expect(response.status).toBe(200);
  expect(f.localData.account).toHaveLength(1);
  expect(f.localData.account[0]).toMatchObject({ providerId: "verified-identity" });
  expect(f.localData.account[0]!.id).toBe(`identity:${f.localData.account[0]!.accountId}`);
  expect(f.localData.session).toHaveLength(1);
  expect(f.centralData.session).toHaveLength(0);
  expect(f.localData.verification).toHaveLength(0);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeTruthy();
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  const session = await f.receiver.api.getSession({ headers: new Headers({ cookie: cookie! }) });
  expect(session?.user.email).toBe(source.email);
  expect((await f.call("/sign-out", {}, cookie)).status).toBe(200);
  expect(f.localData.session).toHaveLength(0);
  expect(f.seen.every((r) => !r.url.includes("token") && !r.url.includes("?"))).toBe(true);
});

it("passes on the issuer refusing an address it has not approved, OTP errors, and nothing else", async () => {
  const f = servers();
  const refuse = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", async () => Response.json(body, { status }));
  refuse(403, { code: "EMAIL_NOT_INVITED", message: "This email is not invited yet" });
  const refused = await f.call("/email-otp/send-verification-otp", { email: source.email });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "EMAIL_NOT_INVITED" });
  for (const [status, code, message] of [
    [400, "INVALID_OTP", "Invalid OTP"],
    [400, "OTP_EXPIRED", "Request a new code"],
    [403, "TOO_MANY_ATTEMPTS", "Too many attempts"],
    [429, "TOO_MANY_REQUESTS", "Too many attempts. Try again later."],
  ] as const) {
    refuse(status, { code, message });
    const forwarded = await f.call("/sign-in/email-otp", {
      email: source.email,
      otp: "123456",
    });
    expect(forwarded.status).toBe(status);
    expect(await forwarded.json()).toMatchObject({ code, message });
  }
  refuse(429, { error: "rate limited" });
  const bareRateLimit = await f.call("/email-otp/send-verification-otp", { email: source.email });
  expect(bareRateLimit.status).toBe(429);
  expect(await bareRateLimit.json()).toMatchObject({ code: "TOO_MANY_REQUESTS" });
  refuse(403, { code: "SOMETHING_ELSE" });
  const other = await f.call("/email-otp/send-verification-otp", { email: source.email });
  expect(other.status).toBe(401);
  expect(await other.json()).not.toMatchObject({ code: "EMAIL_NOT_INVITED" });
});

it("enrolls only the device public key and then closes the central session", async () => {
  const device = createRemoteDeviceKey();
  const f = servers(device.privateKey);
  expect((await f.call("/email-otp/send-verification-otp", { email: source.email })).status).toBe(
    200,
  );
  expect((await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() })).status).toBe(
    200,
  );
  expect(f.centralData.session).toHaveLength(0);
  expect(f.enrolled).toEqual([
    { accountId: f.centralData.user[0]?.id, deviceId: local.deviceId, publicKey: device.publicKey },
  ]);
  expect(JSON.stringify(f.enrolled)).not.toContain(device.privateKey);
});

it("admits the enrolled owner to the host and does not create a second local account", async () => {
  const f = servers();
  expect((await f.call("/email-otp/send-verification-otp", { email: source.email })).status).toBe(
    200,
  );
  expect((await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() })).status).toBe(
    200,
  );
  const subject = String(f.centralData.user[0]?.id);
  const ticket = await issueRemoteEnterTicket(issuer, { subject, device: local.deviceId });
  const opened = await f.call("/remote-enter", { ticket });
  expect(opened.status).toBe(200);
  expect(f.localData.account).toHaveLength(1);
  expect(f.localData.session).toHaveLength(2);
  expect((await f.call("/remote-enter", { ticket })).status).not.toBe(200);
  const stranger = await issueRemoteEnterTicket(issuer, {
    subject: "missing-person",
    device: local.deviceId,
  });
  expect((await f.call("/remote-enter", { ticket: stranger })).status).not.toBe(200);
  expect(f.localData.account).toHaveLength(1);
});

it("admits a guest only when the host hook creates that guest", async () => {
  const f = servers(undefined, async (input) => {
    if (!input.inviteToken || !input.email) return null;
    return input.createUser(input.email);
  });
  expect((await f.call("/email-otp/send-verification-otp", { email: source.email })).status).toBe(
    200,
  );
  expect((await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() })).status).toBe(
    200,
  );
  const owner = String(f.centralData.user[0]?.id);
  const denied = await issueRemoteEnterTicket(issuer, {
    subject: "guest-subject",
    device: local.deviceId,
    email: "guest@example.test",
  });
  expect((await f.call("/remote-enter", { ticket: denied })).status).not.toBe(200);
  expect(f.localData.account).toHaveLength(1);
  const invited = await issueRemoteEnterTicket(issuer, {
    subject: "guest-subject",
    device: local.deviceId,
    email: "guest@example.test",
  });
  const opened = await f.call("/remote-enter", { ticket: invited, invite: "invite-token" });
  expect(opened.status).toBe(200);
  expect(f.localData.account).toHaveLength(2);
  expect(f.localData.user.map((user) => user.email)).toContain("guest@example.test");
  expect(f.localData.user.map((user) => user.id)).not.toContain(owner);
});

it("refuses to merge an existing local account by email", async () => {
  const f = servers();
  f.localData.user.push({
    ...source,
    id: "existing-local",
    name: "Existing",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await f.call("/email-otp/send-verification-otp", { email: source.email });
  expect((await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() })).status).toBe(
    401,
  );
  expect(f.localData.account).toHaveLength(0);
  expect(f.localData.session).toHaveLength(0);
});

it("lets a verified sign-in claim the matching account an upgrade carried over from 0.3.9", async () => {
  const f = servers(undefined, undefined, true);
  f.localData.user.push({
    ...source,
    id: "legacy-local",
    name: "Legacy",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await f.call("/email-otp/send-verification-otp", { email: source.email });
  const response = await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() });
  expect(response.status).toBe(200);
  expect(((await response.json()) as { user: { id: string } }).user.id).toBe("legacy-local");
  expect(f.localData.account).toEqual([
    expect.objectContaining({ userId: "legacy-local", providerId: "verified-identity" }),
  ]);
  expect(f.localData.user).toHaveLength(1);
});

it("never lets an upgrade claim an account that already has a verified identity", async () => {
  const f = servers(undefined, undefined, true);
  f.localData.user.push({
    ...source,
    id: "bound-local",
    name: "Bound",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  f.localData.account.push({
    id: "identity:other",
    userId: "bound-local",
    providerId: "verified-identity",
    accountId: "another-issuer-subject",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await f.call("/email-otp/send-verification-otp", { email: source.email });
  expect((await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() })).status).toBe(
    401,
  );
  expect(f.localData.session).toHaveLength(0);
});

async function existingLocalSession(
  f: ReturnType<typeof servers>,
  email = source.email,
  emailVerified = true,
) {
  const ctx = await f.receiver.$context;
  const user = await ctx.internalAdapter.createUser(
    { name: "Existing", email, emailVerified },
    { method: "email-otp" },
  );
  const session = await ctx.internalAdapter.createSession(user.id);
  const signature = createHmac("sha256", ctx.secret).update(session.token).digest("base64");
  return {
    user,
    session,
    cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
  };
}

it("binds a verified identity to the same authenticated local user without replacing their ID", async () => {
  const f = servers();
  const legacy = await existingLocalSession(f);
  expect(
    (await f.receiver.api.getSession({ headers: new Headers({ cookie: legacy.cookie }) }))?.user.id,
  ).toBe(legacy.user.id);
  await f.call("/email-otp/send-verification-otp", { email: source.email });
  const response = await f.call(
    "/sign-in/email-otp",
    { email: source.email, otp: f.code() },
    legacy.cookie,
  );
  expect(response.status).toBe(200);
  expect(f.localData.user).toHaveLength(1);
  expect(f.localData.account).toHaveLength(1);
  expect(f.localData.account[0]).toMatchObject({
    userId: legacy.user.id,
    providerId: "verified-identity",
  });
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const session = await f.receiver.api.getSession({ headers: new Headers({ cookie }) });
  expect(session?.user.id).toBe(legacy.user.id);
  await f.call("/sign-out", {}, cookie);
  await f.call("/email-otp/send-verification-otp", { email: source.email });
  expect((await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() })).status).toBe(
    200,
  );
  expect(f.localData.user).toHaveLength(1);
  expect(f.localData.account[0]!.userId).toBe(legacy.user.id);
});

it.each(["expired", "wrong-user", "unverified", "invalid-signature", "already-bound"])(
  "refuses local identity linking with a %s session",
  async (failure) => {
    const f = servers();
    const legacy = await existingLocalSession(
      f,
      failure === "wrong-user" ? "other@example.test" : source.email,
      failure !== "unverified",
    );
    if (failure === "wrong-user")
      await (await f.receiver.$context).internalAdapter.createUser(
        {
          name: "Target",
          email: source.email,
          emailVerified: true,
        },
        { method: "email-otp" },
      );
    if (failure === "expired") f.localData.session[0]!.expiresAt = new Date(Date.now() - 1000);
    if (failure === "already-bound")
      await (await f.receiver.$context).internalAdapter.linkAccount({
        id: "previous-binding",
        userId: legacy.user.id,
        providerId: "verified-identity",
        accountId: "other-subject",
      });
    await f.call("/email-otp/send-verification-otp", { email: source.email });
    const before = f.localData.account.length;
    expect(
      (
        await f.call(
          "/sign-in/email-otp",
          { email: source.email, otp: f.code() },
          failure === "invalid-signature" ? `${legacy.cookie}invalid` : legacy.cookie,
        )
      ).status,
    ).toBe(401);
    expect(f.localData.account).toHaveLength(before);
    expect(f.localData.verification).toHaveLength(0);
  },
);

it("requires a fresh issuer proof even with a valid local session", async () => {
  const f = servers();
  const legacy = await existingLocalSession(f);
  await f.call("/email-otp/send-verification-otp", { email: source.email });
  const response = await f.call(
    "/sign-in/email-otp",
    { email: source.email, otp: "invalid-code" },
    legacy.cookie,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "INVALID_OTP" });
  expect(f.localData.account).toHaveLength(0);
});

it("keeps the old user and session usable if persisting their identity binding fails", async () => {
  const f = servers();
  const legacy = await existingLocalSession(f);
  f.failAccount(true);
  await f.call("/email-otp/send-verification-otp", { email: source.email });
  expect(
    (await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() }, legacy.cookie))
      .status,
  ).toBe(401);
  expect(f.localData.account).toHaveLength(0);
  expect(f.localData.user).toHaveLength(1);
  expect(
    (await f.receiver.api.getSession({ headers: new Headers({ cookie: legacy.cookie }) }))?.user.id,
  ).toBe(legacy.user.id);
});

it("consumes persisted challenges once across receiver instances", async () => {
  const { createHash } = await import("node:crypto");
  const { consumeIdentityProof } = await import("./identity-exchange.js");
  const f = servers();
  const context = await f.receiver.$context;
  const nonce = "durable-challenge";
  await context.internalAdapter.createVerificationValue({
    identifier: `identity-exchange:${createHash("sha256").update(nonce).digest("hex")}`,
    value: local.deviceId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const proof = await issueIdentityProof(issuer, source, { device: local.deviceId, nonce });
  expect(await consumeIdentityProof(local, proof, nonce, context.internalAdapter)).toMatchObject({
    subject: source.id,
  });
  const second = betterAuth({
    secret: "offline-test-secret-with-at-least-32-characters",
    database: memoryAdapter(f.localData),
  });
  await expect(
    consumeIdentityProof(local, proof, nonce, (await second.$context).internalAdapter),
  ).rejects.toThrow();
});

it("does not issue a proof from an unverified authenticated session", async () => {
  const { createHmac } = await import("node:crypto");
  const f = servers();
  const ctx = await f.central.$context;
  const user = await ctx.internalAdapter.createUser(
    { name: "Test", email: source.email, emailVerified: false },
    { method: "email-otp" },
  );
  const session = await ctx.internalAdapter.createSession(user.id);
  const token = `${session.token}.${createHmac("sha256", ctx.secret).update(session.token).digest("base64url")}`;
  const response = await f.central.handler(
    new Request(`${local.centralAuthUrl}/identity/issue`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        origin: local.centralOrigin,
      },
      body: JSON.stringify({ device: local.deviceId, nonce: "nonce" }),
    }),
  );
  expect(response.status).toBe(401);
});

it("expires a local session through the official session reader", async () => {
  const f = servers();
  await f.call("/email-otp/send-verification-otp", { email: source.email });
  const response = await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const row = f.localData.session[0]!;
  row.expiresAt = new Date(Date.now() - 1000);
  expect(await f.receiver.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
});

it("accepts a public issuer pin and rejects a private key or chosen device", async () => {
  const { parseNativeIssuerPin } = await import("./identity-exchange-config.js");
  const publicPin = {
    issuer: local.issuer,
    audience: local.audience,
    publicKey: local.publicKey,
    centralAuthUrl: local.centralAuthUrl,
    centralOrigin: local.centralOrigin,
  };
  expect(parseNativeIssuerPin(undefined)).toBeUndefined();
  expect(parseNativeIssuerPin(JSON.stringify(publicPin))).toEqual(publicPin);
  expect(() => parseNativeIssuerPin(JSON.stringify({ ...publicPin, deviceId: "chosen" }))).toThrow(
    "Invalid identity exchange configuration",
  );
  expect(() =>
    parseNativeIssuerPin(JSON.stringify({ ...publicPin, privateKey: "secret" })),
  ).toThrow("Invalid identity exchange configuration");
  expect(() => parseNativeIssuerPin("{")).toThrow("Invalid identity exchange configuration");
});

it("loads optional composition and rejects an unpinned service", async () => {
  const { parseIdentityExchangeConfig } = await import("./identity-exchange.js");
  expect(parseIdentityExchangeConfig(undefined)).toBeUndefined();
  expect(parseIdentityExchangeConfig(JSON.stringify(local))).toEqual(local);
  expect(parseIdentityExchangeConfig(JSON.stringify(issuer))).toEqual(issuer);
  expect(() =>
    parseIdentityExchangeConfig(
      JSON.stringify({ ...local, centralAuthUrl: "https://other.example.test/api/auth" }),
    ),
  ).toThrow();
  expect(() => parseIdentityExchangeConfig("invalid configuration")).toThrow(
    "Invalid identity exchange configuration",
  );
});

it("rejects a valid signature from another key and an excessive proof lifetime", async () => {
  const { SignJWT, importPKCS8 } = await import("jose");
  const proof = await issueIdentityProof(issuer, source, {
    device: local.deviceId,
    nonce: "nonce",
  });
  const other = generateKeyPairSync("ed25519");
  await expect(
    verifyIdentityProof(
      { ...local, publicKey: other.publicKey.export({ type: "spki", format: "pem" }).toString() },
      proof,
      "nonce",
    ),
  ).rejects.toThrow();
  const long = await new SignJWT({ email: source.email, device: local.deviceId, nonce: "nonce" })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(issuer.issuer)
    .setAudience(issuer.audience)
    .setSubject(source.id)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(await importPKCS8(issuer.privateKey, "EdDSA"));
  await expect(verifyIdentityProof(local, long, "nonce")).rejects.toThrow();
});

it("rolls back a failed identity binding and safely retries account provisioning", async () => {
  const f = servers();
  await f.call("/email-otp/send-verification-otp", { email: source.email });
  f.failAccount(true);
  expect((await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() })).status).toBe(
    401,
  );
  expect(f.localData.user).toHaveLength(0);
  expect(f.localData.account).toHaveLength(0);
  expect(f.localData.session).toHaveLength(0);
  expect(f.centralData.session).toHaveLength(0);
  f.failAccount(false);
  await f.call("/email-otp/send-verification-otp", { email: source.email });
  expect((await f.call("/sign-in/email-otp", { email: source.email, otp: f.code() })).status).toBe(
    200,
  );
  expect(f.localData.user).toHaveLength(1);
  expect(f.localData.account).toHaveLength(1);
  expect(f.localData.session).toHaveLength(1);
});

it.each(["vi", "en", "fr"])(
  "carries only supported sign-in locale %s to the issuer",
  async (locale) => {
    const f = servers();
    const response = await f.receiver.handler(
      new Request("https://local.example.test/api/auth/email-otp/send-verification-otp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://local.example.test",
          "x-rakazo-locale": locale,
        },
        body: JSON.stringify({ email: source.email, type: "sign-in" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(
      f.seen.find((request) => request.url.endsWith("/email-otp/send-verification-otp"))?.locale,
    ).toBe(locale === "fr" ? null : locale);
  },
);
