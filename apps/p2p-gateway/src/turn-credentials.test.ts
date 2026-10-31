import { createHmac } from "node:crypto";
import { generateKeyPair, nodeAuthorization } from "@rakazo/p2p-prototype/pairing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnIceServer } from "../../../packages/p2p-prototype/src/turn-credentials.js";
import type { Deps } from "./app.js";
import { handle } from "./app.js";
import { signAssertion } from "./pairing.js";
import { insertNode, revokeNode } from "./store.js";
import { createD1, fakeRooms, T0, testConfig } from "./test-util.js";
import { loadTurnConfig } from "./turn-config.js";

const gateway = generateKeyPair();
const node = generateKeyPair();
const settings = {
  TURN_SECRET: "dummy-turn-test-secret",
  TURN_URLS:
    "turn:relay.example.test:3479?transport=udp, turn:relay.example.test:3479?transport=tcp, turns:relay.example.test:5350",
};
let db: ReturnType<typeof createD1>;
let deps: Deps;
let now: number;

beforeEach(async () => {
  db = createD1();
  now = T0;
  deps = {
    db: db.d1,
    config: { ...testConfig(gateway, {}), turn: loadTurnConfig(settings) },
    room: fakeRooms().room,
    now: () => now,
  };
  await insertNode(
    db.d1,
    {
      nodeId: "node-1",
      publicKey: node.publicKey,
      user: { id: "user-1", email: "fake@example.test" },
      name: "Test",
      kind: "linux",
      gatewayKeyId: "gw-test",
    },
    now,
  );
});
afterEach(() => db.sql.close());

function request(authorization?: string, peer = "node-1") {
  return handle(
    new Request(`https://gateway.example.test/turn-credentials?peer=${peer}`, {
      headers: authorization ? { authorization } : {},
    }),
    deps,
  );
}
const nodeAuth = () => nodeAuthorization(node, "node-1", now);
async function clientAuth(exp = T0 + 60_000, user = "user-1") {
  return `Assertion ${await signAssertion(gateway, { nodeId: "node-1", peerId: "peer-1", user, exp })}`;
}

it("requires valid signaling auth even when TURN is disabled", async () => {
  for (const enabled of [true, false]) {
    if (!enabled) deps.config.turn = undefined;
    expect((await request()).status).toBe(401);
    expect((await request("Node invalid")).status).toBe(401);
    expect((await request("Bearer invalid")).status).toBe(401);
  }
});

it.each([{ TURN_SECRET: undefined }, { TURN_URLS: undefined }, { TURN_URLS: " , " }])(
  "returns 501 when a required setting is absent: %j",
  async (missing) => {
    deps.config.turn = loadTurnConfig({ ...settings, ...missing });
    expect((await request(nodeAuth())).status).toBe(501);
    expect((await request(await clientAuth(), "peer-1")).status).toBe(501);
  },
);

it("returns RTC ICE fields with coturn HMAC and a short default TTL, never the secret", async () => {
  const response = await request(nodeAuth());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  const username = `${Math.floor(now / 1000) + 600}:node-1`;
  expect(body).toEqual({
    urls: settings.TURN_URLS.split(",").map((url) => url.trim()),
    username,
    credential: createHmac("sha1", settings.TURN_SECRET).update(username).digest("base64"),
    ttl: 600,
  });
  expect(JSON.stringify(body)).not.toContain(settings.TURN_SECRET);
});

it.each([
  ["30", 30],
  ["999999", 3600],
  ["0", 600],
  ["-1", 600],
  ["1.5", 600],
  ["invalid", 600],
])("bounds configured TTL %s to %i", async (raw, ttl) => {
  deps.config.turn = loadTurnConfig({ ...settings, TURN_TTL_SECONDS: raw });
  const body = await (await request(nodeAuth())).json<TurnIceServer>();
  expect(body.ttl).toBe(ttl);
  expect(body.username).toBe(`${Math.floor(now / 1000) + ttl}:node-1`);
});

it("limits browser credentials to the remaining assertion lifetime", async () => {
  const auth = await clientAuth();
  now += 15_500;
  const body = await (await request(auth, "peer-1")).json<TurnIceServer>();
  expect(body.ttl).toBe(44);
  expect(Number(body.username.split(":")[0]) * 1000).toBeLessThanOrEqual(T0 + 60_000);
  now = T0 + 59_500;
  expect((await request(auth, "peer-1")).status).toBe(401);
  now = T0 + 60_000;
  expect((await request(auth, "peer-1")).status).toBe(401);
});

