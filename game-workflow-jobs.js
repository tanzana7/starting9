export const WORKFLOW_JOB_STATUSES = Object.freeze(new Set([
  "pending", "claimed", "running", "retry_wait", "succeeded", "permanently_failed", "cancelled"
]));

const WORKFLOW_TRANSITIONS = Object.freeze({
  waiting: new Set(["prediction_open", "manual_intervention_required", "service_unavailable"]),
  prediction_open: new Set(["prediction_closed", "lineup_pending", "retrying", "manual_intervention_required"]),
  prediction_closed: new Set(["lineup_pending", "retrying", "manual_intervention_required"]),
  lineup_pending: new Set(["provisional_lineup_captured", "final_lineup_captured", "retrying", "service_unavailable", "manual_intervention_required"]),
  provisional_lineup_captured: new Set(["final_lineup_captured", "retrying", "service_unavailable", "manual_intervention_required"]),
  final_lineup_captured: new Set(["scoring_pending", "retrying", "manual_intervention_required"]),
  scoring_pending: new Set(["scored_private", "retrying", "service_unavailable", "manual_intervention_required"]),
  scored_private: new Set(["published", "retrying", "manual_intervention_required"]),
  published: new Set(["rescore_pending", "manual_intervention_required"]),
  retrying: new Set(["prediction_open", "lineup_pending", "provisional_lineup_captured", "final_lineup_captured", "scoring_pending", "service_unavailable", "manual_intervention_required"]),
  service_unavailable: new Set(["lineup_pending", "manual_intervention_required"]),
  manual_intervention_required: new Set(["prediction_open", "lineup_pending", "final_lineup_captured", "scoring_pending", "service_unavailable"]),
  rescore_pending: new Set(["scored_private", "published", "manual_intervention_required"])
});

function createWorkflowError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw createWorkflowError("JOB_INPUT_INVALID", "ジョブ時刻が不正です。");
  return date.toISOString();
}

function asInternalGameId(value) {
  const internalGameId = String(value || "").trim();
  if (!internalGameId) throw createWorkflowError("INTERNAL_GAME_ID_MISSING", "内部試合IDがありません。");
  return internalGameId;
}

export function isWorkflowTransitionAllowed(from, to) {
  const current = String(from || "waiting");
  const next = String(to || "");
  return current === next || Boolean(WORKFLOW_TRANSITIONS[current]?.has(next));
}

export function assertAllowedWorkflowTransition(from, to) {
  if (!isWorkflowTransitionAllowed(from, to)) {
    throw createWorkflowError("WORKFLOW_TRANSITION_INVALID", `試合進行状態を ${from || "waiting"} から ${to || ""} へ変更できません。`);
  }
}

export async function isGameWorkflowJobSchemaReady(db) {
  const result = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('game_workflow_state', 'game_job_runs')"
  ).bind().all();
  const names = new Set((result.results || []).map((row) => String(row.name || "")));
  return names.has("game_workflow_state") && names.has("game_job_runs");
}

export async function ensureGameWorkflowState(db, {
  internalGameId,
  legacyGameId = "",
  gameStatus = "scheduled",
  workflowStatus = "prediction_open",
  now = new Date()
} = {}) {
  const id = asInternalGameId(internalGameId);
  const timestamp = asIso(now);
  await db.prepare(
    `INSERT INTO game_workflow_state
      (internal_game_id, legacy_game_id, game_status, workflow_status, workflow_version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
     ON CONFLICT(internal_game_id) DO UPDATE SET
       legacy_game_id = CASE WHEN excluded.legacy_game_id = '' THEN game_workflow_state.legacy_game_id ELSE excluded.legacy_game_id END,
       game_status = excluded.game_status,
       updated_at = excluded.updated_at`
  ).bind(id, String(legacyGameId || ""), String(gameStatus || "scheduled"), String(workflowStatus || "prediction_open"), timestamp).run();
  return id;
}

export async function transitionWorkflowState(db, {
  internalGameId,
  to,
  completedJobType = "",
  errorCode = "",
  nextDueAt = null,
  now = new Date()
} = {}) {
  const id = asInternalGameId(internalGameId);
  const current = await db.prepare(
    "SELECT workflow_status, workflow_version FROM game_workflow_state WHERE internal_game_id = ?1 LIMIT 1"
  ).bind(id).first();
  if (!current) throw createWorkflowError("WORKFLOW_STATE_NOT_FOUND", "試合進行状態がありません。");
  assertAllowedWorkflowTransition(current.workflow_status, to);
  const timestamp = asIso(now);
  const result = await db.prepare(
    `UPDATE game_workflow_state
        SET workflow_status = ?1, workflow_version = workflow_version + 1,
            last_completed_job_type = CASE WHEN ?2 = '' THEN last_completed_job_type ELSE ?2 END,
            last_error_code = CASE WHEN ?3 = '' THEN NULL ELSE ?3 END,
            last_error_at = CASE WHEN ?3 = '' THEN NULL ELSE ?4 END,
            next_due_at = ?5, updated_at = ?4
      WHERE internal_game_id = ?6 AND workflow_version = ?7`
  ).bind(String(to), String(completedJobType || ""), String(errorCode || ""), timestamp, nextDueAt ? asIso(nextDueAt) : null, id, Number(current.workflow_version || 0)).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw createWorkflowError("WORKFLOW_STATE_CONFLICT", "試合進行状態が別の実行者に更新されました。");
  }
  return { internalGameId: id, from: current.workflow_status, to: String(to) };
}

