import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { migrationPrismaCli } from "./deferred-migrations.js";

it("runs the installed Prisma CLI outside the workspace without pnpm on PATH", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "migration-cli-"));
  try {
    const cli = migrationPrismaCli(fileURLToPath(new URL("../", import.meta.url)));
    const output = execFileSync(process.execPath, [cli, "--version"], {
      cwd,
      env: { ...process.env, PATH: "", RAKAZO_LOAD_ROOT_ENV: "false", CHECKPOINT_DISABLE: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(output).toMatch(/prisma\s*:\s*7\./);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
