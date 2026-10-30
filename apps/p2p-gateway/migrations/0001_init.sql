-- Timestamps are epoch milliseconds.

CREATE TABLE nodes (
  node_id        TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  user_email     TEXT NOT NULL,
  node_pubkey    TEXT NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL CHECK (kind IN ('windows','linux','macos','vps','unknown')),
  gateway_key_id TEXT NOT NULL,
  paired_at      INTEGER NOT NULL,
  last_seen_at   INTEGER,
  revoked_at     INTEGER
);
CREATE INDEX nodes_user ON nodes(user_id) WHERE revoked_at IS NULL;

CREATE TABLE pair_codes (
  code_hash  TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  user_email TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- App token ids already spent on a state-changing route, kept until the token itself expires.
CREATE TABLE used_jti (
  jti TEXT PRIMARY KEY,
  exp INTEGER NOT NULL
);
