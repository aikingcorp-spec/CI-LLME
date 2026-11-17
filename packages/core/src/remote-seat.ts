export const DEFAULT_ACCOUNT_REMOTE_SEATS = 1;
export const REMOTE_OFFLINE_AFTER_MS = 15 * 60 * 1000;

export type RemotePresenceState = "off" | "connecting" | "ready" | "offline" | "error";

export interface RemotePresence {
  state: RemotePresenceState;
  /** The provider object can be removed. The computer registration stays. */
  releaseProvider: boolean;
}

export interface RemotePortalDevice {
  deviceId: string;
  logicalHost: string;
  shortCode?: string | null;
  invited?: boolean;
  remoteEnabled: boolean;
  state: RemotePresenceState;
}

export type RemotePortal =
  | {
      kind: "open";
      deviceId: string;
      logicalHost: string;
      shortCode?: string | null;
      edition?: "free" | "team";
      devices: RemotePortalDevice[];
    }
  | { kind: "choose" | "unavailable"; edition?: "free" | "team"; devices: RemotePortalDevice[] };

/** Server-side access grant. The object id never goes to a browser. */
export interface RemoteAccessGrant {
  objectId: string;
  /**
   * Lets the host connector run. It is not a stored object id and never
   * belongs in a portal response.
   */
  runToken?: string;
}

export interface RemoteAccessProvider {
  provision(input: {
    accountId: string;
    deviceId: string;
    logicalHost: string;
    /** Loopback origin on the host. The registry supplies it per computer. */
    originService?: string;
  }): Promise<RemoteAccessGrant>;
  release(input: { objectId: string }): Promise<void>;
}

/** The value persisted for a grant. A connector token must not be stored as that id. */
export function remoteObjectId(grant: RemoteAccessGrant): string {
  if (grant.runToken !== undefined && grant.objectId === grant.runToken) {
    throw new Error("Remote object id must not be the connector token");
  }
  return grant.objectId;
}

/** Used when this server has no access provider. It never invents an object id. */
export function unavailableRemoteAccessProvider(): RemoteAccessProvider {
  return {
    provision() {
      return Promise.reject(new Error("Remote access provider is not configured"));
    },
    release() {
      return Promise.resolve();
    },
  };
}

/** A registered computer. Remote stays off until the server grants a seat. */
export interface RemoteDevice {
  accountId: string;
  deviceId: string;
  remoteEnabled: boolean;
}

/** Server configuration. Callers must not forward a number chosen by the client. */
export interface RemoteSeatPolicy {
  accountSeats: 1 | 2;
  /** Hosts with remote access on across the whole system. Unset means no limit. */
  pilotCap?: number;
}

export type RemoteSeatResult =
  | { kind: "registered" | "enabled" | "disabled"; changed: boolean; devices: RemoteDevice[] }
  | { kind: "moved"; changed: true; interruptedDeviceId: string; devices: RemoteDevice[] }
  | {
      kind: "needs-confirmation";
      changed: false;
      interruptedDeviceId: string;
      devices: RemoteDevice[];
    }
  | { kind: "occupied"; changed: false; holders: string[]; devices: RemoteDevice[] }
  | { kind: "pilot-full" | "unregistered" | "conflict"; changed: false; devices: RemoteDevice[] };

export function remoteSeatPolicy(input?: {
  accountSeats?: number;
  pilotCap?: number;
}): RemoteSeatPolicy {
  const accountSeats = input?.accountSeats ?? DEFAULT_ACCOUNT_REMOTE_SEATS;
  const pilotCap = input?.pilotCap;
  if (accountSeats !== 1 && accountSeats !== 2) {
    throw new Error("Remote seat limit must be 1 or 2");
  }
  if (pilotCap === undefined) return { accountSeats };
  if (!Number.isInteger(pilotCap) || pilotCap < 1) {
    throw new Error("Remote pilot cap must be a positive integer");
  }
  return { accountSeats, pilotCap };
}

