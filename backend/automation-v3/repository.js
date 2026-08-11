import { V3_JOB_TYPES, createV3Error, normalizeV3InternalGameId } from "./constants.js";
import { assertV3Transition, getV3NpbIdentityState } from "./domain.js";

// D1 persistence boundary for V3 games, states, identity hydration, and jobs.
export async function getV3SchemaState(db) {
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('games', 'game_jobs_v3', 'game_automation_v3_state')").all();
  const names = new Set((rows.results || []).map((row) => row.name));
  return {
    games: names.has("games"),
    jobs: names.has("game_jobs_v3"),
    state: names.has("game_automation_v3_state"),
    ready: names.has("games") && names.has("game_jobs_v3") && names.has("game_automation_v3_state")
  };
}

export async function listV3Games(db, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const date = new Date(current.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let columns = new Set();
  try {
    const schema = await db.prepare("PRAGMA table_info(games)").all();
    columns = new Set((schema.results || []).map((row) => String(row.name || "")));
  } catch {
    // Older adapters do not expose PRAGMA; the base V3 projection remains valid.
  }
  const optionalColumns = ["npb_game_url", "source_schedule_key", "npb_identity_status", "npb_identity_resolved_at", "npb_identity_source"]
    .filter((column) => columns.has(column));
  const result = await db.prepare(
    `SELECT internal_game_id, game_date, start_time, home_team, away_team,
            npb_game_code${optionalColumns.length ? `, ${optionalColumns.join(", ")}` : ""},
            game_status, is_active, deleted_at
       FROM games
      WHERE internal_game_id IS NOT NULL AND internal_game_id <> ''
        AND game_date >= date(?1)
      ORDER BY start_time, internal_game_id`
  ).bind(date).all();
  const baseGames = (result.results || []).map((row) => ({
    internalGameId: row.internal_game_id,
    gameDate: row.game_date,
    startAt: row.start_time,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    npbGameCode: row.npb_game_code || null,
    npbGameUrl: row.npb_game_url || null,
    sourceScheduleKey: row.source_schedule_key || null,
    npbIdentityStatus: row.npb_identity_status || (row.npb_game_code ? "resolved" : "unresolved"),
    npbIdentityResolvedAt: row.npb_identity_resolved_at || null,
    npbIdentitySource: row.npb_identity_source || null,
    npbIdentityState: getV3NpbIdentityState({
      npbIdentityStatus: row.npb_identity_status || (row.npb_game_code ? "resolved" : "unresolved"),
      startAt: row.start_time
    }, current),
    gameStatus: row.game_status,
    isActive: row.is_active,
    deletedAt: row.deleted_at
  }));
  return Promise.all(baseGames.map((game) => hydrateV3GameIdentityFromIdentifiers(db, game)));
}

function normalizeV3NpbGameCode(value) {
  const code = String(value || "").trim().toLowerCase();
  return /^[a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+$/.test(code) ? code : "";
}

function buildV3NpbGameUrl(gameDate, gameCode) {
  const date = String(gameDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const code = normalizeV3NpbGameCode(gameCode);
  if (!date || !code) return null;
  return `https://npb.jp/scores/${date[1]}/${date[2]}${date[3]}/${code}/`;
}

// Schedule sync registers NPB identity in game_identifiers before all consumers
// have necessarily copied it into games. Read that canonical registry value for
// V3 planning and lineup execution without mutating historical schedule rows.
export async function hydrateV3GameIdentityFromIdentifiers(db, game = {}) {
  const existingCode = normalizeV3NpbGameCode(game.npbGameCode || game.npb_game_code);
  const existingStatus = String(game.npbIdentityStatus || game.npb_identity_status || "").trim();
  if (existingCode || existingStatus === "manually_overridden") return game;

  const internalGameId = String(game.internalGameId || game.internal_game_id || "").trim();
  if (!internalGameId) return game;
  let result;
  try {
    result = await db.prepare(
      `SELECT provider, identifier_type, identifier_value, updated_at
         FROM game_identifiers
        WHERE internal_game_id = ?1
          AND ((provider = 'npb' AND identifier_type = 'npb_game_code')
            OR (provider = 'schedule_worker' AND identifier_type = 'source_game_key'))
        ORDER BY updated_at DESC, id DESC`
    ).bind(internalGameId).all();
  } catch {
    // Older test adapters or partially migrated databases should retain the
    // normal unresolved behavior rather than blocking the V3 runner.
    return game;
  }
  const identifiers = result?.results || [];
  const codes = [...new Set(identifiers
    .filter((row) => row.provider === "npb" && row.identifier_type === "npb_game_code")
    .map((row) => normalizeV3NpbGameCode(row.identifier_value))
    .filter(Boolean))];
  if (codes.length === 0) return game;
  if (codes.length > 1) {
    return { ...game, npbIdentityStatus: "conflict", npbIdentitySource: "game_identifiers" };
  }
  const code = codes[0];
  const sourceKey = identifiers.find((row) => row.provider === "schedule_worker" && row.identifier_type === "source_game_key")?.identifier_value || null;
  const updatedAt = identifiers.find((row) => row.provider === "npb" && row.identifier_type === "npb_game_code")?.updated_at || null;
  return {
    ...game,
    npbGameCode: code,
    npbGameUrl: game.npbGameUrl || game.npb_game_url || buildV3NpbGameUrl(game.gameDate || game.game_date, code),
    sourceScheduleKey: game.sourceScheduleKey || game.source_schedule_key || sourceKey,
    npbIdentityStatus: "resolved",
    npbIdentityResolvedAt: game.npbIdentityResolvedAt || game.npb_identity_resolved_at || updatedAt,
    npbIdentitySource: "game_identifiers"
  };
}

export async function ensureV3State(db, internalGameId, now = new Date()) {
  const id = normalizeV3InternalGameId(internalGameId);
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  await db.prepare(
    `INSERT INTO game_automation_v3_state
       (internal_game_id, state, version, created_at, updated_at)
     VALUES (?1, 'scheduled', 0, ?2, ?2)
     ON CONFLICT(internal_game_id) DO NOTHING`
  ).bind(id, timestamp).run();
  return db.prepare("SELECT * FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1").bind(id).first();
}

export async function transitionV3State(db, { internalGameId, from, to, now = new Date(), failureCode = null, failureMessage = null } = {}) {
  const id = normalizeV3InternalGameId(internalGameId);
  assertV3Transition(from, to);
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const result = await db.prepare(
    `UPDATE game_automation_v3_state
        SET state = ?1, version = version + 1, failure_code = ?2,
            failure_message = ?3,
            prediction_closed_at = CASE WHEN ?1 = 'prediction_closed' THEN COALESCE(prediction_closed_at, ?4) ELSE prediction_closed_at END,
            lineup_finalized_at = CASE WHEN ?1 = 'lineup_ready' THEN COALESCE(lineup_finalized_at, ?4) ELSE lineup_finalized_at END,
            ranked_at = CASE WHEN ?1 = 'ranked' THEN COALESCE(ranked_at, ?4) ELSE ranked_at END,
            published_at = CASE WHEN ?1 = 'published' THEN COALESCE(published_at, ?4) ELSE published_at END,
            excluded_at = CASE WHEN ?1 = 'excluded' THEN COALESCE(excluded_at, ?4) ELSE excluded_at END,
            updated_at = ?4
      WHERE internal_game_id = ?5 AND state = ?6`
  ).bind(to, failureCode, failureMessage, timestamp, id, from).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw createV3Error("V3_STATE_VERSION_CONFLICT", "V3状態が別の実行で更新されました。");
  }
  return db.prepare("SELECT * FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1").bind(id).first();
}

export async function createV3Job(db, { internalGameId, jobType, scheduledSlotAt, scheduledAt = scheduledSlotAt, maxAttempts = 12, source = "cron" } = {}) {
  const id = normalizeV3InternalGameId(internalGameId);
  if (!V3_JOB_TYPES.includes(jobType)) throw createV3Error("V3_JOB_TYPE_INVALID", "V3ジョブ種別が不正です。");
  const slot = scheduledSlotAt instanceof Date ? scheduledSlotAt : new Date(scheduledSlotAt);
  const due = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(slot.getTime()) || Number.isNaN(due.getTime())) {
    throw createV3Error("V3_JOB_TIME_INVALID", "V3ジョブの実行時刻が不正です。");
  }
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `INSERT OR IGNORE INTO game_jobs_v3
       (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
        attempt_count, max_attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?6, ?6)`
  ).bind(id, jobType, due.toISOString(), slot.toISOString(), maxAttempts, timestamp).run();
  const row = await db.prepare(
    `SELECT * FROM game_jobs_v3
      WHERE internal_game_id = ?1 AND job_type = ?2 AND scheduled_slot_at = ?3 LIMIT 1`
  ).bind(id, jobType, slot.toISOString()).first();
  return { created: Number(result?.meta?.changes || 0) === 1, job: row, source };
}

