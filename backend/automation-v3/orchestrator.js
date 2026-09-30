import {
  V3_ERROR_CLASSES,
  V3_JOB_TYPE,
  V3_JOB_TYPES,
  V3_OPEN_JOB_STATUS_SQL,
  getV3JobPriority,
  isV3OpenJobStatus,
  isV3RankingRecoveryTerminalJob,
  isV3ScoreRecoveryTerminalJob,
  isV3TerminalJobStatus,
  createV3Error
} from "./constants.js";
import {
  claimV3Job,
  createV3Job,
  findV3ProbableStarterStartCheckGame,
  hasV3StartedFightersGameForProbableStarterBoundary,
  listDueV3Jobs
} from "./repository.js";
import {
  getV3DuePlan,
  getV3FormalDuePlans,
  getV3IdentityResolvePlans,
  planV3RosterJobs
} from "./planner.js";
import { planV3ProbableStarterJobs } from "./probable-starter-planner.js";
import { isV3GameEligible } from "./domain.js";
import { assessV3LineupArtifact } from "./lineup-artifacts.js";
import { isShadowLineupRevision } from "./lineup-shadow-service.js";
import { evaluateCanonicalArtifactsFromDb, hasCanonicalArtifactEvidence, revisionMatchesIdentity } from "./canonical-artifact-evaluator.js";
import { getV3CanonicalRosterSnapshot } from "./roster-repository.js";
import { buildStagePlans, buildV3PlanningState, isV3JobForStage } from "./planning-engine.js";

// Planner aggregation, planner diagnostics, and atomic claim coordination.
const V3_DUE_JOB_BATCH_SIZE = 50;
const V3_DUE_JOB_MAX_BATCHES = 4;

export function assertV3AuxiliaryJobResult(job, result, now) {
  const jobType = String(job?.job_type || "");
  if (!["roster_fetch", "lineup_fetch"].includes(jobType)) return;
  const status = String(result?.status || "").trim().toLowerCase();
  const retryableStatuses = new Set(["pending", "retry_wait", "unannounced", "not_announced", "error", "failed"]);
  if (!retryableStatuses.has(status)) return;
  const error = createV3Error(
    String(result?.failureCode || result?.reasonCode || `${jobType.toUpperCase()}_RETRYABLE`),
    String(result?.failureMessage || result?.message || `${jobType}の次回slotで再試行します。`),
    { retryable: true }
  );
  error.retryAt = result?.nextRetryAt || new Date(new Date(now).getTime() + 10 * 60 * 1000);
  throw error;
}

async function hasOpenV3Job(db, internalGameId, jobType, excludeJobId = null) {
  const row = await db.prepare(
    `SELECT id FROM game_jobs_v3
      WHERE internal_game_id = ?1 AND job_type = ?2
        AND (?3 IS NULL OR id <> ?3)
        AND status IN (${V3_OPEN_JOB_STATUS_SQL})
      LIMIT 1`
  ).bind(internalGameId, jobType, excludeJobId).first();
  return Boolean(row?.id);
}

