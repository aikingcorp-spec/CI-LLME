/** Keys are provisioned by the composition root, never discovered from a proof. */
export type IdentityExchangeConfig =
  | { kind: "issuer"; issuer: string; audience: string; privateKey: string }
  | {
      kind: "local";
      issuer: string;
      audience: string;
      publicKey: string;
      deviceId: string;
      centralAuthUrl: string;
      centralOrigin: string;
      /** Host-only signing key. Absent on a device file that has not enrolled yet. */
      devicePrivateKey?: string;
    };

function configField(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || !(key in value)) {
    throw new Error("Identity exchange rejected");
  }
  const field: unknown = Reflect.get(value, key);
  if (typeof field !== "string" || !field || field.length > 4096) {
    throw new Error("Identity exchange rejected");
  }
  return field;
}

/** Public issuer material. The desktop generates the device id; this pin never carries a private key. */
export type NativeIssuerPin = {
  issuer: string;
  audience: string;
  publicKey: string;
  centralAuthUrl: string;
  centralOrigin: string;
};

/** Rejects a private key or a caller-chosen device id before any profile file is written. */
export function parseNativeIssuerPin(raw: string | undefined): NativeIssuerPin | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid identity exchange configuration");
  }
  if (
    !value ||
    typeof value !== "object" ||
    "deviceId" in value ||
    "privateKey" in value ||
    "devicePrivateKey" in value
  ) {
    throw new Error("Invalid identity exchange configuration");
  }
  const parsed = parseIdentityExchangeConfig(
    JSON.stringify({ ...value, kind: "local", deviceId: "pin" }),
  );
  if (parsed?.kind !== "local") throw new Error("Invalid identity exchange configuration");
  return {
    issuer: parsed.issuer,
    audience: parsed.audience,
    publicKey: parsed.publicKey,
    centralAuthUrl: parsed.centralAuthUrl,
    centralOrigin: parsed.centralOrigin,
  };
}

/** Optional deployment composition. Missing configuration preserves existing auth. */
export function parseIdentityExchangeConfig(
  raw: string | undefined,
): IdentityExchangeConfig | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid identity exchange configuration");
  }
  const kind = configField(value, "kind");
  const issuer = configField(value, "issuer");
  const audience = configField(value, "audience");
  const origin = new URL(issuer);
  if (origin.protocol !== "https:" || origin.origin !== issuer) {
    throw new Error("Invalid identity issuer");
  }
  if (kind === "issuer") {
    return { kind, issuer, audience, privateKey: configField(value, "privateKey") };
  }
  if (kind !== "local") throw new Error("Invalid identity exchange mode");
  const centralAuthUrl = configField(value, "centralAuthUrl");
  if (new URL(centralAuthUrl).origin !== issuer) {
    throw new Error("Identity service must match pinned issuer");
  }
  const devicePrivateKey =
    value && typeof value === "object" && "devicePrivateKey" in value
      ? configField(value, "devicePrivateKey")
      : undefined;
  return {
    kind,
    issuer,
    audience,
    centralAuthUrl,
    centralOrigin: configField(value, "centralOrigin"),
    deviceId: configField(value, "deviceId"),
    publicKey: configField(value, "publicKey"),
    ...(devicePrivateKey ? { devicePrivateKey } : {}),
  };
}
