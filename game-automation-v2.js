// Canonical domain rules for the server-side game automation pipeline.
// Persistence and external fetches stay in the Worker; this module only
// defines deterministic timing, state transitions, and revision decisions.

export const AUTOMATION_V2_TIMING = Object.freeze({
  predictionDeadlineMinutes: 60,
  lineupPollingStartMinutes: 50,
  finalLineupMinutesAfterStart: 2,
  publicationMinutesAfterStart: 10,
  lineupPollingIntervalMinutes: 10,
  rosterRegularIntervalMinutes: 24 * 60,
  rosterPregameMinutes: 120,
  rosterSecondPregameMinutes: 110,
  rosterDailySlotsJst: Object.freeze(["16:02", "16:10"])
});

export const AUTOMATION_V2_STATES = Object.freeze([
  "scheduled",
  "prediction_open",
  "prediction_closed",
  "lineup_polling",
  "lineup_candidate_captured",
  "final_lineup_pending",
  "final_lineup_confirmed",
  "scoring_pending",
  "scoring_in_progress",
  "scored",
  "ranking_update_pending",
  "ranking_reflected",
  "publication_pending",
  "published",
  "ranking_exclusion_pending",
  "ranking_excluded",
  "publication_update_pending",
  "publication_updated",
  "ranking_reinclusion_pending",
  "lineup_correction_pending",
  "corrected_lineup_confirmed",
  "rescoring_pending",
  "rescoring_in_progress",
  "rescored",
  "republication_pending",
  "manual_intervention_required",
  "service_unavailable"
]);

export const AUTOMATION_V2_LEGACY_STATE_MAP = Object.freeze({
  waiting: "scheduled",
  prediction_open: "prediction_open",
  prediction_closed: "prediction_closed",
  lineup_pending: "final_lineup_pending",
  provisional_lineup_captured: "lineup_candidate_captured",
  final_lineup_captured: "final_lineup_confirmed",
  scoring_pending: "scoring_pending",
  scored_private: "scored",
  published: "published",
  retrying: "manual_intervention_required",
  service_unavailable: "service_unavailable",
  manual_intervention_required: "manual_intervention_required",
  rescore_pending: "rescoring_pending"
});

export function canonicalAutomationStateFromLegacy(value) {
  return AUTOMATION_V2_LEGACY_STATE_MAP[String(value || "scheduled")] || String(value || "scheduled");
}

const AUTOMATION_V2_TRANSITIONS = Object.freeze({
  scheduled: new Set(["prediction_open", "manual_intervention_required"]),
  prediction_open: new Set(["prediction_closed", "lineup_polling", "manual_intervention_required"]),
  prediction_closed: new Set(["lineup_polling", "manual_intervention_required"]),
  lineup_polling: new Set(["lineup_candidate_captured", "final_lineup_pending", "manual_intervention_required"]),
  lineup_candidate_captured: new Set(["lineup_polling", "final_lineup_pending", "manual_intervention_required"]),
  final_lineup_pending: new Set(["final_lineup_confirmed", "manual_intervention_required"]),
  final_lineup_confirmed: new Set(["scoring_pending", "manual_intervention_required"]),
  scoring_pending: new Set(["scoring_in_progress", "scored", "manual_intervention_required"]),
  scoring_in_progress: new Set(["scored", "manual_intervention_required"]),
  scored: new Set(["ranking_update_pending", "ranking_reflected", "manual_intervention_required"]),
  ranking_update_pending: new Set(["ranking_reflected", "manual_intervention_required"]),
  ranking_reflected: new Set(["publication_pending", "published", "manual_intervention_required"]),
  publication_pending: new Set(["published", "manual_intervention_required"]),
  published: new Set(["lineup_correction_pending", "ranking_exclusion_pending", "manual_intervention_required"]),
  ranking_exclusion_pending: new Set(["ranking_excluded", "manual_intervention_required"]),
  ranking_excluded: new Set(["publication_update_pending", "ranking_reinclusion_pending", "manual_intervention_required"]),
  publication_update_pending: new Set(["publication_updated", "published", "manual_intervention_required"]),
  publication_updated: new Set(["published", "lineup_correction_pending", "ranking_reinclusion_pending", "manual_intervention_required"]),
  ranking_reinclusion_pending: new Set(["ranking_reflected", "manual_intervention_required"]),
  lineup_correction_pending: new Set(["corrected_lineup_confirmed", "manual_intervention_required"]),
  corrected_lineup_confirmed: new Set(["rescoring_pending", "manual_intervention_required"]),
  rescoring_pending: new Set(["rescoring_in_progress", "rescored", "manual_intervention_required"]),
  rescoring_in_progress: new Set(["rescored", "manual_intervention_required"]),
  rescored: new Set(["ranking_update_pending", "ranking_reflected", "manual_intervention_required"]),
  manual_intervention_required: new Set(["lineup_polling", "final_lineup_pending", "lineup_correction_pending", "rescoring_pending"]),
  service_unavailable: new Set(["lineup_polling", "final_lineup_pending", "scoring_pending", "manual_intervention_required"])
});