function parseStoredLineupPayload(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readV3LineupDataHealth(db, internalGameId, workflowState = "scheduled") {
  const health = {
    available: false,
    verificationStatus: "unavailable",
    candidateExists: null,
    candidateValid: null,
    canonicalDataReady: null,
    canonicalValid: null,
    finalizedLineupExists: null,
    finalizedValid: null,
    workflowStateAtLeastLineupReady: ["lineup_ready", "scored", "ranked", "published"].includes(String(workflowState)),
    ready: null,
    artifactVerified: null,
    candidateCount: null,
    candidateValidCount: null,
    finalizedCount: null,
    finalizedValidCount: null,
    canonicalFinalized: false,
    canonicalFinalLineupRevisionId: null
  };
  try {
    const revisions = await db.prepare(
      `SELECT *
         FROM game_lineup_revisions
        WHERE internal_game_id = ?1
        ORDER BY version DESC`
    ).bind(internalGameId).all();
    const rows = revisions.results || [];
    const formalRows = rows.filter((row) => !isShadowLineupRevision(row));
    const candidates = formalRows.filter((row) => Number(row.is_final || 0) !== 1);
    const finalized = rows.filter((row) => Number(row.is_final || 0) === 1);
    const revisionChecks = formalRows.map((row) => ({ row, check: assessV3LineupArtifact(parseStoredLineupPayload(row.actual_lineup_json)) }));
    const candidateChecks = candidates.map((row) => assessV3LineupArtifact(parseStoredLineupPayload(row.actual_lineup_json)));
    const finalizedChecks = finalized.map((row) => assessV3LineupArtifact(parseStoredLineupPayload(row.actual_lineup_json)));
    const canonical = await db.prepare(
      `SELECT actual_lineup_json
         FROM game_lineups
        WHERE internal_game_id = ?1
        LIMIT 1`
    ).bind(internalGameId).first();
    // Manual finalize writes the canonical final-revision link after the
    // revision row is activated. Read that marker independently so older
    // adapters without the column remain compatible with revision-only data.
    let canonicalFinalLineupRevisionId = null;
    try {
      const canonicalMarker = await db.prepare(
        `SELECT final_lineup_revision_id
           FROM game_lineups
          WHERE internal_game_id = ?1
          LIMIT 1`
      ).bind(internalGameId).first();
      canonicalFinalLineupRevisionId = String(canonicalMarker?.final_lineup_revision_id || "").trim() || null;
    } catch {
      canonicalFinalLineupRevisionId = null;
    }
    health.available = true;
    const canonicalCheck = assessV3LineupArtifact(parseStoredLineupPayload(canonical?.actual_lineup_json));
    health.candidateExists = candidateChecks.some((check) => check.ok);
    health.candidateValid = health.candidateExists;
    health.canonicalDataReady = canonicalCheck.ok;
    health.canonicalValid = canonicalCheck.ok;
    health.canonicalFinalLineupRevisionId = canonicalFinalLineupRevisionId;
    health.canonicalFinalized = Boolean(canonicalFinalLineupRevisionId
      && canonicalCheck.ok
      && revisionChecks.some(({ row, check }) => check.ok && revisionMatchesIdentity(row, canonicalFinalLineupRevisionId)));
    health.finalizedLineupExists = finalizedChecks.some((check) => check.ok) || health.canonicalFinalized;
    health.finalizedValid = health.finalizedLineupExists;
    health.candidateCount = candidates.length;
    health.candidateValidCount = candidateChecks.filter((check) => check.ok).length;
    health.finalizedCount = finalized.length;
    health.finalizedValidCount = finalizedChecks.filter((check) => check.ok).length
      + (health.canonicalFinalized && !finalizedChecks.some((check) => check.ok) ? 1 : 0);
    health.ready = health.candidateValid || health.canonicalValid || health.finalizedValid;
    health.artifactVerified = health.ready;
    health.verificationStatus = health.ready ? "verified" : "missing_or_invalid";
  } catch {
    // Unknown/legacy schemas must not trigger a speculative recovery job.
  }
  return health;
}

async function readV3WorkflowArtifactHealth(db, internalGameId, workflowState = "scheduled") {
  const lineup = await readV3LineupDataHealth(db, internalGameId, workflowState);
  const health = {
    available: lineup.available,
    lineup,
    scoreReady: false,
    rankingReflected: false,
    rankingRevisionMismatch: false,
    rankingReprocessRequired: false,
    rankingScoringRevisionId: null,
    reflectedScoringRevisionId: null,
    publicationReady: false
  };
  try {
    const canonical = await db.prepare(
      `SELECT scoring_status, scored_at, publication_status, published_at
         FROM game_lineups WHERE internal_game_id = ?1 LIMIT 1`
    ).bind(internalGameId).first();
    health.scoreReady = String(canonical?.scoring_status || "") === "scored" && Boolean(canonical?.scored_at);
    health.publicationReady = String(canonical?.publication_status || "") === "published" && Boolean(canonical?.published_at);
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
      // Legacy adapters may not expose the revision marker. Production
      // schemas use the revision-aware path below.
    }
    let reflection = null;
    try {
      reflection = await db.prepare(
        `SELECT status, scoring_revision_id
           FROM ranking_reflection_revisions
          WHERE internal_game_id = ?1
          ORDER BY ranking_update_revision DESC, id DESC LIMIT 1`
      ).bind(internalGameId).first();
    } catch {
      reflection = await db.prepare(
        `SELECT status FROM ranking_reflection_revisions
          WHERE internal_game_id = ?1
          ORDER BY ranking_update_revision DESC, id DESC LIMIT 1`
      ).bind(internalGameId).first();
    }
    const currentScoringRevisionId = String(currentScoringRevision?.scoring_revision_id || "").trim();
    const reflectedScoringRevisionId = String(reflection?.scoring_revision_id || "").trim();
    const reflected = String(reflection?.status || "") === "reflected";
    health.rankingReflected = currentScoringRevisionAvailable
      ? Boolean(currentScoringRevisionId && reflected && reflectedScoringRevisionId === currentScoringRevisionId)
      : reflected;
    health.rankingRevisionMismatch = Boolean(
      currentScoringRevisionAvailable
      && currentScoringRevisionId
      && reflected
      && reflectedScoringRevisionId !== currentScoringRevisionId
    );
    health.rankingReprocessRequired = Boolean(
      health.scoreReady
      && currentScoringRevisionAvailable
      && currentScoringRevisionId
      && (!reflected || reflectedScoringRevisionId !== currentScoringRevisionId)
    );
    health.rankingScoringRevisionId = currentScoringRevisionId || null;
    health.reflectedScoringRevisionId = reflectedScoringRevisionId || null;
  } catch {
    // Legacy or partially migrated schemas must not trigger speculative jobs.
    health.available = false;
  }
  return health;
}

async function readV3StateForPlanning(db, internalGameId) {
  try {
    return await db.prepare(
      "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
    ).bind(internalGameId).first();
  } catch {
    return null;
  }
}

