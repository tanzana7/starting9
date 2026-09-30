-- Cron invocation health is operational state, not an audit history.
-- Keep exactly one nullable row so a normal minute does not append history.
CREATE TABLE IF NOT EXISTS cron_heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_invocation_at TEXT NULL,
  last_completed_at TEXT NULL,
  last_failed_at TEXT NULL,
  last_outcome TEXT NULL CHECK (last_outcome IN ('completed', 'failed')),
  updated_at TEXT NOT NULL
);
