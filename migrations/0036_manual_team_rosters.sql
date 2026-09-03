PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS manual_team_rosters (
  team_code TEXT NOT NULL CHECK (team_code IN ('fighters')),
  team_id TEXT NOT NULL CHECK (team_id = 'F'),
  player_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  roster_source TEXT NOT NULL DEFAULT 'manual' CHECK (roster_source = 'manual'),
  note TEXT NULL CHECK (length(note) <= 240),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (length(updated_by) <= 160),
  PRIMARY KEY (team_code, player_id),
  UNIQUE (team_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_manual_team_rosters_status
  ON manual_team_rosters(team_code, status, updated_at DESC);
