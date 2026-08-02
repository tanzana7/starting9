PRAGMA foreign_keys = ON;

-- Phase 5 stores only administrator-approved repair plans and their reversible
-- metadata. Applying this migration never inspects or changes game data.
CREATE TABLE IF NOT EXISTS game_identity_repair_plans (
  repair_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'executing', 'completed', 'failed', 'cancelled', 'rolled_back')),
  classification TEXT NOT NULL,
  target_internal_game_id TEXT NULL,
  create_internal_game INTEGER NOT NULL DEFAULT 0 CHECK (create_internal_game IN (0, 1)),
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  reviewed_at TEXT NULL,
  reviewed_by TEXT NULL,
  executed_at TEXT NULL,
  completed_at TEXT NULL,
  error_code TEXT NULL,
  error_message TEXT NULL,
  rollback_json TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_identity_repair_plans_status
  ON game_identity_repair_plans(status, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_identity_repair_plans_target
  ON game_identity_repair_plans(target_internal_game_id);
