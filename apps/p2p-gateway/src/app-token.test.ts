import { generateKeyPair } from "@rakazo/p2p-prototype/pairing";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppTokenOptions } from "./app-token.js";
import { MAX_TOKEN_LENGTH, verifyAppToken } from "./app-token.js";
import { signAppToken, T0, TEST_AUDIENCE, TEST_ISSUER } from "./test-util.js";

const appKey = generateKeyPair();
const otherKey = generateKeyPair();
const options = (nowMs = T0): AppTokenOptions => ({
  keys: { "app-test": appKey.publicKey },
  issuer: TEST_ISSUER,
  audience: TEST_AUDIENCE,
  nowMs,
});
const seconds = Math.floor(T0 / 1000);

describe("verifyAppToken", () => {
  let token: string;
  beforeAll(async () => {
    token = await signAppToken(appKey, { nowMs: T0 });
  });

  it("accepts a valid token and returns its claims", async () => {
    const claims = await verifyAppToken(token, options());
    expect(claims).toMatchObject({
      sub: "user-1",
      email: "one@example.test",
      expMs: (seconds + 300) * 1000,
      scope: ["pair", "session", "nodes", "turn"],
    });
    expect(claims?.nodeId).toBeUndefined();
  });

  it("carries the node a token is limited to", async () => {
    const limited = await signAppToken(appKey, { nowMs: T0, claims: { nodeId: "node-1" } });
    expect((await verifyAppToken(limited, options()))?.nodeId).toBe("node-1");
  });

  it("rejects an expired token, including at the exact expiry second", async () => {
    expect(await verifyAppToken(token, options(T0 + 299_999))).toBeDefined();
    expect(await verifyAppToken(token, options(T0 + 300_000))).toBeUndefined();
    expect(await verifyAppToken(token, options(T0 + 3_600_000))).toBeUndefined();
  });

  it("allows 30 seconds of clock skew before nbf and no more", async () => {
    const future = await signAppToken(appKey, { nowMs: T0 + 30_000 });
    expect(await verifyAppToken(future, options())).toBeDefined();
    const tooFar = await signAppToken(appKey, { nowMs: T0 + 31_000 });
    expect(await verifyAppToken(tooFar, options())).toBeUndefined();
  });

  it("rejects a tampered payload", async () => {
    const [h, , s] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ iss: TEST_ISSUER, aud: TEST_AUDIENCE, sub: "admin" }),
    ).toString("base64url");
    expect(await verifyAppToken(`${h}.${forged}.${s}`, options())).toBeUndefined();
  });

  it("rejects a bad or truncated signature", async () => {
    const [h, p, s] = token.split(".");
    const flipped = `${s?.startsWith("A") ? "B" : "A"}${s?.slice(1)}`;
    expect(await verifyAppToken(`${h}.${p}.${flipped}`, options())).toBeUndefined();
    expect(await verifyAppToken(`${h}.${p}.${s?.slice(0, 20)}`, options())).toBeUndefined();
    expect(await verifyAppToken(`${h}.${p}.`, options())).toBeUndefined();
  });

  it("rejects a token signed by a key that is not the one registered for its kid", async () => {
    const wrongKey = await signAppToken(otherKey, { nowMs: T0 });
    expect(await verifyAppToken(wrongKey, options())).toBeUndefined();
  });

  it("selects the key by kid and refuses unknown kids", async () => {
    const rotated = await signAppToken(otherKey, { nowMs: T0, header: { kid: "app-next" } });
    expect(await verifyAppToken(rotated, options())).toBeUndefined();
    const both = { ...options(), keys: { ...options().keys, "app-next": otherKey.publicKey } };
    expect(await verifyAppToken(rotated, both)).toBeDefined();
    const inherited = await signAppToken(appKey, { nowMs: T0, header: { kid: "__proto__" } });
    expect(await verifyAppToken(inherited, options())).toBeUndefined();
  });

  it.each([
    ["none", "none"],
    ["HS256", "HS256"],
    ["RS256", "RS256"],
    ["lowercase eddsa", "eddsa"],
  ])("rejects alg %s", async (_name, alg) => {
    const bad = await signAppToken(appKey, { nowMs: T0, header: { alg } });
    expect(await verifyAppToken(bad, options())).toBeUndefined();
  });

  it("rejects an unsigned alg=none token", async () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const unsigned = `${enc({ alg: "none", typ: "vnbot-p2p+jwt", kid: "app-test" })}.${token.split(".")[1]}.`;
    expect(await verifyAppToken(unsigned, options())).toBeUndefined();
  });

  it("rejects a wrong typ, issuer or audience", async () => {
    for (const bad of [
      await signAppToken(appKey, { nowMs: T0, header: { typ: "JWT" } }),
      await signAppToken(appKey, { nowMs: T0, claims: { iss: "https://evil.example.test" } }),
      await signAppToken(appKey, { nowMs: T0, claims: { aud: "other.example.test" } }),
      await signAppToken(appKey, { nowMs: T0, claims: { aud: [TEST_AUDIENCE] } }),
    ]) {
      expect(await verifyAppToken(bad, options())).toBeUndefined();
    }
  });

  it("rejects a token that lives longer than five minutes", async () => {
    const long = await signAppToken(appKey, { nowMs: T0, claims: { exp: seconds + 301 } });
    expect(await verifyAppToken(long, options())).toBeUndefined();
    const inverted = await signAppToken(appKey, { nowMs: T0, claims: { exp: seconds - 1 } });
    expect(await verifyAppToken(inverted, options(T0 - 5_000))).toBeUndefined();
  });

  it.each([
    ["sub", { sub: "" }],
    ["email", { email: 5 }],
    ["jti", { jti: undefined }],
    ["scope", { scope: "pair" }],
    ["scope entries", { scope: ["pair", 1] }],
    ["nodeId", { nodeId: 5 }],
    ["iat", { iat: "now" }],
    ["exp", { exp: 1.5 }],
  ])("rejects a malformed %s", async (_name, claims) => {
    const bad = await signAppToken(appKey, { nowMs: T0, claims });
    expect(await verifyAppToken(bad, options())).toBeUndefined();
  });

  it("rejects oversized and malformed tokens", async () => {
    const huge = await signAppToken(appKey, {
      nowMs: T0,
      claims: { email: "x".repeat(MAX_TOKEN_LENGTH) },
    });
    expect(await verifyAppToken(huge, options())).toBeUndefined();
    for (const junk of ["", "a.b", "a.b.c.d", "...", "not a token", "e30.e30.e30"]) {
      expect(await verifyAppToken(junk, options())).toBeUndefined();
    }
  });
});
