import { decodeUtf8Base64Url, utf8, verify } from "./crypto.js";

/*
 * The short-lived token the app signs for a signed-in user (plan 4a): a compact JWS with
 * `alg: EdDSA`, checked here against the app's public keys. The gateway never calls the app.
 */

export type TokenScope = "pair" | "session" | "nodes" | "turn";

export interface AppTokenClaims {
  /** The user id. */
  sub: string;
  email: string;
  jti: string;
  /** Expiry as epoch milliseconds. */
  expMs: number;
  scope: string[];
  nodeId?: string;
}
export interface AppTokenOptions {
  /** `kid` to base64url Ed25519 public key. */
  keys: Readonly<Record<string, string>>;
  issuer: string;
  audience: string;
  nowMs: number;
}

export const TOKEN_TYP = "vnbot-p2p+jwt";
export const MAX_TOKEN_LENGTH = 2048;
export const MAX_TOKEN_LIFETIME_S = 300;
const CLOCK_SKEW_S = 30;

type Fields = Record<string, unknown>;

function parseObject(segment: string): Fields | undefined {
  try {
    const v: unknown = JSON.parse(decodeUtf8Base64Url(segment) ?? "");
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Fields) : undefined;
  } catch {
    return undefined;
  }
}

const seconds = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;

/** Returns the claims only for a token that is untampered, in its validity window, and meant for this gateway. */
export async function verifyAppToken(
  token: string,
  o: AppTokenOptions,
): Promise<AppTokenClaims | undefined> {
  if (token.length > MAX_TOKEN_LENGTH) return undefined;
  const parts = token.split(".");
  const [encodedHeader, encodedPayload, signature] = parts;
  if (parts.length !== 3 || !encodedHeader || !encodedPayload || !signature) return undefined;

  const header = parseObject(encodedHeader);
  if (header?.alg !== "EdDSA" || header.typ !== TOKEN_TYP) return undefined;
  const kid = header.kid;
  if (typeof kid !== "string" || !Object.hasOwn(o.keys, kid)) return undefined;
  const publicKey = o.keys[kid];
  if (publicKey === undefined) return undefined;
  if (!(await verify(publicKey, utf8(`${encodedHeader}.${encodedPayload}`), signature))) {
    return undefined;
  }

  const p = parseObject(encodedPayload);
  if (p === undefined) return undefined;
  const { iss, aud, sub, email, jti, iat, nbf, exp, scope, nodeId } = p;
  if (iss !== o.issuer || aud !== o.audience) return undefined;
  if (!text(sub) || !text(email) || !text(jti)) return undefined;
  if (!seconds(iat) || !seconds(nbf) || !seconds(exp)) return undefined;
  if (!Array.isArray(scope) || !scope.every((s) => typeof s === "string")) return undefined;
  if (nodeId !== undefined && !text(nodeId)) return undefined;

  const now = o.nowMs / 1000;
  if (now < nbf - CLOCK_SKEW_S || now >= exp) return undefined;
  if (exp <= iat || exp - iat > MAX_TOKEN_LIFETIME_S) return undefined;
  return { sub, email, jti, expMs: exp * 1000, scope, ...(nodeId !== undefined ? { nodeId } : {}) };
}
