import {
  getEffectiveRankingCutoffBoundary,
  getRankingCutoffBoundary,
  getRankingResetDateBoundary,
  toPublicRankingRow
} from "../domain/ranking.js";
import { DAILY_BEST_NINE_LIMIT, toPublicDailyBestNineRow } from "../domain/public-results.js";
import { RANKING_TEST_SLOT_MAX, rankingTestUsername } from "../domain/ranking-test-users.js";
import { createV3Error } from "../../game-automation-v3.js";

const RANKING_ACHIEVEMENT_DISPLAY_LIMIT = 3;

// Ranking reset marker reads are kept behind a repository boundary. The
// preview path is read-only; execute remains in the authenticated route.
export async function getActiveRankingResetMarker(db, { periodType, periodKey, strict = false } = {}) {
  try {
    return await db.prepare(
      `SELECT id, period_type, period_key, reset_at, reason, created_by, created_at, is_active
         FROM ranking_reset_markers
        WHERE period_type = ?1 AND period_key = ?2 AND is_active = 1
        ORDER BY id DESC
        LIMIT 1`
    ).bind(periodType, periodKey).first();
  } catch (error) {
    if (!strict && /no such table|does not exist/i.test(String(error?.message || error))) return null;
    throw createV3Error("RANKING_RESET_SCHEMA_UNAVAILABLE", "ランキングリセットのschemaが利用できません。", { httpStatus: 503, cause: error });
  }
}

export async function listRankingResetMarkers(db, { periodType = "", periodKey = "" } = {}) {
  return db.prepare(
    `SELECT id, period_type, period_key, reset_at, reason, created_by, created_at, is_active
       FROM ranking_reset_markers
      WHERE (?1 = '' OR period_type = ?1) AND (?2 = '' OR period_key = ?2)
      ORDER BY created_at DESC, id DESC
      LIMIT 100`
  ).bind(periodType, periodKey).all();
}

export async function insertRankingResetMarker(db, { periodType, periodKey, resetAt, reason, createdBy, createdAt }) {
  return db.prepare(
    `INSERT INTO ranking_reset_markers
       (period_type, period_key, reset_at, reason, created_by, created_at, is_active)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)`
  ).bind(periodType, periodKey, resetAt, reason, String(createdBy), createdAt).run();
}

function rankingResetPeriodRange(periodType, periodKey) {
  if (periodType === "yearly") {
    const year = Number(periodKey);
    return { startAt: `${periodKey}-01-01`, endAt: `${String(year + 1).padStart(4, "0")}-01-01` };
  }
  const [year, month] = periodKey.split("-").map(Number);
  return {
    startAt: `${periodKey}-01`,
    endAt: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10)
  };
}

export async function getRankingResetPreview(db, { periodType, periodKey, resetAt, resetBoundary = "" } = {}) {
  const range = rankingResetPeriodRange(periodType, periodKey);
  const boundary = resetBoundary || getRankingResetDateBoundary(resetAt);
  const [beforeGames, remainingGames, beforePredictions, remainingPredictions] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS count FROM ranking_games
        WHERE game_date >= ?1 AND game_date < ?2 AND game_date < ?3
          AND is_ranking_eligible = 1 AND game_status = 'scored' AND is_test_game = 0`
    ).bind(range.startAt, range.endAt, boundary).first(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM ranking_games
        WHERE game_date >= ?1 AND game_date < ?2 AND game_date >= ?3
          AND is_ranking_eligible = 1 AND game_status = 'scored' AND is_test_game = 0`
    ).bind(range.startAt, range.endAt, boundary).first(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM predictions
        JOIN ranking_games ON ranking_games.game_id = predictions.game_id
        WHERE ranking_games.game_date >= ?1 AND ranking_games.game_date < ?2 AND ranking_games.game_date < ?3
          AND ranking_games.is_ranking_eligible = 1 AND ranking_games.game_status = 'scored'
          AND ranking_games.is_test_game = 0 AND predictions.is_test_prediction = 0`
    ).bind(range.startAt, range.endAt, boundary).first(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM predictions
        JOIN ranking_games ON ranking_games.game_id = predictions.game_id
        WHERE ranking_games.game_date >= ?1 AND ranking_games.game_date < ?2 AND ranking_games.game_date >= ?3
          AND ranking_games.is_ranking_eligible = 1 AND ranking_games.game_status = 'scored'
          AND ranking_games.is_test_game = 0 AND predictions.is_test_prediction = 0`
    ).bind(range.startAt, range.endAt, boundary).first()
  ]);
  return {
    periodType,
    periodKey,
    resetAt: new Date(resetAt).toISOString(),
    resetBoundary: boundary,
    periodStart: range.startAt,
    periodEnd: range.endAt,
    gamesExcluded: Number(beforeGames?.count || 0),
    gamesRemaining: Number(remainingGames?.count || 0),
    predictionsExcluded: Number(beforePredictions?.count || 0),
    predictionsRemaining: Number(remainingPredictions?.count || 0)
  };
}

