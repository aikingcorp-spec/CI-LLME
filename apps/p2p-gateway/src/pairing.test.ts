import {
  generateKeyPair,
  nodeAuthorization,
  pairingMessage as nodePairingMessage,
  nodeProofMessage as protoNodeProofMessage,
  sign as protoSign,
  signAssertion as protoSignAssertion,
  signNodeProof,
  verifyAssertion as protoVerifyAssertion,
} from "@rakazo/p2p-prototype/pairing";
import { describe, expect, it } from "vitest";
import { isPublicKey, sha256Hex, sign, verify } from "./crypto.js";
import {
  hashPairingCode,
  newPairingCode,
  nodeProofMessage,
  pairingMessage,
  parseNodeProof,
  signAssertion,
  verifyAssertion,
  verifyNodeProof,
} from "./pairing.js";
import { handle } from "./app.js";
import { createD1, signAppToken, T0, testConfig } from "./test-util.js";

const node = generateKeyPair();
const gateway = generateKeyPair();

describe("pairing codes", () => {
  it("makes 8 symbols from the unambiguous alphabet and does not repeat", () => {
    const codes = new Set(Array.from({ length: 200 }, newPairingCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  });

  it("hashes with SHA-256 hex so the code itself is never stored", async () => {
    expect(await hashPairingCode("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex("")).toHaveLength(64);
  });
});

describe("Ed25519 over WebCrypto", () => {
  it("verifies what the prototype signs, and rejects forgeries", async () => {
    const sig = protoSign(node, "hello");
    expect(await verify(node.publicKey, "hello", sig)).toBe(true);
    expect(await verify(node.publicKey, "hello!", sig)).toBe(false);
    expect(await verify(gateway.publicKey, "hello", sig)).toBe(false);
  });

  it("produces signatures the prototype verifies", async () => {
    const { verify: protoVerify } = await import("@rakazo/p2p-prototype/pairing");
    expect(protoVerify(gateway.publicKey, "x", await sign(gateway, "x"))).toBe(true);
  });

  it("treats malformed keys and signatures as a failed check", async () => {
    expect(await verify("not-a-key", "m", "sig")).toBe(false);
    expect(await verify(node.publicKey, "m", "!!!")).toBe(false);
    expect(await verify(node.publicKey, "m", "")).toBe(false);
    expect(await isPublicKey(node.publicKey)).toBe(true);
    expect(await isPublicKey("AAAA")).toBe(false);
    expect(await isPublicKey("")).toBe(false);
  });
});

describe("message formats match the node agent", () => {
  it("builds the same signed strings", () => {
    expect(pairingMessage("ABCD2345", "n1")).toBe(nodePairingMessage("ABCD2345", "n1"));
    expect(nodeProofMessage("agent", "n1", 5)).toBe(protoNodeProofMessage("agent", "n1", 5));
    expect(nodeProofMessage("signal", "n1", 5)).toBe(protoNodeProofMessage("signal", "n1", 5));
  });
});

describe("node proofs", () => {
  it("accepts a proof signed by the node's key within the skew window", async () => {
    const proof = signNodeProof(node, "agent", "n1", T0);
    expect(await verifyNodeProof(node.publicKey, "agent", proof, T0)).toBe(true);
    expect(await verifyNodeProof(node.publicKey, "agent", proof, T0 + 30_000)).toBe(true);
    expect(await verifyNodeProof(node.publicKey, "agent", proof, T0 - 30_000)).toBe(true);
  });

  it("rejects a stale proof, another key, another scope and another node", async () => {
    const proof = signNodeProof(node, "agent", "n1", T0);
    expect(await verifyNodeProof(node.publicKey, "agent", proof, T0 + 30_001)).toBe(false);
    expect(await verifyNodeProof(gateway.publicKey, "agent", proof, T0)).toBe(false);
    expect(await verifyNodeProof(node.publicKey, "signal", proof, T0)).toBe(false);
    expect(await verifyNodeProof(node.publicKey, "agent", { ...proof, nodeId: "n2" }, T0)).toBe(
      false,
    );
  });

  it("parses the Authorization credential the node builds", () => {
    const header = nodeAuthorization(node, "n1", T0);
    const proof = parseNodeProof(header.slice("Node ".length));
    expect(proof).toMatchObject({ nodeId: "n1", ts: T0 });
    expect(parseNodeProof("")).toBeUndefined();
    expect(parseNodeProof("!!!")).toBeUndefined();
    expect(parseNodeProof(Buffer.from('{"nodeId":1}').toString("base64url"))).toBeUndefined();
  });
});

describe("assertions", () => {
  const payload = { nodeId: "n1", user: "u1", peerId: "p1", exp: T0 + 60_000 };

  it("round-trips and interoperates with the prototype in both directions", async () => {
    const token = await signAssertion(gateway, payload);
    expect(await verifyAssertion(gateway.publicKey, token, T0)).toEqual(payload);
    expect(protoVerifyAssertion(gateway.publicKey, token, T0)).toEqual(payload);
    expect(await verifyAssertion(gateway.publicKey, protoSignAssertion(gateway, payload), T0)).toEqual(
      payload,
    );
  });

  it("rejects an expired, tampered or foreign assertion", async () => {
    const token = await signAssertion(gateway, payload);
    expect(await verifyAssertion(gateway.publicKey, token, payload.exp)).toBeUndefined();
    expect(await verifyAssertion(node.publicKey, token, T0)).toBeUndefined();
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, user: "u2" })).toString("base64url");
    expect(await verifyAssertion(gateway.publicKey, `${forged}.${sig}`, T0)).toBeUndefined();
    expect(await verifyAssertion(gateway.publicKey, `${body}`, T0)).toBeUndefined();
    expect(await verifyAssertion(gateway.publicKey, `${body}.${sig}.x`, T0)).toBeUndefined();
  });
});

describe("D1-backed pairing flow", () => {
  it("applies the migration and persists a redeemed pairing", async () => {
    const { d1, sql } = createD1();
    expect(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'").get()).toBeTruthy();
    const app = generateKeyPair();
    const gateway = generateKeyPair();
    const node = generateKeyPair();
    const token = await signAppToken(app, { nowMs: T0, claims: { scope: ["pair"] } });
    const deps = { db: d1, config: testConfig(gateway, { "app-test": app.publicKey }), room: () => ({ fetch: async () => new Response(null, { status: 101 }), online: async () => false, kick: async () => {} }), now: () => T0 };
    const start = await handle(new Request("https://gw.test/pair/start", { method: "POST", headers: { authorization: `Bearer ${token}` } }), deps);
    expect(start.status).toBe(200);
    const { code } = (await start.json()) as { code: string };
    const sig = await sign(node, pairingMessage(code, "node-1"));
    const complete = await handle(new Request("https://gw.test/pair/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, nodeId: "node-1", nodePublicKey: node.publicKey, sig, kind: "unknown" }) }), deps);
    expect(complete.status).toBe(200);
    expect(sql.prepare("SELECT user_id FROM nodes WHERE node_id = 'node-1'").get()).toMatchObject({ user_id: "user-1" });
  });
});
