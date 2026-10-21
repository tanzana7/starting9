-- C-4A3 introduces canonical contest-owned scoring and result artifacts while
-- retaining the game-only tables as read/write compatibility bridges for the
-- existing Fighters automation until C-4A4 migrates formal job identity.
PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = ON;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contest_lineup_revisions_contest_revision_id
  ON contest_lineup_revisions(contest_id, revision_id);

CREATE TABLE contest_scoring_revisions (
  contest_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  lineup_revision_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  committed_attempt_id TEXT NULL,
  PRIMARY KEY (contest_id, id),
  UNIQUE (contest_id, revision_number),
  UNIQUE (contest_id, internal_game_id, lineup_revision_id),
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, lineup_revision_id) REFERENCES contest_lineup_revisions(contest_id, revision_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX idx_contest_scoring_revisions_active
  ON contest_scoring_revisions(contest_id) WHERE is_active = 1;
CREATE INDEX idx_contest_scoring_revisions_history
  ON contest_scoring_revisions(contest_id, revision_number DESC);

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
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, canonical_lineup_revision_id) REFERENCES contest_lineup_revisions(contest_id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, scoring_lineup_revision_id) REFERENCES contest_lineup_revisions(contest_id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, scoring_revision_id) REFERENCES contest_scoring_revisions(contest_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id) REFERENCES game_jobs_v3(id) ON DELETE RESTRICT
);
CREATE INDEX idx_contest_score_attempts_lineage
  ON contest_score_attempts(contest_id, canonical_lineup_revision_id, status);
CREATE UNIQUE INDEX idx_contest_score_attempts_one_committed
  ON contest_score_attempts(contest_id, canonical_lineup_revision_id) WHERE status = 'committed';

CREATE TABLE contest_score_attempt_prediction_rows (
  attempt_id TEXT NOT NULL,
  contest_id TEXT NOT NULL,
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
  FOREIGN KEY (attempt_id) REFERENCES contest_score_attempts(attempt_id) ON DELETE CASCADE,
  FOREIGN KEY (prediction_id) REFERENCES predictions(id) ON DELETE RESTRICT,
  CHECK ((outcome = 'scored' AND validity_status = 'valid' AND total_score BETWEEN 0 AND 99 AND max_score = 99 AND exclusion_reason IS NULL)
      OR (outcome = 'excluded' AND validity_status = 'excluded' AND total_score IS NULL AND max_score IS NULL AND exclusion_reason IS NOT NULL))
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
  status TEXT NOT NULL CHECK (status IN ('scored', 'invalid')),
  score INTEGER NULL CHECK (score BETWEEN 0 AND 99),
  max_score INTEGER NULL CHECK (max_score = 99),
  warning_code TEXT NULL,
  lineage_json TEXT NULL CHECK (lineage_json IS NULL OR length(lineage_json) <= 4096),
  PRIMARY KEY (attempt_id, slot),
  FOREIGN KEY (attempt_id) REFERENCES contest_score_attempts(attempt_id) ON DELETE CASCADE,
  CHECK ((status = 'scored' AND score BETWEEN 0 AND 99 AND max_score = 99) OR (status = 'invalid' AND score IS NULL AND max_score IS NULL))
);

