import { z } from "zod";

export const authCapabilitiesSchema = z.object({
  sso: z
    .object({
      name: z.string().min(1),
      availability: z.enum(["available", "unavailable", "checking"]),
    })
    .nullable(),
  passwordAuth: z.boolean(),
  passwordReset: z.boolean(),
  resetUrl: z.string().url().nullable(),
  // Older servers omit this field; clients treat omission as unavailable.
  emailCode: z.boolean().optional(),
  billing: z.boolean().optional(),
  /** WebAuthn relying party ID; null or omitted when this server does not offer passkeys. */
  passkeyRpId: z.string().min(1).nullable().optional(),
  /** Native apps this domain vouches for; omitted by older servers, which means none. */
  nativePasskeys: z.object({ ios: z.boolean(), android: z.boolean() }).optional(),
  /** Crisp chat on the paywall; null or omitted when the deployment offers none. */
  crispWebsiteId: z.string().min(1).nullable().optional(),
});
export type AuthCapabilities = z.infer<typeof authCapabilitiesSchema>;

export const accountSecuritySchema = z.object({
  hasPassword: z.boolean(),
  // Older servers omit this field; clients treat omission as enabled.
  passwordChangeEnabled: z.boolean().optional(),
  freshOidcAuth: z.boolean(),
  ssoLinked: z.boolean(),
  emailDeletion: z.boolean(),
  sso: z.object({ name: z.string().min(1) }).nullable(),
});
export type AccountSecurity = z.infer<typeof accountSecuritySchema>;

/** Only a complete pre-SSO shape may opt into password-only compatibility. */
export const legacyAuthCapabilitiesSchema = authCapabilitiesSchema
  .omit({ sso: true, passwordAuth: true })
  .strict()
  .transform((value) => ({ ...value, passwordAuth: true, sso: null }));

/** Pre-SSO servers only had credential accounts and password-protected deletion. */
export const legacyAccountSecurity: AccountSecurity = {
  hasPassword: true,
  passwordChangeEnabled: true,
  freshOidcAuth: false,
  ssoLinked: false,
  emailDeletion: false,
  sso: null,
};

/**
 * HTTP 403 from the auth server when the invite list is on and the address is
 * not in it. The body is `{ "code": "EMAIL_NOT_INVITED", "message": "..." }`.
 * Clients map the code; the English message is not the UI string.
 */
export const EMAIL_NOT_INVITED = "EMAIL_NOT_INVITED";

/**
 * The SSO callback ends at `<web origin>/sign-in?error=ACCOUNT_NOT_LINKED` when
 * the provider email already belongs to another account. SSO never links by
 * itself; the person signs in with an email code and links SSO in Settings.
 */
export const ACCOUNT_NOT_LINKED = "ACCOUNT_NOT_LINKED";

/** Client copy for auth error codes that have no server message. */
export const AUTH_ERROR_MESSAGES = {
  ACCOUNT_NOT_LINKED: {
    vi: "Email này đã có tài khoản. Hãy đăng nhập bằng mã email rồi liên kết SSO trong Cài đặt.",
    en: "This email already has an account. Sign in with an email code, then link SSO in Settings.",
  },
} as const;

/**
 * The RPC error code for a sensitive action the session must confirm its
 * identity for first. Clients confirm, then retry the action once.
 */
export const IDENTITY_CONFIRMATION_REQUIRED = "IDENTITY_CONFIRMATION_REQUIRED";

export function isIdentityConfirmationRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === IDENTITY_CONFIRMATION_REQUIRED
  );
}

/**
 * Runs an action that may need a recent identity confirmation. When the server asks for one,
 * `confirm` prompts; once confirmed, the action is retried a single time.
 * A dismissed prompt rethrows the server's error.
 */
export async function runWithIdentityConfirmation<T>(
  action: () => Promise<T>,
  confirm: () => Promise<boolean>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isIdentityConfirmationRequired(error) || !(await confirm())) throw error;
  }
  return action();
}
