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
import { isV3JobForStage } from "./planning-engine.js";
import { assessV3LineupArtifact } from "./lineup-artifacts.js";

// Audit observers must never hold the workflow planner or executor hostage.
// D1 audit writes are operational telemetry; the V3 job lifecycle is the
// authoritative path and must continue when telemetry is slow or unavailable.
// The observer promise is handed to the runtime scheduler when one is
// available. There is deliberately no timeout race: a timeout cannot cancel a
// side-effectful audit callback and would leave a late write running in the
// background. Every rejection is observed before it is scheduled or ignored.
const V3_OBSERVER_TIMEOUT_MS = 1000;

function invokeV3Observer(observer, args = [], _timeoutMs = V3_OBSERVER_TIMEOUT_MS, observerScheduler = null) {
  if (typeof observer !== "function") return Promise.resolve(true);
  const parameters = Array.isArray(args) ? args : [args];
  const observed = Promise.resolve()
    .then(() => observer(...parameters))
    .then(() => true)
    .catch(() => false);
  if (typeof observerScheduler === "function") {
    try {
      observerScheduler(observed);
    } catch {
      // Scheduling telemetry must not affect the V3 lifecycle.
    }
  }
  return Promise.resolve(true);
}

function emptyV3PlanResult(error = null, plan = null) {
  return {
    created: 0,
    planned: [],
    diagnostics: [],
    errors: error ? [{ game: null, plan, error }] : []
  };
}

function emptyV3PlannerPhaseResult(error = null, plan = null) {
  const base = emptyV3PlanResult(error, plan);
  if (plan !== "auxiliary") return base;
  return {
    ...base,
    probablePlan: emptyV3PlanResult(),
    rosterPlan: emptyV3PlanResult(),
    identityPlan: emptyV3PlanResult()
  };
}

async function runV3PlannerPhase(planner, db, games, now, plan) {
  try {
    const result = await planner(db, games, now);
    const normalized = result || emptyV3PlannerPhaseResult(null, plan);
    return { ...normalized, phaseStatus: normalized.errors?.length ? "failed" : "completed" };
  } catch (error) {
    // Planning is best-effort. The due-job lifecycle must still run so an
    // already-created pending/retry_wait job is not stranded by a planner
    // failure in the same Cron invocation.
    return { ...emptyV3PlannerPhaseResult(error, plan), phaseStatus: "failed" };
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

const V3_STATE_ORDER = Object.freeze([
  "scheduled",
  "probable_starter_ready",
  "roster_ready",
  "prediction_closed",
  "lineup_ready",
  "scored",
  "ranked",
  "published"
]);

function isLaterV3State(currentState, expectedState) {
  const currentIndex = V3_STATE_ORDER.indexOf(String(currentState || "").trim().toLowerCase());
  const expectedIndex = V3_STATE_ORDER.indexOf(String(expectedState || "").trim().toLowerCase());
  return currentIndex >= 0 && expectedIndex >= 0 && currentIndex > expectedIndex;
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
        let currentScoringRevision = null;
        let currentScoringRevisionAvailable = false;
        try {
          currentScoringRevision = await db.prepare(
            `SELECT scoring_revision_id
               FROM game_automation_v3_state
              WHERE internal_game_id = ?1 LIMIT 1`
          ).bind(internalGameId).first();
          currentScoringRevisionAvailable = Boolean(currentScoringRevision);
        } catch {
          // Legacy schemas without the revision marker retain status-only
          // reconciliation compatibility.
        }
        let reflection = null;
        try {
          reflection = await db.prepare(
            `SELECT status, scoring_revision_id
               FROM ranking_reflection_revisions
              WHERE internal_game_id = ?1
              ORDER BY ranking_update_revision DESC, id DESC
              LIMIT 1`
          ).bind(internalGameId).first();
        } catch {
          reflection = await db.prepare(
            `SELECT status
               FROM ranking_reflection_revisions
              WHERE internal_game_id = ?1
              ORDER BY ranking_update_revision DESC, id DESC
              LIMIT 1`
          ).bind(internalGameId).first();
        }
        const currentScoringRevisionId = String(currentScoringRevision?.scoring_revision_id || "").trim();
        const reflectedScoringRevisionId = String(reflection?.scoring_revision_id || "").trim();
        if (currentScoringRevisionAvailable) {
          return Boolean(
            currentScoringRevisionId
            && String(reflection?.status || "") === "reflected"
            && reflectedScoringRevisionId === currentScoringRevisionId
          );
        }
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

async function reconcileCompletedV3StateTransitions(env, games = [], now = new Date(), { onError = null, observerTimeoutMs = V3_OBSERVER_TIMEOUT_MS, observerScheduler = null } = {}) {
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
        const completedJobs = await env.AUTH_DB.prepare(
          `SELECT *
             FROM game_jobs_v3
            WHERE internal_game_id = ?1
              AND status = 'completed'`
        ).bind(game.internalGameId).all();
        const completedJob = (completedJobs.results || [])
          .filter((job) => isV3JobForStage(job, transition.jobType))
          .sort((left, right) => String(right.completed_at || right.updated_at || right.created_at || "")
            .localeCompare(String(left.completed_at || left.updated_at || left.created_at || ""))
            || Number(right.id || 0) - Number(left.id || 0))[0] || null;
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
      }], observerTimeoutMs, observerScheduler);
    }
  }
  return { recovered, failed, recoveredJobIds, recoveredByJobType, skipped };
}

