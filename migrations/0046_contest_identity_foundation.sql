PRAGMA foreign_keys = ON;

-- C-4A1 is an additive identity foundation. Existing game-only runtime tables
-- remain untouched until their owning C-4A phase migrates them atomically.
CREATE TABLE IF NOT EXISTS contest_identity_teams (
  team_key TEXT PRIMARY KEY NOT NULL
    CHECK (length(team_key) > 0 AND team_key = lower(team_key)
      AND team_key NOT GLOB '*[^a-z0-9-]*'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO contest_identity_teams (team_key) VALUES ('fighters');
INSERT OR IGNORE INTO contest_identity_teams (team_key) VALUES ('marines');

CREATE TABLE IF NOT EXISTS game_contests (
  contest_id TEXT PRIMARY KEY NOT NULL,
  internal_game_id TEXT NOT NULL,
  target_team_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (internal_game_id, target_team_key),
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (target_team_key) REFERENCES contest_identity_teams(team_key) ON DELETE RESTRICT
);

-- The composite unique index also serves game/team lookups; the primary key
-- serves direct contest lookup, so no duplicate indexes are needed.

CREATE TABLE IF NOT EXISTS contest_identity_backfill_issues (
  internal_game_id TEXT PRIMARY KEY NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'multiple_fighters_sides', 'missing_participant_identity'
  )),
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
);

-- Keep this alias set aligned with frontend/shared/team-context.js. A legacy
-- Fighters contest is created only when exactly one participant is provably
-- Fighters; unknown/non-Fighters games are intentionally not assigned.
WITH normalized_games AS (
  SELECT internal_game_id, home_team, away_team,
    lower(replace(replace(replace(replace(trim(home_team), ' ', ''), '　', ''), '・', ''), '.', '')) AS home_key,
    lower(replace(replace(replace(replace(trim(away_team), ' ', ''), '　', ''), '・', ''), '.', '')) AS away_key
  FROM games
), classified_games AS (
  SELECT *,
    home_key IN ('f', 'fighters', '北海道日本ハムファイターズ', '北海道日本ハム', '日本ハムファイターズ', '日本ハム', 'ファイターズ') AS home_is_fighters,
    away_key IN ('f', 'fighters', '北海道日本ハムファイターズ', '北海道日本ハム', '日本ハムファイターズ', '日本ハム', 'ファイターズ') AS away_is_fighters
  FROM normalized_games
)
INSERT INTO game_contests (contest_id, internal_game_id, target_team_key)
SELECT 'contest_' || lower(hex(internal_game_id)) || '_6669676874657273', internal_game_id, 'fighters'
FROM classified_games
WHERE home_is_fighters + away_is_fighters = 1;

WITH normalized_games AS (
  SELECT internal_game_id, home_team, away_team,
    lower(replace(replace(replace(replace(trim(home_team), ' ', ''), '　', ''), '・', ''), '.', '')) AS home_key,
    lower(replace(replace(replace(replace(trim(away_team), ' ', ''), '　', ''), '・', ''), '.', '')) AS away_key
  FROM games
), classified_games AS (
  SELECT *,
    home_key IN ('f', 'fighters', '北海道日本ハムファイターズ', '北海道日本ハム', '日本ハムファイターズ', '日本ハム', 'ファイターズ') AS home_is_fighters,
    away_key IN ('f', 'fighters', '北海道日本ハムファイターズ', '北海道日本ハム', '日本ハムファイターズ', '日本ハム', 'ファイターズ') AS away_is_fighters
  FROM normalized_games
)
INSERT INTO contest_identity_backfill_issues (internal_game_id, reason_code, home_team, away_team)
SELECT internal_game_id,
       CASE WHEN home_is_fighters AND away_is_fighters
         THEN 'multiple_fighters_sides' ELSE 'missing_participant_identity' END,
       home_team, away_team
FROM classified_games
WHERE (home_is_fighters AND away_is_fighters)
   OR home_key = '' OR away_key = '';
