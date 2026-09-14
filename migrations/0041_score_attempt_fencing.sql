-- Migration number: 0041 	 2026-09-13T11:13:41.105Z

-- A claim generation may stage an arbitrary number of predictions without
-- changing the current read model. Only a completed, fenced attempt is public.
CREATE TABLE score_attempts (
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
  actual_lineup_json TEXT NOT NULL,
  commit_nonce TEXT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT NULL,
  UNIQUE (job_id, claim_token),
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id) REFERENCES game_jobs_v3(id) ON DELETE RESTRICT
);

CREATE INDEX idx_score_attempts_game
  ON score_attempts(internal_game_id, canonical_lineup_revision_id, status);

CREATE UNIQUE INDEX idx_score_attempts_one_committed
  ON score_attempts(internal_game_id, canonical_lineup_revision_id)
  WHERE status = 'committed';

CREATE TABLE score_attempt_prediction_rows (
  attempt_id TEXT NOT NULL,
  prediction_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('scored', 'excluded')),
  score INTEGER NULL CHECK (score BETWEEN 0 AND 99),
  max_score INTEGER NULL CHECK (max_score = 99),
  player_hits INTEGER NULL,
  order_hits INTEGER NULL,
  position_hits INTEGER NULL,
  perfect_hits INTEGER NULL,
  exclusion_reason TEXT NULL,
  CHECK (
    (outcome = 'scored' AND score BETWEEN 0 AND 99 AND max_score = 99 AND exclusion_reason IS NULL)
    OR (outcome = 'excluded' AND score IS NULL AND max_score IS NULL AND exclusion_reason IS NOT NULL)
  ),
  PRIMARY KEY (attempt_id, prediction_id),
  FOREIGN KEY (attempt_id) REFERENCES score_attempts(attempt_id) ON DELETE CASCADE,
  FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE RESTRICT
);

CREATE TABLE score_attempt_test_rows (
  attempt_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 9),
  prediction_json TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('scored', 'invalid')),
  score INTEGER NULL CHECK (score BETWEEN 0 AND 99),
  max_score INTEGER NULL CHECK (max_score = 99),
  warning_code TEXT NULL,
  CHECK (
    (status = 'scored' AND score BETWEEN 0 AND 99 AND max_score = 99 AND prediction_json IS NOT NULL)
    OR (status = 'invalid' AND score IS NULL AND max_score IS NULL AND prediction_json IS NOT NULL)
  ),
  PRIMARY KEY (attempt_id, slot),
  FOREIGN KEY (attempt_id) REFERENCES score_attempts(attempt_id) ON DELETE CASCADE
);

-- Null is the pre-migration/legacy contract. No historical score is rewritten.
ALTER TABLE game_scoring_revisions ADD COLUMN committed_attempt_id TEXT NULL;
ALTER TABLE predictions ADD COLUMN scored_attempt_id TEXT NULL;
ALTER TABLE ranking_test_predictions ADD COLUMN scored_attempt_id TEXT NULL;
