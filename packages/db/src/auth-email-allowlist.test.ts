import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROW_SECURITY_MODELS } from "./row-security.js";

describe("auth email allowlist migration", () => {
  it("adds a system-only table the client treats as protected", () => {
    const sql = readFileSync(
      new URL(
        "../prisma/migrations/20261031090000_auth_email_allowlist/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(sql).toContain('CREATE TABLE "auth_email_allowlist"');
    // Same order as normalizeEmail: trim, NFC, strip zero-width, lowercase.
    expect(sql).toContain(
      "CHECK (\"email\" = lower(regexp_replace(normalize(btrim(\"email\"), NFC), '[\\u200B\\u200C\\u200D\\u2060\\uFEFF]', '', 'g')) AND \"email\" LIKE '%_@_%')",
    );
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain('ALTER TABLE "auth_email_allowlist" FORCE ROW LEVEL SECURITY');
    const keyed = readFileSync(
      new URL(
        "../prisma/migrations/20261211160000_vnbot_system_policies_key_check/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    // The original policy is replaced by the shared key check.
    expect(keyed).toContain(
      'CREATE POLICY auth_email_allowlist_system ON "auth_email_allowlist"\n  USING ((SELECT app_rls_bypass()));',
    );
    expect(ROW_SECURITY_MODELS.has("AuthEmailAllowlist")).toBe(true);
  });
});
