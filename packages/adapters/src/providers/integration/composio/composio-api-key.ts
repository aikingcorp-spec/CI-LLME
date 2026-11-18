import { ClientError } from "@rakazo/core";

const ENV_ASSIGNMENT_PREFIX =
  /^(?:export\s+)?(?:COMPOSIO_API_KEY|X-API-KEY|AUTHORIZATION)\s*[=:]\s*/i;
const BEARER_PREFIX = /^Bearer\s+/i;

/**
 * Strips common copy-paste wrappers from a pasted Composio API key (such as
 * `COMPOSIO_API_KEY=ak_...` from Dashboard Getting Started or surrounding quotes)
 * that are invisible inside a masked password input.
 */
export function normalizeComposioApiKey(raw: string): string {
  let value = raw.trim();
  value = value.replace(ENV_ASSIGNMENT_PREFIX, "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(BEARER_PREFIX, "").trim();
  return value;
}

/**
 * Rejects Composio "For You" consumer keys (`ck_...`) with actionable guidance
 * without echoing the submitted secret.
 */
export function assertComposioProjectApiKey(apiKey: string): void {
  if (/^ck_/i.test(apiKey)) {
    throw new ClientError(
      "BAD_REQUEST",
      "This is a Composio For You consumer key (ck_…). Paste a Project API key (ak_…) from Project Settings → API Keys.",
    );
  }
}
