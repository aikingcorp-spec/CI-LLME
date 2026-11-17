import type { NativeIssuerPin } from "@rakazo/auth/identity-exchange-config";
import { parseNativeIssuerPin } from "@rakazo/auth/identity-exchange-config";

/** Hosted portal used when a build is not given a public origin. */
export const PRODUCTION_PORTAL_ORIGIN = "https://app.vnbot.run";

/** Hosts a staging installer must not call for account, remote, or update traffic. */
export const PRODUCTION_DISTRIBUTION_HOSTS = ["app.vnbot.run", "dl.vnbot.run"] as const;

const PUBLIC_PIN_FIELDS = [
  "issuer",
  "audience",
  "publicKey",
  "centralAuthUrl",
  "centralOrigin",
] as const;

export type PublicDistribution = {
  /** Canonical public pin JSON. Empty when this build has no pin. */
  identityPin: string;
  /** Portal origin inlined for account and remote. Empty keeps the production portal. */
  portalOrigin: string;
};

export function productionDistributionHost(value: string): boolean {
  const host = new URL(value).hostname;
  return PRODUCTION_DISTRIBUTION_HOSTS.some((item) => item === host);
}

/** An https origin with no user, path, query, or hash. Blank keeps the production portal. */
export function portalOrigin(raw: string | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return PRODUCTION_PORTAL_ORIGIN;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Invalid public portal origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.origin !== trimmed
  ) {
    throw new Error("Invalid public portal origin.");
  }
  return url.origin;
}

export const RAKAZO_CLOUD_URL = portalOrigin(process.env.RAKAZO_CLOUD_URL);

function canonicalPublicPin(pin: NativeIssuerPin): string {
  return JSON.stringify({
    issuer: pin.issuer,
    audience: pin.audience,
    publicKey: pin.publicKey,
    centralAuthUrl: pin.centralAuthUrl,
    centralOrigin: pin.centralOrigin,
  });
}

/** Public pin fields only. A private key, device id, or any other field is rejected. */
export function readPublicPin(raw: string | undefined): NativeIssuerPin | undefined {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("Invalid identity exchange configuration");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid identity exchange configuration");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== PUBLIC_PIN_FIELDS.length ||
    PUBLIC_PIN_FIELDS.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error("Invalid identity exchange configuration");
  }
  const pin = parseNativeIssuerPin(
    JSON.stringify({
      issuer: record.issuer,
      audience: record.audience,
      publicKey: record.publicKey,
      centralAuthUrl: record.centralAuthUrl,
      centralOrigin: record.centralOrigin,
    }),
  );
  if (!pin) throw new Error("Invalid identity exchange configuration");
  return pin;
}

/** Build-time pin and portal. An absent pin leaves the production portal in place. */
export function resolvePublicDistribution(env: {
  RAKAZO_IDENTITY_PIN?: string;
  RAKAZO_CLOUD_URL?: string;
}): PublicDistribution {
  const pin = readPublicPin(env.RAKAZO_IDENTITY_PIN);
  const cloudRaw = env.RAKAZO_CLOUD_URL?.trim() ?? "";
  const explicit = cloudRaw === "" ? undefined : portalOrigin(cloudRaw);
  if (pin && explicit && explicit !== pin.centralOrigin) {
    throw new Error("Public portal origin must match the issuer pin.");
  }
  const portal = explicit ?? pin?.centralOrigin ?? "";
  return {
    identityPin: pin ? canonicalPublicPin(pin) : "",
    portalOrigin: pin || explicit ? portal : "",
  };
}

/** Staging packages need an explicit public pin and portal, and neither may be production. */
export function assertStagingDistribution(env: {
  RAKAZO_IDENTITY_PIN?: string;
  RAKAZO_CLOUD_URL?: string;
}): PublicDistribution {
  if (!env.RAKAZO_IDENTITY_PIN?.trim()) {
    throw new Error("Staging installer requires RAKAZO_IDENTITY_PIN.");
  }
  if (!env.RAKAZO_CLOUD_URL?.trim()) {
    throw new Error("Staging installer requires RAKAZO_CLOUD_URL.");
  }
  const distribution = resolvePublicDistribution(env);
  const pin = readPublicPin(distribution.identityPin);
  if (!pin || distribution.portalOrigin === "") {
    throw new Error("Staging installer requires a public issuer pin and portal origin.");
  }
  const origins = [
    distribution.portalOrigin,
    pin.issuer,
    pin.centralOrigin,
    new URL(pin.centralAuthUrl).origin,
  ];
  if (origins.some((origin) => productionDistributionHost(origin))) {
    throw new Error("Staging installer must not use the production portal or update feed.");
  }
  return distribution;
}

export function desktopBuildDefines(env: {
  RAKAZO_IDENTITY_PIN?: string;
  RAKAZO_CLOUD_URL?: string;
}): {
  "process.env.RAKAZO_IDENTITY_PIN": string;
  "process.env.RAKAZO_CLOUD_URL": string;
} {
  const distribution = resolvePublicDistribution(env);
  return {
    "process.env.RAKAZO_IDENTITY_PIN": JSON.stringify(distribution.identityPin),
    "process.env.RAKAZO_CLOUD_URL": JSON.stringify(distribution.portalOrigin),
  };
}

export const STAGING_USER_DATA_NAME = "VNBot-Staging";

/** True when built or launched against a non-production portal origin or issuer pin. */
export function isStagingDistribution(env: {
  RAKAZO_IDENTITY_PIN?: string;
  RAKAZO_CLOUD_URL?: string;
}): boolean {
  const cloudRaw = env.RAKAZO_CLOUD_URL?.trim() ?? "";
  if (cloudRaw !== "") {
    try {
      if (!productionDistributionHost(portalOrigin(cloudRaw))) return true;
    } catch {
      return true;
    }
  }
  const pinRaw = env.RAKAZO_IDENTITY_PIN?.trim() ?? "";
  if (pinRaw !== "") {
    try {
      const pin = readPublicPin(pinRaw);
      if (pin && !productionDistributionHost(pin.centralOrigin)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function stagingUserDataDir(
  env: { RAKAZO_IDENTITY_PIN?: string; RAKAZO_CLOUD_URL?: string },
  appDataDir: string,
  joinPath: (...parts: string[]) => string,
): string | null {
  return isStagingDistribution(env) ? joinPath(appDataDir, STAGING_USER_DATA_NAME) : null;
}
