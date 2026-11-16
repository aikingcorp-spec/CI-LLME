import {
  APP_CONTENT_SECURITY_POLICY,
  withPortalFrameAncestor,
} from "@rakazo/contracts/content-security-policy";
import { expect, it, vi } from "vitest";
import { portalFramePolicy } from "./remote-frame-policy";

it("admits only frame origins from this deployment's portal metadata", async () => {
  const request = vi.fn(async () =>
    Response.json({
      kind: "portal",
      portalOrigin: "https://portal.example.test",
      frameSrc: ["https://*.machines.example.test"],
    }),
  );
  const policy = await portalFramePolicy(
    "http://localhost:3100",
    "portal.example.test",
    APP_CONTENT_SECURITY_POLICY,
    request,
  );
  expect(policy).toContain("frame-src 'self' blob: https://*.machines.example.test");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(
    await portalFramePolicy(
      "http://localhost:3100",
      "other.example.test",
      APP_CONTENT_SECURITY_POLICY,
      request,
    ),
  ).toBe(APP_CONTENT_SECURITY_POLICY);
});
it("keeps framing blocked when the API is unavailable or returns unsafe sources", async () => {
  for (const body of [
    { kind: "computer" },
    { kind: "portal", portalOrigin: "https://portal.example.test", frameSrc: ["*"] },
  ]) {
    expect(
      await portalFramePolicy(
        "http://localhost:3100",
        "portal.example.test",
        APP_CONTENT_SECURITY_POLICY,
        async () => Response.json(body),
      ),
    ).toBe(APP_CONTENT_SECURITY_POLICY);
  }
});
it("preserves existing nested-viewer policy while admitting the exact pinned ancestor", () => {
  expect(
    withPortalFrameAncestor(
      "default-src 'none'; frame-ancestors 'self'",
      "https://portal.example.test",
    ),
  ).toBe("default-src 'none'; frame-ancestors 'self' https://portal.example.test");
  expect(
    withPortalFrameAncestor("sandbox; default-src 'none'", "https://portal.example.test"),
  ).toBe("sandbox; default-src 'none'");
  expect(() =>
    withPortalFrameAncestor("frame-ancestors 'none'", "https://*.example.test"),
  ).toThrow();
});
