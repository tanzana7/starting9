PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS games (
  internal_game_id TEXT PRIMARY KEY NOT NULL,
  game_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  game_status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A unique constraint is intentionally not used here. Double headers and start-time
-- corrections must be reviewed rather than silently merged by a migration.
CREATE INDEX IF NOT EXISTS idx_games_schedule_identity
  ON games(game_date, start_time, home_team, away_team);

CREATE TABLE IF NOT EXISTS game_identifiers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_game_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT,
  UNIQUE(provider, identifier_type, identifier_value)
);

CREATE INDEX IF NOT EXISTS idx_game_identifiers_internal_game_id
  ON game_identifiers(internal_game_id);

ALTER TABLE detected_game_schedule ADD COLUMN internal_game_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_detected_game_schedule_internal_game_id
  ON detected_game_schedule(internal_game_id);