async function deriveV3PlanningState(db, gameOrId, persistedState = "scheduled", now = new Date(), { v4SemiAuto = false } = {}) {
  const game = typeof gameOrId === "string"
    ? { internalGameId: gameOrId }
    : (gameOrId || {});
  const internalGameId = game.internalGameId || game.internal_game_id;
  let jobs = [];
  try {
    const result = await db.prepare(
      "SELECT * FROM game_jobs_v3 WHERE internal_game_id = ?1 ORDER BY scheduled_slot_at, id"
    ).bind(internalGameId).all();
    jobs = result.results || [];
  } catch {
    jobs = [];
  }
  const workflowArtifacts = await readV3WorkflowArtifactHealth(db, internalGameId, persistedState);
  const rosterSnapshot = await getV3CanonicalRosterSnapshot(db, internalGameId, {
    gameDate: game.gameDate || game.game_date
  });
  let canonicalArtifacts = null;
  try {
    canonicalArtifacts = await evaluateCanonicalArtifactsFromDb(db, internalGameId);
  } catch {
    // Keep the formal planner compatible with databases where optional canonical reads are unavailable.
  }
  const artifacts = {
    roster_fetch: {
      available: Boolean(rosterSnapshot?.exists),
      valid: Boolean(rosterSnapshot?.exists && !rosterSnapshot?.isStale)
    },
    prediction_close: {
      available: jobs.some((job) => isV3JobForStage(job, "prediction_close") && String(job?.status || "").toLowerCase() === "completed"),
      valid: jobs.some((job) => isV3JobForStage(job, "prediction_close") && String(job?.status || "").toLowerCase() === "completed")
    },
    lineup_fetch: workflowArtifacts.lineup,
    lineup_finalize: {
      available: workflowArtifacts.lineup.finalizedValid,
      valid: workflowArtifacts.lineup.finalizedValid
    },
    scoring: { available: workflowArtifacts.scoreReady, valid: workflowArtifacts.scoreReady },
    ranking_reflect: {
      available: workflowArtifacts.rankingReflected,
      valid: workflowArtifacts.rankingReflected,
      revisionMismatch: workflowArtifacts.rankingRevisionMismatch === true,
      reprocessRequired: workflowArtifacts.rankingReprocessRequired === true
    },
    publish: { available: workflowArtifacts.publicationReady, valid: workflowArtifacts.publicationReady }
  };
  const planningState = buildV3PlanningState({
    game,
    persistedState,
    jobs,
    artifacts,
    canonicalArtifacts,
    now,
    v4SemiAuto
  });
  return { ...planningState, workflowArtifacts, rosterSnapshot };
}

function createV3PlanningDiagnostic(game, plan, state) {
  return {
    internalGameId: game?.internalGameId || null,
    jobType: plan?.jobType || null,
    state: state || "scheduled",
    scheduledSlotAt: plan?.scheduledSlotAt?.toISOString?.() || null,
    plannerReached: true,
    insertAttempted: false,
    insertedRowCount: 0,
    claimResult: "not_attempted",
    executorReached: false,
    persistenceResult: "not_attempted",
    reasonCode: null,
    actualJobExists: false,
    existingJobId: null,
    existingStatus: null
  };
}

export function normalizeV3PlannerDecision(entry, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const plan = entry?.plan || null;
  const diagnostic = entry?.diagnostic || {};
  const job = entry?.job || null;
  const status = String(entry?.existingStatus || job?.status || diagnostic.existingStatus || "");
  const scheduledSlotAt = plan?.scheduledSlotAt instanceof Date
    ? plan.scheduledSlotAt.toISOString()
    : plan?.scheduledSlotAt || entry?.existingScheduledSlotAt || null;
  const dueAt = new Date(plan?.scheduledAt || scheduledSlotAt || "");
  const due = !Number.isNaN(current.getTime()) && !Number.isNaN(dueAt.getTime()) && dueAt.getTime() <= current.getTime();
  const existing = job?.id ? { id: job.id, status: job.status || null, scheduledSlotAt: job.scheduled_slot_at || null } : null;
  const existingOpenJob = existing && isV3OpenJobStatus(existing.status) ? existing : null;
  const existingTerminalJob = existing && isV3TerminalJobStatus(existing.status) ? existing : null;
  const reasonCode = entry?.reasonCode || diagnostic.reasonCode || null;
  const shouldRun = Boolean(plan && ![
    "PROBABLE_STARTER_GAME_NOT_ELIGIBLE",
    "PROBABLE_STARTER_NOT_DUE",
    "V3_GAME_NOT_ELIGIBLE",
    "V3_STATE_NOT_ELIGIBLE"
  ].includes(String(reasonCode || "")));
  const canonicalDataReady = typeof diagnostic.canonicalDataReady === "boolean"
    ? diagnostic.canonicalDataReady
    : typeof diagnostic.rosterSnapshotExists === "boolean"
      ? diagnostic.rosterSnapshotExists
      : null;
  return {
    jobType: plan?.jobType || job?.job_type || null,
    shouldRun,
    reasonCode,
    scheduledSlotAt,
    due,
    existingOpenJob,
    existingTerminalJob,
    canonicalDataReady,
    candidateExists: typeof diagnostic.candidateExists === "boolean" ? diagnostic.candidateExists : null,
    finalizedLineupExists: typeof diagnostic.finalizedLineupExists === "boolean" ? diagnostic.finalizedLineupExists : null,
    lineupDataReady: typeof diagnostic.lineupDataReady === "boolean" ? diagnostic.lineupDataReady : null,
    insertAttempted: Boolean(entry?.insertAttempted ?? diagnostic.insertAttempted),
    insertedJobId: entry?.created ? entry?.job?.id || null : null
  };
}

function normalizeV3PlanEntries(result, now) {
  const planned = (result?.planned || []).map((entry) => ({
    ...entry,
    plannerDecision: normalizeV3PlannerDecision(entry, now),
    diagnostic: {
      ...(entry.diagnostic || {}),
      plannerDecision: normalizeV3PlannerDecision(entry, now)
    }
  }));
  const diagnostics = Array.isArray(result?.diagnostics)
    ? result.diagnostics.map((diagnostic) => ({ ...diagnostic }))
    : [];
  for (const entry of planned) {
    const entryDiagnostic = { ...(entry.diagnostic || {}) };
    const match = diagnostics.findIndex((diagnostic) =>
      String(diagnostic.internalGameId || "") === String(entry.game?.internalGameId || "")
      && String(diagnostic.stage || diagnostic.jobType || "") === String(entry.plan?.stage || entry.plan?.jobType || ""));
    if (match >= 0) diagnostics[match] = { ...diagnostics[match], ...entryDiagnostic };
    else diagnostics.push(entryDiagnostic);
  }
  return { ...(result || {}), planned, diagnostics };
}