CREATE TABLE contest_prediction_score_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  contest_id TEXT NOT NULL,
  prediction_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  is_test_prediction INTEGER NOT NULL DEFAULT 0 CHECK (is_test_prediction IN (0, 1)),
  scoring_revision INTEGER NOT NULL CHECK (scoring_revision > 0),
  lineup_revision_id TEXT NULL,
  score INTEGER NULL,
  max_score INTEGER NULL,
  actual_lineup_json TEXT NULL,
  scored_at TEXT NULL,
  scored_by TEXT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (contest_id, prediction_id, scoring_revision),
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, lineup_revision_id) REFERENCES contest_lineup_revisions(contest_id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, prediction_id, internal_game_id)
    REFERENCES predictions(contest_id, id, internal_game_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_predictions_contest_id_game
  ON predictions(contest_id, id, internal_game_id);
CREATE INDEX idx_contest_prediction_score_revisions_lineage
  ON contest_prediction_score_revisions(contest_id, internal_game_id, scoring_revision);

CREATE TABLE contest_ranking_games (
  contest_id TEXT PRIMARY KEY NOT NULL,
  internal_game_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  is_ranking_eligible INTEGER NOT NULL DEFAULT 0 CHECK (is_ranking_eligible IN (0, 1)),
  ranking_eligible_at TEXT NULL,
  game_status TEXT NOT NULL DEFAULT 'pending' CHECK (game_status IN ('pending', 'scored', 'failed', 'cancelled', 'service_unavailable')),
  is_test_game INTEGER NOT NULL DEFAULT 0 CHECK (is_test_game IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  game_date TEXT NULL CHECK (game_date IS NULL OR (length(game_date) = 10 AND date(game_date) = game_date)),
  scored_private_at TEXT NULL,
  published_at TEXT NULL,
  publication_status TEXT NOT NULL DEFAULT 'pending' CHECK (publication_status IN ('pending', 'scored_private', 'published')),
  ranking_eligibility_status TEXT NOT NULL DEFAULT 'eligible' CHECK (ranking_eligibility_status IN ('eligible', 'excluded', 'pending_admin_decision')),
  ranking_eligibility_reason TEXT NULL,
  ranking_eligibility_note TEXT NULL,
  ranking_eligibility_version INTEGER NOT NULL DEFAULT 1 CHECK (ranking_eligibility_version > 0),
  ranking_eligibility_updated_by TEXT NOT NULL DEFAULT 'system',
  ranking_eligibility_updated_at TEXT NULL,
  UNIQUE (contest_id, internal_game_id),
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT
);
CREATE INDEX idx_contest_ranking_games_period
  ON contest_ranking_games(game_date, is_ranking_eligible, game_status, is_test_game, publication_status);
CREATE INDEX idx_contest_ranking_games_published
  ON contest_ranking_games(publication_status, published_at DESC, game_date DESC);

CREATE TABLE contest_ranking_eligibility_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contest_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  previous_status TEXT NULL,
  next_status TEXT NOT NULL CHECK (next_status IN ('eligible', 'excluded', 'pending_admin_decision')),
  reason TEXT NULL,
  note TEXT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT
);
CREATE INDEX idx_contest_ranking_eligibility_history
  ON contest_ranking_eligibility_history(contest_id, version DESC);

CREATE TABLE contest_ranking_reflection_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  contest_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  scoring_revision_id TEXT NULL,
  ranking_eligibility_version INTEGER NOT NULL,
  ranking_update_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reflected', 'excluded', 'revoked', 'failed')),
  reflected_at TEXT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (contest_id, scoring_revision_id, ranking_eligibility_version),
  UNIQUE (contest_id, ranking_update_revision),
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, scoring_revision_id) REFERENCES contest_scoring_revisions(contest_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_contest_ranking_reflection_history
  ON contest_ranking_reflection_revisions(contest_id, ranking_update_revision DESC);

CREATE TABLE contest_perfect_achievers (
  id TEXT PRIMARY KEY NOT NULL,
  contest_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  max_score INTEGER NOT NULL CHECK (max_score > 0),
  achieved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, contest_id),
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_contest_perfect_achievers_date
  ON contest_perfect_achievers(contest_id, achieved_at DESC);

CREATE TABLE contest_game_rescore_previews (
  id TEXT PRIMARY KEY NOT NULL,
  contest_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  lineup_version INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  reason TEXT NOT NULL,
  summary_json TEXT NOT NULL CHECK (length(summary_json) <= 16384),
  expected_prediction_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, lineup_version) REFERENCES contest_lineup_revisions(contest_id, version) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_contest_game_rescore_previews_expiry ON contest_game_rescore_previews(expires_at);

CREATE TABLE contest_game_rescore_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  contest_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  lineup_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('previewed', 'running', 'completed', 'failed')),
  error_code TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lineup_revision_id TEXT NULL,
  scoring_revision INTEGER NULL,
  claimed_at TEXT NULL,
  claim_token TEXT NULL,
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, lineup_version) REFERENCES contest_lineup_revisions(contest_id, version) ON DELETE CASCADE,
  FOREIGN KEY (contest_id, lineup_revision_id) REFERENCES contest_lineup_revisions(contest_id, revision_id) ON DELETE RESTRICT
);
CREATE INDEX idx_contest_game_rescore_jobs_scope ON contest_game_rescore_jobs(contest_id, updated_at DESC);

