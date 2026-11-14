import { randomBytes } from "node:crypto";
import type { IdentityExchangeConfig } from "./identity-exchange-config.js";

const AGE = 60;
const seen = new Set<string>();

export async function issueRemoteEnterTicket(
  config: Extract<IdentityExchangeConfig, { kind: "issuer" }>,
  binding: { subject: string; device: string; email?: string },
): Promise<string> {
  const nonce = randomBytes(32).toString("base64url");
  const { importPKCS8, SignJWT } = await import("jose");
  return new SignJWT({
    device: binding.device,
    nonce,
    purpose: "remote-enter",
    ...(binding.email ? { email: binding.email } : {}),
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject(binding.subject)
    .setIssuedAt()
    .setExpirationTime(`${AGE}s`)
    .sign(await importPKCS8(config.privateKey, "EdDSA"));
}

export async function verifyRemoteEnterTicket(
  config: Extract<IdentityExchangeConfig, { kind: "local" }>,
  ticket: string,
): Promise<{ subject: string; nonce: string; email?: string }> {
  const { importSPKI, jwtVerify } = await import("jose");
  const { payload } = await jwtVerify(ticket, await importSPKI(config.publicKey, "EdDSA"), {
    algorithms: ["EdDSA"],
    issuer: config.issuer,
    audience: config.audience,
    maxTokenAge: AGE,
    requiredClaims: ["sub", "iat", "exp"],
  });
  if (
    payload.purpose !== "remote-enter" ||
    payload.device !== config.deviceId ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.nonce !== "string" ||
    !payload.nonce
  ) {
    throw new Error("Remote enter rejected");
  }
  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (email !== undefined && (email.length > 320 || !email.includes("@"))) {
    throw new Error("Remote enter rejected");
  }
  return { subject: payload.sub, nonce: payload.nonce, ...(email ? { email } : {}) };
}

/** One process remembers a ticket nonce until restart. A restart still faces the short expiry. */
export function consumeRemoteEnterTicket(nonce: string): boolean {
  if (seen.has(nonce)) return false;
  seen.add(nonce);
  return true;
}
