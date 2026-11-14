import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareLegacyMigrationBaseline } from "./legacy-migration-baseline.js";
import type { LegacyMigrationClient } from "./legacy-native-import.js";

const fixtures: string[] = [];
afterEach(async () => {
  for (const root of fixtures.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "vnbot-baseline-"));
  fixtures.push(root);
  const currentMigrations = path.join(root, "current"),
    destination = path.join(root, "baseline");
  const name = "20260101000000_common",
    sql = "CREATE TABLE preserved (id TEXT PRIMARY KEY);";
  await mkdir(path.join(currentMigrations, name), { recursive: true });
  await writeFile(path.join(currentMigrations, name, "migration.sql"), sql);
  await writeFile(path.join(currentMigrations, "migration_lock.toml"), 'provider = "postgresql"\n');
  const history = [
    { migration_name: name, checksum: createHash("sha256").update(sql).digest("hex") },
    { migration_name: "../../not-a-current-migration", checksum: "ignored" },
  ];
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValue({ rows: history });
  return {
    root,
    currentMigrations,
    destination,
    name,
    sql,
    history,
    source: { query } as unknown as LegacyMigrationClient,
  };
}
it("uses only current SQL with matching source checksums and safely repeats", async () => {
  const f = await fixture();
  expect(await prepareLegacyMigrationBaseline(f)).toBe(f.destination);
  const second = {
    ...f,
    source: {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValue({ rows: f.history }),
    } as unknown as LegacyMigrationClient,
  };
  await prepareLegacyMigrationBaseline(second);
  expect((await readdir(f.destination)).sort()).toEqual([f.name, "migration_lock.toml"].sort());
  expect(await readFile(path.join(f.destination, f.name, "migration.sql"), "utf8")).toBe(f.sql);
});
it("refuses a changed common migration before making a baseline", async () => {
  const f = await fixture();
  f.history[0]!.checksum = "wrong";
  await expect(prepareLegacyMigrationBaseline(f)).rejects.toThrow("checksum differs");
  await expect(readdir(f.destination)).rejects.toThrow();
});
it("keeps unrecognized output files", async () => {
  const f = await fixture();
  await mkdir(f.destination);
  await writeFile(path.join(f.destination, "keep.txt"), "user work");
  await expect(prepareLegacyMigrationBaseline(f)).rejects.toThrow("files were kept");
  expect(await readFile(path.join(f.destination, "keep.txt"), "utf8")).toBe("user work");
});
