PRAGMA foreign_keys = ON;

-- Game Automation V3 is additive and intentionally has no backfill. Existing
-- V1/V2 rows remain historical and are never auto-registered as V3 work.
CREATE TABLE IF NOT EXISTS game_automation_v3_state (
  internal_game_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled', 'prediction_closed', 'lineup_ready', 'scored', 'ranked', 'published', 'excluded', 'failed', 'manual_action_required')),
  prediction_closed_at TEXT NULL,
  lineup_finalized_at TEXT NULL,
  scoring_revision_id TEXT NULL,
  ranked_at TEXT NULL,
  published_at TEXT NULL,
  excluded_at TEXT NULL,
  failure_code TEXT NULL,
  failure_message TEXT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS game_jobs_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_game_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('prediction_close', 'lineup_fetch', 'lineup_finalize', 'score', 'ranking_rebuild', 'publish', 'probable_starter_fetch', 'roster_fetch')),
  scheduled_at TEXT NOT NULL,
  scheduled_slot_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'retry_wait', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 12 CHECK (max_attempts > 0),
  next_retry_at TEXT NULL,
  claimed_at TEXT NULL,
  claim_token TEXT NULL,
  lease_expires_at TEXT NULL,
  completed_at TEXT NULL,
  failure_code TEXT NULL,
  failure_message TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (internal_game_id, job_type, scheduled_slot_at),
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_game_jobs_v3_due
  ON game_jobs_v3(status, scheduled_at, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_game_jobs_v3_lease
  ON game_jobs_v3(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_game_jobs_v3_game
  ON game_jobs_v3(internal_game_id, job_type, scheduled_slot_at);

CREATE TABLE IF NOT EXISTS game_automation_v3_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_game_id TEXT NOT NULL,
  job_id INTEGER NULL,
  job_type TEXT NOT NULL,
  scheduled_slot_at TEXT NULL,
  claim_id TEXT NULL,
  state_before TEXT NULL,
  state_after TEXT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_code TEXT NULL,
  failure_message TEXT NULL,
  duration_ms INTEGER NULL,
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'cron',
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id) REFERENCES game_jobs_v3(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_game_automation_v3_audit_game
  ON game_automation_v3_audit(internal_game_id, occurred_at DESC);
