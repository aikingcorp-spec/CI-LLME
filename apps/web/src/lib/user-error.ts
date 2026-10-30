import { t } from "@lingui/core/macro";
import {
  ACCOUNT_NOT_LINKED,
  isVoiceAccountErrorCode,
  MODEL_SERVER_STATUS_ERROR,
  MODEL_SERVER_TIMEOUT_ERROR,
  MODEL_SERVER_UNREACHABLE_ERROR,
} from "@rakazo/contracts";
import type { CredentialField } from "@rakazo/core";
import {
  authErrorMessage,
  HOSTED_MODEL_CREDITS_REQUIRED_ERROR,
  MAX_PASSWORD_LENGTH,
  MODEL_IMAGE_INPUT_ERROR,
  MODEL_IMAGE_INPUT_UNKNOWN,
  normalizeRunError,
  userErrorMessage,
} from "@rakazo/core";

/** Localize structured model connection failures returned by the node. */
export function modelConnectionErrorText(message: string): string {
  if (message === "Your model provider rejected the API key. Check your connection settings.")
    return t`Your model provider rejected the API key. Check your connection settings.`;
  if (message === MODEL_SERVER_UNREACHABLE_ERROR)
    return t`Could not reach the model server. Check the server URL.`;
  if (message === MODEL_SERVER_TIMEOUT_ERROR)
    return t`Model server did not respond in time. Check the server URL.`;
  const unanswered = MODEL_SERVER_STATUS_ERROR.exec(message)?.[1];
  if (unanswered) return t`Model server returned ${unanswered}. Check the server URL.`;
  const probe =
    /^Model server returned (\d{3})\. You can still Connect with an explicit model id\.$/.exec(
      message,
    );
  if (probe?.[1]) {
    const status = probe[1];
    return t`Model server returned ${status}. You can still Connect with an explicit model id.`;
  }
  const pins = /^In use by (.+)\. Pick another model for them first\.$/.exec(message);
  if (pins?.[1]) {
    const names = pins[1]
      .split(", ")
      .map((name) =>
        name === "backup models"
          ? t`backup models`
          : name === "main model"
            ? t`main model`
            : name === "approval model"
              ? t`approval model`
              : name,
      )
      .join(", ");
    return t`In use by ${names}. Pick another model for them first.`;
  }
  return message;
}

/** Text for a failure: human messages pass through; network and implementation detail become copy. */
export function errorText(error: unknown, fallback = t`Something went wrong. Try again.`): string {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? error.message
        : undefined;
  if (typeof message === "string") {
    if (message.includes("PLUGIN_SKILL_CONFLICT"))
      return t`This plugin has a skill with the same name as a built-in skill.`;
    if (message.includes("CONNECTOR_TOOL_NAME_CONFLICT"))
      return t`This connector has a tool with the same name as a built-in tool.`;
    const normalized = normalizeRunError(message);
    if (
      normalized.kind === "credit" ||
      normalized.summary === HOSTED_MODEL_CREDITS_REQUIRED_ERROR
    ) {
      return t`Connect your own API key in Models.`;
    }
  }
  if (typeof message === "string" && message.trim() === MODEL_IMAGE_INPUT_ERROR)
    return t`This model cannot read images. Choose a model that supports images.`;
  if (typeof message === "string" && message.trim() === MODEL_IMAGE_INPUT_UNKNOWN)
    return t`Image input is not configured for this model.`;
  if (typeof message === "string" && modelConnectionErrorText(message) !== message)
    return modelConnectionErrorText(message);
  return (
    voiceAccountErrorText(error) ??
    userErrorMessage(error, { fallback, offline: t`Could not reach the server` })
  );
}

/** Text for an RPC error or `/api/voice` body whose code says the voice account needs attention. */
export function voiceAccountErrorText(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (!isVoiceAccountErrorCode(code)) return undefined;
  return code === "VOICE_OUT_OF_CREDIT"
    ? t`Your voice provider is out of credit.`
    : t`Your voice provider key was rejected.`;
}

export function credentialIssueText(field: CredentialField): string {
  return field === "email" ? t`Enter a valid email` : t`Enter a password`;
}

/**
 * HTTP 403 body `{ code: "EMAIL_NOT_INVITED", message: "This email is not invited yet" }`
 * from the auth server when the email is not on the invite list. Same top-level shape
 * as `PASSWORD_AUTH_DISABLED`.
 */
export const EMAIL_NOT_INVITED = "EMAIL_NOT_INVITED";

/** Code from a Better Auth error body (`{ code, message }`), when it has one. */
export function authErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" && error.code ? error.code : undefined;
}

/** Text for a failed Better Auth client result (`{ code, message }`). */
export function authErrorText(error: unknown, fallback: string): string {
  const code = authErrorCode(error);
  if (code === "SSO_UNAVAILABLE") return t`SSO is temporarily unavailable. Try again.`;
  if (code === "account_not_linked" || code === ACCOUNT_NOT_LINKED)
    return t`This email already has an account. Sign in with an email code, then link SSO in Settings.`;
  if (code === "REGISTRATION_CLOSED") return t`Registration is closed`;
  if (code === "EMAIL_NOT_ALLOWED") return t`Email is not allowed to register`;
  if (code === "EMAIL_VERIFICATION_REQUIRED" || code === "unable_to_link_account")
    return t`Email verification required`;
  if (code === "REAUTHENTICATION_REQUIRED") return t`Sign in again`;
  if (code === "PASSWORD_AUTH_DISABLED") return t`Password sign-in is turned off on this server`;
  if (code === "PASSWORD_TOO_LONG")
    return t`Password must be ${MAX_PASSWORD_LENGTH} characters or fewer`;
  if (code === "EMAIL_DELETION_UNAVAILABLE") return t`Could not continue`;
  if (code === EMAIL_NOT_INVITED) return t`VNBot is in limited preview`;
  if (code === "INVALID_OTP") return t`That code isn't right. Check your email and try again.`;
  if (code === "OTP_EXPIRED" || code === "TOO_MANY_ATTEMPTS")
    return t`This code has expired. Send a new one to continue.`;
  return authErrorMessage(error, {
    fallback,
    email: credentialIssueText("email"),
    password: credentialIssueText("password"),
  });
}
