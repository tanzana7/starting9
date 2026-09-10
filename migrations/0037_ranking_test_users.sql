PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ranking_test_game_settings (
  internal_game_id TEXT PRIMARY KEY NOT NULL,
  include_in_public_ranking INTEGER NOT NULL DEFAULT 0 CHECK (include_in_public_ranking IN (0, 1)),
  updated_by TEXT NOT NULL CHECK (length(updated_by) <= 160),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ranking_test_predictions (
  internal_game_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 9),
  prediction_json TEXT NOT NULL CHECK (length(prediction_json) <= 16384),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'scored', 'invalid')),
  score INTEGER NULL,
  max_score INTEGER NULL,
  lineup_revision_id TEXT NULL,
  scoring_revision_id TEXT NULL,
  scored_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (internal_game_id, slot),
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ranking_test_predictions_game_status
  ON ranking_test_predictions(internal_game_id, status, updated_at DESC);
