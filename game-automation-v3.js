const INTERNAL_GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const V3_FEATURE_FLAG = "ENABLE_GAME_AUTOMATION_V3";
export const V3_STATES = Object.freeze([
  "scheduled",
  "prediction_closed",
  "lineup_ready",
  "scored",
  "ranked",
  "published",
  "excluded",
  "failed",
  "manual_action_required"
]);
export const V3_JOB_TYPES = Object.freeze([
  "npb_identity_resolve",
  "prediction_close",
  "lineup_fetch",
  "lineup_finalize",
  "score",
  "ranking_rebuild",
  "publish",
  "probable_starter_fetch",
  "roster_fetch"
]);
export const V3_MAIN_JOB_TYPES = Object.freeze([
  "npb_identity_resolve",
  "prediction_close",
  "lineup_fetch",
  "lineup_finalize",
  "score",
  "ranking_rebuild",
  "publish"
]);
export const V3_JOB_STATUSES = Object.freeze([
  "pending",
  "claimed",
  "completed",
  "retry_wait",
  "failed",
  "cancelled"
]);

export function isGameAutomationV3Enabled(env = {}) {
  return ["true", "1", "on", "enabled"].includes(String(env?.[V3_FEATURE_FLAG] || "").trim().toLowerCase());
}

export function normalizeV3InternalGameId(value) {
  const internalGameId = String(value || "").trim();
  if (!INTERNAL_GAME_ID_PATTERN.test(internalGameId)) {
    const error = new Error("V3ジョブにはinternal_game_idが必要です。");
    error.code = "V3_INTERNAL_GAME_ID_REQUIRED";
    throw error;
  }
  return internalGameId;
}

export function deriveV3Schedule(game) {
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  if (Number.isNaN(startAt.getTime())) {
    const error = new Error("DB日程に開始時刻がありません。");
    error.code = "V3_GAME_SCHEDULE_INVALID";
    throw error;
  }
  return {
    startAt,
    predictionDeadline: new Date(startAt.getTime() - 60 * 60 * 1000),
    lineupPollingStart: new Date(startAt.getTime() - 50 * 60 * 1000),
    finalLineupAt: new Date(startAt.getTime() + 2 * 60 * 1000),
    publicationAt: new Date(startAt.getTime() + 10 * 60 * 1000)
  };
}

export function getV3NpbIdentityState(game, now = new Date()) {
  const persisted = String(game?.npbIdentityStatus || game?.npb_identity_status || "").trim();
  if (persisted === "resolved" || persisted === "manually_overridden") return persisted;
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(current.getTime())) return "manual_action_required";
  if (current < new Date(startAt.getTime() - 50 * 60 * 1000)) return "pending";
  if (current <= new Date(startAt.getTime() + 2 * 60 * 1000)) return "retry_wait";
  return "manual_action_required";
}

export function isV3GameEligible(game) {
  if (!game?.internalGameId) return false;
  if (Number(game.isActive) === 0 || game.deletedAt) return false;
  return !["cancelled", "postponed", "no_game", "service_unavailable"].includes(String(game.gameStatus || "").toLowerCase());
}

export function getV3AllowedTransitions(from, to) {
  const allowed = {
    scheduled: ["prediction_closed", "excluded", "failed", "manual_action_required"],
    prediction_closed: ["lineup_ready", "failed", "manual_action_required", "excluded"],
    lineup_ready: ["scored", "failed", "manual_action_required", "excluded"],
    scored: ["ranked", "failed", "manual_action_required", "excluded"],
    ranked: ["published", "failed", "manual_action_required", "excluded"],
    published: ["manual_action_required"],
    excluded: ["ranked", "manual_action_required"],
    failed: ["manual_action_required"],
    manual_action_required: ["prediction_closed", "lineup_ready", "scored", "ranked", "published", "excluded"]
  };
  return Boolean(allowed[String(from || "")]?.includes(String(to || "")));
}

export function assertV3Transition(from, to) {
  if (!getV3AllowedTransitions(from, to)) {
    const error = new Error(`V3状態遷移が許可されていません: ${from} -> ${to}`);
    error.code = "V3_STATE_TRANSITION_INVALID";
    throw error;
  }
  return { from, to };
}

export function getV3LineupSlot(startAt, now = new Date()) {
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  const current = now instanceof Date ? now : new Date(now);
  const pollingStart = new Date(start.getTime() - 50 * 60 * 1000);
  if (current < pollingStart) return null;
  const elapsed = Math.max(0, current.getTime() - pollingStart.getTime());
  return new Date(pollingStart.getTime() + Math.floor(elapsed / (10 * 60 * 1000)) * 10 * 60 * 1000);
}

