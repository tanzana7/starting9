PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS game_workflow_state (
  internal_game_id TEXT PRIMARY KEY NOT NULL,
  legacy_game_id TEXT NOT NULL DEFAULT '',
  game_status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (game_status IN ('scheduled', 'postponed', 'cancelled', 'completed')),
  workflow_status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (workflow_status IN ('waiting', 'prediction_open', 'prediction_closed', 'lineup_pending', 'provisional_lineup_captured', 'final_lineup_captured', 'scoring_pending', 'scored_private', 'published', 'retrying', 'service_unavailable', 'manual_intervention_required', 'rescore_pending')),
  workflow_version INTEGER NOT NULL DEFAULT 0 CHECK (workflow_version >= 0),
  last_completed_job_type TEXT NULL,
  last_error_code TEXT NULL,
  last_error_at TEXT NULL,
  next_due_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_game_workflow_state_due
  ON game_workflow_state(game_status, workflow_status, next_due_at);

CREATE TABLE IF NOT EXISTS game_job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_game_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  scheduled_slot_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'running', 'retry_wait', 'succeeded', 'permanently_failed', 'cancelled')),
  source TEXT NOT NULL DEFAULT 'cron' CHECK (source IN ('cron', 'admin', 'system')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 12 CHECK (max_attempts > 0),
  claimed_at TEXT NULL,
  claim_token TEXT NULL,
  lease_expires_at TEXT NULL,
  started_at TEXT NULL,
  completed_at TEXT NULL,
  next_attempt_at TEXT NULL,
  error_code TEXT NULL,
  error_detail TEXT NULL,
  result_metadata TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT,
  UNIQUE(internal_game_id, job_type, scheduled_slot_at)
);

CREATE INDEX IF NOT EXISTS idx_game_job_runs_due
  ON game_job_runs(status, next_attempt_at, lease_expires_at, scheduled_slot_at);
CREATE INDEX IF NOT EXISTS idx_game_job_runs_internal
  ON game_job_runs(internal_game_id, job_type, status);