export async function getPerfectAchieversForDate(db, { date, limit, offset, releaseCutoffAt = "", targetTeamKey = "" }) {
  const releaseCutoffBoundary = getRankingCutoffBoundary(releaseCutoffAt);
  if (releaseCutoffBoundary && String(date || "") < releaseCutoffBoundary) {
    return { rows: [], totalCount: 0 };
  }

  if (targetTeamKey) {
    const [countRow, rowsResult] = await Promise.all([
      db.prepare(`SELECT COUNT(*) AS total_count FROM predictions p
        JOIN contest_ranking_games rg ON rg.contest_id = p.contest_id AND rg.internal_game_id = p.internal_game_id
        JOIN game_contests c ON c.contest_id = p.contest_id
        JOIN contest_scoring_revisions sr ON sr.contest_id = p.contest_id AND sr.is_active = 1
          AND sr.status = 'completed' AND sr.committed_attempt_id = p.scored_attempt_id AND sr.revision_number = p.scoring_revision
        JOIN users u ON u.id = p.user_id
        WHERE c.target_team_key = ?1 AND rg.game_date = ?2 AND p.status = 'scored'
          AND p.is_test_prediction = 0 AND p.score = p.max_score AND p.scored_attempt_id IS NOT NULL
          AND rg.is_ranking_eligible = 1 AND rg.game_status = 'scored'
          AND rg.publication_status = 'published' AND rg.is_test_game = 0 AND u.status = 'active'
          AND EXISTS (SELECT 1 FROM game_lineups gl JOIN contest_lineup_revisions lr
            ON lr.contest_id = gl.contest_id AND lr.revision_id = gl.final_lineup_revision_id
              AND lr.is_current = 1 AND lr.is_final = 1
            WHERE gl.contest_id = p.contest_id AND gl.internal_game_id = p.internal_game_id)
          AND (?3 = '' OR rg.game_date >= ?3)`)
        .bind(targetTeamKey, date, releaseCutoffBoundary).first(),
      db.prepare(`SELECT u.username, p.score, rg.game_date, p.opponent_code, p.submitted_at
        FROM predictions p
        JOIN contest_ranking_games rg ON rg.contest_id = p.contest_id AND rg.internal_game_id = p.internal_game_id
        JOIN game_contests c ON c.contest_id = p.contest_id
        JOIN contest_scoring_revisions sr ON sr.contest_id = p.contest_id AND sr.is_active = 1
          AND sr.status = 'completed' AND sr.committed_attempt_id = p.scored_attempt_id AND sr.revision_number = p.scoring_revision
        JOIN users u ON u.id = p.user_id
        WHERE c.target_team_key = ?1 AND rg.game_date = ?2 AND p.status = 'scored'
          AND p.is_test_prediction = 0 AND p.score = p.max_score AND p.scored_attempt_id IS NOT NULL
          AND rg.is_ranking_eligible = 1 AND rg.game_status = 'scored'
          AND rg.publication_status = 'published' AND rg.is_test_game = 0 AND u.status = 'active'
          AND EXISTS (SELECT 1 FROM game_lineups gl JOIN contest_lineup_revisions lr
            ON lr.contest_id = gl.contest_id AND lr.revision_id = gl.final_lineup_revision_id
              AND lr.is_current = 1 AND lr.is_final = 1
            WHERE gl.contest_id = p.contest_id AND gl.internal_game_id = p.internal_game_id)
          AND (?3 = '' OR rg.game_date >= ?3)
        ORDER BY p.submitted_at ASC, p.id ASC LIMIT ?4 OFFSET ?5`)
        .bind(targetTeamKey, date, releaseCutoffBoundary, limit, offset).all()
    ]);
    return { rows: (rowsResult.results || []).map(row => ({ username: row.username, score: Number(row.score),
      gameDate: row.game_date, opponent: row.opponent_code || "", submittedAt: row.submitted_at || null })),
      totalCount: Number(countRow?.total_count || 0) };
  }

  const scoreAttemptSchema = await hasScoreAttemptSchema(db);
  const latestPredictions = `WITH latest_predictions AS (
    SELECT predictions.id, predictions.user_id, predictions.game_id,
           predictions.score, predictions.max_score,
           predictions.opponent_code, predictions.submitted_at, predictions.status, predictions.is_test_prediction${scoreAttemptSchema ? ", predictions.scored_attempt_id" : ""},
           ROW_NUMBER() OVER (
             PARTITION BY predictions.user_id, predictions.game_id
             ORDER BY predictions.updated_at DESC, predictions.submitted_at DESC, predictions.id DESC
           ) AS submission_rank
      FROM predictions
  )`;
  const committedPredicate = scoreAttemptSchema ? committedAttemptPredicate("latest_predictions", "ranking_games.internal_game_id") : "";
  const conditions = `latest_predictions.submission_rank = 1
       AND latest_predictions.status = 'scored'
       AND latest_predictions.score IS NOT NULL
       AND latest_predictions.is_test_prediction = 0
       AND ranking_games.game_date = ?1
       AND ranking_games.is_ranking_eligible = 1
       AND ranking_games.game_status = 'scored'
       AND ranking_games.publication_status = 'published'
       AND ranking_games.is_test_game = 0
       AND users.status = 'active'
       AND latest_predictions.score = latest_predictions.max_score
       ${committedPredicate}`;
  const [countRow, rowsResult] = await Promise.all([
    db.prepare(`${latestPredictions}
      SELECT COUNT(*) AS total_count
        FROM latest_predictions
        JOIN ranking_games ON ranking_games.game_id = latest_predictions.game_id
        JOIN users ON users.id = latest_predictions.user_id
       WHERE ${conditions}`).bind(date).first(),
    db.prepare(`${latestPredictions}
      SELECT users.username,
             latest_predictions.score,
             ranking_games.game_date,
             latest_predictions.opponent_code,
             latest_predictions.submitted_at
        FROM latest_predictions
        JOIN ranking_games ON ranking_games.game_id = latest_predictions.game_id
        JOIN users ON users.id = latest_predictions.user_id
       WHERE ${conditions}
     ORDER BY latest_predictions.submitted_at ASC, latest_predictions.id ASC
     LIMIT ?2 OFFSET ?3`).bind(date, limit, offset).all()
  ]);

  return {
    rows: (rowsResult.results || []).map((row) => ({
      username: row.username,
      score: Number(row.score),
      gameDate: row.game_date,
      opponent: row.opponent_code || "",
      submittedAt: row.submitted_at || null
    })),
    totalCount: Number(countRow?.total_count || 0)
  };
}

async function hasRankingInternalGameId(db) {
  try {
    const columns = await db.prepare("PRAGMA table_info(ranking_games)").bind().all();
    return (columns.results || []).some((column) => column.name === "internal_game_id");
  } catch {
    return false;
  }
}

