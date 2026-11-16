import { addAllowlistEmail, lookupEdition, removeAllowlistEmail } from "@rakazo/auth";
import type { RemoteAccessProvider } from "@rakazo/core";
import { createDb, listRemoteHosts, runAsSystem } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actSignedRemoteHost } from "./remote-registry-server.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("free and team editions on PostgreSQL (runtime login)", () => {
  const suffix = `edition-${process.pid}-${Date.now()}`;
  const free = `${suffix}-free`;
  const team = `${suffix}-team`;
  let db: ReturnType<typeof createDb>;
  const provisioned: string[] = [];
  const provider: RemoteAccessProvider = {
    async provision(input) {
      provisioned.push(input.deviceId);
      return { objectId: `object-${input.deviceId}` };
    },
    async release() {},
  };

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    await runAsSystem("edition fixtures", async () => {
      for (const id of [free, team])
        await db.prisma.user.create({
          data: { id, name: id, email: `${id}@example.test`, emailVerified: true },
        });
      await addAllowlistEmail(db.prisma, `${free}@example.test`, { edition: "free" });
      await addAllowlistEmail(db.prisma, `${team}@example.test`);
    });
  });

  afterAll(async () => {
    await runAsSystem("remove edition fixtures", async () => {
      await db.prisma.remoteHost.deleteMany({ where: { accountId: { in: [free, team] } } });
      await db.prisma.user.deleteMany({ where: { id: { in: [free, team] } } });
      await db.prisma.authEmailAllowlist.deleteMany({
        where: { email: { contains: suffix } },
      });
    });
    await db?.prisma.$disconnect();
    await db?.pool.end();
  });

  it("lists existing addresses as team and moves one without an UPDATE grant", async () => {
    expect(await lookupEdition(db.prisma, `${team}@example.test`)).toBe("team");
    expect(await lookupEdition(db.prisma, `${free}@example.test`)).toBe("free");
    const moved = `${suffix}-moved@example.test`;
    await runAsSystem("move an address", async () => {
      await addAllowlistEmail(db.prisma, moved, { note: "kept" });
      expect(await addAllowlistEmail(db.prisma, moved, { edition: "free" })).toEqual({
        email: moved,
        created: false,
        changed: true,
      });
      const row = await db.prisma.authEmailAllowlist.findUnique({ where: { email: moved } });
      expect(row).toMatchObject({ edition: "free", note: "kept" });
      await removeAllowlistEmail(db.prisma, moved);
    });
  });

  it("refuses an edition the product does not have", async () => {
    await expect(
      runAsSystem("bad edition", () =>
        db.prisma.authEmailAllowlist.create({
          data: { email: `${suffix}-bad@example.test`, edition: "gold" },
        }),
      ),
    ).rejects.toThrow(/auth_email_allowlist_edition/);
  });

  it("never offers remote access to a free account's computer", async () => {
    const act = (accountId: string, request: Record<string, unknown>) =>
      runAsSystem("signed remote host", () =>
        actSignedRemoteHost({
          prisma: db.prisma,
          provider,
          tokens: { get: () => "connector-token" },
          signed: { accountId, deviceId: `${accountId}-computer`, request } as never,
          included: async (id) => (await lookupEdition(db.prisma, `${id}@example.test`)) === "team",
        }),
      );
    const present = await act(free, { action: "present" });
    expect(present).toEqual({ body: { portal: { kind: "unavailable", devices: [] } } });
    const set = await act(free, { action: "set", enabled: true, confirmed: true });
    expect(set.body).toMatchObject({ kind: "conflict", changed: false });
    expect(set.connectorToken).toBeUndefined();
    const listed = await runAsSystem("list", () =>
      listRemoteHosts(db.prisma, provider, { accountId: free, now: new Date() }),
    );
    expect(listed.devices).toEqual([]);
    expect(provisioned).toEqual([]);

    const teamPresent = await act(team, { action: "present" });
    expect((teamPresent.body.portal as { devices: unknown[] }).devices).toHaveLength(1);
  });
});
