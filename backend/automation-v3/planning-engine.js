// Shared, side-effect-free V3 planning decisions.
// Consumers may persist the returned plans, but this module never writes state.
import { deriveV3DisplaySchedule, deriveV3Schedule, isV3GameEligible } from "./domain.js";

const JOB_TYPE_BY_STAGE = Object.freeze({
  roster_fetch: "roster_fetch",
  prediction_close: "prediction_close",
  lineup_fetch: "lineup_fetch",
  lineup_finalize: "lineup_finalize",
  scoring: "score",
  ranking_reflect: "ranking_rebuild",
  publish: "publish"
});

const OPEN_STATUSES = new Set(["pending", "claimed", "retry_wait"]);
const STAGES = Object.freeze(Object.keys(JOB_TYPE_BY_STAGE));

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function first(object, ...keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function artifactReady(value) {
  return Boolean(value && (value.valid === true || value.ready === true
    || (value.available === true && value.verificationStatus === "verified")));
}

function stageJobs(jobs, stage, gameId) {
  const jobType = JOB_TYPE_BY_STAGE[stage];
  return (Array.isArray(jobs) ? jobs : []).filter((job) => {
    const id = first(job, "internalGameId", "internal_game_id");
    const type = normalize(first(job, "jobType", "job_type", "stage", "stageName"));
    return (!gameId || String(id) === String(gameId))
      && (type === stage || type === normalize(jobType));
  });
}

function latestJob(jobs, stage, gameId, slot) {
  const selected = stageJobs(jobs, stage, gameId);
  if (!selected.length) return null;
  const wanted = asDate(slot)?.getTime();
  return selected.find((job) => wanted && asDate(first(job, "scheduledSlotAt", "scheduled_slot_at"))?.getTime() === wanted)
    || selected.sort((a, b) => (asDate(first(b, "scheduledSlotAt", "scheduled_slot_at"))?.getTime() || 0)
      - (asDate(first(a, "scheduledSlotAt", "scheduled_slot_at"))?.getTime() || 0))[0];
}

function effectiveStateOf(input) {
  const explicit = normalize(input.effectiveState || "");
  if (explicit) return explicit;
  const persisted = normalize(input.persistedState || input.workflowState || "scheduled") || "scheduled";
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const completed = (type) => jobs.some((job) => normalize(first(job, "jobType", "job_type")) === type
    && normalize(first(job, "status", "jobStatus")) === "completed");
  if (completed("publish")) return "published";
  if (completed("ranking_rebuild")) return "ranked";
  if (completed("score")) return "scored";
  if (completed("lineup_finalize")) return "lineup_ready";
  if (completed("prediction_close")) return "prediction_closed";
  if (persisted === "scheduled" && completed("probable_starter_fetch")) return "probable_starter_ready";
  return persisted;
}

function dueAtFor(schedule, stage) {
  const value = schedule?.stages?.[stage]?.dueAt;
  return asDate(value);
}

function dueSlotsFor(schedule, stage) {
  return (schedule?.stages?.[stage]?.slots || []).map(asDate).filter(Boolean);
}

function stateAllows(state, stage) {
  const order = ["scheduled", "probable_starter_ready", "roster_ready", "prediction_closed", "lineup_ready", "scored", "ranked", "published"];
  const index = order.indexOf(state);
  if (stage === "roster_fetch") return index >= order.indexOf("probable_starter_ready") && index < order.indexOf("prediction_closed");
  if (stage === "prediction_close") return index >= 0 && index < order.indexOf("prediction_closed");
  if (["lineup_fetch", "lineup_finalize"].includes(stage)) return index >= order.indexOf("prediction_closed") && index < order.indexOf("lineup_ready");
  if (stage === "scoring") return index >= order.indexOf("lineup_ready") && index < order.indexOf("scored");
  if (stage === "ranking_reflect") return index >= order.indexOf("scored") && index < order.indexOf("ranked");
  if (stage === "publish") return index >= order.indexOf("ranked") && index < order.indexOf("published");
  return false;
}

export function buildV3PlanningState({ game = {}, artifacts = {}, jobs = [], effectiveState = null, persistedState = null, now = new Date() } = {}) {
  let baseSchedule = null;
  let displaySchedule = null;
  try {
    baseSchedule = deriveV3Schedule(game);
    displaySchedule = deriveV3DisplaySchedule(game);
  } catch {
    baseSchedule = {};
    displaySchedule = { rosterFetchSlots: [], predictionDeadline: null, lineupPollingStart: null, lineupPollingSlots: [], finalLineupAt: null, scoringEarliestAt: null, publicationAt: null };
  }
  const schedule = {
    ...baseSchedule,
    stages: {
      roster_fetch: { dueAt: displaySchedule.rosterFetchSlots[0] || null, slots: displaySchedule.rosterFetchSlots },
      prediction_close: { dueAt: displaySchedule.predictionDeadline },
      lineup_fetch: { dueAt: displaySchedule.lineupPollingStart, slots: displaySchedule.lineupPollingSlots },
      lineup_finalize: { dueAt: displaySchedule.finalLineupAt },
      scoring: { dueAt: displaySchedule.scoringEarliestAt },
      ranking_reflect: { dueAt: displaySchedule.publicationAt },
      publish: { dueAt: displaySchedule.publicationAt }
    }
  };
  const planningJobs = Array.isArray(jobs) ? jobs : [];
  const state = effectiveStateOf({ game, effectiveState, persistedState: persistedState || game.workflowState || game.workflow_state, jobs: planningJobs });
  const gameId = first(game, "internalGameId", "internal_game_id");
  return {
    game,
    gameId,
    artifacts: artifacts || {},
    jobs: planningJobs,
    effectiveState: state,
    persistedState: normalize(persistedState || game.workflowState || game.workflow_state || "scheduled") || "scheduled",
    stateMismatch: state !== normalize(persistedState || game.workflowState || game.workflow_state || "scheduled"),
    schedule,
    now: asDate(now) || new Date(),
    identityResolved: Boolean(first(game, "npbGameCode", "npb_game_code")
      && ["resolved", "manually_overridden"].includes(normalize(first(game, "npbIdentityStatus", "npb_identity_status"))))
  };
}

export function buildStagePlan(planningState, stage) {
  const state = planningState || buildV3PlanningState();
  const { game, gameId, artifacts, jobs, effectiveState, schedule, now, identityResolved } = state;
  const dueAt = dueAtFor(schedule, stage);
  const dueSlots = dueSlotsFor(schedule, stage);
  const selectedSlotAt = ["roster_fetch", "lineup_fetch"].includes(stage)
    ? dueSlots.filter((slot) => now >= slot).at(-1) || dueSlots[0] || dueAt
    : dueAt;
  const job = latestJob(jobs, stage, gameId, selectedSlotAt);
  const status = normalize(first(job, "status", "jobStatus"));
  const artifact = artifacts[stage] || artifacts[JOB_TYPE_BY_STAGE[stage]];
  const due = Boolean(selectedSlotAt && now >= selectedSlotAt);
  const plan = {
    stage,
    jobType: JOB_TYPE_BY_STAGE[stage],
    due,
    dueAt: dueAt?.toISOString() || null,
    selectedSlotAt: selectedSlotAt?.toISOString() || null,
    existingJob: job || null,
    artifactReady: artifactReady(artifact),
    shouldCreateJob: false,
    insertAllowed: false,
    blocked: false,
    blockedReason: null,
    reasonCode: null,
    diagnostics: { effectiveState, persistedState: state.persistedState, stateMismatch: state.stateMismatch }
  };
  if (!isV3GameEligible(game)) return { ...plan, blocked: true, blockedReason: "GAME_NOT_ELIGIBLE", reasonCode: "GAME_NOT_ELIGIBLE" };
  if (effectiveState === "published" || state.persistedState === "published") return { ...plan, reasonCode: "ALREADY_PUBLISHED" };
  if (["ranking_reflect", "publish"].includes(stage) && (game.rankingExcluded || game.ranking_excluded)) {
    return { ...plan, blocked: true, blockedReason: "RANKING_EXCLUDED", reasonCode: "RANKING_EXCLUDED" };
  }
  if (!due) return { ...plan, reasonCode: "NOT_DUE" };
  if (!stateAllows(effectiveState, stage)) {
    const blockedReason = ["lineup_fetch", "lineup_finalize"].includes(stage) && effectiveState !== "prediction_closed"
      ? "PREDICTION_CLOSE_STATE_GATE"
      : `${stage.toUpperCase()}_STATE_GATE`;
    return { ...plan, blocked: true, blockedReason, reasonCode: blockedReason };
  }
  if (stage === "lineup_fetch" && now >= (asDate(schedule.finalLineupAt) || new Date(0))) {
    return { ...plan, blocked: true, blockedReason: "LINEUP_FETCH_WINDOW_CLOSED_NO_FINALIZE", reasonCode: "LINEUP_FETCH_WINDOW_CLOSED" };
  }
  if (plan.artifactReady) return { ...plan, reasonCode: "ARTIFACT_READY" };
  if (status === "completed") {
    if (["lineup_fetch", "lineup_finalize", "publish"].includes(stage)) {
      return { ...plan, shouldCreateJob: true, insertAllowed: true, reasonCode: "COMPLETED_ARTIFACT_MISSING" };
    }
    return { ...plan, reasonCode: "COMPLETED_JOB_EXISTS" };
  }
  if (OPEN_STATUSES.has(status)) return { ...plan, reasonCode: "OPEN_JOB_EXISTS" };
  if (["lineup_fetch", "lineup_finalize"].includes(stage) && !identityResolved) {
    return { ...plan, blocked: true, blockedReason: "NPB_IDENTITY_UNRESOLVED", reasonCode: "NPB_IDENTITY_UNRESOLVED" };
  }
  if (stage === "lineup_finalize" && artifacts.lineup_fetch?.available === true
    && !(artifacts.lineup_fetch?.candidateValid || artifacts.lineup_fetch?.candidateExists || artifact?.candidateValid || artifact?.candidateExists)) {
    return { ...plan, blocked: true, blockedReason: "LINEUP_FETCH_ARTIFACT_MISSING", reasonCode: "LINEUP_FETCH_ARTIFACT_MISSING" };
  }
  if (stage === "ranking_reflect" && now < (asDate(schedule.publicationAt) || new Date(0))) return { ...plan, reasonCode: "PUBLICATION_NOT_DUE" };
  return { ...plan, shouldCreateJob: true, insertAllowed: true, reasonCode: "DUE_JOB_MISSING" };
}

export function buildStagePlans(planningState, stages = STAGES) {
  return stages.map((stage) => buildStagePlan(planningState, stage));
}

export { JOB_TYPE_BY_STAGE, STAGES };
