import { remoteDeviceSignatureMatches } from "@rakazo/auth";

const SKEW_MS = 60_000;
const MAX_BODY = 4_096;

export interface SignedRemoteHost {
  accountId: string;
  request: {
    action?: string;
    enabled?: boolean;
    confirmed?: boolean;
    originService?: string;
    error?: boolean;
  };
}

export async function readSignedRemoteHost(input: {
  deviceId: string | null;
  time: string | null;
  nonce: string | null;
  signature: string | null;
  body: string;
  now: number;
  lookup: (
    deviceId: string,
  ) => Promise<
    { accountId: string; publicKey: string; revokedAt?: Date | null } | null | undefined
  >;
  seenNonce: (nonce: string) => boolean;
  rememberNonce: (nonce: string) => void;
}): Promise<SignedRemoteHost | undefined> {
  if (!input.deviceId || !input.time || !input.nonce || !input.signature) return undefined;
  if (input.body.length > MAX_BODY) return undefined;
  const time = Number(input.time);
  if (!Number.isFinite(time) || Math.abs(input.now - time) > SKEW_MS) return undefined;
  if (input.seenNonce(input.nonce)) return undefined;
  const key = await input.lookup(input.deviceId);
  if (!key || key.revokedAt) return undefined;
  const signed = {
    deviceId: input.deviceId,
    time: input.time,
    nonce: input.nonce,
    body: input.body,
  };
  if (!remoteDeviceSignatureMatches(key.publicKey, signed, input.signature)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  input.rememberNonce(input.nonce);
  const request = parsed as SignedRemoteHost["request"];
  return { accountId: key.accountId, request };
}

/** A list is safe to show. The connector token leaves only with a signed host action. */
export function remoteHostChannelResult(input: {
  action: string | undefined;
  body: Record<string, unknown>;
  connectorToken?: string;
}): Record<string, unknown> {
  if ((input.action === "present" || input.action === "set") && input.connectorToken) {
    return { ...input.body, connectorToken: input.connectorToken };
  }
  return input.body;
}

export async function handleRemoteHostRequest(
  request: Request,
  input: {
    now?: () => number;
    lookup: Parameters<typeof readSignedRemoteHost>[0]["lookup"];
    seenNonce: (nonce: string) => boolean;
    rememberNonce: (nonce: string) => void;
    act: (signed: SignedRemoteHost & { deviceId: string }) => Promise<{
      body: Record<string, unknown>;
      connectorToken?: string;
    }>;
  },
): Promise<Response> {
  const body = await request.text();
  const signed = await readSignedRemoteHost({
    deviceId: request.headers.get("x-rakazo-device"),
    time: request.headers.get("x-rakazo-time"),
    nonce: request.headers.get("x-rakazo-nonce"),
    signature: request.headers.get("x-rakazo-signature"),
    body,
    now: input.now?.() ?? Date.now(),
    lookup: input.lookup,
    seenNonce: input.seenNonce,
    rememberNonce: input.rememberNonce,
  });
  if (!signed) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  const deviceId = request.headers.get("x-rakazo-device");
  if (!deviceId) {
    return Response.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  const result = await input.act({ ...signed, deviceId });
  return Response.json(
    remoteHostChannelResult({
      action: signed.request.action,
      body: result.body,
      connectorToken: result.connectorToken,
    }),
    { headers: { "cache-control": "no-store" } },
  );
}
