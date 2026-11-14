import type { RemotePortal } from "@rakazo/contracts";

/** Internal storage prefix. The saved value is a device id, never a ticket, address, or account secret. */
export const REMEMBERED_COMPUTER_KEY_PREFIX = "rakazo.portalDevice.";

export interface ComputerPreferenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type PortalEntry =
  | { kind: "auto"; deviceId: string }
  | { kind: "choose"; rememberedAbsent: boolean };

export function rememberedComputerKey(userId: string, origin: string): string | null {
  if (userId.length === 0 || origin.length === 0) return null;
  return `${REMEMBERED_COMPUTER_KEY_PREFIX}${encodeURIComponent(origin)}.${encodeURIComponent(userId)}`;
}

function deviceIdFromStored(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("deviceId" in parsed)) return null;
    const deviceId = parsed.deviceId;
    if (typeof deviceId !== "string" || deviceId.length === 0) return null;
    return deviceId;
  } catch {
    return null;
  }
}

export function readRememberedComputer(
  store: ComputerPreferenceStore | null,
  scope: { userId: string | null; origin: string },
): string | null {
  if (store === null || scope.userId === null) return null;
  const key = rememberedComputerKey(scope.userId, scope.origin);
  if (key === null) return null;
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    return deviceIdFromStored(raw);
  } catch {
    return null;
  }
}

export function rememberComputer(
  store: ComputerPreferenceStore | null,
  scope: { userId: string | null; origin: string; deviceId: string },
): void {
  if (store === null || scope.userId === null || scope.deviceId.length === 0) return;
  const key = rememberedComputerKey(scope.userId, scope.origin);
  if (key === null) return;
  try {
    store.setItem(key, JSON.stringify({ deviceId: scope.deviceId }));
  } catch {
    // A denied write must not throw or replace another account's key. The open still proceeds.
  }
}

/** A remembered computer blocks every other automatic open. No memory follows the server. */
export function portalEntry(input: {
  portal: RemotePortal;
  rememberedDeviceId: string | null;
}): PortalEntry {
  const remembered = input.rememberedDeviceId;
  if (remembered === null || remembered.length === 0) {
    if (input.portal.kind === "open") return { kind: "auto", deviceId: input.portal.deviceId };
    return { kind: "choose", rememberedAbsent: false };
  }
  const listed = input.portal.devices.find((device) => device.deviceId === remembered);
  if (
    input.portal.kind === "open" &&
    input.portal.deviceId === remembered &&
    listed?.state === "ready"
  ) {
    return { kind: "auto", deviceId: remembered };
  }
  return { kind: "choose", rememberedAbsent: listed === undefined };
}
