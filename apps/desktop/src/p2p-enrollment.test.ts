import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readKeyFile, writeKeyFile } from "../../../packages/p2p-prototype/src/key-file.js";
import { generateKeyPair, sign } from "../../../packages/p2p-prototype/src/pairing.js";
import { handle } from "../../p2p-gateway/src/app.js";
import { revokeNode } from "../../p2p-gateway/src/store.js";
import { createD1, signAppToken, T0, testConfig } from "../../p2p-gateway/src/test-util.js";
import { enrollDesktop } from "./p2p-enrollment.js";

describe("desktop enrollment with the real gateway registry and signatures", () => {
  it.each(["linux", "win32"])(
    "registers %s once, upgrades legacy pairing and refuses account takeover or revoked identities",
    async (platform) => {
      const root = await mkdtemp(path.join(tmpdir(), "p2p-enrollment-"));
      const { d1, sql } = createD1();
      const app = generateKeyPair();
      const config = testConfig(generateKeyPair(), { "app-test": app.publicKey });
      const token = (sub = "user-1") => signAppToken(app, { nowMs: T0, claims: { sub } });
      const pairing = {
        generateKeyPair,
        sign,
        readKeyFile,
        writeKeyFile,
        completePairing: async () => {
          throw new Error("A second pairing code is unnecessary");
        },
      };
      const enroll = async (sub = "user-1", localUser = "local-user") =>
        enrollDesktop({
          platform,
          userDataDir: root,
          localUser,
          name: "My computer",
          gatewayUrl: "https://gateway.example.test",
          appToken: await token(sub),
          pairing,
          request: async (input, init) =>
            handle(new Request(input, init), {
              db: d1,
              config,
              now: () => T0,
              room: () => {
                throw new Error("No room needed for enrollment");
              },
            }),
        });
      try {
        const nodeId = await enroll();
        const file = path.join(root, "p2p", "node-key.json");
        const key = readKeyFile(file)!;
        expect(key).toMatchObject({ nodeId, localUser: "local-user", user: "user-1" });
        expect(await enroll()).toBe(nodeId);
        expect(sql.prepare("SELECT COUNT(*) AS count FROM nodes").get()).toMatchObject({
          count: 1,
        });
        // An existing pairing gains local-user binding only after the same account proves ownership.
        writeKeyFile(file, {
          publicKey: key.publicKey,
          privateKey: key.privateKey,
          gatewayPublicKey: key.gatewayPublicKey,
          user: key.user,
        });
        await writeFile(path.join(root, "p2p", "node-id"), nodeId);
        expect(await enroll()).toBe(nodeId);
        expect(readKeyFile(file)?.publicKey).toBe(key.publicKey);
        expect(readKeyFile(file)?.localUser).toBe("local-user");
        await expect(enroll("another-user")).rejects.toThrow("registration refused");
        await expect(enroll("user-1", "another-local-user")).rejects.toThrow(
          "another local account",
        );
        await revokeNode(d1, "user-1", nodeId, T0);
        await expect(enroll()).rejects.toThrow("registration refused");
      } finally {
        sql.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