export async function getLatestPublishedRankingGame(db, { releaseCutoffAt = "", contestId = "", targetTeamKey = "" } = {}) {
  let contestScopedSchemaAvailable = false;
  if (contestId || targetTeamKey) {
    // Keep the established read path usable for an older/partially migrated
    // database. Production uses the contest-scoped query once its tables exist;
    // the legacy table represented one game identity before contest support.
    const [rankingColumns, contestColumns] = await Promise.all([
      db.prepare("PRAGMA table_info(contest_ranking_games)").bind().all(),
      db.prepare("PRAGMA table_info(game_contests)").bind().all()
    ]);
    contestScopedSchemaAvailable = (rankingColumns.results || []).some((column) => column.name === "contest_id")
      && (contestColumns.results || []).some((column) => column.name === "target_team_key");
    // A requested contest can never be inferred from a legacy game-only row.
    // The sole pre-contest production dataset belonged to Fighters; for any
    // other target, returning no result is safer than crossing team scope.
    if (contestId && !contestScopedSchemaAvailable) return null;
    if (!contestScopedSchemaAvailable && targetTeamKey && targetTeamKey !== "fighters") return null;
  }
  if ((contestId || targetTeamKey) && contestScopedSchemaAvailable) {
    const cutoffBoundary = getRankingCutoffBoundary(releaseCutoffAt);
    const row = await db.prepare(`SELECT ranking.contest_id, ranking.game_id, ranking.internal_game_id, ranking.game_date, ranking.published_at
      FROM contest_ranking_games ranking
      JOIN game_contests contest ON contest.contest_id = ranking.contest_id
      WHERE (?1 = '' OR ranking.contest_id = ?1)
        AND (?2 = '' OR contest.target_team_key = ?2)
        AND ranking.is_ranking_eligible = 1 AND ranking.game_status = 'scored'
        AND ranking.publication_status = 'published' AND ranking.is_test_game = 0
        AND ranking.published_at IS NOT NULL AND (?3 = '' OR ranking.game_date >= ?3)
      ORDER BY ranking.published_at DESC, ranking.game_date DESC, ranking.internal_game_id DESC LIMIT 1`)
      .bind(contestId, targetTeamKey, cutoffBoundary).first();
    if (!row) return null;
    return { gameId: String(row.game_id || "").trim(), internalGameId: String(row.internal_game_id || "").trim(),
      contestId: String(row.contest_id || contestId || "").trim(), gameDate: String(row.game_date || "").trim(), publishedAt: row.published_at || null };
  }
  const useCanonicalId = await hasRankingInternalGameId(db);
  const cutoffBoundary = getRankingCutoffBoundary(releaseCutoffAt);
  const internalSelect = useCanonicalId ? ", internal_game_id" : "";
  const row = await db.prepare(
    `SELECT game_id${internalSelect}, game_date, published_at
       FROM ranking_games
      WHERE is_ranking_eligible = 1
        AND game_status = 'scored'
        AND publication_status = 'published'
        AND is_test_game = 0
        AND published_at IS NOT NULL
        AND (?1 = '' OR game_date >= ?1)
      ORDER BY published_at DESC, game_date DESC, game_id DESC
      LIMIT 1`
  ).bind(cutoffBoundary).first();
  if (!row) return null;
  return {
    gameId: String(row.game_id || "").trim(),
    internalGameId: useCanonicalId ? String(row.internal_game_id || "").trim() : "",
    contestId: "",
    gameDate: String(row.game_date || "").trim(),
    publishedAt: row.published_at || null
  };
}

export async function getDailyBestNineForGame(db, { internalGameId = "", legacyGameId = "", contestId = "", limit = DAILY_BEST_NINE_LIMIT } = {}) {
  if (contestId) return getContestDailyBestNine(db, { internalGameId, legacyGameId, contestId, limit });
  const canonicalId = String(internalGameId || "").trim();
  const compatibilityId = String(legacyGameId || "").trim();
  const useCanonicalId = Boolean(canonicalId) && await hasRankingInternalGameId(db);
  const gameValue = useCanonicalId ? canonicalId : compatibilityId;
  if (!gameValue) return { rows: [], totalCount: 0 };

  // Best Nine admits only the canonical S9_TEST accounts as TEST rows. This
  // keeps arbitrary test predictions out while making the product rule
  // independent of any particular slot winning by default.
  const rankingTestUsernames = Array.from(
    { length: RANKING_TEST_SLOT_MAX },
    (_, index) => rankingTestUsername(index + 1)
  );
  const rankingTestPlaceholders = rankingTestUsernames.map((_, index) => `?${index + 2}`).join(", ");
  const bindValues = [gameValue, ...rankingTestUsernames];
  const scoreAttemptSchema = await hasScoreAttemptSchema(db);
  const rankingTestSchema = await hasRankingTestSchema(db);
  const latestPredictions = `latest_predictions AS (
    SELECT predictions.id, predictions.user_id, predictions.game_id,
           predictions.score, predictions.max_score,
           predictions.submitted_at, predictions.status, predictions.is_test_prediction, predictions.updated_at${scoreAttemptSchema ? ", predictions.scored_attempt_id" : ""},
           ROW_NUMBER() OVER (
             PARTITION BY predictions.user_id, predictions.game_id
             ORDER BY predictions.updated_at DESC, predictions.submitted_at DESC, predictions.id DESC
           ) AS submission_rank
      FROM predictions
  )`;
  const gameCondition = useCanonicalId
    ? "ranking_games.internal_game_id = ?1"
    : "ranking_games.game_id = ?1";
  const committedPredicate = scoreAttemptSchema ? committedAttemptPredicate("latest_predictions", "ranking_games.internal_game_id") : "";
  const conditions = `latest_predictions.submission_rank = 1
       AND latest_predictions.status = 'scored'
       AND latest_predictions.score IS NOT NULL
       AND latest_predictions.max_score IS NOT NULL
       AND (latest_predictions.is_test_prediction = 0
         OR (latest_predictions.is_test_prediction = 1
           AND users.username IN (${rankingTestPlaceholders})))
       AND ${gameCondition}
       AND ranking_games.is_ranking_eligible = 1
       AND ranking_games.game_status = 'scored'
       AND ranking_games.publication_status = 'published'
       AND ranking_games.is_test_game = 0
       AND users.status = 'active'
       ${committedPredicate}`;
  const testCandidateRows = rankingTestSchema ? `
    UNION ALL
    SELECT COALESCE(
             NULLIF(json_extract(global_settings.slot_names_json, '$.' || CAST(test_predictions.slot AS TEXT)), ''),
             'S9_TEST_' || CAST(test_predictions.slot AS TEXT)
           ) AS username,
           test_predictions.score,
           test_predictions.max_score,
           COALESCE(test_predictions.scored_at, test_predictions.updated_at, test_predictions.created_at) AS submitted_at,
           'ranking-test:' || CAST(test_predictions.slot AS TEXT) AS user_id
      FROM ranking_test_predictions AS test_predictions
      JOIN ranking_games
        ON ${useCanonicalId
    ? "ranking_games.internal_game_id = test_predictions.internal_game_id AND ranking_games.internal_game_id = ?1"
    : "ranking_games.game_id = ?1"}
      LEFT JOIN ranking_test_game_settings AS test_settings
        ON test_settings.internal_game_id = test_predictions.internal_game_id
      LEFT JOIN ranking_test_global_settings AS global_settings
        ON global_settings.id = 1
      JOIN game_lineups AS test_lineup
        ON test_lineup.internal_game_id = test_predictions.internal_game_id
       AND test_lineup.final_lineup_revision_id = test_predictions.lineup_revision_id
      ${scoreAttemptSchema ? `JOIN game_lineup_revisions AS current_test_lineup
        ON current_test_lineup.internal_game_id = test_predictions.internal_game_id
       AND current_test_lineup.is_current = 1
       AND current_test_lineup.is_final = 1
       AND (test_lineup.final_lineup_revision_id = current_test_lineup.revision_id
         OR test_lineup.final_lineup_revision_id = current_test_lineup.internal_game_id || ':' || current_test_lineup.version
         OR test_lineup.final_lineup_revision_id = current_test_lineup.game_id || ':' || current_test_lineup.version)
      ` : ""}
      JOIN game_scoring_revisions AS test_revision
        ON test_revision.internal_game_id = test_predictions.internal_game_id
       AND test_revision.id = test_predictions.scoring_revision_id
       AND (${scoreAttemptSchema
    ? "test_revision.lineup_revision_id = current_test_lineup.revision_id OR test_revision.lineup_revision_id = current_test_lineup.internal_game_id || ':' || current_test_lineup.version OR test_revision.lineup_revision_id = current_test_lineup.game_id || ':' || current_test_lineup.version"
    : "test_revision.lineup_revision_id = test_predictions.lineup_revision_id"})
       AND test_revision.is_active = 1
       AND test_revision.status = 'completed'
       ${scoreAttemptSchema ? `AND (test_revision.committed_attempt_id IS NULL
         OR test_revision.committed_attempt_id = test_predictions.scored_attempt_id)` : ""}
     WHERE test_predictions.status = 'scored'
       AND test_predictions.score IS NOT NULL
       AND test_predictions.max_score IS NOT NULL
       AND test_predictions.slot BETWEEN 1 AND 9
       AND (COALESCE(test_settings.include_in_public_ranking, 0) = 1
         OR COALESCE(global_settings.global_enabled, 1) = 1)` : "";
  const candidateRows = `WITH ${latestPredictions}
  , candidate_rows AS (
    SELECT users.username,
           latest_predictions.score,
           latest_predictions.max_score,
           latest_predictions.submitted_at,
           latest_predictions.user_id
      FROM latest_predictions
      JOIN ranking_games ON ranking_games.game_id = latest_predictions.game_id
      JOIN users ON users.id = latest_predictions.user_id
     WHERE ${conditions}${testCandidateRows}
  )`;
  const [countRow, rowsResult] = await Promise.all([
    db.prepare(`${candidateRows}
      SELECT COUNT(*) AS total_count
        FROM candidate_rows`).bind(...bindValues).first(),
    db.prepare(`${candidateRows}
      SELECT username, score, max_score, submitted_at, user_id
        FROM candidate_rows
       ORDER BY score DESC,
                submitted_at ASC,
                username ASC,
                user_id ASC
       LIMIT ?${rankingTestUsernames.length + 2}`).bind(
      ...bindValues,
      Math.min(DAILY_BEST_NINE_LIMIT, Math.max(1, Number(limit) || DAILY_BEST_NINE_LIMIT))
    ).all()
  ]);

  return {
    rows: (rowsResult.results || []).map((row, index) => toPublicDailyBestNineRow(row, index + 1)),
    totalCount: Number(countRow?.total_count || 0)
  };
}

