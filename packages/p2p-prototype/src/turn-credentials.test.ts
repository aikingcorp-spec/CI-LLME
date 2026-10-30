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
  it("matches a known HMAC-SHA1 vector", () => {
    const c = mintTurnCredentials(cfg, "peer-a", NOW_MS);
    expect(c.username).toBe("1700000600:peer-a");
    expect(c.credential).toBe("BFsFv2AUU6n7zdKuHP9tq0VL8QI=");
  });

  it("computes expiry from now plus ttl in whole seconds", () => {
    const c = mintTurnCredentials({ ...cfg, ttlSeconds: 60 }, "p", NOW_MS);
    expect(c.expiresAt).toBe(1_700_000_060);
    expect(c.ttlSeconds).toBe(60);
    expect(c.urls).toEqual(cfg.urls);
  });

  it("rejects bad ttl and peer ids", () => {
    for (const ttlSeconds of [0, -1, 3601, 1.5, Number.NaN]) {
      expect(() => mintTurnCredentials({ ...cfg, ttlSeconds }, "p", NOW_MS)).toThrow(/ttl/);
    }
    expect(() => mintTurnCredentials(cfg, "", NOW_MS)).toThrow(/peerId/);
    expect(() => mintTurnCredentials(cfg, "a:b", NOW_MS)).toThrow(/peerId/);
  });

  it("never exposes the secret", () => {
    const c = mintTurnCredentials(cfg, "peer-a", NOW_MS);
    const out = JSON.stringify([c, toNodeDatachannelIceServers(c)]);
    expect(out).not.toContain(cfg.secret);
  });
});

describe("toNodeDatachannelIceServers", () => {
  it("maps urls to structured ice servers", () => {
    const c = mintTurnCredentials(cfg, "peer-a", NOW_MS);
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

  it("handles tcp transport, default port and bracketed ipv6", () => {
    const c = mintTurnCredentials(
      { ...cfg, urls: ["turn:turn.example.test?transport=tcp", "turn:[2001:db8::1]:3479"] },
      "p",
      NOW_MS,
    );
    const [tcp, v6] = toNodeDatachannelIceServers(c);
    expect(tcp).toMatchObject({ hostname: "turn.example.test", port: 3478, relayType: "TurnTcp" });
    expect(v6).toMatchObject({ hostname: "2001:db8::1", port: 3479, relayType: "TurnUdp" });
  });

  it("rejects non-turn urls", () => {
    const c = mintTurnCredentials({ ...cfg, urls: ["stun:192.0.2.10:3478"] }, "p", NOW_MS);
    expect(() => toNodeDatachannelIceServers(c)).toThrow(/invalid TURN url/);
  });
});
