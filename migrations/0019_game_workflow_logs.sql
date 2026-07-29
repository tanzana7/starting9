CREATE TABLE IF NOT EXISTS game_workflow_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'warning', 'error', 'info')),
  game_id TEXT,
  occurred_at TEXT NOT NULL,
  message TEXT NOT NULL,
  error_code TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL CHECK (source IN ('cron', 'admin', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_game_workflow_logs_occurred_at
  ON game_workflow_logs (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_workflow_logs_game_id
  ON game_workflow_logs (game_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_workflow_logs_event_type
  ON game_workflow_logs (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_workflow_logs_status
  ON game_workflow_logs (status, occurred_at DESC);

CREATE TABLE IF NOT EXISTS game_workflow_log_maintenance (
  maintenance_key TEXT PRIMARY KEY,
  last_cleanup_at TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE game_automation_health ADD COLUMN prediction_target_game_id TEXT;
ALTER TABLE game_automation_health ADD COLUMN prediction_target_no_next_logged_at TEXT;
