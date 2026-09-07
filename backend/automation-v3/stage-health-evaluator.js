// V3.5 Phase 1: derive-only stage health evaluation.
// This module intentionally has no database, fetch, Worker, or side-effect dependency.
import { V3_STATE } from "./constants.js";

export const V35_STAGE_HEALTH = Object.freeze({
  NOT_DUE: "NOT_DUE",
  DUE: "DUE",
  OPEN_JOB_EXISTS: "OPEN_JOB_EXISTS",
  COMPLETED_ARTIFACT_READY: "COMPLETED_ARTIFACT_READY",
  COMPLETED_ARTIFACT_MISSING: "COMPLETED_ARTIFACT_MISSING",
  MISSING_JOB: "MISSING_JOB",
  RETRY_WAIT_DUE: "RETRY_WAIT_DUE",
  RETRY_WAIT_NOT_DUE: "RETRY_WAIT_NOT_DUE",
  TERMINAL_FAILED: "TERMINAL_FAILED",
  TERMINAL_CANCELLED: "TERMINAL_CANCELLED",
  BLOCKED_BY_PREREQUISITE: "BLOCKED_BY_PREREQUISITE",
  BLOCKED_BY_CANCELLED: "BLOCKED_BY_CANCELLED",
  BLOCKED_BY_EXTERNAL_FETCH_DISABLED: "BLOCKED_BY_EXTERNAL_FETCH_DISABLED",
  BLOCKED_BY_MANUAL_ATTENTION: "BLOCKED_BY_MANUAL_ATTENTION",
  MANUAL_MODE: "MANUAL_MODE",
  RECOVERY_RECOMMENDED: "RECOVERY_RECOMMENDED",
  READY_TO_CLAIM: "READY_TO_CLAIM"
});

export const V35_EFFECTIVE_STATE = Object.freeze({
  SCHEDULED: V3_STATE.SCHEDULED,
  PREDICTION_CLOSED: V3_STATE.PREDICTION_CLOSED,
  LINEUP_READY: V3_STATE.LINEUP_READY,
  SCORED: V3_STATE.SCORED,
  RANKED: V3_STATE.RANKED,
  PUBLISHED: V3_STATE.PUBLISHED,
  LINEUP_DATA_READY: "lineup_data_ready",
  ROSTER_READY: "roster_ready",
  NPB_IDENTITY_READY: "npb_identity_ready",
  PROBABLE_STARTER_READY: "probable_starter_ready",
  SCHEDULE_REGISTERED: "schedule_registered",
  CANCELLED: "cancelled",
  POSTPONED: "postponed",
  EXCLUDED: V3_STATE.EXCLUDED
});

const STAGE_NAMES = Object.freeze([
  "schedule_registration",
  "npb_game_identify",
  "probable_starter",
  "roster_fetch",
  "prediction_close",
  "lineup_fetch",
  "lineup_finalize",
  "scoring",
  "ranking_reflect",
  "publish"
]);

const EFFECTIVE_STATE_ORDER = Object.freeze([
  "scheduled",
  "schedule_registered",
  "npb_identity_ready",
  "probable_starter_ready",
  "roster_ready",
  "prediction_closed",
  "lineup_data_ready",
  "lineup_ready",
  "scored",
  "ranked",
  "published"
]);
const PROTECTED_STATES = new Set(["cancelled", "canceled", "postponed", "excluded", "failed", "manual_action_required"]);

const JOB_TYPE_BY_STAGE = Object.freeze({
  probable_starter: "probable_starter_fetch",
  roster_fetch: "roster_fetch",
  prediction_close: "prediction_close",
  npb_game_identify: "npb_identity_resolve",
  lineup_fetch: "lineup_fetch",
  lineup_finalize: "lineup_finalize",
  scoring: "score",
  ranking_reflect: "ranking_rebuild",
  publish: "publish"
});

const OPEN_JOB_STATUSES = new Set(["pending", "claimed"]);

