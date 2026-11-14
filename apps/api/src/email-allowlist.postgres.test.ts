import { randomUUID } from "node:crypto";
import {
  addAllowlistEmail,
  CLIENT_IP_HEADER,
  createAuth,
  removeAllowlistEmail,
} from "@rakazo/auth";
import { createDb, createPool, rlsBypassKey, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("invite list on PostgreSQL (runtime login)", () => {
  const suffix = randomUUID().slice(0, 8);
  const invited = `rls-${suffix}@example.test`;
  let pool: ReturnType<typeof createPool>;
  let db: ReturnType<typeof createDb>;

  // One connection per call; the bypass is set for that transaction only.
  const sql = async (bypass: boolean, text: string, values: unknown[] = []) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (bypass)
        await client.query(
          "SELECT set_config('app.rls_bypass', 'on', true), set_config('app.rls_bypass_key', $1, true)",
          [rlsBypassKey(databaseUrl!)],
        );
      const result = await client.query(text, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    db = createDb(databaseUrl!);
    expect((await pool.query("SELECT current_user AS who")).rows[0].who).toBe("rakazo_app");
    await sql(true, 'INSERT INTO "auth_email_allowlist" ("email") VALUES ($1)', [invited]);
  });

  afterAll(async () => {
    await sql(true, 'DELETE FROM "auth_email_allowlist" WHERE "email" LIKE $1', [`%${suffix}%`]);
    await db?.prisma.$disconnect();
    await db?.pool.end();
    await pool?.end();
  });

  it("hides every row and refuses inserts without the system bypass", async () => {
    expect((await sql(false, 'SELECT "email" FROM "auth_email_allowlist"')).rows).toEqual([]);
    await expect(
      sql(false, 'INSERT INTO "auth_email_allowlist" ("email") VALUES ($1)', [
        `sneak-${suffix}@example.test`,
      ]),
    ).rejects.toThrow(/row-level security/);
    expect(
      (await sql(true, 'SELECT "email" FROM "auth_email_allowlist" WHERE "email" = $1', [invited]))
        .rows,
    ).toEqual([{ email: invited }]);
  });

  it("forces the policy and gives the runtime login no UPDATE grant", async () => {
    const table = await sql(
      false,
      `SELECT relrowsecurity, relforcerowsecurity,
              has_table_privilege('rakazo_app', oid, 'UPDATE') AS can_update
         FROM pg_class WHERE relname = 'auth_email_allowlist'`,
    );
    expect(table.rows[0]).toEqual({
      relrowsecurity: true,
      relforcerowsecurity: true,
      can_update: false,
    });
    await expect(
      sql(true, 'UPDATE "auth_email_allowlist" SET "note" = $1 WHERE "email" = $2', ["x", invited]),
    ).rejects.toThrow(/permission denied/);
  });

  it.each([
    ` Pad-${suffix}@example.test`,
    `Upper-${suffix}@Example.test`,
    `zw-${suffix}\u200b@example.test`,
    "no-at-sign",
  ])("rejects the un-normalized address %j at the database", async (email) => {
    await expect(
      sql(true, 'INSERT INTO "auth_email_allowlist" ("email") VALUES ($1)', [email]),
    ).rejects.toThrow(/auth_email_allowlist_email_normalized/);
  });

  it("removing an invite deletes that account's sessions in the same transaction", async () => {
    const email = `gone-${suffix}@example.test`;
    const userId = `user-${suffix}`;
    await runAsSystem("fixture", async () => {
      await addAllowlistEmail(db.prisma, ` Gone-${suffix}@Example.test`, { addedBy: "test" });
      await db.prisma.user.create({
        data: { id: userId, email, name: "Gone", emailVerified: true },
      });
      await db.prisma.session.createMany({
        data: [1, 2].map((n) => ({
          id: `session-${suffix}-${n}`,
          token: `token-${suffix}-${n}`,
          userId,
          expiresAt: new Date(Date.now() + 3_600_000),
        })),
      });
    });
    const result = await runAsSystem("remove invite", () =>
      removeAllowlistEmail(db.prisma, `GONE-${suffix}@example.test`),
    );
    expect(result).toEqual({ email, removed: true, sessionsRevoked: 2 });
    await runAsSystem("check", async () => {
      expect(await db.prisma.session.count({ where: { userId } })).toBe(0);
      expect(await db.prisma.authEmailAllowlist.findUnique({ where: { email } })).toBeNull();
      await db.prisma.user.delete({ where: { id: userId } });
    });
  });
  it("refuses an uninvited code before mail and sends one to an invited address", async () => {
    const sent: unknown[] = [];
    const origin = "http://127.0.0.1:5180";
    const auth = createAuth(db.prisma, {
      secret: "invite-list-test-secret-with-over-32-characters",
      baseURL: origin,
      webOrigin: origin,
      signupsEnabled: "true",
      signupAllowlist: "",
      emailAllowlist: true,
      email: {
        describe: () => ({
          id: "offline-email",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { transactional: true },
        }),
        send: async (message) => {
          sent.push(message);
        },
      },
    });
    const send = (email: string) =>
      auth.handler(
        new Request(`${origin}/api/auth/email-otp/send-verification-otp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin,
            [CLIENT_IP_HEADER]: "203.0.113.9",
          },
          body: JSON.stringify({ email, type: "sign-in" }),
        }),
      );
    const refused = await send(`stranger-${suffix}@example.test`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "EMAIL_NOT_INVITED" });
    expect(sent).toHaveLength(0);
    expect((await send(` ${invited.toUpperCase()}`)).status).toBe(200);
    await expect.poll(() => sent.length).toBe(1);
  });
});
