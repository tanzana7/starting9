ALTER TABLE game_pregame_automation ADD COLUMN provisional_lineup_json TEXT;
ALTER TABLE game_pregame_automation ADD COLUMN provisional_lineup_detected_at TEXT;
ALTER TABLE game_pregame_automation ADD COLUMN final_lineup_attempt_at TEXT;
ALTER TABLE game_pregame_automation ADD COLUMN final_lineup_fallback_used INTEGER NOT NULL DEFAULT 0
  CHECK (final_lineup_fallback_used IN (0, 1));
ALTER TABLE game_pregame_automation ADD COLUMN final_lineup_error_code TEXT;
