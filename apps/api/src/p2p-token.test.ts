import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { verifyAppToken } from "../../p2p-gateway/src/app-token.js";
import type { P2pTokenConfig, P2pUser } from "./p2p-token.js";
import {
  mintP2pToken,
  mountP2pTokenRoute,
  P2P_TOKEN_PATH,
  p2pTokenConfigFromEnv,
} from "./p2p-token.js";

const pair = () => {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return { privateKey: jwk.d as string, publicKey: jwk.x as string };
};
const key = pair();
const config: P2pTokenConfig = {
  privateKey: key.privateKey,
  kid: "app-2026-10",
  issuer: "https://app.vnbot.run",
  audience: "p2p.vnbot.run",
};
const user: P2pUser = { id: "user-1", email: "u@example.com" };
const NOW = 1_793_000_000_000;
const gateway = (
  token: string,
  nowMs = NOW,
  keys: Record<string, string> = { [config.kid]: key.publicKey },
) => verifyAppToken(token, { keys, issuer: config.issuer, audience: config.audience, nowMs });

function app(o: { session?: P2pUser | null; cfg?: P2pTokenConfig | undefined } = {}) {
  const a = new Hono();
  mountP2pTokenRoute(a, {
    config: "cfg" in o ? o.cfg : config,
    sessionUser: async () => ("session" in o ? (o.session ?? null) : user),
    trustedOrigin: (origin) => origin === "https://app.vnbot.run",
    now: () => NOW,
  });
  return a;
}
const post = (a: Hono, body: unknown, headers: Record<string, string> = {}) =>
  a.request(P2P_TOKEN_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.vnbot.run", ...headers },
    body: JSON.stringify(body),
  });

describe("mintP2pToken", () => {
  it("is accepted by the gateway verifier with the matching public key", async () => {
    const { token, expiresAt } = mintP2pToken(config, user, ["pair", "nodes"], NOW, "node-1");
    const claims = await gateway(token);
    expect(claims).toMatchObject({
      sub: "user-1",
      email: "u@example.com",
      scope: ["pair", "nodes"],
      nodeId: "node-1",
    });
    expect(expiresAt).toBe(Math.floor(NOW / 1000) * 1000 + 120_000);
  });
  it("is refused by the gateway with another key, another kid, or after expiry", async () => {
    const { token } = mintP2pToken(config, user, ["pair"], NOW);
    expect(await gateway(token, NOW, { [config.kid]: pair().publicKey })).toBeUndefined();
    expect(await gateway(token, NOW, { other: key.publicKey })).toBeUndefined();
    expect(await gateway(token, NOW + 121_000)).toBeUndefined();
  });
  it("gives every token a fresh jti", () => {
    const a = mintP2pToken(config, user, ["pair"], NOW).token.split(".")[1];
    const b = mintP2pToken(config, user, ["pair"], NOW).token.split(".")[1];
    expect(a).not.toBe(b);
  });
});

describe("POST /api/auth/p2p-token", () => {
  it("mints a gateway-valid token for a signed-in user", async () => {
    const r = await post(app(), { scope: ["session"] });
    expect(r.status).toBe(200);
    const { token } = (await r.json()) as { token: string };
    expect((await gateway(token))?.scope).toEqual(["session"]);
  });
  it("refuses without a session", async () => {
    expect((await post(app({ session: null }), { scope: ["pair"] })).status).toBe(401);
  });
  it("is off when not configured", async () => {
    expect((await post(app({ cfg: undefined }), { scope: ["pair"] })).status).toBe(404);
  });
  it("refuses an untrusted origin and a non-JSON body", async () => {
    expect(
      (await post(app(), { scope: ["pair"] }, { origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await post(app(), { scope: ["pair"] }, { "content-type": "text/plain" })).status).toBe(
      415,
    );
  });
  it("refuses unknown, duplicate or empty scopes and a bad nodeId", async () => {
    for (const body of [
      { scope: ["admin"] },
      { scope: ["pair", "pair"] },
      { scope: [] },
      {},
      { scope: ["nodes"], nodeId: "../x" },
    ]) {
      expect((await post(app(), body)).status).toBe(400);
    }
  });
});

describe("p2pTokenConfigFromEnv", () => {
  it("is off when unset and defaults issuer and audience", () => {
    expect(p2pTokenConfigFromEnv({}, "https://app.vnbot.run")).toBeUndefined();
    expect(
      p2pTokenConfigFromEnv(
        { P2P_TOKEN_PRIVATE_KEY: key.privateKey, P2P_TOKEN_KID: "k" },
        "https://app.vnbot.run",
      ),
    ).toEqual({
      privateKey: key.privateKey,
      kid: "k",
      issuer: "https://app.vnbot.run",
      audience: "p2p.vnbot.run",
    });
  });
  it("rejects half or malformed configuration", () => {
    expect(() => p2pTokenConfigFromEnv({ P2P_TOKEN_KID: "k" }, "x")).toThrow();
    expect(() =>
      p2pTokenConfigFromEnv({ P2P_TOKEN_PRIVATE_KEY: "abc", P2P_TOKEN_KID: "k" }, "x"),
    ).toThrow();
  });
});
