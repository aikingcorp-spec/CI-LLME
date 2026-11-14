import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LegacyMigrationClient } from "./legacy-native-import.js";

/** Selects only current migration SQL whose checksum matches the stopped source's history. */
export async function prepareLegacyMigrationBaseline(input: {
  source: LegacyMigrationClient;
  currentMigrations: string;
  destination: string;
}): Promise<string> {
  const unfinished = await input.source.query(
    "SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL LIMIT 1",
  );
  if (unfinished.rowCount) throw new Error("Legacy migration history is incomplete.");
  const history = (
    await input.source.query<{ migration_name: string; checksum: string }>(
      "SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL",
    )
  ).rows;
  const current = await readdir(input.currentMigrations, { withFileTypes: true });
  const names = new Set(current.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const selected: Array<{ name: string; sql: Buffer }> = [];
  for (const row of history) {
    if (!names.has(row.migration_name)) continue;
    const file = path.join(input.currentMigrations, row.migration_name, "migration.sql");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid current migration file.");
    const sql = await readFile(file);
    if (createHash("sha256").update(sql).digest("hex") !== row.checksum)
      throw new Error("Legacy migration checksum differs from current source.");
    selected.push({ name: row.migration_name, sql });
  }
  if (!selected.length) throw new Error("Legacy migration history is not recognized.");
  await mkdir(input.destination, { recursive: true, mode: 0o700 });
  if ((await lstat(input.destination)).isSymbolicLink())
    throw new Error("Invalid migration baseline directory.");
  const expected = new Set([...selected.map((row) => row.name), "migration_lock.toml"]);
  for (const entry of await readdir(input.destination))
    if (!expected.has(entry)) throw new Error("Unrecognized migration baseline files were kept.");
  async function save(file: string, body: Buffer) {
    try {
      await writeFile(file, body, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || !body.equals(await readFile(file)))
        throw new Error("Existing migration baseline differs; files were kept.");
    }
  }
  for (const row of selected) {
    const directory = path.join(input.destination, row.name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink())
      throw new Error("Invalid migration baseline directory.");
    await save(path.join(directory, "migration.sql"), row.sql);
  }
  await save(
    path.join(input.destination, "migration_lock.toml"),
    await readFile(path.join(input.currentMigrations, "migration_lock.toml")),
  );
  return input.destination;
}