function shiftV3IsoDate(dateValue, days) {
  const date = new Date(`${String(dateValue || "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function jstV3Slot(dateValue, hour, minute) {
  const date = String(dateValue || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`);
}

export function getV3IdentityResolvePlans(game, now = new Date(), workflowState = "") {
  if (!isV3GameEligible(game) || String(workflowState || "") === "published") return [];
  const identityStatus = String(game?.npbIdentityStatus || game?.npb_identity_status || "").trim();
  if (["resolved", "manually_overridden"].includes(identityStatus)) return [];
  const current = now instanceof Date ? now : new Date(now);
  const schedule = deriveV3Schedule(game);
  if (Number.isNaN(current.getTime())) return [];
  const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10);
  const slots = [
    jstV3Slot(shiftV3IsoDate(gameDate, -1), 18, 0),
    jstV3Slot(gameDate, 16, 0),
    schedule.lineupPollingStart
  ];
  for (let slot = schedule.lineupPollingStart; slot <= schedule.finalLineupAt; slot = new Date(slot.getTime() + 10 * 60 * 1000)) {
    slots.push(slot);
  }
  const uniqueSlots = [...new Map(slots.filter((slot) => slot && !Number.isNaN(slot.getTime()))
    .map((slot) => [slot.toISOString(), slot])).values()]
    .sort((left, right) => left.getTime() - right.getTime());
  return uniqueSlots
    .filter((slot) => slot.getTime() <= current.getTime())
    .filter((slot) => slot.getTime() <= schedule.finalLineupAt.getTime())
    .map((slot) => ({ jobType: "npb_identity_resolve", scheduledSlotAt: slot, scheduledAt: slot }));
}

function isV3NpbIdentityResolved(game) {
  return ["resolved", "manually_overridden"].includes(String(game?.npbIdentityStatus || game?.npb_identity_status || "").trim());
}

export function getV3DuePlan(game, state, now = new Date()) {
  if (!isV3GameEligible(game)) return null;
  const schedule = deriveV3Schedule(game);
  const current = now instanceof Date ? now : new Date(now);
  if (state === "scheduled" && current >= schedule.predictionDeadline) {
    return { jobType: "prediction_close", scheduledSlotAt: schedule.predictionDeadline, scheduledAt: schedule.predictionDeadline };
  }
  if (state === "prediction_closed" && current >= schedule.finalLineupAt && isV3NpbIdentityResolved(game)) {
    return { jobType: "lineup_finalize", scheduledSlotAt: schedule.finalLineupAt, scheduledAt: schedule.finalLineupAt };
  }
  if (state === "prediction_closed" && current >= schedule.lineupPollingStart && isV3NpbIdentityResolved(game)) {
    const slot = getV3LineupSlot(schedule.startAt, current);
    return slot ? { jobType: "lineup_fetch", scheduledSlotAt: slot, scheduledAt: slot } : null;
  }
  if (state === "lineup_ready") return { jobType: "score", scheduledSlotAt: schedule.finalLineupAt, scheduledAt: schedule.finalLineupAt };
  if (state === "scored") return { jobType: "ranking_rebuild", scheduledSlotAt: schedule.publicationAt, scheduledAt: schedule.publicationAt };
  if (state === "ranked" && current >= schedule.publicationAt) {
    return { jobType: "publish", scheduledSlotAt: schedule.publicationAt, scheduledAt: schedule.publicationAt };
  }
  return null;
}

