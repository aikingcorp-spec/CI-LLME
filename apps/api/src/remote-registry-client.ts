import { randomBytes } from "node:crypto";
import { remoteDeviceSignature } from "@rakazo/auth";
import type { RemoteHostCommand, RemotePortal } from "@rakazo/contracts";
import { RemoteRegistryResponseSchema } from "@rakazo/contracts";
import { readBoundedJsonResponse } from "@rakazo/core";

export interface RemoteRegistryResult {
  portal: RemotePortal;
  kind?: RemoteHostCommand["kind"];
  changed?: boolean;
  interruptedDeviceId?: string;
  holders?: string[];
  connectorToken?: string;
}

/**
 * The host calls the registry with its device key. The central session is not
 * required. A connector token is removed from the portal object before return.
 */
export function createRemoteRegistryClient(input: {
  origin: string;
  deviceId: string;
  privateKey: string;
  originService: string;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const request = input.fetch ?? fetch;
  async function post(
    action: string,
    extra?: Record<string, unknown>,
  ): Promise<RemoteRegistryResult> {
    const body = JSON.stringify({
      action,
      originService: input.originService,
      ...extra,
    });
    const time = String(input.now?.() ?? Date.now());
    const nonce = randomBytes(16).toString("base64url");
    const signature = remoteDeviceSignature(input.privateKey, {
      deviceId: input.deviceId,
      time,
      nonce,
      body,
    });
    const signal = AbortSignal.timeout(15_000);
    const response = await request(new URL("/api/remote-host", input.origin), {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        "x-rakazo-device": input.deviceId,
        "x-rakazo-time": time,
        "x-rakazo-nonce": nonce,
        "x-rakazo-signature": signature,
      },
      body,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Remote registry rejected the host");
    }
    const payload = RemoteRegistryResponseSchema.parse(
      await readBoundedJsonResponse<unknown>(response, 64 * 1024, signal),
    );
    const { connectorToken, ...result } = payload;
    return {
      ...result,
      ...((action === "present" || action === "set") && connectorToken ? { connectorToken } : {}),
    };
  }
  return {
    present: (error?: boolean) => post("present", error ? { error: true } : {}),
    list: () => post("list"),
    set: (enabled: boolean, confirmed: boolean) => post("set", { enabled, confirmed }),
  };
}
