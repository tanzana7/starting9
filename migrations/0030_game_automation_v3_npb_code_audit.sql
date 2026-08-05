ALTER TABLE game_automation_v3_audit ADD COLUMN event_type TEXT NOT NULL DEFAULT 'job';
ALTER TABLE game_automation_v3_audit ADD COLUMN previous_npb_game_code TEXT NULL;
ALTER TABLE game_automation_v3_audit ADD COLUMN next_npb_game_code TEXT NULL;
ALTER TABLE game_automation_v3_audit ADD COLUMN updated_by TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_game_automation_v3_audit_event
  ON game_automation_v3_audit(event_type, occurred_at DESC);