function emptyV3PlanResult(error = null) {
  return { created: 0, planned: [], diagnostics: [], errors: error ? [{ game: null, plan: null, error }] : [] };
}

async function readV3JobsForPlanning(db, internalGameId) {
  try {
    const result = await db.prepare(
      `SELECT * FROM game_jobs_v3 WHERE internal_game_id = ?1 ORDER BY scheduled_slot_at, id`
    ).bind(internalGameId).all();
    return result.results || [];
  } catch {
    return [];
  }
}

function isPredictionCloseRecoveryJob(job) {
  const status = String(job?.status || "").trim().toLowerCase();
  if (status === "failed") return true;
  return status === "retry_wait"
    && Number(job?.attempt_count ?? job?.attemptCount ?? 0) >= Number(job?.max_attempts ?? job?.maxAttempts ?? 0);
}

export const V3_JOB_PLANNERS = Object.freeze({
  [V3_JOB_TYPE.PROBABLE_STARTER_FETCH]: planV3ProbableStarterJobs,
  [V3_JOB_TYPE.ROSTER_FETCH]: planV3RosterJobs,
  [V3_JOB_TYPE.NPB_IDENTITY_RESOLVE]: planV3IdentityJobs,
  [V3_JOB_TYPE.PREDICTION_CLOSE]: planV3MainJobs,
  [V3_JOB_TYPE.LINEUP_FETCH]: planV3MainJobs,
  [V3_JOB_TYPE.LINEUP_FINALIZE]: planV3MainJobs,
  [V3_JOB_TYPE.SCORE]: planV3MainJobs,
  [V3_JOB_TYPE.RANKING_REBUILD]: planV3MainJobs,
  [V3_JOB_TYPE.PUBLISH]: planV3MainJobs
});

export async function planAuxiliaryJobs(db, games = [], now = new Date(), {
  autoProbableStarter = true,
  autoRosterFetch = true,
  includeStartBoundaryLookup = true,
  probableStarterOnly = false
} = {}) {
  const run = async (name, planner) => {
    try {
      return normalizeV3PlanEntries(await planner(db, games, now), now);
    } catch (error) {
      // Auxiliary failures are isolated. The other auxiliary and main planners
      // still run in the same Cron invocation.
      return emptyV3PlanResult(error);
    }
  };
  let probableGames = Array.isArray(games) ? games : [];
  if (autoProbableStarter && includeStartBoundaryLookup) {
    try {
      // Before the first pitch there cannot be a start-boundary target. Avoid
      // the schema inspection and bounded future-game hydration in that
      // common five-minute path; the normal slot planner still evaluates the
      // games already discovered for pregame polling.
      let boundaryStarted = true;
      try {
        boundaryStarted = await hasV3StartedFightersGameForProbableStarterBoundary(db, now);
      } catch (error) {
        // Preserve the prior targeted lookup on legacy/partially migrated
        // adapters; the optimization must never hide a next-game check.
        console.warn(`[V3_PROBABLE_START_CHECK] ${JSON.stringify({
          reasonCode: "BOUNDARY_PREFLIGHT_FAILED",
          message: String(error?.message || "preflight_failed").slice(0, 160)
        })}`);
      }
      const startCheckGame = boundaryStarted
        ? await findV3ProbableStarterStartCheckGame(db, now)
        : null;
      if (startCheckGame) {
        const existing = probableGames.find((game) => String(game?.internalGameId || "") === String(startCheckGame.internalGameId || ""));
        probableGames = existing
          ? probableGames.map((game) => String(game?.internalGameId || "") === String(startCheckGame.internalGameId || "")
            ? { ...game, probableStarterStartCheckAt: startCheckGame.probableStarterStartCheckAt }
            : game)
          : [...probableGames, startCheckGame];
      }
    } catch (error) {
      // The normal bounded auxiliary list remains usable if the targeted
      // start-check query is unavailable on an older adapter.
      console.warn(`[V3_PROBABLE_START_CHECK] ${JSON.stringify({
        reasonCode: "TARGETED_LOOKUP_FAILED",
        message: String(error?.message || "lookup_failed").slice(0, 160)
      })}`);
    }
  }
  const probablePlan = autoProbableStarter
    ? await run(V3_JOB_TYPE.PROBABLE_STARTER_FETCH, (database, _ignoredGames, plannerNow) =>
      V3_JOB_PLANNERS[V3_JOB_TYPE.PROBABLE_STARTER_FETCH](database, probableGames, plannerNow))
    : { created: 0, planned: [], diagnostics: [{ stage: "probable_starter_fetch", reasonCode: "AUTO_PROBABLE_STARTER_DISABLED" }], errors: [] };
  const rosterPlan = !probableStarterOnly && autoRosterFetch
    ? await run(V3_JOB_TYPE.ROSTER_FETCH, V3_JOB_PLANNERS[V3_JOB_TYPE.ROSTER_FETCH])
    : { created: 0, planned: [], diagnostics: [{ stage: "roster_fetch", reasonCode: "V4_AUTO_ROSTER_FETCH_DISABLED" }], errors: [] };
  const identityPlan = probableStarterOnly
    ? { created: 0, planned: [], diagnostics: [{ stage: "npb_identity_resolve", reasonCode: "PROBABLE_STARTER_ONLY" }], errors: [] }
    : await run(V3_JOB_TYPE.NPB_IDENTITY_RESOLVE, V3_JOB_PLANNERS[V3_JOB_TYPE.NPB_IDENTITY_RESOLVE]);
  return {
    probablePlan,
    rosterPlan,
    identityPlan,
    planned: [...probablePlan.planned, ...rosterPlan.planned, ...identityPlan.planned],
    errors: [...probablePlan.errors, ...rosterPlan.errors, ...identityPlan.errors],
    created: probablePlan.created + rosterPlan.created + identityPlan.created
  };
}

