-- Audit storage is diagnostic-only and intentionally has no foreign keys to
-- the core D1. A missing or delayed core record must never block formal V3
-- state transitions, scoring, ranking, or publication.
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
  event_type TEXT NOT NULL DEFAULT 'job',
  data_status TEXT NULL,
  previous_npb_game_code TEXT NULL,
  next_npb_game_code TEXT NULL,
  updated_by TEXT NULL,
  previous_npb_game_url TEXT NULL,
  next_npb_game_url TEXT NULL,
  previous_npb_identity_status TEXT NULL,
  next_npb_identity_status TEXT NULL,
  previous_npb_identity_source TEXT NULL,
  next_npb_identity_source TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_automation_v3_audit_game
  ON game_automation_v3_audit(internal_game_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_game_automation_v3_audit_event
  ON game_automation_v3_audit(event_type, occurred_at DESC);
