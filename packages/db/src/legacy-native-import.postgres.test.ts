import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { importLegacyNativeDatabase } from "./legacy-native-import.js";

const databaseUrl = process.env.DATABASE_URL;
const verify = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
verify("copy-only native database import", () => {
  const clients: Client[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((client) => client.end()));
  });
  async function fixture() {
    const admin = new Client(databaseUrl);
    await admin.connect();
    clients.push(admin);
    const suffix = randomBytes(8).toString("hex");
    const sourceName = `legacy_source_${suffix}`,
      targetName = `legacy_target_${suffix}`;
    for (const name of [sourceName, targetName]) await admin.query(`CREATE DATABASE ${name}`);
    const connect = async (name: string) => {
      const url = new URL(databaseUrl!);
      url.pathname = `/${name}`;
      const client = new Client(url.toString());
      await client.connect();
      clients.push(client);
      return client;
    };
    const source = await connect(sourceName),
      destination = await connect(targetName);
    for (const client of [source, destination])
      await client.query(
        "CREATE TABLE z_parent(id TEXT PRIMARY KEY); CREATE TABLE a_child(id TEXT PRIMARY KEY,parent_id TEXT NOT NULL REFERENCES z_parent(id),payload JSONB NOT NULL)",
      );
    await source.query(
      "INSERT INTO z_parent VALUES ('parent'); INSERT INTO a_child VALUES ('child','parent','{\"text\":\"preserved\"}')",
    );
    const input = {
      source,
      destination,
      sourceDigest: "ab".repeat(32),
      transform: async (_table: string, row: Record<string, unknown>) => row,
      signal: new AbortController().signal,
    };
    return { source, destination, input };
  }
  it("copies rows before their referenced table, checks constraints and verifies a repeat", async () => {
    const f = await fixture();
    expect(await importLegacyNativeDatabase(f.input)).toBe("imported");
    expect(await importLegacyNativeDatabase(f.input)).toBe("existing");
    expect((await f.destination.query("SELECT * FROM a_child")).rows).toEqual([
      { id: "child", parent_id: "parent", payload: { text: "preserved" } },
    ]);
    expect((await f.source.query("SELECT * FROM a_child")).rows).toEqual([
      { id: "child", parent_id: "parent", payload: { text: "preserved" } },
    ]);
  });
  it("keeps current data when an imported target has changed", async () => {
    const f = await fixture();
    await importLegacyNativeDatabase(f.input);
    await f.destination.query('UPDATE a_child SET payload=\'{"text":"current user work"}\'');
    await expect(importLegacyNativeDatabase(f.input)).rejects.toThrow("destination changed");
    expect((await f.destination.query("SELECT payload FROM a_child")).rows[0]?.payload).toEqual({
      text: "current user work",
    });
  });
  it("rolls back an unmapped nonempty column instead of dropping it", async () => {
    const f = await fixture();
    await f.source.query("ALTER TABLE a_child ADD COLUMN missing TEXT DEFAULT 'must keep'");
    await expect(importLegacyNativeDatabase(f.input)).rejects.toThrow("no current mapping");
    expect((await f.destination.query("SELECT * FROM a_child")).rowCount).toBe(0);
    expect((await f.source.query("SELECT missing FROM a_child")).rows[0]?.missing).toBe(
      "must keep",
    );
  });
  it("checks newly required foreign keys before committing", async () => {
    const f = await fixture();
    await f.source.query(
      "ALTER TABLE a_child DROP CONSTRAINT a_child_parent_id_fkey; UPDATE a_child SET parent_id='missing'",
    );
    await expect(importLegacyNativeDatabase(f.input)).rejects.toThrow("unresolved foreign key");
    expect((await f.destination.query("SELECT * FROM a_child")).rowCount).toBe(0);
    expect((await f.destination.query("SELECT * FROM z_parent")).rowCount).toBe(0);
  });
  it("retries after an interrupted transformation without duplicating rows", async () => {
    const f = await fixture();
    await expect(
      importLegacyNativeDatabase({
        ...f.input,
        transform: async () => {
          throw new Error("interrupted");
        },
      }),
    ).rejects.toThrow("interrupted");
    expect((await f.destination.query("SELECT * FROM a_child")).rowCount).toBe(0);
    expect(await importLegacyNativeDatabase(f.input)).toBe("imported");
    expect((await f.destination.query("SELECT * FROM a_child")).rowCount).toBe(1);
  });
  it("refuses a nonempty current database without replacing its rows", async () => {
    const f = await fixture();
    await f.destination.query("INSERT INTO z_parent VALUES ('current')");
    await expect(importLegacyNativeDatabase(f.input)).rejects.toThrow("empty destination");
    expect((await f.destination.query("SELECT * FROM z_parent")).rows).toEqual([{ id: "current" }]);
  });
});
