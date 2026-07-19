PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  prediction_json TEXT NOT NULL CHECK (length(prediction_json) <= 16384),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  game_date TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  opponent_code TEXT NOT NULL,
  is_home INTEGER NOT NULL CHECK (is_home IN (0, 1)),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  locked_at TEXT NULL,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft', 'submitted', 'locked', 'scored')),
  score INTEGER NULL,
  max_score INTEGER NULL,
  scored_at TEXT NULL,
  actual_lineup_json TEXT NULL,
  UNIQUE (user_id, game_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_predictions_game_id
  ON predictions(game_id);

CREATE INDEX IF NOT EXISTS idx_predictions_user_updated
  ON predictions(user_id, updated_at);
