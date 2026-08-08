// Scoring and ranking eligibility rules are kept separate from fetch and
// publication code so a cancelled game cannot be mistaken for a zero score.

export const RANKING_ELIGIBILITY_STATUS = Object.freeze({
  ELIGIBLE: "eligible",
  EXCLUDED: "excluded",
  PENDING_ADMIN_DECISION: "pending_admin_decision"
});

export const RANKING_ELIGIBILITY_REASONS = Object.freeze([
  "cancelled_before_start",
  "cancelled_after_start",
  "no_game",
  "postponed",
  "data_invalid",
  "official_correction",
  "admin_decision",
  "other"
]);

export const SCORING_EXCLUSION_REASONS = Object.freeze([
  "INVALID_PREDICTION",
  "INCOMPLETE_LINEUP",
  "DUPLICATE_PLAYER",
  "SAVED_AFTER_DEADLINE",
  "TEST_PREDICTION",
  "USER_NOT_ELIGIBLE"
]);

export function normalizeRankingEligibilityStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  return Object.values(RANKING_ELIGIBILITY_STATUS).includes(status)
    ? status
    : RANKING_ELIGIBILITY_STATUS.ELIGIBLE;
}

export function normalizeRankingEligibilityReason(value) {
  const reason = String(value || "").trim().toLowerCase();
  return RANKING_ELIGIBILITY_REASONS.includes(reason) ? reason : "other";
}

export function deriveInitialRankingEligibility({ gameStatus = "scheduled", startAt = "", now = new Date() } = {}) {
  const status = String(gameStatus || "scheduled").trim().toLowerCase();
  if (status === "postponed") return { status: "excluded", eligible: false, reason: "postponed" };
  if (status === "cancelled") {
    const start = new Date(startAt || "");
    const current = now instanceof Date ? now : new Date(now);
    return {
      status: "excluded",
      eligible: false,
      reason: Number.isNaN(start.getTime()) || current < start ? "cancelled_before_start" : "cancelled_after_start"
    };
  }
  return { status: "eligible", eligible: true, reason: null };
}

export function isRankingAggregationEligible({ rankingEligible = false, eligibilityStatus = "eligible", gameStatus = "", scoringStatus = "" } = {}) {
  return Boolean(rankingEligible)
    && normalizeRankingEligibilityStatus(eligibilityStatus) === "eligible"
    && String(gameStatus || "") === "scored"
    && String(scoringStatus || "") === "completed";
}

export function canCreateScoringRevision({ rankingEligibilityStatus = "eligible", lineupRevisionId = "", activeLineupRevisionId = "", activeRevisionStatus = "" } = {}) {
  if (normalizeRankingEligibilityStatus(rankingEligibilityStatus) !== "eligible") {
    return { allowed: false, reasonCode: "RANKING_GAME_EXCLUDED" };
  }
  if (!lineupRevisionId) return { allowed: false, reasonCode: "LINEUP_REVISION_REQUIRED" };
  if (String(lineupRevisionId) === String(activeLineupRevisionId || "") && activeRevisionStatus === "completed") {
    return { allowed: false, reasonCode: "SCORING_REVISION_ALREADY_COMPLETED" };
  }
  return { allowed: true };
}

export function isScoringComplete({ eligiblePredictionCount = 0, scoredPredictionCount = 0, excludedPredictionCount = 0, failedPredictionCount = 0 } = {}) {
  if (Number(failedPredictionCount) !== 0) return false;
  if (Number(eligiblePredictionCount) === 0) return true;
  return Number(eligiblePredictionCount) === Number(scoredPredictionCount) + Number(excludedPredictionCount);
}

export function getRankingReflectionKey({ internalGameId = "", scoringRevisionId = "", rankingEligibilityVersion = 0 } = {}) {
  return `${String(internalGameId)}:${String(scoringRevisionId)}:${Number(rankingEligibilityVersion || 0)}`;
}

export function isPredictionEligible({ valid = false, complete = false, duplicatePlayer = false, duplicateOrder = false, savedBeforeDeadline = true, isTestPrediction = false, userEligible = true } = {}) {
  if (isTestPrediction) return { eligible: false, reason: "TEST_PREDICTION" };
  if (!userEligible) return { eligible: false, reason: "USER_NOT_ELIGIBLE" };
  if (!savedBeforeDeadline) return { eligible: false, reason: "SAVED_AFTER_DEADLINE" };
  if (!complete) return { eligible: false, reason: "INCOMPLETE_LINEUP" };
  if (duplicatePlayer) return { eligible: false, reason: "DUPLICATE_PLAYER" };
  if (duplicateOrder) return { eligible: false, reason: "DUPLICATE_ORDER" };
  if (!valid) return { eligible: false, reason: "INVALID_PREDICTION" };
  return { eligible: true, reason: null };
}