const emptyV3ReconciliationResult = () => ({
  recovered: 0,
  failed: 0,
  recoveredJobIds: [],
  recoveredByJobType: {},
  skipped: []
});

async function prepareV3GameStates(env, games = [], now = new Date(), { onError = null, observerTimeoutMs = V3_OBSERVER_TIMEOUT_MS, observerScheduler = null } = {}) {
  let prepared = 0;
  let skipped = 0;
  let failed = 0;
  for (const game of Array.isArray(games) ? games : []) {
    try {
      const stateRow = await ensureV3State(env.AUTH_DB, game.internalGameId, now);
      prepared += 1;
      if (isV3GameEligible(game) || stateRow.state === V3_STATE.EXCLUDED) continue;
      const unavailable = ["cancelled", "canceled", "postponed", "service_unavailable"].includes(String(game?.gameStatus || "").toLowerCase());
      if (unavailable) {
        skipped += 1;
        await invokeV3Observer(onError, [createV3Error(
          "OFFICIAL_CANCELLATION_RECONCILE_REQUIRED",
          "中止・対象外状態を正式反映できるまで、V3状態を自動前進させません。",
          { retryable: true }
        ), { game, stateBefore: stateRow.state, stage: "official_cancellation_reconcile" }], observerTimeoutMs, observerScheduler);
        continue;
      }
      await transitionV3State(env.AUTH_DB, { internalGameId: game.internalGameId, from: stateRow.state, to: V3_STATE.EXCLUDED, now });
    } catch (error) {
      failed += 1;
      await invokeV3Observer(onError, [error, { game, stage: "state_prepare" }], observerTimeoutMs, observerScheduler);
    }
  }
  return { prepared, skipped, failed };
}

