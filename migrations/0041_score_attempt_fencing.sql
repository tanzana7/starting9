-- Migration number: 0041
-- Score execution is compute -> isolated staging -> atomic activation.  The
-- new tables are additive; rows created before this migration keep using the
-- legacy current-score read model and are never backfilled.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS score_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  internal_game_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  canonical_lineup_revision_id TEXT NOT NULL,
  scoring_lineup_revision_id TEXT NOT NULL,
  canonical_lineup_fingerprint TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  claim_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'committing', 'committed', 'abandoned', 'failed')),
  expected_prediction_count INTEGER NOT NULL CHECK (expected_prediction_count >= 0),
  expected_test_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_test_count BETWEEN 0 AND 9),
  scoring_revision_id TEXT NOT NULL,
  scoring_revision_number INTEGER NOT NULL CHECK (scoring_revision_number > 0),
  actual_lineup_json TEXT NOT NULL CHECK (length(actual_lineup_json) <= 16384),
  commit_nonce TEXT NULL,
  created_at TEXT NOT NULL,
  ready_at TEXT NULL,
  committed_at TEXT NULL,
  UNIQUE (job_id, claim_token),
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id) REFERENCES game_jobs_v3(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_score_attempts_game
  ON score_attempts(internal_game_id, canonical_lineup_revision_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_score_attempts_one_committed
  ON score_attempts(internal_game_id, canonical_lineup_revision_id)
  WHERE status = 'committed';

CREATE TABLE IF NOT EXISTS score_attempt_prediction_rows (
  attempt_id TEXT NOT NULL,
  prediction_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('scored', 'excluded')),
  validity_status TEXT NOT NULL DEFAULT 'valid' CHECK (validity_status IN ('valid', 'excluded')),
  total_score INTEGER NULL CHECK (total_score BETWEEN 0 AND 99),
  max_score INTEGER NULL CHECK (max_score = 99),
  participation_score INTEGER NULL CHECK (participation_score >= 0),
  batting_order_score INTEGER NULL CHECK (batting_order_score >= 0),
  defense_score INTEGER NULL CHECK (defense_score >= 0),
  perfect_bonus INTEGER NULL CHECK (perfect_bonus >= 0),
  player_hits INTEGER NULL,
  order_hits INTEGER NULL,
  position_hits INTEGER NULL,
  perfect_hits INTEGER NULL,
  exclusion_reason TEXT NULL,
  lineage_json TEXT NULL CHECK (lineage_json IS NULL OR length(lineage_json) <= 4096),
  PRIMARY KEY (attempt_id, prediction_id),
  FOREIGN KEY (attempt_id) REFERENCES score_attempts(attempt_id) ON DELETE CASCADE,
  FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE RESTRICT,
  CHECK (
    (outcome = 'scored' AND validity_status = 'valid' AND total_score BETWEEN 0 AND 99
      AND max_score = 99 AND exclusion_reason IS NULL)
    OR
    (outcome = 'excluded' AND validity_status = 'excluded' AND total_score IS NULL
      AND max_score IS NULL AND exclusion_reason IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS score_attempt_test_rows (
  attempt_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 9),
  prediction_json TEXT NOT NULL CHECK (length(prediction_json) <= 16384),
  status TEXT NOT NULL CHECK (status IN ('scored', 'invalid')),
  score INTEGER NULL CHECK (score BETWEEN 0 AND 99),
  max_score INTEGER NULL CHECK (max_score = 99),
  warning_code TEXT NULL,
  lineage_json TEXT NULL CHECK (lineage_json IS NULL OR length(lineage_json) <= 4096),
  PRIMARY KEY (attempt_id, slot),
  FOREIGN KEY (attempt_id) REFERENCES score_attempts(attempt_id) ON DELETE CASCADE,
  CHECK (
    (status = 'scored' AND score BETWEEN 0 AND 99 AND max_score = 99)
    OR
    (status = 'invalid' AND score IS NULL AND max_score IS NULL)
  )
);

-- Null means legacy lineage.  No historical score or TEST row is rewritten.
ALTER TABLE game_scoring_revisions ADD COLUMN committed_attempt_id TEXT NULL;
ALTER TABLE predictions ADD COLUMN scored_attempt_id TEXT NULL;
ALTER TABLE ranking_test_predictions ADD COLUMN scored_attempt_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_game_scoring_revisions_committed_attempt
  ON game_scoring_revisions(committed_attempt_id);
CREATE INDEX IF NOT EXISTS idx_predictions_scored_attempt
  ON predictions(internal_game_id, scored_attempt_id);
CREATE INDEX IF NOT EXISTS idx_ranking_test_predictions_scored_attempt
  ON ranking_test_predictions(internal_game_id, scored_attempt_id);
