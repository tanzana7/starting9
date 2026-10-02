-- Migration number: 0002  2026-10-02T00:00:00Z
-- Asia CS remains isolated from the NPB database, while explicit metadata
-- keeps future competition-scoped reporting and identity checks unambiguous.
ALTER TABLE games ADD COLUMN competition_type TEXT NOT NULL DEFAULT 'ASIA_CS';
ALTER TABLE games ADD COLUMN competition_id TEXT NOT NULL DEFAULT 'asia-cs';
ALTER TABLE games ADD COLUMN game_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE games ADD COLUMN external_game_code TEXT;
ALTER TABLE games ADD COLUMN venue TEXT;
ALTER TABLE games ADD COLUMN home_team_id TEXT;
ALTER TABLE games ADD COLUMN home_team_name TEXT;
ALTER TABLE games ADD COLUMN away_team_id TEXT;
ALTER TABLE games ADD COLUMN away_team_name TEXT;

CREATE INDEX IF NOT EXISTS idx_asia_cs_games_competition ON games(competition_type, competition_id, game_date, start_at);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY NOT NULL,
  competition_id TEXT NOT NULL,
  team_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  country_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (competition_id, team_key)
);

CREATE INDEX IF NOT EXISTS idx_asia_cs_teams_competition ON teams(competition_id, display_name, id);

ALTER TABLE players ADD COLUMN team_id TEXT;
CREATE INDEX IF NOT EXISTS idx_asia_cs_players_team ON players(game_id, team_id, active, name);

CREATE TABLE IF NOT EXISTS formal_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL,
  competition_type TEXT NOT NULL DEFAULT 'ASIA_CS',
  competition_id TEXT NOT NULL DEFAULT 'asia-cs',
  job_type TEXT NOT NULL CHECK (job_type IN ('prediction_close', 'score', 'ranking_rebuild', 'publish')),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'claimed', 'completed', 'failed')),
  revision_number INTEGER,
  due_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (game_id, job_type),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_asia_cs_formal_jobs_due ON formal_jobs(status, due_at, job_type, game_id);
CREATE INDEX IF NOT EXISTS idx_asia_cs_formal_jobs_scope ON formal_jobs(competition_type, competition_id, game_id, job_type);