async function runV3OptionalPhases(env, games, now, {
  auxiliaryPlanner,
  onError,
  onPlan,
  onPhase,
  observerTimeoutMs,
  observerScheduler
} = {}) {
  let statePreparation = { prepared: 0, skipped: 0, failed: 0 };
  await invokeV3Observer(onPhase, [{ stage: "state_prepare_started", now, gameCount: games.length }], observerTimeoutMs, observerScheduler);
  try {
    statePreparation = await prepareV3GameStates(env, games, now, { onError, observerTimeoutMs, observerScheduler });
    await invokeV3Observer(onPhase, [{
      stage: "state_prepare_finished",
      now,
      status: statePreparation.failed ? "completed_with_errors" : "completed",
      statePreparation
    }], observerTimeoutMs, observerScheduler);
  } catch (error) {
    await invokeV3Observer(onError, [error, { stage: "state_prepare" }], observerTimeoutMs, observerScheduler);
    await invokeV3Observer(onPhase, [{
      stage: "state_prepare_finished",
      now,
      status: "failed",
      statePreparation,
      errorCode: error?.code || "V3_STATE_PREPARATION_FAILED"
    }], observerTimeoutMs, observerScheduler);
  }
  let stateReconciliation = emptyV3ReconciliationResult();
  await invokeV3Observer(onPhase, [{ stage: "reconciliation_started", now, gameCount: games.length }], observerTimeoutMs, observerScheduler);
  try {
    stateReconciliation = await reconcileCompletedV3StateTransitions(env, games, now, { onError, observerTimeoutMs, observerScheduler });
    await invokeV3Observer(onPhase, [{
      stage: "reconciliation_finished",
      now,
      status: "completed",
      stateReconciliation,
      errorCode: null
    }], observerTimeoutMs, observerScheduler);
  } catch (error) {
    await invokeV3Observer(onError, [error, { stage: "reconciliation" }], observerTimeoutMs, observerScheduler);
    await invokeV3Observer(onPhase, [{
      stage: "reconciliation_finished",
      now,
      status: "failed",
      stateReconciliation,
      errorCode: error?.code || "V3_RECONCILIATION_FAILED"
    }], observerTimeoutMs, observerScheduler);
  }

  await invokeV3Observer(onPhase, [{ stage: "auxiliary_plan_started", now, gameCount: games.length }], observerTimeoutMs, observerScheduler);
  const auxiliary = await runV3PlannerPhase(auxiliaryPlanner, env.AUTH_DB, games, now, "auxiliary");
  for (const [plan, stage] of [
    [auxiliary.probablePlan, "probable_plan"],
    [auxiliary.rosterPlan, "roster_plan"],
    [auxiliary.identityPlan, "identity_plan"]
  ]) {
    for (const entry of plan?.planned || []) {
      await invokeV3Observer(onPlan, [{ ...entry, stage, now, plannerDecision: entry.plannerDecision }], observerTimeoutMs, observerScheduler);
    }
  }
  await invokeV3Observer(onPhase, [{
    stage: "auxiliary_plan_finished",
    now,
    status: auxiliary.phaseStatus || "completed",
    plan: auxiliary,
    errorCode: auxiliary.errors[0]?.error?.code || null
  }], observerTimeoutMs, observerScheduler);
  await invokeV3Observer(onPhase, [{
    stage: "auxiliary_plan_summary",
    now,
    plan: auxiliary
  }], observerTimeoutMs, observerScheduler);
  return { statePreparation, stateReconciliation, auxiliary };
}

