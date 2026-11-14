import { createHash } from "node:crypto";
import type { Client } from "pg";
import pg from "pg";

export type LegacyMigrationClient = Pick<Client, "query">;
type Row = Record<string, unknown>;
type Column = { name: string; type: string };
type TableReceipt = { count: number; sha256: string };
type ImportReceipt = Record<string, TableReceipt>;
export type LegacyNativeRowTransform = (table: string, row: Row) => Promise<Row | null>;
const RECEIPT_TABLE = "_native_legacy_import";
const quote = pg.escapeIdentifier;

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString("base64"));
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
async function tables(client: LegacyMigrationClient): Promise<string[]> {
  return (
    await client.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows
    .map((row) => row.name)
    .filter(
      (name) => !["_prisma_migrations", "_deferred_migrations", RECEIPT_TABLE].includes(name),
    );
}
async function columns(client: LegacyMigrationClient, table: string): Promise<Column[]> {
  return (
    await client.query<Column>(
      "SELECT column_name AS name,data_type AS type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
      [table],
    )
  ).rows;
}
async function scan(
  client: LegacyMigrationClient,
  table: string,
  visit: (row: Row) => Promise<void>,
) {
  await client.query(
    `DECLARE legacy_import_rows NO SCROLL CURSOR FOR SELECT * FROM ${quote(table)} ORDER BY to_jsonb(${quote(table)})::text`,
  );
  try {
    while (true) {
      const batch = await client.query<Row>("FETCH 128 FROM legacy_import_rows");
      if (!batch.rowCount) break;
      for (const row of batch.rows) await visit(row);
    }
  } finally {
    await client.query("CLOSE legacy_import_rows");
  }
}
async function receipt(client: LegacyMigrationClient, table: string): Promise<TableReceipt> {
  const hash = createHash("sha256");
  let count = 0;
  await scan(client, table, async (row) => {
    hash.update(canonical(row));
    hash.update("\n");
    count++;
  });
  return { count, sha256: hash.digest("hex") };
}
async function verifyForeignKeys(client: LegacyMigrationClient) {
  const result = await client.query<{
    table: string;
    referenced: string;
    columns: string[];
    targets: string[];
  }>(`
    SELECT child.relname AS "table", parent.relname AS referenced,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.o) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.o) AS targets
    FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid WHERE c.contype='f' AND n.nspname='public'`);
  for (const fk of result.rows) {
    const table = fk.table;
    const referenced = fk.referenced;
    const matches = fk.columns
      .map((column, index) => `child.${quote(column)}=parent.${quote(fk.targets[index]!)}`)
      .join(" AND ");
    const supplied = fk.columns.map((column) => `child.${quote(column)} IS NOT NULL`).join(" AND ");
    const invalid = await client.query(
      `SELECT 1 FROM ${quote(table)} child WHERE ${supplied} AND NOT EXISTS(SELECT 1 FROM ${quote(referenced)} parent WHERE ${matches}) LIMIT 1`,
    );
    if (invalid.rowCount) throw new Error("Legacy import has an unresolved foreign key.");
  }
}

/** Imports into a fresh current schema. Every copied row and foreign key is verified before commit. */
export async function importLegacyNativeDatabase(input: {
  source: LegacyMigrationClient;
  destination: LegacyMigrationClient;
  sourceDigest: string;
  transform: LegacyNativeRowTransform;
  signal: AbortSignal;
}): Promise<"imported" | "existing"> {
  if (!/^[a-f0-9]{64}$/.test(input.sourceDigest)) throw new Error("Invalid legacy source digest.");
  const { source, destination, signal } = input;
  signal.throwIfAborted();
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const queue = (
      await source.query<{ exists: boolean }>(
        "SELECT to_regclass('graphile_worker._private_jobs') IS NOT NULL AS exists",
      )
    ).rows[0]?.exists;
    if (
      queue &&
      (await source.query("SELECT 1 FROM graphile_worker._private_jobs LIMIT 1")).rowCount
    )
      throw new Error("Pending legacy jobs need a verified queue migration.");
    await destination.query("BEGIN");
    try {
      await destination.query("SELECT pg_advisory_xact_lock(hashtext('native-legacy-import'))");
      await destination.query(
        `CREATE TABLE IF NOT EXISTS ${quote(RECEIPT_TABLE)} (source_digest TEXT PRIMARY KEY, tables JSONB NOT NULL, source_tables JSONB NOT NULL, verified_at TIMESTAMPTZ, imported_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
      );
      const saved = (
        await destination.query<{
          source_digest: string;
          tables: ImportReceipt;
          source_tables: ImportReceipt;
        }>(`SELECT source_digest,tables,source_tables FROM ${quote(RECEIPT_TABLE)}`)
      ).rows;
      if (saved.length) {
        if (saved.length !== 1 || saved[0]!.source_digest !== input.sourceDigest)
          throw new Error("Destination belongs to a different legacy import.");
        const expected = saved[0]!.tables;
        const destinationTables = await tables(destination);
        if (
          !expected ||
          Array.isArray(expected) ||
          canonical(Object.keys(expected).sort()) !== canonical([...destinationTables].sort())
        )
          throw new Error("Incomplete legacy import receipt.");
        const currentSource: ImportReceipt = {};
        for (const table of await tables(source))
          currentSource[table] = await receipt(source, table);
        if (canonical(currentSource) !== canonical(saved[0]!.source_tables))
          throw new Error("Legacy source rows changed since import.");
        for (const table of destinationTables) {
          const actual = await receipt(destination, table);
          if (
            canonical(actual) !==
            canonical(expected[table] ?? { count: 0, sha256: createHash("sha256").digest("hex") })
          )
            throw new Error("Imported destination changed; existing data was kept.");
        }
        await destination.query("COMMIT");
        return "existing";
      }
      const destinationTables = new Set(await tables(destination));
      for (const table of destinationTables)
        if ((await destination.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`)).rowCount)
          throw new Error("Legacy import requires an empty destination; existing data was kept.");
      const sourceTables: ImportReceipt = {};
      for (const table of await tables(source)) sourceTables[table] = await receipt(source, table);
      await destination.query("SET LOCAL session_replication_role=replica");
      for (const table of await tables(source)) {
        signal.throwIfAborted();
        const targetColumns = destinationTables.has(table) ? await columns(destination, table) : [];
        const names = new Set(targetColumns.map((column) => column.name));
        await scan(source, table, async (original) => {
          signal.throwIfAborted();
          const row = await input.transform(table, original);
          if (row === null) return;
          if (!targetColumns.length)
            throw new Error(`Nonempty legacy table has no current mapping: ${table}`);
          for (const key of Object.keys(row))
            if (!names.has(key) && row[key] !== null && row[key] !== undefined)
              throw new Error(`Legacy column has no current mapping: ${table}.${key}`);
          const selected = targetColumns.filter((column) => Object.hasOwn(row, column.name));
          const values = selected.map((column) =>
            column.type === "json" || column.type === "jsonb"
              ? JSON.stringify(row[column.name])
              : row[column.name],
          );
          const written = await destination.query<Row>(
            `INSERT INTO ${quote(table)} (${selected.map((column) => quote(column.name)).join(",")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")}) RETURNING ${selected.map((column) => quote(column.name)).join(",")}`,
            values,
          );
          const expected = Object.fromEntries(
            selected.map((column) => [column.name, row[column.name]]),
          );
          if (canonical(written.rows[0]) !== canonical(expected))
            throw new Error("Legacy row did not round-trip.");
        });
      }
      await destination.query("SET LOCAL session_replication_role=origin");
      await verifyForeignKeys(destination);
      const imported: ImportReceipt = {};
      for (const table of destinationTables) imported[table] = await receipt(destination, table);
      await destination.query(
        `INSERT INTO ${quote(RECEIPT_TABLE)}(source_digest,tables,source_tables) VALUES($1,$2,$3)`,
        [input.sourceDigest, JSON.stringify(imported), JSON.stringify(sourceTables)],
      );
      signal.throwIfAborted();
      await destination.query("COMMIT");
      return "imported";
    } catch (error) {
      await destination.query("ROLLBACK");
      throw error;
    }
  } finally {
    await source.query("ROLLBACK");
  }
}

