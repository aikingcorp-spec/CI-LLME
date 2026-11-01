import { describe, expect, it } from "vitest";
import type { TurnConfig } from "./turn-credentials.js";
import { mintTurnCredentials, toNodeDatachannelIceServers } from "./turn-credentials.js";

const cfg: TurnConfig = {
  secret: "s3cret",
  urls: ["turn:192.0.2.10:3478?transport=udp", "turns:turn.example.test?transport=tcp"],
  ttlSeconds: 600,
};
const NOW_MS = 1_700_000_000_500;

describe("mintTurnCredentials", () => {
  it("matches a known HMAC-SHA1 vector", async () => {
    const c = await mintTurnCredentials(cfg, "peer-a", NOW_MS);
    expect(c.username).toBe("1700000600:peer-a");
    expect(c.credential).toBe("BFsFv2AUU6n7zdKuHP9tq0VL8QI=");
  });

  it("computes expiry from now plus ttl in whole seconds", async () => {
    const c = await mintTurnCredentials({ ...cfg, ttlSeconds: 60 }, "p", NOW_MS);
    expect(c.expiresAt).toBe(1_700_000_060);
    expect(c.ttlSeconds).toBe(60);
    expect(c.urls).toEqual(cfg.urls);
  });

  it("rejects bad ttl and peer ids", async () => {
    for (const ttlSeconds of [0, -1, 3601, 1.5, Number.NaN]) {
      await expect(mintTurnCredentials({ ...cfg, ttlSeconds }, "p", NOW_MS)).rejects.toThrow(/ttl/);
    }
    await expect(mintTurnCredentials(cfg, "", NOW_MS)).rejects.toThrow(/peerId/);
    await expect(mintTurnCredentials(cfg, "a:b", NOW_MS)).rejects.toThrow(/peerId/);
  });

  it("never exposes the secret", async () => {
    const c = await mintTurnCredentials(cfg, "peer-a", NOW_MS);
    const out = JSON.stringify([c, toNodeDatachannelIceServers(c)]);
    expect(out).not.toContain(cfg.secret);
  });
});

describe("toNodeDatachannelIceServers", () => {
  it("maps urls to structured ice servers", async () => {
    const c = await mintTurnCredentials(cfg, "peer-a", NOW_MS);
    expect(toNodeDatachannelIceServers(c)).toEqual([
      {
        hostname: "192.0.2.10",
        port: 3478,
        username: c.username,
        password: c.credential,
        relayType: "TurnUdp",
      },
      {
        hostname: "turn.example.test",
        port: 5349,
        username: c.username,
        password: c.credential,
        relayType: "TurnTls",
      },
    ]);
  });

  it("handles tcp transport, default port and bracketed ipv6", async () => {
    const c = await mintTurnCredentials(
      { ...cfg, urls: ["turn:turn.example.test?transport=tcp", "turn:[2001:db8::1]:3479"] },
      "p",
      NOW_MS,
    );
    const [tcp, v6] = toNodeDatachannelIceServers(c);
    expect(tcp).toMatchObject({ hostname: "turn.example.test", port: 3478, relayType: "TurnTcp" });
    expect(v6).toMatchObject({ hostname: "2001:db8::1", port: 3479, relayType: "TurnUdp" });
  });

  it("rejects non-turn urls", async () => {
    const c = await mintTurnCredentials({ ...cfg, urls: ["stun:192.0.2.10:3478"] }, "p", NOW_MS);
    expect(() => toNodeDatachannelIceServers(c)).toThrow(/invalid TURN url/);
  });
  it.each([
    "turn:host:0",
    "turn:host:65536",
    "turn:bad host:3479",
    "turn:host/path",
    "turns:host?transport=udp",
  ])("rejects invalid TURN address %s", (url) => {
    expect(() =>
      toNodeDatachannelIceServers({
        urls: [url],
        username: "dummy-user",
        credential: "dummy-credential",
      }),
    ).toThrow();
  });
});
