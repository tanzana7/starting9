PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS game_lineups (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL UNIQUE,
  actual_lineup_json TEXT NOT NULL CHECK (length(actual_lineup_json) <= 16384),
  lineup_fingerprint TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  lineup_detected_at TEXT NOT NULL,
  scoring_due_at TEXT NOT NULL,
  scoring_started_at TEXT NULL,
  scored_at TEXT NULL,
  scoring_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (scoring_status IN ('pending', 'processing', 'scored', 'failed', 'cancelled')),
  scoring_attempts INTEGER NOT NULL DEFAULT 0 CHECK (scoring_attempts >= 0),
  last_error TEXT NULL,
  processed_predictions INTEGER NULL,
  perfect_count INTEGER NULL,
  new_perfect_achievers INTEGER NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_lineups_due
  ON game_lineups(scoring_status, scoring_due_at, scoring_attempts);

CREATE INDEX IF NOT EXISTS idx_game_lineups_game_status
  ON game_lineups(game_id, scoring_status);
