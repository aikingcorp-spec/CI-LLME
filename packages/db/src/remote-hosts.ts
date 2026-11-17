import { createHash, randomBytes } from "node:crypto";
import type {
  RemoteAccessProvider,
  RemoteDevice,
  RemotePortal,
  RemotePortalDevice,
  RemoteSeatPolicy,
  RemoteSeatResult,
} from "@rakazo/core";
import {
  disableRemoteSeat,
  enableRemoteSeat,
  moveRemoteSeat,
  registerRemoteDevice,
  remoteObjectId,
  remotePortal,
  remotePresence,
} from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { isUniqueViolation } from "./prisma-errors.js";
import { runAsSystem } from "./row-security.js";

const SHORT_CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const SHORT_CODE_RE = /^[a-z0-9]{8}$/;

export function generateRemoteShortCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += SHORT_CODE_ALPHABET[bytes[i]! % SHORT_CODE_ALPHABET.length];
  }
  return out;
}

type RemoteHostRow = {
  deviceId: string;
  accountId: string;
  shortCode: string | null;
  remoteEnabled: boolean;
  heartbeatAt: Date | null;
  providerError: boolean;
  providerObjectId: string | null;
  logicalHost: string;
};

export interface RemoteHostCommand {
  kind: RemoteSeatResult["kind"];
  changed: boolean;
  interruptedDeviceId?: string;
  holders?: string[];
  portal: RemotePortal;
}

