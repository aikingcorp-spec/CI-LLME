import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire as createModuleRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface MigrationClient {
  connect(): Promise<unknown>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
}

export function createMigrationClient(databaseUrl: string, dbDir: string): MigrationClient {
  const { Client } = createModuleRequire(path.join(dbDir, "package.json"))("pg");
  return new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
}

export function nativeMigrationsDir(input: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  pathModule?: typeof path;
}): string {
  const p = input.pathModule ?? path;
  return input.packaged
    ? p.join(input.resourcesPath, "migrations")
    : p.resolve(input.appPath, "..", "..", "packages", "db", "prisma", "migrations");
}

/** Local startup has no live clients: indexes can be built synchronously in a transaction.
 * Only standalone transaction delimiters are removed; PL/pgSQL bodies stay intact.
 */
export function transactionalMigrationSql(sql: string): string {
  // Tokens omit comments and quoted bodies, so procedural SQL and literals are opaque.
  const tokens: Array<{ word: string; start: number; end: number }> = [];
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i]!)) {
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    const start = i;
    const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      i = end < 0 ? sql.length : end + dollar.length;
      tokens.push({ word: "quoted", start, end: i });
      continue;
    }
    const quote = sql[i];
    if (quote === "'" || quote === '"') {
      const escaped =
        quote === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/[A-Za-z_0-9]/.test(sql[i - 2] ?? "");
      i++;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") i += 2;
        else if (sql[i++] === quote) {
          if (sql[i] === quote) i++;
          else break;
        }
      }
      tokens.push({ word: "quoted", start, end: i });
      continue;
    }
    const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/)?.[0] ?? sql[i]!;
    i += word.length;
    tokens.push({ word: word.toUpperCase(), start, end: i });
  }
  const removed: Array<{ start: number; end: number }> = [];
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]!;
    const previous = tokens[t - 1]?.word;
    const atStart = t === 0 || previous === ";";
    if (
      atStart &&
      (token.word === "BEGIN" || token.word === "COMMIT") &&
      tokens[t + 1]?.word === ";"
    ) {
      removed.push({ start: token.start, end: tokens[t + 1]!.end });
    }
    if (token.word === "CONCURRENTLY" && previous === "INDEX") {
      const ddl = tokens[t - 2]?.word;
      if (
        ddl === "CREATE" ||
        ddl === "DROP" ||
        (ddl === "UNIQUE" && tokens[t - 3]?.word === "CREATE")
      ) {
        removed.push(token);
      }
    }
  }
  for (const range of removed.sort((a, b) => b.start - a.start))
    sql = sql.slice(0, range.start) + sql.slice(range.end);
  return sql;
}

export async function migrateNativeDatabase(input: {
  databaseUrl: string;
  dbDir: string;
  migrationsDir: string;
  client?: MigrationClient;
}): Promise<void> {
  const client = input.client ?? createMigrationClient(input.databaseUrl, input.dbDir);
  try {
    await client.connect();
    // Same advisory lock used by Prisma; a second startup must wait for this one.
    await client.query("SELECT pg_advisory_lock(72707369)");
    await client.query(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      id VARCHAR(36) PRIMARY KEY, checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ, migration_name VARCHAR(255) NOT NULL, logs TEXT,
      rolled_back_at TIMESTAMPTZ, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )`);
    const directories = (await readdir(input.migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of directories) {
      const source = await readFile(path.join(input.migrationsDir, name, "migration.sql"));
      const checksum = createHash("sha256").update(source).digest("hex");
      const { rows } = await client.query(
        'SELECT checksum, finished_at FROM "_prisma_migrations" WHERE migration_name = $1 AND rolled_back_at IS NULL',
        [name],
      );
      if (rows.length) {
        if (rows.some((row) => !row.finished_at || row.checksum !== checksum)) {
          throw new Error("Local database migration history does not match the app.");
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(transactionalMigrationSql(source.toString("utf8")));
        await client.query(
          `INSERT INTO "_prisma_migrations"
          (id, checksum, migration_name, finished_at, applied_steps_count)
          VALUES ($1, $2, $3, now(), 1)`,
          [randomUUID(), checksum, name],
        );
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK");
        throw new Error("A local database migration failed.");
      }
    }
  } finally {
    // Closing the session releases its advisory lock even after a failure.
    await client.end();
  }
}

/** Uses the existing queue dependency at its composition boundary, without loading providers. */
export async function migrateNativeJobQueue(databaseUrl: string, dbDir: string): Promise<void> {
  const { makeWorkerUtils } = createModuleRequire(
    path.resolve(dbDir, "..", "adapters", "package.json"),
  )("graphile-worker");
  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  try {
    await utils.migrate();
  } finally {
    await utils.release();
  }
}

/** Installed resources supply compiled shared DB code; dev uses Node's TypeScript loader.
 * A computed URL keeps this runtime resource outside the desktop bundle and type graph.
 */
export async function provisionNativeRuntimeRole(
  migrationUrl: string,
  runtimeUrl: string,
  dbDir: string,
): Promise<void> {
  const compiled = path.join(dbDir, "dist", "database-access.js");
  const entry = existsSync(compiled) ? compiled : path.join(dbDir, "src", "database-access.ts");
  const { provisionRuntimeRole } = await import(pathToFileURL(entry).href);
  await provisionRuntimeRole(migrationUrl, runtimeUrl);
}