export async function planMainWorkflowJobs(db, games = [], now = new Date(), options = {}) {
  try {
    return normalizeV3PlanEntries(await planV3MainJobs(db, games, now, options), now);
  } catch (error) {
    return emptyV3PlanResult(error);
  }
}

export async function claimDueJobs(db, now = new Date(), plannedEntries = [], { disabledJobTypes = [] } = {}) {
  // Drain the due set in a deliberately small bounded window. The query is
  // due-first and the next Cron tick continues from rows left pending or in
  // retry_wait; claimV3Job keeps the lease/token race safe. A full backlog
  // must remain visible as hasMoreDue rather than being reported as drained.
  const seen = new Set();
  const due = [];
  const claimed = [];
  const plannedById = new Map(plannedEntries.map((entry) => [String(entry?.job?.id || ""), entry]));
  const disabled = new Set(disabledJobTypes);
  const skipped = [];
  const batchSize = V3_DUE_JOB_BATCH_SIZE;
  const maxBatches = V3_DUE_JOB_MAX_BATCHES;
  let hasMoreDue = false;
  let cursor = null;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await listDueV3Jobs(db, now, batchSize, cursor);
    if (rows.length === 0) break;
    const fresh = rows.filter((job) => {
      const key = String(job?.id || "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    due.push(...fresh);
    for (const job of fresh) {
      if ([...disabled].some((stage) => isV3JobForStage(job, stage))) {
        skipped.push({ job, reasonCode: "V4_AUTO_FETCH_DISABLED" });
        continue;
      }
      let claimedJob = null;
      let claimError = null;
      try {
        claimedJob = await claimV3Job(db, { jobId: job.id, now });
      } catch (error) {
        // A single malformed or transiently unavailable row must not prevent
        // later games/stages in the same batch from being claimed.
        claimError = {
          code: error?.code || "V3_JOB_CLAIM_FAILED",
          message: String(error?.message || "V3ジョブのclaimに失敗しました。")
        };
      }
      const entry = plannedById.get(String(job.id));
      const claimResult = claimError ? "claim_error" : claimedJob ? "claimed" : "claim_conflict";
      if (entry) {
        entry.plannerDecision = {
          ...(entry.plannerDecision || normalizeV3PlannerDecision(entry, now)),
          existingOpenJob: { id: job.id, status: job.status, scheduledSlotAt: job.scheduled_slot_at },
          insertAttempted: entry.plannerDecision?.insertAttempted ?? false
        };
        entry.diagnostic = {
          ...(entry.diagnostic || {}),
          actualJobExists: true,
          jobStatus: claimedJob?.status || job.status || null,
          claimEligible: isV3OpenJobStatus(job.status),
          claimResult,
          claimErrorCode: claimError?.code || null
        };
      }
      claimed.push({ job, claimed: claimedJob, entry, claimResult, claimError });
    }
    const lastRow = rows[rows.length - 1];
    const nextCursor = {
      priority: getV3JobPriority(lastRow?.job_type),
      scheduledAt: lastRow?.scheduled_at || null,
      id: Number(lastRow?.id)
    };
    if (!nextCursor.scheduledAt || !Number.isFinite(nextCursor.id)) break;
    cursor = nextCursor;
    if (rows.length < batchSize) break;
    if (batch === maxBatches - 1) hasMoreDue = true;
  }
  return { due, claimed, skipped, hasMoreDue };
}

export async function planV3MainJobs(db, games = [], now = new Date(), { disabledStages = [], v4SemiAuto = false } = {}) {
  const planned = [];
  const errors = [];
  const diagnostics = [];
  for (const game of Array.isArray(games) ? games : []) {
    if (!isV3GameEligible(game)) continue;
    try {
      const stateRow = await readV3StateForPlanning(db, game.internalGameId);
      const persistedState = String(stateRow?.state || game.workflowState || "scheduled").trim().toLowerCase() || "scheduled";
      const derivedPlanningState = await deriveV3PlanningState(db, game, persistedState, now, { v4SemiAuto });
      const state = derivedPlanningState.effectiveState;
      const workflowArtifacts = derivedPlanningState.workflowArtifacts || await readV3WorkflowArtifactHealth(db, game.internalGameId, state);
      const canonicalAvailable = hasCanonicalArtifactEvidence(derivedPlanningState.canonicalArtifacts);
      const canonicalFullyPublished = derivedPlanningState.canonicalArtifacts?.aggregate?.fullyPublished === true;
      // A correction may advance the canonical pointer before its workflow
      // state is persisted. Reopen only the narrow candidate identified by
      // listV3Games; ordinary published artifact mismatches remain diagnostic.
      const correctionRecovery = state === "published"
        && game.correctionRecoveryCandidate === true
        && canonicalAvailable
        && derivedPlanningState.canonicalArtifacts?.aggregate?.lineupReady === true
        && derivedPlanningState.canonicalArtifacts?.aggregate?.scoringReady !== true;
      if (state === "published" && !correctionRecovery) {
        if (canonicalAvailable && !canonicalFullyPublished) {
          diagnostics.push({
            internalGameId: game.internalGameId || null,
            stage: "publish",
            jobType: V3_JOB_TYPE.PUBLISH,
            effectiveState: state,
            persistedState,
            stateMismatch: derivedPlanningState.stateMismatch,
            due: false,
            selectedSlotAt: null,
            shouldCreateJob: false,
            insertAllowed: false,
            blocked: true,
            blockedReason: "PUBLISHED_CANONICAL_ARTIFACT_MISMATCH",
            reasonCode: "PUBLISHED_CANONICAL_ARTIFACT_MISMATCH_NEEDS_ATTENTION",
            existingJobId: null,
            existingStatus: null,
            canonicalArtifacts: derivedPlanningState.canonicalArtifacts.aggregate,
            insertAttempted: false,
            insertedRowCount: 0
          });
        }
        continue;
      }
      if (workflowArtifacts.publicationReady && (!canonicalAvailable || canonicalFullyPublished)) continue;
      const existingJobs = await readV3JobsForPlanning(db, game.internalGameId);
      const sharedPlanningState = buildV3PlanningState({
        ...derivedPlanningState,
        game,
        persistedState,
        effectiveState: correctionRecovery ? "manual_action_required" : state,
        correctionRecovery,
        jobs: existingJobs,
        now,
        v4SemiAuto
      });
      const stagePlans = buildStagePlans(sharedPlanningState, undefined, {
        disabledStages,
        disabledReason: "V4_AUTO_FETCH_DISABLED"
      });
      for (const stagePlan of stagePlans) {
        diagnostics.push({
          internalGameId: game.internalGameId || null,
          stage: stagePlan.stage,
          jobType: stagePlan.jobType,
          effectiveState: sharedPlanningState.effectiveState,
          persistedState: sharedPlanningState.persistedState,
          stateMismatch: sharedPlanningState.stateMismatch,
          due: stagePlan.due,
          selectedSlotAt: stagePlan.selectedSlotAt,
          shouldCreateJob: stagePlan.shouldCreateJob,
          insertAllowed: stagePlan.insertAllowed,
          blocked: stagePlan.blocked,
          blockedReason: stagePlan.blockedReason,
          reasonCode: stagePlan.reasonCode,
          existingJobId: stagePlan.existingJob?.id || null,
          existingStatus: stagePlan.existingJob?.status || null,
          canonicalArtifacts: derivedPlanningState.canonicalArtifacts?.aggregate || null,
          insertAttempted: false,
          insertedRowCount: 0
        });
      }
      const plans = stagePlans.filter((entry) => entry.shouldCreateJob).map((entry) => ({
        jobType: entry.jobType,
        scheduledSlotAt: new Date(entry.selectedSlotAt),
        // The deterministic recovery slot is an idempotency key, not a user
        // visible due time. Leave one Cron tick for the planner to finish and
        // execute the newly allocated recovery job on the following pass.
        scheduledAt: entry.diagnostics?.recoverySlotAt
          ? new Date(new Date(now).getTime() + 1000)
          : new Date(entry.selectedSlotAt),
        sharedPlan: entry
      }));
      for (const stagePlan of stagePlans.filter((entry) => entry.reasonCode === "RECOVERY_JOB_ALREADY_EXISTS")) {
        const recoveryKind = stagePlan.stage === "scoring" ? "score" : "ranking";
        const recoveryReasonCode = recoveryKind === "score"
          ? "V3_SCORE_RECOVERY_JOB_ALREADY_EXISTS"
          : "V3_RANKING_RECOVERY_JOB_ALREADY_EXISTS";
        const recoveryPlan = {
          jobType: stagePlan.jobType,
          scheduledSlotAt: new Date(stagePlan.selectedSlotAt),
          scheduledAt: new Date(stagePlan.selectedSlotAt),
          sharedPlan: stagePlan
        };
        const diagnostic = {
          ...createV3PlanningDiagnostic(game, recoveryPlan, state),
          recoveryOfJobId: stagePlan.diagnostics?.recoveryOfJobId || null,
          recoveryJobId: stagePlan.diagnostics?.recoveryJobId || stagePlan.existingJob?.id || null,
          actualJobExists: Boolean(stagePlan.existingJob?.id),
          existingJobId: stagePlan.existingJob?.id || null,
          existingStatus: stagePlan.existingJob?.status || null,
          insertAttempted: false,
          insertedRowCount: 0,
          reasonCode: recoveryReasonCode
        };
        planned.push({
          game,
          plan: recoveryPlan,
          created: false,
          job: stagePlan.existingJob || null,
          reasonCode: recoveryReasonCode,
          recoveryOfJobId: diagnostic.recoveryOfJobId,
          insertedRowCount: 0,
          existingJobId: diagnostic.existingJobId,
          existingScheduledSlotAt: stagePlan.existingJob?.scheduled_slot_at || null,
          existingStatus: diagnostic.existingStatus,
          diagnostic
        });
        diagnostics.push(diagnostic);
      }
      for (const plan of plans) {
        const artifactReady = plan.jobType === V3_JOB_TYPE.LINEUP_FETCH
          ? workflowArtifacts.available && workflowArtifacts.lineup.ready === true
          : plan.jobType === V3_JOB_TYPE.LINEUP_FINALIZE
            ? workflowArtifacts.available && workflowArtifacts.lineup.finalizedValid === true
            : plan.jobType === V3_JOB_TYPE.SCORE
              ? workflowArtifacts.scoreReady
              : plan.jobType === V3_JOB_TYPE.RANKING_REBUILD
                ? workflowArtifacts.rankingReflected
                : false;
        const downstreamArtifactReady = plan.jobType === V3_JOB_TYPE.PREDICTION_CLOSE
          && workflowArtifacts.available
          && (workflowArtifacts.scoreReady
            || workflowArtifacts.rankingReflected
            || workflowArtifacts.publicationReady);
        if (artifactReady || downstreamArtifactReady) continue;
        let effectivePlan = plan;
        let recoveryOfJobId = null;
        let recoveryKind = null;
        let diagnostic = createV3PlanningDiagnostic(game, effectivePlan, state);
        let result = await createV3Job(db, { internalGameId: game.internalGameId, ...effectivePlan });
        const recoveryJobType = plan.jobType === V3_JOB_TYPE.SCORE
          ? "score"
          : plan.jobType === V3_JOB_TYPE.RANKING_REBUILD
            ? "ranking"
            : null;
        const artifactRecoveryType = [V3_JOB_TYPE.LINEUP_FINALIZE, V3_JOB_TYPE.PUBLISH].includes(plan.jobType)
          ? plan.jobType
          : null;
        const predictionCloseRecovery = plan.jobType === V3_JOB_TYPE.PREDICTION_CLOSE
          && !result.created
          && isPredictionCloseRecoveryJob(result.job);
        const isTerminalRecovery = recoveryJobType
          && !result.created
          && (recoveryJobType === "score"
            ? isV3ScoreRecoveryTerminalJob(result.job)
            : isV3RankingRecoveryTerminalJob(result.job));
        if (predictionCloseRecovery) {
          const openRecovery = await hasOpenV3Job(db, game.internalGameId, V3_JOB_TYPE.PREDICTION_CLOSE, result.job?.id || null);
          recoveryOfJobId = result.job?.id || null;
          recoveryKind = "prediction_close";
          if (!openRecovery) {
            const recoverySlot = new Date(new Date(now).getTime() + 1000);
            effectivePlan = { ...plan, scheduledSlotAt: recoverySlot, scheduledAt: new Date(now) };
            diagnostic = createV3PlanningDiagnostic(game, effectivePlan, state);
            result = await createV3Job(db, { internalGameId: game.internalGameId, ...effectivePlan });
            diagnostic.recoveryOfJobId = recoveryOfJobId;
            diagnostic.recoveryScheduledSlotAt = recoverySlot.toISOString();
          } else {
            diagnostic.reasonCode = "V3_PREDICTION_CLOSE_RECOVERY_JOB_ALREADY_EXISTS";
            diagnostic.recoveryOfJobId = recoveryOfJobId;
          }
        } else if (isTerminalRecovery) {
          const originalSlot = new Date(plan.scheduledSlotAt);
          const recoverySlot = new Date(originalSlot.getTime() + 1000);
          effectivePlan = { ...plan, scheduledSlotAt: recoverySlot, scheduledAt: recoverySlot };
          recoveryOfJobId = result.job?.id || null;
          diagnostic = createV3PlanningDiagnostic(game, effectivePlan, state);
          result = await createV3Job(db, { internalGameId: game.internalGameId, ...effectivePlan });
          diagnostic.recoveryOfJobId = recoveryOfJobId;
          diagnostic.recoveryScheduledSlotAt = recoverySlot.toISOString();
          recoveryKind = recoveryJobType;
        } else if (artifactRecoveryType && !result.created && isV3TerminalJobStatus(result.job?.status)) {
          const health = await readV3WorkflowArtifactHealth(db, game.internalGameId, state);
          const missingArtifact = artifactRecoveryType === V3_JOB_TYPE.LINEUP_FINALIZE
            ? health.available
              && (health.lineup.finalizedValid === false || health.lineup.finalizedLineupExists === false)
              && (health.lineup.candidateValid === true || health.lineup.candidateExists === true)
            : health.available && health.publicationReady === false && health.rankingReflected === true;
          Object.assign(diagnostic, {
            ...health,
            completedWithoutArtifact: missingArtifact,
            recoveryReason: missingArtifact ? `${artifactRecoveryType.toUpperCase()}_COMPLETED_WITHOUT_ARTIFACT` : null
          });
          if (missingArtifact) {
            const openRecovery = await hasOpenV3Job(db, game.internalGameId, artifactRecoveryType);
            recoveryOfJobId = result.job?.id || null;
            recoveryKind = artifactRecoveryType;
            if (!openRecovery) {
              const originalSlot = new Date(plan.scheduledSlotAt);
              const recoveryTimestamp = Math.max(originalSlot.getTime(), new Date(now).getTime()) + 1000;
              const recoverySlot = new Date(recoveryTimestamp);
              effectivePlan = { ...plan, scheduledSlotAt: recoverySlot, scheduledAt: recoverySlot };
              diagnostic = {
                ...createV3PlanningDiagnostic(game, effectivePlan, state),
                ...health,
                completedWithoutArtifact: true,
                recoveryReason: `${artifactRecoveryType.toUpperCase()}_COMPLETED_WITHOUT_ARTIFACT`
              };
              result = await createV3Job(db, { internalGameId: game.internalGameId, ...effectivePlan });
              diagnostic.recoveryOfJobId = recoveryOfJobId;
              diagnostic.recoveryScheduledSlotAt = recoverySlot.toISOString();
            }
          }
        } else if (plan.jobType === V3_JOB_TYPE.LINEUP_FETCH
          && !result.created
          && isV3TerminalJobStatus(result.job?.status)) {
          const health = await readV3LineupDataHealth(db, game.internalGameId, state);
          Object.assign(diagnostic, {
            ...health,
            lineupDataReady: health.ready,
            completedWithoutCandidate: health.available && !health.ready
          });
          if (health.available && !health.ready) {
            const openRecovery = await hasOpenV3Job(db, game.internalGameId, V3_JOB_TYPE.LINEUP_FETCH);
            recoveryOfJobId = result.job?.id || null;
            recoveryKind = "lineup";
            if (!openRecovery) {
              const originalSlot = new Date(plan.scheduledSlotAt);
              const requestedAt = new Date(now);
              const recoveryTimestamp = Math.max(originalSlot.getTime(), requestedAt.getTime()) + 1000;
              const recoverySlot = new Date(recoveryTimestamp);
              effectivePlan = { ...plan, scheduledSlotAt: recoverySlot, scheduledAt: recoverySlot };
              diagnostic = {
                ...createV3PlanningDiagnostic(game, effectivePlan, state),
                ...health,
                lineupDataReady: health.ready,
                completedWithoutCandidate: true
              };
              result = await createV3Job(db, { internalGameId: game.internalGameId, ...effectivePlan });
              diagnostic.recoveryOfJobId = recoveryOfJobId;
              diagnostic.recoveryScheduledSlotAt = recoverySlot.toISOString();
            } else {
              diagnostic.reasonCode = "V3_LINEUP_RECOVERY_JOB_ALREADY_EXISTS";
              diagnostic.recoveryOfJobId = recoveryOfJobId;
            }
          }
        }
        diagnostic.insertAttempted = true;
        diagnostic.insertedRowCount = result.created ? 1 : 0;
        diagnostic.actualJobExists = Boolean(result.job?.id);
        diagnostic.existingJobId = result.created ? null : result.job?.id || null;
        diagnostic.existingStatus = result.created ? "pending" : result.job?.status || null;
        diagnostic.reasonCode = recoveryKind === "lineup"
          ? (result.created ? "V3_LINEUP_RECOVERY_JOB_CREATED" : diagnostic.reasonCode || "V3_LINEUP_RECOVERY_JOB_ALREADY_EXISTS")
          : recoveryOfJobId
          ? ({
              prediction_close: result.created ? "V3_PREDICTION_CLOSE_RECOVERY_JOB_CREATED" : "V3_PREDICTION_CLOSE_RECOVERY_JOB_ALREADY_EXISTS",
              score: result.created ? "V3_SCORE_RECOVERY_JOB_CREATED" : "V3_SCORE_RECOVERY_JOB_ALREADY_EXISTS",
              ranking: result.created ? "V3_RANKING_RECOVERY_JOB_CREATED" : "V3_RANKING_RECOVERY_JOB_ALREADY_EXISTS",
              lineup_finalize: result.created ? "V3_LINEUP_FINALIZE_RECOVERY_JOB_CREATED" : "V3_LINEUP_FINALIZE_RECOVERY_JOB_ALREADY_EXISTS",
              publish: result.created ? "V3_PUBLISH_RECOVERY_JOB_CREATED" : "V3_PUBLISH_RECOVERY_JOB_ALREADY_EXISTS"
            }[recoveryKind] || (result.created ? "V3_RECOVERY_JOB_CREATED" : "V3_RECOVERY_JOB_ALREADY_EXISTS"))
          : (result.created ? "V3_JOB_CREATED" : "V3_JOB_ALREADY_EXISTS");
        const entry = {
          game,
          plan: effectivePlan,
          ...result,
          reasonCode: diagnostic.reasonCode,
          insertedRowCount: diagnostic.insertedRowCount,
          existingJobId: diagnostic.existingJobId,
          existingScheduledSlotAt: result.created ? null : result.job?.scheduled_slot_at || null,
          existingStatus: diagnostic.existingStatus,
          recoveryOfJobId,
          diagnostic
        };
        planned.push(entry);
        diagnostics.push({ ...diagnostic });
      }
    } catch (error) {
      errors.push({ game, plan: null, error });
    }
  }
  return {
    created: planned.filter((entry) => entry.created).length,
    planned,
    errors,
    diagnostics
  };
}

export async function planV3IdentityJobs(db, games = [], now = new Date()) {
  const planned = [];
  const errors = [];
  const diagnostics = [];
  for (const game of Array.isArray(games) ? games : []) {
    try {
      const stateRow = await readV3StateForPlanning(db, game.internalGameId);
      const state = String(stateRow?.state || game.workflowState || "scheduled");
      const plans = getV3IdentityResolvePlans(game, now, state);
      const plan = plans[plans.length - 1] || null;
      if (!plan) continue;
      const diagnostic = createV3PlanningDiagnostic(game, plan, state);
      const result = await createV3Job(db, { internalGameId: game.internalGameId, ...plan });
      diagnostic.insertAttempted = true;
      diagnostic.insertedRowCount = result.created ? 1 : 0;
      diagnostic.actualJobExists = Boolean(result.job?.id);
      diagnostic.existingJobId = result.created ? null : result.job?.id || null;
      diagnostic.existingStatus = result.created ? "pending" : result.job?.status || null;
      diagnostic.reasonCode = result.created ? "V3_JOB_CREATED" : "V3_JOB_ALREADY_EXISTS";
      const entry = { game, plan, ...result, reasonCode: diagnostic.reasonCode, insertedRowCount: diagnostic.insertedRowCount, existingJobId: diagnostic.existingJobId, existingStatus: diagnostic.existingStatus, diagnostic };
      planned.push(entry);
      diagnostics.push({ ...diagnostic });
    } catch (error) {
      errors.push({ game, plan: null, error });
    }
  }
  return { created: planned.filter((entry) => entry.created).length, planned, errors, diagnostics };
}
