import type { Pool } from "@rakazo/db";
import { expect, it } from "vitest";
import { createMessagingInboundLeadership } from "./messaging-inbound-lock.js";

type Listener = ((...args: unknown[]) => void) & { listener?: Listener };

function createClient(held: Map<string, object>) {
  const queries: string[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const client = {
    queries,
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      if (sql.includes("pg_try_advisory_lock")) {
        const connectionId = String(params?.[1]);
        const owner = held.get(connectionId);
        if (owner && owner !== client) return { rows: [{ acquired: false }] };
        held.set(connectionId, client);
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        const connectionId = String(params?.[1]);
        const released = held.get(connectionId) === client;
        if (released) held.delete(connectionId);
        return { rows: [{ released }] };
      }
      if (sql.startsWith("LISTEN") || sql.startsWith("UNLISTEN")) return { rows: [] };
      if (sql.includes("pg_notify")) return { rows: [] };
      throw new Error(`unexpected sql ${sql}`);
    },
    release(_destroy?: boolean) {
      return undefined;
    },
    on(event: string, callback: Listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(callback);
      listeners.set(event, set);
      return client;
    },
    once(event: string, callback: Listener) {
      const wrapped: Listener = (...args) => {
        client.removeListener(event, wrapped);
        callback(...args);
      };
      wrapped.listener = callback;
      return client.on(event, wrapped);
    },
    removeListener(event: string, callback: Listener) {
      const set = listeners.get(event);
      if (!set) return;
      for (const item of [...set]) {
        if (item === callback || item.listener === callback) set.delete(item);
      }
    },
    emit(event: string, ...args: unknown[]) {
      for (const callback of [...(listeners.get(event) ?? [])]) callback(...args);
    },
  };
  return client;
}

it("drops listen state before a session returns to the pool and can be acquired again", async () => {
  const held = new Map<string, object>();
  const client = createClient(held);
  let checkedOut = false;
  const pool = {
    async connect() {
      if (checkedOut) throw new Error("client is already checked out");
      checkedOut = true;
      return client;
    },
  };
  client.release = () => {
    checkedOut = false;
  };
  const leadership = createMessagingInboundLeadership(pool as unknown as Pick<Pool, "connect">);
  const seen: string[] = [];
  leadership.onNotify((payload) => {
    seen.push(payload);
  });
  expect(await leadership.tryAcquire("telegram")).toBe(true);
  expect(client.queries.some((sql) => sql.startsWith("LISTEN"))).toBe(true);
  await leadership.release("telegram");
  expect(client.queries.some((sql) => sql.startsWith("UNLISTEN"))).toBe(true);
  expect(client.listenerCount("notification")).toBe(0);
  expect(checkedOut).toBe(false);
  client.emit("notification", { channel: "messaging_connection", payload: "other telegram" });
  expect(seen).toEqual([]);
  expect(await leadership.tryAcquire("telegram")).toBe(true);
  client.emit("notification", { channel: "messaging_connection", payload: "leader telegram" });
  expect(seen).toEqual(["leader telegram"]);
  expect(client.listenerCount("notification")).toBe(1);
});

it("does not listen when the lock belongs to another session", async () => {
  const held = new Map<string, object>();
  const clients = [createClient(held), createClient(held)];
  let index = 0;
  const pool = {
    async connect() {
      const client = clients[index];
      index += 1;
      if (!client) throw new Error("pool exhausted");
      return client;
    },
  };
  const leader = createMessagingInboundLeadership(pool as unknown as Pick<Pool, "connect">);
  const follower = createMessagingInboundLeadership(pool as unknown as Pick<Pool, "connect">);
  expect(await leader.tryAcquire("telegram")).toBe(true);
  expect(await follower.tryAcquire("telegram")).toBe(false);
  expect(clients[1]?.queries.some((sql) => sql.startsWith("LISTEN"))).toBe(false);
  expect(clients[1]?.listenerCount("notification")).toBe(0);
  expect(held.has("telegram")).toBe(true);
});