async function getContestDailyBestNine(db, { internalGameId = "", legacyGameId = "", contestId, limit }) {
  const limitValue = Math.min(DAILY_BEST_NINE_LIMIT, Math.max(1, Number(limit) || DAILY_BEST_NINE_LIMIT));
  const candidates = `WITH eligible_predictions AS (
    SELECT p.id, p.user_id, p.score, p.max_score, p.submitted_at, p.updated_at,
      ROW_NUMBER() OVER (PARTITION BY p.user_id, p.contest_id ORDER BY p.updated_at DESC, p.submitted_at DESC, p.id DESC) AS rank
    FROM predictions p
    JOIN contest_ranking_games rg ON rg.contest_id = p.contest_id AND rg.internal_game_id = p.internal_game_id
    JOIN contest_scoring_revisions sr ON sr.contest_id = p.contest_id AND sr.internal_game_id = p.internal_game_id
      AND sr.is_active = 1 AND sr.status = 'completed' AND sr.revision_number = p.scoring_revision
      AND sr.committed_attempt_id = p.scored_attempt_id
    WHERE p.contest_id = ?1 AND p.internal_game_id = ?2 AND p.is_test_prediction = 0
      AND p.status = 'scored' AND p.scoring_status = 'scored' AND p.score IS NOT NULL AND p.max_score IS NOT NULL
      AND rg.is_ranking_eligible = 1 AND rg.game_status = 'scored' AND rg.publication_status = 'published'
      AND rg.is_test_game = 0
      AND EXISTS (SELECT 1 FROM game_lineups gl JOIN contest_lineup_revisions lr
        ON lr.contest_id = gl.contest_id AND lr.revision_id = gl.final_lineup_revision_id
          AND lr.is_current = 1 AND lr.is_final = 1
        WHERE gl.contest_id = p.contest_id AND gl.internal_game_id = p.internal_game_id)
  ), real_rows AS (
    SELECT u.username, p.score, p.max_score, p.submitted_at, p.user_id
      FROM eligible_predictions p JOIN users u ON u.id = p.user_id
     WHERE p.rank = 1 AND u.status = 'active'
  ), test_rows AS (
    SELECT COALESCE(NULLIF(json_extract(gs.slot_names_json, '$.' || CAST(tp.slot AS TEXT)), ''),
             'S9_TEST_' || CAST(tp.slot AS TEXT)) AS username,
           tp.score, tp.max_score, COALESCE(tp.scored_at,tp.updated_at,tp.created_at) AS submitted_at,
           'ranking-test:' || CAST(tp.slot AS TEXT) AS user_id
      FROM contest_ranking_test_predictions tp
      JOIN contest_ranking_games rg ON rg.contest_id = tp.contest_id AND rg.internal_game_id = tp.internal_game_id
      JOIN contest_scoring_revisions sr ON sr.contest_id = tp.contest_id AND sr.id = tp.scoring_revision_id
        AND sr.is_active = 1 AND sr.status = 'completed'
      LEFT JOIN contest_ranking_test_game_settings ts ON ts.contest_id = tp.contest_id
        AND ts.internal_game_id = tp.internal_game_id
      LEFT JOIN ranking_test_global_settings gs ON gs.id = 1
     WHERE tp.contest_id = ?1 AND tp.internal_game_id = ?2 AND tp.status = 'scored'
       AND tp.score IS NOT NULL AND tp.max_score IS NOT NULL AND tp.slot BETWEEN 1 AND 9
       AND (COALESCE(ts.include_in_public_ranking,0)=1 OR COALESCE(gs.global_enabled,1)=1)
       AND rg.is_ranking_eligible=1 AND rg.game_status='scored'
       AND rg.publication_status='published' AND rg.is_test_game=0
  ), all_rows AS (SELECT * FROM real_rows UNION ALL SELECT * FROM test_rows)`;
  const [count, rows] = await Promise.all([
    db.prepare(`${candidates} SELECT COUNT(*) AS count FROM all_rows`).bind(contestId, internalGameId).first(),
    db.prepare(`${candidates} SELECT username, score, max_score, submitted_at, user_id FROM all_rows
      ORDER BY score DESC, submitted_at ASC, username ASC, user_id ASC LIMIT ?3`)
      .bind(contestId, internalGameId, limitValue).all()
  ]);
  return { rows: (rows.results || []).map((row, index) => toPublicDailyBestNineRow(row, index + 1)), totalCount: Number(count?.count || 0) };
}

