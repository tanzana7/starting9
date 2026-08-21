import { V3_JOB_STATUS, V3_JOB_TYPE, V3_STATE, createV3Error, isGameAutomationV3Enabled } from "./constants.js";
import { isV3GameEligible, V3_COMPLETED_STATE_TRANSITIONS } from "./domain.js";
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
import { assessV3LineupArtifact } from "./lineup-artifacts.js";

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

function hasVerifiedLineupPayload(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const parsed = JSON.parse(value);
    return assessV3LineupArtifact(parsed).ok;
  } catch {
    return false;
  }
}

async function canReconcileCompletedV3StateTransition(db, internalGameId, transition) {
  try {
    switch (transition.jobType) {
      case V3_JOB_TYPE.PREDICTION_CLOSE:
        return true;
      case V3_JOB_TYPE.LINEUP_FINALIZE: {
        const final = await db.prepare(
          `SELECT actual_lineup_json
             FROM game_lineup_revisions
            WHERE internal_game_id = ?1 AND is_final = 1
            ORDER BY version DESC LIMIT 1`
        ).bind(internalGameId).first();
        return hasVerifiedLineupPayload(final?.actual_lineup_json);
      }
      case V3_JOB_TYPE.SCORE: {
        const lineup = await db.prepare(
          `SELECT scoring_status, scored_at
             FROM game_lineups
            WHERE internal_game_id = ?1 LIMIT 1`
        ).bind(internalGameId).first();
        return String(lineup?.scoring_status || "") === "scored" && Boolean(lineup?.scored_at);
      }
      case V3_JOB_TYPE.RANKING_REBUILD: {
        const reflection = await db.prepare(
          `SELECT status
             FROM ranking_reflection_revisions
            WHERE internal_game_id = ?1
            ORDER BY ranking_update_revision DESC, id DESC
            LIMIT 1`
        ).bind(internalGameId).first();
        return String(reflection?.status || "") === "reflected";
      }
      case V3_JOB_TYPE.PUBLISH: {
        const publication = await db.prepare(
          `SELECT publication_status, published_at
             FROM game_lineups
            WHERE internal_game_id = ?1 LIMIT 1`
        ).bind(internalGameId).first();
        return String(publication?.publication_status || "") === "published" && Boolean(publication?.published_at);
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

async function reconcileCompletedV3StateTransitions(env, games = [], now = new Date(), { onError = null, observerTimeoutMs = V3_OBSERVER_TIMEOUT_MS } = {}) {
  let recovered = 0;
  let failed = 0;
  const recoveredJobIds = [];
  const recoveredByJobType = {};
  const skipped = [];
  for (const game of Array.isArray(games) ? games : []) {
    try {
      // Walk only the finite canonical graph. This also repairs multiple
      // consecutive post-completion transition failures in one Cron run.
      for (let step = 0; step < V3_COMPLETED_STATE_TRANSITIONS.length; step += 1) {
        const stateRow = await env.AUTH_DB.prepare(
          "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
        ).bind(game.internalGameId).first();
        const currentState = String(stateRow?.state || "");
        const transition = V3_COMPLETED_STATE_TRANSITIONS.find((candidate) => candidate.from === currentState);
        if (!transition) break;
        const completedJob = await env.AUTH_DB.prepare(
          `SELECT id, completed_at
             FROM game_jobs_v3
            WHERE internal_game_id = ?1
              AND job_type = ?2
              AND status = 'completed'
            ORDER BY completed_at DESC, updated_at DESC, id DESC
            LIMIT 1`
        ).bind(game.internalGameId, transition.jobType).first();
        if (!completedJob) break;
        if (!(await canReconcileCompletedV3StateTransition(env.AUTH_DB, game.internalGameId, transition))) {
          skipped.push({
            jobType: transition.jobType,
            jobId: Number(completedJob.id),
            reason: "V3_COMPLETED_WITHOUT_REQUIRED_ARTIFACT",
            code: `${String(transition.jobType).toUpperCase()}_COMPLETED_WITHOUT_ARTIFACT`
          });
          break;
        }
        await transitionV3State(env.AUTH_DB, {
          internalGameId: game.internalGameId,
          from: transition.from,
          to: transition.to,
          now
        });
        recovered += 1;
        recoveredJobIds.push(Number(completedJob.id));
        recoveredByJobType[transition.jobType] = (recoveredByJobType[transition.jobType] || 0) + 1;
      }
    } catch (error) {
      failed += 1;
      await invokeV3Observer(onError, [error, {
        game,
        stage: "completed_state_reconcile"
      }], observerTimeoutMs);
    }
  }
  return { recovered, failed, recoveredJobIds, recoveredByJobType, skipped };
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
      const completed = await completeV3Job(env.AUTH_DB, {
        jobId: claimed.id,
        claimToken: claimed.claim_token,
        now: executionNow,
        failureCode: result?.failureCode || null,
        failureMessage: result?.failureMessage || null
      });
      if (!completed) {
        throw createV3Error("V3_JOB_COMPLETION_CONFLICT", "V3ジョブの完了状態を確定できませんでした。状態遷移は行いません。", { retryable: true });
      }
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

  // A completed main job can outlive a failed state transition. Restore only
  // the matching canonical boundary through the normal V3 transition contract
  // before planning downstream jobs; this never writes the state table directly.
  const stateReconciliation = await reconcileCompletedV3StateTransitions(env, games, now, { onError, observerTimeoutMs });
  failed += stateReconciliation.failed;

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
    stateReconciliation,
    probablePlan: auxiliary.probablePlan,
    rosterPlan: auxiliary.rosterPlan,
    identityPlan: auxiliary.identityPlan,
    mainPlan,
    auxiliaryPlan: auxiliary,
    claimReport
  };
}
