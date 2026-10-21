-- C-4A4 separates contest-owned formal work from physical-game source work.
-- Rebuild the job/score-attempt FK chain together so every migrated attempt
-- remains attached to the same contest job and legacy IDs/history survive.
PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = ON;

CREATE TABLE contest_identity_a4_migration_assert (valid INTEGER NOT NULL CHECK (valid = 1));

-- A game-only formal job cannot be assigned when no unique contest exists.
-- This intentionally aborts the migration rather than guessing ownership.
INSERT INTO contest_identity_a4_migration_assert(valid)
SELECT 0
 WHERE EXISTS (
   SELECT 1
     FROM game_jobs_v3 jobs
    WHERE jobs.job_type IN ('prediction_close','lineup_fetch','lineup_finalize','score','ranking_rebuild','publish')
      AND (SELECT COUNT(*) FROM game_contests contests
            WHERE contests.internal_game_id = jobs.internal_game_id) <> 1
 );

-- State is contest workflow state, not physical-game state. A progressed
-- state with multiple contests has no provable owner and must fail closed.
INSERT INTO contest_identity_a4_migration_assert(valid)
SELECT 0
 WHERE EXISTS (
   SELECT 1
     FROM game_automation_v3_state state
    WHERE (SELECT COUNT(*) FROM game_contests contests
            WHERE contests.internal_game_id = state.internal_game_id) > 1
      AND state.state <> 'scheduled'
 );

-- Score attempts must point at a score job owned by the same contest/game.
INSERT INTO contest_identity_a4_migration_assert(valid)
SELECT 0
 WHERE EXISTS (
   SELECT 1
     FROM contest_score_attempts attempts
     JOIN game_jobs_v3 jobs ON jobs.id = attempts.job_id
     LEFT JOIN game_contests contests ON contests.internal_game_id = jobs.internal_game_id
    WHERE jobs.job_type <> 'score'
       OR jobs.internal_game_id <> attempts.internal_game_id
       OR (SELECT COUNT(*) FROM game_contests scoped
            WHERE scoped.internal_game_id = jobs.internal_game_id) <> 1
       OR contests.contest_id <> attempts.contest_id
 );

CREATE TABLE _a4_jobs AS
SELECT jobs.*,
       CASE WHEN jobs.job_type IN ('prediction_close','lineup_fetch','lineup_finalize','score','ranking_rebuild','publish')
            THEN (SELECT contests.contest_id FROM game_contests contests
                   WHERE contests.internal_game_id = jobs.internal_game_id LIMIT 1)
            ELSE NULL END AS contest_id
  FROM game_jobs_v3 jobs;
CREATE TABLE _a4_attempts AS SELECT * FROM contest_score_attempts;
CREATE TABLE _a4_attempt_prediction_rows AS SELECT * FROM contest_score_attempt_prediction_rows;
CREATE TABLE _a4_attempt_test_rows AS SELECT * FROM contest_score_attempt_test_rows;

CREATE TABLE contest_automation_v3_state (
  contest_id TEXT PRIMARY KEY NOT NULL,
  internal_game_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (state IN ('scheduled','prediction_closed','lineup_ready','scored','ranked','published','excluded','failed','manual_action_required')),
  prediction_closed_at TEXT NULL,
  lineup_finalized_at TEXT NULL,
  scoring_revision_id TEXT NULL,
  ranked_at TEXT NULL,
  published_at TEXT NULL,
  excluded_at TEXT NULL,
  failure_code TEXT NULL,
  failure_message TEXT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (contest_id, internal_game_id),
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT
);
CREATE INDEX idx_contest_automation_v3_game
  ON contest_automation_v3_state(internal_game_id, contest_id);
