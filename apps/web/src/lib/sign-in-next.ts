export const MCP_OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
export const SLACK_INSTALL_CALLBACK_PATH = "/messaging/slack/callback";

const INVITE_PATH = /^\/invite\/[A-Za-z0-9_-]{1,200}$/;
const REMOTE_JOIN_PATH = "/remote-join";

/** The page sign-in or sign-up may return to; anything else is ignored, so `next` can't redirect off the app. */
export function signInNext(next: string | null): string | null {
  if (!next) return null;
  // A connector sign-in started on another device lands here signed out; finish it after sign-in.
  if (
    next === "/integrations/setup" ||
    next === "/admin/plugins" ||
    next === "/admin/access" ||
    next === REMOTE_JOIN_PATH ||
    next.startsWith(`${MCP_OAUTH_CALLBACK_PATH}?`) ||
    next.startsWith(`${SLACK_INSTALL_CALLBACK_PATH}?`) ||
    INVITE_PATH.test(next)
  ) {
    return next;
  }
  return null;
}

/** Where a new account starts: an invite or host handoff it came for, otherwise onboarding. */
export function newAccountDestination(next: string | null): string {
  if (next && (INVITE_PATH.test(next) || next === REMOTE_JOIN_PATH)) return next;
  return "/onboarding";
}

/** Page opened after the host accepts a remote ticket. Anything else stays in the app. */
export function remoteEnterDestination(invite: string | undefined): string {
  if (!invite || !INVITE_PATH.test(`/invite/${invite}`)) return "/app";
  return `/invite/${invite}`;
}
