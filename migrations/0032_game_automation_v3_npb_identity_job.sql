-- game_jobs_v3 has a CHECK constraint on job_type, so the table must be
-- rebuilt to add the identity-resolution job without changing existing rows.
CREATE TABLE game_jobs_v3_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_game_id TEXT NOT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('npb_identity_resolve', 'prediction_close', 'lineup_fetch', 'lineup_finalize', 'score', 'ranking_rebuild', 'publish', 'probable_starter_fetch', 'roster_fetch')),
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

INSERT INTO game_jobs_v3_next (
  id, internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
  attempt_count, max_attempts, next_retry_at, claimed_at, claim_token,
  lease_expires_at, completed_at, failure_code, failure_message, created_at, updated_at
)
SELECT id, internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
       attempt_count, max_attempts, next_retry_at, claimed_at, claim_token,
       lease_expires_at, completed_at, failure_code, failure_message, created_at, updated_at
  FROM game_jobs_v3;

ALTER TABLE game_automation_v3_audit RENAME TO game_automation_v3_audit_old;

CREATE TABLE game_automation_v3_audit (
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
  event_type TEXT NOT NULL DEFAULT 'job',
  previous_npb_game_code TEXT NULL,
  next_npb_game_code TEXT NULL,
  updated_by TEXT NULL,
  previous_npb_game_url TEXT NULL,
  next_npb_game_url TEXT NULL,
  previous_npb_identity_status TEXT NULL,
  next_npb_identity_status TEXT NULL,
  previous_npb_identity_source TEXT NULL,
  next_npb_identity_source TEXT NULL,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id) REFERENCES game_jobs_v3_next(id) ON DELETE SET NULL
);

INSERT INTO game_automation_v3_audit (
  id, internal_game_id, job_id, job_type, scheduled_slot_at, claim_id,
  state_before, state_after, attempt_count, failure_code, failure_message,
  duration_ms, occurred_at, source, event_type, previous_npb_game_code,
  next_npb_game_code, updated_by, previous_npb_game_url, next_npb_game_url,
  previous_npb_identity_status, next_npb_identity_status,
  previous_npb_identity_source, next_npb_identity_source
)
SELECT id, internal_game_id, job_id, job_type, scheduled_slot_at, claim_id,
       state_before, state_after, attempt_count, failure_code, failure_message,
       duration_ms, occurred_at, source, event_type, previous_npb_game_code,
       next_npb_game_code, updated_by, previous_npb_game_url, next_npb_game_url,
       previous_npb_identity_status, next_npb_identity_status,
       previous_npb_identity_source, next_npb_identity_source
  FROM game_automation_v3_audit_old;

DROP TABLE game_automation_v3_audit_old;
DROP TABLE game_jobs_v3;
ALTER TABLE game_jobs_v3_next RENAME TO game_jobs_v3;

CREATE INDEX IF NOT EXISTS idx_game_jobs_v3_due
  ON game_jobs_v3(status, scheduled_at, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_game_jobs_v3_lease
  ON game_jobs_v3(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_game_jobs_v3_game
  ON game_jobs_v3(internal_game_id, job_type, scheduled_slot_at);
CREATE INDEX IF NOT EXISTS idx_game_automation_v3_audit_game
  ON game_automation_v3_audit(internal_game_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_automation_v3_audit_event
  ON game_automation_v3_audit(event_type, occurred_at DESC);
