-- Additive: previous gateway releases do not read or write this table.
CREATE TABLE turn_rate_limits (
  identity TEXT PRIMARY KEY,
  requests INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX turn_rate_limits_expiry ON turn_rate_limits(expires_at);
