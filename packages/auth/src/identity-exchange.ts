import { createHash, randomBytes } from "node:crypto";
import { EMAIL_NOT_INVITED } from "@rakazo/contracts";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { sessionForAuthHook } from "./account-security.js";
import { notInvited } from "./email-allowlist.js";
import type { IdentityExchangeConfig } from "./identity-exchange-config.js";
import { remoteDevicePublicKey } from "./remote-device-key.js";
import { consumeRemoteEnterTicket, verifyRemoteEnterTicket } from "./remote-enter-ticket.js";

export type { IdentityExchangeConfig } from "./identity-exchange-config.js";
export { parseIdentityExchangeConfig } from "./identity-exchange-config.js";

const AGE = 60;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const denied = () => new APIError("UNAUTHORIZED", { message: "Identity exchange rejected" });
const FORWARDED_OTP_CODES = new Set([
  "INVALID_OTP",
  "OTP_EXPIRED",
  "TOO_MANY_ATTEMPTS",
  "TOO_MANY_REQUESTS",
]);

function stringField(body: unknown, key: string): string {
  const value = optionalField(body, key);
  if (!value) throw denied();
  return value;
}

function optionalField(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object" || !(key in body)) return undefined;
  const value: unknown = Reflect.get(body, key);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > 4096) throw denied();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function issueIdentityProof(
  config: Extract<IdentityExchangeConfig, { kind: "issuer" }>,
  source: { id: string; email: string; emailVerified: boolean },
  binding: { device: string; nonce: string },
) {
  if (!source.emailVerified) throw denied();
  const { importPKCS8, SignJWT } = await import("jose");
  return new SignJWT({ email: source.email, device: binding.device, nonce: binding.nonce })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject(source.id)
    .setIssuedAt()
    .setExpirationTime(`${AGE}s`)
    .sign(await importPKCS8(config.privateKey, "EdDSA"));
}

export async function verifyIdentityProof(
  config: Extract<IdentityExchangeConfig, { kind: "local" }>,
  proof: string,
  nonce: string,
) {
  const { importSPKI, jwtVerify } = await import("jose");
  const { payload } = await jwtVerify(proof, await importSPKI(config.publicKey, "EdDSA"), {
    algorithms: ["EdDSA"],
    issuer: config.issuer,
    audience: config.audience,
    maxTokenAge: AGE,
    requiredClaims: ["sub", "iat", "exp"],
  });
  if (
    payload.device !== config.deviceId ||
    payload.nonce !== nonce ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !payload.email ||
    typeof payload.exp !== "number" ||
    typeof payload.iat !== "number" ||
    payload.exp - payload.iat > AGE
  )
    throw denied();
  return { subject: payload.sub, email: payload.email, expiresAt: payload.exp * 1000 };
}

export async function consumeIdentityProof(
  config: Extract<IdentityExchangeConfig, { kind: "local" }>,
  proof: string,
  nonce: string,
  adapter: { consumeVerificationValue(identifier: string): Promise<{ value: string } | null> },
) {
  const identity = await verifyIdentityProof(config, proof, nonce);
  const challenge = await adapter.consumeVerificationValue(`identity-exchange:${hash(nonce)}`);
  if (!challenge || challenge.value !== config.deviceId) throw denied();
  return identity;
}

export interface RemoteDeviceEnrollment {
  enrollRemoteDevice?: (input: {
    accountId: string;
    deviceId: string;
    publicKey: string;
  }) => Promise<{ kind: "enrolled" | "conflict" | "revoked" }>;
  /**
   * Host decides who may have a session. Absent keeps the enrolled owner lookup.
   * The result is that subject's own user. It must not be the machine owner for
   * a different subject.
   */
  resolveRemoteEnter?: (input: {
    accountId: string;
    subject?: string;
    email?: string;
    inviteToken?: string;
    createUser: (email: string) => Promise<string | null>;
  }) => Promise<string | null>;
  /**
   * The host carried this account over from an earlier release that had no identity binding,
   * so the issuer's proof of the same email may claim it once.
   */
  legacyAccountsClaimable?: boolean;
}

