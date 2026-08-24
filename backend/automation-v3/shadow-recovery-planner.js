// V3.5 Phase 2: derive-only recovery intents for diagnostics.
// This module never creates jobs, changes state, writes data, or calls runtime services.

const STAGE_ORDER = Object.freeze([
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

const FETCH_STAGES = new Set([
  "probable_starter",
  "roster_fetch",
  "npb_game_identify",
  "lineup_fetch"
]);

const RECOVERABLE_HEALTH = new Set([
  "MISSING_JOB",
  "TERMINAL_FAILED",
  "COMPLETED_ARTIFACT_MISSING",
  "RETRY_WAIT_DUE",
  "RECOVERY_RECOMMENDED"
]);

function first(object, ...keys) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
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

function gameStatusOf(game, diagnostics) {
  const status = normalize(first(game, "gameStatus", "game_status"));
  const effectiveState = normalize(diagnostics.effectiveState);
  const excluded = Boolean(first(game, "excluded", "isExcluded")) || status === "excluded" || effectiveState === "excluded";
  if (excluded) return "game_excluded";
  if (status === "postponed" || effectiveState === "postponed") return "game_postponed";
  if (status === "cancelled" || status === "canceled" || status === "no_game" || status === "service_unavailable" || effectiveState === "cancelled") {
    return "game_cancelled";
  }
  return null;
}

function isPublished(game, diagnostics, stages) {
  const effectiveState = normalize(diagnostics.effectiveState || game.persistedWorkflowState);
  const persistedState = normalize(diagnostics.persistedState || game.persistedWorkflowState);
  return effectiveState === "published"
    || persistedState === "published"
    || stages.publish?.healthStatus === "COMPLETED_ARTIFACT_READY";
}

function priorityFor(healthStatus) {
  return RECOVERABLE_HEALTH.has(healthStatus) ? "high" : "normal";
}

function safeAfterFor(item, now) {
  return iso(item?.dueAt || item?.selectedSlot) || iso(now);
}

function idempotencyKeyFor({ gameId, stage, item }) {
  const slot = item?.selectedSlot || item?.dueAt || "unscheduled";
  return `shadow:${gameId || "unknown-game"}:${stage}:${JOB_TYPE_BY_STAGE[stage] || stage}:${slot}`;
}

function planItem({ game, stage, item, reason, actionType, blocked, blockedReason, now }) {
  return {
    stage,
    actionType,
    jobType: JOB_TYPE_BY_STAGE[stage] || null,
    reason,
    priority: priorityFor(item?.healthStatus),
    safeAfter: safeAfterFor(item, now),
    blocked: Boolean(blocked),
    blockedReason: blockedReason || null,
    idempotencyKey: idempotencyKeyFor({
      gameId: first(game, "internalGameId", "internal_game_id"),
      stage,
      item
    })
  };
}

function reasonFor(item) {
  return item?.blockingReason
    || item?.recoveryReason
    || item?.artifactHealth?.reason
    || item?.healthStatus
    || "RECOVERY_RECOMMENDED";
}

function addNoAction(noActionReasons, reason) {
  if (reason && !noActionReasons.includes(reason)) noActionReasons.push(reason);
}

function stagePlan({ game, stage, item, flags, now, noActionReasons }) {
  const healthStatus = String(item?.healthStatus || "").trim();
  if (!healthStatus) return null;
  if (["NOT_DUE", "RETRY_WAIT_NOT_DUE"].includes(healthStatus)) {
    addNoAction(noActionReasons, `${stage}:wait`);
    return null;
  }
  if (["COMPLETED_ARTIFACT_READY", "OPEN_JOB_EXISTS", "READY_TO_CLAIM", "DUE", "TERMINAL_CANCELLED"].includes(healthStatus)) {
    addNoAction(noActionReasons, `${stage}:no_action`);
    return null;
  }
  if (healthStatus === "BLOCKED_BY_PREREQUISITE") {
    return {
      blocked: true,
      plan: planItem({
        game,
        stage,
        item,
        reason: reasonFor(item),
        actionType: "would_wait_for_prerequisite",
        blocked: true,
        blockedReason: reasonFor(item),
        now
      })
    };
  }
  if (healthStatus === "BLOCKED_BY_CANCELLED") {
    addNoAction(noActionReasons, "game_cancelled");
    return null;
  }
  if (healthStatus === "BLOCKED_BY_EXTERNAL_FETCH_DISABLED") {
    return {
      blocked: true,
      plan: planItem({
        game,
        stage,
        item,
        reason: "external_fetch_disabled",
        actionType: "would_schedule_recovery_job",
        blocked: true,
        blockedReason: "external_fetch_disabled",
        now
      })
    };
  }
  if (healthStatus === "BLOCKED_BY_MANUAL_ATTENTION") {
    return {
      blocked: true,
      plan: planItem({
        game,
        stage,
        item,
        reason: "manual_attention",
        actionType: "would_schedule_recovery_job",
        blocked: true,
        blockedReason: "manual_attention",
        now
      })
    };
  }
  if (healthStatus === "RETRY_WAIT_DUE") {
    return {
      blocked: false,
      plan: planItem({
        game,
        stage,
        item,
        reason: reasonFor(item),
        actionType: "would_requeue_or_claim_retry",
        blocked: false,
        now
      })
    };
  }
  if (RECOVERABLE_HEALTH.has(healthStatus) || item?.recoveryRecommended) {
    const blockedByFlag = flags.externalFetchDisabled && FETCH_STAGES.has(stage);
    const blockedByManualAttention = flags.manualAttention;
    const blockedReason = blockedByFlag
      ? "external_fetch_disabled"
      : blockedByManualAttention
        ? "manual_attention"
        : null;
    return {
      blocked: Boolean(blockedReason),
      plan: planItem({
        game,
        stage,
        item,
        reason: blockedReason || reasonFor(item),
        actionType: "would_schedule_recovery_job",
        blocked: Boolean(blockedReason),
        blockedReason,
        now
      })
    };
  }
  addNoAction(noActionReasons, `${stage}:unrecognized_status`);
  return null;
}

export function planShadowRecovery({
  game = {},
  derivedDiagnostics = {},
  now = null,
  flags = {}
} = {}) {
  const diagnostics = derivedDiagnostics || {};
  const stages = diagnostics.stages && typeof diagnostics.stages === "object" ? diagnostics.stages : {};
  const normalizedFlags = {
    externalFetchDisabled: Boolean(flags.externalFetchDisabled),
    manualAttention: Boolean(flags.manualAttention)
  };
  const recommendations = [];
  const blockedRecommendations = [];
  const noActionReasons = [];
  const cancellationReason = gameStatusOf(game, diagnostics);
  const currentTime = asDate(now);

  if (cancellationReason) {
    return {
      mode: "shadow_read_only",
      canExecute: false,
      hasRecommendedActions: false,
      recommendations,
      blockedRecommendations,
      noActionReasons: [cancellationReason]
    };
  }
  if (isPublished(game, diagnostics, stages)) {
    return {
      mode: "shadow_read_only",
      canExecute: false,
      hasRecommendedActions: false,
      recommendations,
      blockedRecommendations,
      noActionReasons: ["already_published"]
    };
  }

  for (const stage of STAGE_ORDER) {
    if (stage === "schedule_registration") {
      addNoAction(noActionReasons, `${stage}:no_action`);
      continue;
    }
    if (["ranking_reflect", "publish"].includes(stage) && (game.rankingExcluded || game.ranking_excluded)) {
      addNoAction(noActionReasons, "ranking_excluded");
      continue;
    }
    const planned = stagePlan({
      game,
      stage,
      item: stages[stage],
      flags: normalizedFlags,
      now: currentTime,
      noActionReasons
    });
    if (!planned) continue;
    if (planned.blocked) blockedRecommendations.push(planned.plan);
    else recommendations.push(planned.plan);
  }

  if (normalizedFlags.manualAttention && !noActionReasons.includes("manual_attention")) addNoAction(noActionReasons, "manual_attention");
  if (normalizedFlags.externalFetchDisabled && !noActionReasons.includes("external_fetch_disabled")) addNoAction(noActionReasons, "external_fetch_disabled");
  return {
    mode: "shadow_read_only",
    canExecute: false,
    hasRecommendedActions: recommendations.length > 0,
    recommendations,
    blockedRecommendations,
    noActionReasons
  };
}

export const buildShadowRecoveryPlan = planShadowRecovery;