export function monotonicV3JobTimestamp(requestedAt, ...minimumValues) {
  const requested = requestedAt instanceof Date ? requestedAt : new Date(requestedAt);
  const values = [requested.getTime(), ...minimumValues.map((value) => new Date(value || "").getTime())]
    .filter((value) => Number.isFinite(value));
  return new Date(Math.max(...values)).toISOString();
}

export async function claimV3Job(db, { jobId, now = new Date(), leaseMilliseconds = 5 * 60 * 1000 } = {}) {
  const current = await db.prepare("SELECT created_at FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
  const timestamp = monotonicV3JobTimestamp(now, current?.created_at);
  const leaseExpiresAt = new Date(new Date(timestamp).getTime() + leaseMilliseconds).toISOString();
  const claimToken = `${timestamp}:${Math.random().toString(36).slice(2)}`;
  const result = await db.prepare(
    `UPDATE game_jobs_v3
        SET status = 'claimed', attempt_count = attempt_count + 1,
            claimed_at = ?1, lease_expires_at = ?2, claim_token = ?3, updated_at = ?1
      WHERE id = ?4 AND (
        status IN ('pending', 'retry_wait')
        OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1)
      )
        AND (next_retry_at IS NULL OR next_retry_at <= ?1)
        AND attempt_count < max_attempts`
  ).bind(timestamp, leaseExpiresAt, claimToken, Number(jobId)).run();
  if (Number(result?.meta?.changes || 0) !== 1) return null;
  return db.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
}

export async function completeV3Job(db, { jobId, claimToken, now = new Date(), failureCode = null, failureMessage = null } = {}) {
  const current = await db.prepare("SELECT created_at, claimed_at FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
  const timestamp = monotonicV3JobTimestamp(now, current?.created_at, current?.claimed_at);
  const result = await db.prepare(
    `UPDATE game_jobs_v3
        SET status = 'completed', completed_at = ?1, lease_expires_at = NULL,
            claim_token = NULL, failure_code = ?2, failure_message = ?3, updated_at = ?1
      WHERE id = ?4 AND status = 'claimed' AND claim_token = ?5`
  ).bind(timestamp, failureCode, failureMessage, Number(jobId), claimToken).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function retryV3Job(db, { jobId, claimToken, attemptCount, maxAttempts, now = new Date(), errorCode, errorMessage, retryAt } = {}) {
  const current = await db.prepare("SELECT created_at, claimed_at FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
  const timestamp = monotonicV3JobTimestamp(now, current?.created_at, current?.claimed_at);
  const terminal = Number(attemptCount) >= Number(maxAttempts);
  const retry = retryAt ? new Date(retryAt).toISOString() : null;
  const result = await db.prepare(
    `UPDATE game_jobs_v3
        SET status = ?1, next_retry_at = ?2, lease_expires_at = NULL,
            claim_token = NULL, failure_code = ?3, failure_message = ?4, updated_at = ?5
      WHERE id = ?6 AND status = 'claimed' AND claim_token = ?7`
  ).bind(terminal ? "failed" : "retry_wait", terminal ? null : retry, errorCode || null, errorMessage || null, timestamp, Number(jobId), claimToken).run();
  return { updated: Number(result?.meta?.changes || 0) === 1, status: terminal ? "failed" : "retry_wait" };
}

export async function listDueV3Jobs(db, now = new Date(), limit = 50) {
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const result = await db.prepare(
    `SELECT * FROM game_jobs_v3
      WHERE (status IN ('pending', 'retry_wait')
         OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1))
        AND scheduled_at <= ?1
        AND (next_retry_at IS NULL OR next_retry_at <= ?1)
      ORDER BY scheduled_at, id LIMIT ?2`
  ).bind(timestamp, Math.max(1, Math.min(100, Number(limit) || 50))).all();
  return result.results || [];
}