INSERT INTO contest_automation_v3_state (
  contest_id, internal_game_id, state, prediction_closed_at, lineup_finalized_at,
  scoring_revision_id, ranked_at, published_at, excluded_at, failure_code,
  failure_message, version, created_at, updated_at
)
SELECT contests.contest_id, state.internal_game_id, state.state, state.prediction_closed_at,
       state.lineup_finalized_at, state.scoring_revision_id, state.ranked_at, state.published_at,
       state.excluded_at, state.failure_code, state.failure_message, state.version,
       state.created_at, state.updated_at
  FROM game_automation_v3_state state
  JOIN game_contests contests ON contests.internal_game_id = state.internal_game_id
 WHERE (SELECT COUNT(*) FROM game_contests scoped
         WHERE scoped.internal_game_id = state.internal_game_id) = 1;

DROP TRIGGER IF EXISTS contest_score_attempt_prediction_scope_insert;
DROP TRIGGER IF EXISTS contest_score_attempt_prediction_scope_update;
DROP TABLE contest_score_attempt_prediction_rows;
DROP TABLE contest_score_attempt_test_rows;
DROP TABLE contest_score_attempts;
DROP TABLE game_jobs_v3;

CREATE TABLE game_jobs_v3 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_game_id TEXT NOT NULL,
  contest_id TEXT NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('npb_identity_resolve','prediction_close','lineup_fetch','lineup_finalize','score','ranking_rebuild','publish','probable_starter_fetch','roster_fetch')),
  scheduled_at TEXT NOT NULL,
  scheduled_slot_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','claimed','completed','retry_wait','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 12 CHECK (max_attempts > 0),
  next_retry_at TEXT NULL,
  claimed_at TEXT NULL,
  claim_token TEXT NULL,
  lease_expires_at TEXT NULL,
  completed_at TEXT NULL,
  failure_code TEXT NULL,
  failure_message TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, contest_id, internal_game_id),
  CHECK ((job_type IN ('prediction_close','lineup_fetch','lineup_finalize','score','ranking_rebuild','publish') AND contest_id IS NOT NULL)
      OR (job_type IN ('npb_identity_resolve','probable_starter_fetch','roster_fetch') AND contest_id IS NULL)),
  FOREIGN KEY (internal_game_id) REFERENCES games(internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT
);
INSERT INTO game_jobs_v3 (
  id, internal_game_id, contest_id, job_type, scheduled_at, scheduled_slot_at, status,
  attempt_count, max_attempts, next_retry_at, claimed_at, claim_token, lease_expires_at,
  completed_at, failure_code, failure_message, created_at, updated_at
)
SELECT id, internal_game_id, contest_id, job_type, scheduled_at, scheduled_slot_at, status,
       attempt_count, max_attempts, next_retry_at, claimed_at, claim_token, lease_expires_at,
       completed_at, failure_code, failure_message, created_at, updated_at
  FROM _a4_jobs;
CREATE UNIQUE INDEX idx_game_jobs_v3_contest_identity
  ON game_jobs_v3(contest_id, job_type, scheduled_slot_at) WHERE contest_id IS NOT NULL;
CREATE UNIQUE INDEX idx_game_jobs_v3_physical_identity
  ON game_jobs_v3(internal_game_id, job_type, scheduled_slot_at) WHERE contest_id IS NULL;
CREATE INDEX idx_game_jobs_v3_due
  ON game_jobs_v3(status, scheduled_at, next_retry_at);
CREATE INDEX idx_game_jobs_v3_lease
  ON game_jobs_v3(status, lease_expires_at);
CREATE INDEX idx_game_jobs_v3_game
  ON game_jobs_v3(internal_game_id, job_type, scheduled_slot_at);
CREATE INDEX idx_game_jobs_v3_contest_due
  ON game_jobs_v3(contest_id, status, scheduled_at, next_retry_at) WHERE contest_id IS NOT NULL;

CREATE TABLE contest_score_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  contest_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  canonical_lineup_revision_id TEXT NOT NULL,
  scoring_lineup_revision_id TEXT NOT NULL,
  canonical_lineup_fingerprint TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  claim_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging','ready','committing','committed','abandoned','failed')),
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
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, canonical_lineup_revision_id) REFERENCES contest_lineup_revisions(contest_id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, scoring_lineup_revision_id) REFERENCES contest_lineup_revisions(contest_id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, scoring_revision_id) REFERENCES contest_scoring_revisions(contest_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id, contest_id, internal_game_id) REFERENCES game_jobs_v3(id, contest_id, internal_game_id) ON DELETE RESTRICT
);
CREATE INDEX idx_contest_score_attempts_lineage
  ON contest_score_attempts(contest_id, canonical_lineup_revision_id, status);
