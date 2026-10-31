import { fromBase64Url, isPublicKey, sign, verify } from "./crypto.js";
import type { SigningKey } from "./crypto.js";
import type { Env } from "./env.js";

export interface Config {
  gatewayKey: SigningKey;
  gatewayKeyId: string;
  /** `kid` to base64url Ed25519 public key. */
  appKeys: Record<string, string>;
  issuer: string;
  audience: string;
  allowedOrigins: string[];
}

function parseKeys(json: string): Record<string, string> | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
    const entries = Object.entries(v);
    return entries.every(([, key]) => typeof key === "string")
      ? Object.fromEntries(entries as Array<[string, string]>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Undefined when the deployment is misconfigured, for example a public key that does not match the secret. */
export async function loadConfig(env: Env): Promise<Config | undefined> {
  const gatewayKey = { publicKey: env.GATEWAY_PUBLIC_KEY, privateKey: env.GATEWAY_PRIVATE_KEY };
  const appKeys = parseKeys(env.APP_TOKEN_PUBLIC_KEYS);
  if (
    appKeys === undefined ||
    !env.GATEWAY_KEY_ID ||
    !(await isPublicKey(gatewayKey.publicKey)) ||
    fromBase64Url(gatewayKey.privateKey ?? "")?.length !== 32
  ) {
    return undefined;
  }
  try {
    const probe = await sign(gatewayKey, "self-test");
    if (!(await verify(gatewayKey.publicKey, "self-test", probe))) return undefined;
  } catch {
    return undefined;
  }
  return {
    gatewayKey,
    gatewayKeyId: env.GATEWAY_KEY_ID,
    appKeys,
    issuer: env.APP_TOKEN_ISSUER,
    audience: env.APP_TOKEN_AUDIENCE,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