CREATE TABLE contest_game_rescore_audits (
  id TEXT PRIMARY KEY NOT NULL,
  contest_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  game_date TEXT NOT NULL,
  previous_version INTEGER NULL,
  lineup_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  executed_by INTEGER NOT NULL,
  executed_at TEXT NOT NULL,
  prediction_count INTEGER NOT NULL DEFAULT 0,
  changed_score_count INTEGER NOT NULL DEFAULT 0,
  perfect_count_delta INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('previewed', 'running', 'completed', 'failed')),
  error_code TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, lineup_version) REFERENCES contest_lineup_revisions(contest_id, version) ON DELETE CASCADE,
  FOREIGN KEY (executed_by) REFERENCES users(id) ON DELETE RESTRICT
);
CREATE INDEX idx_contest_game_rescore_audits_scope ON contest_game_rescore_audits(contest_id, executed_at DESC);

CREATE TABLE contest_ranking_test_game_settings (
  contest_id TEXT PRIMARY KEY NOT NULL,
  internal_game_id TEXT NOT NULL,
  include_in_public_ranking INTEGER NOT NULL DEFAULT 0 CHECK (include_in_public_ranking IN (0, 1)),
  updated_by TEXT NOT NULL CHECK (length(updated_by) <= 160),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE CASCADE
);

CREATE TABLE contest_ranking_test_predictions (
  contest_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 9),
  prediction_json TEXT NOT NULL CHECK (length(prediction_json) <= 16384),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'scored', 'invalid')),
  score INTEGER NULL,
  max_score INTEGER NULL,
  lineup_revision_id TEXT NULL,
  scoring_revision_id TEXT NULL,
  scored_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  scored_attempt_id TEXT NULL,
  PRIMARY KEY (contest_id, slot),
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE CASCADE,
  FOREIGN KEY (contest_id, lineup_revision_id) REFERENCES contest_lineup_revisions(contest_id, revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (contest_id, scoring_revision_id) REFERENCES contest_scoring_revisions(contest_id, id) ON DELETE RESTRICT
);

