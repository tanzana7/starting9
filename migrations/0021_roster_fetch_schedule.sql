PRAGMA foreign_keys = ON;

ALTER TABLE game_pregame_automation ADD COLUMN last_successful_roster_fetch_at TEXT NULL;
ALTER TABLE game_pregame_automation ADD COLUMN roster_next_check_at TEXT NULL;
ALTER TABLE game_pregame_automation ADD COLUMN last_pregame_check_game_id TEXT NULL;
ALTER TABLE game_pregame_automation ADD COLUMN last_roster_attempt_at TEXT NULL;
ALTER TABLE game_pregame_automation ADD COLUMN last_roster_error_code TEXT NULL;
ALTER TABLE game_pregame_automation ADD COLUMN last_roster_fetch_source TEXT NOT NULL DEFAULT 'cron'
  CHECK (last_roster_fetch_source IN ('cron', 'admin'));

CREATE INDEX IF NOT EXISTS idx_game_pregame_roster_next_check
  ON game_pregame_automation(roster_next_check_at, last_successful_roster_fetch_at);