// Claim execution lifecycle. Job-type business executors remain injected by auth-worker.
export async function executeClaimedJobs(env, claims = [], games = [], now = new Date(), { executeJob, onError = null, onSuccess = null, onPlan = null, observerTimeoutMs = V3_OBSERVER_TIMEOUT_MS, observerScheduler = null, v4SemiAuto = false } = {}) {
  let processed = 0;
  let failed = 0;
  let retryWait = 0;
  let terminalFailed = 0;
  const failedJobIds = [];
  const retryErrors = [];
  for (const claim of claims) {
    const { job, claimed, entry, claimResult } = claim;
    if (onPlan) {
      const claimEntry = entry || {
        game: games.find((game) => game?.internalGameId === job?.internal_game_id) || null,
        plan: {
          jobType: job?.job_type || null,
          scheduledAt: job?.scheduled_at || null,
          scheduledSlotAt: job?.scheduled_slot_at || null
        },
        job,
        diagnostic: {}
      };
      await invokeV3Observer(onPlan, [{
        ...claimEntry,
        diagnostic: { ...(claimEntry.diagnostic || {}), claimResult },
        stage: claimEntry.plan?.jobType === "probable_starter_fetch"
          ? "probable_claim"
          : `${claimEntry.plan?.jobType || job.job_type}_claim`,
        claimResult,
        now
      }], observerTimeoutMs, observerScheduler);
    }
    if (!claimed) continue;
    processed += 1;
    const executionNow = new Date(monotonicV3JobTimestamp(now, claimed.created_at, claimed.claimed_at));
    try {
      if (typeof executeJob !== "function") throw createV3Error("MISSING_EXECUTOR", "V3ジョブexecutorが注入されていません。");
      const result = await executeJob({
        env,
        job: claimed,
        internalGameId: claimed.internal_game_id,
        now: executionNow,
        v4SemiAuto: Boolean(v4SemiAuto)
      });
      assertV3AuxiliaryJobResult(claimed, result, executionNow);
      // Formal score activation completes the job in the same D1 batch as
      // the current score, revision, TEST rows, and workflow pointer. Do not
      // perform a second lifecycle mutation after that atomic boundary.
      const completed = result?.jobCompletedAtomically === true
        ? Boolean((await env.AUTH_DB.prepare(
          "SELECT 1 AS done FROM game_jobs_v3 WHERE id = ?1 AND status = 'completed' LIMIT 1"
        ).bind(claimed.id).first())?.done)
        : await completeV3Job(env.AUTH_DB, {
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
        // A prior completed job may have persisted its artifact while its
        // state transition was lost. Reconcile that finite graph first so a
        // stale state cannot make the current transition invalid. The
        // reconciliation is artifact-checked and never regresses state.
        await reconcileCompletedV3StateTransitions(
          env,
          games.filter((game) => game?.internalGameId === claimed.internal_game_id),
          executionNow,
          { onError, observerTimeoutMs, observerScheduler }
        );
        const currentStateRow = await env.AUTH_DB.prepare(
          "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
        ).bind(claimed.internal_game_id).first();
        const currentState = String(currentStateRow?.state || "");
        if (currentState === result.stateAfter) {
          // The reconciliation already applied this transition.
        } else if (isLaterV3State(currentState, result.stateAfter)) {
          // A downstream job may have advanced the state after this job's
          // artifact was written but before its transition was observed. The
          // lifecycle must never regress a valid later state to this job's
          // earlier boundary.
        } else if (currentState === result.stateBefore) {
          await transitionV3State(env.AUTH_DB, {
            internalGameId: claimed.internal_game_id,
            from: result.stateBefore,
            to: result.stateAfter,
            now: executionNow,
            failureCode: null,
            failureMessage: null
          });
        } else {
          throw createV3Error(
            "V3_STATE_VERSION_CONFLICT",
            `V3状態が想定前提と一致しません: ${currentState || "unknown"} (expected ${result.stateBefore})`
          );
        }
      }
      const completedJob = await env.AUTH_DB.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(claimed.id)).first();
      await invokeV3Observer(onSuccess, [{ job: completedJob || { ...claimed, status: V3_JOB_STATUS.COMPLETED, completed_at: executionNow.toISOString(), updated_at: executionNow.toISOString() }, claimToken: claimed.claim_token, result, now: executionNow }], observerTimeoutMs, observerScheduler);
      if (claimed.job_type === V3_JOB_TYPE.NPB_IDENTITY_RESOLVE && result?.identityResolved) {
        const followupGame = games.find((game) => game.internalGameId === claimed.internal_game_id);
        if (followupGame) {
          followupGame.npbIdentityStatus = "resolved";
          const followupState = await env.AUTH_DB.prepare(
            "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
          ).bind(claimed.internal_game_id).first();
          const followupPlan = getV3DuePlan(
            followupGame,
            followupState?.state || V3_STATE.SCHEDULED,
            now,
            {
              v4SemiAuto: Boolean(v4SemiAuto),
              disabledStages: v4SemiAuto ? ["roster_fetch", "lineup_fetch"] : []
            }
          );
          if (followupPlan && [V3_JOB_TYPE.LINEUP_FETCH, V3_JOB_TYPE.LINEUP_FINALIZE].includes(followupPlan.jobType)) {
            await createV3Job(env.AUTH_DB, { internalGameId: claimed.internal_game_id, ...followupPlan });
          }
        }
      }
    } catch (rawError) {
      failed += 1;
      failedJobIds.push(claimed.id);
      const error = normalizeV3ExecutionError(rawError);
      try {
        const retryResult = await retryV3Job(env.AUTH_DB, {
          jobId: claimed.id,
          claimToken: claimed.claim_token,
          attemptCount: claimed.attempt_count,
          maxAttempts: claimed.max_attempts,
          now: executionNow,
          errorCode: error.code,
          errorMessage: formatV3JobFailureMessage(error),
          retryAt: error?.retryAt || new Date(executionNow.getTime() + 10 * 60 * 1000)
        });
        if (retryResult?.updated && retryResult?.status === V3_JOB_STATUS.RETRY_WAIT) retryWait += 1;
        if (retryResult?.updated && retryResult?.status === V3_JOB_STATUS.FAILED) terminalFailed += 1;
        const retryJob = await env.AUTH_DB.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(claimed.id)).first();
        await invokeV3Observer(onError, [error, { job: retryJob || claimed, claimToken: claimed.claim_token, stage: "execute", stateBefore: claimed.status }], observerTimeoutMs, observerScheduler);
      } catch (retryError) {
        // Failure handling is isolated as well. If the lifecycle update or
        // diagnostic read is unavailable, preserve the original failure and
        // continue with the next claimed job instead of freezing the run.
        retryErrors.push({
          jobId: claimed.id,
          code: retryError?.code || "V3_JOB_FAILURE_HANDLING_FAILED",
          message: String(retryError?.message || "V3ジョブ失敗処理に失敗しました。")
        });
        await invokeV3Observer(onError, [error, {
          job: claimed,
          claimToken: claimed.claim_token,
          stage: "execute",
          stateBefore: claimed.status,
          retryError: retryErrors[retryErrors.length - 1]
        }], observerTimeoutMs, observerScheduler);
      }
    }
  }
  return { processed, failed, retryWait, terminalFailed, failedJobIds, retryErrors };
}

