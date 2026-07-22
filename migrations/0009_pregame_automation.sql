PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS game_roster_snapshots (
  game_id TEXT PRIMARY KEY NOT NULL,
  game_date TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  roster_json TEXT NOT NULL CHECK (length(roster_json) <= 65536),
  source TEXT NOT NULL DEFAULT 'npb-roster' CHECK (source = 'npb-roster'),
  player_count INTEGER NOT NULL CHECK (player_count BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'captured' CHECK (status = 'captured'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_pregame_automation (
  game_id TEXT PRIMARY KEY NOT NULL,
  game_date TEXT NOT NULL,
  start_at TEXT NOT NULL,
  roster_status TEXT NOT NULL DEFAULT 'pending' CHECK (roster_status IN ('pending', 'captured', 'failed', 'skipped')),
  roster_captured_at TEXT NULL,
  lineup_status TEXT NOT NULL DEFAULT 'pending' CHECK (lineup_status IN ('pending', 'captured', 'failed', 'skipped')),
  lineup_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (lineup_attempt_count >= 0),
  last_lineup_attempt_at TEXT NULL,
  next_lineup_attempt_at TEXT NULL,
  lineup_captured_at TEXT NULL,
  scoring_status TEXT NOT NULL DEFAULT 'pending' CHECK (scoring_status IN ('pending', 'scored', 'blocked')),
  last_error_code TEXT NULL,
  last_error_message TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_pregame_automation_start
  ON game_pregame_automation(start_at, lineup_status);

ALTER TABLE game_lineups ADD COLUMN lineup_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (lineup_source IN ('manual', 'npb-auto'));
