import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  generateKeyPairSync,
  randomInt,
} from "node:crypto";

/** Ed25519 key pair; both halves are the raw 32 bytes as base64url (the JWK `x` and `d`). */
export interface KeyPair {
  publicKey: string;
  privateKey: string;
}
export interface AssertionPayload {
  nodeId: string;
  user: string;
  peerId: string;
  /** Expiry as epoch milliseconds. */
  exp: number;
}
export interface PairingCodes {
  issue(user: string): { code: string; expiresAt: number };
  /** Consumes the code. Returns the user that issued it, or undefined for unknown, expired or used. */
  redeem(code: string): string | undefined;
}
export interface PairingCodeOptions {
  ttlMs?: number;
  clock?: () => number;
}
export interface NodeProof {
  nodeId: string;
  ts: number;
  sig: string;
}
/** `agent` signs the /agent hello. `signal` signs the Authorization header on /signal and /turn-credentials. */
export type NodeProofScope = "agent" | "signal";

export const DEFAULT_PAIRING_TTL_MS = 120_000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const ASSERTION_DOMAIN = "assertion";
const NODE_SCHEME = "Node";

const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");

function privateKeyObject(keyPair: KeyPair) {
  return createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", x: keyPair.publicKey, d: keyPair.privateKey },
    format: "jwk",
  });
}

function publicKeyObject(publicKey: string) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
}

export function generateKeyPair(): KeyPair {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  if (jwk.x === undefined || jwk.d === undefined) throw new Error("ed25519 export failed");
  return { publicKey: jwk.x, privateKey: jwk.d };
}

export function isPublicKey(publicKey: string): boolean {
  try {
    publicKeyObject(publicKey);
    return Buffer.from(publicKey, "base64url").length === 32;
  } catch {
    return false;
  }
}

/** Signs a canonical string. Callers prefix a domain (`pair|`, `agent|`, ...) so signatures cannot cross protocols. */
export function sign(keyPair: KeyPair, message: string): string {
  return b64url(edSign(null, Buffer.from(message), privateKeyObject(keyPair)));
}

export function verify(publicKey: string, message: string, signature: string): boolean {
  try {
    return edVerify(
      null,
      Buffer.from(message),
      publicKeyObject(publicKey),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export const pairingMessage = (code: string, nodeId: string): string => `pair|${code}|${nodeId}`;

export const nodeProofMessage = (scope: NodeProofScope, nodeId: string, ts: number): string =>
  `${scope}|${nodeId}|${ts}`;

export function signNodeProof(
  keyPair: KeyPair,
  scope: NodeProofScope,
  nodeId: string,
  nowMs = Date.now(),
): NodeProof {
  return { nodeId, ts: nowMs, sig: sign(keyPair, nodeProofMessage(scope, nodeId, nowMs)) };
}

/** `Authorization: Node <token>` for /signal and /turn-credentials, signed by the node's own key. */
export function nodeAuthorization(keyPair: KeyPair, nodeId: string, nowMs = Date.now()): string {
  const proof = signNodeProof(keyPair, "signal", nodeId, nowMs);
  return `${NODE_SCHEME} ${b64url(JSON.stringify(proof))}`;
}

export function parseNodeProof(token: string): NodeProof | undefined {
  try {
    const v: unknown = JSON.parse(Buffer.from(token, "base64url").toString());
    if (typeof v !== "object" || v === null) return undefined;
    const { nodeId, ts, sig } = v as Record<string, unknown>;
    if (
      typeof nodeId !== "string" ||
      typeof ts !== "number" ||
      !Number.isFinite(ts) ||
      typeof sig !== "string"
    ) {
      return undefined;
    }
    return { nodeId, ts, sig };
  } catch {
    return undefined;
  }
}

export function signAssertion(gatewayKey: KeyPair, payload: AssertionPayload): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(gatewayKey, `${ASSERTION_DOMAIN}|${body}`)}`;
}

/** Returns the payload only for an untampered, unexpired assertion signed by `gatewayPublicKey`. */
export function verifyAssertion(
  gatewayPublicKey: string,
  token: string,
  nowMs = Date.now(),
): AssertionPayload | undefined {
  const parts = token.split(".");
  const [body, sig] = parts;
  if (parts.length !== 2 || body === undefined || sig === undefined) return undefined;
  if (!verify(gatewayPublicKey, `${ASSERTION_DOMAIN}|${body}`, sig)) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof v !== "object" || v === null) return undefined;
    const { nodeId, user, peerId, exp } = v as Record<string, unknown>;
    if (
      typeof nodeId !== "string" ||
      typeof user !== "string" ||
      typeof peerId !== "string" ||
      typeof exp !== "number" ||
      !Number.isFinite(exp) ||
      exp <= nowMs
    ) {
      return undefined;
    }
    return { nodeId, user, peerId, exp };
  } catch {
    return undefined;
  }
}

const hashCode = (code: string): string => createHash("sha256").update(code).digest("hex");

export function createPairingCodes(o: PairingCodeOptions = {}): PairingCodes {
  const ttlMs = o.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
  const clock = o.clock ?? Date.now;
  const entries = new Map<string, { user: string; expiresAt: number }>();

  const purge = (): void => {
    const now = clock();
    for (const [hash, entry] of entries) if (entry.expiresAt <= now) entries.delete(hash);
  };

  return {
    issue(user) {
      purge();
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const expiresAt = clock() + ttlMs;
      entries.set(hashCode(code), { user, expiresAt });
      return { code, expiresAt };
    },
    redeem(code) {
      const hash = hashCode(code);
      const entry = entries.get(hash);
      entries.delete(hash);
      return entry !== undefined && entry.expiresAt > clock() ? entry.user : undefined;
    },
  };
}
