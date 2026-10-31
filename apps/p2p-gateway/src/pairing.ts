import type { SigningKey } from "./crypto.js";
import { decodeUtf8Base64Url, sha256Hex, sign, toBase64Url, utf8, verify } from "./crypto.js";

/*
 * Message formats shared with the node agent (packages/p2p-prototype/src/pairing.ts). The
 * interop tests sign with the prototype and verify here, so a drift fails a test.
 */

export interface AssertionPayload {
  nodeId: string;
  user: string;
  peerId: string;
  /** Expiry as epoch milliseconds. */
  exp: number;
}
export interface NodeProof {
  nodeId: string;
  ts: number;
  sig: string;
}
/** `agent` signs the /agent hello. `signal` signs the Authorization header on /signal. */
export type NodeProofScope = "agent" | "signal";

export const PAIR_CODE_TTL_MS = 120_000;
export const ASSERTION_TTL_MS = 60_000;
/** How far a node proof's timestamp may be from the gateway clock. */
export const PROOF_SKEW_MS = 30_000;
export const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const ASSERTION_DOMAIN = "assertion";

export const pairingMessage = (code: string, nodeId: string): string => `pair|${code}|${nodeId}`;

export const nodeProofMessage = (scope: NodeProofScope, nodeId: string, ts: number): string =>
  `${scope}|${nodeId}|${ts}`;

export function newPairingCode(): string {
  // The alphabet has 32 symbols, so masking a random byte is unbiased.
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
}

/** Only this hash is stored; the code itself is shown once and never kept. */
export const hashPairingCode = (code: string): Promise<string> => sha256Hex(code);

export async function verifyNodeProof(
  publicKey: string,
  scope: NodeProofScope,
  proof: NodeProof,
  nowMs: number,
): Promise<boolean> {
  return (
    Math.abs(nowMs - proof.ts) <= PROOF_SKEW_MS &&
    (await verify(publicKey, nodeProofMessage(scope, proof.nodeId, proof.ts), proof.sig))
  );
}

/** Parses the credential of `Authorization: Node <credential>`. */
export function parseNodeProof(token: string): NodeProof | undefined {
  try {
    const v: unknown = JSON.parse(decodeUtf8Base64Url(token) ?? "");
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

export async function signAssertion(key: SigningKey, payload: AssertionPayload): Promise<string> {
  const body = toBase64Url(utf8(JSON.stringify(payload)));
  return `${body}.${await sign(key, `${ASSERTION_DOMAIN}|${body}`)}`;
}

/** Returns the payload only for an untampered, unexpired assertion signed by `gatewayPublicKey`. */
export async function verifyAssertion(
  gatewayPublicKey: string,
  token: string,
  nowMs: number,
): Promise<AssertionPayload | undefined> {
  const parts = token.split(".");
  const [body, sig] = parts;
  if (parts.length !== 2 || body === undefined || sig === undefined) return undefined;
  if (!(await verify(gatewayPublicKey, `${ASSERTION_DOMAIN}|${body}`, sig))) return undefined;
  try {
    const v: unknown = JSON.parse(decodeUtf8Base64Url(body) ?? "");
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
