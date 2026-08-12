import { V3_JOB_STATUS, V3_JOB_TYPE, V3_STATE, isGameAutomationV3Enabled } from "./constants.js";
import { isV3GameEligible } from "./domain.js";
import {
  completeV3Job,
  createV3Job,
  ensureV3State,
  listV3Games,
  getV3SchemaState,
  monotonicV3JobTimestamp,
  retryV3Job,
  transitionV3State
} from "./repository.js";
import { formatV3JobFailureMessage, getV3DuePlan, normalizeV3ExecutionError } from "./planner.js";
import {
  assertV3AuxiliaryJobResult,
  claimDueJobs,
  planAuxiliaryJobs,
  planMainWorkflowJobs
} from "./orchestrator.js";

// Audit observers must never hold the workflow planner or executor hostage.
// D1 audit writes are operational telemetry; the V3 job lifecycle is the
// authoritative path and must continue when telemetry is slow or unavailable.
const V3_OBSERVER_TIMEOUT_MS = 1000;

async function invokeV3Observer(observer, args = [], timeoutMs = V3_OBSERVER_TIMEOUT_MS) {
  if (typeof observer !== "function") return true;
  let timer = null;
  const parameters = Array.isArray(args) ? args : [args];
  try {
    const observed = Promise.resolve().then(() => observer(...parameters));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([observed.then(() => true).catch(() => false), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Claim execution lifecycle. Job-type business executors remain injected by auth-worker.
export async function executeClaimedJobs(env, claims = [], games = [], now = new Date(), { executeJob, onError = null, onSuccess = null, onPlan = null, observerTimeoutMs = V3_OBSERVER_TIMEOUT_MS } = {}) {
  let processed = 0;
  let failed = 0;
  for (const claim of claims) {
    const { job, claimed, entry, claimResult } = claim;
    if (entry && onPlan) {
      await invokeV3Observer(onPlan, [{
        ...entry,
        stage: entry.plan?.jobType === "probable_starter_fetch"
          ? "probable_claim"
          : `${entry.plan?.jobType || job.job_type}_claim`,
        claimResult,
        now
      }], observerTimeoutMs);
    }
    if (!claimed) continue;
    processed += 1;
    const executionNow = new Date(monotonicV3JobTimestamp(now, claimed.created_at, claimed.claimed_at));
    try {
      if (typeof executeJob !== "function") throw createV3Error("MISSING_EXECUTOR", "V3ジョブexecutorが注入されていません。");
      const result = await executeJob({ env, job: claimed, internalGameId: claimed.internal_game_id, now: executionNow });
      assertV3AuxiliaryJobResult(claimed, result, executionNow);
      await completeV3Job(env.AUTH_DB, {
        jobId: claimed.id,
        claimToken: claimed.claim_token,
        now: executionNow,
        failureCode: result?.failureCode || null,
        failureMessage: result?.failureMessage || null
      });
      if (result?.stateAfter && result.stateBefore && result.stateAfter !== result.stateBefore) {
        await transitionV3State(env.AUTH_DB, {
          internalGameId: claimed.internal_game_id,
          from: result.stateBefore,
          to: result.stateAfter,
          now: executionNow,
          failureCode: null,
          failureMessage: null
        });
      }
      const completedJob = await env.AUTH_DB.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(claimed.id)).first();
      await invokeV3Observer(onSuccess, [{ job: completedJob || { ...claimed, status: V3_JOB_STATUS.COMPLETED, completed_at: executionNow.toISOString(), updated_at: executionNow.toISOString() }, claimToken: claimed.claim_token, result, now: executionNow }], observerTimeoutMs);
      if (claimed.job_type === V3_JOB_TYPE.NPB_IDENTITY_RESOLVE && result?.identityResolved) {
        const followupGame = games.find((game) => game.internalGameId === claimed.internal_game_id);
        if (followupGame) {
          followupGame.npbIdentityStatus = "resolved";
          const followupState = await env.AUTH_DB.prepare(
            "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
          ).bind(claimed.internal_game_id).first();
          const followupPlan = getV3DuePlan(followupGame, followupState?.state || V3_STATE.SCHEDULED, now);
          if (followupPlan && [V3_JOB_TYPE.LINEUP_FETCH, V3_JOB_TYPE.LINEUP_FINALIZE].includes(followupPlan.jobType)) {
            await createV3Job(env.AUTH_DB, { internalGameId: claimed.internal_game_id, ...followupPlan });
          }
        }
      }
    } catch (rawError) {
      failed += 1;
      const error = normalizeV3ExecutionError(rawError);
      await retryV3Job(env.AUTH_DB, {
        jobId: claimed.id,
        claimToken: claimed.claim_token,
        attemptCount: claimed.attempt_count,
        maxAttempts: claimed.max_attempts,
        now: executionNow,
        errorCode: error.code,
        errorMessage: formatV3JobFailureMessage(error),
        retryAt: error?.retryAt || new Date(executionNow.getTime() + 10 * 60 * 1000)
      });
      const retryJob = await env.AUTH_DB.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(claimed.id)).first();
      await invokeV3Observer(onError, [error, { job: retryJob || claimed, claimToken: claimed.claim_token, stage: "execute", stateBefore: claimed.status }], observerTimeoutMs);
    }
  }
  return { processed, failed };
}

export async function runGameAutomationV3(env, now = new Date(), { executeJob, onError = null, onSuccess = null, onPlan = null, observerTimeoutMs = V3_OBSERVER_TIMEOUT_MS } = {}) {
  if (!isGameAutomationV3Enabled(env)) return { enabled: false, processed: 0, created: 0 };
  const schema = await getV3SchemaState(env.AUTH_DB);
  if (!schema.ready) return { enabled: true, schemaReady: false, errorCode: "GAME_AUTOMATION_V3_SCHEMA_UNAVAILABLE", processed: 0, created: 0 };
  const games = await listV3Games(env.AUTH_DB, now);
  let failed = 0;
  for (const game of games) {
    try {
      const stateRow = await ensureV3State(env.AUTH_DB, game.internalGameId, now);
      if (!isV3GameEligible(game) && stateRow.state !== V3_STATE.EXCLUDED) {
        await transitionV3State(env.AUTH_DB, { internalGameId: game.internalGameId, from: stateRow.state, to: V3_STATE.EXCLUDED, now });
      }
    } catch (error) {
      failed += 1;
      await invokeV3Observer(onError, [error, { game, stage: "state_prepare" }], observerTimeoutMs);
    }
  }

  // Phase boundaries are explicit: an auxiliary decision never short-circuits
  // the main workflow planner for the same or another game.
  const auxiliary = await planAuxiliaryJobs(env.AUTH_DB, games, now);
  const mainPlan = await planMainWorkflowJobs(env.AUTH_DB, games, now);
  const allPlanned = [...auxiliary.planned, ...mainPlan.planned];
  const reportPlan = async (entries, stage) => {
    for (const entry of entries) {
      if (!onPlan) continue;
      await invokeV3Observer(onPlan, [{ ...entry, stage, now, plannerDecision: entry.plannerDecision }], observerTimeoutMs);
    }
  };
  await reportPlan(auxiliary.probablePlan.planned, "probable_plan");
  await reportPlan(auxiliary.rosterPlan.planned, "roster_plan");
  await reportPlan(auxiliary.identityPlan.planned, "identity_plan");
  await reportPlan(mainPlan.planned, "main_plan");
  for (const entry of [...auxiliary.errors, ...mainPlan.errors]) {
    failed += 1;
    await invokeV3Observer(onError, [entry.error, { game: entry.game, plan: entry.plan, stage: "planner" }], observerTimeoutMs);
  }

  const claimReport = await claimDueJobs(env.AUTH_DB, now, allPlanned);
  const execution = await executeClaimedJobs(env, claimReport.claimed, games, now, { executeJob, onError, onSuccess, onPlan, observerTimeoutMs });
  return {
    enabled: true,
    schemaReady: true,
    gameCount: games.length,
    created: auxiliary.created + mainPlan.created,
    processed: execution.processed,
    failed: failed + execution.failed,
    probablePlan: auxiliary.probablePlan,
    rosterPlan: auxiliary.rosterPlan,
    identityPlan: auxiliary.identityPlan,
    mainPlan,
    auxiliaryPlan: auxiliary,
    claimReport
  };
}
