-- v2: hour-of-day charts, AI insights, imported history and forwarding retries.

-- More detail from AI coding tools (sent by the WakaTime CLI).
ALTER TABLE heartbeats ADD COLUMN ai_model TEXT NOT NULL DEFAULT '';
ALTER TABLE heartbeats ADD COLUMN ai_session TEXT NOT NULL DEFAULT '';
ALTER TABLE heartbeats ADD COLUMN ai_input_tokens INTEGER;
ALTER TABLE heartbeats ADD COLUMN ai_output_tokens INTEGER;
ALTER TABLE heartbeats ADD COLUMN ai_cached_tokens INTEGER;
ALTER TABLE heartbeats ADD COLUMN ai_prompt_length INTEGER;

-- Summaries now record where they came from: 'live' (rebuilt from raw heartbeats)
-- or 'import' (WakaTime history). Rebuilding a day only replaces its live rows.
CREATE TABLE daily_summaries_v2 (
  day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  project TEXT NOT NULL,
  language TEXT NOT NULL,
  editor TEXT NOT NULL,
  os TEXT NOT NULL,
  machine TEXT NOT NULL,
  category TEXT NOT NULL,
  seconds REAL NOT NULL,
  ai_lines INTEGER NOT NULL DEFAULT 0,
  human_lines INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, project, language, editor, os, machine, category)
) WITHOUT ROWID;
INSERT INTO daily_summaries_v2 (day, source, project, language, editor, os, machine, category, seconds, ai_lines, human_lines)
  SELECT day, 'live', project, language, editor, os, machine, category, seconds, ai_lines, human_lines FROM daily_summaries;
DROP TABLE daily_summaries;
ALTER TABLE daily_summaries_v2 RENAME TO daily_summaries;

-- Coding time per local hour of each day.
CREATE TABLE IF NOT EXISTS daily_hours (
  day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  hour INTEGER NOT NULL,
  seconds REAL NOT NULL,
  PRIMARY KEY (day, source, hour)
) WITHOUT ROWID;

-- AI usage per day and model.
CREATE TABLE IF NOT EXISTS daily_ai (
  day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  model TEXT NOT NULL,
  seconds REAL NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  prompts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  ai_lines INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, model)
) WITHOUT ROWID;

-- Heartbeats that couldn't be forwarded to WakaTime yet; retried by the cron job.
CREATE TABLE IF NOT EXISTS forward_queue (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  headers TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS forward_queue_next ON forward_queue (next_at);

-- Ask the cron job to rebuild existing days once, so they get hours and AI data.
INSERT INTO settings (key, value) VALUES ('needs_rebuild', '1')
  ON CONFLICT(key) DO UPDATE SET value = '1';
