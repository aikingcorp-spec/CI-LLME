import { generateKeyPair, sign } from "@rakazo/p2p-prototype/pairing";
import { describe, expect, it } from "vitest";
import type { Deps } from "./app.js";
import { handle } from "./app.js";
import { revokeNode } from "./store.js";
import { createD1, signAppToken, T0, testConfig } from "./test-util.js";

describe("account machine registration", () => {
  it("requires a signed account token and machine key, rejects replay, takeover and revocation bypass", async () => {
    const { d1, sql } = createD1();
    const app = generateKeyPair();
    const node = generateKeyPair();
    const deps: Deps = {
      db: d1,
      config: testConfig(generateKeyPair(), { "app-test": app.publicKey }),
      now: () => T0,
      room: () => {
        throw new Error("registration must not open a room");
      },
    };
    const token = (sub = "user-1") => signAppToken(app, { nowMs: T0, claims: { sub } });
    const register = async (credential: string, key = node, signature?: string) =>
      handle(
        new Request("https://gateway.example.test/nodes/register", {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: JSON.stringify({
            nodeId: "desktop-one",
            nodePublicKey: key.publicKey,
            sig: signature ?? sign(key, `register|desktop-one|${credential}`),
            name: "My computer",
            kind: "linux",
          }),
        }),
        deps,
      );
    try {
      const first = await token();
      expect(
        (await register(first, node, sign(generateKeyPair(), `register|desktop-one|${first}`)))
          .status,
      ).toBe(401);
      expect((await register(first)).status).toBe(200);
      expect((await register(first)).status).toBe(401);
      expect((await register(await token())).status).toBe(200);
      expect((await register(await token("other-user"))).status).toBe(409);
      expect((await register(await token(), generateKeyPair())).status).toBe(409);
      await revokeNode(d1, "user-1", "desktop-one", T0);
      expect((await register(await token())).status).toBe(409);
      const expired = await signAppToken(app, { nowMs: T0 - 600_000 });
      expect((await register(expired)).status).toBe(401);
    } finally {
      sql.close();
    }
  });
});
