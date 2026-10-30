import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createMigrationClient,
  migrateNativeDatabase,
  nativeMigrationsDir,
  transactionalMigrationSql,
} from "./native-migrate.js";
import { NativePostgres, PG_BIN_DIR_ENV } from "./native-postgres.js";

describe("native migrations", () => {
  it("resolves migrations outside asar for packaged Windows and Linux", () => {
    expect(
      nativeMigrationsDir({
        packaged: true,
        resourcesPath: "C:\\App\\resources",
        appPath: "C:\\App",
        pathModule: path.win32,
      }),
    ).toBe("C:\\App\\resources\\migrations");
    expect(
      nativeMigrationsDir({
        packaged: false,
        resourcesPath: "",
        appPath: "/repo/apps/desktop",
        pathModule: path.posix,
      }),
    ).toBe("/repo/packages/db/prisma/migrations");
  });

  it("keeps procedural bodies while making local index migrations transactional", () => {
    expect(
      transactionalMigrationSql(
        "BEGIN;\nDO $$\nBEGIN\n  RAISE NOTICE 'x';\nEND $$;\nCOMMIT;\nCREATE UNIQUE INDEX CONCURRENTLY x ON t(id);",
      ),
    ).toContain("DO $$\nBEGIN\n  RAISE NOTICE 'x';\nEND $$;");
    const quoted = `SELECT 'COMMIT; CREATE INDEX CONCURRENTLY', "BEGIN";
DO $body$
BEGIN
  RAISE NOTICE 'CREATE INDEX CONCURRENTLY';
END $body$;
/* BEGIN; /* nested */ COMMIT; */`;
    expect(transactionalMigrationSql(quoted)).toBe(quoted);
    expect(transactionalMigrationSql("DROP INDEX CONCURRENTLY x;")).toMatch(/^DROP INDEX\s+x;$/);
  });

  it("rolls back a failed file and closes the connection", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-migration-unit-"));
    const query = vi.fn(async (sql: string) => {
      if (sql === "broken") throw new Error("private details");
      return { rows: [] };
    });
    const client = { connect: vi.fn(async () => {}), query, end: vi.fn(async () => {}) };
    try {
      await mkdir(path.join(dir, "001"));
      await writeFile(path.join(dir, "001", "migration.sql"), "broken");
      await expect(
        migrateNativeDatabase({
          databaseUrl: "unused",
          dbDir: "unused",
          migrationsDir: dir,
          client,
        }),
      ).rejects.toThrow("A local database migration failed.");
      expect(query.mock.calls.map(([sql]) => sql).slice(-3)).toEqual([
        "BEGIN",
        "broken",
        "ROLLBACK",
      ]);
      expect(client.end).toHaveBeenCalledOnce();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it.runIf(
  Boolean(process.env[PG_BIN_DIR_ENV]) && process.platform === "linux" && process.getuid?.() !== 0,
)(
  "records original checksums, is idempotent, rejects drift and rolls back real SQL atomically",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-migrate-real-"));
    const pg = new NativePostgres({ userDataDir: root });
    const dbDir = path.resolve("packages/db");
    let client: ReturnType<typeof createMigrationClient> | undefined;
    try {
      const { migrationUrl } = await pg.start();
      const migrationsDir = path.join(root, "migrations");
      const first = path.join(migrationsDir, "001");
      await mkdir(first, { recursive: true });
      const source =
        "BEGIN;\nCREATE TABLE atomic_test (id int);\nCOMMIT;\nCREATE INDEX CONCURRENTLY test_idx ON atomic_test(id);";
      await writeFile(path.join(first, "migration.sql"), source);
      const input = { databaseUrl: migrationUrl, dbDir, migrationsDir };
      await migrateNativeDatabase(input);
      await migrateNativeDatabase(input);
      client = createMigrationClient(migrationUrl, dbDir);
      await client.connect();
      const { rows } = await client.query('SELECT * FROM "_prisma_migrations"');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        checksum: createHash("sha256").update(source).digest("hex"),
        applied_steps_count: 1,
        migration_name: "001",
      });
      expect(rows[0]!.finished_at).toBeTruthy();
      await writeFile(path.join(first, "migration.sql"), `${source}\n-- drift`);
      await expect(migrateNativeDatabase(input)).rejects.toThrow("history does not match");
      await writeFile(path.join(first, "migration.sql"), source);
      await mkdir(path.join(migrationsDir, "002"));
      await writeFile(
        path.join(migrationsDir, "002", "migration.sql"),
        "BEGIN;\nCREATE TABLE rollback_test(id int);\nCOMMIT;\nSELECT does_not_exist;",
      );
      await expect(migrateNativeDatabase(input)).rejects.toThrow(
        "A local database migration failed.",
      );
      expect(
        (await client.query("SELECT to_regclass('rollback_test') AS name")).rows[0]!.name,
      ).toBeNull();
      expect((await client.query('SELECT * FROM "_prisma_migrations"')).rows).toHaveLength(1);
    } finally {
      await client?.end();
      await pg.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