export async function runGameAutomationV3(env, now = new Date(), { executeJob, onError = null, onSuccess = null, onPlan = null, onPhase = null, observerTimeoutMs = V3_OBSERVER_TIMEOUT_MS, observerScheduler = null, formalPlanner = planMainWorkflowJobs, auxiliaryPlanner = planAuxiliaryJobs, scheduleOptional = null, disabledJobTypes = [], v4SemiAuto = false, gameListOptions = {}, auxiliaryGameListOptions = null } = {}) {
  if (!isGameAutomationV3Enabled(env)) return { enabled: false, processed: 0, created: 0 };
  const schema = await getV3SchemaState(env.AUTH_DB);
  if (!schema.ready) return { enabled: true, schemaReady: false, errorCode: "GAME_AUTOMATION_V3_SCHEMA_UNAVAILABLE", processed: 0, created: 0 };
  const games = await listV3Games(env.AUTH_DB, now, gameListOptions);
  await invokeV3Observer(onPhase, [{
    stage: "eligible_games",
    now,
    gameCount: games.length,
    gameIds: games.map((game) => game?.internalGameId).filter(Boolean).slice(0, 100)
  }], observerTimeoutMs, observerScheduler);
  let failed = 0;

  // The formal workflow planner has priority over all state preparation and
  // optional work. Keep this checkpoint before any per-game hydration or
  // diagnostic preparation so an eligible-only stall is observable.
  const eligibleGameIds = games.map((game) => game?.internalGameId).filter(Boolean).slice(0, 100);
  await invokeV3Observer(onPhase, [{
    stage: "post_eligible_started",
    now,
    phase: "post_eligible",
    gameCount: games.length,
    eligibleGameCount: games.length,
    processingGameIds: eligibleGameIds,
    completedGameCount: 0,
    failedGameCount: 0,
    skippedGameCount: 0
  }], observerTimeoutMs, observerScheduler);
  await invokeV3Observer(onPhase, [{
    stage: "formal_plan_started",
    now,
    phase: "formal_plan",
    gameCount: games.length,
    eligibleGameCount: games.length,
    processingGameIds: eligibleGameIds
  }], observerTimeoutMs, observerScheduler);
  const formalPlanInputStartedAt = Date.now();
  await invokeV3Observer(onPhase, [{
    stage: "formal_plan_input_started",
    now,
    phase: "formal_plan_input",
    gameCount: games.length,
    eligibleGameCount: games.length,
    processingGameIds: eligibleGameIds,
    completedGameCount: 0,
    failedGameCount: 0,
    skippedGameCount: 0,
    elapsedMs: 0
  }], observerTimeoutMs, observerScheduler);
  const mainPlan = await runV3PlannerPhase(
    formalPlanner,
    env.AUTH_DB,
    games,
    now,
    "formal"
  );
  await invokeV3Observer(onPhase, [{
    stage: "formal_plan_finished",
    now,
    status: mainPlan.phaseStatus || "completed",
    plan: mainPlan,
    errorCode: mainPlan.errors[0]?.error?.code || null
  }], observerTimeoutMs, observerScheduler);
  await invokeV3Observer(onPhase, [{
    stage: "formal_plan_input_finished",
    now,
    phase: "formal_plan_input",
    status: mainPlan.phaseStatus || "completed",
    gameCount: games.length,
    eligibleGameCount: games.length,
    processingGameIds: eligibleGameIds,
    completedGameCount: Math.max(0, games.length - mainPlan.errors.length),
    failedGameCount: mainPlan.errors.length,
    skippedGameCount: 0,
    plannedCount: mainPlan.planned.length,
    errorCount: mainPlan.errors.length,
    elapsedMs: Math.max(0, Date.now() - formalPlanInputStartedAt)
  }], observerTimeoutMs, observerScheduler);
  if (mainPlan.phaseStatus === "failed" || mainPlan.errors.length) {
    await invokeV3Observer(onPhase, [{
      stage: "formal_plan_input_error",
      now,
      phase: "formal_plan_input",
      status: "failed",
      gameCount: games.length,
      eligibleGameCount: games.length,
      processingGameIds: eligibleGameIds,
      completedGameCount: Math.max(0, games.length - mainPlan.errors.length),
      failedGameCount: mainPlan.errors.length,
      skippedGameCount: 0,
      errorCount: mainPlan.errors.length,
      elapsedMs: Math.max(0, Date.now() - formalPlanInputStartedAt),
      errorCode: mainPlan.errors[0]?.error?.code || "V3_FORMAL_PLAN_INPUT_FAILED"
    }], observerTimeoutMs, observerScheduler);
  }
  if (mainPlan.phaseStatus === "failed" || mainPlan.errors.length) {
    await invokeV3Observer(onPhase, [{
      stage: "formal_plan_error",
      now,
      status: "failed",
      plan: mainPlan,
      errorCode: mainPlan.errors[0]?.error?.code || "V3_FORMAL_PLAN_FAILED"
    }], observerTimeoutMs, observerScheduler);
  }
  await invokeV3Observer(onPhase, [{
    stage: "formal_due_plan_summary",
    now,
    plan: mainPlan
  }], observerTimeoutMs, observerScheduler);

  const allPlanned = [...mainPlan.planned];
  const reportPlan = async (entries, stage) => {
    for (const entry of entries) {
      if (!onPlan) continue;
      await invokeV3Observer(onPlan, [{ ...entry, stage, now, plannerDecision: entry.plannerDecision }], observerTimeoutMs, observerScheduler);
    }
  };
  await reportPlan(mainPlan.planned, "main_plan");
  for (const entry of mainPlan.errors) {
    failed += 1;
    await invokeV3Observer(onError, [entry.error, { game: entry.game, plan: entry.plan, stage: "planner" }], observerTimeoutMs, observerScheduler);
  }

  await invokeV3Observer(onPhase, [{
    stage: "claim_phase_started",
    now,
    gameCount: games.length,
    plannedCount: allPlanned.length
  }], observerTimeoutMs, observerScheduler);
  const claimReport = await claimDueJobs(env.AUTH_DB, now, allPlanned, { disabledJobTypes }).catch(async (error) => {
    failed += 1;
    await invokeV3Observer(onError, [error, { stage: "claim" }], observerTimeoutMs, observerScheduler);
    return {
      due: [],
      claimed: [],
      errors: [{ code: error?.code || "V3_CLAIM_PHASE_FAILED", message: String(error?.message || "V3ジョブclaim phaseに失敗しました。") }]
    };
  });
  const execution = await executeClaimedJobs(env, claimReport.claimed, games, now, {
    executeJob,
    onError,
    onSuccess,
    onPlan,
    observerTimeoutMs,
    observerScheduler,
    v4SemiAuto
  }).catch(async (error) => {
    failed += 1;
    await invokeV3Observer(onError, [error, { stage: "execute" }], observerTimeoutMs, observerScheduler);
    return {
      processed: 0,
      failed: 1,
      retryWait: 0,
      terminalFailed: 0,
      failedJobIds: [],
      retryErrors: [{ code: error?.code || "V3_EXECUTION_PHASE_FAILED", message: String(error?.message || "V3ジョブexecution phaseに失敗しました。") }]
    };
  });
  await invokeV3Observer(onPhase, [{
    stage: "claim_execution_completed",
    now,
    claimReport,
    execution
  }], observerTimeoutMs, observerScheduler);
  await invokeV3Observer(onPhase, [{
    stage: "run_finished",
    now,
    criticalPath: true,
    createdJobCount: mainPlan.created,
    executedJobCount: execution.processed,
    failedJobCount: failed + execution.failed,
    retryWaitCount: execution.retryWait,
    terminalFailedJobCount: execution.terminalFailed
  }], observerTimeoutMs, observerScheduler);
  const criticalResult = {
    enabled: true,
    schemaReady: true,
    gameCount: games.length,
    gameIds: games.map((game) => game?.internalGameId).filter(Boolean),
    created: mainPlan.created,
    processed: execution.processed,
    failed: failed + execution.failed,
    execution,
    mainPlan,
    claimReport
  };
  // The formal workflow uses bounded discovery to protect the Cron critical
  // path. Auxiliary polling has a different contract: a completed probable-
  // starter job remains in the top-level game list, so a bounded list would
  // permanently starve later games. Load the unbounded auxiliary window only
  // after the critical path has finished and keep the existing optional
  // scheduling behavior.
  const auxiliaryGamesPromise = auxiliaryGameListOptions
    ? listV3Games(env.AUTH_DB, now, auxiliaryGameListOptions)
    : Promise.resolve(games);
  const optionalPromise = auxiliaryGamesPromise.then((auxiliaryGames) => runV3OptionalPhases(env, auxiliaryGames, now, {
    auxiliaryPlanner,
    onError,
    onPlan,
    onPhase,
    observerTimeoutMs,
    observerScheduler
  })).catch(async (error) => {
    await invokeV3Observer(onError, [error, { stage: "optional" }], observerTimeoutMs, observerScheduler);
    return { stateReconciliation: emptyV3ReconciliationResult(), auxiliary: emptyV3PlannerPhaseResult(error, "auxiliary") };
  });
  if (typeof scheduleOptional === "function") {
    scheduleOptional(optionalPromise);
    return { ...criticalResult, optionalScheduled: true };
  }
  const optional = await optionalPromise;
  return {
    ...criticalResult,
    statePreparation: optional.statePreparation,
    stateReconciliation: optional.stateReconciliation,
    probablePlan: optional.auxiliary.probablePlan,
    rosterPlan: optional.auxiliary.rosterPlan,
    identityPlan: optional.auxiliary.identityPlan,
    auxiliaryPlan: optional.auxiliary,
    created: criticalResult.created + optional.auxiliary.created
  };
}
