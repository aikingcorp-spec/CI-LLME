import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNodeTurnResolver } from "./gateway-client.js";
import { generateKeyPair, parseNodeProof } from "./pairing.js";

const gateway = "https://gateway.example.test";
const turn = {
  urls: ["turn:relay.example.test:3478?transport=udp"],
  username: "fixture-expiry:fixture-node",
  credential: "fixture-credential",
  ttl: 600,
};
let now = 0;
let request: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  request = vi.fn<typeof fetch>(async () => Response.json(turn));
  vi.stubGlobal("fetch", request);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("shares one credential request across twenty concurrent connections to the same node", async () => {
  const resolve = createNodeTurnResolver(gateway, "fixture-node", generateKeyPair());
  const results = await Promise.all(Array.from({ length: 20 }, () => resolve()));
  expect(request).toHaveBeenCalledTimes(1);
  expect(results).toHaveLength(20);
  expect(results.every((servers) => servers[0]?.username === turn.username)).toBe(true);
  expect(results[0]).not.toBe(results[1]);
  expect(results[0]?.[0]).not.toBe(results[1]?.[0]);
  now = 299_999;
  await resolve();
  expect(request).toHaveBeenCalledTimes(1);
  now = 300_000;
  await resolve();
  expect(request).toHaveBeenCalledTimes(2);
});

it("keeps credential ownership and in-flight requests separate for each node", async () => {
  const first = createNodeTurnResolver(gateway, "fixture-one", generateKeyPair());
  const second = createNodeTurnResolver(gateway, "fixture-two", generateKeyPair());
  await Promise.all([first(), second(), first(), second()]);
  expect(request).toHaveBeenCalledTimes(2);
  const owners = request.mock.calls.map(([, init]) => {
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    return parseNodeProof(authorization.slice(5))?.nodeId;
  });
  expect(owners).toEqual(["fixture-one", "fixture-two"]);
});

it("refreshes short credentials before expiry and never falls back to an expired cache", async () => {
  request.mockImplementation(async () => Response.json({ ...turn, ttl: 5 }));
  const resolve = createNodeTurnResolver(gateway, "fixture-node", generateKeyPair());
  expect(await resolve()).toHaveLength(1);
  now = 3000;
  request.mockImplementation(async () => new Response(null, { status: 503 }));
  expect(await resolve()).toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);
  request.mockImplementation(async () => Response.json(turn));
  expect(await resolve()).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(3);
});

it("does not return a credential whose remaining lifetime was consumed by the request", async () => {
  request.mockImplementation(async () => {
    now += 2500;
    return Response.json({ ...turn, ttl: 2 });
  });
  const resolve = createNodeTurnResolver(gateway, "fixture-node", generateKeyPair());
  expect(await resolve()).toEqual([]);
  expect(await resolve()).toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);
});