-- Backfill only when a physical game has exactly one contest. A game with two
-- registered contests has no trustworthy owner for game-only score/ranking/
-- publication state and therefore aborts the migration instead of guessing.
CREATE TABLE contest_a3_migration_assert (valid INTEGER NOT NULL CHECK (valid = 1));
WITH artifacts AS (
  SELECT 'game_scoring_revisions' AS source, s.internal_game_id FROM game_scoring_revisions s
  UNION ALL SELECT 'score_attempts', s.internal_game_id FROM score_attempts s
  UNION ALL SELECT 'ranking_games', COALESCE(r.internal_game_id, g.internal_game_id)
    FROM ranking_games r LEFT JOIN games g ON g.internal_game_id = r.game_id OR g.internal_game_id = r.internal_game_id
   WHERE r.is_test_game = 0
  UNION ALL SELECT 'ranking_eligibility_history', COALESCE(h.internal_game_id, g.internal_game_id)
    FROM ranking_eligibility_history h LEFT JOIN games g ON g.internal_game_id = h.game_id OR g.internal_game_id = h.internal_game_id
  UNION ALL SELECT 'ranking_reflection_revisions', r.internal_game_id FROM ranking_reflection_revisions r
  UNION ALL SELECT 'prediction_score_revisions', COALESCE(s.internal_game_id, p.internal_game_id)
    FROM prediction_score_revisions s JOIN predictions p ON p.id = s.prediction_id WHERE s.is_test_prediction = 0
  UNION ALL SELECT 'game_rescore_previews', COALESCE(l.internal_game_id, g.internal_game_id)
    FROM game_rescore_previews p LEFT JOIN game_lineup_revisions l ON l.game_id = p.game_id AND l.version = p.lineup_version
    LEFT JOIN games g ON g.internal_game_id = p.game_id OR g.internal_game_id = l.internal_game_id
  UNION ALL SELECT 'game_rescore_jobs', COALESCE(j.internal_game_id, g.internal_game_id)
    FROM game_rescore_jobs j LEFT JOIN games g ON g.internal_game_id = j.game_id OR g.internal_game_id = j.internal_game_id
  UNION ALL SELECT 'game_rescore_audits', g.internal_game_id
    FROM game_rescore_audits a LEFT JOIN games g
      ON g.internal_game_id = a.game_id
      OR g.internal_game_id = (
        SELECT MIN(gi.internal_game_id) FROM game_identifiers gi
         WHERE gi.identifier_value = a.game_id
         GROUP BY gi.identifier_value
        HAVING COUNT(DISTINCT gi.internal_game_id) = 1
      )
  UNION ALL SELECT 'perfect_achievers', COALESCE(g.internal_game_id, p.internal_game_id)
    FROM perfect_achievers a LEFT JOIN games g ON g.internal_game_id = a.game_id
    LEFT JOIN predictions p ON p.game_id = a.game_id AND p.user_id = a.user_id
  UNION ALL SELECT 'ranking_test_game_settings', s.internal_game_id FROM ranking_test_game_settings s
  UNION ALL SELECT 'ranking_test_predictions', p.internal_game_id FROM ranking_test_predictions p
), ambiguous AS (
  SELECT 1 FROM artifacts a
   WHERE a.internal_game_id IS NULL
      OR (SELECT COUNT(*) FROM game_contests c WHERE c.internal_game_id = a.internal_game_id) <> 1
      OR (SELECT COUNT(*) FROM game_contests c WHERE c.internal_game_id = a.internal_game_id AND c.target_team_key = 'fighters') <> 1
)
INSERT INTO contest_a3_migration_assert(valid)
SELECT CASE WHEN EXISTS (SELECT 1 FROM ambiguous) THEN 0 ELSE 1 END;
DROP TABLE contest_a3_migration_assert;

INSERT INTO contest_scoring_revisions (
  contest_id, internal_game_id, id, game_id, revision_number, lineup_revision_id, status,
  reason, created_by, created_at, completed_at, is_active, committed_attempt_id
)
SELECT c.contest_id, s.internal_game_id, s.id, s.game_id, s.revision_number, s.lineup_revision_id,
       s.status, s.reason, s.created_by, s.created_at, s.completed_at, s.is_active, s.committed_attempt_id
  FROM game_scoring_revisions s JOIN game_contests c ON c.internal_game_id = s.internal_game_id AND c.target_team_key = 'fighters'
 WHERE (SELECT COUNT(*) FROM game_contests c2 WHERE c2.internal_game_id = s.internal_game_id) = 1;

