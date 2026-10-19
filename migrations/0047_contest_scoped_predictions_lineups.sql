PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = ON;

-- A2 stores current prediction and canonical-lineup ownership by contest. The
-- physical game remains available to A3/A4 scoring and automation bridges.
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_contests_id_game
  ON game_contests(contest_id, internal_game_id);

CREATE TRIGGER IF NOT EXISTS game_contests_require_participant_insert
BEFORE INSERT ON game_contests
WHEN NOT EXISTS (
  SELECT 1 FROM games AS g
   WHERE g.internal_game_id = NEW.internal_game_id
     AND (
       lower(replace(replace(replace(replace(trim(g.home_team), ' ', ''), '　', ''), '・', ''), '.', '')) = NEW.target_team_key
       OR lower(replace(replace(replace(replace(trim(g.away_team), ' ', ''), '　', ''), '・', ''), '.', '')) = NEW.target_team_key
       OR
       (NEW.target_team_key = 'fighters' AND (
         lower(replace(replace(replace(replace(trim(g.home_team), ' ', ''), '　', ''), '・', ''), '.', ''))
           IN ('f', 'fighters', '北海道日本ハムファイターズ', '北海道日本ハム', '日本ハムファイターズ', '日本ハム', 'ファイターズ')
         OR lower(replace(replace(replace(replace(trim(g.away_team), ' ', ''), '　', ''), '・', ''), '.', ''))
           IN ('f', 'fighters', '北海道日本ハムファイターズ', '北海道日本ハム', '日本ハムファイターズ', '日本ハム', 'ファイターズ')
       ))
       OR
       (NEW.target_team_key = 'marines' AND (
         lower(replace(replace(replace(replace(trim(g.home_team), ' ', ''), '　', ''), '・', ''), '.', ''))
           IN ('m', 'marines', '千葉ロッテマリーンズ', 'ロッテマリーンズ', 'ロッテ', 'マリーンズ')
         OR lower(replace(replace(replace(replace(trim(g.away_team), ' ', ''), '　', ''), '・', ''), '.', ''))
           IN ('m', 'marines', '千葉ロッテマリーンズ', 'ロッテマリーンズ', 'ロッテ', 'マリーンズ')
       ))
     )
)
BEGIN
  SELECT RAISE(ABORT, 'CONTEST_TARGET_NOT_A_GAME_PARTICIPANT');
END;

CREATE TRIGGER IF NOT EXISTS game_contests_require_participant_update
BEFORE UPDATE OF internal_game_id, target_team_key ON game_contests
WHEN NOT EXISTS (
  SELECT 1 FROM games AS g
   WHERE g.internal_game_id = NEW.internal_game_id
     AND (
       lower(replace(replace(replace(replace(trim(g.home_team), ' ', ''), '　', ''), '・', ''), '.', '')) = NEW.target_team_key
       OR lower(replace(replace(replace(replace(trim(g.away_team), ' ', ''), '　', ''), '・', ''), '.', '')) = NEW.target_team_key
       OR
       (NEW.target_team_key = 'fighters' AND (
         lower(replace(replace(replace(replace(trim(g.home_team), ' ', ''), '　', ''), '・', ''), '.', ''))
           IN ('f', 'fighters', '北海道日本ハムファイターズ', '北海道日本ハム', '日本ハムファイターズ', '日本ハム', 'ファイターズ')
         OR lower(replace(replace(replace(replace(trim(g.away_team), ' ', ''), '　', ''), '・', ''), '.', ''))
           IN ('f', 'fighters', '北海道日本ハムファイターズ', '北海道日本ハム', '日本ハムファイターズ', '日本ハム', 'ファイターズ')
       ))
       OR
       (NEW.target_team_key = 'marines' AND (
         lower(replace(replace(replace(replace(trim(g.home_team), ' ', ''), '　', ''), '・', ''), '.', ''))
           IN ('m', 'marines', '千葉ロッテマリーンズ', 'ロッテマリーンズ', 'ロッテ', 'マリーンズ')
         OR lower(replace(replace(replace(replace(trim(g.away_team), ' ', ''), '　', ''), '・', ''), '.', ''))
           IN ('m', 'marines', '千葉ロッテマリーンズ', 'ロッテマリーンズ', 'ロッテ', 'マリーンズ')
       ))
     )
)
BEGIN
  SELECT RAISE(ABORT, 'CONTEST_TARGET_NOT_A_GAME_PARTICIPANT');
