import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { expect, it } from "vitest";
import { buildTrustedOrigins } from "./index.js";

it("checks remote origins when a browser already has cookies", async () => {
  const baseURL = "http://127.0.0.1:5173";
  const own = `https://h${"a".repeat(32)}.example.test`;
  const other = `https://h${"b".repeat(32)}.example.test`;
  const auth = betterAuth({
    baseURL,
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    secret: "offline-test-secret-at-least-thirty-two-characters",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    trustedOrigins: buildTrustedOrigins({ origins: [baseURL], extraOrigins: [own] }),
  });
  const request = (origin: string) =>
    auth.handler(
      new Request(`${baseURL}/api/auth/sign-out`, {
        method: "POST",
        headers: { origin, cookie: "regression=non-session", "content-type": "application/json" },
        body: "{}",
      }),
    );
  expect((await request(own)).status).toBe(200);
  const denied = await request(other);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ code: "INVALID_ORIGIN" });
});
