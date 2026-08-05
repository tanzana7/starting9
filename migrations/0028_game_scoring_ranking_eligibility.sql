PRAGMA foreign_keys = ON;

-- Ranking eligibility is the single game-level source of truth. Legacy
-- is_ranking_eligible remains populated for existing read paths.
ALTER TABLE ranking_games ADD COLUMN ranking_eligibility_status TEXT NOT NULL DEFAULT 'eligible'
  CHECK (ranking_eligibility_status IN ('eligible', 'excluded', 'pending_admin_decision'));
ALTER TABLE ranking_games ADD COLUMN ranking_eligibility_reason TEXT NULL;
ALTER TABLE ranking_games ADD COLUMN ranking_eligibility_note TEXT NULL;
ALTER TABLE ranking_games ADD COLUMN ranking_eligibility_version INTEGER NOT NULL DEFAULT 1
  CHECK (ranking_eligibility_version > 0);
ALTER TABLE ranking_games ADD COLUMN ranking_eligibility_updated_by TEXT NOT NULL DEFAULT 'system';
ALTER TABLE ranking_games ADD COLUMN ranking_eligibility_updated_at TEXT NULL;
ALTER TABLE predictions ADD COLUMN scoring_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (scoring_status IN ('pending', 'scored', 'excluded', 'failed'));
ALTER TABLE predictions ADD COLUMN scoring_exclusion_reason TEXT NULL;

ALTER TABLE games ADD COLUMN season INTEGER NULL;
ALTER TABLE games ADD COLUMN stadium TEXT NULL;
ALTER TABLE games ADD COLUMN roster_fetch_at1 TEXT NULL;
ALTER TABLE games ADD COLUMN roster_fetch_at2 TEXT NULL;
ALTER TABLE games ADD COLUMN publication_at TEXT NULL;
ALTER TABLE games ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));
ALTER TABLE games ADD COLUMN deleted_at TEXT NULL;

ALTER TABLE game_pregame_automation ADD COLUMN last_roster_fetch_slot TEXT NULL;
ALTER TABLE game_lineup_revisions ADD COLUMN unresolved_player_count INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_player_count >= 0);
ALTER TABLE game_lineup_revisions ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1));

UPDATE games
   SET roster_fetch_at1 = datetime(start_time, '-120 minutes'),
       roster_fetch_at2 = datetime(start_time, '-110 minutes'),
       publication_at = datetime(start_time, '+10 minutes')
 WHERE start_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_games_active_automation
  ON games(game_date, start_time, game_status, is_active, internal_game_id);

UPDATE predictions
   SET scoring_status = 'scored'
 WHERE status = 'scored' AND score IS NOT NULL;

UPDATE ranking_games
   SET ranking_eligibility_status = CASE
         WHEN game_status IN ('cancelled', 'service_unavailable') THEN 'excluded'
         ELSE 'eligible'
       END,
       ranking_eligibility_reason = CASE
         WHEN game_status = 'service_unavailable' THEN 'data_invalid'
         WHEN game_status = 'cancelled' THEN 'cancelled_before_start'
         ELSE NULL
       END,
       ranking_eligibility_updated_at = COALESCE(updated_at, created_at),
       is_ranking_eligible = CASE WHEN game_status IN ('cancelled', 'service_unavailable') THEN 0 ELSE is_ranking_eligible END;

CREATE TABLE IF NOT EXISTS ranking_eligibility_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_game_id TEXT NULL,
  game_id TEXT NOT NULL,
  previous_status TEXT NULL,
  next_status TEXT NOT NULL CHECK (next_status IN ('eligible', 'excluded', 'pending_admin_decision')),
  reason TEXT NULL,
  note TEXT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_ranking_eligibility_history_game
  ON ranking_eligibility_history(internal_game_id, game_id, version DESC);

CREATE TABLE IF NOT EXISTS game_scoring_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  internal_game_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  lineup_revision_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  UNIQUE(internal_game_id, lineup_revision_id),
  UNIQUE(internal_game_id, revision_number),
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_game_scoring_revisions_active
  ON game_scoring_revisions(internal_game_id, is_active, revision_number DESC);

CREATE TABLE IF NOT EXISTS ranking_reflection_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  internal_game_id TEXT NOT NULL,
  scoring_revision_id TEXT NOT NULL,
  ranking_eligibility_version INTEGER NOT NULL,
  ranking_update_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reflected', 'excluded', 'failed')),
  reflected_at TEXT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(internal_game_id, scoring_revision_id, ranking_eligibility_version),
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_ranking_reflection_revisions_game
  ON ranking_reflection_revisions(internal_game_id, ranking_update_revision DESC);

INSERT OR IGNORE INTO game_scoring_revisions (
  id, internal_game_id, game_id, revision_number, lineup_revision_id, status,
  reason, created_by, created_at, completed_at, is_active
)
SELECT g.internal_game_id,
       g.internal_game_id,
       p.game_id,
       1,
       COALESCE(l.final_lineup_revision_id, p.game_id || ':1'),
       'completed',
       'initial_scoring',
       'migration:0028',
       COALESCE(p.scored_at, p.updated_at),
       COALESCE(p.scored_at, p.updated_at),
       1
  FROM predictions p
  JOIN games g ON g.internal_game_id = p.internal_game_id
  LEFT JOIN game_lineups l ON l.game_id = p.game_id
 WHERE p.status = 'scored'
 GROUP BY g.internal_game_id, p.game_id,
          COALESCE(l.final_lineup_revision_id, p.game_id || ':1');
