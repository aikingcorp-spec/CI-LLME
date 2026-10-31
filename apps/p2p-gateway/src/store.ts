import { PAIR_CODE_TTL_MS } from "./pairing.js";

/** All SQL of the gateway. Timestamps are epoch milliseconds. Pairing data lives here, never in a Durable Object. */

export const NODE_KINDS = ["windows", "linux", "macos", "vps", "unknown"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export interface NodeRow {
  node_id: string;
  user_id: string;
  user_email: string;
  node_pubkey: string;
  name: string;
  kind: NodeKind;
  gateway_key_id: string;
  paired_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}
export interface PairedUser {
  id: string;
  email: string;
}
export interface NewNode {
  nodeId: string;
  user: PairedUser;
  publicKey: string;
  name: string;
  kind: NodeKind;
  gatewayKeyId: string;
}

/** Most nodes one listing asks a Durable Object about; the Workers Free plan allows 50 subrequests. */
export const MAX_LISTED_NODES = 40;

export async function issuePairCode(
  db: D1Database,
  codeHash: string,
  user: PairedUser,
  nowMs: number,
): Promise<number> {
  const expiresAt = nowMs + PAIR_CODE_TTL_MS;
  await db.batch([
    db.prepare("DELETE FROM pair_codes WHERE expires_at <= ?1").bind(nowMs),
    db
      .prepare(
        "INSERT INTO pair_codes (code_hash, user_id, user_email, expires_at) VALUES (?1, ?2, ?3, ?4)",
      )
      .bind(codeHash, user.id, user.email, expiresAt),
  ]);
  return expiresAt;
}

/** Spends the code. Returns the user that issued it, or undefined for an unknown, used or expired code. */
export async function redeemPairCode(
  db: D1Database,
  codeHash: string,
  nowMs: number,
): Promise<PairedUser | undefined> {
  const row = await db
    .prepare(
      "DELETE FROM pair_codes WHERE code_hash = ?1 RETURNING user_id, user_email, expires_at",
    )
    .bind(codeHash)
    .first<{ user_id: string; user_email: string; expires_at: number }>();
  return row !== null && row.expires_at > nowMs
    ? { id: row.user_id, email: row.user_email }
    : undefined;
}

export async function nodeExists(db: D1Database, nodeId: string): Promise<boolean> {
  return (
    (await db.prepare("SELECT 1 AS found FROM nodes WHERE node_id = ?1").bind(nodeId).first()) !==
    null
  );
}

/** False when the node id is already taken. */
export async function insertNode(db: D1Database, n: NewNode, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO nodes
         (node_id, user_id, user_email, node_pubkey, name, kind, gateway_key_id, paired_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(n.nodeId, n.user.id, n.user.email, n.publicKey, n.name, n.kind, n.gatewayKeyId, nowMs)
    .run();
  return result.meta.changes === 1;
}

/** The node when it exists and is not revoked. */
export async function activeNode(db: D1Database, nodeId: string): Promise<NodeRow | undefined> {
  const row = await db
    .prepare("SELECT * FROM nodes WHERE node_id = ?1 AND revoked_at IS NULL")
    .bind(nodeId)
    .first<NodeRow>();
  return row ?? undefined;
}

export async function ownedActiveNode(
  db: D1Database,
  userId: string,
  nodeId: string,
): Promise<NodeRow | undefined> {
  const node = await activeNode(db, nodeId);
  return node?.user_id === userId ? node : undefined;
}

export async function listUserNodes(db: D1Database, userId: string): Promise<NodeRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM nodes WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY paired_at DESC LIMIT ?2",
    )
    .bind(userId, MAX_LISTED_NODES)
    .all<NodeRow>();
  return results;
}

/** Revoking twice is fine. False when the user does not own the node. */
export async function revokeNode(
  db: D1Database,
  userId: string,
  nodeId: string,
  nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE nodes SET revoked_at = COALESCE(revoked_at, ?1) WHERE node_id = ?2 AND user_id = ?3",
    )
    .bind(nowMs, nodeId, userId)
    .run();
  return result.meta.changes === 1;
}

export async function touchLastSeen(db: D1Database, nodeId: string, nowMs: number): Promise<void> {
  await db.prepare("UPDATE nodes SET last_seen_at = ?1 WHERE node_id = ?2").bind(nowMs, nodeId).run();
}

/** Records a token id once. False when it was already used. Expired ids are dropped on the way. */
export async function useTokenId(
  db: D1Database,
  jti: string,
  expMs: number,
  nowMs: number,
): Promise<boolean> {
  const [, insert] = await db.batch([
    db.prepare("DELETE FROM used_jti WHERE exp <= ?1").bind(nowMs),
    db.prepare("INSERT OR IGNORE INTO used_jti (jti, exp) VALUES (?1, ?2)").bind(jti, expMs),
  ]);
  return insert?.meta.changes === 1;
}
