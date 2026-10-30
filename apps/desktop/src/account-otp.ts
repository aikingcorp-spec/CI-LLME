import { normalizeServerUrl, RAKAZO_CLOUD_URL } from "./setup-config.js";
import type { Strings } from "./strings.js";

export type AccountOtpErrorKind =
  | "invalid-code"
  | "expired"
  | "not-invited"
  | "rate-limited"
  | "network"
  | "failed";

export class AccountOtpError extends Error {
  constructor(readonly kind: AccountOtpErrorKind) {
    super(`Account sign-in failed: ${kind}`);
    this.name = "AccountOtpError";
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

/** The account server the first sign-in talks to; a bad override falls back to the hosted one. */
export function accountBaseUrl(override: string | undefined): string {
  return normalizeServerUrl(override ?? "") ?? RAKAZO_CLOUD_URL;
}

/** A shape check before spending a request; the server decides what the address really is. */
export function isPlausibleEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value);
}

function errorKind(status: number, code: unknown): AccountOtpErrorKind {
  if (code === "EMAIL_NOT_INVITED") return "not-invited";
  if (code === "INVALID_OTP") return "invalid-code";
  if (code === "OTP_EXPIRED" || code === "TOO_MANY_ATTEMPTS") return "expired";
  if (status === 429) return "rate-limited";
  return "failed";
}

/**
 * The email-code client for the setup window. It runs in the main process and keeps nothing: the
 * session the server issues is dropped here, and only the verified address comes back.
 */
export function createAccountOtpClient(input: { baseUrl: string; fetch: typeof fetch }) {
  async function post(path: string, body: unknown, locale?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await input.fetch(`${input.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The auth server only accepts requests from its own origin.
          origin: input.baseUrl,
          ...(locale ? { "x-rakazo-locale": locale } : {}),
        },
        body: JSON.stringify(body),
        // A session cookie must not land in the app's cookie store.
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AccountOtpError("network");
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = parsed && typeof parsed === "object" && "code" in parsed ? parsed.code : null;
      throw new AccountOtpError(errorKind(response.status, code));
    }
    return parsed;
  }

  return {
    async sendCode(email: string, locale: string): Promise<void> {
      await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }, locale);
    },
    /** Resolves to the address the server verified. A success without one is not a sign-in. */
    async verifyCode(email: string, otp: string): Promise<string> {
      const body = (await post("/api/auth/sign-in/email-otp", { email, otp })) as {
        user?: { email?: unknown };
      } | null;
      const verified = body?.user?.email;
      if (typeof verified !== "string" || verified === "") throw new AccountOtpError("failed");
      return verified;
    },
  };
}

export function accountOtpErrorText(error: unknown, text: Strings["setup"]): string {
  const kind = error instanceof AccountOtpError ? error.kind : "failed";
  const messages: Record<AccountOtpErrorKind, string> = {
    "invalid-code": text.otpInvalid,
    expired: text.otpExpired,
    "not-invited": text.otpNotInvited,
    "rate-limited": text.otpRateLimited,
    network: text.otpNetwork,
    failed: text.otpFailed,
  };
  return messages[kind];
}
