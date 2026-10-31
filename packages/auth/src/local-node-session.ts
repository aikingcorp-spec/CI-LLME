import { localNodeSessionBody } from "@rakazo/contracts";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { isAllowlistEmail, normalizeEmail } from "./email-allowlist.js";

/**
 * Opens a session for an address the desktop app already verified against the account server. The
 * endpoint is server-only, so no HTTP request reaches it; the API exposes it only behind the
 * private stack token. The signup policy and the session hooks still apply.
 */
export const localNodeSession = {
  id: "local-node-session",
  endpoints: {
    mintLocalNodeSession: createAuthEndpoint(
      "/local-node-session",
      {
        method: "POST",
        metadata: { SERVER_ONLY: true },
        body: localNodeSessionBody,
      },
      async (ctx) => {
        const email = normalizeEmail(ctx.body.email);
        if (!isAllowlistEmail(email)) throw new APIError("BAD_REQUEST");
        const adapter = ctx.context.internalAdapter;
        const found = await adapter.findUserByEmail(email);
        const user =
          found?.user ??
          (await adapter.createUser(
            { email, emailVerified: true, name: email.split("@")[0] || "User" },
            // The address reached this node through the account server's email code.
            { method: "email-otp" },
          ));
        const verified = user.emailVerified
          ? user
          : await adapter.updateUser(user.id, { emailVerified: true });
        const session = await adapter.createSession(verified.id);
        await setSessionCookie(ctx, { session, user: verified });
        return ctx.json({ ok: true });
      },
    ),
  },
} satisfies BetterAuthPlugin;