function moment(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Remote ${label} is invalid`);
  }
  return value;
}

/** Remote off is its own state. A silent host releases the provider object after 15 minutes. */
export function remotePresence(input: {
  remoteEnabled: boolean;
  heartbeatAt: number | null;
  now: number;
  error: boolean;
}): RemotePresence {
  const now = moment(input.now, "clock");
  if (!input.remoteEnabled) return { state: "off", releaseProvider: true };
  if (input.heartbeatAt === null) {
    return { state: input.error ? "error" : "connecting", releaseProvider: false };
  }
  const heartbeatAt = moment(input.heartbeatAt, "heartbeat");
  if (now - heartbeatAt >= REMOTE_OFFLINE_AFTER_MS) {
    return { state: "offline", releaseProvider: true };
  }
  if (input.error) return { state: "error", releaseProvider: false };
  return { state: "ready", releaseProvider: false };
}

function portalDevices(devices: readonly RemotePortalDevice[]): RemotePortalDevice[] {
  return devices.map((device) => ({ ...device }));
}

/** Opens the only ready computer. Every registered computer stays in the list. */
export function remotePortal(devices: readonly RemotePortalDevice[]): RemotePortal {
  const listed = portalDevices(devices);
  const ready = listed.filter((device) => device.state === "ready");
  const first = ready[0];
  if (ready.length === 1 && first) {
    return {
      kind: "open",
      deviceId: first.deviceId,
      logicalHost: first.logicalHost,
      ...(first.shortCode !== undefined ? { shortCode: first.shortCode } : {}),
      devices: listed,
    };
  }
  if (ready.length > 1) return { kind: "choose", devices: listed };
  return { kind: "unavailable", devices: listed };
}

function identity(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("Remote device is invalid");
  }
  return value;
}

function snapshot(devices: readonly RemoteDevice[]): RemoteDevice[] {
  return devices.map((device) => ({ ...device }));
}

function owned(devices: readonly RemoteDevice[], accountId: string, deviceId: string) {
  return devices.find((device) => device.deviceId === deviceId && device.accountId === accountId);
}

function holdersOf(devices: readonly RemoteDevice[], accountId: string): string[] {
  return devices
    .filter((device) => device.accountId === accountId && device.remoteEnabled)
    .map((device) => device.deviceId);
}

function withEnabled(
  devices: readonly RemoteDevice[],
  accountId: string,
  deviceId: string,
  remoteEnabled: boolean,
): RemoteDevice[] {
  return devices.map((device) =>
    device.accountId === accountId && device.deviceId === deviceId
      ? { ...device, remoteEnabled }
      : { ...device },
  );
}

/** Adds a computer with remote off. Signing in does not call this and creates no grant. */
export function registerRemoteDevice(
  devices: readonly RemoteDevice[],
  input: { accountId: string; deviceId: string },
): RemoteSeatResult {
  const accountId = identity(input.accountId);
  const deviceId = identity(input.deviceId);
  const existing = devices.find((device) => device.deviceId === deviceId);
  if (existing?.accountId === accountId) {
    return { kind: "registered", changed: false, devices: snapshot(devices) };
  }
  if (existing) return { kind: "conflict", changed: false, devices: snapshot(devices) };
  return {
    kind: "registered",
    changed: true,
    devices: [...snapshot(devices), { accountId, deviceId, remoteEnabled: false }],
  };
}

/** Grants this computer the account's free remote seat. A full account is left unchanged. */
export function enableRemoteSeat(
  devices: readonly RemoteDevice[],
  policy: RemoteSeatPolicy,
  input: { accountId: string; deviceId: string },
): RemoteSeatResult {
  const accountId = identity(input.accountId);
  const deviceId = identity(input.deviceId);
  const current = devices.find((device) => device.deviceId === deviceId);
  if (!current) return { kind: "unregistered", changed: false, devices: snapshot(devices) };
  if (current.accountId !== accountId) {
    return { kind: "conflict", changed: false, devices: snapshot(devices) };
  }
  if (current.remoteEnabled) {
    return { kind: "enabled", changed: false, devices: snapshot(devices) };
  }
  const holders = holdersOf(devices, accountId);
  if (holders.length >= policy.accountSeats) {
    return { kind: "occupied", changed: false, holders, devices: snapshot(devices) };
  }
  const enabled = devices.filter((device) => device.remoteEnabled).length;
  if (policy.pilotCap !== undefined && enabled >= policy.pilotCap) {
    return { kind: "pilot-full", changed: false, devices: snapshot(devices) };
  }
  return {
    kind: "enabled",
    changed: true,
    devices: withEnabled(devices, accountId, deviceId, true),
  };
}

/** Turns remote off and keeps the computer registered. */
export function disableRemoteSeat(
  devices: readonly RemoteDevice[],
  input: { accountId: string; deviceId: string },
): RemoteSeatResult {
  const accountId = identity(input.accountId);
  const deviceId = identity(input.deviceId);
  const current = devices.find((device) => device.deviceId === deviceId);
  if (!current) return { kind: "unregistered", changed: false, devices: snapshot(devices) };
  if (current.accountId !== accountId) {
    return { kind: "conflict", changed: false, devices: snapshot(devices) };
  }
  if (!current.remoteEnabled) {
    return { kind: "disabled", changed: false, devices: snapshot(devices) };
  }
  return {
    kind: "disabled",
    changed: true,
    devices: withEnabled(devices, accountId, deviceId, false),
  };
}

/**
 * Moves the account's remote seat after the holder confirms the interruption.
 * The result names the computer that loses remote and carries no host data.
 */
export function moveRemoteSeat(
  devices: readonly RemoteDevice[],
  input: { accountId: string; fromDeviceId: string; toDeviceId: string; confirmed: boolean },
): RemoteSeatResult {
  const accountId = identity(input.accountId);
  const fromDeviceId = identity(input.fromDeviceId);
  const toDeviceId = identity(input.toDeviceId);
  const source = owned(devices, accountId, fromDeviceId);
  const target = owned(devices, accountId, toDeviceId);
  if (!source || !target) {
    return { kind: "unregistered", changed: false, devices: snapshot(devices) };
  }
  if (!source.remoteEnabled || target.remoteEnabled) {
    return {
      kind: "occupied",
      changed: false,
      holders: holdersOf(devices, accountId),
      devices: snapshot(devices),
    };
  }
  if (!input.confirmed) {
    return {
      kind: "needs-confirmation",
      changed: false,
      interruptedDeviceId: fromDeviceId,
      devices: snapshot(devices),
    };
  }
  return {
    kind: "moved",
    changed: true,
    interruptedDeviceId: fromDeviceId,
    devices: withEnabled(
      withEnabled(devices, accountId, fromDeviceId, false),
      accountId,
      toDeviceId,
      true,
    ),
  };
}