function committedAttemptPredicate(alias = "predictions", internalGameExpression = `${alias}.internal_game_id`) {
  return `AND (${alias}.scored_attempt_id IS NULL OR EXISTS (
    SELECT 1
      FROM game_scoring_revisions AS committed_score
      JOIN game_lineups AS committed_lineup
        ON committed_lineup.internal_game_id = ${internalGameExpression}
       AND committed_lineup.final_lineup_revision_id IS NOT NULL
      JOIN game_lineup_revisions AS current_lineup_revision
        ON current_lineup_revision.internal_game_id = ${internalGameExpression}
       AND current_lineup_revision.is_current = 1
       AND current_lineup_revision.is_final = 1
       AND (committed_lineup.final_lineup_revision_id = current_lineup_revision.revision_id
         OR committed_lineup.final_lineup_revision_id = current_lineup_revision.internal_game_id || ':' || current_lineup_revision.version
         OR committed_lineup.final_lineup_revision_id = current_lineup_revision.game_id || ':' || current_lineup_revision.version)
       AND (current_lineup_revision.revision_id = committed_score.lineup_revision_id
         OR committed_score.lineup_revision_id = current_lineup_revision.internal_game_id || ':' || current_lineup_revision.version
         OR committed_score.lineup_revision_id = current_lineup_revision.game_id || ':' || current_lineup_revision.version)
     WHERE committed_score.internal_game_id = ${internalGameExpression}
       AND committed_score.is_active = 1
       AND committed_score.status = 'completed'
       AND committed_score.committed_attempt_id = ${alias}.scored_attempt_id
  ))`;
}

function createRankingCte(includeTestUsers = false, scoreAttemptSchema = false) {
  if (includeTestUsers) return createRankingCteWithTestUsers(scoreAttemptSchema);
  return `WITH eligible_games AS (
    SELECT game_id
     FROM ranking_games
     WHERE is_ranking_eligible = 1
       AND game_status = 'scored'
       AND is_test_game = 0
       AND (?1 IS NULL OR game_date >= ?1)
       AND (?2 IS NULL OR game_date < ?2)
  ), eligibility AS (
    SELECT COUNT(*) AS eligible_games FROM eligible_games
  ), threshold AS (
    SELECT eligible_games,
           CAST((eligible_games * 2 + 2) / 3 AS INTEGER) AS required_games
      FROM eligibility
  ), user_totals AS (
    SELECT predictions.user_id,
           users.username,
           COUNT(DISTINCT predictions.game_id) AS games_played,
           SUM(predictions.score) AS total_score,
           SUM(CASE WHEN predictions.score = predictions.max_score THEN 1 ELSE 0 END) AS perfect_count,
           MAX(predictions.score) AS best_score,
           MAX(predictions.scored_at) AS last_scored_at
      FROM predictions
      JOIN eligible_games ON eligible_games.game_id = predictions.game_id
      JOIN users ON users.id = predictions.user_id
     WHERE predictions.status = 'scored'
       AND predictions.score IS NOT NULL
       AND predictions.max_score IS NOT NULL
       AND predictions.is_test_prediction = 0
       AND users.status = 'active'
     GROUP BY predictions.user_id, users.username
  ), all_user_totals AS (
    SELECT * FROM user_totals
  ), qualified_rows AS (
    SELECT all_user_totals.*,
           threshold.eligible_games,
           threshold.required_games,
           1 AS is_qualified,
           0 AS games_needed,
           RANK() OVER (
             ORDER BY (total_score * 1.0 / games_played) DESC,
                      perfect_count DESC,
                      total_score DESC,
                      games_played DESC
           ) AS ranking_rank
      FROM all_user_totals CROSS JOIN threshold
     WHERE games_played >= required_games
  ), unqualified_rows AS (
    SELECT all_user_totals.*,
           threshold.eligible_games,
           threshold.required_games,
           0 AS is_qualified,
           MAX(2 * threshold.eligible_games - 3 * all_user_totals.games_played, 0) AS games_needed,
           NULL AS ranking_rank
      FROM all_user_totals CROSS JOIN threshold
     WHERE games_played < required_games
  ), combined AS (
    SELECT * FROM qualified_rows
    UNION ALL
    SELECT * FROM unqualified_rows
  )`;
}