export function createV3Error(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

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
  return (result.results || []).map((row) => ({
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

export async function claimV3Job(db, { jobId, now = new Date(), leaseMilliseconds = 5 * 60 * 1000 } = {}) {
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
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
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const result = await db.prepare(
    `UPDATE game_jobs_v3
        SET status = 'completed', completed_at = ?1, lease_expires_at = NULL,
            claim_token = NULL, failure_code = ?2, failure_message = ?3, updated_at = ?1
      WHERE id = ?4 AND status = 'claimed' AND claim_token = ?5`
  ).bind(timestamp, failureCode, failureMessage, Number(jobId), claimToken).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function retryV3Job(db, { jobId, claimToken, attemptCount, maxAttempts, now = new Date(), errorCode, errorMessage, retryAt } = {}) {
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
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

async function hasOpenV3Job(db, internalGameId, jobType) {
  const row = await db.prepare(
    `SELECT id FROM game_jobs_v3
      WHERE internal_game_id = ?1 AND job_type = ?2
        AND status IN ('pending', 'claimed', 'retry_wait')
      LIMIT 1`
  ).bind(internalGameId, jobType).first();
  return Boolean(row?.id);
}

export async function runGameAutomationV3(env, now = new Date(), { executeJob, onError = null, onSuccess = null } = {}) {
  if (!isGameAutomationV3Enabled(env)) return { enabled: false, processed: 0, created: 0 };
  const schema = await getV3SchemaState(env.AUTH_DB);
  if (!schema.ready) return { enabled: true, schemaReady: false, errorCode: "GAME_AUTOMATION_V3_SCHEMA_UNAVAILABLE", processed: 0, created: 0 };
  const games = await listV3Games(env.AUTH_DB, now);
  let created = 0;
  let processed = 0;
  let failed = 0;
  for (const game of games) {
    try {
      const stateRow = await ensureV3State(env.AUTH_DB, game.internalGameId, now);
      if (!isV3GameEligible(game)) {
        if (stateRow.state !== "excluded") {
          await transitionV3State(env.AUTH_DB, { internalGameId: game.internalGameId, from: stateRow.state, to: "excluded", now });
        }
        continue;
      }
      const identityPlans = getV3IdentityResolvePlans(game, now, stateRow.state);
      const identityPlan = identityPlans[identityPlans.length - 1] || null;
      if (identityPlan && !(await hasOpenV3Job(env.AUTH_DB, game.internalGameId, "npb_identity_resolve"))) {
        const result = await createV3Job(env.AUTH_DB, { internalGameId: game.internalGameId, ...identityPlan });
        if (result.created) created += 1;
      }
      const plan = getV3DuePlan(game, stateRow.state, now);
      if (plan) {
        const result = await createV3Job(env.AUTH_DB, { internalGameId: game.internalGameId, ...plan });
        if (result.created) created += 1;
      }
    } catch (error) {
      failed += 1;
      if (onError) await onError(error, { game, stage: "plan" });
    }
  }
  const due = await listDueV3Jobs(env.AUTH_DB, now);
  for (const job of due) {
    const claimed = await claimV3Job(env.AUTH_DB, { jobId: job.id, now });
    if (!claimed) continue;
    processed += 1;
    try {
      const result = await executeJob({ env, job: claimed, internalGameId: claimed.internal_game_id, now });
      await completeV3Job(env.AUTH_DB, {
        jobId: claimed.id,
        claimToken: claimed.claim_token,
        now,
        failureCode: result?.failureCode || null,
        failureMessage: result?.failureMessage || null
      });
      if (result?.stateAfter && result.stateBefore && result.stateAfter !== result.stateBefore) {
        await transitionV3State(env.AUTH_DB, {
          internalGameId: claimed.internal_game_id,
          from: result.stateBefore,
          to: result.stateAfter,
          now,
          failureCode: null,
          failureMessage: null
        });
      }
      if (onSuccess) await onSuccess({ job: claimed, result, now });
      if (claimed.job_type === "npb_identity_resolve" && result?.identityResolved) {
        const followupGame = games.find((game) => game.internalGameId === claimed.internal_game_id);
        if (followupGame) {
          followupGame.npbIdentityStatus = "resolved";
          const followupState = await env.AUTH_DB.prepare(
            "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
          ).bind(claimed.internal_game_id).first();
          const followupPlan = getV3DuePlan(followupGame, followupState?.state || "scheduled", now);
          if (followupPlan && ["lineup_fetch", "lineup_finalize"].includes(followupPlan.jobType)) {
            await createV3Job(env.AUTH_DB, { internalGameId: claimed.internal_game_id, ...followupPlan });
          }
        }
      }
    } catch (error) {
      failed += 1;
      await retryV3Job(env.AUTH_DB, {
        jobId: claimed.id,
        claimToken: claimed.claim_token,
        attemptCount: claimed.attempt_count,
        maxAttempts: claimed.max_attempts,
        now,
        errorCode: error?.code || "V3_JOB_FAILED",
        errorMessage: String(error?.message || "V3ジョブに失敗しました。").slice(0, 240),
        retryAt: error?.retryAt || new Date(new Date(now).getTime() + 10 * 60 * 1000)
      });
      if (onError) await onError(error, { job: claimed, stage: "execute" });
    }
  }
  return { enabled: true, schemaReady: true, gameCount: games.length, created, processed, failed };
}