/** A baseline receipt permits resuming our migrations, never replacing an unrelated current database. */
export async function legacyNativeImportState(
  source: LegacyMigrationClient,
  destination: LegacyMigrationClient,
  sourceDigest: string,
): Promise<"empty" | "baseline" | "verified"> {
  const exists = (
    await destination.query<{ exists: boolean }>(
      "SELECT to_regclass('_native_legacy_import') IS NOT NULL AS exists",
    )
  ).rows[0]?.exists;
  if (!exists) return "empty";
  await destination.query(
    `ALTER TABLE ${quote(RECEIPT_TABLE)} ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`,
  );
  const rows = (
    await destination.query<{
      source_digest: string;
      source_tables: ImportReceipt;
      verified_at: Date | null;
    }>(`SELECT source_digest,source_tables,verified_at FROM ${quote(RECEIPT_TABLE)}`)
  ).rows;
  if (rows.length !== 1 || rows[0]!.source_digest !== sourceDigest)
    throw new Error("Destination belongs to a different legacy import.");
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const current: ImportReceipt = {};
    for (const table of await tables(source)) current[table] = await receipt(source, table);
    if (canonical(current) !== canonical(rows[0]!.source_tables))
      throw new Error("Legacy source rows changed since import.");
  } finally {
    await source.query("ROLLBACK");
  }
  return rows[0]!.verified_at ? "verified" : "baseline";
}

export async function markLegacyNativeImportVerified(
  destination: LegacyMigrationClient,
  sourceDigest: string,
): Promise<void> {
  const result = await destination.query(
    `UPDATE ${quote(RECEIPT_TABLE)} SET verified_at=COALESCE(verified_at,now()) WHERE source_digest=$1`,
    [sourceDigest],
  );
  if (result.rowCount !== 1) throw new Error("Legacy import receipt is missing.");
}
