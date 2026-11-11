-- v5: estimated daily usage against Cloudflare's free-plan limits (days are UTC,
-- because that's when the limits reset).
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  db_size INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
