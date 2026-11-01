/** Ed25519 and SHA-256 over WebCrypto. Keys are the raw 32 bytes as base64url (the JWK `x` and `d`). */

const encoder = new TextEncoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Undefined for anything that is not canonical unpadded base64url. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(text));

export function decodeUtf8Base64Url(text: string): string | undefined {
  const bytes = fromBase64Url(text);
  if (bytes === undefined) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function importPublicKey(publicKey: string): Promise<CryptoKey | undefined> {
  if (fromBase64Url(publicKey)?.length !== 32) return undefined;
  try {
    return await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: publicKey },
      "Ed25519",
      false,
      ["verify"],
    );
  } catch {
    return undefined;
  }
}

export async function isPublicKey(publicKey: string): Promise<boolean> {
  return (await importPublicKey(publicKey)) !== undefined;
}

/** False for a malformed key or signature as well as a wrong one. */
export async function verify(
  publicKey: string,
  message: string | Uint8Array<ArrayBuffer>,
  signature: string,
): Promise<boolean> {
  const key = await importPublicKey(publicKey);
  const sig = fromBase64Url(signature);
  if (key === undefined || sig === undefined) return false;
  try {
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      sig,
      typeof message === "string" ? utf8(message) : message,
    );
  } catch {
    return false;
  }
}

export interface SigningKey {
  publicKey: string;
  privateKey: string;
}

/** Signs a canonical string. Callers prefix a domain (`pair|`, `agent|`, ...) so signatures cannot cross protocols. */
export async function sign(key: SigningKey, message: string): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: key.publicKey, d: key.privateKey },
    "Ed25519",
    false,
    ["sign"],
  );
  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, utf8(message))),
  );
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
