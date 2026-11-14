import { randomUUID } from "node:crypto";
import type { Pool } from "@rakazo/db";
import { createPool } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import type { MessagingInboundLeadership } from "./messaging-inbound-lock.js";
import { createMessagingInboundLeadership } from "./messaging-inbound-lock.js";

const suite =
  process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL ? describe : describe.skip;

suite("messaging leadership on PostgreSQL sessions", () => {
  const pools: Pool[] = [];
  const releases: Array<() => Promise<void>> = [];

  function participant(connectionId: string) {
    const pool = createPool(process.env.DATABASE_URL!, { poolMax: 2 });
    pools.push(pool);
    const leadership = createMessagingInboundLeadership(pool);
    releases.push(() => leadership.release(connectionId));
    return { pool, leadership };
  }

  afterEach(async () => {
    for (const release of releases.splice(0)) await release();
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it("excludes a second receiver for one connection and lets other connections proceed", async () => {
    const connectionId = randomUUID();
    const first = participant(connectionId);
    const second = participant(connectionId);
    const independent = participant(randomUUID());
    const independentId = randomUUID();
    releases.push(() => independent.leadership.release(independentId));

    expect(await first.leadership.tryAcquire(connectionId)).toBe(true);
    expect(await second.leadership.tryAcquire(connectionId)).toBe(false);
    expect(await independent.leadership.tryAcquire(independentId)).toBe(true);
    await first.leadership.release(connectionId);
    expect(await second.leadership.tryAcquire(connectionId)).toBe(true);
    expect(await first.leadership.tryAcquire(connectionId)).toBe(false);
  });

  it("lets a peer receive after the owner's database session is terminated", async () => {
    const connectionId = randomUUID();
    const owner = participant(connectionId);
    const peer = participant(connectionId);
    let ownerPid = 0;
    owner.pool.once("acquire", (client) => {
      ownerPid = client.processID;
    });
    expect(await owner.leadership.tryAcquire(connectionId)).toBe(true);
    expect(ownerPid).toBeGreaterThan(0);
    expect(await peer.leadership.tryAcquire(connectionId)).toBe(false);
    const lost = new Promise<void>((resolve) => owner.leadership.onLost(connectionId, resolve));
    const terminated = await peer.pool.query<{ stopped: boolean }>(
      "SELECT pg_terminate_backend($1) AS stopped",
      [ownerPid],
    );
    expect(terminated.rows[0]?.stopped).toBe(true);
    await lost;
    expect(await peer.leadership.tryAcquire(connectionId)).toBe(true);
    expect(await owner.leadership.tryAcquire(connectionId)).toBe(false);
  });

  it("delivers notices only while listening and returns a clean session to the pool", async () => {
    const connectionId = randomUUID();
    // One pooled connection guarantees that the borrow after release is the same session.
    const pool = createPool(process.env.DATABASE_URL!, { poolMax: 1 });
    pools.push(pool);
    const leadership: MessagingInboundLeadership = createMessagingInboundLeadership(pool);
    releases.push(() => leadership.release(connectionId));
    const sender = participant(connectionId);
    const seen: string[] = [];
    let pid = 0;
    pool.once("acquire", (client) => {
      pid = client.processID;
    });
    const received = new Promise<void>((resolve) => {
      leadership.onNotify((payload) => {
        seen.push(payload);
        resolve();
      });
    });
    expect(await leadership.tryAcquire(connectionId)).toBe(true);
    await sender.leadership.notify(connectionId);
    await received;
    expect(seen).toEqual([connectionId]);
    await leadership.release(connectionId);
    const borrowed = await pool.connect();
    try {
      const backend = await borrowed.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      expect(backend.rows[0]?.pid).toBe(pid);
      expect(borrowed.listenerCount("notification")).toBe(0);
      const channels = await borrowed.query("SELECT pg_listening_channels() AS channel");
      expect(channels.rows).toEqual([]);
      await sender.leadership.notify(`${connectionId}:after-release`);
      await borrowed.query("SELECT 1");
      expect(seen).toEqual([connectionId]);
    } finally {
      borrowed.release();
    }
  });
});
