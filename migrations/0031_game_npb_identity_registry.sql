PRAGMA foreign_keys = ON;

-- NPB identity is additive. Existing codes are retained; unresolved is the
-- explicit default for rows that have not yet been matched to NPB's schedule.
ALTER TABLE games ADD COLUMN npb_game_url TEXT NULL;
ALTER TABLE games ADD COLUMN source_schedule_key TEXT NULL;
ALTER TABLE games ADD COLUMN npb_identity_status TEXT NOT NULL DEFAULT 'unresolved'
  CHECK (npb_identity_status IN ('resolved', 'unresolved', 'manually_overridden'));
ALTER TABLE games ADD COLUMN npb_identity_resolved_at TEXT NULL;
ALTER TABLE games ADD COLUMN npb_identity_source TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_games_npb_identity
  ON games(npb_identity_status, game_date, start_time);

ALTER TABLE game_automation_v3_audit ADD COLUMN previous_npb_game_url TEXT NULL;
ALTER TABLE game_automation_v3_audit ADD COLUMN next_npb_game_url TEXT NULL;
ALTER TABLE game_automation_v3_audit ADD COLUMN previous_npb_identity_status TEXT NULL;
ALTER TABLE game_automation_v3_audit ADD COLUMN next_npb_identity_status TEXT NULL;
ALTER TABLE game_automation_v3_audit ADD COLUMN previous_npb_identity_source TEXT NULL;
ALTER TABLE game_automation_v3_audit ADD COLUMN next_npb_identity_source TEXT NULL;