export async function createWorkflowJob(db, {
  internalGameId,
  jobType,
  scheduledSlotAt,
  source = "cron",
  maxAttempts = 12,
  now = new Date()
} = {}) {
  const id = asInternalGameId(internalGameId);
  const type = String(jobType || "").trim();
  if (!type) throw createWorkflowError("JOB_INPUT_INVALID", "ジョブ種別がありません。");
  const timestamp = asIso(now);
  const result = await db.prepare(
    `INSERT INTO game_job_runs
      (internal_game_id, job_type, scheduled_slot_at, status, source, attempt_count, max_attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'pending', ?4, 0, ?5, ?6, ?6)
     ON CONFLICT(internal_game_id, job_type, scheduled_slot_at) DO NOTHING`
  ).bind(id, type, asIso(scheduledSlotAt), String(source || "cron"), Math.max(1, Number(maxAttempts || 1)), timestamp).run();
  return { created: Number(result?.meta?.changes || 0) === 1, internalGameId: id, jobType: type };
}

export async function claimWorkflowJob(db, {
  jobId,
  now = new Date(),
  leaseMilliseconds = 5 * 60 * 1000,
  claimToken = crypto.randomUUID()
} = {}) {
  const numericJobId = Number(jobId);
  if (!Number.isInteger(numericJobId) || numericJobId < 1) throw createWorkflowError("JOB_INPUT_INVALID", "ジョブIDが不正です。");
  const timestamp = asIso(now);
  const leaseExpiresAt = new Date(new Date(timestamp).getTime() + Math.max(1_000, Number(leaseMilliseconds || 0))).toISOString();
  const result = await db.prepare(
    `UPDATE game_job_runs
        SET status = 'claimed', claim_token = ?1, claimed_at = ?2, started_at = ?2,
            lease_expires_at = ?3, attempt_count = attempt_count + 1, updated_at = ?2
      WHERE id = ?4
        AND (
          status = 'pending'
          OR (status = 'retry_wait' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?2)
          OR (status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?2)
        )`
  ).bind(String(claimToken), timestamp, leaseExpiresAt, numericJobId).run();
  if (Number(result?.meta?.changes || 0) !== 1) return null;
  return await db.prepare(
    "SELECT * FROM game_job_runs WHERE id = ?1 AND claim_token = ?2 LIMIT 1"
  ).bind(numericJobId, String(claimToken)).first();
}

export async function completeWorkflowJob(db, { jobId, claimToken, resultMetadata = null, now = new Date() } = {}) {
  const timestamp = asIso(now);
  const result = await db.prepare(
    `UPDATE game_job_runs
        SET status = 'succeeded', completed_at = ?1, next_attempt_at = NULL,
            lease_expires_at = NULL, error_code = NULL, error_detail = NULL,
            result_metadata = ?2, updated_at = ?1
      WHERE id = ?3 AND claim_token = ?4 AND status IN ('claimed', 'running')`
  ).bind(timestamp, resultMetadata ? JSON.stringify(resultMetadata) : null, Number(jobId), String(claimToken || "")).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function retryWorkflowJob(db, {
  job,
  claimToken,
  errorCode,
  errorDetail = "",
  errorMetadata = null,
  retryable = true,
  nextAttemptAt,
  now = new Date()
} = {}) {
  const timestamp = asIso(now);
  const attemptCount = Number(job?.attempt_count || 0);
  const maxAttempts = Math.max(1, Number(job?.max_attempts || 1));
  const permanentlyFailed = retryable !== true || attemptCount >= maxAttempts;
  const status = permanentlyFailed ? "permanently_failed" : "retry_wait";
  const serializedMetadata = errorMetadata && typeof errorMetadata === "object"
    ? JSON.stringify(errorMetadata).slice(0, 1200)
    : null;
  const result = await db.prepare(
    `UPDATE game_job_runs
        SET status = ?1, completed_at = CASE WHEN ?1 = 'permanently_failed' THEN ?2 ELSE NULL END,
            next_attempt_at = CASE WHEN ?1 = 'retry_wait' THEN ?3 ELSE NULL END,
            lease_expires_at = NULL, error_code = ?4, error_detail = ?5,
            result_metadata = ?8, updated_at = ?2
      WHERE id = ?6 AND claim_token = ?7 AND status IN ('claimed', 'running')`
  ).bind(
    status,
    timestamp,
    permanentlyFailed ? null : asIso(nextAttemptAt),
    String(errorCode || "JOB_FAILED"),
    String(errorDetail || "").slice(0, 500),
    Number(job?.id),
    String(claimToken || ""),
    serializedMetadata
  ).run();
  return { updated: Number(result?.meta?.changes || 0) === 1, status };
}

export async function listDueWorkflowJobs(db, { jobTypes = [], now = new Date(), limit = 20 } = {}) {
  const types = [...new Set((jobTypes || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!types.length) return [];
  const timestamp = asIso(now);
  const placeholders = types.map((_, index) => `?${index + 1}`).join(", ");
  const result = await db.prepare(
    `SELECT * FROM game_job_runs
      WHERE job_type IN (${placeholders})
        AND scheduled_slot_at <= ?${types.length + 1}
        AND (
          status = 'pending'
          OR (status = 'retry_wait' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?${types.length + 1})
          OR (status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?${types.length + 1})
        )
      ORDER BY scheduled_slot_at ASC, id ASC
      LIMIT ?${types.length + 2}`
  ).bind(...types, timestamp, Math.max(1, Math.min(100, Number(limit || 20)))).all();
  return result.results || [];
}