CREATE UNIQUE INDEX idx_contest_score_attempts_one_committed
  ON contest_score_attempts(contest_id, canonical_lineup_revision_id) WHERE status = 'committed';

CREATE TABLE contest_score_attempt_prediction_rows (
  attempt_id TEXT NOT NULL,
  contest_id TEXT NOT NULL,
  prediction_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('scored','excluded')),
  validity_status TEXT NOT NULL DEFAULT 'valid' CHECK (validity_status IN ('valid','excluded')),
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
  FOREIGN KEY (attempt_id) REFERENCES contest_score_attempts(attempt_id) ON DELETE CASCADE,
  FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE RESTRICT,
  CHECK ((outcome='scored' AND validity_status='valid' AND total_score BETWEEN 0 AND 99 AND max_score=99 AND exclusion_reason IS NULL)
      OR (outcome='excluded' AND validity_status='excluded' AND total_score IS NULL AND max_score IS NULL AND exclusion_reason IS NOT NULL))
);
CREATE TRIGGER contest_score_attempt_prediction_scope_insert
BEFORE INSERT ON contest_score_attempt_prediction_rows
WHEN NOT EXISTS (
  SELECT 1 FROM contest_score_attempts a JOIN predictions p ON p.id = NEW.prediction_id
   WHERE a.attempt_id = NEW.attempt_id AND a.contest_id = NEW.contest_id
     AND p.contest_id = NEW.contest_id AND p.internal_game_id = a.internal_game_id
)
BEGIN SELECT RAISE(ABORT, 'SCORE_ATTEMPT_CONTEST_MISMATCH'); END;
CREATE TRIGGER contest_score_attempt_prediction_scope_update
BEFORE UPDATE OF attempt_id, contest_id, prediction_id ON contest_score_attempt_prediction_rows
WHEN NOT EXISTS (
  SELECT 1 FROM contest_score_attempts a JOIN predictions p ON p.id = NEW.prediction_id
   WHERE a.attempt_id = NEW.attempt_id AND a.contest_id = NEW.contest_id
     AND p.contest_id = NEW.contest_id AND p.internal_game_id = a.internal_game_id
)
BEGIN SELECT RAISE(ABORT, 'SCORE_ATTEMPT_CONTEST_MISMATCH'); END;

CREATE TABLE contest_score_attempt_test_rows (
  attempt_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 9),
  prediction_json TEXT NOT NULL CHECK (length(prediction_json) <= 16384),
  status TEXT NOT NULL CHECK (status IN ('scored','invalid')),
  score INTEGER NULL CHECK (score BETWEEN 0 AND 99),
  max_score INTEGER NULL CHECK (max_score = 99),
  warning_code TEXT NULL,
  lineage_json TEXT NULL CHECK (lineage_json IS NULL OR length(lineage_json) <= 4096),
  PRIMARY KEY (attempt_id, slot),
  FOREIGN KEY (attempt_id) REFERENCES contest_score_attempts(attempt_id) ON DELETE CASCADE,
  CHECK ((status='scored' AND score BETWEEN 0 AND 99 AND max_score=99) OR (status='invalid' AND score IS NULL AND max_score IS NULL))
);

INSERT INTO contest_score_attempts SELECT * FROM _a4_attempts;
INSERT INTO contest_score_attempt_prediction_rows SELECT * FROM _a4_attempt_prediction_rows;
INSERT INTO contest_score_attempt_test_rows SELECT * FROM _a4_attempt_test_rows;

DROP TABLE _a4_attempt_prediction_rows;
DROP TABLE _a4_attempt_test_rows;
DROP TABLE _a4_attempts;
DROP TABLE _a4_jobs;
DROP TABLE contest_identity_a4_migration_assert;
