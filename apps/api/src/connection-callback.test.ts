import { describe, expect, it } from "vitest";
import { integrationCallbackUrl } from "./connection-flows.js";

const webOrigin = "http://127.0.0.1:5173";
const host = "https://h.example.test";

describe("integration OAuth callback", () => {
  const trusted = (origin: string) => origin === webOrigin || origin === host;

  it("returns to the trusted host that started the request", () => {
    expect(integrationCallbackUrl(webOrigin, host, trusted)).toBe(
      "https://h.example.test/integrations/callback",
    );
  });

  it("stays on the configured origin when the request has no origin", () => {
    expect(integrationCallbackUrl(webOrigin, null, trusted)).toBe(
      "http://127.0.0.1:5173/integrations/callback",
    );
  });

  it.each([
    "https://other.example.test",
    "https://user:secret@h.example.test",
    "https://h.example.test/integrations/callback",
    "http://evil.example.test",
    "not a url",
    "javascript:alert(1)",
  ])("ignores an untrusted or decorated origin %s", (origin) => {
    expect(integrationCallbackUrl(webOrigin, origin, trusted)).toBe(
      "http://127.0.0.1:5173/integrations/callback",
    );
  });
});
