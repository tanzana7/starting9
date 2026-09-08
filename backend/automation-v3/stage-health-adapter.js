// V3.5 Phase 1.5: adapt existing V3-shaped data for the derive-only evaluator.
// This module is intentionally pure. It does not read D1, fetch, create jobs,
// mutate workflow state, or connect to a runtime entrypoint.
import { deriveV35StageDueSchedule } from "./stage-due-schedule.js";
import { buildStagePlans, buildV3PlanningState, getLateLineupFetchDecision } from "./planning-engine.js";
import { getV3OperationalMode } from "./constants.js";
import { toCanonicalArtifactStageArtifacts } from "./canonical-artifact-evaluator.js";

const STAGES = Object.freeze([
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

const LINEUP_FINALIZE_SUPERSEDING_STATUSES = new Set(["pending", "claimed", "retry_wait", "completed"]);

const JOB_TYPE_TO_STAGE = Object.freeze({
  probable_starter_fetch: "probable_starter",
  roster_fetch: "roster_fetch",
  prediction_close: "prediction_close",
  npb_identity_resolve: "npb_game_identify",
  lineup_fetch: "lineup_fetch",
  lineup_finalize: "lineup_finalize",
  score: "scoring",
  scoring: "scoring",
  ranking_rebuild: "ranking_reflect",
  ranking: "ranking_reflect",
  publish: "publish"
});

const EXTERNAL_FETCH_STAGES = new Set([
  "probable_starter",
  "roster_fetch",
  "npb_game_identify",
  "lineup_fetch"
]);

const ARTIFACT_ALIASES = Object.freeze({
  probable_starter: ["probable_starter", "probableStarter", "probable_starter_fetch"],
  roster_fetch: ["roster_fetch", "roster", "rosterSnapshot", "roster_snapshot"],
  prediction_close: ["prediction_close", "predictionClose", "prediction_close_marker"],
  lineup_fetch: ["lineup_fetch", "lineupFetch", "lineup", "lineupData"],
  lineup_finalize: ["lineup_finalize", "lineupFinalize", "finalizedLineup"],
  scoring: ["scoring", "score", "scoringResult"],
  ranking_reflect: ["ranking_reflect", "ranking", "rankingReflection", "ranking_rebuild"],
  publish: ["publish", "publication", "publicationMarker", "publish_marker"]
});

const V4_MANUAL_STAGES = Object.freeze(["roster_fetch", "lineup_fetch", "lineup_finalize"]);

function normalizeMode(value) {
  return String(value || "").trim().toLowerCase();
}

export function resolveV35OperationalMode({ automationMode = null, operationalMode = null, env = {} } = {}) {
  const supplied = objectOrEmpty(automationMode || operationalMode);
  const configured = getV3OperationalMode(env);
  const isV4SemiAuto = supplied.isV4SemiAuto === true
    || normalizeMode(supplied.mode) === "v4_semi_auto"
    || normalizeMode(supplied.schema) === "v4_semi_auto"
    || normalizeMode(configured.mode) === "v4_semi_auto";
  const disabledStages = isV4SemiAuto
    ? ["roster_fetch", "lineup_fetch"]
    : Array.isArray(supplied.disabledStages) ? supplied.disabledStages : [];
  return Object.freeze({
    mode: isV4SemiAuto ? "v4_semi_auto" : normalizeMode(supplied.mode) || configured.mode,
    isV4SemiAuto,
    autoProbableStarter: supplied.autoProbableStarter === undefined ? configured.autoProbableStarter : Boolean(supplied.autoProbableStarter),
    autoRosterFetch: isV4SemiAuto ? false : supplied.autoRosterFetch === undefined ? configured.autoRosterFetch : Boolean(supplied.autoRosterFetch),
    autoLineupFetch: isV4SemiAuto ? false : supplied.autoLineupFetch === undefined ? configured.autoLineupFetch : Boolean(supplied.autoLineupFetch),
    disabledStages: Object.freeze(disabledStages),
    diagnosticManualStages: Object.freeze(isV4SemiAuto ? [...V4_MANUAL_STAGES] : [])
  });
}

function first(object, ...keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeStage(value) {
  const normalized = String(value || "").trim();
  return JOB_TYPE_TO_STAGE[normalized] || normalized;
}

function warning(code, message, stage = null) {
  return { code, message, ...(stage ? { stage } : {}) };
}

function normalizeJob(job = {}) {
  const jobType = String(first(job, "jobType", "job_type", "diagnosticJobType") || "").trim();
  const stageName = normalizeStage(first(job, "stageName", "stage", "jobType", "job_type"));
  return {
    id: first(job, "id", "jobId", "job_id"),
    internalGameId: first(job, "internalGameId", "internal_game_id"),
    jobType: jobType || null,
    stageName: stageName || null,
    scheduledAt: normalizeDate(first(job, "scheduledAt", "scheduled_at")),
    scheduledSlotAt: normalizeDate(first(job, "scheduledSlotAt", "scheduled_slot_at")),
    status: first(job, "status", "jobStatus") || null,
    createdAt: normalizeDate(first(job, "createdAt", "created_at")),
    claimedAt: normalizeDate(first(job, "claimedAt", "claimed_at")),
    completedAt: normalizeDate(first(job, "completedAt", "completed_at")),
    failedAt: normalizeDate(first(job, "failedAt", "failed_at")),
    retryAt: normalizeDate(first(job, "retryAt", "retry_at", "nextRetryAt", "next_retry_at")),
    nextRetryAt: normalizeDate(first(job, "nextRetryAt", "next_retry_at", "retryAt", "retry_at")),
    attemptCount: Number(first(job, "attemptCount", "attempt_count") || 0),
    maxAttempts: Number(first(job, "maxAttempts", "max_attempts") || 0),
    failureCode: first(job, "failureCode", "failure_code", "errorCode", "error_code"),
    failureReason: first(job, "failureReason", "failure_reason", "reason", "reasonCode"),
    recoveryOfJobId: first(job, "recoveryOfJobId", "recovery_of_job_id"),
    recoveryReason: first(job, "recoveryReason", "recovery_reason"),
    recoveryGeneration: first(job, "recoveryGeneration", "recovery_generation"),
    requestedAt: normalizeDate(first(job, "requestedAt", "requested_at")),
    requestedBy: first(job, "requestedBy", "requested_by"),
    source: first(job, "source", "jobSource"),
    readyToClaim: Boolean(first(job, "readyToClaim", "ready_to_claim"))
  };
}

function artifactCandidate(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
}

function genericArtifact(raw, stageName) {
  const value = artifactCandidate(raw) || {};
  const health = artifactCandidate(value.health) || value;
  const candidateExists = first(health, "candidateExists", "candidate_exists");
  const canonicalReady = first(health, "canonicalDataReady", "canonical_data_ready", "canonicalExists");
  const finalizedExists = first(health, "finalizedLineupExists", "finalized_lineup_exists");
  const canonicalFinalRevisionId = first(health, "canonicalFinalRevisionId", "canonical_final_revision_id", "finalLineupRevisionId", "final_lineup_revision_id");
  const canonicalFinalRevisionValid = first(health, "canonicalFinalRevisionValid", "canonical_final_revision_valid");
  const finalizedValid = first(health, "finalizedValid", "finalized_valid");
  const revisionMatches = first(health, "revisionMatches", "revision_matches");
  const revisionMismatch = health.revisionMismatch === true
    || health.revision_mismatch === true
    || health.reprocessRequired === true
    || health.reprocess_required === true
    || revisionMatches === false;
  const canonicalFinalInvalid = canonicalFinalRevisionValid === false;
  const available = health.available !== undefined
    ? Boolean(health.available)
    : Boolean(health.present ?? health.exists ?? health.ready ?? health.valid ?? candidateExists ?? canonicalReady ?? finalizedExists);
  const inferredValid = stageName === "lineup_fetch"
    ? candidateExists === true || canonicalReady === true || health.ready === true
    : stageName === "lineup_finalize"
      ? finalizedExists === true || finalizedValid === true || canonicalFinalRevisionValid === true || health.ready === true
      : stageName === "ranking_reflect"
        ? health.reflected === true || health.ready === true
        : stageName === "publish"
          ? health.published === true || health.ready === true
          : health.valid === true || health.artifactVerified === true || health.ready === true;
  const valid = (health.valid !== undefined ? Boolean(health.valid) : inferredValid)
    && !revisionMismatch
    && !canonicalFinalInvalid;
  return {
    available,
    valid,
    fresh: health.fresh === undefined ? valid : Boolean(health.fresh),
    source: first(health, "source", "sourceType"),
    capturedAt: normalizeDate(first(health, "capturedAt", "captured_at", "updatedAt", "updated_at")),
    fingerprint: first(health, "fingerprint", "sourceFingerprint"),
    verificationStatus: first(health, "verificationStatus", "verification_status") || (valid ? "verified" : "unverified"),
    internalGameId: first(health, "internalGameId", "internal_game_id"),
    rowCount: first(health, "rowCount", "row_count"),
    reason: first(health, "reason", "reasonCode", "staleReason"),
    blockingReason: first(health, "blockingReason", "blocking_reason"),
    nextSafeAction: first(health, "nextSafeAction", "next_safe_action") || (valid ? "no_op" : "wait_or_recover"),
    ...(candidateExists !== null ? { candidateExists } : {}),
    ...(canonicalReady !== null ? { canonicalDataReady: canonicalReady } : {}),
    ...(finalizedExists !== null ? { finalizedLineupExists: finalizedExists } : {}),
    ...(finalizedValid !== null ? { finalizedValid } : {}),
    ...(canonicalFinalRevisionId !== null ? { canonicalFinalRevisionId } : {}),
    ...(canonicalFinalRevisionValid !== null ? { canonicalFinalRevisionValid } : {}),
    ...(revisionMismatch ? { revisionMismatch: true } : {}),
    ...(health.reprocessRequired === true ? { reprocessRequired: true } : {}),
    ...(["scoring", "ranking_reflect", "publish"].includes(stageName) ? {
      scoringRevisionId: first(health, "scoringRevisionId", "scoring_revision_id", "currentScoringRevisionId", "current_scoring_revision_id"),
      reflectedScoringRevisionId: first(health, "reflectedScoringRevisionId", "reflected_scoring_revision_id"),
      revisionMatches
    } : {})
  };
}

function rosterArtifact(raw, game = {}) {
  const value = artifactCandidate(raw) || {};
  const health = artifactCandidate(value.health) || value;
  const publicSource = artifactCandidate(first(health, "public", "publicSource", "public_source")) || {};
  const snapshot = artifactCandidate(first(health, "snapshot", "canonicalSnapshot", "canonical_snapshot")) || {};
  const source = first(health, "source", "sourceType") || first(publicSource, "source", "sourceType") || null;
  const verificationStatus = first(health, "verificationStatus", "verification_status");
  const publicVerified = Boolean(
    first(publicSource, "verified", "isVerified")
    ?? first(health, "publicVerified", "public_verified")
    ?? health.verified
    ?? verificationStatus === "verified"
  );
  const publicUsable = Boolean(
    first(health, "publicUsable", "public_usable")
    ?? (String(source || "").toLowerCase() === "latest_official_live" && publicVerified)
  );
  const noticeState = String(first(health, "noticeState", "notice_state", "reasonCode", "reason_code") || "").trim().toUpperCase();
  const snapshotStatus = String(first(
    health,
    "rosterSnapshotStatus",
    "roster_snapshot_status",
    "snapshotStatus",
    "snapshot_status"
  ) || first(snapshot, "status") || "").trim().toLowerCase();
  const rosterNoChanges = noticeState === "ROSTER_NO_CHANGES";
  const capturedSnapshot = snapshotStatus === "captured";
  const snapshotAvailable = Boolean(
    rosterNoChanges
    || capturedSnapshot
    || (first(health, "canonicalSnapshotAvailable", "canonical_snapshot_available", "snapshotExists", "snapshot_exists", "rosterSnapshotExists", "roster_snapshot_exists")
      ?? (Object.keys(snapshot).length > 0 && snapshot.available !== false))
  );
  const snapshotVerified = Boolean(first(health, "snapshotVerified", "snapshot_verified", "verifiedSnapshot", "verified_snapshot") ?? snapshot.verified);
  const snapshotValid = Boolean(
    rosterNoChanges
    || capturedSnapshot
    || first(health, "snapshotValid", "snapshot_valid")
    || snapshot.valid
    || (snapshotAvailable && snapshotVerified)
  );
  const available = rosterNoChanges || capturedSnapshot
    ? true
    : health.available !== undefined ? Boolean(health.available) : snapshotAvailable;
  const valid = rosterNoChanges || capturedSnapshot
    ? true
    : health.valid !== undefined ? Boolean(health.valid) : snapshotValid;
  const reason = first(health, "reason", "reasonCode", "staleReason")
    || (rosterNoChanges ? "ROSTER_NO_CHANGES" : null)
    || (!snapshotAvailable && publicUsable ? "ROSTER_SNAPSHOT_MISSING" : null);
  return {
    available,
    valid,
    fresh: health.fresh === undefined ? Boolean(snapshotAvailable && (health.isFresh ?? snapshot.fresh ?? snapshotValid)) : Boolean(health.fresh),
    source,
    capturedAt: normalizeDate(first(health, "capturedAt", "captured_at") || first(snapshot, "capturedAt", "captured_at")),
    fingerprint: first(health, "fingerprint", "sourceFingerprint") || first(snapshot, "fingerprint"),
    verificationStatus: verificationStatus || (snapshotVerified ? "verified" : publicVerified ? "public_verified" : "unverified"),
    internalGameId: first(health, "internalGameId", "internal_game_id") || first(game, "internalGameId", "internal_game_id"),
    rowCount: first(health, "rowCount", "row_count") || first(snapshot, "rowCount", "row_count"),
    reason,
    blockingReason: first(health, "blockingReason", "blocking_reason") || (reason === "ROSTER_SNAPSHOT_MISSING" ? "ROSTER_SNAPSHOT_MISSING" : null),
    nextSafeAction: rosterNoChanges || capturedSnapshot
      ? "no_op"
      : first(health, "nextSafeAction", "next_safe_action") || (reason === "ROSTER_SNAPSHOT_MISSING" ? "roster_fetch" : valid ? "no_op" : "wait_or_recover"),
    publicUsable,
    publicSource: source,
    publicVerified,
    canonicalSnapshotAvailable: snapshotAvailable,
    canonicalSnapshotVerified: snapshotVerified
  };
}

function probableStarterArtifact(raw, game = {}) {
  const value = artifactCandidate(raw) || {};
  const health = artifactCandidate(value.health) || value;
  const homeStarter = artifactCandidate(first(health, "homeProbableStarter", "home_probable_starter")) || {};
  const awayStarter = artifactCandidate(first(health, "awayProbableStarter", "away_probable_starter")) || {};
  const homePitcherName = first(health, "homePitcherName", "home_pitcher_name") || first(homeStarter, "name", "playerName");
  const awayPitcherName = first(health, "awayPitcherName", "away_pitcher_name") || first(awayStarter, "name", "playerName");
  const dataStatus = String(first(health, "dataStatus", "data_status") || "").trim().toLowerCase();
  const announced = dataStatus === "announced"
    || health.fullyAnnounced === true
    || health.fully_announced === true
    || health.isConfirmed === true
    || health.confirmed === true;
  const available = Boolean(homePitcherName && awayPitcherName && announced);
  return {
    available,
    valid: available,
    fresh: available,
    source: first(health, "source", "sourceType") || null,
    capturedAt: normalizeDate(first(health, "fetchedAt", "fetched_at", "updatedAt", "updated_at")),
    fingerprint: first(health, "fingerprint", "sourceFingerprint"),
    verificationStatus: available ? "verified" : "unverified",
    internalGameId: first(health, "internalGameId", "internal_game_id") || first(game, "internalGameId", "internal_game_id"),
    rowCount: null,
    reason: available ? null : first(health, "errorCode", "error_code", "reason", "reasonCode") || "PROBABLE_STARTER_NOT_ANNOUNCED",
    blockingReason: available ? null : "PROBABLE_STARTER_ARTIFACT_MISSING",
    nextSafeAction: available ? "no_op" : "wait_or_recover"
  };
}

function findArtifact(source, stageName, diagnostics, game) {
  const supplied = objectOrEmpty(source.artifacts);
  const diagnosticArtifacts = objectOrEmpty(diagnostics.artifactHealth || diagnostics.artifacts || diagnostics.workflowArtifactHealth);
  const aliases = ARTIFACT_ALIASES[stageName] || [stageName];
  const raw = aliases.map((key) => supplied[key]).find((value) => value !== undefined)
    ?? aliases.map((key) => diagnosticArtifacts[key]).find((value) => value !== undefined)
    ?? (stageName === "lineup_fetch" ? diagnostics.lineupFetch?.artifactStatus : null)
    ?? (stageName === "prediction_close" ? diagnostics.predictionClose : null)
    ?? (stageName === "probable_starter" ? (diagnostics.probable_starter || diagnostics.probableStarter) : null)
    ?? (stageName === "roster_fetch" ? diagnostics.roster : null)
    ?? (stageName === "roster_fetch" ? first(game, "rosterSnapshot", "roster_snapshot", "rosterHealth") : null);
  if (raw === undefined || raw === null) return null;
  if (stageName === "roster_fetch") return rosterArtifact(raw, game);
  if (stageName === "probable_starter") return probableStarterArtifact(raw, game);
  return genericArtifact(raw, stageName);
}

function externalFetchDisabled(source, diagnostics, game) {
  const flags = {
    ...objectOrEmpty(source.externalFlags),
    ...objectOrEmpty(game.externalFlags || game.external_flags),
    ...objectOrEmpty(diagnostics.externalFlags || diagnostics.external_flags)
  };
  return Boolean(
    source.NPB_FETCH_DISABLED
    || source.npbFetchDisabled
    || game.NPB_FETCH_DISABLED
    || diagnostics.NPB_FETCH_DISABLED
    || flags.NPB_FETCH_DISABLED
    || flags.npb_fetch_disabled
  );
}

function cancellationInfo(game, source) {
  const status = String(first(game, "gameStatus", "game_status") || "").trim().toLowerCase();
  const supplied = objectOrEmpty(source.cancellationInfo || source.cancellation || game.cancellationInfo || game.cancellation);
  return {
    cancelled: Boolean(supplied.cancelled || ["cancelled", "canceled", "no_game", "service_unavailable"].includes(status)),
    postponed: Boolean(supplied.postponed || status === "postponed"),
    excluded: Boolean(supplied.excluded || status === "excluded" || game.excluded === true || game.isExcluded === true),
    source: first(supplied, "source", "cancelSource"),
    reason: first(supplied, "reason", "reasonCode")
  };
}

function stageSource(source, diagnostics, stageName, derivedStageSchedule) {
  const provided = objectOrEmpty(source.stageDefinitions);
  const diagnosticStages = objectOrEmpty(diagnostics.stages || diagnostics.stageHealth || diagnostics.stage_health);
  const direct = objectOrEmpty(provided[stageName] || diagnosticStages[stageName] || diagnostics[stageName]);
  const job = Array.isArray(source.jobs)
    ? source.jobs.map(normalizeJob).find((entry) => entry.stageName === stageName)
    : null;
  const jobDueAt = job?.scheduledSlotAt || job?.scheduledAt || null;
  const explicitDueAt = first(
    direct,
    "dueAt", "due_at", "deadlineAt", "deadline_at", "selectedSlot", "selected_slot", "scheduledSlotAt", "scheduled_slot_at"
  )
    || (stageName === "prediction_close" ? first(diagnostics.predictionClose || {}, "deadlineAt", "deadline_at") : null)
    || (stageName === "lineup_fetch" ? first(diagnostics.lineupFetch || {}, "dueAt", "due_at", "selectedSlot", "selected_slot") : null)
    || (stageName === "roster_fetch" ? first(diagnostics.roster || {}, "dueAt", "due_at", "selectedSlot", "selected_slot") : null)
    || null;
  const derived = objectOrEmpty(derivedStageSchedule?.stages?.[stageName]);
  const dueAt = jobDueAt || explicitDueAt || derived.dueAt || null;
  const dueAtSource = jobDueAt
    ? "job"
    : explicitDueAt
      ? "diagnostic"
      : derived.dueAt
        ? derived.source || "derived_from_game_start"
        : null;
  const dueSlots = first(direct, "slots", "dueSlots", "due_slots")
    || first(diagnostics[stageName] || {}, "slots", "dueSlots", "due_slots")
    || derived.slots
    || null;
  return { direct, dueAt, dueAtSource, dueSlots, job };
}

function buildStageDefinitions(source, diagnostics, artifacts, disabled, game, jobs, derivedStageSchedule, planningState, operationalMode) {
  const definitions = {};
  const currentTime = asDate(source.currentTime || source.now) || new Date();
  const finalizeDueAt = asDate(derivedStageSchedule?.stages?.lineup_finalize?.dueAt);
  const internalGameId = first(game, "internalGameId", "internal_game_id");
  const finalizeJobExists = Array.isArray(jobs)
    && Boolean(internalGameId)
    && jobs.some((job) => {
      const jobGameId = first(job, "internalGameId", "internal_game_id");
      const status = String(first(job, "status", "jobStatus") || "").trim().toLowerCase();
      return normalizeStage(first(job, "stageName", "stage", "jobType", "job_type")) === "lineup_finalize"
        && String(jobGameId || "") === String(internalGameId)
        && LINEUP_FINALIZE_SUPERSEDING_STATUSES.has(status);
    });
  const lineupFetchWindowClosed = Boolean(finalizeDueAt && currentTime >= finalizeDueAt);
  const lineupArtifactReady = Boolean(artifacts.lineup_fetch?.available && artifacts.lineup_fetch?.valid);
  const lateLineupFetch = getLateLineupFetchDecision({
    game,
    effectiveState: planningState?.effectiveState,
    now: currentTime,
    finalLineupAt: finalizeDueAt
  });
  for (const stageName of STAGES) {
    const { direct, dueAt, dueAtSource, dueSlots } = stageSource({ ...source, jobs }, diagnostics, stageName, derivedStageSchedule);
    const blockingReason = first(direct, "blockingReason", "blocking_reason", "blockingReasonCode", "blocking_reason_code")
      || first(diagnostics[stageName] || {}, "blockingReason", "blocking_reason", "blockingReasonCode", "blocking_reason_code");
    const lineupGate = ["lineup_fetch", "lineup_finalize"].includes(stageName)
      && (String(blockingReason || "").includes("PREDICTION_CLOSE") || String(game.workflowState || game.workflow_state || "") === "scheduled");
    const artifactRequired = {
      scoring: "lineup_finalize",
      ranking_reflect: "scoring",
      publish: "ranking_reflect"
    }[stageName];
    const requiredArtifactMissing = artifactRequired && !(artifacts[artifactRequired]?.available && artifacts[artifactRequired]?.valid);
    definitions[stageName] = {
      dueAt,
      dueAtSource,
      dueSlots,
      selectedSlot: first(direct, "selectedSlot", "selected_slot") || dueAt,
      ...(lineupGate ? { prerequisiteMet: false, prerequisiteReason: blockingReason || "PREDICTION_CLOSE_STATE_GATE" } : {}),
      ...(requiredArtifactMissing ? { prerequisiteMet: false, prerequisiteReason: `${artifactRequired.toUpperCase()}_ARTIFACT_MISSING` } : {}),
      ...(stageName === "lineup_fetch" && lineupFetchWindowClosed && !lineupArtifactReady
        && (finalizeJobExists || !lateLineupFetch.allowed)
         ? {
             prerequisiteMet: false,
             prerequisiteReason: finalizeJobExists
               ? "LINEUP_FETCH_SUPERSEDED_BY_LINEUP_FINALIZE"
               : lateLineupFetch.reasonCode || "LINEUP_FETCH_WINDOW_CLOSED_NO_FINALIZE"
           }
         : {}),
      externalFetchDisabled: disabled && EXTERNAL_FETCH_STAGES.has(stageName),
      manualMode: operationalMode.isV4SemiAuto && operationalMode.diagnosticManualStages.includes(stageName),
      manualAttention: Boolean(first(direct, "manualAttention", "manual_attention") || diagnostics.manualAttention || diagnostics.manual_attention),
      rankingExcluded: Boolean(game.rankingExcluded || game.ranking_excluded)
    };
  }
  return definitions;
}

function artifactReady(value) {
  return Boolean(value?.available && value?.valid);
}

function lineupFetchCompleted(diagnostics) {
  const lineup = objectOrEmpty(diagnostics.lineupFetch || diagnostics.lineup_fetch);
  const status = String(first(lineup, "status", "jobStatus", "phaseStatus") || "").trim().toLowerCase();
  const reason = String(first(lineup, "reason", "reasonCode", "completionCode") || "").trim().toUpperCase();
  return status === "completed" && reason === "LINEUP_FETCH_COMPLETED";
}

function derivePublishedLineupFetchArtifact(game, diagnostics, artifacts) {
  if (artifactReady(artifacts.lineup_fetch)) return null;
  const persistedState = String(first(game, "workflowState", "workflow_state", "state") || "").trim().toLowerCase();
  const downstreamReady = ["lineup_finalize", "scoring", "ranking_reflect", "publish"].some((stageName) => artifactReady(artifacts[stageName]));
  if (!lineupFetchCompleted(diagnostics) && !(persistedState === "published" && downstreamReady)) return null;
  return {
    available: true,
    valid: true,
    fresh: true,
    source: lineupFetchCompleted(diagnostics) ? "normal_admin_overview" : "derived_from_published_artifact",
    capturedAt: null,
    fingerprint: null,
    verificationStatus: "verified",
    internalGameId: first(game, "internalGameId", "internal_game_id"),
    rowCount: null,
    reason: "LINEUP_FETCH_COMPLETED",
    blockingReason: null,
    nextSafeAction: "no_op"
  };
}

export function adaptV35Input({ game = {}, jobs = [], artifacts = {}, diagnostics = {}, now = new Date(), externalFlags = {}, automationMode = null, operationalMode = null, env = {}, canonicalArtifacts = null } = {}) {
  const normalizedGame = objectOrEmpty(game);
  const normalizedDiagnostics = objectOrEmpty(diagnostics);
  const derivedStageSchedule = deriveV35StageDueSchedule({ game: normalizedGame });
  const internalGameId = first(normalizedGame, "internalGameId", "internal_game_id");
  const gameStatus = first(normalizedGame, "gameStatus", "game_status") || "scheduled";
  const persistedWorkflowState = first(normalizedGame, "workflowState", "workflow_state", "state") || "scheduled";
  const resolvedOperationalMode = resolveV35OperationalMode({ automationMode, operationalMode, env });
  const normalizedJobs = (Array.isArray(jobs) ? jobs : []).map(normalizeJob);
  const evaluatorArtifacts = {};
  const warnings = [];
  const informationalNotices = [];
  const artifactSummary = {};
  for (const stageName of STAGES) {
    const artifact = findArtifact({ artifacts, externalFlags }, stageName, normalizedDiagnostics, normalizedGame);
    if (artifact) {
      evaluatorArtifacts[stageName] = artifact;
      artifactSummary[stageName] = {
        available: artifact.available,
        valid: artifact.valid,
        source: artifact.source,
        reason: artifact.reason || null
      };
      if (artifact.reason === "ROSTER_SNAPSHOT_MISSING") {
        if (resolvedOperationalMode.isV4SemiAuto && stageName === "roster_fetch") {
          informationalNotices.push(warning("V4_MANUAL_ROSTER_SNAPSHOT_NOT_REQUIRED", "V4 manual roster運用では、roster snapshotは正式処理の成立条件ではありません。", stageName));
        } else {
          warnings.push(warning("ROSTER_SNAPSHOT_MISSING", "Formal roster snapshot is missing.", stageName));
        }
      }
    }
  }
  const derivedLineupFetchArtifact = derivePublishedLineupFetchArtifact(normalizedGame, normalizedDiagnostics, evaluatorArtifacts);
  if (derivedLineupFetchArtifact) {
    evaluatorArtifacts.lineup_fetch = derivedLineupFetchArtifact;
    artifactSummary.lineup_fetch = {
      available: true,
      valid: true,
      source: derivedLineupFetchArtifact.source,
      reason: derivedLineupFetchArtifact.reason
    };
  }
  Object.assign(evaluatorArtifacts, toCanonicalArtifactStageArtifacts(canonicalArtifacts));
  const externalDisabled = externalFetchDisabled({ externalFlags }, normalizedDiagnostics, normalizedGame);
  const cancellation = cancellationInfo(normalizedGame, { cancellationInfo: first(normalizedGame, "cancellationInfo", "cancellation_info") });
  const excluded = cancellation.excluded;
  if (!internalGameId) warnings.push(warning("INTERNAL_GAME_ID_MISSING", "The game has no internalGameId."));
  if (!derivedStageSchedule.available) warnings.push(warning("STAGE_DUE_SCHEDULE_UNAVAILABLE", "Game start time is unavailable, so derived stage due times cannot be evaluated."));
  const unknownJobs = normalizedJobs.filter((job) => !STAGES.includes(job.stageName));
  if (unknownJobs.length) warnings.push(warning("UNKNOWN_JOB_STAGE", "Some jobs could not be mapped to a V3.5 stage."));
  if (externalDisabled) warnings.push(warning("NPB_FETCH_DISABLED", "External NPB fetching is disabled."));
  if (!resolvedOperationalMode.isV4SemiAuto && evaluatorArtifacts.roster_fetch?.publicUsable && !evaluatorArtifacts.roster_fetch?.canonicalSnapshotAvailable) {
    warnings.push(warning("PUBLIC_ROSTER_WITHOUT_FORMAL_SNAPSHOT", "Public roster data is usable, but the formal canonical snapshot is missing.", "roster_fetch"));
  }
  const planningState = buildV3PlanningState({
    game: normalizedGame,
    jobs: normalizedJobs,
    artifacts: evaluatorArtifacts,
    effectiveState: first(normalizedDiagnostics, "effectiveState", "effective_state"),
    persistedState: persistedWorkflowState,
    now
  });
  const planningPlans = buildStagePlans(planningState, undefined, {
    disabledStages: resolvedOperationalMode.isV4SemiAuto
      ? resolvedOperationalMode.diagnosticManualStages
      : resolvedOperationalMode.disabledStages,
    disabledReason: "V4_AUTO_FETCH_DISABLED"
  });
  const stageDefinitions = buildStageDefinitions(
    { artifacts, externalFlags, currentTime: now },
    normalizedDiagnostics,
    evaluatorArtifacts,
    externalDisabled,
    normalizedGame,
    normalizedJobs,
    derivedStageSchedule,
    planningState,
    resolvedOperationalMode
  );
  for (const plan of planningPlans) {
    if (plan.blocked && stageDefinitions[plan.stage]) {
      stageDefinitions[plan.stage] = {
        ...stageDefinitions[plan.stage],
        prerequisiteMet: false,
        prerequisiteReason: stageDefinitions[plan.stage].prerequisiteReason || plan.blockedReason,
        planningPlan: plan
      };
    } else if (stageDefinitions[plan.stage]) {
      stageDefinitions[plan.stage] = {
        ...stageDefinitions[plan.stage],
        ...(plan.shouldCreateJob && ["PREDICTION_CLOSE_STATE_GATE", "LINEUP_FETCH_WINDOW_CLOSED_NO_FINALIZE"].includes(stageDefinitions[plan.stage].prerequisiteReason)
          ? { prerequisiteMet: true, prerequisiteReason: null }
          : {}),
        planningPlan: plan
      };
    }
  }
  const scheduleRegistered = Boolean(
    first(normalizedGame, "scheduleRegistered", "schedule_registered")
    ?? normalizedGame.gameDate
    ?? normalizedGame.game_date
  );
  return {
    evaluatorInput: {
      internalGameId,
      gameStatus,
      persistedWorkflowState,
      startAt: first(normalizedGame, "startAt", "start_at", "gameStartAt", "game_start_at"),
      currentTime: now,
      stageDefinitions,
      derivedStageSchedule,
      jobs: normalizedJobs,
      artifacts: evaluatorArtifacts,
      cancellationInfo: cancellation,
      excluded,
      rankingExcluded: Boolean(first(normalizedGame, "rankingExcluded", "ranking_excluded")),
      scheduleRegistered,
      externalFlags: { ...externalFlags, NPB_FETCH_DISABLED: externalDisabled },
      planningPlans,
      operationalMode: resolvedOperationalMode
    },
    warnings,
    informationalNotices,
    operationalMode: resolvedOperationalMode,
    sourceSummary: {
      game: {
        internalGameIdPresent: Boolean(internalGameId),
        gameStatus,
        persistedWorkflowState,
        startAt: first(normalizedGame, "startAt", "start_at", "gameStartAt", "game_start_at")
      },
      jobs: {
        inputCount: Array.isArray(jobs) ? jobs.length : 0,
        normalizedCount: normalizedJobs.length,
        unknownCount: unknownJobs.length,
        byStage: normalizedJobs.reduce((summary, job) => {
          const key = job.stageName || "unknown";
          summary[key] = (summary[key] || 0) + 1;
          return summary;
        }, {})
      },
      artifacts: artifactSummary,
      diagnostics: {
        provided: Object.keys(normalizedDiagnostics).length > 0,
        keys: Object.keys(normalizedDiagnostics)
      },
      derivedStageSchedule,
      externalFetchDisabled: externalDisabled,
      cancellation,
      warningCount: warnings.length,
      informationalNoticeCount: informationalNotices.length
    }
  };
}
