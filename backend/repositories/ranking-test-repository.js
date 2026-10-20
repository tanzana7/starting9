import {
  RANKING_TEST_SLOT_MAX,
  defaultRankingTestDisplayName,
  normalizeRankingTestSlot,
  normalizeRankingTestDisplayName,
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

function parseSlotNames(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .map(([slot, name]) => [normalizeRankingTestSlot(slot), normalizeRankingTestDisplayName(name)])
      .filter(([slot, result]) => slot && result.ok && result.value)
      .map(([slot, result]) => [String(slot), result.value]));
  } catch {
    return {};
  }
}

function serializeSlotNames(slotNames = {}) {
  return JSON.stringify(Object.fromEntries(Object.entries(slotNames)
    .map(([slot, name]) => [normalizeRankingTestSlot(slot), normalizeRankingTestDisplayName(name)])
    .filter(([slot, result]) => slot && result.ok && result.value)
    .map(([slot, result]) => [String(slot), result.value])));
}

function globalSettingsFromRow(row) {
  const slotNames = parseSlotNames(row?.slot_names_json);
  return {
    // A missing singleton means the feature has never been configured. Treat
    // that state as the product default, while preserving an explicit row.
    globalEnabled: row ? Number(row.global_enabled) === 1 : true,
    slotNames,
    displayNames: Object.fromEntries(Array.from({ length: RANKING_TEST_SLOT_MAX }, (_, index) => {
      const slot = index + 1;
      return [String(slot), slotNames[String(slot)] || defaultRankingTestDisplayName(slot)];
    })),
    updatedBy: row?.updated_by || null,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null
  };
}

export async function getRankingTestGlobalSettings(db) {
  try {
    const row = await db.prepare(
      `SELECT id, global_enabled, slot_names_json, updated_by, created_at, updated_at
         FROM ranking_test_global_settings WHERE id = 1 LIMIT 1`
    ).bind().first();
    return { schemaAvailable: true, ...globalSettingsFromRow(row) };
  } catch (error) {
    if (schemaError(error)) return { schemaAvailable: false, globalEnabled: false, slotNames: {}, displayNames: {}, updatedBy: null, createdAt: null, updatedAt: null };
    throw error;
  }
}

