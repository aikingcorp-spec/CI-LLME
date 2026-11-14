import type { PrismaClient } from "./client.js";
import { runAsSystem } from "./row-security.js";

export async function enrollRemoteDeviceKey(
  db: PrismaClient,
  input: { accountId: string; deviceId: string; publicKey: string },
): Promise<{ kind: "enrolled" | "conflict" | "revoked" }> {
  return runAsSystem("enroll a host device key", async () => {
    const existing = await db.remoteDeviceKey.findUnique({
      where: { deviceId: input.deviceId },
      select: { accountId: true, publicKey: true, revokedAt: true },
    });
    if (existing?.revokedAt) return { kind: "revoked" };
    if (existing && existing.accountId !== input.accountId) return { kind: "conflict" };
    if (existing?.publicKey === input.publicKey) return { kind: "enrolled" };
    if (existing) {
      await db.remoteDeviceKey.update({
        where: { deviceId: input.deviceId },
        data: { publicKey: input.publicKey },
      });
      return { kind: "enrolled" };
    }
    await db.remoteDeviceKey.create({
      data: {
        deviceId: input.deviceId,
        accountId: input.accountId,
        publicKey: input.publicKey,
      },
    });
    return { kind: "enrolled" };
  });
}

/** Stops a host key immediately, including while that computer is offline. */
export async function revokeRemoteDeviceKey(
  db: PrismaClient,
  input: { accountId: string; deviceId: string; now: Date },
): Promise<boolean> {
  return runAsSystem("revoke a host device key", async () => {
    const updated = await db.remoteDeviceKey.updateMany({
      where: { deviceId: input.deviceId, accountId: input.accountId, revokedAt: null },
      data: { revokedAt: input.now },
    });
    return updated.count > 0;
  });
}

export async function remoteDeviceKeyFor(db: PrismaClient, deviceId: string) {
  return runAsSystem("read a host device key", () =>
    db.remoteDeviceKey.findUnique({
      where: { deviceId },
      select: { accountId: true, publicKey: true, revokedAt: true },
    }),
  );
}
