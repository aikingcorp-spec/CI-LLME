import { remoteSeatPolicy, unavailableRemoteAccessProvider } from "@rakazo/core";
import {
  listRemoteHosts,
  noteRemoteHeartbeat,
  registerRemoteHost,
  revokeRemoteDeviceKey,
  revokeRemoteHostMember,
  runAsSystem,
  setRemoteHost,
} from "@rakazo/db";
import { isGuestOnlyUser } from "../local-presence.js";
import {
  localRemoteActor,
  pinnedRegistrationId,
  presentLocalComputer,
  remoteProviderForDeployment,
} from "../remote-presence.js";
import type { RouterDeps } from "../router.js";
import type { RouterContext } from "./context.js";

function policyOf(env: RouterDeps["env"] | undefined) {
  return remoteSeatPolicy({
    accountSeats: env?.remoteAccountSeats,
    pilotCap: env?.remotePilotCap,
  });
}

function adopt(deps: RouterDeps, token: string | undefined) {
  if (token) deps.adoptConnector?.(token);
  else deps.adoptConnector?.(undefined);
}

export function remoteHostRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const provider =
    remoteProviderForDeployment({
      localDeviceId: deps.localDeviceId,
      configured: deps.remoteAccess,
    }) ?? unavailableRemoteAccessProvider();
  const registry = deps.remoteRegistry;
  const actorOnHost = async (accountId: string) =>
    localRemoteActor({
      localDeviceId: deps.localDeviceId,
      guestOnly: deps.localDeviceId ? await isGuestOnlyUser(deps.prisma, accountId) : false,
    });
  const listed = async (accountId: string, now: Date) => {
    const edition = deps.accountEdition ? await deps.accountEdition(accountId) : undefined;
    const portal = await listRemoteHosts(deps.prisma, provider, {
      accountId,
      now,
      includeOwned: edition !== "free",
    });
    return edition ? { ...portal, edition } : portal;
  };
  return {
    remoteHosts: {
      list: authed.remoteHosts.list.handler(async ({ context }) => {
        const now = new Date();
        const accountId = context.actor.userId;
        if (registry) return (await registry.list()).portal;
        if ((await actorOnHost(accountId)) !== "host" || !deps.localDeviceId) {
          return listed(accountId, now);
        }
        const portal = await presentLocalComputer(
          deps.prisma,
          provider,
          deps.localDeviceId,
          accountId,
        );
        deps.localPresence?.note(accountId);
        return portal;
      }),
      register: authed.remoteHosts.register.handler(async ({ context, input }) => {
        const accountId = context.actor.userId;
        const now = new Date();
        if ((await actorOnHost(accountId)) === "guest") {
          return {
            kind: "conflict" as const,
            changed: false,
            portal: await listed(accountId, now),
          };
        }
        const deviceId = pinnedRegistrationId(deps.localDeviceId, input.deviceId);
        if (registry) {
          if (!deviceId) {
            const current = await registry.list();
            return { kind: "conflict" as const, changed: false, portal: current.portal };
          }
          const result = await registry.present();
          adopt(deps, result.connectorToken);
          return { kind: "registered" as const, changed: false, portal: result.portal };
        }
        if (!deviceId) {
          const portal = await listRemoteHosts(deps.prisma, provider, { accountId, now });
          return { kind: "conflict" as const, changed: false, portal };
        }
        return registerRemoteHost(deps.prisma, { accountId, deviceId, now });
      }),
      set: authed.remoteHosts.set.handler(async ({ context, input }) => {
        const accountId = context.actor.userId;
        const now = new Date();
        if ((await actorOnHost(accountId)) === "guest") {
          return {
            kind: "conflict" as const,
            changed: false,
            portal: await listed(accountId, now),
          };
        }
        if (registry) {
          const result = await registry.set(input.enabled, input.confirmed === true);
          adopt(deps, result.connectorToken);
          return {
            kind: result.kind ?? (input.enabled ? "enabled" : "disabled"),
            changed: result.changed ?? false,
            ...(result.interruptedDeviceId
              ? { interruptedDeviceId: result.interruptedDeviceId }
              : {}),
            ...(result.holders ? { holders: result.holders } : {}),
            portal: result.portal,
          };
        }
        return setRemoteHost(deps.prisma, provider, policyOf(deps.env), {
          accountId,
          deviceId: input.deviceId,
          enabled: input.enabled,
          confirmed: input.confirmed === true,
          now,
        });
      }),
      heartbeat: authed.remoteHosts.heartbeat.handler(async ({ context, input }) => {
        const now = new Date();
        const accountId = context.actor.userId;
        if ((await actorOnHost(accountId)) === "guest") return listed(accountId, now);
        if (registry) {
          const result = await registry.present();
          adopt(deps, result.connectorToken);
          return result.portal;
        }
        if (!deps.localDeviceId) return listRemoteHosts(deps.prisma, provider, { accountId, now });
        const portal = await noteRemoteHeartbeat(deps.prisma, provider, {
          accountId,
          deviceId: deps.localDeviceId,
          error: input.error === true,
          now,
        });
        deps.localPresence?.note(accountId);
        return portal;
      }),
      revoke: authed.remoteHosts.revoke.handler(async ({ context, input }) => {
        const accountId = context.actor.userId;
        const now = new Date();
        if (deps.localDeviceId || registry) {
          const portal = registry
            ? (await registry.list()).portal
            : await listRemoteHosts(deps.prisma, provider, { accountId, now });
          return { kind: "conflict" as const, changed: false, portal };
        }
        const host = deps.prisma.remoteHost?.findUnique
          ? await runAsSystem("check remote host owner before revoking", () =>
              deps.prisma.remoteHost.findUnique({
                where: { deviceId: input.deviceId },
                select: { accountId: true },
              }),
            )
          : null;
        if (host && host.accountId !== accountId) {
          await revokeRemoteHostMember(deps.prisma, { deviceId: input.deviceId, accountId });
          return { kind: "disabled" as const, changed: true, portal: await listed(accountId, now) };
        }
        await revokeRemoteDeviceKey(deps.prisma, { accountId, deviceId: input.deviceId, now });
        return setRemoteHost(deps.prisma, provider, policyOf(deps.env), {
          accountId,
          deviceId: input.deviceId,
          enabled: false,
          confirmed: true,
          now,
        });
      }),
      enter: authed.remoteHosts.enter.handler(async ({ context, input }) => {
        if (!deps.issueRemoteEnter) return { href: null };
        const href = await deps.issueRemoteEnter({
          accountId: context.actor.userId,
          email: context.actor.email,
          deviceId: input.deviceId,
        });
        return { href };
      }),
    },
  };
}
