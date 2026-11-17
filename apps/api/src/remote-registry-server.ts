import type { Edition } from "@rakazo/auth";
import type { RemotePortal } from "@rakazo/contracts";
import type { RemoteAccessProvider, RemoteSeatPolicy } from "@rakazo/core";
import { remoteSeatPolicy } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  ensureRemoteConnector,
  listRemoteHosts,
  noteRemoteHeartbeat,
  recordRemoteHostMember,
  registerRemoteHost,
  remoteConnectorObjectId,
  revokeRemoteHostMember,
  setRemoteHost,
} from "@rakazo/db";
import type { SignedRemoteHost } from "./remote-host-channel.js";

export async function actSignedRemoteHost(input: {
  prisma: PrismaClient;
  provider: RemoteAccessProvider;
  policy?: RemoteSeatPolicy;
  tokens: { get(objectId: string): string | undefined };
  signed: SignedRemoteHost & { deviceId: string };
  /** False when the account's edition has no remote access: the computer is never offered. */
  included?: (accountId: string) => Promise<boolean>;
  /** Authoritative account edition, included on the returned portal and gating owned devices. */
  editionFor?: (accountId: string) => Promise<Edition | null>;
}): Promise<{ body: Record<string, unknown>; connectorToken?: string }> {
  const now = new Date();
  const { accountId, deviceId, request } = input.signed;
  const origin = typeof request.originService === "string" ? request.originService : undefined;
  const policy = input.policy ?? remoteSeatPolicy();
  const edition = input.editionFor ? await input.editionFor(accountId) : undefined;
  const isIncluded =
    edition !== undefined
      ? edition === "team"
      : input.included
        ? await input.included(accountId)
        : true;
  const withEdition = (portal: RemotePortal) =>
    edition ? { ...portal, edition } : portal;

  if (!isIncluded) {
    const readPortal = async () =>
      withEdition(
        await listRemoteHosts(input.prisma, input.provider, {
          accountId,
          now,
          includeOwned: false,
        }),
      );
    if (request.action !== "present" && request.action !== "set") {
      return { body: { portal: await readPortal() } };
    }
    // An account moved off remote access stops being reachable on its next check-in.
    const listed = await listRemoteHosts(input.prisma, input.provider, { accountId, now });
    for (const device of listed.devices) {
      if (device.invited || !device.remoteEnabled) continue;
      await setRemoteHost(input.prisma, input.provider, policy, {
        accountId,
        deviceId: device.deviceId,
        enabled: false,
        confirmed: true,
        now,
      });
    }
    const portal = await readPortal();
    return {
      body: request.action === "set" ? { kind: "conflict", changed: false, portal } : { portal },
    };
  }
  if (request.action === "list") {
    return {
      body: {
        portal: withEdition(
          await listRemoteHosts(input.prisma, input.provider, { accountId, now }),
        ),
      },
    };
  }
  if (request.action === "record-member") {
    const memberAccountId =
      typeof request.memberAccountId === "string" ? request.memberAccountId.trim() : "";
    if (!memberAccountId) return { body: { error: "unauthorized" } };
    await recordRemoteHostMember(input.prisma, {
      deviceId,
      accountId: memberAccountId,
      invitedBy: accountId,
    });
    return {
      body: {
        portal: withEdition(
          await listRemoteHosts(input.prisma, input.provider, { accountId, now }),
        ),
      },
    };
  }
  if (request.action === "revoke-member") {
    const memberAccountId =
      typeof request.memberAccountId === "string" ? request.memberAccountId.trim() : "";
    if (!memberAccountId) return { body: { error: "unauthorized" } };
    await revokeRemoteHostMember(input.prisma, { deviceId, accountId: memberAccountId });
    return {
      body: {
        portal: withEdition(
          await listRemoteHosts(input.prisma, input.provider, { accountId, now }),
        ),
      },
    };
  }
  if (request.action === "present") {
    await registerRemoteHost(input.prisma, { accountId, deviceId, now });
    await noteRemoteHeartbeat(input.prisma, input.provider, {
      accountId,
      deviceId,
      error: request.error === true,
      now,
    });
    const objectId =
      request.error === true
        ? await remoteConnectorObjectId(input.prisma, { accountId, deviceId })
        : await ensureRemoteConnector(input.prisma, input.provider, {
            accountId,
            deviceId,
            originService: origin,
          });
    const portal = withEdition(
      await listRemoteHosts(input.prisma, input.provider, { accountId, now }),
    );
    return { body: { portal }, connectorToken: objectId ? input.tokens.get(objectId) : undefined };
  }
  if (request.action === "set") {
    const command = await setRemoteHost(input.prisma, input.provider, policy, {
      accountId,
      deviceId,
      enabled: request.enabled === true,
      confirmed: request.confirmed === true,
      now,
    });
    const objectId =
      command.kind === "enabled" || command.kind === "moved"
        ? await ensureRemoteConnector(input.prisma, input.provider, {
            accountId,
            deviceId,
            originService: origin,
          })
        : undefined;
    const portal = withEdition(
      await listRemoteHosts(input.prisma, input.provider, { accountId, now }),
    );
    return {
      body: { ...command, portal },
      connectorToken: objectId ? input.tokens.get(objectId) : undefined,
    };
  }
  return { body: { error: "unauthorized" } };
}
