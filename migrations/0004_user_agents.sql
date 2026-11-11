-- v4: keep the raw user agent of every heartbeat (stored once per distinct value),
-- so improvements to the parser can re-read old data instead of guessing.
CREATE TABLE IF NOT EXISTS user_agents (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL UNIQUE
);
ALTER TABLE heartbeats ADD COLUMN user_agent_id INTEGER;
CREATE INDEX IF NOT EXISTS heartbeats_user_agent ON heartbeats (user_agent_id);
