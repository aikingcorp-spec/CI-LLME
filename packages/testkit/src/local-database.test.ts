import { expect, test } from "vitest";
import {
  assertSafeLocalDatabaseName,
  DEFAULT_LOCAL_DB_PREFIX,
  LocalDatabases,
  localDatabaseName,
  withDatabase,
} from "./cli/local-database.js";

test("names a run database from the UTC time and process id", () => {
  const now = new Date("2026-10-30T07:05:09.123Z");
  expect(localDatabaseName(DEFAULT_LOCAL_DB_PREFIX, now, 4242)).toBe("kai_e2e_20261030070509_4242");
  expect(localDatabaseName("pr9", now, 1)).toBe("pr9_20261030070509_1");
});

test("refuses protected and unsafe database names", () => {
  const now = new Date("2026-10-30T07:05:09Z");
  expect(() => assertSafeLocalDatabaseName("rakazo_e2e")).toThrow(/protected/);
  expect(() => assertSafeLocalDatabaseName("leo_main")).toThrow(/protected/);
  expect(() => localDatabaseName("leo_e2e", now, 1)).toThrow(/protected/);
  expect(() => assertSafeLocalDatabaseName('x"; DROP DATABASE postgres; --')).toThrow(/unsafe/);
  expect(() => assertSafeLocalDatabaseName("Upper")).toThrow(/unsafe/);
  expect(() => assertSafeLocalDatabaseName("a".repeat(64))).toThrow(/unsafe/);
});

test("points an admin URL at another database and keeps the login", () => {
  expect(withDatabase("postgresql://postgres@127.0.0.1:54329/postgres", "kai_e2e_1")).toBe(
    "postgresql://postgres@127.0.0.1:54329/kai_e2e_1",
  );
});

test("drops only databases this run created", async () => {
  const statements: string[] = [];
  const databases = new LocalDatabases(async (statement) => {
    statements.push(statement);
  });
  await databases.create("kai_e2e_1_1");
  await databases.create("kai_e2e_1_1_s0", "kai_e2e_1_1");
  expect(statements).toEqual([
    'CREATE DATABASE "kai_e2e_1_1"',
    'CREATE DATABASE "kai_e2e_1_1_s0" TEMPLATE "kai_e2e_1_1"',
  ]);

  await expect(databases.drop("postgres")).rejects.toThrow(/did not create/);
  await expect(databases.drop("rakazo_e2e")).rejects.toThrow(/protected/);
  await expect(databases.create("kai_e2e_1_1_s1", "rakazo_e2e")).rejects.toThrow(/did not create/);
  expect(statements).toHaveLength(2);

  await databases.dropAll();
  expect(statements.slice(2)).toEqual([
    'DROP DATABASE IF EXISTS "kai_e2e_1_1_s0" WITH (FORCE)',
    'DROP DATABASE IF EXISTS "kai_e2e_1_1" WITH (FORCE)',
  ]);
  expect(databases.created).toEqual([]);
});

test("keeps dropping after one drop fails and reports it", async () => {
  const dropped: string[] = [];
  const databases = new LocalDatabases(async (statement) => {
    if (statement.includes("_s0") && statement.startsWith("DROP")) throw new Error("busy");
    if (statement.startsWith("DROP")) dropped.push(statement);
  });
  await databases.create("kai_e2e_2_2");
  await databases.create("kai_e2e_2_2_s0", "kai_e2e_2_2");
  await expect(databases.dropAll()).rejects.toThrow("busy");
  expect(dropped).toEqual(['DROP DATABASE IF EXISTS "kai_e2e_2_2" WITH (FORCE)']);
});
