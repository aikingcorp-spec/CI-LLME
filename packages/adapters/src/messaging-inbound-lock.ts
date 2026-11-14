import type { Pool } from "@rakazo/db";
import type { PoolClient } from "pg";

const LOCK_NAMESPACE = "rakazo:messaging-inbound";
const NOTIFY_CHANNEL = "messaging_connection";

type Notice = (message: { channel: string; payload?: string }) => void;

export interface MessagingInboundLeadership {
  tryAcquire(connectionId: string): Promise<boolean>;
  release(connectionId: string): Promise<void>;
  /** Publishes `payload` to every session listening on this leadership. */
  notify(payload: string): Promise<void>;
  onNotify(listener: (payload: string) => void): () => void;
  /** Fires when the session that holds `connectionId` drops. The lock is already gone. */
  onLost(connectionId: string, listener: () => void): () => void;
}

interface HeldSession {
  client: PoolClient;
  onError: () => void;
  onNotification: Notice;
}

/**
 * One session advisory lock per connection. The session that holds it is the only
 * inbound poller. Closing the session, or losing it, releases the lock so another
 * API process can take that connection. Transaction locks cannot do this: they end
 * before the poll, which has to stay open.
 */
export function createMessagingInboundLeadership(
  pool: Pick<Pool, "connect">,
): MessagingInboundLeadership {
  const sessions = new Map<string, HeldSession>();
  const notifyListeners = new Set<(payload: string) => void>();
  const lostListeners = new Map<string, Set<() => void>>();

  const detach = (session: HeldSession) => {
    session.client.removeListener("error", session.onError);
    session.client.removeListener("notification", session.onNotification);
  };

  const dropSession = (connectionId: string, client: PoolClient) => {
    const current = sessions.get(connectionId);
    if (!current || current.client !== client) return;
    sessions.delete(connectionId);
    detach(current);
    client.release(true);
    for (const listener of lostListeners.get(connectionId) ?? []) listener();
  };

  return {
    async tryAcquire(connectionId) {
      const current = sessions.get(connectionId);
      if (current) return true;
      const candidate = await pool.connect();
      let onError: (() => void) | undefined;
      let onNotification: Notice | undefined;
      try {
        const result = await candidate.query<{ acquired: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired",
          [LOCK_NAMESPACE, connectionId],
        );
        if (!result.rows[0]?.acquired) {
          candidate.release();
          return false;
        }
        await candidate.query(`LISTEN ${NOTIFY_CHANNEL}`);
        onError = () => dropSession(connectionId, candidate);
        onNotification = (message) => {
          if (message.channel !== NOTIFY_CHANNEL || !message.payload) return;
          for (const listener of notifyListeners) listener(message.payload);
        };
        candidate.once("error", onError);
        candidate.on("notification", onNotification);
        sessions.set(connectionId, { client: candidate, onError, onNotification });
        return true;
      } catch (error) {
        if (onError) candidate.removeListener("error", onError);
        if (onNotification) candidate.removeListener("notification", onNotification);
        candidate.release(true);
        throw error;
      }
    },

    async release(connectionId) {
      const current = sessions.get(connectionId);
      if (!current) return;
      sessions.delete(connectionId);
      detach(current);
      let destroy = false;
      try {
        await current.client.query(`UNLISTEN ${NOTIFY_CHANNEL}`);
      } catch {
        destroy = true;
      }
      try {
        const result = await current.client.query<{ released: boolean }>(
          "SELECT pg_advisory_unlock(hashtext($1), hashtext($2)) AS released",
          [LOCK_NAMESPACE, connectionId],
        );
        if (result.rows[0]?.released !== true) destroy = true;
      } catch {
        destroy = true;
      } finally {
        current.client.release(destroy);
      }
    },

    async notify(payload) {
      const client = await pool.connect();
      try {
        await client.query("SELECT pg_notify($1, $2)", [NOTIFY_CHANNEL, payload]);
      } finally {
        client.release();
      }
    },

    onNotify(listener) {
      notifyListeners.add(listener);
      return () => notifyListeners.delete(listener);
    },

    onLost(connectionId, listener) {
      const listeners = lostListeners.get(connectionId) ?? new Set();
      listeners.add(listener);
      lostListeners.set(connectionId, listeners);
      return () => listeners.delete(listener);
    },
  };
}