END;

-- Legacy production rows can be assigned only when their persisted physical
-- identity (or a unique historical identifier) proves exactly one Fighters
-- contest. Test-only rows keep contest_id NULL and retain their existing scope.
CREATE TABLE contest_identity_a2_migration_assert (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

WITH prediction_games AS (
  SELECT p.id,
    CASE
      WHEN p.internal_game_id IS NOT NULL AND p.internal_game_id <> '' THEN p.internal_game_id
      WHEN EXISTS (SELECT 1 FROM games g WHERE g.internal_game_id = p.game_id) THEN p.game_id
      WHEN (SELECT COUNT(DISTINCT gi.internal_game_id) FROM game_identifiers gi WHERE gi.identifier_value = p.game_id) = 1
        THEN (SELECT MIN(gi.internal_game_id) FROM game_identifiers gi WHERE gi.identifier_value = p.game_id)
      WHEN (SELECT COUNT(DISTINCT d.internal_game_id) FROM detected_game_schedule d WHERE d.game_id = p.game_id AND d.internal_game_id IS NOT NULL AND d.internal_game_id <> '') = 1
        THEN (SELECT MIN(d.internal_game_id) FROM detected_game_schedule d WHERE d.game_id = p.game_id AND d.internal_game_id IS NOT NULL AND d.internal_game_id <> '')
      ELSE NULL
    END AS internal_game_id
  FROM predictions p
  WHERE p.is_test_prediction = 0
), lineup_games AS (
  SELECT l.id,
    CASE
      WHEN l.internal_game_id IS NOT NULL AND l.internal_game_id <> '' THEN l.internal_game_id
      WHEN EXISTS (SELECT 1 FROM games g WHERE g.internal_game_id = l.game_id) THEN l.game_id
      WHEN (SELECT COUNT(DISTINCT gi.internal_game_id) FROM game_identifiers gi WHERE gi.identifier_value = l.game_id) = 1
        THEN (SELECT MIN(gi.internal_game_id) FROM game_identifiers gi WHERE gi.identifier_value = l.game_id)
      WHEN (SELECT COUNT(DISTINCT d.internal_game_id) FROM detected_game_schedule d WHERE d.game_id = l.game_id AND d.internal_game_id IS NOT NULL AND d.internal_game_id <> '') = 1
        THEN (SELECT MIN(d.internal_game_id) FROM detected_game_schedule d WHERE d.game_id = l.game_id AND d.internal_game_id IS NOT NULL AND d.internal_game_id <> '')
      ELSE NULL
    END AS internal_game_id
  FROM game_lineups l
  WHERE NOT EXISTS (SELECT 1 FROM test_games t WHERE t.game_id = l.game_id)
), unresolved AS (
  SELECT 1 FROM prediction_games p
   WHERE p.internal_game_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM games g WHERE g.internal_game_id = p.internal_game_id)
      OR NOT EXISTS (SELECT 1 FROM game_contests c WHERE c.internal_game_id = p.internal_game_id AND c.target_team_key = 'fighters')
  UNION ALL
  SELECT 1 FROM lineup_games l
   WHERE l.internal_game_id IS NULL
      OR NOT EXISTS (SELECT 1 FROM games g WHERE g.internal_game_id = l.internal_game_id)
      OR NOT EXISTS (SELECT 1 FROM game_contests c WHERE c.internal_game_id = l.internal_game_id AND c.target_team_key = 'fighters')
)
INSERT INTO contest_identity_a2_migration_assert(valid)
SELECT CASE WHEN EXISTS (SELECT 1 FROM unresolved) THEN 0 ELSE 1 END;

DROP TABLE contest_identity_a2_migration_assert;

CREATE TABLE predictions_a2 (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  contest_id TEXT NULL,
  prediction_json TEXT NOT NULL CHECK (length(prediction_json) <= 16384),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  game_date TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  opponent_code TEXT NOT NULL,
  is_home INTEGER NOT NULL CHECK (is_home IN (0, 1)),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  locked_at TEXT NULL,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('draft', 'submitted', 'locked', 'scored')),
  score INTEGER NULL,
  max_score INTEGER NULL,
  scored_at TEXT NULL,
  actual_lineup_json TEXT NULL,
  is_test_prediction INTEGER NOT NULL DEFAULT 0 CHECK (is_test_prediction IN (0, 1)),
  internal_game_id TEXT NULL,
  scored_lineup_revision_id TEXT NULL,
  scoring_revision INTEGER NOT NULL DEFAULT 0,
  scored_by TEXT NULL,
  scoring_status TEXT NOT NULL DEFAULT 'pending' CHECK (scoring_status IN ('pending', 'scored', 'excluded', 'failed')),
  scoring_exclusion_reason TEXT NULL,
  scored_attempt_id TEXT NULL,
  UNIQUE (user_id, contest_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT
);