INSERT INTO contest_score_attempts (
  attempt_id, contest_id, internal_game_id, game_id, canonical_lineup_revision_id,
  scoring_lineup_revision_id, canonical_lineup_fingerprint, job_id, claim_token, status,
  expected_prediction_count, expected_test_count, scoring_revision_id, scoring_revision_number,
  actual_lineup_json, commit_nonce, created_at, ready_at, committed_at
)
SELECT a.attempt_id, c.contest_id, a.internal_game_id, a.game_id, a.canonical_lineup_revision_id,
       a.scoring_lineup_revision_id, a.canonical_lineup_fingerprint, a.job_id, a.claim_token, a.status,
       a.expected_prediction_count, a.expected_test_count, a.scoring_revision_id, a.scoring_revision_number,
       a.actual_lineup_json, a.commit_nonce, a.created_at, a.ready_at, a.committed_at
  FROM score_attempts a JOIN game_contests c ON c.internal_game_id = a.internal_game_id AND c.target_team_key = 'fighters'
 WHERE (SELECT COUNT(*) FROM game_contests c2 WHERE c2.internal_game_id = a.internal_game_id) = 1;
INSERT INTO contest_score_attempt_prediction_rows (
  attempt_id, contest_id, prediction_id, outcome, validity_status, total_score, max_score,
  participation_score, batting_order_score, defense_score, perfect_bonus, player_hits, order_hits,
  position_hits, perfect_hits, exclusion_reason, lineage_json
)
SELECT r.attempt_id, a.contest_id, r.prediction_id, r.outcome, r.validity_status, r.total_score, r.max_score,
       r.participation_score, r.batting_order_score, r.defense_score, r.perfect_bonus, r.player_hits, r.order_hits,
       r.position_hits, r.perfect_hits, r.exclusion_reason, r.lineage_json
  FROM score_attempt_prediction_rows r JOIN contest_score_attempts a ON a.attempt_id = r.attempt_id;
INSERT INTO contest_score_attempt_test_rows
SELECT * FROM score_attempt_test_rows WHERE attempt_id IN (SELECT attempt_id FROM contest_score_attempts);

INSERT INTO contest_prediction_score_revisions (
  id, contest_id, prediction_id, game_id, internal_game_id, is_test_prediction, scoring_revision,
  lineup_revision_id, score, max_score, actual_lineup_json, scored_at, scored_by, created_at
)
SELECT s.id, p.contest_id, s.prediction_id, s.game_id, p.internal_game_id, s.is_test_prediction,
       s.scoring_revision, s.lineup_revision_id, s.score, s.max_score, s.actual_lineup_json,
       s.scored_at, s.scored_by, s.created_at
  FROM prediction_score_revisions s JOIN predictions p ON p.id = s.prediction_id
 WHERE p.contest_id IS NOT NULL AND s.is_test_prediction = 0;

INSERT INTO contest_ranking_games (
  contest_id, internal_game_id, game_id, is_ranking_eligible, ranking_eligible_at, game_status,
  is_test_game, created_at, updated_at, game_date, scored_private_at, published_at, publication_status,
  ranking_eligibility_status, ranking_eligibility_reason, ranking_eligibility_note, ranking_eligibility_version,
  ranking_eligibility_updated_by, ranking_eligibility_updated_at
)
SELECT c.contest_id, COALESCE(r.internal_game_id, g.internal_game_id), r.game_id, r.is_ranking_eligible,
       r.ranking_eligible_at, r.game_status, r.is_test_game, r.created_at, r.updated_at, r.game_date,
       r.scored_private_at, r.published_at, r.publication_status, r.ranking_eligibility_status,
       r.ranking_eligibility_reason, r.ranking_eligibility_note, r.ranking_eligibility_version,
       r.ranking_eligibility_updated_by, r.ranking_eligibility_updated_at
  FROM ranking_games r
  JOIN games g ON g.internal_game_id = COALESCE(r.internal_game_id, r.game_id)
  JOIN game_contests c ON c.internal_game_id = g.internal_game_id AND c.target_team_key = 'fighters'
 WHERE r.is_test_game = 0
   AND (SELECT COUNT(*) FROM game_contests c2 WHERE c2.internal_game_id = g.internal_game_id) = 1;

