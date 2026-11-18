import { ClientError, errorStatus } from "@rakazo/core";

const UNREACHABLE_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

function providerHttpStatus(error: unknown): number | undefined {
  const direct = errorStatus(error);
  if (direct !== undefined) return direct;
  if (!error || typeof error !== "object") return undefined;
  const record = error as { statusCode?: unknown; cause?: unknown };
  if (typeof record.statusCode === "number" && Number.isInteger(record.statusCode)) {
    return record.statusCode;
  }
  return record.cause !== undefined ? providerHttpStatus(record.cause) : undefined;
}

/** A provider that never answered. This is not a rejected credential. */
export function integrationProviderUnreachable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown };
  const status = providerHttpStatus(error) ?? Number.NaN;
  if (status === 401 || status === 403) return false;
  if (record.name === "AbortError" || record.name === "TimeoutError") return true;
  if (typeof record.code === "string" && UNREACHABLE_CODES.has(record.code)) return true;
  if (record.cause !== undefined && integrationProviderUnreachable(record.cause)) return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message === "fetch failed" ||
    message === "the operation was aborted" ||
    message === "the operation was aborted due to timeout" ||
    message.includes("network timeout")
  );
}

export function credentialVerificationError(error: unknown): Error {
  const status = providerHttpStatus(error);
  if (status === 401 || status === 403) {
    return new ClientError("BAD_REQUEST", "The integration provider refused these credentials.");
  }
  if (integrationProviderUnreachable(error)) {
    return new ClientError("SERVICE_UNAVAILABLE", "Could not reach the integration provider");
  }
  return new Error("Could not verify these credentials");
}