it("refuses a mismatched peer, foreign owner, stale proof and revoked node", async () => {
  expect((await request(nodeAuth(), "another-peer")).status).toBe(403);
  expect((await request(await clientAuth(), "another-peer")).status).toBe(403);
  expect((await request(await clientAuth(T0 + 60_000, "another-user"), "peer-1")).status).toBe(401);
  expect((await request(nodeAuthorization(node, "node-1", now - 31_000))).status).toBe(401);
  const auth = await clientAuth();
  await revokeNode(db.d1, "user-1", "node-1", now);
  expect((await request(nodeAuth())).status).toBe(401);
  expect((await request(auth, "peer-1")).status).toBe(401);
});

describe("optional TURN URL configuration", () => {
  it("fails closed for a non-TURN URL", () => {
    expect(
      loadTurnConfig({ ...settings, TURN_URLS: "https://relay.example.test" }),
    ).toBeUndefined();
  });
});

it("rate limits issuance per authenticated user across fresh assertions and peers", async () => {
  for (let i = 0; i < 10; i++)
    expect((await request(await clientAuth(), "peer-1")).status).toBe(200);
  const otherPeer = `Assertion ${await signAssertion(gateway, { nodeId: "node-1", peerId: "peer-2", user: "user-1", exp: now + 120_000 })}`;
  const limited = await request(otherPeer, "peer-2");
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await request(nodeAuth())).status).toBe(200);
  now += 60_000;
  expect((await request(await clientAuth(now + 60_000), "peer-1")).status).toBe(200);
});

it("rate limits nodes independently of other paired identities", async () => {
  for (let i = 0; i < 10; i++) expect((await request(nodeAuth())).status).toBe(200);
  expect((await request(nodeAuth())).status).toBe(429);
  const second = generateKeyPair();
  await insertNode(
    db.d1,
    {
      nodeId: "node-2",
      publicKey: second.publicKey,
      user: { id: "user-2", email: "two@example.test" },
      name: "Test",
      kind: "linux",
      gatewayKeyId: "gw-test",
    },
    now,
  );
  expect((await request(nodeAuthorization(second, "node-2", now), "node-2")).status).toBe(200);
  const assertion = `Assertion ${await signAssertion(gateway, { nodeId: "node-2", peerId: "peer-2", user: "user-2", exp: now + 60_000 })}`;
  expect((await request(assertion, "peer-2")).status).toBe(200);
});

it("enforces the limit under concurrent requests and across request dependency objects", async () => {
  const auth = nodeAuth();
  const responses = await Promise.all(
    Array.from({ length: 15 }, () =>
      handle(
        new Request("https://gateway.example.test/turn-credentials?peer=node-1", {
          headers: { authorization: auth },
        }),
        { ...deps },
      ),
    ),
  );
  expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
  expect(responses.filter((response) => response.status === 429)).toHaveLength(5);
});

it.each(["/signal?peer=peer-1", "/agent?node=node-1", "/turn-credentials?peer=peer-1"])(
  "rejects disallowed HTTP and WebSocket origins at %s",
  async (path) => {
    for (const upgrade of [false, true]) {
      const response = await handle(
        new Request(`https://gateway.example.test${path}`, {
          headers: {
            origin: "https://untrusted.example.test",
            authorization: await clientAuth(),
            ...(upgrade ? { upgrade: "websocket" } : {}),
          },
        }),
        deps,
      );
      expect(response.status).toBe(403);
    }
  },
);

it("admits allowlisted signaling origins and originless native peers, while retaining auth", async () => {
  for (const origin of ["https://app.example.test", undefined]) {
    const headers = {
      upgrade: "websocket",
      authorization: await clientAuth(),
      ...(origin ? { origin } : {}),
    };
    expect(
      (
        await handle(
          new Request("https://gateway.example.test/signal?peer=peer-1", { headers }),
          deps,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handle(
          new Request("https://gateway.example.test/signal?peer=peer-1", {
            headers: { upgrade: "websocket", ...(origin ? { origin } : {}) },
          }),
          deps,
        )
      ).status,
    ).toBe(401);
  }
});
