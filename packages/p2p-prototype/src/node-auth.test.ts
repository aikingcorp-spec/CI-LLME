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
  it("renews the same bearer without the previous expiry closing its channel", () => {
    const { auth, token, exp, onRevoke } = fixture();
    const session = auth.acceptAssertion(token)!;
    vi.advanceTimersByTime(30_000);
    const assertion = signAssertion(gatewayKey, {
      nodeId: "node",
      peerId: "peer",
      user: "user",
      exp: exp + 30_000,
    });
    expect(auth.renewBearer(session.bearer, assertion)).toEqual({
      ...session,
      expiresAt: exp + 30_000,
    });
    vi.advanceTimersByTime(30_000);
    expect(auth.checkBearer(session.bearer)).toBeDefined();
    expect(onRevoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(auth.checkBearer(session.bearer)).toBeUndefined();
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });
  it.each([
    { nodeId: "other", peerId: "peer", user: "user" },
    { nodeId: "node", peerId: "other", user: "user" },
    { nodeId: "node", peerId: "peer", user: "other" },
  ])("rejects renewal across an identity boundary: %j", (identity) => {
    const { auth, token, exp, onRevoke } = fixture();
    const session = auth.acceptAssertion(token)!;
    expect(
      auth.renewBearer(
        session.bearer,
        signAssertion(gatewayKey, { ...identity, exp: exp + 30_000 }),
      ),
    ).toBeUndefined();
    expect(auth.checkBearer(session.bearer)).toEqual(session);
    vi.advanceTimersByTime(60_000);
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });
  it("rejects replayed, tampered and untrusted renewals without extending access", () => {
    const { auth, token, exp } = fixture();
    const session = auth.acceptAssertion(token)!;
    expect(auth.renewBearer(session.bearer, token)).toBeUndefined();
    expect(auth.renewBearer(session.bearer, `x${token}`)).toBeUndefined();
    expect(
      auth.renewBearer(
        session.bearer,
        signAssertion(generateKeyPair(), {
          nodeId: "node",
          peerId: "peer",
          user: "user",
          exp: exp + 30_000,
        }),
      ),
    ).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(auth.checkBearer(session.bearer)).toBeUndefined();
  });
  it.each(["expired", "revoked"])("never revives a %s channel", (reason) => {
    const { auth, token, exp } = fixture();
    const session = auth.acceptAssertion(token)!;
    if (reason === "expired") vi.advanceTimersByTime(60_000);
    else auth.revokeUser("user");
    expect(
      auth.renewBearer(
        session.bearer,
        signAssertion(gatewayKey, {
          nodeId: "node",
          peerId: "peer",
          user: "user",
          exp: exp + 60_000,
        }),
      ),
    ).toBeUndefined();
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