INSERT INTO contest_ranking_eligibility_history (
  id, contest_id, internal_game_id, game_id, previous_status, next_status, reason, note, version, updated_by, updated_at
)
SELECT h.id, c.contest_id, COALESCE(h.internal_game_id, g.internal_game_id), h.game_id, h.previous_status,
       h.next_status, h.reason, h.note, h.version, h.updated_by, h.updated_at
  FROM ranking_eligibility_history h
  JOIN games g ON g.internal_game_id = COALESCE(h.internal_game_id, h.game_id)
  JOIN game_contests c ON c.internal_game_id = g.internal_game_id AND c.target_team_key = 'fighters'
 WHERE (SELECT COUNT(*) FROM game_contests c2 WHERE c2.internal_game_id = g.internal_game_id) = 1;

INSERT INTO contest_ranking_reflection_revisions (
  id, contest_id, internal_game_id, scoring_revision_id, ranking_eligibility_version,
  ranking_update_revision, status, reflected_at, created_at
)
SELECT c.contest_id || ':' || r.id, c.contest_id, r.internal_game_id,
       COALESCE(scoring.id, CASE WHEN r.scoring_revision_id IN ('none', 'excluded') THEN active.id END),
       r.ranking_eligibility_version, r.ranking_update_revision, r.status, r.reflected_at, r.created_at
  FROM ranking_reflection_revisions r
  JOIN game_contests c ON c.internal_game_id = r.internal_game_id AND c.target_team_key = 'fighters'
   AND (SELECT COUNT(*) FROM game_contests c2 WHERE c2.internal_game_id = r.internal_game_id) = 1
  LEFT JOIN contest_scoring_revisions scoring ON scoring.contest_id = c.contest_id
    AND scoring.internal_game_id = r.internal_game_id AND scoring.id = r.scoring_revision_id
  LEFT JOIN contest_scoring_revisions active ON active.contest_id = c.contest_id
    AND active.internal_game_id = r.internal_game_id AND active.is_active = 1;

INSERT INTO contest_perfect_achievers (id, contest_id, internal_game_id, user_id, game_id, score, max_score, achieved_at, created_at)
SELECT a.id, c.contest_id, COALESCE(g.internal_game_id, p.internal_game_id), a.user_id, a.game_id,
       a.score, a.max_score, a.achieved_at, a.created_at
  FROM perfect_achievers a
  LEFT JOIN games g ON g.internal_game_id = a.game_id
  LEFT JOIN predictions p ON p.game_id = a.game_id AND p.user_id = a.user_id
  JOIN game_contests c ON c.internal_game_id = COALESCE(g.internal_game_id, p.internal_game_id)
    AND c.target_team_key = 'fighters'
 WHERE (SELECT COUNT(*) FROM game_contests c2 WHERE c2.internal_game_id = COALESCE(g.internal_game_id, p.internal_game_id)) = 1;

INSERT INTO contest_game_rescore_previews (
  id, contest_id, internal_game_id, game_id, lineup_version, created_by, reason, summary_json,
  expected_prediction_count, expires_at, created_at
)
SELECT p.id, c.contest_id, c.internal_game_id, p.game_id, p.lineup_version, p.created_by, p.reason,
       p.summary_json, p.expected_prediction_count, p.expires_at, p.created_at
  FROM game_rescore_previews p JOIN game_lineup_revisions l ON l.game_id = p.game_id AND l.version = p.lineup_version
  JOIN game_contests c ON c.internal_game_id = l.internal_game_id AND c.target_team_key = 'fighters'
 WHERE (SELECT COUNT(*) FROM game_contests c2 WHERE c2.internal_game_id = l.internal_game_id) = 1;