/** The local OTP caller keeps central credentials server-side and returns only a local session. */
export function identityExchange(
  config: IdentityExchangeConfig,
  hooks?: RemoteDeviceEnrollment,
): BetterAuthPlugin {
  if (config.kind === "issuer")
    return {
      id: "identity-exchange",
      endpoints: {
        issueIdentity: createAuthEndpoint("/identity/issue", { method: "POST" }, async (ctx) => {
          const source = await sessionForAuthHook(ctx);
          if (!source) throw denied();
          const proof = await issueIdentityProof(config, source.user, {
            device: stringField(ctx.body, "device"),
            nonce: stringField(ctx.body, "nonce"),
          });
          ctx.setHeader("cache-control", "no-store");
          return ctx.json({ proof });
        }),
        enrollRemoteDevice: createAuthEndpoint(
          "/remote-device",
          { method: "POST" },
          async (ctx) => {
            const source = await sessionForAuthHook(ctx);
            if (!source) throw denied();
            const enrolled = await hooks?.enrollRemoteDevice?.({
              accountId: source.user.id,
              deviceId: stringField(ctx.body, "device"),
              publicKey: stringField(ctx.body, "publicKey"),
            });
            if (enrolled && enrolled.kind !== "enrolled") throw denied();
            ctx.setHeader("cache-control", "no-store");
            return ctx.json({ ok: true });
          },
        ),
      },
    };
  const local = config;
  const central = new URL(local.centralAuthUrl);
  if (
    central.protocol !== "https:" ||
    central.username ||
    central.password ||
    central.search ||
    central.hash
  )
    throw new Error("Identity service requires an HTTPS auth URL");
  async function request(
    path: string,
    body: unknown,
    token?: string,
    extraHeaders: Record<string, string> = {},
  ) {
    const response = await fetch(`${local.centralAuthUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        origin: local.centralOrigin,
        ...extraHeaders,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // The central list refusing the address and actionable OTP errors are safe to surface.
      const payload: unknown = await response.json().catch(() => null);
      const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : undefined;
      if (response.status === 403 && code === EMAIL_NOT_INVITED) throw notInvited();
      if ((code && FORWARDED_OTP_CODES.has(code)) || response.status === 429) {
        const status = response.status >= 400 && response.status <= 599 ? response.status : 400;
        const message =
          isRecord(payload) && typeof payload.message === "string" && payload.message
            ? payload.message
            : response.status === 429
              ? "Too many attempts. Try again later."
              : "Invalid code";
        throw new APIError(status as never, {
          code: code && FORWARDED_OTP_CODES.has(code) ? code : "TOO_MANY_REQUESTS",
          message,
        });
      }
      throw denied();
    }
    return response;
  }
  return {
    id: "identity-exchange",
    endpoints: {
      identitySendCode: createAuthEndpoint(
        "/email-otp/send-verification-otp",
        { method: "POST" },
        async (ctx) => {
          const email = stringField(ctx.body, "email");
          const locale = ctx.headers?.get("x-rakazo-locale");
          const response = await request(
            "/email-otp/send-verification-otp",
            { email, type: "sign-in" },
            undefined,
            locale === "vi" || locale === "en" ? { "x-rakazo-locale": locale } : {},
          );
          await response.body?.cancel();
          return ctx.json({ success: true });
        },
      ),
      identitySignIn: createAuthEndpoint("/sign-in/email-otp", { method: "POST" }, async (ctx) => {
        const response = await request("/sign-in/email-otp", {
          email: stringField(ctx.body, "email"),
          otp: stringField(ctx.body, "otp"),
        });
        // signedBearer emits the authenticated session as a signed response header.
        const token = response.headers.get("set-auth-token");
        await response.body?.cancel();
        if (!token) throw denied();
        const nonce = randomBytes(32).toString("base64url");
        const identifier = `identity-exchange:${hash(nonce)}`;
        try {
          await ctx.context.internalAdapter.createVerificationValue({
            identifier,
            value: config.deviceId,
            expiresAt: new Date(Date.now() + AGE * 1000),
          });
          const issued: unknown = await (
            await request("/identity/issue", { device: config.deviceId, nonce }, token)
          ).json();
          const identity = await consumeIdentityProof(
            config,
            stringField(issued, "proof"),
            nonce,
            ctx.context.internalAdapter,
          );
          if (config.devicePrivateKey) {
            await request(
              "/remote-device",
              {
                device: config.deviceId,
                publicKey: remoteDevicePublicKey(config.devicePrivateKey),
              },
              token,
            );
          }
          const accountId = hash(JSON.stringify([config.issuer, identity.subject]));
          const account = await ctx.context.internalAdapter.findAccountByKey({
            providerId: "verified-identity",
            accountId,
          });
          let user = account
            ? await ctx.context.internalAdapter.findUserById(account.userId)
            : null;
          if (!account) {
            const existing = await ctx.context.internalAdapter.findUserByEmail(identity.email, {
              includeAccounts: true,
            });
            const binding = {
              id: `identity:${accountId}`,
              providerId: "verified-identity",
              accountId,
              scope: identity.subject,
            };
            if (existing) {
              // A copied session proves local ownership. Otherwise only an account carried over
              // from 0.3.9, which predates identity binding, may be claimed by the proof alone.
              const current = await sessionForAuthHook(ctx);
              const owned =
                (current?.user.id === existing.user.id && existing.user.emailVerified) ||
                hooks?.legacyAccountsClaimable === true;
              if (
                !owned ||
                ("deactivatedAt" in existing.user && existing.user.deactivatedAt) ||
                existing.accounts.some((linked) => linked.providerId === "verified-identity")
              )
                throw denied();
              const linked = await ctx.context.internalAdapter.linkAccount({
                ...binding,
                userId: existing.user.id,
              });
              if (!linked) throw denied();
              user = existing.user;
            } else {
              // Both rows commit together. The stable account primary key makes
              // concurrent provisioning first-writer-wins without pinning an extra connection.
              const created = await ctx.context.internalAdapter.createOAuthUser(
                {
                  email: identity.email,
                  emailVerified: true,
                  name: identity.email.split("@")[0] || "User",
                },
                binding,
              );
              user = created.user;
            }
          }
          if (!user || ("deactivatedAt" in user && user.deactivatedAt)) throw denied();
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw denied();
          await setSessionCookie(ctx, { session, user });
          ctx.setHeader("cache-control", "no-store");
          return ctx.json({ user, token: session.token });
        } catch {
          throw denied();
        } finally {
          await ctx.context.internalAdapter
            .deleteVerificationByIdentifier(identifier)
            .catch(() => undefined);
          // The central OTP session exists only to authorize this exchange.
          await request("/sign-out", {}, token)
            .then((r) => r.body?.cancel())
            .catch(() => undefined);
        }
      }),
      remoteEnter: createAuthEndpoint("/remote-enter", { method: "POST" }, async (ctx) => {
        let identity: { subject: string; nonce: string; email?: string };
        try {
          identity = await verifyRemoteEnterTicket(local, stringField(ctx.body, "ticket"));
        } catch {
          throw denied();
        }
        if (!consumeRemoteEnterTicket(identity.nonce)) throw denied();
        const accountId = hash(JSON.stringify([local.issuer, identity.subject]));
        const inviteToken = optionalField(ctx.body, "invite");
        let userId: string | null = null;
        if (hooks?.resolveRemoteEnter) {
          try {
            userId = await hooks.resolveRemoteEnter({
              accountId,
              subject: identity.subject,
              email: identity.email,
              inviteToken,
              createUser: async (email) => {
                if (await ctx.context.internalAdapter.findUserByEmail(email)) return null;
                const created = await ctx.context.internalAdapter.createOAuthUser(
                  {
                    email,
                    emailVerified: true,
                    name: email.split("@")[0] || "User",
                  },
                  {
                    id: `identity:${accountId}`,
                    providerId: "verified-identity",
                    accountId,
                    scope: identity.subject,
                  },
                );
                return created?.user?.id ?? null;
              },
            });
          } catch {
            throw denied();
          }
        } else {
          const account = await ctx.context.internalAdapter.findAccountByKey({
            providerId: "verified-identity",
            accountId,
          });
          userId = account?.userId ?? null;
        }
        const user = userId ? await ctx.context.internalAdapter.findUserById(userId) : null;
        if (!user || ("deactivatedAt" in user && user.deactivatedAt)) throw denied();
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) throw denied();
        await setSessionCookie(ctx, { session, user });
        ctx.setHeader("cache-control", "no-store");
        return ctx.json({ ok: true });
      }),
    },
  };
}
