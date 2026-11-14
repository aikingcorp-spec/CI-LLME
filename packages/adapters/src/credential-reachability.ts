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

/** A provider that never answered. This is not a rejected credential. */
export function integrationProviderUnreachable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; code?: unknown; status?: unknown; cause?: unknown };
  const status = typeof record.status === "number" ? record.status : Number.NaN;
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
  if (integrationProviderUnreachable(error)) {
    return new Error("Could not reach the integration provider");
  }
  return new Error("Could not verify these credentials");
}