function createRankingCteWithTestUsers(scoreAttemptSchema = false) {
  const testTotals = `
  test_user_totals AS (
    SELECT 'ranking-test:' || CAST(test_predictions.slot AS TEXT) AS user_id,
           COALESCE(
             NULLIF(json_extract(global_settings.slot_names_json, '$.' || CAST(test_predictions.slot AS TEXT)), ''),
             'S9_TEST_' || CAST(test_predictions.slot AS TEXT)
           ) AS username,
           COUNT(DISTINCT test_predictions.internal_game_id) AS games_played,
           SUM(test_predictions.score) AS total_score,
           SUM(CASE WHEN test_predictions.score = test_predictions.max_score THEN 1 ELSE 0 END) AS perfect_count,
           MAX(test_predictions.score) AS best_score,
           MAX(test_predictions.scored_at) AS last_scored_at
      FROM ranking_test_predictions AS test_predictions
      JOIN eligible_games ON eligible_games.internal_game_id = test_predictions.internal_game_id
      LEFT JOIN ranking_test_game_settings AS test_settings
        ON test_settings.internal_game_id = test_predictions.internal_game_id
      LEFT JOIN ranking_test_global_settings AS global_settings
        ON global_settings.id = 1
      JOIN game_lineups AS test_lineups
        ON test_lineups.internal_game_id = test_predictions.internal_game_id
       AND test_lineups.final_lineup_revision_id = test_predictions.lineup_revision_id
      ${scoreAttemptSchema ? `JOIN game_lineup_revisions AS test_final_revision
        ON test_final_revision.internal_game_id = test_predictions.internal_game_id
       AND test_final_revision.is_current = 1
       AND test_final_revision.is_final = 1` : ""}
      JOIN game_scoring_revisions AS test_revisions
        ON test_revisions.internal_game_id = test_predictions.internal_game_id
       AND test_revisions.id = test_predictions.scoring_revision_id
       AND test_revisions.lineup_revision_id = ${scoreAttemptSchema ? "test_final_revision.revision_id" : "test_predictions.lineup_revision_id"}
       AND test_revisions.is_active = 1
       AND test_revisions.status = 'completed'
       ${scoreAttemptSchema ? "AND (test_revisions.committed_attempt_id IS NULL OR test_revisions.committed_attempt_id = test_predictions.scored_attempt_id)" : ""}
       AND (COALESCE(test_settings.include_in_public_ranking, 0) = 1
            OR COALESCE(global_settings.global_enabled, 1) = 1)
     WHERE test_predictions.status = 'scored'
       AND test_predictions.score IS NOT NULL
       AND test_predictions.max_score IS NOT NULL
       AND test_predictions.slot BETWEEN 1 AND 9
     GROUP BY test_predictions.slot
  )`;
  const base = createRankingCte(false, scoreAttemptSchema);
  return base
    .replace(
      "    SELECT game_id\n     FROM ranking_games",
      "    SELECT game_id, internal_game_id\n     FROM ranking_games"
    )
    .replace(
      "  ), all_user_totals AS (\n    SELECT * FROM user_totals\n  ), qualified_rows AS (",
      `  ), ${testTotals}, all_user_totals AS (\n    SELECT * FROM user_totals\n    UNION ALL\n    SELECT * FROM test_user_totals\n  ), qualified_rows AS (`
    );
}

function createRankingCteForReset(resetBoundary = "", includeTestUsers = false, scoreAttemptSchema = false) {
  const cte = createRankingCte(includeTestUsers, scoreAttemptSchema);
  if (!resetBoundary) return cte;
  return cte.replace(
    "       AND (?1 IS NULL OR game_date >= ?1)",
    "       AND (?1 IS NULL OR game_date >= ?1)\n       AND game_date >= ?3"
  );
}

function createRankingCteForPublishedPeriod(resetBoundary = "", includeTestUsers = false, scoreAttemptSchema = false) {
  return createRankingCteForReset(resetBoundary, includeTestUsers, scoreAttemptSchema).replace(
    "       AND game_status = 'scored'\n       AND is_test_game = 0",
    "       AND game_status = 'scored'\n       AND publication_status = 'published'\n       AND is_test_game = 0"
  );
}

function resolveRankingCutoffBoundary(marker, releaseCutoffAt = "") {
  return getEffectiveRankingCutoffBoundary({
    releaseCutoffAt,
    resetAt: marker?.reset_at || ""
  });
}

