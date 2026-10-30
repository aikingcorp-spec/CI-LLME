import { describe, expect, it } from "vitest";
import {
  createPairingCodes,
  generateKeyPair,
  pairingMessage,
  sign,
  signAssertion,
  verify,
  verifyAssertion,
} from "./pairing.js";

describe("pairing primitives", () => {
  it("signs canonical strings with distinct Ed25519 keys", () => {
    const key = generateKeyPair();
    const message = pairingMessage("ABCDEFGH", "node");
    const signature = sign(key, message);
    expect(verify(key.publicKey, message, signature)).toBe(true);
    expect(verify(generateKeyPair().publicKey, message, signature)).toBe(false);
    expect(verify(key.publicKey, `${message}x`, signature)).toBe(false);
    expect(verify("invalid", message, signature)).toBe(false);
  });
  it("issues eight-character single-use codes bound to their issuing user", () => {
    const store = createPairingCodes({ clock: () => 1000 });
    const first = store.issue("first");
    const second = store.issue("second");
    expect(first.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(first.expiresAt).toBe(121_000);
    expect(store.redeem(first.code)).toBe("first");
    expect(store.redeem(first.code)).toBeUndefined();
    expect(store.redeem(second.code)).toBe("second");
    expect(store.redeem("unknown")).toBeUndefined();
  });
  it("respects a custom TTL at the exact expiry boundary", () => {
    let now = 1000;
    const store = createPairingCodes({ clock: () => now, ttlMs: 50 });
    const { code } = store.issue("user");
    now += 50;
    expect(store.redeem(code)).toBeUndefined();
  });
  it("verifies all assertion fields and rejects malformed payloads", () => {
    const key = generateKeyPair();
    const payload = { nodeId: "node", user: "user", peerId: "peer", exp: 2000 };
    const token = signAssertion(key, payload);
    expect(verifyAssertion(key.publicKey, token, 1000)).toEqual(payload);
    expect(verifyAssertion(key.publicKey, token, 2000)).toBeUndefined();
    expect(verifyAssertion(key.publicKey, `${token}.extra`, 1000)).toBeUndefined();
    for (const body of [
      "not json",
      JSON.stringify({ ...payload, peerId: 1 }),
      JSON.stringify({ ...payload, exp: null }),
    ]) {
      const encoded = Buffer.from(body).toString("base64url");
      expect(
        verifyAssertion(key.publicKey, `${encoded}.${sign(key, `assertion|${encoded}`)}`, 1000),
      ).toBeUndefined();
    }
  });
});
