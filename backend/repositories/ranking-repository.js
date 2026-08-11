import { getRankingResetDateBoundary, toPublicRankingRow } from "../domain/ranking.js";
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

export async function getPerfectAchieversForDate(db, { date, limit, offset }) {
  const latestPredictions = `WITH latest_predictions AS (
    SELECT predictions.id, predictions.user_id, predictions.game_id, predictions.score, predictions.max_score,
           predictions.opponent_code, predictions.submitted_at, predictions.status, predictions.is_test_prediction,
           ROW_NUMBER() OVER (
             PARTITION BY predictions.user_id, predictions.game_id
             ORDER BY predictions.updated_at DESC, predictions.submitted_at DESC, predictions.id DESC
           ) AS submission_rank
      FROM predictions
  )`;
  const conditions = `latest_predictions.submission_rank = 1
       AND latest_predictions.status = 'scored'
       AND latest_predictions.score IS NOT NULL
       AND latest_predictions.is_test_prediction = 0
       AND ranking_games.game_date = ?1
       AND ranking_games.is_ranking_eligible = 1
       AND ranking_games.game_status = 'scored'
       AND ranking_games.is_test_game = 0
       AND users.status = 'active'
       AND latest_predictions.score = latest_predictions.max_score`;
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

function createRankingCte() {
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
  ), qualified_rows AS (
    SELECT user_totals.*,
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
      FROM user_totals CROSS JOIN threshold
     WHERE games_played >= required_games
  ), unqualified_rows AS (
    SELECT user_totals.*,
           threshold.eligible_games,
           threshold.required_games,
           0 AS is_qualified,
           MAX(2 * threshold.eligible_games - 3 * user_totals.games_played, 0) AS games_needed,
           NULL AS ranking_rank
      FROM user_totals CROSS JOIN threshold
     WHERE games_played < required_games
  ), combined AS (
    SELECT * FROM qualified_rows
    UNION ALL
    SELECT * FROM unqualified_rows
  )`;
}

function createRankingCteForReset(resetBoundary = "") {
  const cte = createRankingCte();
  if (!resetBoundary) return cte;
  return cte.replace(
    "       AND (?1 IS NULL OR game_date >= ?1)",
    "       AND (?1 IS NULL OR game_date >= ?1)\n       AND game_date >= ?3"
  );
}

export async function getRankingForPeriod(db, { limit, offset, qualifiedOnly, startAt = null, endAt = null, periodType = null, periodKey = null }) {
  const marker = periodType && periodKey ? await getActiveRankingResetMarker(db, { periodType, periodKey }) : null;
  const resetBoundary = marker ? getRankingResetDateBoundary(marker.reset_at) : "";
  const cte = createRankingCteForReset(resetBoundary);
  const qualifiedParam = marker ? 4 : 3;
  const limitParam = qualifiedParam + 1;
  const offsetParam = qualifiedParam + 2;
  const baseBindings = marker ? [startAt, endAt, resetBoundary] : [startAt, endAt];
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

export async function getRankingEntryForUser(db, userId, { startAt = null, endAt = null, periodType = null, periodKey = null } = {}) {
  const marker = periodType && periodKey ? await getActiveRankingResetMarker(db, { periodType, periodKey }) : null;
  const resetBoundary = marker ? getRankingResetDateBoundary(marker.reset_at) : "";
  const cte = createRankingCteForReset(resetBoundary);
  const userParam = marker ? 4 : 3;
  const bindings = marker ? [startAt, endAt, resetBoundary, userId] : [startAt, endAt, userId];
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
