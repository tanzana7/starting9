CREATE TABLE IF NOT EXISTS detected_game_schedule (
  game_id TEXT PRIMARY KEY NOT NULL,
  source_game_key TEXT NOT NULL UNIQUE,
  game_date TEXT NOT NULL,
  start_at TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  game_code TEXT NULL,
  venue TEXT NULL,
  game_status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (game_status IN ('scheduled', 'cancelled', 'postponed')),
  detected_at TEXT NOT NULL,
  schedule_checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_detected_game_schedule_date
  ON detected_game_schedule(game_date, game_status, start_at);

CREATE TABLE IF NOT EXISTS game_schedule_check_state (
  schedule_date TEXT PRIMARY KEY NOT NULL,
  next_check_at TEXT NOT NULL,
  last_checked_at TEXT NULL,
  last_error_code TEXT NULL,
  updated_at TEXT NOT NULL
);