export async function updateRankingTestGlobalSettings(db, { globalEnabled, slotNames = {}, updatedBy, now }) {
  const timestamp = now instanceof Date ? now.toISOString() : String(now);
  return db.prepare(
    `INSERT INTO ranking_test_global_settings
       (id, global_enabled, slot_names_json, updated_by, created_at, updated_at)
     VALUES (1, ?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(id) DO UPDATE SET
       global_enabled = excluded.global_enabled,
       slot_names_json = excluded.slot_names_json,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  ).bind(globalEnabled ? 1 : 0, serializeSlotNames(slotNames), String(updatedBy).slice(0, 160), timestamp).run();
}

export async function updateRankingTestDisplayName(db, { slot, displayName, updatedBy, now }) {
  const current = await getRankingTestGlobalSettings(db);
  if (!current.schemaAvailable) throw new Error("ranking_test_global_settings schema unavailable");
  const slotKey = String(normalizeRankingTestSlot(slot));
  const slotNames = { ...current.slotNames };
  if (displayName) slotNames[slotKey] = displayName;
  else delete slotNames[slotKey];
  return updateRankingTestGlobalSettings(db, { globalEnabled: current.globalEnabled, slotNames, updatedBy, now });
}

export async function getRankingTestState(db, internalGameId, contestId = "") {
  try {
    if (contestId) {
      const [setting, predictions, globalSettings] = await Promise.all([
        db.prepare(`SELECT internal_game_id, include_in_public_ranking, updated_by, created_at, updated_at
          FROM contest_ranking_test_game_settings WHERE contest_id=?1 AND internal_game_id=?2 LIMIT 1`)
          .bind(contestId, internalGameId).first(),
        db.prepare(`SELECT internal_game_id, slot, prediction_json, status, score, max_score,
            lineup_revision_id, scoring_revision_id, scored_at, created_at, updated_at
          FROM contest_ranking_test_predictions WHERE contest_id=?1 AND internal_game_id=?2 ORDER BY slot ASC`)
          .bind(contestId, internalGameId).all(),
        getRankingTestGlobalSettings(db)
      ]);
      return rankingTestStateResult(internalGameId, setting, predictions, globalSettings);
    }
    const [setting, predictions, globalSettings] = await Promise.all([
      db.prepare(
        `SELECT internal_game_id, include_in_public_ranking, updated_by, created_at, updated_at
           FROM ranking_test_game_settings WHERE internal_game_id = ?1 LIMIT 1`
      ).bind(internalGameId).first(),
      db.prepare(
        `SELECT internal_game_id, slot, prediction_json, status, score, max_score,
                lineup_revision_id, scoring_revision_id, scored_at, created_at, updated_at
           FROM ranking_test_predictions WHERE internal_game_id = ?1 ORDER BY slot ASC`
      ).bind(internalGameId).all(),
      getRankingTestGlobalSettings(db)
    ]);
    return rankingTestStateResult(internalGameId, setting, predictions, globalSettings);
  } catch (error) {
    if (schemaError(error)) return { schemaAvailable: false, internalGameId, setting: null, slots: [] };
    throw error;
  }
}

function rankingTestStateResult(internalGameId, setting, predictions, globalSettings) {
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
      globalSettings,
      setting: setting ? {
        includeInPublicRanking: Number(setting.include_in_public_ranking) === 1,
        updatedBy: setting.updated_by,
        createdAt: setting.created_at,
        updatedAt: setting.updated_at
      } : { includeInPublicRanking: false, updatedBy: null, createdAt: null, updatedAt: null },
      slots
    };
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

export async function materializeRankingTestPresetPredictions(db, { internalGameId, contestId = "", predictions = [], invalidSlots = [], now }) {
  const timestamp = now instanceof Date ? now.toISOString() : String(now);
  if (contestId) {
    const statements = predictions.map(({ slot, predictionJson }) => db.prepare(
      `INSERT INTO contest_ranking_test_predictions
         (contest_id, internal_game_id, slot, prediction_json, status, score, max_score,
          lineup_revision_id, scoring_revision_id, scored_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'submitted', NULL, NULL, NULL, NULL, NULL, ?5, ?5)
       ON CONFLICT(contest_id, slot) DO UPDATE SET prediction_json=excluded.prediction_json,
         status='submitted',score=NULL,max_score=NULL,lineup_revision_id=NULL,scoring_revision_id=NULL,
         scored_at=NULL,scored_attempt_id=NULL,updated_at=excluded.updated_at`
    ).bind(contestId, internalGameId, slot, predictionJson, timestamp));
    statements.push(...invalidSlots.map(slot => db.prepare(
      `UPDATE contest_ranking_test_predictions SET status='invalid',score=NULL,max_score=NULL,
          lineup_revision_id=NULL,scoring_revision_id=NULL,scored_at=NULL,scored_attempt_id=NULL,updated_at=?1
        WHERE contest_id=?2 AND internal_game_id=?3 AND slot=?4`
    ).bind(timestamp, contestId, internalGameId, slot)));
    if (statements.length) await db.batch(statements);
    return { materialized: predictions.length, invalid: invalidSlots.length };
  }
  const statements = predictions.map(({ slot, predictionJson }) => db.prepare(
    `INSERT INTO ranking_test_predictions
       (internal_game_id, slot, prediction_json, status, score, max_score,
        lineup_revision_id, scoring_revision_id, scored_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'submitted', NULL, NULL, NULL, NULL, NULL, ?4, ?4)
     ON CONFLICT(internal_game_id, slot) DO UPDATE SET
       prediction_json = excluded.prediction_json,
       status = 'submitted', score = NULL, max_score = NULL,
       lineup_revision_id = NULL, scoring_revision_id = NULL,
       scored_at = NULL, updated_at = excluded.updated_at`
  ).bind(internalGameId, slot, predictionJson, timestamp));
  statements.push(...invalidSlots.map((slot) => db.prepare(
    `UPDATE ranking_test_predictions
        SET status = 'invalid', score = NULL, max_score = NULL,
            lineup_revision_id = NULL, scoring_revision_id = NULL,
            scored_at = NULL, updated_at = ?1
      WHERE internal_game_id = ?2 AND slot = ?3`
  ).bind(timestamp, internalGameId, slot)));
  if (statements.length) await db.batch(statements);
  return { materialized: predictions.length, invalid: invalidSlots.length };
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
