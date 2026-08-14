/**
 * Ranking domain rules that do not require a database or HTTP request.
 */

export const DEFAULT_HIDE_INELIGIBLE_RANKINGS = false;

export function calculateRankingGamesNeeded(participated, total) {
  const participatedCount = Math.max(0, Number(participated) || 0);
  const totalCount = Math.max(0, Number(total) || 0);
  return Math.max(0, 2 * totalCount - 3 * participatedCount);
}

export function shouldDisplayRankingRow(row, { hideIneligibleRankings = DEFAULT_HIDE_INELIGIBLE_RANKINGS } = {}) {
  return !hideIneligibleRankings || Boolean(row?.isQualified);
}

export function selectRankingRowsForDisplay(rows = [], options = {}) {
  return (Array.isArray(rows) ? rows : []).filter((row) => shouldDisplayRankingRow(row, options));
}

export function toPublicRankingRow(row, achievementSummary = null) {
  const eligibleGames = Number(row?.eligible_games || 0);
  const gamesPlayed = Number(row?.games_played || 0);
  const isQualified = Number(row?.is_qualified) === 1;
  return {
    rank: isQualified ? Number(row?.ranking_rank) : null,
    username: row?.username,
    gamesPlayed,
    eligibleGames,
    requiredGames: Number(row?.required_games || 0),
    participationRate: eligibleGames > 0 ? gamesPlayed / eligibleGames : 0,
    isQualified,
    gamesNeeded: calculateRankingGamesNeeded(gamesPlayed, eligibleGames),
    totalScore: Number(row?.total_score || 0),
    averageScore: Number(row?.average_score || 0),
    perfectCount: Number(row?.perfect_count || 0),
    bestScore: Number(row?.best_score || 0),
    lastScoredAt: row?.last_scored_at || null,
    ...(achievementSummary ? achievementSummary : {})
  };
}

export function getRankingResetDateBoundary(value) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

// Public ranking cutoffs use the same JST calendar-day boundary as the
// existing non-destructive reset markers.
export function getRankingCutoffBoundary(value) {
  return getRankingResetDateBoundary(value);
}

export function getEffectiveRankingCutoffBoundary({ releaseCutoffAt = "", resetAt = "" } = {}) {
  return [
    getRankingCutoffBoundary(releaseCutoffAt),
    getRankingCutoffBoundary(resetAt)
  ].filter(Boolean).sort().at(-1) || "";
}

function formatCalendarDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function getJstWeekRange(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const jstCalendarDate = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  const daysSinceMonday = (jstCalendarDate.getUTCDay() + 6) % 7;
  const startDate = new Date(jstCalendarDate);
  startDate.setUTCDate(startDate.getUTCDate() - daysSinceMonday);
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 7);
  const startAt = formatCalendarDate(startDate);
  const endAt = formatCalendarDate(endDate);

  return {
    periodType: "weekly",
    periodKey: startAt,
    startAt,
    endAt,
    startAtUtc: new Date(`${startAt}T00:00:00+09:00`).toISOString(),
    endAtUtc: new Date(`${endAt}T00:00:00+09:00`).toISOString()
  };
}

export function normalizeRankingResetRequest(input = {}) {
  const periodType = String(input.periodType || input.period_type || "").trim().toLowerCase();
  const periodKey = String(input.periodKey || input.period_key || "").trim();
  const resetAt = String(input.resetAt || input.reset_at || "").trim();
  const reason = String(input.reason || "").trim();
  if (!["yearly", "monthly"].includes(periodType)) {
    return { ok: false, code: "RANKING_RESET_PERIOD_INVALID", error: "periodTypeはyearlyまたはmonthlyで指定してください。" };
  }
  const periodPattern = periodType === "yearly" ? /^\d{4}$/ : /^(\d{4})-(0[1-9]|1[0-2])$/;
  if (!periodPattern.test(periodKey)) {
    return { ok: false, code: "RANKING_RESET_PERIOD_INVALID", error: periodType === "yearly" ? "periodKeyはYYYY形式で指定してください。" : "periodKeyはYYYY-MM形式で指定してください。" };
  }
  const resetDate = new Date(resetAt);
  if (!resetAt || Number.isNaN(resetDate.getTime())) {
    return { ok: false, code: "RANKING_RESET_AT_INVALID", error: "resetAtは有効な日時で指定してください。" };
  }
  if (!reason || reason.length > 240) {
    return { ok: false, code: "RANKING_RESET_REASON_REQUIRED", error: "理由を1〜240文字で入力してください。" };
  }
  return {
    ok: true,
    periodType,
    periodKey,
    resetAt: resetDate.toISOString(),
    resetBoundary: getRankingResetDateBoundary(resetDate),
    reason
  };
}

export function getRankingResetConfirmation(periodType, periodKey) {
  return `RESET ${String(periodType || "").toUpperCase()} ${String(periodKey || "")}`;
}
