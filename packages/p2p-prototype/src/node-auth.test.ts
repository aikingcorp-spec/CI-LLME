import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeAuth } from "./node-auth.js";
import { generateKeyPair, signAssertion } from "./pairing.js";

const gatewayKey = generateKeyPair();
const nodeKey = generateKeyPair();

describe("node authentication", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  function fixture() {
    const onRevoke = vi.fn();
    const auth = createNodeAuth({
      nodeId: "node",
      keyPair: nodeKey,
      gatewayPublicKey: gatewayKey.publicKey,
      allowedUsers: ["user"],
      onRevoke,
    });
    const exp = Date.now() + 60_000;
    const token = signAssertion(gatewayKey, { nodeId: "node", peerId: "peer", user: "user", exp });
    return { auth, token, exp, onRevoke };
  }
  it("mints random bearers bound to the user and assertion expiry", () => {
    const { auth, token, exp } = fixture();
    const first = auth.acceptAssertion(token);
    const second = auth.acceptAssertion(token);
    expect(first).toMatchObject({ user: "user", expiresAt: exp });
    expect(first?.bearer).not.toBe(second?.bearer);
    expect(auth.checkBearer(first?.bearer ?? "")).toEqual(first);
    expect(auth.checkBearer("unknown")).toBeUndefined();
  });
  it("rejects a revoked user and closes all their sessions", () => {
    const { auth, token, onRevoke } = fixture();
    const session = auth.acceptAssertion(token);
    auth.acceptAssertion(token);
    expect(auth.revokeUser("user")).toBe(2);
    expect(onRevoke).toHaveBeenCalledTimes(2);
    expect(auth.checkBearer(session?.bearer ?? "")).toBeUndefined();
    expect(auth.acceptAssertion(token)).toBeUndefined();
  });
  it("rejects a revoked bearer and closes only its channel", () => {
    const { auth, token, onRevoke } = fixture();
    const first = auth.acceptAssertion(token);
    const second = auth.acceptAssertion(token);
    expect(auth.revokeBearer(first?.bearer ?? "")).toBe(true);
    expect(auth.revokeBearer(first?.bearer ?? "")).toBe(false);
    expect(auth.checkBearer(first?.bearer ?? "")).toBeUndefined();
    expect(auth.checkBearer(second?.bearer ?? "")).toEqual(second);
    expect(onRevoke).toHaveBeenCalledExactlyOnceWith(first);
  });
  it("rejects expired assertions", () => {
    const { auth, token } = fixture();
    vi.advanceTimersByTime(60_000);
    expect(auth.acceptAssertion(token)).toBeUndefined();
  });
  it("expires bearers and closes idle channels at expiry", () => {
    const { auth, token, onRevoke } = fixture();
    const session = auth.acceptAssertion(token);
    vi.advanceTimersByTime(60_000);
    expect(onRevoke).toHaveBeenCalledExactlyOnceWith(session);
    expect(auth.checkBearer(session?.bearer ?? "")).toBeUndefined();
  });
  it("rejects tampered assertions", () => {
    const { auth, token } = fixture();
    expect(auth.acceptAssertion(`x${token}`)).toBeUndefined();
  });
  it("rejects an unpinned gateway", () => {
    const { auth, exp } = fixture();
    expect(
      auth.acceptAssertion(
        signAssertion(generateKeyPair(), { nodeId: "node", user: "user", peerId: "peer", exp }),
      ),
    ).toBeUndefined();
  });
  it("rejects another node", () => {
    const { auth, exp } = fixture();
    expect(
      auth.acceptAssertion(
        signAssertion(gatewayKey, { nodeId: "other", user: "user", peerId: "peer", exp }),
      ),
    ).toBeUndefined();
  });
  it("rejects a user without a local binding", () => {
    const { auth, exp } = fixture();
    expect(
      auth.acceptAssertion(
        signAssertion(gatewayKey, { nodeId: "node", user: "other", peerId: "peer", exp }),
      ),
    ).toBeUndefined();
  });
});
