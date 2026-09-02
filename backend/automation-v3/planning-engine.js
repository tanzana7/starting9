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
const STATE_ORDER = Object.freeze([
  "scheduled",
  "probable_starter_ready",
  "roster_ready",
  "prediction_closed",
  "lineup_ready",
  "scored",
  "ranked",
  "published"
]);
const LATE_LINEUP_FETCH_MAX_MS = 24 * 60 * 60 * 1000;

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function stateRank(value) {
  const index = STATE_ORDER.indexOf(normalize(value));
  return index < 0 ? 0 : index;
}

function isPublishedGame(game = {}) {
  return normalize(first(game, "workflowState", "workflow_state", "state")) === "published"
    || normalize(first(game, "publicationStatus", "publication_status")) === "published"
    || Boolean(first(game, "publishedAt", "published_at"))
    || first(game, "isPublished", "is_published") === true;
}

function first(object, ...keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function normalizedJobTypeTokens(value) {
  return normalize(value).split(/[:/]/).map((token) => token.trim()).filter(Boolean);
}

const STAGE_ALIASES = Object.freeze({
  probable_starter: "probable_starter",
  probable_starter_fetch: "probable_starter",
  roster_fetch: "roster_fetch",
  prediction_close: "prediction_close",
  lineup_fetch: "lineup_fetch",
  lineup_finalize: "lineup_finalize",
  scoring: "scoring",
  score: "scoring",
  ranking_reflect: "ranking_reflect",
  ranking_rebuild: "ranking_reflect",
  ranking: "ranking_reflect",
  publish: "publish"
});

function canonicalStageToken(value) {
  return STAGE_ALIASES[normalize(value)] || null;
}

function canonicalStagesFromValue(value) {
  return new Set(normalizedJobTypeTokens(value)
    .map(canonicalStageToken)
    .filter(Boolean));
}

function mergeConsistentStageSets(fieldSets) {
  const knownSets = fieldSets.filter((stages) => stages.size > 0);
  if (!knownSets.length) return new Set();
  const intersection = new Set(knownSets[0]);
  for (const stages of knownSets.slice(1)) {
    for (const stage of intersection) {
      if (!stages.has(stage)) intersection.delete(stage);
    }
  }
  return intersection;
}

// Job projections can expose both a canonical job_type and a display stage.
// Require all known fields to agree instead of accepting a match from any one
// field, because a contradictory projection must never suppress another stage.
export function isV3JobForStage(job, stageOrJobType) {
  const expected = canonicalStageToken(stageOrJobType);
  if (!expected || !job || typeof job !== "object") return false;
  const values = ["job_type", "jobType", "stage", "stageName", "type"]
    .map((key) => job[key])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  const consistentStages = mergeConsistentStageSets(values.map(canonicalStagesFromValue));
  return consistentStages.has(expected);
}

export function getLateLineupFetchDecision({ game = {}, effectiveState = null, now = new Date(), finalLineupAt = null } = {}) {
  const current = asDate(now);
  const finalAt = asDate(finalLineupAt);
  if (!current || !finalAt || current < finalAt) {
    return { late: false, allowed: false, reasonCode: null, deadline: null };
  }
  if (isPublishedGame(game)) {
    return { late: true, allowed: false, reasonCode: "ALREADY_PUBLISHED", deadline: null };
  }
  if (stateRank(effectiveState || first(game, "workflowState", "workflow_state", "state")) < stateRank("prediction_closed")) {
    return { late: true, allowed: false, reasonCode: "PREDICTION_CLOSE_STATE_GATE", deadline: null };
  }
  const startAt = asDate(first(game, "startAt", "start_at", "gameStartAt", "game_start_at"));
  if (!startAt) {
    return { late: true, allowed: false, reasonCode: "LINEUP_FETCH_LATE_WINDOW_UNAVAILABLE", deadline: null };
  }
  const deadline = new Date(startAt.getTime() + LATE_LINEUP_FETCH_MAX_MS);
  if (current > deadline) {
    return { late: true, allowed: false, reasonCode: "LINEUP_FETCH_LATE_WINDOW_EXPIRED", deadline: deadline.toISOString() };
  }
  return { late: true, allowed: true, reasonCode: "LATE_LINEUP_FETCH_REQUIRED", deadline: deadline.toISOString() };
}

function jobBelongsToGame(job, gameId) {
  if (!gameId) return false;
  const id = first(job, "internalGameId", "internal_game_id");
  return Boolean(id) && String(id) === String(gameId);
}

function artifactReady(value) {
  return Boolean(value && (value.valid === true || value.ready === true
    || (value.available === true && value.verificationStatus === "verified")));
}

function stageJobs(jobs, stage, gameId) {
  const jobType = JOB_TYPE_BY_STAGE[stage];
  return (Array.isArray(jobs) ? jobs : []).filter((job) => {
    return jobBelongsToGame(job, gameId)
      && isV3JobForStage(job, stage || jobType);
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
  const persisted = normalize(input.persistedState || input.workflowState || "scheduled") || "scheduled";
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];
  const gameId = first(input.game, "internalGameId", "internal_game_id") || input.gameId;
  const scopedJobs = jobs.filter((job) => jobBelongsToGame(job, gameId));
  const artifacts = input.artifacts || {};
  const completed = (stage, ...jobTypes) => scopedJobs.some((job) => isV3JobForStage(job, jobTypes[0] || stage)
    && normalize(first(job, "status", "jobStatus")) === "completed");
  const artifactFor = (stage, jobType) => artifactReady(artifacts[stage] || artifacts[jobType]);
  const rank = stateRank;
  const protectedStates = new Set(["excluded", "failed", "manual_action_required"]);
  if (protectedStates.has(explicit)) return explicit;
  if (protectedStates.has(persisted)) return persisted;
  let state = rank(explicit) >= rank(persisted) ? explicit : persisted;
  const probableReady = completed("probable_starter_fetch", "probable_starter_fetch")
    || artifactFor("probable_starter", "probable_starter_fetch");
  const rosterReady = completed("roster_fetch") || artifactFor("roster_fetch");
  const predictionClosed = completed("prediction_close", "prediction_close")
    || artifactFor("prediction_close", "prediction_close");
  const lineupReady = artifactFor("lineup_finalize", "lineup_finalize");
  const scored = artifactFor("scoring", "score");
  const ranked = artifactFor("ranking_reflect", "ranking_rebuild");
  const published = artifactFor("publish", "publish");

  if (probableReady && rank("probable_starter_ready") > rank(state)) state = "probable_starter_ready";
  if (rosterReady && rank("roster_ready") > rank(state)) state = "roster_ready";
  // A finalized lineup is not enough to skip the prediction-close boundary.
  // Manual V4 input may arrive before the deadline, so downstream state can
  // advance only after persisted state or a completed close artifact proves
  // that the prediction phase has ended.
  if (predictionClosed && rank("prediction_closed") > rank(state)) state = "prediction_closed";
  if (lineupReady && rank(state) >= rank("prediction_closed") && rank("lineup_ready") > rank(state)) state = "lineup_ready";
  if (scored && rank(state) >= rank("lineup_ready") && rank("scored") > rank(state)) state = "scored";
  if (ranked && rank(state) >= rank("scored") && rank("ranked") > rank(state)) state = "ranked";
  if (published && rank(state) >= rank("ranked") && rank("published") > rank(state)) state = "published";
  return state || "scheduled";
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
  const state = effectiveStateOf({ game, effectiveState, persistedState: persistedState || game.workflowState || game.workflow_state, jobs: planningJobs, artifacts });
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

export function buildStagePlan(planningState, stage, { disabled = false, disabledReason = "AUTO_FETCH_DISABLED" } = {}) {
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
    disabled: false,
    blockedReason: null,
    reasonCode: null,
    diagnostics: { effectiveState, persistedState: state.persistedState, stateMismatch: state.stateMismatch }
  };
  if (disabled) {
    return {
      ...plan,
      disabled: true,
      reasonCode: disabledReason,
      diagnostics: { ...plan.diagnostics, disabled: true, disabledReason }
    };
  }
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
  if (plan.artifactReady) return { ...plan, reasonCode: "ARTIFACT_READY" };
  const lateLineupFetch = stage === "lineup_fetch"
    ? getLateLineupFetchDecision({ game, effectiveState, now, finalLineupAt: schedule.finalLineupAt })
    : null;
  if (lateLineupFetch?.late && !lateLineupFetch.allowed) {
    if (OPEN_STATUSES.has(status)) return { ...plan, reasonCode: "OPEN_JOB_EXISTS" };
    return {
      ...plan,
      blocked: true,
      blockedReason: lateLineupFetch.reasonCode,
      reasonCode: lateLineupFetch.reasonCode,
      diagnostics: { ...plan.diagnostics, lateWindowDeadline: lateLineupFetch.deadline }
    };
  }
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
  const lineupFetchHasCandidate = Boolean(artifacts.lineup_fetch && (
    artifacts.lineup_fetch.candidateValid === true
    || artifacts.lineup_fetch.candidateExists === true
    || artifacts.lineup_fetch.canonicalDataReady === true
    || artifacts.lineup_fetch.canonicalValid === true
  ));
  if (stage === "lineup_finalize" && !lineupFetchHasCandidate) {
    return { ...plan, blocked: true, blockedReason: "LINEUP_FETCH_ARTIFACT_MISSING", reasonCode: "LINEUP_FETCH_ARTIFACT_MISSING" };
  }
  if (stage === "ranking_reflect" && now < (asDate(schedule.publicationAt) || new Date(0))) return { ...plan, reasonCode: "PUBLICATION_NOT_DUE" };
  if (lateLineupFetch?.allowed) {
    return {
      ...plan,
      shouldCreateJob: true,
      insertAllowed: true,
      reasonCode: "LATE_LINEUP_FETCH_REQUIRED",
      diagnostics: { ...plan.diagnostics, lateWindowDeadline: lateLineupFetch.deadline }
    };
  }
  return { ...plan, shouldCreateJob: true, insertAllowed: true, reasonCode: "DUE_JOB_MISSING" };
}

export function buildStagePlans(planningState, stages = STAGES, { disabledStages = [], disabledReason = "AUTO_FETCH_DISABLED" } = {}) {
  const disabled = new Set(disabledStages);
  return stages.map((stage) => buildStagePlan(planningState, stage, {
    disabled: disabled.has(stage),
    disabledReason
  }));
}

export { JOB_TYPE_BY_STAGE, STAGES };
