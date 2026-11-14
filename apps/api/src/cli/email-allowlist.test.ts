import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("email-allowlist command", () => {
  it("stops before opening a database when DATABASE_URL is missing", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync(
      "pnpm",
      ["exec", "tsx", "apps/api/src/cli/email-allowlist.ts", "list"],
      {
        cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
        env,
        encoding: "utf8",
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("DATABASE_URL is required");
    expect(result.stdout).not.toContain("@");
  });
});
