import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { rlsBypassKey } from "./row-security.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;

it.skipIf(
  !process.env.VERIFY_DATABASE || !runtimeUrl || !migrationUrl || runtimeUrl === migrationUrl,
)(
  "keeps account voice preferences private when a tenant sets the system flag without its key",
  async () => {
    const owner = new pg.Client({ connectionString: migrationUrl });
    const runtime = new pg.Client({ connectionString: runtimeUrl });
    const id = `voice-policy-${randomUUID()}`;
    await owner.connect();
    try {
      await runtime.connect();
      let role: string;
      try {
        role = (await runtime.query<{ name: string }>("SELECT current_user AS name")).rows[0]!.name;
      } finally {
        await runtime.end();
      }
      await owner.query("BEGIN");
      try {
        const existing = await owner.query(
          "SELECT to_regclass('public.user_realtime_voice_preferences') AS name",
        );
        if (!existing.rows[0].name) {
          await owner.query(
            await readFile(
              new URL(
                "../prisma/migrations/20261102213000_realtime_voice_preferences/migration.sql",
                import.meta.url,
              ),
              "utf8",
            ),
          );
        }
        await owner.query(
          await readFile(
            new URL(
              "../prisma/migrations/20261211140000_realtime_voice_policy/migration.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        await owner.query(
          `GRANT SELECT ON user_realtime_voice_preferences TO ${pg.escapeIdentifier(role)}`,
        );
        const key = rlsBypassKey(runtimeUrl);
        expect(key).not.toBe("");
        await owner.query(
          "SELECT set_config('app.rls_bypass', 'on', true), set_config('app.rls_bypass_key', $1, true)",
          [key],
        );
        await owner.query(
          'INSERT INTO "user" (id, name, email, "updatedAt") VALUES ($1, $1, $2, now())',
          [id, `${id}@example.test`],
        );
        await owner.query(
          'INSERT INTO user_model_credentials (id, "userId", provider, label, "secretId", "updatedAt") VALUES ($1, $1, $2, $2, $2, now())',
          [id, "fixture"],
        );
        await owner.query(
          'INSERT INTO user_realtime_voice_preferences ("userId", "credentialId", "updatedAt") VALUES ($1, $1, now())',
          [id],
        );
        await owner.query(`SET LOCAL ROLE ${pg.escapeIdentifier(role)}`);
        await owner.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.rls_bypass_key', 'wrong-fixture-key', true)",
          [`other-${id}`],
        );
        expect((await owner.query("SELECT app_rls_bypass() AS allowed")).rows[0].allowed).toBe(
          false,
        );
        const count = async () =>
          (
            await owner.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM user_realtime_voice_preferences WHERE "userId" = $1',
              [id],
            )
          ).rows[0]!.count;
        expect(await count()).toBe(0);
        await owner.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.rls_bypass', 'off', true)",
          [id],
        );
        expect(await count()).toBe(1);
        await owner.query(
          "SELECT set_config('app.user_id', $1, true), set_config('app.rls_bypass', 'on', true), set_config('app.rls_bypass_key', $2, true)",
          [`other-${id}`, key],
        );
        expect(await count()).toBe(1);
      } finally {
        await owner.query("ROLLBACK");
      }
    } finally {
      await owner.end();
    }
  },
);