function valueOr(object, ...keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeStageName(value) {
  const stage = String(value || "").trim();
  if (stage === "probable_starter_fetch") return "probable_starter";
  if (stage === "npb_identity_resolve") return "npb_game_identify";
  if (stage === "ranking_rebuild") return "ranking_reflect";
  if (stage === "score") return "scoring";
  return stage;
}

function normalizeGameStatus({ gameStatus, cancellationInfo, excluded }) {
  const status = normalizeStatus(gameStatus);
  const info = cancellationInfo || {};
  if (excluded || info.excluded || status === "excluded") return "excluded";
  if (info.cancelled || ["cancelled", "canceled", "no_game", "service_unavailable"].includes(status)) return "cancelled";
  if (info.postponed || status === "postponed") return "postponed";
  return null;
}

function isArtifactCandidate(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeV35ArtifactHealth(value = null, context = {}) {
  const raw = isArtifactCandidate(value?.health) ? value.health : value;
  if (!isArtifactCandidate(raw)) {
    return {
      available: false,
      valid: false,
      fresh: false,
      source: null,
      capturedAt: null,
      fingerprint: null,
      verificationStatus: "missing",
      internalGameId: context.internalGameId || null,
      rowCount: null,
      reason: context.reason || "ARTIFACT_MISSING",
      blockingReason: context.blockingReason || "ARTIFACT_MISSING",
      nextSafeAction: context.nextSafeAction || "wait_or_recover"
    };
  }
  const valid = Boolean(valueOr(raw, "valid", "artifactVerified", "ready"));
  const available = raw.available === undefined
    ? Boolean(raw.present ?? valid)
    : Boolean(raw.available);
  const fresh = raw.fresh === undefined ? valid : Boolean(raw.fresh);
  return {
    available,
    valid,
    fresh,
    source: valueOr(raw, "source", "sourceType"),
    capturedAt: iso(valueOr(raw, "capturedAt", "captured_at", "updatedAt", "updated_at")),
    fingerprint: valueOr(raw, "fingerprint", "sourceFingerprint"),
    verificationStatus: valueOr(raw, "verificationStatus", "verification_status") || (valid ? "verified" : "unverified"),
    internalGameId: valueOr(raw, "internalGameId", "internal_game_id") || context.internalGameId || null,
    rowCount: valueOr(raw, "rowCount", "row_count"),
    reason: valueOr(raw, "reason", "reasonCode") || (valid ? null : "ARTIFACT_INVALID"),
    blockingReason: valueOr(raw, "blockingReason", "blocking_reason") || null,
    nextSafeAction: valueOr(raw, "nextSafeAction", "next_safe_action") || (valid ? "no_op" : "wait_or_recover")
  };
}

function artifactFor(stageName, artifacts = {}) {
  if (artifacts && artifacts[stageName] !== undefined) return artifacts[stageName];
  const jobType = JOB_TYPE_BY_STAGE[stageName];
  return jobType && artifacts ? artifacts[jobType] : null;
}

function jobsForStage(jobs, stageName, internalGameId) {
  const jobType = JOB_TYPE_BY_STAGE[stageName] || stageName;
  return (Array.isArray(jobs) ? jobs : []).filter((job) => {
    const jobStage = normalizeStageName(valueOr(job, "stageName", "stage", "jobType", "job_type"));
    const jobGameId = valueOr(job, "internalGameId", "internal_game_id");
    return jobStage === stageName
      && (!internalGameId || !jobGameId || jobGameId === internalGameId)
      && (jobType === stageName || normalizeStageName(jobType) === stageName || valueOr(job, "jobType", "job_type") === jobType);
  });
}

function selectedJob(jobs, selectedSlot) {
  if (!jobs.length) return null;
  const selected = asDate(selectedSlot);
  const exact = selected && jobs.find((job) => {
    const slot = asDate(valueOr(job, "scheduledSlotAt", "scheduled_slot_at"));
    return slot && slot.getTime() === selected.getTime();
  });
  if (exact) return exact;
  if (selected) return null;
  return [...jobs].sort((left, right) => {
    const leftTime = asDate(valueOr(left, "scheduledSlotAt", "scheduled_slot_at"))?.getTime() || 0;
    const rightTime = asDate(valueOr(right, "scheduledSlotAt", "scheduled_slot_at"))?.getTime() || 0;
    return rightTime - leftTime;
  })[0];
}

function normalizeDefinition(stageName, definition = {}) {
  const source = definition || {};
  const prerequisite = source.prerequisiteHealth || source.prerequisite || {};
  const prerequisiteSpecified = source.prerequisiteMet !== undefined
    || prerequisite.met !== undefined
    || source.blockedByPrerequisite !== undefined;
  const prerequisiteMet = source.prerequisiteMet !== undefined
    ? Boolean(source.prerequisiteMet)
    : prerequisite.met !== undefined
      ? Boolean(prerequisite.met)
      : source.blockedByPrerequisite !== true;
  return {
    stageName,
    dueAt: valueOr(source, "dueAt", "due_at", "scheduledSlotAt", "scheduled_slot_at"),
    dueAtSource: valueOr(source, "dueAtSource", "due_at_source") || null,
    dueSlots: Array.isArray(valueOr(source, "dueSlots", "due_slots", "slots"))
      ? valueOr(source, "dueSlots", "due_slots", "slots").map(iso).filter(Boolean)
      : [],
    selectedSlot: valueOr(source, "selectedSlot", "selected_slot", "dueAt", "due_at", "scheduledSlotAt", "scheduled_slot_at"),
    prerequisiteMet,
    prerequisiteSpecified,
    prerequisiteReason: valueOr(prerequisite, "reason", "reasonCode") || valueOr(source, "prerequisiteReason", "blockingReason"),
    externalFetchDisabled: Boolean(source.externalFetchDisabled || source.external_fetch_disabled),
    manualMode: Boolean(source.manualMode || source.manual_mode),
    manualAttention: Boolean(source.manualAttention || source.manual_attention),
    readyToClaim: Boolean(source.readyToClaim || source.ready_to_claim),
    rankingExcluded: Boolean(source.rankingExcluded || source.ranking_excluded),
    planningPlan: source.planningPlan || null
  };
}

function definitionsByStage(stageDefinitions) {
  const source = Array.isArray(stageDefinitions)
    ? Object.fromEntries(stageDefinitions.map((definition) => [normalizeStageName(definition?.stageName || definition?.stage), definition]))
    : stageDefinitions || {};
  return Object.fromEntries(STAGE_NAMES.map((stageName) => [
    stageName,
    normalizeDefinition(stageName, source[stageName] || {})
  ]));
}

function isDue(definition, now) {
  const dueAt = asDate(definition.dueAt);
  return Boolean(dueAt && now.getTime() >= dueAt.getTime());
}

function recoveryResult(healthStatus, recoveryReason, attentionLevel = "ATTENTION") {
  return {
    recoveryRecommended: true,
    recoveryReason,
    attentionLevel,
    healthStatus
  };
}

function isManualArtifactReady(stageName, artifactHealth, artifacts) {
  if (stageName === "roster_fetch") return false;
  if (stageName === "lineup_fetch") {
    const final = normalizeV35ArtifactHealth(artifactFor("lineup_finalize", artifacts));
    return final.available && final.valid;
  }
  return artifactHealth.available && artifactHealth.valid;
}

export function evaluateV35Stage({
  stageName,
  definition = {},
  jobs = [],
  artifacts = {},
  currentTime = new Date(),
  internalGameId = null,
  cancelled = false,
  rankingExcluded = false,
  scheduleRegistered = false,
  operationalMode = null
} = {}) {
  const normalizedDefinition = normalizeDefinition(normalizeStageName(stageName), definition);
  const now = asDate(currentTime) || new Date();
  const selectedSlot = normalizedDefinition.selectedSlot || normalizedDefinition.dueAt;
  const artifactHealth = normalizeV35ArtifactHealth(artifactFor(normalizedDefinition.stageName, artifacts), { internalGameId });
  const stageJobs = jobsForStage(jobs, normalizedDefinition.stageName, internalGameId);
  const job = selectedJob(stageJobs, selectedSlot);
  const due = isDue(normalizedDefinition, now);
  const base = {
    healthStatus: due ? V35_STAGE_HEALTH.DUE : V35_STAGE_HEALTH.NOT_DUE,
    dueAt: iso(normalizedDefinition.dueAt),
    dueAtSource: normalizedDefinition.dueAtSource,
    dueSlots: normalizedDefinition.dueSlots,
    selectedSlot: iso(selectedSlot),
    job: job || null,
    artifactHealth,
    blockingReason: null,
    nextSafeAction: due ? "plan_or_claim" : "wait",
    recoveryRecommended: false,
    recoveryReason: null,
    attentionLevel: "INFO",
    formalPlan: normalizedDefinition.planningPlan || null,
    manualMode: normalizedDefinition.manualMode === true
  };

  if (cancelled) return {
    ...base,
    healthStatus: V35_STAGE_HEALTH.BLOCKED_BY_CANCELLED,
    blockingReason: "GAME_CANCELLED_OR_EXCLUDED",
    nextSafeAction: "no_op",
    attentionLevel: "INFO"
  };
  const rankingStage = ["ranking_reflect", "publish"].includes(normalizedDefinition.stageName);
  if ((normalizedDefinition.rankingExcluded || rankingExcluded) && rankingStage) {
    return {
      ...base,
      healthStatus: V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE,
      blockingReason: "RANKING_EXCLUDED",
      nextSafeAction: "no_op",
      attentionLevel: "INFO"
    };
  }
  if (normalizedDefinition.stageName === "schedule_registration" && scheduleRegistered) return {
    ...base,
    healthStatus: V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY,
    nextSafeAction: "no_op",
    attentionLevel: "INFO"
  };
  if (normalizedDefinition.manualMode) {
    const manualArtifactReady = isManualArtifactReady(normalizedDefinition.stageName, artifactHealth, artifacts);
    if (normalizedDefinition.stageName === "lineup_finalize" && manualArtifactReady) return {
      ...base,
      healthStatus: V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY,
      nextSafeAction: "no_action",
      recoveryRecommended: false,
      recoveryReason: null,
      attentionLevel: "INFO",
      reasonCode: "V4_MANUAL_LINEUP",
      completionSource: "manual_lineup",
      manualArtifactReady: true
    };
    const reason = normalizedDefinition.stageName === "roster_fetch"
      ? "V4_MANUAL_ROSTER"
      : manualArtifactReady ? "V4_MANUAL_LINEUP" : "MANUAL_LINEUP_REQUIRED";
    return {
      ...base,
      healthStatus: V35_STAGE_HEALTH.MANUAL_MODE,
      blockingReason: manualArtifactReady || normalizedDefinition.stageName === "roster_fetch" ? null : "MANUAL_LINEUP_REQUIRED",
      nextSafeAction: manualArtifactReady || normalizedDefinition.stageName === "roster_fetch" ? "no_action" : "manual_lineup",
      recoveryRecommended: false,
      recoveryReason: null,
      attentionLevel: manualArtifactReady || normalizedDefinition.stageName === "roster_fetch" ? "INFO" : "ATTENTION",
      reasonCode: reason,
      manualArtifactReady
    };
  }
  // A future stage is expected to wait, even when its eventual prerequisite
  // artifact does not exist yet. Only evaluate blockers once the stage is due.
  if (!due) return base;
  if (normalizedDefinition.externalFetchDisabled) return {
    ...base,
    healthStatus: V35_STAGE_HEALTH.BLOCKED_BY_EXTERNAL_FETCH_DISABLED,
    blockingReason: "EXTERNAL_FETCH_DISABLED",
    nextSafeAction: "wait_for_configuration",
    attentionLevel: "ATTENTION"
  };
  if (normalizedDefinition.manualAttention) return {
    ...base,
    healthStatus: V35_STAGE_HEALTH.BLOCKED_BY_MANUAL_ATTENTION,
    blockingReason: "MANUAL_ATTENTION_REQUIRED",
    nextSafeAction: "manual_review",
    attentionLevel: "ATTENTION"
  };
  if (!normalizedDefinition.prerequisiteMet) return {
    ...base,
    healthStatus: V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE,
    blockingReason: normalizedDefinition.prerequisiteReason || "PREREQUISITE_NOT_MET",
    nextSafeAction: "wait_for_prerequisite",
    attentionLevel: "INFO"
  };
  if (normalizedDefinition.stageName !== "roster_fetch" && artifactHealth.valid && artifactHealth.available) return {
    ...base,
    healthStatus: V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY,
    nextSafeAction: "no_op",
    attentionLevel: "INFO"
  };
  if (!job) return {
    ...base,
    ...recoveryResult(V35_STAGE_HEALTH.MISSING_JOB, "MISSING_DUE_JOB"),
    blockingReason: "MISSING_DUE_JOB",
    nextSafeAction: "plan_recovery"
  };

  const status = normalizeStatus(valueOr(job, "status", "jobStatus"));
  if (status === "retry_wait") {
    const retryAt = asDate(valueOr(job, "nextRetryAt", "next_retry_at", "retryAt", "retry_at"));
    if (retryAt && retryAt.getTime() > now.getTime()) return {
      ...base,
      healthStatus: V35_STAGE_HEALTH.RETRY_WAIT_NOT_DUE,
      nextSafeAction: "wait_until_retry",
      attentionLevel: "INFO"
    };
    return {
      ...base,
      ...recoveryResult(V35_STAGE_HEALTH.RETRY_WAIT_DUE, "RETRY_WAIT_EXPIRED"),
      blockingReason: "RETRY_WAIT_EXPIRED",
      nextSafeAction: "plan_recovery"
    };
  }
  if (OPEN_JOB_STATUSES.has(status)) return {
    ...base,
    healthStatus: normalizedDefinition.readyToClaim || job.readyToClaim ? V35_STAGE_HEALTH.READY_TO_CLAIM : V35_STAGE_HEALTH.OPEN_JOB_EXISTS,
    nextSafeAction: "claim_existing_job",
    attentionLevel: "INFO"
  };
  if (status === "failed") return {
    ...base,
    ...recoveryResult(V35_STAGE_HEALTH.TERMINAL_FAILED, "TERMINAL_FAILED"),
    blockingReason: valueOr(job, "failureCode", "failure_code") || "TERMINAL_FAILED",
    nextSafeAction: "plan_recovery"
  };
  if (status === "cancelled") return {
    ...base,
    healthStatus: V35_STAGE_HEALTH.TERMINAL_CANCELLED,
    blockingReason: "JOB_CANCELLED",
    nextSafeAction: "no_op",
    attentionLevel: "INFO"
  };
  if (status === "completed") {
    if (artifactHealth.valid && artifactHealth.available) return {
      ...base,
      healthStatus: V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY,
      nextSafeAction: "no_op",
      attentionLevel: "INFO"
    };
    return {
      ...base,
      ...recoveryResult(V35_STAGE_HEALTH.COMPLETED_ARTIFACT_MISSING, "COMPLETED_ARTIFACT_MISSING"),
      blockingReason: artifactHealth.reason || "COMPLETED_ARTIFACT_MISSING",
      nextSafeAction: "plan_recovery"
    };
  }
  return {
    ...base,
    ...recoveryResult(V35_STAGE_HEALTH.BLOCKED_BY_MANUAL_ATTENTION, "UNKNOWN_JOB_STATUS"),
    blockingReason: "UNKNOWN_JOB_STATUS",
    nextSafeAction: "manual_review"
  };
}

function stageReady(stages, stageName) {
  return stages[stageName]?.healthStatus === V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY;
}

function derivedPrerequisite(definition, stageName, artifacts) {
  if (definition.prerequisiteSpecified) return definition;
  const requiredArtifactStage = {
    lineup_finalize: "prediction_close",
    scoring: "lineup_finalize",
    ranking_reflect: "scoring",
    publish: "ranking_reflect"
  }[stageName];
  if (!requiredArtifactStage) return definition;
  const requiredArtifact = normalizeV35ArtifactHealth(artifactFor(requiredArtifactStage, artifacts));
  if (requiredArtifact.available && requiredArtifact.valid) return definition;
  return {
    ...definition,
    prerequisiteMet: false,
    prerequisiteReason: `${requiredArtifactStage.toUpperCase()}_ARTIFACT_MISSING`
  };
}

function effectiveStateFromEvidence({ stages, artifacts, scheduleRegistered }) {
  const publication = normalizeV35ArtifactHealth(artifactFor("publish", artifacts));
  const ranking = normalizeV35ArtifactHealth(artifactFor("ranking_reflect", artifacts));
  const scoring = normalizeV35ArtifactHealth(artifactFor("scoring", artifacts));
  const finalized = normalizeV35ArtifactHealth(artifactFor("lineup_finalize", artifacts));
  if (publication.valid && publication.available || stageReady(stages, "publish")) return V35_EFFECTIVE_STATE.PUBLISHED;
  if (ranking.valid && ranking.available || stageReady(stages, "ranking_reflect")) return V35_EFFECTIVE_STATE.RANKED;
  if (scoring.valid && scoring.available || stageReady(stages, "scoring")) return V35_EFFECTIVE_STATE.SCORED;
  if (finalized.valid && finalized.available || stageReady(stages, "lineup_finalize")) return V35_EFFECTIVE_STATE.LINEUP_READY;
  const lineup = normalizeV35ArtifactHealth(artifactFor("lineup_fetch", artifacts));
  if (lineup.valid && lineup.available || stageReady(stages, "lineup_fetch")) return V35_EFFECTIVE_STATE.LINEUP_DATA_READY;
  if (stageReady(stages, "prediction_close")) return V35_EFFECTIVE_STATE.PREDICTION_CLOSED;
  if (stageReady(stages, "roster_fetch")) return V35_EFFECTIVE_STATE.ROSTER_READY;
  if (stageReady(stages, "probable_starter")) return V35_EFFECTIVE_STATE.PROBABLE_STARTER_READY;
  if (stageReady(stages, "npb_game_identify")) return V35_EFFECTIVE_STATE.NPB_IDENTITY_READY;
  if (scheduleRegistered) return V35_EFFECTIVE_STATE.SCHEDULE_REGISTERED;
  return V35_EFFECTIVE_STATE.SCHEDULED;
}

function progressRank(value) {
  const normalized = normalizeStatus(value);
  const index = EFFECTIVE_STATE_ORDER.indexOf(normalized);
  return index < 0 ? 0 : index;
}

function monotonicEffectiveState(evidenceState, persistedState) {
  const persisted = normalizeStatus(persistedState);
  if (PROTECTED_STATES.has(persisted)) return persisted;
  return progressRank(persisted) > progressRank(evidenceState) ? persisted : evidenceState;
}

function cancellationEffectiveState(gameStatus, cancellationInfo, excluded) {
  return normalizeGameStatus({ gameStatus, cancellationInfo, excluded });
}

function statesEquivalent(left, right) {
  const normalize = (value) => value === V35_EFFECTIVE_STATE.SCHEDULE_REGISTERED
    ? V35_EFFECTIVE_STATE.SCHEDULED
    : value;
  return normalize(left) === normalize(right);
}

function publishedArtifactsHealthy(stages, persistedState, effectiveState) {
  if (![persistedState, effectiveState].some((value) => normalizeStatus(value) === V35_EFFECTIVE_STATE.PUBLISHED)) return false;
  return ["lineup_finalize", "scoring", "ranking_reflect", "publish"].every((stageName) => {
    const stage = stages[stageName];
    return stage?.healthStatus === V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY
      && stage?.artifactHealth?.available === true
      && stage?.artifactHealth?.valid === true;
  });
}

export function evaluateV35Automation({
  internalGameId = null,
  gameStatus = "scheduled",
  persistedWorkflowState = V3_STATE.SCHEDULED,
  currentTime = new Date(),
  stageDefinitions = {},
  jobs = [],
  artifacts = {},
  cancellationInfo = null,
  excluded = false,
  rankingExcluded = false,
  scheduleRegistered = false,
  operationalMode = null
  } = {}) {
  const cancellationState = cancellationEffectiveState(gameStatus, cancellationInfo, excluded);
  const persistedState = String(persistedWorkflowState || V3_STATE.SCHEDULED);
  const definitions = definitionsByStage(stageDefinitions);
  const stages = Object.fromEntries(STAGE_NAMES.map((stageName) => [stageName, evaluateV35Stage({
    stageName,
    definition: derivedPrerequisite(definitions[stageName], stageName, artifacts),
    jobs,
    artifacts,
    currentTime,
    internalGameId,
    cancelled: Boolean(cancellationState),
    rankingExcluded,
    scheduleRegistered,
    operationalMode
  })]));
  const evidenceState = effectiveStateFromEvidence({ stages, artifacts, scheduleRegistered });
  const effectiveState = cancellationState || monotonicEffectiveState(evidenceState, persistedState);
  return {
    effectiveState,
    persistedState,
    stateMismatch: !statesEquivalent(effectiveState, persistedState),
    publishedHealthy: publishedArtifactsHealthy(stages, persistedState, effectiveState),
    stages
  };
}