WITH prediction_games AS (
  SELECT p.id,
    CASE
      WHEN p.internal_game_id IS NOT NULL AND p.internal_game_id <> '' THEN p.internal_game_id
      WHEN EXISTS (SELECT 1 FROM games g WHERE g.internal_game_id = p.game_id) THEN p.game_id
      WHEN (SELECT COUNT(DISTINCT gi.internal_game_id) FROM game_identifiers gi WHERE gi.identifier_value = p.game_id) = 1
        THEN (SELECT MIN(gi.internal_game_id) FROM game_identifiers gi WHERE gi.identifier_value = p.game_id)
      WHEN (SELECT COUNT(DISTINCT d.internal_game_id) FROM detected_game_schedule d WHERE d.game_id = p.game_id AND d.internal_game_id IS NOT NULL AND d.internal_game_id <> '') = 1
        THEN (SELECT MIN(d.internal_game_id) FROM detected_game_schedule d WHERE d.game_id = p.game_id AND d.internal_game_id IS NOT NULL AND d.internal_game_id <> '')
      ELSE NULL
    END AS internal_game_id
  FROM predictions p
)
INSERT INTO predictions_a2 (
  id, user_id, game_id, contest_id, prediction_json, schema_version, game_date, home_team, away_team,
  opponent_code, is_home, submitted_at, updated_at, locked_at, status, score, max_score, scored_at,
  actual_lineup_json, is_test_prediction, internal_game_id, scored_lineup_revision_id, scoring_revision,
  scored_by, scoring_status, scoring_exclusion_reason, scored_attempt_id
)
SELECT p.id, p.user_id, p.game_id,
       CASE WHEN p.is_test_prediction = 1 THEN NULL ELSE c.contest_id END,
       p.prediction_json, p.schema_version, p.game_date, p.home_team, p.away_team, p.opponent_code,
       p.is_home, p.submitted_at, p.updated_at, p.locked_at, p.status, p.score, p.max_score, p.scored_at,
       p.actual_lineup_json, p.is_test_prediction, COALESCE(pg.internal_game_id, p.internal_game_id),
       p.scored_lineup_revision_id, p.scoring_revision, p.scored_by, p.scoring_status,
       p.scoring_exclusion_reason, p.scored_attempt_id
  FROM predictions p
  LEFT JOIN prediction_games pg ON pg.id = p.id
  LEFT JOIN game_contests c ON c.internal_game_id = pg.internal_game_id AND c.target_team_key = 'fighters';

DROP TABLE predictions;
ALTER TABLE predictions_a2 RENAME TO predictions;

CREATE INDEX idx_predictions_game_id ON predictions(game_id);
CREATE INDEX idx_predictions_user_updated ON predictions(user_id, updated_at);
CREATE INDEX idx_predictions_ranking_scores ON predictions(game_id, status, is_test_prediction, user_id, scored_at);
CREATE INDEX idx_predictions_internal_game_id ON predictions(internal_game_id);
CREATE INDEX idx_predictions_scoring_revision ON predictions(internal_game_id, scored_lineup_revision_id, scoring_revision);
CREATE INDEX idx_predictions_scored_attempt ON predictions(internal_game_id, scored_attempt_id);
CREATE UNIQUE INDEX idx_predictions_legacy_test_identity
  ON predictions(user_id, game_id) WHERE is_test_prediction = 1 AND contest_id IS NULL;

CREATE TRIGGER predictions_require_contest_insert
BEFORE INSERT ON predictions
WHEN NEW.is_test_prediction = 0 AND (
  NEW.contest_id IS NULL OR NEW.internal_game_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM game_contests c
     WHERE c.contest_id = NEW.contest_id AND c.internal_game_id = NEW.internal_game_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'PREDICTION_CONTEST_GAME_MISMATCH');
END;

