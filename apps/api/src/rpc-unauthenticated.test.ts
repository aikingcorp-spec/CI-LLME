import { RPCHandler } from "@orpc/server/fetch";
import { describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

// Signed-out deep links (/settings, /bots, /integrations) load the SPA, whose first
// calls hit these procedures. The web app can only redirect to /sign-in if the API
// answers with a machine-readable 401, never HTML or a 500.
const PROTECTED = [
  ["bots/list", {}],
  ["preferences/update", { avatarStyle: "robot" }],
  ["marketplace/catalog", { query: "" }],
  ["capabilities/list", {}],
  ["capabilities/catalogSearch", { query: "stripe" }],
] as const;

describe("unauthenticated RPC", () => {
  const handler = new RPCHandler(
    createRouter({
      prisma: {} as never,
      env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
      dataDir: "/tmp/rpc-unauthenticated-test",
    } as unknown as RouterDeps),
  );

  it.each(PROTECTED)("%s answers 401 JSON with code UNAUTHORIZED", async (path, input) => {
    const { matched, response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: null } },
    );
    expect(matched).toBe(true);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("content-type")).toMatch(/application\/json/);
    await expect(response?.json()).resolves.toMatchObject({
      json: { code: "UNAUTHORIZED", status: 401 },
    });
  });
});
