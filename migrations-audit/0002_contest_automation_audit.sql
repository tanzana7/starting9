-- The audit database is diagnostic-only; contest identity is stored as a
-- nullable dimension so physical-game source events remain one-per-game.
ALTER TABLE game_automation_v3_audit ADD COLUMN contest_id TEXT NULL;
CREATE INDEX idx_game_automation_v3_audit_contest
  ON game_automation_v3_audit(contest_id, occurred_at DESC) WHERE contest_id IS NOT NULL;
