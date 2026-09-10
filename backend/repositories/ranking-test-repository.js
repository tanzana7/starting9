import {
  RANKING_TEST_SLOT_MAX,
  normalizeRankingTestSlot,
  rankingTestUsername
} from "../domain/ranking-test-users.js";

function parsePrediction(row) {
  if (!row?.prediction_json) return null;
  try {
    const value = JSON.parse(row.prediction_json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function schemaError(error) {
  return /no such table|does not exist/i.test(String(error?.message || error));
}

export async function getRankingTestState(db, internalGameId) {
  try {
    const [setting, predictions] = await Promise.all([
      db.prepare(
        `SELECT internal_game_id, include_in_public_ranking, updated_by, created_at, updated_at
           FROM ranking_test_game_settings WHERE internal_game_id = ?1 LIMIT 1`
      ).bind(internalGameId).first(),
      db.prepare(
        `SELECT internal_game_id, slot, prediction_json, status, score, max_score,
                lineup_revision_id, scoring_revision_id, scored_at, created_at, updated_at
           FROM ranking_test_predictions WHERE internal_game_id = ?1 ORDER BY slot ASC`
      ).bind(internalGameId).all()
    ]);
    const slots = Array.from({ length: RANKING_TEST_SLOT_MAX }, (_, index) => {
      const row = (predictions.results || []).find((candidate) => Number(candidate.slot) === index + 1) || null;
      return row ? {
        slot: Number(row.slot),
        prediction: parsePrediction(row),
        status: row.status,
        score: row.score === null ? null : Number(row.score),
        maxScore: row.max_score === null ? null : Number(row.max_score),
        lineupRevisionId: row.lineup_revision_id || null,
        scoringRevisionId: row.scoring_revision_id || null,
        scoredAt: row.scored_at || null,
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null
      } : { slot: index + 1, prediction: null, status: "empty", score: null, maxScore: null, lineupRevisionId: null, scoringRevisionId: null, scoredAt: null, createdAt: null, updatedAt: null };
    });
    return {
      schemaAvailable: true,
      internalGameId,
      setting: setting ? {
        includeInPublicRanking: Number(setting.include_in_public_ranking) === 1,
        updatedBy: setting.updated_by,
        createdAt: setting.created_at,
        updatedAt: setting.updated_at
      } : { includeInPublicRanking: false, updatedBy: null, createdAt: null, updatedAt: null },
      slots
    };
  } catch (error) {
    if (schemaError(error)) return { schemaAvailable: false, internalGameId, setting: null, slots: [] };
    throw error;
  }
}

export async function upsertRankingTestPrediction(db, { internalGameId, slot, predictionJson, now }) {
  const timestamp = now instanceof Date ? now.toISOString() : String(now);
  return db.prepare(
    `INSERT INTO ranking_test_predictions
       (internal_game_id, slot, prediction_json, status, score, max_score,
        lineup_revision_id, scoring_revision_id, scored_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'submitted', NULL, NULL, NULL, NULL, NULL, ?4, ?4)
     ON CONFLICT(internal_game_id, slot) DO UPDATE SET
       prediction_json = excluded.prediction_json,
       status = 'submitted', score = NULL, max_score = NULL,
       lineup_revision_id = NULL, scoring_revision_id = NULL,
       scored_at = NULL, updated_at = excluded.updated_at`
  ).bind(internalGameId, slot, predictionJson, timestamp).run();
}

export async function deleteRankingTestPrediction(db, { internalGameId, slot }) {
  return db.prepare(
    "DELETE FROM ranking_test_predictions WHERE internal_game_id = ?1 AND slot = ?2"
  ).bind(internalGameId, slot).run();
}

export async function updateRankingTestToggle(db, { internalGameId, includeInPublicRanking, updatedBy, now }) {
  const timestamp = now instanceof Date ? now.toISOString() : String(now);
  return db.prepare(
    `INSERT INTO ranking_test_game_settings
       (internal_game_id, include_in_public_ranking, updated_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(internal_game_id) DO UPDATE SET
       include_in_public_ranking = excluded.include_in_public_ranking,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).bind(internalGameId, includeInPublicRanking ? 1 : 0, String(updatedBy).slice(0, 160), timestamp).run();
}

export function publicRankingTestUserId(slot) {
  return `ranking-test:${normalizeRankingTestSlot(slot)}`;
}

export function publicRankingTestUsername(slot) {
  return rankingTestUsername(slot);
}