export function isAutomationV2StateTransitionAllowed(from, to) {
  const current = String(from || "scheduled");
  const next = String(to || "");
  return current === next || Boolean(AUTOMATION_V2_TRANSITIONS[current]?.has(next));
}

export function assertAutomationV2StateTransition(from, to) {
  if (!isAutomationV2StateTransitionAllowed(from, to)) {
    const error = new Error(`自動運転状態を ${from || "scheduled"} から ${to || ""} へ変更できません。`);
    error.code = "AUTOMATION_V2_STATE_TRANSITION_INVALID";
    throw error;
  }
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

export function deriveAutomationSchedule({
  internalGameId = "",
  gameDate = "",
  startAt = "",
  homeTeam = "",
  awayTeam = "",
  npbGameCode = "",
  status = "scheduled",
  updatedBy = "system",
  updatedAt = ""
} = {}) {
  const start = asDate(startAt);
  const date = String(gameDate || "").trim();
  if (!internalGameId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !start) return null;
  const minutes = (offset) => new Date(start.getTime() + offset * 60 * 1000);
  return {
    internalGameId: String(internalGameId),
    gameDate: date,
    startAt: start.toISOString(),
    homeTeam: String(homeTeam || "").trim().toLowerCase(),
    awayTeam: String(awayTeam || "").trim().toLowerCase(),
    npbGameCode: String(npbGameCode || "").trim().toLowerCase(),
    status: String(status || "scheduled"),
    updatedBy: String(updatedBy || "system"),
    updatedAt: String(updatedAt || ""),
    predictionDeadline: minutes(-AUTOMATION_V2_TIMING.predictionDeadlineMinutes).toISOString(),
    rosterFetchAt1: minutes(-AUTOMATION_V2_TIMING.rosterPregameMinutes).toISOString(),
    rosterFetchAt2: minutes(-AUTOMATION_V2_TIMING.rosterSecondPregameMinutes).toISOString(),
    lineupPollingStart: minutes(-AUTOMATION_V2_TIMING.lineupPollingStartMinutes).toISOString(),
    finalLineupAt: minutes(AUTOMATION_V2_TIMING.finalLineupMinutesAfterStart).toISOString(),
    publicationAt: minutes(AUTOMATION_V2_TIMING.publicationMinutesAfterStart).toISOString()
  };
}

export function getLineupPollingSlot(schedule, now = new Date()) {
  const start = asDate(schedule?.startAt);
  const pollingStart = asDate(schedule?.lineupPollingStart);
  const current = asDate(now);
  if (!start || !pollingStart || !current || current < pollingStart) return null;
  const elapsed = Math.floor((current.getTime() - pollingStart.getTime()) / 60000);
  const slot = Math.floor(elapsed / AUTOMATION_V2_TIMING.lineupPollingIntervalMinutes);
  return new Date(pollingStart.getTime() + slot * AUTOMATION_V2_TIMING.lineupPollingIntervalMinutes * 60000).toISOString();
}

export function getPredictionDeadlineState(schedule, now = new Date()) {
  const deadline = asDate(schedule?.predictionDeadline);
  const current = asDate(now);
  if (!deadline || !current) return { ok: false, code: "SCHEDULE_START_AT_UNAVAILABLE" };
  return {
    ok: true,
    deadlineAt: deadline.toISOString(),
    isClosed: current.getTime() >= deadline.getTime(),
    code: current.getTime() >= deadline.getTime() ? "PREDICTION_DEADLINE_PASSED" : "PREDICTION_DEADLINE_OPEN"
  };
}

export function getRosterExecutorDecision(schedule, state = {}, now = new Date()) {
  const start = asDate(schedule?.startAt);
  const current = asDate(now);
  if (!start || !current) return { due: false, reason: "SCHEDULE_START_AT_UNAVAILABLE" };
  if (current >= start) return { due: false, reason: "AFTER_START" };
  const dailySlot = getRosterDailySlot(current, schedule?.gameDate || schedule?.date);
  if (dailySlot && state?.lastSuccessfulFetchSlot !== dailySlot) {
    return { due: true, kind: "daily_slot", slot: dailySlot };
  }
  const next = asDate(state?.nextCheckAt);
  if (next && current < next) return { due: false, reason: "RETRY_WAIT" };
  const pregame = new Date(start.getTime() - AUTOMATION_V2_TIMING.rosterPregameMinutes * 60000);
  const secondPregame = new Date(start.getTime() - AUTOMATION_V2_TIMING.rosterSecondPregameMinutes * 60000);
  if (current >= pregame && current < secondPregame && state?.lastPregameCheckGameId !== state?.gameId) {
    return { due: true, kind: "pregame" };
  }
  if (current >= secondPregame && state?.lastPregameCheckGameId !== `${state?.gameId}:110`) {
    return { due: true, kind: "pregame" };
  }
  const last = asDate(state?.lastSuccessfulFetchAt);
  if (!last || current.getTime() - last.getTime() >= AUTOMATION_V2_TIMING.rosterRegularIntervalMinutes * 60000) {
    return { due: true, kind: "daily" };
  }
  return { due: false, reason: "DAILY_INTERVAL" };
}

export function getRosterDailySlot(now = new Date(), gameDate = "") {
  const current = asDate(now);
  if (!current || !/^\d{4}-\d{2}-\d{2}$/.test(String(gameDate || ""))) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(current);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  if (`${values.year}-${values.month}-${values.day}` !== String(gameDate)) return "";
  const currentMinutes = Number(values.hour || 0) * 60 + Number(values.minute || 0);
  const slots = AUTOMATION_V2_TIMING.rosterDailySlotsJst
    .map((slot) => ({ slot, minutes: Number(slot.slice(0, 2)) * 60 + Number(slot.slice(3)) }))
    .filter((entry) => entry.minutes <= currentMinutes)
    .sort((left, right) => right.minutes - left.minutes);
  return slots.length ? `${gameDate}:${slots[0].slot}` : "";
}

export function getFinalLineupDecision(schedule, now = new Date()) {
  const finalAt = asDate(schedule?.finalLineupAt);
  const current = asDate(now);
  if (!finalAt || !current) return { due: false, reason: "SCHEDULE_START_AT_UNAVAILABLE" };
  return current >= finalAt
    ? { due: true, state: "final_lineup_pending" }
    : { due: false, reason: "FINAL_LINEUP_NOT_DUE" };
}

export function validateLineupRevision(lineup, { internalGameId = "", allowUnresolvedPlayer = false } = {}) {
  const rows = Array.isArray(lineup) ? lineup : [];
  const orders = rows.map((row) => Number(row?.order ?? row?.battingOrder ?? row?.orderNo));
  const playerIds = rows.map((row) => String(row?.playerId ?? row?.player_id ?? "").trim());
  const playerNames = rows.map((row) => String(row?.playerName ?? row?.player_name ?? "").trim());
  const positions = rows.map((row) => String(row?.position ?? row?.defensivePosition ?? "").trim());
  const validOrders = rows.length === 9 && orders.every((value, index) => value === index + 1);
  const knownPlayerIds = playerIds.filter(Boolean);
  const validPlayers = playerIds.every((value, index) => value || (allowUnresolvedPlayer && playerNames[index]))
    && new Set(knownPlayerIds).size === knownPlayerIds.length;
  const validPositions = positions.every(Boolean);
  const validInternalIds = rows.every((row) => !row?.internalGameId || String(row.internalGameId) === String(internalGameId));
  return {
    valid: validOrders && validPlayers && validPositions && validInternalIds,
    playerCount: rows.length,
    unresolvedPlayerCount: playerIds.filter((value) => !value).length,
    ordersValid: validOrders,
    playersValid: validPlayers,
    positionsValid: validPositions,
    internalGameIdsValid: validInternalIds,
    reason: !validOrders ? "ORDER_INVALID" : !validPlayers ? "PLAYER_INVALID" : !validPositions ? "POSITION_INVALID" : !validInternalIds ? "INTERNAL_GAME_ID_MISMATCH" : "VALID"
  };
}

export function shouldCreateScoringRevision({ lineupRevisionId = "", activeScoringLineupRevisionId = "", scoringStatus = "" } = {}) {
  if (!lineupRevisionId) return { due: false, reason: "LINEUP_REVISION_REQUIRED" };
  if (String(lineupRevisionId) === String(activeScoringLineupRevisionId || "") && scoringStatus === "scored") {
    return { due: false, reason: "ALREADY_SCORED_FOR_LINEUP_REVISION" };
  }
  return { due: true, scoringRevision: 1 };
}

export function getProbableStarterSourceDate({ now = new Date(), currentGameStartAt = "", nextGameDate = "" } = {}) {
  const current = asDate(now);
  if (!current) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(current);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const today = `${values.year}-${values.month}-${values.day}`;
  const hour = Number(values.hour || 0);
  const start = asDate(currentGameStartAt);
  if (start && current >= start && nextGameDate) return String(nextGameDate);
  if (hour >= 18) {
    const tomorrow = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + 1));
    return tomorrow.toISOString().slice(0, 10);
  }
  return today;
}

export function createAutomationExecutors({ probableStarter, roster, lineup, scoring, rescore } = {}) {
  const executors = { probableStarter, roster, lineup, scoring, rescore };
  return Object.freeze({
    async run(name, context) {
      const executor = executors[name];
      if (typeof executor !== "function") {
        const error = new Error(`自動処理executorが未登録です: ${name}`);
        error.code = "AUTOMATION_EXECUTOR_NOT_REGISTERED";
        throw error;
      }
      return executor(context);
    }
  });
}
