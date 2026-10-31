import { createPrivateKey, randomBytes, sign } from "node:crypto";
import type { Hono } from "hono";

/*
 * Short-lived tokens for the P2P gateway (p2p.vnbot.run). The gateway checks them offline
 * against the public half in its APP_TOKEN_PUBLIC_KEYS; it never calls this server.
 * Format and limits mirror apps/p2p-gateway/src/app-token.ts: compact JWS, alg EdDSA,
 * typ vnbot-p2p+jwt, seconds-based iat/nbf/exp, lifetime at most 300 s.
 */

export const P2P_TOKEN_PATH = "/api/auth/p2p-token";
export const P2P_TOKEN_TYP = "vnbot-p2p+jwt";
export const P2P_TOKEN_TTL_S = 120;
export const P2P_SCOPES = ["pair", "session", "nodes", "turn"] as const;
export type P2pScope = (typeof P2P_SCOPES)[number];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface P2pTokenConfig {
  /** base64url raw 32-byte Ed25519 seed. Lives only on the auth server. */
  privateKey: string;
  kid: string;
  issuer: string;
  audience: string;
}

/** Undefined (feature off) unless P2P_TOKEN_PRIVATE_KEY and P2P_TOKEN_KID are both set. */
export function p2pTokenConfigFromEnv(
  source: NodeJS.ProcessEnv,
  webOrigin: string,
): P2pTokenConfig | undefined {
  const privateKey = source.P2P_TOKEN_PRIVATE_KEY?.trim();
  const kid = source.P2P_TOKEN_KID?.trim();
  if (!privateKey && !kid) return undefined;
  if (!privateKey || !kid) throw new Error("P2P_TOKEN_PRIVATE_KEY and P2P_TOKEN_KID go together");
  if (Buffer.from(privateKey, "base64url").length !== 32) {
    throw new Error("P2P_TOKEN_PRIVATE_KEY must be a base64url 32-byte Ed25519 seed");
  }
  return {
    privateKey,
    kid,
    issuer: source.P2P_TOKEN_ISSUER?.trim() || webOrigin,
    audience: source.P2P_TOKEN_AUDIENCE?.trim() || "p2p.vnbot.run",
  };
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export interface P2pUser {
  id: string;
  email: string;
}

export function mintP2pToken(
  config: P2pTokenConfig,
  user: P2pUser,
  scope: readonly P2pScope[],
  nowMs: number,
  nodeId?: string,
): { token: string; expiresAt: number } {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(config.privateKey, "base64url")]),
    format: "der",
    type: "pkcs8",
  });
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + P2P_TOKEN_TTL_S;
  const header = b64(JSON.stringify({ alg: "EdDSA", typ: P2P_TOKEN_TYP, kid: config.kid }));
  const payload = b64(
    JSON.stringify({
      iss: config.issuer,
      aud: config.audience,
      sub: user.id,
      email: user.email,
      jti: randomBytes(16).toString("base64url"),
      iat,
      nbf: iat,
      exp,
      scope,
      ...(nodeId !== undefined ? { nodeId } : {}),
    }),
  );
  const signature = sign(null, Buffer.from(`${header}.${payload}`), key).toString("base64url");
  return { token: `${header}.${payload}.${signature}`, expiresAt: exp * 1000 };
}

export interface P2pTokenRouteOptions {
  config: P2pTokenConfig | undefined;
  sessionUser: (request: Request) => Promise<P2pUser | null>;
  trustedOrigin: (origin: string) => boolean;
  now?: () => number;
}

/**
 * POST /api/auth/p2p-token {scope: [...], nodeId?} -> {token, expiresAt}.
 * Signed-in only; JSON only and, when the browser sends an Origin, a trusted one, so a
 * cross-site form cannot mint a token with the user's cookie. Must be mounted before the
 * catch-all /api/auth/* handler.
 */
export function mountP2pTokenRoute(app: Hono, o: P2pTokenRouteOptions): void {
  app.post(P2P_TOKEN_PATH, async (c) => {
    if (o.config === undefined) return c.json({ error: "P2P is not enabled" }, 404);
    const origin = c.req.header("origin");
    if (origin !== undefined && !o.trustedOrigin(origin))
      return c.json({ error: "forbidden" }, 403);
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      return c.json({ error: "expected application/json" }, 415);
    }
    const user = await o.sessionUser(c.req.raw);
    if (user === null) return c.json({ error: "NO_SESSION" }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const { scope, nodeId } = (typeof body === "object" && body !== null ? body : {}) as {
      scope?: unknown;
      nodeId?: unknown;
    };
    const scopes = Array.isArray(scope) ? scope : [];
    const valid =
      scopes.length > 0 &&
      scopes.length <= P2P_SCOPES.length &&
      scopes.every((s) => (P2P_SCOPES as readonly unknown[]).includes(s)) &&
      new Set(scopes).size === scopes.length &&
      (nodeId === undefined || (typeof nodeId === "string" && ID_PATTERN.test(nodeId)));
    if (!valid) return c.json({ error: "invalid scope or nodeId" }, 400);
    return c.json(
      mintP2pToken(
        o.config,
        user,
        scopes as P2pScope[],
        (o.now ?? Date.now)(),
        nodeId as string | undefined,
      ),
    );
  });
}
