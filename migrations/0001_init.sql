-- Raw activity sent by the WakaTime editor plugins.
-- Kept for `raw_retention_days` (default 365), then removed by the cron job.
-- Daily summaries below are kept forever, so your full history survives.
CREATE TABLE IF NOT EXISTS heartbeats (
  id INTEGER PRIMARY KEY,
  time REAL NOT NULL,
  entity TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'file',
  category TEXT NOT NULL DEFAULT 'coding',
  project TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  editor TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  machine TEXT NOT NULL DEFAULT '',
  is_write INTEGER NOT NULL DEFAULT 0,
  lines INTEGER,
  ai_line_changes INTEGER,
  human_line_changes INTEGER
);

-- Also stops duplicates when the CLI retries a request.
CREATE UNIQUE INDEX IF NOT EXISTS heartbeats_time_entity ON heartbeats (time, entity);

-- One row per day per (project, language, editor, os, machine, category).
CREATE TABLE IF NOT EXISTS daily_summaries (
  day TEXT NOT NULL,
  project TEXT NOT NULL,
  language TEXT NOT NULL,
  editor TEXT NOT NULL,
  os TEXT NOT NULL,
  machine TEXT NOT NULL,
  category TEXT NOT NULL,
  seconds REAL NOT NULL,
  ai_lines INTEGER NOT NULL DEFAULT 0,
  human_lines INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, project, language, editor, os, machine, category)
) WITHOUT ROWID;

-- Days whose summaries need recalculating after new heartbeats arrive.
CREATE TABLE IF NOT EXISTS dirty_days (
  day TEXT PRIMARY KEY,
  marked_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

-- Short-lived cache for public stats, so README cards and embeds
-- on busy websites don't eat into the free D1 read allowance.
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires INTEGER NOT NULL
) WITHOUT ROWID;