INSERT INTO contest_game_rescore_jobs (
  id, contest_id, internal_game_id, game_id, lineup_version, status, error_code, created_at, updated_at,
  lineup_revision_id, scoring_revision, claimed_at, claim_token
)
SELECT j.id, c.contest_id, COALESCE(j.internal_game_id, c.internal_game_id), j.game_id, j.lineup_version,
       j.status, j.error_code, j.created_at, j.updated_at, j.lineup_revision_id, j.scoring_revision, j.claimed_at, j.claim_token
  FROM game_rescore_jobs j
  LEFT JOIN game_lineup_revisions l ON l.game_id = j.game_id AND l.version = j.lineup_version
  LEFT JOIN games g ON g.internal_game_id = COALESCE(j.internal_game_id, l.internal_game_id, j.game_id)
  JOIN game_contests c ON c.internal_game_id = COALESCE(j.internal_game_id, l.internal_game_id, g.internal_game_id)
    AND c.target_team_key = 'fighters'
 WHERE (SELECT COUNT(*) FROM game_contests c2
         WHERE c2.internal_game_id = COALESCE(j.internal_game_id, l.internal_game_id, g.internal_game_id)) = 1;
INSERT INTO contest_game_rescore_audits (
  id, contest_id, internal_game_id, game_id, game_date, previous_version, lineup_version, reason,
  executed_by, executed_at, prediction_count, changed_score_count, perfect_count_delta, status,
  error_code, created_at, updated_at
)
SELECT a.id, c.contest_id, c.internal_game_id, a.game_id, a.game_date,
       a.previous_version, a.lineup_version, a.reason, a.executed_by, a.executed_at, a.prediction_count,
       a.changed_score_count, a.perfect_count_delta, a.status, a.error_code, a.created_at, a.updated_at
  FROM game_rescore_audits a JOIN games g
    ON g.internal_game_id = a.game_id
    OR g.internal_game_id IN (
      SELECT gi.internal_game_id FROM game_identifiers gi
       WHERE gi.identifier_value = a.game_id
       GROUP BY gi.identifier_value
      HAVING COUNT(DISTINCT gi.internal_game_id) = 1
    )
  JOIN game_contests c ON c.internal_game_id = g.internal_game_id AND c.target_team_key = 'fighters'
 WHERE (SELECT COUNT(*) FROM game_contests c2 WHERE c2.internal_game_id = g.internal_game_id AND c2.target_team_key = 'fighters') = 1;

INSERT INTO contest_ranking_test_game_settings
  (contest_id, internal_game_id, include_in_public_ranking, updated_by, created_at, updated_at)
SELECT c.contest_id, s.internal_game_id, s.include_in_public_ranking, s.updated_by, s.created_at, s.updated_at
  FROM ranking_test_game_settings s JOIN game_contests c ON c.internal_game_id = s.internal_game_id AND c.target_team_key = 'fighters'
 WHERE (SELECT COUNT(*) FROM game_contests c2 WHERE c2.internal_game_id = s.internal_game_id) = 1;
INSERT INTO contest_ranking_test_predictions
  (contest_id, internal_game_id, slot, prediction_json, status, score, max_score, lineup_revision_id,
   scoring_revision_id, scored_at, created_at, updated_at, scored_attempt_id)
SELECT c.contest_id, p.internal_game_id, p.slot, p.prediction_json, p.status, p.score, p.max_score,
       p.lineup_revision_id, s.id, p.scored_at, p.created_at, p.updated_at, p.scored_attempt_id
  FROM ranking_test_predictions p JOIN game_contests c ON c.internal_game_id = p.internal_game_id AND c.target_team_key = 'fighters'
  LEFT JOIN contest_scoring_revisions s ON s.contest_id = c.contest_id AND s.internal_game_id = p.internal_game_id
    AND s.id = p.scoring_revision_id
 WHERE (SELECT COUNT(*) FROM game_contests c2 WHERE c2.internal_game_id = p.internal_game_id) = 1;

PRAGMA defer_foreign_keys = OFF;
