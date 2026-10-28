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
    expect(sql).toContain('CHECK ("email" = lower(btrim("email")) AND "email" LIKE \'%_@_%\')');
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("current_setting('app.rls_bypass', true) = 'on'");
    expect(ROW_SECURITY_MODELS.has("AuthEmailAllowlist")).toBe(true);
  });
});
