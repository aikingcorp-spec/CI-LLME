import { remoteConnectorHostname } from "@rakazo/adapters";
import { remoteLogicalHost } from "@rakazo/db";

export interface RemoteAccessEnv {
  accountId: string;
  zoneId: string;
  apiToken: string;
  nameSuffix: string;
}

/** Central process environment only. The host install must ignore this value. */
export function parseRemoteAccessEnv(raw: string | undefined): RemoteAccessEnv | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Remote access configuration is invalid");
  }
  if (!value || typeof value !== "object")
    throw new Error("Remote access configuration is invalid");
  const accountId = text(value, "accountId");
  const zoneId = text(value, "zoneId");
  const apiToken = text(value, "apiToken");
  const nameSuffix = text(value, "nameSuffix");
  if (!accountId || !zoneId || !apiToken || !nameSuffix) {
    throw new Error("Remote access configuration is invalid");
  }
  remoteConnectorHostname(remoteLogicalHost("configured"), nameSuffix);
  return { accountId, zoneId, apiToken, nameSuffix };
}

/** Public name of this computer. The control token never belongs on the host. */
export function localRemoteOrigin(
  deviceId: string,
  rawSuffix: string | undefined,
  issuer?: string,
): string | undefined {
  const suffix = rawSuffix ?? (issuer === "https://app.vnbot.run" ? "vnbot.run" : undefined);
  if (!suffix) return undefined;
  return `https://${remoteConnectorHostname(remoteLogicalHost(deviceId), suffix)}`;
}

function text(value: object, key: string): string | undefined {
  if (!(key in value)) return undefined;
  const field: unknown = Reflect.get(value, key);
  if (typeof field !== "string" || !field || field.length > 4096) return undefined;
  return field;
}
