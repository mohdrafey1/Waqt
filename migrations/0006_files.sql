-- Time per file and branch, so a project can be opened to see where the time went.
-- Paths are stored relative to the project folder. Rebuilt from raw heartbeats.
CREATE TABLE IF NOT EXISTS daily_files (
  day TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'live',
  project TEXT NOT NULL,
  branch TEXT NOT NULL,
  entity TEXT NOT NULL,
  seconds REAL NOT NULL,
  PRIMARY KEY (day, source, project, branch, entity)
) WITHOUT ROWID;

INSERT INTO settings (key, value) VALUES ('needs_rebuild', '1')
  ON CONFLICT(key) DO UPDATE SET value = '1';