const LOCK = Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('rakazo:remote-seats'))`;

export function remoteLogicalHost(deviceId: string): string {
  return `h${createHash("sha256").update(deviceId).digest("hex").slice(0, 32)}`;
}

function deviceOf(row: RemoteHostRow): RemoteDevice {
  return {
    accountId: row.accountId,
    deviceId: row.deviceId,
    remoteEnabled: row.remoteEnabled,
  };
}

function view(row: RemoteHostRow, now: Date, options?: { invited?: boolean }): RemotePortalDevice {
  return {
    deviceId: row.deviceId,
    logicalHost: row.logicalHost,
    shortCode: row.shortCode,
    ...(options?.invited ? { invited: true } : {}),
    remoteEnabled: row.remoteEnabled,
    state: remotePresence({
      remoteEnabled: row.remoteEnabled,
      heartbeatAt: row.heartbeatAt?.getTime() ?? null,
      now: now.getTime(),
      error: row.providerError,
    }).state,
  };
}

const REMOTE_HOST_SELECT = {
  deviceId: true,
  accountId: true,
  shortCode: true,
  remoteEnabled: true,
  heartbeatAt: true,
  providerError: true,
  providerObjectId: true,
  logicalHost: true,
} as const;

async function readRemoteHostByKey(
  db: PrismaClient,
  key: string,
): Promise<RemoteHostRow | null> {
  const byDevice = await db.remoteHost.findUnique({
    where: { deviceId: key },
    select: REMOTE_HOST_SELECT,
  });
  if (byDevice) return byDevice;
  if (!SHORT_CODE_RE.test(key)) return null;
  return db.remoteHost.findUnique({
    where: { shortCode: key },
    select: REMOTE_HOST_SELECT,
  });
}

export async function findRemoteHostByKey(
  db: PrismaClient,
  key: string,
): Promise<RemoteHostRow | null> {
  return runAsSystem("find a remote computer", () => readRemoteHostByKey(db, key));
}

/** One computer's public state. No provider id and no connector token. */
export async function remoteHostEntrance(
  db: PrismaClient,
  deviceIdOrShortCode: string,
  now: Date,
): Promise<{
  deviceId: string;
  shortCode: string | null;
  logicalHost: string;
  state: RemotePortalDevice["state"];
} | null> {
  return runAsSystem("read one remote computer", async () => {
    const row = await readRemoteHostByKey(db, deviceIdOrShortCode);
    if (!row) return null;
    const shown = view(row, now);
    return {
      deviceId: row.deviceId,
      shortCode: row.shortCode,
      logicalHost: shown.logicalHost,
      state: shown.state,
    };
  });
}

function portalFor(rows: readonly RemoteHostRow[], accountId: string, now: Date): RemotePortal {
  return remotePortal(
    rows.filter((row) => row.accountId === accountId).map((row) => view(row, now)),
  );
}

function command(
  result: RemoteSeatResult,
  rows: readonly RemoteHostRow[],
  accountId: string,
  now: Date,
): RemoteHostCommand {
  const portal = portalFor(rows, accountId, now);
  if (result.kind === "occupied") {
    return { kind: result.kind, changed: false, holders: result.holders, portal };
  }
  if (result.kind === "needs-confirmation" || result.kind === "moved") {
    return {
      kind: result.kind,
      changed: result.changed,
      interruptedDeviceId: result.interruptedDeviceId,
      portal,
    };
  }
  return { kind: result.kind, changed: result.changed, portal };
}

async function rowsOf(db: PrismaClient): Promise<RemoteHostRow[]> {
  return db.remoteHost.findMany({
    select: REMOTE_HOST_SELECT,
  });
}

async function releaseObject(
  db: PrismaClient,
  provider: RemoteAccessProvider,
  row: RemoteHostRow,
): Promise<void> {
  if (!row.providerObjectId) return;
  try {
    await provider.release({ objectId: row.providerObjectId });
    await db.remoteHost.update({
      where: { deviceId: row.deviceId },
      data: { providerObjectId: null, providerError: false },
    });
  } catch {
    await db.remoteHost.update({
      where: { deviceId: row.deviceId },
      data: { providerError: true },
    });
  }
}

async function grantObject(
  db: PrismaClient,
  provider: RemoteAccessProvider,
  row: RemoteHostRow,
): Promise<void> {
  if (row.providerObjectId || !row.remoteEnabled) return;
  try {
    const grant = await provider.provision({
      accountId: row.accountId,
      deviceId: row.deviceId,
      logicalHost: row.logicalHost,
    });
    await db.remoteHost.update({
      where: { deviceId: row.deviceId },
      data: { providerObjectId: remoteObjectId(grant), providerError: false },
    });
  } catch {
    await db.remoteHost.update({
      where: { deviceId: row.deviceId },
      data: { providerError: true },
    });
  }
}

export async function remoteConnectorObjectId(
  db: PrismaClient,
  input: { accountId: string; deviceId: string },
): Promise<string | undefined> {
  return runAsSystem("read a remote connector id", async () => {
    const row = await db.remoteHost.findUnique({
      where: { deviceId: input.deviceId },
      select: { accountId: true, remoteEnabled: true, providerObjectId: true },
    });
    if (!row || row.accountId !== input.accountId || !row.remoteEnabled) return undefined;
    return row.providerObjectId ?? undefined;
  });
}

/**
 * Asks the provider for this enabled computer again. A repeat finds the same
 * object. The connector token stays in the provider callback, not in this row.
 */
export async function ensureRemoteConnector(
  db: PrismaClient,
  provider: RemoteAccessProvider,
  input: { accountId: string; deviceId: string; originService?: string },
): Promise<string | undefined> {
  return runAsSystem("refresh a remote connector without storing its token", async () => {
    const row = await db.remoteHost.findUnique({
      where: { deviceId: input.deviceId },
      select: { accountId: true, remoteEnabled: true, logicalHost: true, providerObjectId: true },
    });
    if (!row || row.accountId !== input.accountId || !row.remoteEnabled) return undefined;
    try {
      const grant = await provider.provision({
        accountId: input.accountId,
        deviceId: input.deviceId,
        logicalHost: row.logicalHost,
        originService: input.originService,
      });
      const objectId = remoteObjectId(grant);
      if (objectId !== row.providerObjectId || row.providerObjectId === null) {
        await db.remoteHost.update({
          where: { deviceId: input.deviceId },
          data: { providerObjectId: objectId, providerError: false },
        });
      } else {
        await db.remoteHost.update({
          where: { deviceId: input.deviceId },
          data: { providerError: false },
        });
      }
      return objectId;
    } catch {
      await db.remoteHost.update({
        where: { deviceId: input.deviceId },
        data: { providerError: true },
      });
      return undefined;
    }
  });
}

/** Drops provider objects the presence rule no longer allows. Registrations stay. */
export async function reconcileRemoteHosts(
  db: PrismaClient,
  provider: RemoteAccessProvider,
  now: Date,
): Promise<void> {
  await runAsSystem("release remote access that is off or offline", async () => {
    const rows = await rowsOf(db);
    for (const row of rows) {
      if (!row.providerObjectId) continue;
      const presence = remotePresence({
        remoteEnabled: row.remoteEnabled,
        heartbeatAt: row.heartbeatAt?.getTime() ?? null,
        now: now.getTime(),
        error: row.providerError,
      });
      if (presence.releaseProvider) await releaseObject(db, provider, row);
    }
  });
}

async function allocateShortCode(
  tx: Pick<PrismaClient, "remoteHost">,
): Promise<string> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = generateRemoteShortCode();
    const taken = await tx.remoteHost.findUnique({
      where: { shortCode: candidate },
      select: { deviceId: true },
    });
    if (!taken) return candidate;
  }
  throw new Error("Could not allocate unique remote short code");
}

export async function recordRemoteHostMember(
  db: PrismaClient,
  input: { deviceId: string; accountId: string; invitedBy: string },
): Promise<boolean> {
  return runAsSystem("record a remote host member", async () => {
    const host = await db.remoteHost.findUnique({
      where: { deviceId: input.deviceId },
      select: { deviceId: true, accountId: true },
    });
    if (!host || host.accountId === input.accountId) return false;
    await db.remoteHostMember.upsert({
      where: {
        deviceId_accountId: { deviceId: input.deviceId, accountId: input.accountId },
      },
      create: {
        deviceId: input.deviceId,
        accountId: input.accountId,
        invitedBy: input.invitedBy,
      },
      update: {},
    });
    return true;
  });
}

export async function revokeRemoteHostMember(
  db: PrismaClient,
  input: { deviceId: string; accountId: string },
): Promise<boolean> {
  return runAsSystem("revoke a remote host member", async () => {
    const deleted = await db.remoteHostMember.deleteMany({
      where: { deviceId: input.deviceId, accountId: input.accountId },
    });
    return deleted.count > 0;
  });
}

export async function listRemoteHosts(
  db: PrismaClient,
  provider: RemoteAccessProvider,
  input: { accountId: string; now: Date; includeOwned?: boolean },
): Promise<RemotePortal> {
  await reconcileRemoteHosts(db, provider, input.now);
  return runAsSystem("list one account's remote computers", async () => {
    const includeOwned = input.includeOwned ?? true;
    const ownedRows = includeOwned
      ? await db.remoteHost.findMany({
          where: { accountId: input.accountId },
          select: REMOTE_HOST_SELECT,
        })
      : [];
    const memberships = await db.remoteHostMember.findMany({
      where: { accountId: input.accountId },
      include: { host: { select: REMOTE_HOST_SELECT } },
      orderBy: { createdAt: "asc" },
    });
    const seen = new Set(ownedRows.map((row) => row.deviceId));
    const devices: RemotePortalDevice[] = ownedRows.map((row) => view(row, input.now));
    for (const membership of memberships) {
      if (seen.has(membership.host.deviceId)) continue;
      seen.add(membership.host.deviceId);
      devices.push(view(membership.host, input.now, { invited: true }));
    }
    return remotePortal(devices);
  });
}

export async function registerRemoteHost(
  db: PrismaClient,
  input: { accountId: string; deviceId: string; now: Date },
): Promise<RemoteHostCommand> {
  return runAsSystem("register a computer without remote access", () =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw(LOCK);
      const rows = await rowsOf(tx as unknown as PrismaClient);
      const result = registerRemoteDevice(rows.map(deviceOf), input);
      let updated = false;
      if (result.changed) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const shortCode = await allocateShortCode(tx as unknown as PrismaClient);
          try {
            await tx.remoteHost.create({
              data: {
                deviceId: input.deviceId,
                accountId: input.accountId,
                shortCode,
                remoteEnabled: false,
                logicalHost: remoteLogicalHost(input.deviceId),
              },
            });
            updated = true;
            break;
          } catch (error) {
            if (!isUniqueViolation(error) || attempt === 4) throw error;
          }
        }
      } else {
        const existing = rows.find(
          (row) => row.deviceId === input.deviceId && row.accountId === input.accountId,
        );
        if (existing && !existing.shortCode) {
          const shortCode = await allocateShortCode(tx as unknown as PrismaClient);
          await tx.remoteHost.update({
            where: { deviceId: input.deviceId },
            data: { shortCode },
          });
          updated = true;
        }
      }
      const stored = updated ? await rowsOf(tx as unknown as PrismaClient) : rows;
      return command(result, stored, input.accountId, input.now);
    }),
  );
}

async function persistEnabled(
  tx: Prisma.TransactionClient,
  devices: readonly RemoteDevice[],
  previous: readonly RemoteHostRow[],
): Promise<void> {
  for (const device of devices) {
    const before = previous.find((row) => row.deviceId === device.deviceId);
    if (!before || before.remoteEnabled === device.remoteEnabled) continue;
    await tx.remoteHost.update({
      where: { deviceId: device.deviceId },
      data: { remoteEnabled: device.remoteEnabled },
    });
  }
}

export async function setRemoteHost(
  db: PrismaClient,
  provider: RemoteAccessProvider,
  policy: RemoteSeatPolicy,
  input: { accountId: string; deviceId: string; enabled: boolean; confirmed: boolean; now: Date },
): Promise<RemoteHostCommand> {
  const decided = await runAsSystem("change one computer's remote seat", () =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw(LOCK);
      const rows = await rowsOf(tx as unknown as PrismaClient);
      const devices = rows.map(deviceOf);
      let result: RemoteSeatResult = input.enabled
        ? enableRemoteSeat(devices, policy, input)
        : disableRemoteSeat(devices, input);
      if (result.kind === "occupied" && input.confirmed && result.holders.length === 1) {
        const fromDeviceId = result.holders[0];
        if (fromDeviceId && fromDeviceId !== input.deviceId) {
          result = moveRemoteSeat(devices, {
            accountId: input.accountId,
            fromDeviceId,
            toDeviceId: input.deviceId,
            confirmed: true,
          });
        }
      } else if (result.kind === "occupied") {
        result = {
          kind: "needs-confirmation",
          changed: false,
          interruptedDeviceId: result.holders[0] ?? input.deviceId,
          devices: result.devices,
        };
      }
      if (result.changed) await persistEnabled(tx, result.devices, rows);
      const stored = result.changed ? await rowsOf(tx as unknown as PrismaClient) : rows;
      return { result, stored };
    }),
  );
  if (decided.result.changed) {
    await runAsSystem("provision or release remote access for a seat change", async () => {
      const rows = await rowsOf(db);
      for (const row of rows) {
        if (row.accountId !== input.accountId) continue;
        if (row.remoteEnabled) await grantObject(db, provider, row);
        else await releaseObject(db, provider, row);
      }
    });
  }
  return runAsSystem("read remote computers after a seat change", async () => {
    const rows = await rowsOf(db);
    return command(decided.result, rows, input.accountId, input.now);
  });
}

export async function noteRemoteHeartbeat(
  db: PrismaClient,
  provider: RemoteAccessProvider,
  input: { accountId: string; deviceId: string; error: boolean; now: Date },
): Promise<RemotePortal> {
  await runAsSystem("record that a remote computer is online", async () => {
    const current = await db.remoteHost.findUnique({
      where: { deviceId: input.deviceId },
      select: { accountId: true, shortCode: true },
    });
    if (current?.accountId !== input.accountId) return;
    await db.remoteHost.update({
      where: { deviceId: input.deviceId },
      data: {
        heartbeatAt: input.now,
        providerError: input.error,
        ...(current.shortCode ? {} : { shortCode: await allocateShortCode(db) }),
      },
    });
    const row = (await rowsOf(db)).find((item) => item.deviceId === input.deviceId);
    if (row?.remoteEnabled && !input.error) await grantObject(db, provider, row);
  });
  return listRemoteHosts(db, provider, input);
}
