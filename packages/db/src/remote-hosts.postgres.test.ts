import type { RemoteAccessProvider } from "@rakazo/core";
import { remoteSeatPolicy } from "@rakazo/core";
import { afterAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  findRemoteHostByKey,
  listRemoteHosts,
  noteRemoteHeartbeat,
  recordRemoteHostMember,
  registerRemoteHost,
  remoteHostEntrance,
  revokeRemoteHostMember,
  setRemoteHost,
} from "./remote-hosts.js";
import { runAsSystem } from "./row-security.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

function recorder() {
  const calls: string[] = [];
  const provider: RemoteAccessProvider = {
    async provision(input) {
      const objectId = `object-${calls.length + 1}`;
      calls.push(`provision:${input.deviceId}:${input.logicalHost}`);
      return { objectId };
    },
    async release(input) {
      calls.push(`release:${input.objectId}`);
    },
  };
  return { calls, provider };
}

describePostgres("remote hosts (PostgreSQL)", () => {
  const suffix = `remote-${process.pid}-${Date.now()}`;
  const accountA = `${suffix}-a`;
  const accountB = `${suffix}-b`;
  const now = new Date("2026-11-11T00:00:00.000Z");
  let prisma: PrismaClient;
  let close: () => Promise<void>;

  afterAll(async () => close?.());

  it("keeps remote off at registration and provisions only the granted seat", async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    close = async () => {
      await runAsSystem("remove remote host fixtures", async () => {
        await prisma.remoteHost.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
        await prisma.user.deleteMany({ where: { id: { in: [accountA, accountB] } } });
      });
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await runAsSystem("create remote host fixture accounts", async () => {
      await prisma.user.create({
        data: { id: accountA, name: "A", email: `${accountA}@example.test` },
      });
      await prisma.user.create({
        data: { id: accountB, name: "B", email: `${accountB}@example.test` },
      });
    });
    const access = recorder();
    const registered = await registerRemoteHost(prisma, {
      accountId: accountA,
      deviceId: `${suffix}-computer-a`,
      now,
    });
    expect(registered).toMatchObject({ kind: "registered", changed: true });
    expect(registered.portal).toMatchObject({ kind: "unavailable" });
    expect(registered.portal.devices[0]).toMatchObject({
      remoteEnabled: false,
      state: "off",
    });
    expect(access.calls).toEqual([]);
    const again = await registerRemoteHost(prisma, {
      accountId: accountA,
      deviceId: `${suffix}-computer-a`,
      now,
    });
    expect(again).toMatchObject({ kind: "registered", changed: false });
    expect(again.portal.devices[0]?.logicalHost).toBe(registered.portal.devices[0]?.logicalHost);

    const enabled = await setRemoteHost(prisma, access.provider, remoteSeatPolicy(), {
      accountId: accountA,
      deviceId: `${suffix}-computer-a`,
      enabled: true,
      confirmed: false,
      now,
    });
    expect(enabled.kind).toBe("enabled");
    expect(enabled.portal.devices[0]?.state).toBe("connecting");
    expect(access.calls).toHaveLength(1);
    expect(JSON.stringify(enabled)).not.toMatch(/providerObjectId|object-/);
    const stored = await runAsSystem("read the remote provider object", () =>
      prisma.remoteHost.findUniqueOrThrow({ where: { deviceId: `${suffix}-computer-a` } }),
    );
    expect(stored.providerObjectId).toMatch(/^object-/);
    const logicalHost = stored.logicalHost;
    const repeated = await setRemoteHost(prisma, access.provider, remoteSeatPolicy(), {
      accountId: accountA,
      deviceId: `${suffix}-computer-a`,
      enabled: true,
      confirmed: false,
      now,
    });
    expect(repeated.changed).toBe(false);
    expect(access.calls).toHaveLength(1);

    await registerRemoteHost(prisma, {
      accountId: accountA,
      deviceId: `${suffix}-computer-b`,
      now,
    });
    const waiting = await setRemoteHost(prisma, access.provider, remoteSeatPolicy(), {
      accountId: accountA,
      deviceId: `${suffix}-computer-b`,
      enabled: true,
      confirmed: false,
      now,
    });
    expect(waiting.kind).toBe("needs-confirmation");
    expect(access.calls).toHaveLength(1);
    const moved = await setRemoteHost(prisma, access.provider, remoteSeatPolicy(), {
      accountId: accountA,
      deviceId: `${suffix}-computer-b`,
      enabled: true,
      confirmed: true,
      now,
    });
    expect(moved.kind).toBe("moved");
    expect(moved.interruptedDeviceId).toBe(`${suffix}-computer-a`);
    expect(access.calls.some((call) => call.startsWith("release:"))).toBe(true);
    expect(access.calls.filter((call) => call.startsWith("provision:"))).toHaveLength(2);
    const hosts = await runAsSystem("read remote hosts after the move", () =>
      prisma.remoteHost.findMany({
        where: { accountId: accountA },
        orderBy: { deviceId: "asc" },
      }),
    );
    expect(hosts.map((host) => host.logicalHost).sort()).toEqual(
      [logicalHost, hosts.find((host) => host.deviceId.endsWith("computer-b"))!.logicalHost].sort(),
    );
    const hostB = hosts.find((host) => host.deviceId.endsWith("computer-b"));
    expect(hosts.find((host) => host.deviceId.endsWith("computer-a"))?.logicalHost).toBe(
      logicalHost,
    );
    expect(hosts.find((host) => host.deviceId.endsWith("computer-a"))?.providerObjectId).toBeNull();
    expect(hostB?.logicalHost).toBeTruthy();
    expect(hostB?.logicalHost).not.toBe(logicalHost);

    const readyAt = new Date(now.getTime() + 60_000);
    const portal = await noteRemoteHeartbeat(prisma, access.provider, {
      accountId: accountA,
      deviceId: `${suffix}-computer-b`,
      error: false,
      now: readyAt,
    });
    expect(portal).toMatchObject({
      kind: "open",
      deviceId: `${suffix}-computer-b`,
    });
    const offlineAt = new Date(readyAt.getTime() + 15 * 60 * 1000);
    const offline = await listRemoteHosts(prisma, access.provider, {
      accountId: accountA,
      now: offlineAt,
    });
    const current = offline.devices.find((device) => device.deviceId.endsWith("computer-b"));
    expect(current).toMatchObject({
      state: "offline",
      remoteEnabled: true,
      logicalHost: hostB?.logicalHost,
    });
    const released = await runAsSystem("read the offline remote host", () =>
      prisma.remoteHost.findUniqueOrThrow({ where: { deviceId: `${suffix}-computer-b` } }),
    );
    expect(released.providerObjectId).toBeNull();
    expect(released.logicalHost).toBe(current?.logicalHost);
    expect(released.remoteEnabled).toBe(true);

    const blocked = await registerRemoteHost(prisma, {
      accountId: accountB,
      deviceId: `${suffix}-computer-c`,
      now,
    });
    expect(blocked.portal.devices).toHaveLength(1);
    const denied = await setRemoteHost(prisma, access.provider, remoteSeatPolicy({ pilotCap: 1 }), {
      accountId: accountB,
      deviceId: `${suffix}-computer-c`,
      enabled: true,
      confirmed: false,
      now,
    });
    expect(denied.kind).toBe("pilot-full");
    expect(denied.changed).toBe(false);

    const unknown = await setRemoteHost(prisma, access.provider, remoteSeatPolicy(), {
      accountId: accountA,
      deviceId: `${suffix}-missing`,
      enabled: true,
      confirmed: false,
      now,
    });
    expect(unknown.kind).toBe("unregistered");
    const stolen = await registerRemoteHost(prisma, {
      accountId: accountB,
      deviceId: `${suffix}-computer-a`,
      now,
    });
    expect(stolen.kind).toBe("conflict");
    const disabled = await setRemoteHost(prisma, access.provider, remoteSeatPolicy(), {
      accountId: accountA,
      deviceId: `${suffix}-computer-b`,
      enabled: false,
      confirmed: false,
      now,
    });
    expect(disabled.kind).toBe("disabled");
    expect(disabled.changed).toBe(true);
    expect(
      disabled.portal.devices.find((device) => device.deviceId.endsWith("computer-b")),
    ).toMatchObject({ remoteEnabled: false, state: "off" });
    const kept = await runAsSystem("read the computer after remote is turned off", () =>
      prisma.remoteHost.findUniqueOrThrow({ where: { deviceId: `${suffix}-computer-b` } }),
    );
    expect(kept.remoteEnabled).toBe(false);
    expect(kept.providerObjectId).toBeNull();
    expect(kept.logicalHost).toBe(hostB?.logicalHost);
  });

  it("allocates shortCode and tracks remote_host_members across includeOwned modes", async () => {
    const db = createDb(databaseUrl!);
    const owner = `${suffix}-owner`;
    const guest = `${suffix}-guest`;
    const deviceId = `${suffix}-short-host`;
    const access = recorder();
    try {
      await runAsSystem("create shortCode fixture accounts", async () => {
        await prisma.user.create({
          data: { id: owner, name: "Owner", email: `${owner}@example.test` },
        });
        await prisma.user.create({
          data: { id: guest, name: "Guest", email: `${guest}@example.test` },
        });
      });

      const reg = await registerRemoteHost(db.prisma, { accountId: owner, deviceId, now });
      const shortCode = reg.portal.devices[0]?.shortCode;
      expect(shortCode).toMatch(/^[a-z0-9]{8}$/);

      const byShort = await remoteHostEntrance(db.prisma, shortCode!, now);
      expect(byShort).toMatchObject({ deviceId, shortCode, state: "off" });
      const byDevice = await findRemoteHostByKey(db.prisma, deviceId);
      expect(byDevice?.shortCode).toBe(shortCode);
      expect(await remoteHostEntrance(db.prisma, "notfound", now)).toBeNull();

      // Owner cannot add themselves as an invited member; guest can be added idempotently.
      expect(
        await recordRemoteHostMember(db.prisma, { deviceId, accountId: owner, invitedBy: owner }),
      ).toBe(false);
      expect(
        await recordRemoteHostMember(db.prisma, { deviceId, accountId: guest, invitedBy: owner }),
      ).toBe(true);
      expect(
        await recordRemoteHostMember(db.prisma, { deviceId, accountId: guest, invitedBy: owner }),
      ).toBe(true);

      // Team listing returns owned host; Free guest listing still shows invited Team host.
      const ownerPortal = await listRemoteHosts(db.prisma, access.provider, {
        accountId: owner,
        now,
        includeOwned: true,
      });
      expect(ownerPortal.devices.map((d) => d.deviceId)).toEqual([deviceId]);
      expect(ownerPortal.devices[0]?.invited).toBeUndefined();

      const guestFreePortal = await listRemoteHosts(db.prisma, access.provider, {
        accountId: guest,
        now,
        includeOwned: false,
      });
      expect(guestFreePortal.devices).toEqual([
        expect.objectContaining({ deviceId, shortCode, invited: true }),
      ]);

      expect(await revokeRemoteHostMember(db.prisma, { deviceId, accountId: guest })).toBe(true);
      expect(await revokeRemoteHostMember(db.prisma, { deviceId, accountId: guest })).toBe(false);
      const afterRevoke = await listRemoteHosts(db.prisma, access.provider, {
        accountId: guest,
        now,
        includeOwned: false,
      });
      expect(afterRevoke.devices).toEqual([]);
    } finally {
      await runAsSystem("clean shortCode fixture", async () => {
        await db.prisma.remoteHostMember.deleteMany({ where: { deviceId } });
        await db.prisma.remoteHost.deleteMany({ where: { deviceId } });
        await db.prisma.user.deleteMany({ where: { id: { in: [owner, guest] } } });
      });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
});
