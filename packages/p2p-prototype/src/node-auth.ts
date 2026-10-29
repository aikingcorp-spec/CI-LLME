import { randomBytes } from "node:crypto";
import type { KeyPair } from "./pairing.js";
import { nodeAuthorization, verifyAssertion } from "./pairing.js";
import type { NodeId } from "./protocol.js";

export interface NodeSession {
  bearer: string;
  user: string;
  /** Epoch milliseconds; equals the assertion's expiry. */
  expiresAt: number;
}
export interface NodeAuthOptions {
  nodeId: NodeId;
  keyPair: KeyPair;
  /** Pinned at pairing; the only key whose assertions this node accepts. */
  gatewayPublicKey: string;
  /** Gateway users allowed to act on this node. */
  allowedUsers: Iterable<string>;
  clock?: () => number;
  /** Called for each live session that `revokeUser` or `revokeBearer` removes, so its channel can be closed. */
  onRevoke?: (session: NodeSession) => void;
}
export interface NodeAuth {
  /** Authorization header proving this node's identity to the gateway. */
  authorization(): string;
  /** Verifies an assertion and, if it is for this node and an allowed user, mints a bearer for the channel. */
  acceptAssertion(token: string): NodeSession | undefined;
  checkBearer(bearer: string): NodeSession | undefined;
  /** Blocks the user and revokes their bearers. Returns how many sessions were revoked. */
  revokeUser(user: string): number;
  revokeBearer(bearer: string): boolean;
}

const BEARER_BYTES = 32;

export function createNodeAuth(o: NodeAuthOptions): NodeAuth {
  const clock = o.clock ?? Date.now;
  const allowed = new Set(o.allowedUsers);
  const sessions = new Map<string, NodeSession>();
  const timers = new Map<string, NodeJS.Timeout>();

  const revoke = (bearer: string): boolean => {
    const session = sessions.get(bearer);
    if (session === undefined) return false;
    sessions.delete(bearer);
    clearTimeout(timers.get(bearer));
    timers.delete(bearer);
    o.onRevoke?.(session);
    return true;
  };

  const purgeExpired = (): void => {
    for (const [bearer, session] of sessions) if (session.expiresAt <= clock()) revoke(bearer);
  };

  return {
    authorization: () => nodeAuthorization(o.keyPair, o.nodeId, clock()),
    acceptAssertion(token) {
      purgeExpired();
      const claims = verifyAssertion(o.gatewayPublicKey, token, clock());
      if (claims === undefined || claims.nodeId !== o.nodeId || !allowed.has(claims.user)) {
        return undefined;
      }
      const session = {
        bearer: randomBytes(BEARER_BYTES).toString("base64url"),
        user: claims.user,
        expiresAt: claims.exp,
      };
      sessions.set(session.bearer, session);
      const timer = setTimeout(() => revoke(session.bearer), session.expiresAt - clock());
      timer.unref();
      timers.set(session.bearer, timer);
      return { ...session };
    },
    checkBearer(bearer) {
      purgeExpired();
      const session = sessions.get(bearer);
      return session && { ...session };
    },
    revokeUser(user) {
      allowed.delete(user);
      let revoked = 0;
      for (const [bearer, session] of [...sessions]) {
        if (session.user === user && revoke(bearer)) revoked += 1;
      }
      return revoked;
    },
    revokeBearer: revoke,
  };
}
