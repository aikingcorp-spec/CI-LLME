import type { RemoteAccessProvider } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { listRemoteHosts, noteRemoteHeartbeat, registerRemoteHost } from "@rakazo/db";

/**
 * The local server reports its own pinned computer. A server without one only
 * reads, so a browser cannot mark some other computer online.
 */
export async function presentPinnedDevice<T>(input: {
  localDeviceId: string | undefined;
  register: (deviceId: string) => Promise<{ kind: string }>;
  heartbeat: (deviceId: string) => Promise<T>;
  list: () => Promise<T>;
}): Promise<T> {
  if (!input.localDeviceId) return input.list();
  const registered = await input.register(input.localDeviceId);
  if (registered.kind === "conflict") return input.list();
  return input.heartbeat(input.localDeviceId);
}

/**
 * The host install must not receive the central provider. A server without a
 * pinned computer is the registry and may use the provider configured there.
 */
export function remoteProviderForDeployment<T>(input: {
  localDeviceId: string | undefined;
  configured: T | undefined;
}): T | undefined {
  if (input.localDeviceId) return undefined;
  return input.configured;
}

/**
 * A guest session on this computer does not register it or turn remote on.
 * A server without a pinned computer is the account portal and is unchanged.
 */
export function localRemoteActor(input: {
  localDeviceId: string | undefined;
  guestOnly: boolean;
}): "central" | "host" | "guest" {
  if (!input.localDeviceId) return "central";
  return input.guestOnly ? "guest" : "host";
}

/**
 * Only this install can register its own computer. A browser, or a request that
 * names a different computer, does not create one.
 */
export function pinnedRegistrationId(
  localDeviceId: string | undefined,
  requestedDeviceId: string,
): string | undefined {
  if (!localDeviceId || requestedDeviceId !== localDeviceId) return undefined;
  return localDeviceId;
}

/** Register and heartbeat this install's computer for the signed-in account. */
export function presentLocalComputer(
  prisma: PrismaClient,
  provider: RemoteAccessProvider,
  localDeviceId: string,
  accountId: string,
) {
  const now = new Date();
  return presentPinnedDevice({
    localDeviceId,
    register: (deviceId) => registerRemoteHost(prisma, { accountId, deviceId, now }),
    heartbeat: (deviceId) =>
      noteRemoteHeartbeat(prisma, provider, {
        accountId,
        deviceId,
        error: false,
        now,
      }),
    list: () => listRemoteHosts(prisma, provider, { accountId, now }),
  });
}