CREATE TRIGGER predictions_require_contest_update
BEFORE UPDATE OF contest_id, internal_game_id, is_test_prediction ON predictions
WHEN NEW.is_test_prediction = 0 AND (
  NEW.contest_id IS NULL OR NEW.internal_game_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM game_contests c
     WHERE c.contest_id = NEW.contest_id AND c.internal_game_id = NEW.internal_game_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'PREDICTION_CONTEST_GAME_MISMATCH');
END;

CREATE TABLE game_lineups_a2 (
  id TEXT PRIMARY KEY NOT NULL,
  game_id TEXT NOT NULL,
  contest_id TEXT NULL,
  actual_lineup_json TEXT NOT NULL CHECK (length(actual_lineup_json) <= 16384),
  lineup_fingerprint TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  lineup_detected_at TEXT NOT NULL,
  scoring_due_at TEXT NOT NULL,
  scoring_started_at TEXT NULL,
  scored_at TEXT NULL,
  scoring_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (scoring_status IN ('pending', 'processing', 'scored', 'failed', 'cancelled')),
  scoring_attempts INTEGER NOT NULL DEFAULT 0 CHECK (scoring_attempts >= 0),
  last_error TEXT NULL,
  processed_predictions INTEGER NULL,
  perfect_count INTEGER NULL,
  new_perfect_achievers INTEGER NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lineup_source TEXT NOT NULL DEFAULT 'manual' CHECK (lineup_source IN ('manual', 'npb-auto')),
  publication_status TEXT NOT NULL DEFAULT 'pending' CHECK (publication_status IN ('pending', 'scored_private', 'published')),
  published_at TEXT NULL,
  internal_game_id TEXT NULL,
  final_lineup_revision_id TEXT NULL,
  finalized_at TEXT NULL,
  finalized_by TEXT NULL,
  scoring_lineup_revision_id TEXT NULL,
  scoring_revision INTEGER NOT NULL DEFAULT 0,
  scored_by TEXT NULL,
  UNIQUE (contest_id),
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT
);

WITH lineup_games AS (
  SELECT l.id,
    CASE
      WHEN l.internal_game_id IS NOT NULL AND l.internal_game_id <> '' THEN l.internal_game_id
      WHEN EXISTS (SELECT 1 FROM games g WHERE g.internal_game_id = l.game_id) THEN l.game_id
      WHEN (SELECT COUNT(DISTINCT gi.internal_game_id) FROM game_identifiers gi WHERE gi.identifier_value = l.game_id) = 1
        THEN (SELECT MIN(gi.internal_game_id) FROM game_identifiers gi WHERE gi.identifier_value = l.game_id)
      WHEN (SELECT COUNT(DISTINCT d.internal_game_id) FROM detected_game_schedule d WHERE d.game_id = l.game_id AND d.internal_game_id IS NOT NULL AND d.internal_game_id <> '') = 1
        THEN (SELECT MIN(d.internal_game_id) FROM detected_game_schedule d WHERE d.game_id = l.game_id AND d.internal_game_id IS NOT NULL AND d.internal_game_id <> '')
      ELSE NULL
    END AS internal_game_id
  FROM game_lineups l
)
INSERT INTO game_lineups_a2 (
  id, game_id, contest_id, actual_lineup_json, lineup_fingerprint, schema_version, lineup_detected_at,
  scoring_due_at, scoring_started_at, scored_at, scoring_status, scoring_attempts, last_error,
  processed_predictions, perfect_count, new_perfect_achievers, created_at, updated_at, lineup_source,
  publication_status, published_at, internal_game_id, final_lineup_revision_id, finalized_at,
  finalized_by, scoring_lineup_revision_id, scoring_revision, scored_by
)
SELECT l.id, l.game_id, c.contest_id, l.actual_lineup_json, l.lineup_fingerprint, l.schema_version,
       l.lineup_detected_at, l.scoring_due_at, l.scoring_started_at, l.scored_at, l.scoring_status,
       l.scoring_attempts, l.last_error, l.processed_predictions, l.perfect_count, l.new_perfect_achievers,
       l.created_at, l.updated_at, l.lineup_source, l.publication_status, l.published_at,
       lg.internal_game_id, l.final_lineup_revision_id, l.finalized_at, l.finalized_by,
       l.scoring_lineup_revision_id, l.scoring_revision, l.scored_by
  FROM game_lineups l
  LEFT JOIN lineup_games lg ON lg.id = l.id
  LEFT JOIN game_contests c ON c.internal_game_id = lg.internal_game_id AND c.target_team_key = 'fighters';

