PRAGMA foreign_keys = ON;

-- Keep the legacy status column for rollback/read compatibility, but make the
-- operator's three-state choice explicit.  No DEFAULT is used: existing rows
-- are backfilled from their legacy active/inactive value below, so an existing
-- override can never become AUTO merely because this migration ran.
ALTER TABLE manual_team_rosters ADD COLUMN mode TEXT
  CHECK (mode IN ('auto', 'active', 'inactive'));

UPDATE manual_team_rosters
   SET mode = CASE status
     WHEN 'active' THEN 'active'
     WHEN 'inactive' THEN 'inactive'
   END
 WHERE mode IS NULL;

CREATE INDEX IF NOT EXISTS idx_manual_team_rosters_mode
  ON manual_team_rosters(team_code, mode, updated_at DESC);
