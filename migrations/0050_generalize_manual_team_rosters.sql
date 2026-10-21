PRAGMA foreign_keys = ON;

-- The original manual roster table encoded the first production team directly
-- in CHECK constraints. Rebuild it forward-only so a team's override rows stay
-- isolated by canonical team key while existing Fighters rows and all three
-- roster modes survive unchanged.
CREATE TABLE manual_team_rosters_new (
  team_code TEXT NOT NULL CHECK (team_code IN (
    'giants', 'tigers', 'baystars', 'carp', 'swallows', 'dragons',
    'hawks', 'fighters', 'marines', 'eagles', 'buffaloes', 'lions'
  )),
  team_id TEXT NOT NULL CHECK (team_id IN ('G', 'T', 'DB', 'C', 'S', 'D', 'H', 'F', 'M', 'E', 'B', 'L')),
  player_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  roster_source TEXT NOT NULL DEFAULT 'manual' CHECK (roster_source = 'manual'),
  note TEXT NULL CHECK (length(note) <= 240),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (length(updated_by) <= 160),
  mode TEXT CHECK (mode IN ('auto', 'active', 'inactive')),
  PRIMARY KEY (team_code, player_id),
  UNIQUE (team_id, player_id),
  CHECK (
    (team_code = 'giants' AND team_id = 'G') OR
    (team_code = 'tigers' AND team_id = 'T') OR
    (team_code = 'baystars' AND team_id = 'DB') OR
    (team_code = 'carp' AND team_id = 'C') OR
    (team_code = 'swallows' AND team_id = 'S') OR
    (team_code = 'dragons' AND team_id = 'D') OR
    (team_code = 'hawks' AND team_id = 'H') OR
    (team_code = 'fighters' AND team_id = 'F') OR
    (team_code = 'marines' AND team_id = 'M') OR
    (team_code = 'eagles' AND team_id = 'E') OR
    (team_code = 'buffaloes' AND team_id = 'B') OR
    (team_code = 'lions' AND team_id = 'L')
  )
);

INSERT INTO manual_team_rosters_new (
  team_code, team_id, player_id, status, roster_source, note,
  updated_at, updated_by, mode
)
SELECT team_code, team_id, player_id, status, roster_source, note,
       updated_at, updated_by, mode
  FROM manual_team_rosters;

DROP TABLE manual_team_rosters;
ALTER TABLE manual_team_rosters_new RENAME TO manual_team_rosters;

CREATE INDEX idx_manual_team_rosters_status
  ON manual_team_rosters(team_code, status, updated_at DESC);
CREATE INDEX idx_manual_team_rosters_mode
  ON manual_team_rosters(team_code, mode, updated_at DESC);