DROP TABLE game_lineups;
ALTER TABLE game_lineups_a2 RENAME TO game_lineups;

CREATE INDEX idx_game_lineups_due ON game_lineups(scoring_status, scoring_due_at, scoring_attempts);
CREATE INDEX idx_game_lineups_game_status ON game_lineups(game_id, scoring_status);
CREATE INDEX idx_game_lineups_publication ON game_lineups(publication_status, published_at, scoring_status);
CREATE INDEX idx_game_lineups_internal_game_id ON game_lineups(internal_game_id);
CREATE INDEX idx_game_lineups_final_revision ON game_lineups(internal_game_id, final_lineup_revision_id);
CREATE UNIQUE INDEX idx_game_lineups_legacy_test_game ON game_lineups(game_id) WHERE contest_id IS NULL;

CREATE TRIGGER game_lineups_require_contest_insert
BEFORE INSERT ON game_lineups
WHEN (NEW.internal_game_id IS NOT NULL OR NEW.contest_id IS NOT NULL) AND (
  NEW.contest_id IS NULL OR NEW.internal_game_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM game_contests c
     WHERE c.contest_id = NEW.contest_id AND c.internal_game_id = NEW.internal_game_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'LINEUP_CONTEST_GAME_MISMATCH');
END;

CREATE TRIGGER game_lineups_require_contest_update
BEFORE UPDATE OF contest_id, internal_game_id ON game_lineups
WHEN (NEW.internal_game_id IS NOT NULL OR NEW.contest_id IS NOT NULL) AND (
  NEW.contest_id IS NULL OR NEW.internal_game_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM game_contests c
     WHERE c.contest_id = NEW.contest_id AND c.internal_game_id = NEW.internal_game_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'LINEUP_CONTEST_GAME_MISMATCH');
END;

-- C-4A2 owns lineup revisions as well as the current canonical pointer. Keep
-- the old game-scoped table as the Fighters scoring bridge for A3, while the
-- contest table prevents another club's candidate/final revision from
-- superseding it. Rescore previews/jobs remain on the legacy bridge until A3.
CREATE TABLE contest_lineup_revisions (
  contest_id TEXT NOT NULL,
  internal_game_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  revision_id TEXT NOT NULL UNIQUE,
  actual_lineup_json TEXT NOT NULL CHECK (length(actual_lineup_json) <= 16384),
  lineup_fingerprint TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('npb-auto', 'manual', 'manual-revision', 'restore')),
  created_at TEXT NOT NULL,
  created_by INTEGER NULL,
  reason TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  superseded_at TEXT NULL,
  captured_at TEXT NULL,
  validation_json TEXT NULL,
  finalized_at TEXT NULL,
  finalized_by TEXT NULL,
  unresolved_player_count INTEGER NOT NULL DEFAULT 0 CHECK (unresolved_player_count >= 0),
  is_final INTEGER NOT NULL DEFAULT 0 CHECK (is_final IN (0, 1)),
  PRIMARY KEY (contest_id, version),
  FOREIGN KEY (contest_id, internal_game_id) REFERENCES game_contests(contest_id, internal_game_id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO contest_lineup_revisions (
  contest_id, internal_game_id, game_id, version, revision_id, actual_lineup_json,
  lineup_fingerprint, source, created_at, created_by, reason, is_current, superseded_at,
  captured_at, validation_json, finalized_at, finalized_by, unresolved_player_count, is_final
)
SELECT contests.contest_id, contests.internal_game_id, revisions.game_id, revisions.version,
       COALESCE(revisions.revision_id, revisions.game_id || ':' || revisions.version),
       revisions.actual_lineup_json, revisions.lineup_fingerprint, revisions.source,
       revisions.created_at, revisions.created_by, revisions.reason, revisions.is_current,
       revisions.superseded_at, revisions.captured_at, revisions.validation_json,
       revisions.finalized_at, revisions.finalized_by, revisions.unresolved_player_count,
       revisions.is_final
  FROM game_lineup_revisions AS revisions
  JOIN game_contests AS contests
    ON contests.internal_game_id = revisions.internal_game_id
   AND contests.target_team_key = 'fighters';

CREATE UNIQUE INDEX idx_contest_lineup_revisions_current
  ON contest_lineup_revisions(contest_id) WHERE is_current = 1;
CREATE INDEX idx_contest_lineup_revisions_history
  ON contest_lineup_revisions(contest_id, version DESC);