async function hasRankingTestSchema(db) {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS table_count FROM sqlite_master
        WHERE type = 'table' AND name IN ('ranking_test_game_settings', 'ranking_test_predictions', 'ranking_test_global_settings')`
    ).bind().first();
    return Number(row?.table_count || 0) === 3;
  } catch {
    return false;
  }
}

function applyCommittedAttemptPredicate(cte, scoreAttemptSchema) {
  if (!scoreAttemptSchema) return cte;
  const withCanonicalIdentity = cte.replace(
    "    SELECT game_id\n     FROM ranking_games",
    "    SELECT game_id, internal_game_id\n     FROM ranking_games"
  );
  return withCanonicalIdentity.replace(
    "       AND users.status = 'active'",
    `       AND users.status = 'active'
       ${committedAttemptPredicate("predictions", "eligible_games.internal_game_id")}`
  );
}

async function hasScoreAttemptSchema(db) {
  try {
    const [revisionColumns, predictionColumns, rankingColumns, lineupColumns, lineupRevisionColumns, testPredictionColumns] = await Promise.all([
      db.prepare("PRAGMA table_info(game_scoring_revisions)").all(),
      db.prepare("PRAGMA table_info(predictions)").all(),
      db.prepare("PRAGMA table_info(ranking_games)").all(),
      db.prepare("PRAGMA table_info(game_lineups)").all(),
      db.prepare("PRAGMA table_info(game_lineup_revisions)").all(),
      db.prepare("PRAGMA table_info(ranking_test_predictions)").all()
    ]);
    const hasColumn = (result, name) => (result?.results || []).some((column) => column.name === name);
    return hasColumn(revisionColumns, "committed_attempt_id")
      && hasColumn(predictionColumns, "scored_attempt_id")
      && hasColumn(rankingColumns, "internal_game_id")
      && hasColumn(lineupColumns, "final_lineup_revision_id")
      && hasColumn(lineupRevisionColumns, "revision_id")
      && hasColumn(lineupRevisionColumns, "internal_game_id")
      && hasColumn(lineupRevisionColumns, "is_current")
      && hasColumn(lineupRevisionColumns, "is_final")
      && (!testPredictionColumns?.results?.length || hasColumn(testPredictionColumns, "scored_attempt_id"));
  } catch {
    return false;
  }
}

export async function getRankingForPeriod(db, { limit, offset, qualifiedOnly, startAt = null, endAt = null, periodType = null, periodKey = null, publishedOnly = false, releaseCutoffAt = "", includeTestUsers = false, targetTeamKey = "" }) {
  if (targetTeamKey) {
    return getContestRankingForPeriod(db, { limit, offset, qualifiedOnly, startAt, endAt, periodType, periodKey,
      publishedOnly, releaseCutoffAt, includeTestUsers, targetTeamKey });
  }
  const marker = periodType && periodKey ? await getActiveRankingResetMarker(db, { periodType, periodKey }) : null;
  const cutoffBoundary = resolveRankingCutoffBoundary(marker, releaseCutoffAt);
  const includeTestRows = includeTestUsers && await hasRankingTestSchema(db);
  const scoreAttemptSchema = await hasScoreAttemptSchema(db);
  let cte = publishedOnly
    ? createRankingCteForPublishedPeriod(cutoffBoundary, includeTestRows, scoreAttemptSchema)
    : createRankingCteForReset(cutoffBoundary, includeTestRows, scoreAttemptSchema);
  cte = applyCommittedAttemptPredicate(cte, scoreAttemptSchema);
  const qualifiedParam = cutoffBoundary ? 4 : 3;
  const limitParam = qualifiedParam + 1;
  const offsetParam = qualifiedParam + 2;
  const baseBindings = cutoffBoundary ? [startAt, endAt, cutoffBoundary] : [startAt, endAt];
  const [summaryRow, countRow, rowsResult] = await Promise.all([
    db.prepare(`${cte}
      SELECT COALESCE(MAX(eligible_games), 0) AS eligible_games,
             COALESCE(MAX(required_games), 0) AS required_games,
             COALESCE(SUM(CASE WHEN is_qualified = 1 THEN 1 ELSE 0 END), 0) AS qualified_users,
             COUNT(*) AS total_users
        FROM combined`).bind(...baseBindings).first(),
    db.prepare(`${cte}
      SELECT COUNT(*) AS total_users
        FROM combined
       WHERE (?${qualifiedParam} = 0 OR is_qualified = 1)`).bind(...baseBindings, qualifiedOnly ? 1 : 0).first(),
    db.prepare(`${cte}
      SELECT user_id, username, games_played, eligible_games, required_games, is_qualified, games_needed,
             total_score, (total_score * 1.0 / games_played) AS average_score,
             perfect_count, best_score, last_scored_at, ranking_rank
        FROM combined
       WHERE (?${qualifiedParam} = 0 OR is_qualified = 1)
       ORDER BY is_qualified DESC,
                ranking_rank ASC,
                average_score DESC,
                perfect_count DESC,
                total_score DESC,
                games_played DESC,
                user_id ASC
       LIMIT ?${limitParam} OFFSET ?${offsetParam}`).bind(...baseBindings, qualifiedOnly ? 1 : 0, limit, offset).all()
  ]);

  const internalRows = rowsResult.results || [];
  const achievementsByUser = await getRankingAchievementsByUser(db, internalRows.map((row) => row.user_id));
  return {
    rows: internalRows.map((row) => toPublicRankingRow(row, achievementsByUser.get(row.user_id))),
    summary: {
      eligibleGames: Number(summaryRow?.eligible_games || 0),
      requiredGames: Number(summaryRow?.required_games || 0),
      qualifiedUsers: Number(summaryRow?.qualified_users || 0),
      totalUsers: Number(summaryRow?.total_users || 0)
    },
    pagination: { limit, offset, totalUsers: Number(countRow?.total_users || 0) }
  };
}

async function getContestRankingForPeriod(db, options) {
  const marker = options.periodType && options.periodKey
    ? await getActiveRankingResetMarker(db, { periodType: options.periodType, periodKey: options.periodKey }) : null;
  const cutoffBoundary = resolveRankingCutoffBoundary(marker, options.releaseCutoffAt);
  const publishedPredicate = options.publishedOnly ? "AND ranking.publication_status = 'published'" : "";
  const testRows = options.includeTestUsers ? `UNION ALL
    SELECT 'ranking-test:' || CAST(test.slot AS TEXT) AS user_id,
           COALESCE(NULLIF(json_extract(global_settings.slot_names_json, '$.' || CAST(test.slot AS TEXT)), ''),
             'S9_TEST_' || CAST(test.slot AS TEXT)) AS username,
           1 AS games_played, test.score AS total_score,
           CASE WHEN test.score = test.max_score THEN 1 ELSE 0 END AS perfect_count,
           test.score AS best_score, COALESCE(test.scored_at,test.updated_at) AS last_scored_at
      FROM contest_ranking_test_predictions test
      JOIN eligible_games eligible ON eligible.contest_id = test.contest_id AND eligible.internal_game_id = test.internal_game_id
      LEFT JOIN contest_ranking_test_game_settings settings ON settings.contest_id = test.contest_id
        AND settings.internal_game_id = test.internal_game_id
      LEFT JOIN ranking_test_global_settings global_settings ON global_settings.id = 1
      JOIN contest_scoring_revisions revision ON revision.contest_id = test.contest_id
        AND revision.id = test.scoring_revision_id AND revision.status = 'completed' AND revision.is_active = 1
     WHERE test.status = 'scored' AND test.score IS NOT NULL AND test.max_score IS NOT NULL
       AND test.slot BETWEEN 1 AND 9
       AND (COALESCE(settings.include_in_public_ranking,0)=1 OR COALESCE(global_settings.global_enabled,1)=1)` : "";
  const cte = `WITH eligible_games AS (
      SELECT ranking.contest_id, ranking.internal_game_id, ranking.game_id
        FROM contest_ranking_games ranking JOIN game_contests contest ON contest.contest_id=ranking.contest_id
       WHERE contest.target_team_key=?3 AND ranking.is_ranking_eligible=1 AND ranking.game_status='scored'
         AND ranking.is_test_game=0 ${publishedPredicate}
         AND (?1 IS NULL OR ranking.game_date>=?1) AND (?2 IS NULL OR ranking.game_date<?2)
         AND (?4='' OR ranking.game_date>=?4)
    ), eligibility AS (SELECT COUNT(*) AS eligible_games FROM eligible_games),
    threshold AS (SELECT eligible_games, CAST((eligible_games*2+2)/3 AS INTEGER) AS required_games FROM eligibility),
    real_user_totals AS (
      SELECT prediction.user_id, user.username, COUNT(DISTINCT prediction.contest_id || ':' || prediction.internal_game_id) AS games_played,
        SUM(prediction.score) AS total_score,
        SUM(CASE WHEN prediction.score=prediction.max_score THEN 1 ELSE 0 END) AS perfect_count,
        MAX(prediction.score) AS best_score, MAX(prediction.scored_at) AS last_scored_at
        FROM predictions prediction
        JOIN eligible_games eligible ON eligible.contest_id=prediction.contest_id AND eligible.internal_game_id=prediction.internal_game_id
        JOIN users user ON user.id=prediction.user_id
        JOIN contest_scoring_revisions revision ON revision.contest_id=prediction.contest_id
          AND revision.internal_game_id=prediction.internal_game_id AND revision.revision_number=prediction.scoring_revision
          AND revision.status='completed' AND revision.is_active=1 AND revision.committed_attempt_id=prediction.scored_attempt_id
        JOIN game_lineups lineup ON lineup.contest_id=prediction.contest_id AND lineup.internal_game_id=prediction.internal_game_id
          AND lineup.scoring_status='scored'
        JOIN contest_lineup_revisions final_revision ON final_revision.contest_id=lineup.contest_id
          AND final_revision.revision_id=lineup.final_lineup_revision_id AND final_revision.is_current=1 AND final_revision.is_final=1
       WHERE prediction.status='scored' AND prediction.scoring_status='scored' AND prediction.score IS NOT NULL
         AND prediction.max_score IS NOT NULL AND prediction.is_test_prediction=0 AND user.status='active'
       GROUP BY prediction.user_id,user.username
    ), all_user_totals AS (
      SELECT * FROM real_user_totals ${testRows}
    ), qualified_rows AS (
      SELECT totals.*, threshold.eligible_games,threshold.required_games,1 AS is_qualified,0 AS games_needed,
        RANK() OVER (ORDER BY (total_score*1.0/games_played) DESC,perfect_count DESC,total_score DESC,games_played DESC) AS ranking_rank
        FROM all_user_totals totals CROSS JOIN threshold WHERE games_played>=required_games
    ), unqualified_rows AS (
      SELECT totals.*,threshold.eligible_games,threshold.required_games,0 AS is_qualified,
        MAX(2*threshold.eligible_games-3*totals.games_played,0) AS games_needed,NULL AS ranking_rank
        FROM all_user_totals totals CROSS JOIN threshold WHERE games_played<required_games
    ), combined AS (SELECT * FROM qualified_rows UNION ALL SELECT * FROM unqualified_rows)`;
  const bindings = [options.startAt, options.endAt, options.targetTeamKey, cutoffBoundary];
  const [summaryRow, countRow, rowsResult] = await Promise.all([
    db.prepare(`${cte} SELECT COALESCE(MAX(eligible_games),0) AS eligible_games,COALESCE(MAX(required_games),0) AS required_games,
      COALESCE(SUM(CASE WHEN is_qualified=1 THEN 1 ELSE 0 END),0) AS qualified_users,COUNT(*) AS total_users FROM combined`)
      .bind(...bindings).first(),
    db.prepare(`${cte} SELECT COUNT(*) AS total_users FROM combined WHERE (?5=0 OR is_qualified=1)`)
      .bind(...bindings, options.qualifiedOnly ? 1 : 0).first(),
    db.prepare(`${cte} SELECT user_id,username,games_played,eligible_games,required_games,is_qualified,games_needed,total_score,
      (total_score*1.0/games_played) AS average_score,perfect_count,best_score,last_scored_at,ranking_rank FROM combined
      WHERE (?5=0 OR is_qualified=1) ORDER BY is_qualified DESC,ranking_rank ASC,average_score DESC,perfect_count DESC,
      total_score DESC,games_played DESC,user_id ASC LIMIT ?6 OFFSET ?7`)
      .bind(...bindings, options.qualifiedOnly ? 1 : 0, options.limit, options.offset).all()
  ]);
  const internalRows = rowsResult.results || [];
  const achievements = await getRankingAchievementsByUser(db, internalRows.map(row => row.user_id));
  return { rows: internalRows.map(row => toPublicRankingRow(row, achievements.get(row.user_id))),
    summary: { eligibleGames: Number(summaryRow?.eligible_games||0), requiredGames: Number(summaryRow?.required_games||0),
      qualifiedUsers: Number(summaryRow?.qualified_users||0), totalUsers: Number(summaryRow?.total_users||0) },
    pagination: { limit: options.limit, offset: options.offset, totalUsers: Number(countRow?.total_users||0) } };
}

export async function getRankingEntryForUser(db, userId, { startAt = null, endAt = null, periodType = null, periodKey = null, publishedOnly = false, releaseCutoffAt = "" } = {}) {
  const marker = periodType && periodKey ? await getActiveRankingResetMarker(db, { periodType, periodKey }) : null;
  const cutoffBoundary = resolveRankingCutoffBoundary(marker, releaseCutoffAt);
  const scoreAttemptSchema = await hasScoreAttemptSchema(db);
  const cte = publishedOnly
    ? createRankingCteForPublishedPeriod(cutoffBoundary, false, scoreAttemptSchema)
    : createRankingCteForReset(cutoffBoundary, false, scoreAttemptSchema);
  const userParam = cutoffBoundary ? 4 : 3;
  const bindings = cutoffBoundary ? [startAt, endAt, cutoffBoundary, userId] : [startAt, endAt, userId];
  const row = await db.prepare(`${cte}
    SELECT user_id, username, games_played, eligible_games, required_games, is_qualified, games_needed,
           total_score, (total_score * 1.0 / games_played) AS average_score,
           perfect_count, best_score, last_scored_at, ranking_rank
      FROM combined
     WHERE user_id = ?${userParam}
     LIMIT 1`).bind(...bindings).first();
  return row ? toPublicRankingRow(row) : null;
}

async function getRankingAchievementsByUser(db, userIds) {
  const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
  const results = new Map();
  if (uniqueUserIds.length === 0) return results;

  const placeholders = uniqueUserIds.map((_, index) => `?${index + 1}`).join(", ");
  const rows = await db.prepare(
    `SELECT user_achievements.user_id, achievements.code, achievements.name, achievements.icon_key, achievements.rarity
       FROM user_achievements
       JOIN achievements ON achievements.id = user_achievements.achievement_id
      WHERE achievements.is_hidden = 0
        AND user_achievements.user_id IN (${placeholders})
      ORDER BY user_achievements.user_id ASC, user_achievements.earned_at DESC, achievements.code ASC`
  ).bind(...uniqueUserIds).all();

  for (const row of rows.results || []) {
    const current = results.get(row.user_id) || [];
    current.push({ code: row.code, name: row.name, iconKey: row.icon_key, rarity: row.rarity });
    results.set(row.user_id, current);
  }
  for (const [userId, achievements] of results) {
    results.set(userId, {
      achievements: achievements.slice(0, RANKING_ACHIEVEMENT_DISPLAY_LIMIT),
      achievementCount: achievements.length
    });
  }
  return results;
}
