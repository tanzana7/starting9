PRAGMA foreign_keys = ON;

-- Phase 2/3 automation v2 keeps legacy columns for compatibility while making
-- the canonical schedule and revision metadata explicit. This migration is
-- intentionally additive; it does not rewrite existing predictions or scores.
ALTER TABLE games ADD COLUMN npb_game_code TEXT NULL;
ALTER TABLE games ADD COLUMN prediction_deadline_at TEXT NULL;
ALTER TABLE games ADD COLUMN lineup_polling_start_at TEXT NULL;
ALTER TABLE games ADD COLUMN final_lineup_at TEXT NULL;
ALTER TABLE games ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'system';

-- Existing schedule rows remain authoritative after the additive migration.
-- Populate derived timestamps once so executors do not recompute them from an
-- external schedule or from a legacy game id.
UPDATE games
   SET prediction_deadline_at = datetime(start_time, '-60 minutes'),
       lineup_polling_start_at = datetime(start_time, '-50 minutes'),
       final_lineup_at = datetime(start_time, '+2 minutes')
 WHERE start_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_games_automation_schedule
  ON games(game_date, start_time, game_status, internal_game_id);

CREATE TABLE IF NOT EXISTS game_schedule_change_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_game_id TEXT NOT NULL,
  previous_start_at TEXT NULL,
  next_start_at TEXT NOT NULL,
  previous_status TEXT NULL,
  next_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_game_schedule_change_history_game
  ON game_schedule_change_history(internal_game_id, changed_at DESC);

ALTER TABLE game_workflow_state ADD COLUMN canonical_status TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE game_workflow_state ADD COLUMN state_updated_by TEXT NOT NULL DEFAULT 'system';
ALTER TABLE game_workflow_state ADD COLUMN state_updated_at TEXT NULL;

UPDATE game_workflow_state
   SET canonical_status = CASE workflow_status
     WHEN 'waiting' THEN 'scheduled'
     WHEN 'provisional_lineup_captured' THEN 'lineup_candidate_captured'
     WHEN 'final_lineup_captured' THEN 'final_lineup_confirmed'
     WHEN 'scored_private' THEN 'scored'
     WHEN 'rescore_pending' THEN 'rescoring_pending'
     WHEN 'service_unavailable' THEN 'service_unavailable'
     ELSE workflow_status
   END,
       state_updated_at = updated_at
 WHERE canonical_status = 'scheduled' AND workflow_status <> 'waiting';

CREATE INDEX IF NOT EXISTS idx_game_workflow_canonical_status
  ON game_workflow_state(canonical_status, updated_at);

ALTER TABLE game_lineup_revisions ADD COLUMN revision_id TEXT NULL;
ALTER TABLE game_lineup_revisions ADD COLUMN internal_game_id TEXT NULL;
ALTER TABLE game_lineup_revisions ADD COLUMN captured_at TEXT NULL;
ALTER TABLE game_lineup_revisions ADD COLUMN validation_json TEXT NULL;
ALTER TABLE game_lineup_revisions ADD COLUMN finalized_at TEXT NULL;
ALTER TABLE game_lineup_revisions ADD COLUMN finalized_by TEXT NULL;

UPDATE game_lineup_revisions
   SET revision_id = game_id || ':' || CAST(version AS TEXT),
       captured_at = created_at
 WHERE revision_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_lineup_revisions_revision_id
  ON game_lineup_revisions(revision_id);
CREATE INDEX IF NOT EXISTS idx_game_lineup_revisions_internal
  ON game_lineup_revisions(internal_game_id, version DESC);

ALTER TABLE game_lineups ADD COLUMN final_lineup_revision_id TEXT NULL;
ALTER TABLE game_lineups ADD COLUMN finalized_at TEXT NULL;
ALTER TABLE game_lineups ADD COLUMN finalized_by TEXT NULL;
ALTER TABLE game_lineups ADD COLUMN scoring_lineup_revision_id TEXT NULL;
ALTER TABLE game_lineups ADD COLUMN scoring_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE game_lineups ADD COLUMN scored_by TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_game_lineups_final_revision
  ON game_lineups(internal_game_id, final_lineup_revision_id);

ALTER TABLE predictions ADD COLUMN scored_lineup_revision_id TEXT NULL;
ALTER TABLE predictions ADD COLUMN scoring_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE predictions ADD COLUMN scored_by TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_predictions_scoring_revision
  ON predictions(internal_game_id, scored_lineup_revision_id, scoring_revision);

-- Keep per-prediction scoring history when an administrator rescored a game.
-- The current score columns remain the read model; this table is append-only.
CREATE TABLE IF NOT EXISTS prediction_score_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  prediction_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  internal_game_id TEXT NULL,
  is_test_prediction INTEGER NOT NULL DEFAULT 0
    CHECK (is_test_prediction IN (0, 1)),
  scoring_revision INTEGER NOT NULL CHECK (scoring_revision > 0),
  lineup_revision_id TEXT NULL,
  score INTEGER NULL,
  max_score INTEGER NULL,
  actual_lineup_json TEXT NULL,
  scored_at TEXT NULL,
  scored_by TEXT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(prediction_id, scoring_revision),
  FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_prediction_score_revisions_game
  ON prediction_score_revisions(internal_game_id, game_id, scoring_revision);

UPDATE predictions
   SET scoring_revision = 1
 WHERE status = 'scored'
   AND score IS NOT NULL
   AND scoring_revision = 0;

INSERT OR IGNORE INTO prediction_score_revisions (
  id, prediction_id, game_id, internal_game_id, is_test_prediction,
  scoring_revision, lineup_revision_id, score, max_score, actual_lineup_json,
  scored_at, scored_by, created_at
)
SELECT p.id,
       p.id,
       p.game_id,
       p.internal_game_id,
       p.is_test_prediction,
       p.scoring_revision,
       COALESCE(lineups.final_lineup_revision_id, p.game_id || ':1'),
       p.score,
       p.max_score,
       p.actual_lineup_json,
       p.scored_at,
       COALESCE(p.scored_by, 'system'),
       COALESCE(p.scored_at, p.updated_at)
  FROM predictions AS p
  LEFT JOIN game_lineups AS lineups ON lineups.game_id = p.game_id
 WHERE p.status = 'scored'
   AND p.score IS NOT NULL
   AND p.scoring_revision > 0;

ALTER TABLE game_rescore_jobs ADD COLUMN lineup_revision_id TEXT NULL;
ALTER TABLE game_rescore_jobs ADD COLUMN scoring_revision INTEGER NULL;
ALTER TABLE game_rescore_jobs ADD COLUMN claimed_at TEXT NULL;
ALTER TABLE game_rescore_jobs ADD COLUMN claim_token TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_game_rescore_jobs_claim
  ON game_rescore_jobs(internal_game_id, status, lineup_revision_id);
