const TURN_REQUESTS_PER_MINUTE = 10;
const WINDOW_MS = 60_000;

/** Shared across Worker isolates. An atomic increment prevents concurrent over-issuance. */
export async function turnRateLimit(
  db: D1Database,
  identity: string,
  now: number,
): Promise<number> {
  await db.prepare("DELETE FROM turn_rate_limits WHERE expires_at <= ?1").bind(now).run();
  const row = await db
    .prepare(`INSERT INTO turn_rate_limits (identity, requests, expires_at) VALUES (?1, 1, ?2)
      ON CONFLICT(identity) DO UPDATE SET requests = requests + 1
      RETURNING requests, expires_at`)
    .bind(identity, now + WINDOW_MS)
    .first<{ requests: number; expires_at: number }>();
  if (row === null) throw new Error("TURN rate limit unavailable");
  return row.requests > TURN_REQUESTS_PER_MINUTE
    ? Math.max(1, Math.ceil((row.expires_at - now) / 1000))
    : 0;
}
