import type { PrismaClient } from "@rakazo/db";
import { machineOwnerUserId } from "@rakazo/db";
import type { HostComputerEnvironment, HostComputerRequest } from "./host-computer-protocol.js";
import { managedLoopbackHost } from "./host-computer-protocol.js";
import { HostComputerSandbox } from "./host-computer-sandbox.js";
import { UserDeviceOfflineError } from "./user-device-gateway.js";
import type { UserDevice, UserDeviceGateway } from "./user-device-protocol.js";

export const HOST_COMPUTER_DEVICE_ID = "this-computer";

/**
 * On the desktop app's own server, "Let bots use this computer" makes it every bot's computer.
 * This also offers its apps to the owner's own runs, through the same screen tools and per-app
 * approval as a paired computer. Its commands already run as the bot's computer, so only the
 * screen goes this way.
 */
export function withHostComputerScreen(
  devices: UserDeviceGateway | undefined,
  options: { prisma: PrismaClient; sandboxKind: string; url?: string; token?: string },
): UserDeviceGateway | undefined {
  const { prisma, url, token } = options;
  const nativeBridge =
    options.sandboxKind === "none" ? managedLoopbackHost({ url, token }) : undefined;
  if ((options.sandboxKind !== "docker" && !nativeBridge) || !url || !token) return devices;
  const host = new HostComputerSandbox(nativeBridge?.url ?? url, nativeBridge?.token ?? token);

  // Approvals count from the latest settings change, so turning access off and on asks again.
  async function enabledSince(userId: string) {
    if (nativeBridge) {
      const ownerId = await machineOwnerUserId(prisma);
      if (!ownerId || ownerId !== userId) return null;
    }
    const settings = await prisma.deploymentSettings.findUnique({
      where: { id: "default" },
      select: { computerHost: true, updatedAt: true },
    });
    return settings?.computerHost === "this-mac" ? settings.updatedAt : null;
  }

  async function hostDevice(userId: string): Promise<UserDevice | null> {
    if (!(await enabledSince(userId))) return null;
    try {
      let environment: HostComputerEnvironment | undefined;
      for await (const value of host.stream<HostComputerEnvironment>(
        { method: "environment", botId: HOST_COMPUTER_DEVICE_ID },
        AbortSignal.timeout(5_000),
      ))
        environment = value;
      return environment
        ? {
            deviceId: HOST_COMPUTER_DEVICE_ID,
            name: "This computer",
            platform: environment.platform,
            screenOnly: true,
          }
        : null;
    } catch {
      // The desktop app is closed or access was revoked on it.
      return null;
    }
  }

  return {
    async connected(userId) {
      return (await devices?.connected(userId)) ?? hostDevice(userId);
    },
    async pairedSince(userId) {
      return (await devices?.pairedSince(userId)) ?? enabledSince(userId);
    },
    async *request<T>(
      userId: string,
      request: HostComputerRequest,
      signal: AbortSignal,
      deviceId?: string,
    ): AsyncIterable<T> {
      if (deviceId !== HOST_COMPUTER_DEVICE_ID) {
        if (!devices) throw new UserDeviceOfflineError();
        yield* devices.request<T>(userId, request, signal, deviceId);
        return;
      }
      if (request.method !== "screenObserve" && request.method !== "screenAct")
        throw new Error("Only screen control reaches this computer this way");
      if (!(await enabledSince(userId))) throw new UserDeviceOfflineError();
      yield* host.stream<T>(request, signal);
    },
  };
}
