const INTERNAL_GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// V3 owns its timing contract. Keeping these values here prevents the
// production scheduler from depending on the retired V1/V2 module.
export const V3_TIMING = Object.freeze({
  predictionDeadlineMinutes: 60,
  lineupPollingStartMinutes: 50,
  finalLineupMinutesAfterStart: 2,
  publicationMinutesAfterStart: 10,
  lineupPollingIntervalMinutes: 10,
  rosterPregameMinutes: 120,
  rosterSecondPregameMinutes: 110,
  rosterDailySlotsJst: Object.freeze(["16:02", "16:10"])
});

export const V3_FEATURE_FLAG = "ENABLE_GAME_AUTOMATION_V3";
export const V3_STATES = Object.freeze([
  "scheduled",
  "prediction_closed",
  "lineup_ready",
  "scored",
  "ranked",
  "published",
  "excluded",
  "failed",
  "manual_action_required"
]);
export const V3_JOB_TYPES = Object.freeze([
  "npb_identity_resolve",
  "prediction_close",
  "lineup_fetch",
  "lineup_finalize",
  "score",
  "ranking_rebuild",
  "publish",
  "probable_starter_fetch",
  "roster_fetch"
]);
export const V3_MAIN_JOB_TYPES = Object.freeze([
  "npb_identity_resolve",
  "prediction_close",
  "lineup_fetch",
  "lineup_finalize",
  "score",
  "ranking_rebuild",
  "publish"
]);
export const V3_JOB_STATUSES = Object.freeze([
  "pending",
  "claimed",
  "completed",
  "retry_wait",
  "failed",
  "cancelled"
]);

export function isGameAutomationV3Enabled(env = {}) {
  return ["true", "1", "on", "enabled"].includes(String(env?.[V3_FEATURE_FLAG] || "").trim().toLowerCase());
}

export function normalizeV3InternalGameId(value) {
  const internalGameId = String(value || "").trim();
  if (!INTERNAL_GAME_ID_PATTERN.test(internalGameId)) {
    const error = new Error("V3ジョブにはinternal_game_idが必要です。");
    error.code = "V3_INTERNAL_GAME_ID_REQUIRED";
    throw error;
  }
  return internalGameId;
}

export function deriveV3Schedule(game) {
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  if (Number.isNaN(startAt.getTime())) {
    const error = new Error("DB日程に開始時刻がありません。");
    error.code = "V3_GAME_SCHEDULE_INVALID";
    throw error;
  }
  const minutes = (offset) => new Date(startAt.getTime() + offset * 60 * 1000);
  return {
    startAt,
    predictionDeadline: minutes(-V3_TIMING.predictionDeadlineMinutes),
    rosterFetchAt1: minutes(-V3_TIMING.rosterPregameMinutes),
    rosterFetchAt2: minutes(-V3_TIMING.rosterSecondPregameMinutes),
    lineupPollingStart: minutes(-V3_TIMING.lineupPollingStartMinutes),
    finalLineupAt: minutes(V3_TIMING.finalLineupMinutesAfterStart),
    publicationAt: minutes(V3_TIMING.publicationMinutesAfterStart)
  };
}

function uniqueSortedV3Dates(values) {
  return [...new Map(values.filter((value) => value instanceof Date && !Number.isNaN(value.getTime()))
    .map((value) => [value.toISOString(), value])).values()]
    .sort((left, right) => left.getTime() - right.getTime())
    .map((value) => value.toISOString());
}

export function deriveV3DisplaySchedule(game) {
  const schedule = deriveV3Schedule(game);
  const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10);
  const rosterFetchSlots = [
    new Date(schedule.startAt.getTime() - V3_TIMING.rosterPregameMinutes * 60 * 1000),
    new Date(schedule.startAt.getTime() - V3_TIMING.rosterSecondPregameMinutes * 60 * 1000),
    ...V3_TIMING.rosterDailySlotsJst.map((slot) => {
      const [hour, minute] = String(slot).split(":").map(Number);
      return jstV3Slot(gameDate, hour, minute);
    })
  ];
  const lineupPollingSlots = [];
  for (let slot = schedule.lineupPollingStart; slot < schedule.finalLineupAt; slot = new Date(slot.getTime() + V3_TIMING.lineupPollingIntervalMinutes * 60 * 1000)) {
    lineupPollingSlots.push(slot);
  }
  const previousDayProbableStarterAt = jstV3Slot(shiftV3IsoDate(gameDate, -1), 18, 0);
  return {
    startAt: schedule.startAt.toISOString(),
    predictionDeadline: schedule.predictionDeadline.toISOString(),
    rosterFetchSlots: uniqueSortedV3Dates(rosterFetchSlots),
    lineupPollingStart: schedule.lineupPollingStart.toISOString(),
    lineupPollingSlots: uniqueSortedV3Dates(lineupPollingSlots),
    finalLineupAt: schedule.finalLineupAt.toISOString(),
    scoringEarliestAt: schedule.finalLineupAt.toISOString(),
    publicationAt: schedule.publicationAt.toISOString(),
    probableStarterNextAt: previousDayProbableStarterAt?.toISOString() || null
  };
}

export function getV3RosterSlots(game) {
  return deriveV3DisplaySchedule(game).rosterFetchSlots
    .map((slot) => new Date(slot))
    .filter((slot) => !Number.isNaN(slot.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
}

const NEXT_ACTION_LABELS = Object.freeze({
  prediction_close: "予想締切",
  roster_fetch: "ロースター取得",
  lineup_fetch: "スタメン取得",
  lineup_finalize: "正式スタメン確定",
  score: "採点",
  ranking_rebuild: "ランキング反映",
  publish: "結果公開"
});

function hasFinishedV3Job(jobs, jobType) {
  return jobs.some((job) => job.job_type === jobType && ["completed", "cancelled"].includes(job.status));
}

export function getV3NextAction({ schedule, state = "scheduled", jobs = [], now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (!schedule || Number.isNaN(current.getTime()) || ["excluded", "published"].includes(String(state))) {
    return { nextAction: null, nextActionAt: null, nextActionLabel: null };
  }
  const completed = (jobType) => hasFinishedV3Job(jobs, jobType);
  const candidates = [];
  const add = (action, values, jobType, enabled = true) => {
    if (!enabled || completed(jobType)) return;
    for (const value of Array.isArray(values) ? values : [values]) {
      const at = new Date(value || "");
      if (!Number.isNaN(at.getTime()) && at.getTime() > current.getTime()) candidates.push({ action, at });
    }
  };
  add("prediction_close", schedule.predictionDeadline, "prediction_close", state === "scheduled");
  add("roster_fetch", schedule.rosterFetchSlots, "roster_fetch", !["lineup_ready", "scored", "ranked", "published"].includes(String(state)));
  add("lineup_fetch", schedule.lineupPollingSlots, "lineup_fetch", ["scheduled", "prediction_closed", "manual_action_required"].includes(String(state)));
  add("lineup_finalize", schedule.finalLineupAt, "lineup_finalize", ["scheduled", "prediction_closed", "manual_action_required"].includes(String(state)));
  add("score", schedule.scoringEarliestAt, "score", ["scheduled", "prediction_closed", "lineup_ready", "manual_action_required"].includes(String(state)));
  add("publish", schedule.publicationAt, "publish", String(state) === "ranked");
  const next = candidates.sort((left, right) => left.at.getTime() - right.at.getTime())[0];
  if (next) return { nextAction: next.action, nextActionAt: next.at.toISOString(), nextActionLabel: NEXT_ACTION_LABELS[next.action] };
  if (["lineup_ready", "manual_action_required"].includes(String(state)) && !completed("score")) {
    return { nextAction: "score_after_final_lineup", nextActionAt: null, nextActionLabel: "採点（正式スタメン確定後）" };
  }
  if (String(state) === "scored" && !completed("ranking_rebuild")) {
    return { nextAction: "ranking_after_scoring", nextActionAt: null, nextActionLabel: "ランキング反映（採点完了後）" };
  }
  if (String(state) === "ranked" && !completed("publish")) {
    return { nextAction: "publish", nextActionAt: schedule.publicationAt, nextActionLabel: NEXT_ACTION_LABELS.publish };
  }
  return { nextAction: null, nextActionAt: null, nextActionLabel: null };
}

export function getV3NpbIdentityState(game, now = new Date()) {
  const persisted = String(game?.npbIdentityStatus || game?.npb_identity_status || "").trim();
  if (persisted === "resolved" || persisted === "manually_overridden") return persisted;
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(current.getTime())) return "manual_action_required";
  if (current < new Date(startAt.getTime() - 50 * 60 * 1000)) return "pending";
  if (current <= new Date(startAt.getTime() + 2 * 60 * 1000)) return "retry_wait";
  return "manual_action_required";
}

export function isV3GameEligible(game) {
  if (!game?.internalGameId) return false;
  if (Number(game.isActive) === 0 || game.deletedAt) return false;
  return !["cancelled", "postponed", "no_game", "service_unavailable"].includes(String(game.gameStatus || "").toLowerCase());
}

export function resolveCanonicalProbableStarterRow(rows, internalGameId) {
  const expectedInternalGameId = String(internalGameId || "").trim();
  const allRows = Array.isArray(rows) ? rows : [];
  const mismatchedRows = allRows.filter((row) => {
    const rowInternalGameId = String(row?.internal_game_id || row?.internalGameId || "").trim();
    return rowInternalGameId && rowInternalGameId !== expectedInternalGameId;
  });
  const scopedRows = allRows.filter((row) =>
    String(row?.internal_game_id || row?.internalGameId || "").trim() === expectedInternalGameId
  );
  const canonicalRows = scopedRows.filter((row) =>
    String(row?.game_id || row?.gameId || "").trim() === expectedInternalGameId
  );
  const legacyRows = scopedRows.filter((row) =>
    String(row?.game_id || row?.gameId || "").trim() !== expectedInternalGameId
  );
  const canonicalRow = canonicalRows.length === 1 ? canonicalRows[0] : null;
  return {
    canonicalRow,
    canonicalRowId: canonicalRow?.game_id || canonicalRow?.gameId || null,
    probableStarterRowInternalGameId: canonicalRow?.internal_game_id || canonicalRow?.internalGameId || null,
    conflictingRowId: legacyRows[0]?.game_id || legacyRows[0]?.gameId || null,
    legacyRowDetected: legacyRows.length > 0,
    rowCount: scopedRows.length,
    mismatchedRowId: mismatchedRows[0]?.game_id || mismatchedRows[0]?.gameId || null,
    mismatchedInternalGameId: mismatchedRows[0]?.internal_game_id || mismatchedRows[0]?.internalGameId || null,
    integrityErrorReason: mismatchedRows.length > 0
      ? "PROBABLE_STARTER_INTERNAL_GAME_ID_MISMATCH"
      : canonicalRows.length > 1 ? "MULTIPLE_CANONICAL_PROBABLE_STARTER_ROWS" : null
  };
}

export function normalizeProbableStarterDataStatus(input = {}) {
  const value = typeof input === "string" ? { dataStatus: input } : (input || {});
  const rawStatus = String(value.dataStatus || value.data_status || "").trim().toLowerCase();
  const jobStatus = String(value.status || "").trim().toLowerCase();
  const errorCode = String(value.errorCode || value.error_code || "").trim().toUpperCase();
  const integrityErrorReason = String(value.integrityErrorReason || value.integrity_error_reason || "").trim();
  const homePitcherName = String(value.homePitcherName || value.home_pitcher_name || "").trim();
  const awayPitcherName = String(value.awayPitcherName || value.away_pitcher_name || "").trim();
  const hasHomePitcher = Boolean(homePitcherName);
  const hasAwayPitcher = Boolean(awayPitcherName);
  const integrityError = ["DATA_INTEGRITY_ERROR", "PROBABLE_STARTER_GAME_MISMATCH"].includes(errorCode);
  if (integrityError || integrityErrorReason) return "integrity_error";
  if (errorCode) return "transient_error";
  if (jobStatus === "error" || jobStatus === "failed" || ["error", "failed", "transient_error"].includes(rawStatus)) {
    return "transient_error";
  }
  if (rawStatus === "partial" || (hasHomePitcher !== hasAwayPitcher)) return "partial";
  if ((rawStatus === "announced" || jobStatus === "announced") && hasHomePitcher && hasAwayPitcher) return "announced";
  if (["unannounced", "empty", "pending"].includes(rawStatus) || jobStatus === "unannounced" || !hasHomePitcher && !hasAwayPitcher) return "unannounced";
  return rawStatus || "unannounced";
}

export function shouldStopProbableStarterScheduling({
  dataStatus,
  status,
  errorCode,
  normalizedDataStatus: suppliedNormalizedDataStatus,
  integrityErrorReason,
  homePitcherName,
  awayPitcherName,
  startAt,
  gameStatus,
  now = new Date()
} = {}) {
  const normalizedDataStatus = normalizeProbableStarterDataStatus({
    dataStatus: suppliedNormalizedDataStatus || dataStatus,
    status,
    errorCode,
    integrityErrorReason,
    homePitcherName,
    awayPitcherName
  });
  const normalizedGameStatus = String(gameStatus || "").trim().toLowerCase();
  if (["cancelled", "postponed", "no_game", "service_unavailable", "excluded", "invalid"].includes(normalizedGameStatus)) {
    return { shouldStopScheduling: true, normalizedDataStatus, reasonCode: "PROBABLE_STARTER_GAME_NOT_ELIGIBLE" };
  }
  if (normalizedDataStatus === "integrity_error") {
    return { shouldStopScheduling: true, normalizedDataStatus, reasonCode: "DATA_INTEGRITY_ERROR" };
  }
  const current = now instanceof Date ? now : new Date(now);
  const start = new Date(startAt || "");
  if (!Number.isNaN(current.getTime()) && !Number.isNaN(start.getTime()) && start.getTime() <= current.getTime()) {
    return { shouldStopScheduling: true, normalizedDataStatus, reasonCode: "PROBABLE_STARTER_GAME_STARTED" };
  }
  if (normalizedDataStatus === "announced") {
    return { shouldStopScheduling: true, normalizedDataStatus, reasonCode: "PROBABLE_STARTER_ALREADY_ANNOUNCED" };
  }
  return { shouldStopScheduling: false, normalizedDataStatus, reasonCode: null };
}

export function getV3AllowedTransitions(from, to) {
  const allowed = {
    scheduled: ["prediction_closed", "excluded", "failed", "manual_action_required"],
    prediction_closed: ["lineup_ready", "failed", "manual_action_required", "excluded"],
    lineup_ready: ["scored", "failed", "manual_action_required", "excluded"],
    scored: ["ranked", "failed", "manual_action_required", "excluded"],
    ranked: ["published", "failed", "manual_action_required", "excluded"],
    published: ["manual_action_required"],
    excluded: ["ranked", "manual_action_required"],
    failed: ["manual_action_required"],
    manual_action_required: ["prediction_closed", "lineup_ready", "scored", "ranked", "published", "excluded"]
  };
  return Boolean(allowed[String(from || "")]?.includes(String(to || "")));
}

export function assertV3Transition(from, to) {
  if (!getV3AllowedTransitions(from, to)) {
    const error = new Error(`V3状態遷移が許可されていません: ${from} -> ${to}`);
    error.code = "V3_STATE_TRANSITION_INVALID";
    throw error;
  }
  return { from, to };
}

export function getV3LineupSlot(startAt, now = new Date()) {
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  const current = now instanceof Date ? now : new Date(now);
  const pollingStart = new Date(start.getTime() - 50 * 60 * 1000);
  if (current < pollingStart) return null;
  const elapsed = Math.max(0, current.getTime() - pollingStart.getTime());
  return new Date(pollingStart.getTime() + Math.floor(elapsed / (10 * 60 * 1000)) * 10 * 60 * 1000);
}

function shiftV3IsoDate(dateValue, days) {
  const date = new Date(`${String(dateValue || "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getV3ProbableStarterSourceDate({ now = new Date(), currentGameStartAt = "", nextGameDate = "" } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23"
  }).formatToParts(current);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const today = `${values.year}-${values.month}-${values.day}`;
  const currentHour = Number(values.hour || 0);
  const start = new Date(currentGameStartAt || "");
  if (!Number.isNaN(start.getTime()) && current >= start && nextGameDate) return String(nextGameDate);
  if (currentHour >= 18) {
    const tomorrow = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + 1));
    return tomorrow.toISOString().slice(0, 10);
  }
  return today;
}

function jstV3Slot(dateValue, hour, minute) {
  const date = String(dateValue || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`);
}

export function getV3ProbableStarterSlot(game) {
  const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10);
  const previousGameDate = shiftV3IsoDate(gameDate, -1);
  return jstV3Slot(previousGameDate, 18, 0);
}

export function getV3ProbableStarterSlots(game) {
  const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10);
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  if (!gameDate || Number.isNaN(startAt.getTime())) return [];
  const slots = [
    getV3ProbableStarterSlot(game),
    jstV3Slot(gameDate, 9, 0),
    jstV3Slot(gameDate, 12, 0),
    jstV3Slot(gameDate, 15, 0),
    new Date(startAt.getTime() - 120 * 60 * 1000),
    new Date(startAt.getTime() - 60 * 60 * 1000),
    new Date(startAt.getTime() - 30 * 60 * 1000)
  ];
  return [...new Map(slots
    .filter((slot) => slot && !Number.isNaN(slot.getTime()) && slot.getTime() <= startAt.getTime())
    .map((slot) => [slot.toISOString(), slot]))
    .values()]
    .sort((left, right) => left.getTime() - right.getTime());
}

export function getV3ProbableStarterPlan(game, now = new Date()) {
  if (!isV3GameEligible(game)) return null;
  const current = now instanceof Date ? now : new Date(now);
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  const slot = getV3ProbableStarterSlot(game);
  if (Number.isNaN(current.getTime()) || Number.isNaN(startAt.getTime()) || !slot) return null;
  if (startAt.getTime() <= current.getTime() || slot.getTime() > current.getTime()) return null;
  return { jobType: "probable_starter_fetch", scheduledSlotAt: slot, scheduledAt: slot };
}

export async function planV3ProbableStarterJobs(db, games = [], now = new Date()) {
  const planned = [];
  const errors = [];
  const diagnostics = [];
  const current = now instanceof Date ? now : new Date(now);
  for (const game of Array.isArray(games) ? games : []) {
    const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
    const diagnostic = {
      internalGameId: game?.internalGameId || null,
      now: Number.isNaN(current.getTime()) ? null : current.toISOString(),
      startAt: Number.isNaN(startAt.getTime()) ? null : startAt.toISOString(),
      generatedSlots: [],
      dueSlots: [],
      selectedDueSlot: null,
      currentDataStatus: "unannounced",
      homePitcherPresent: false,
      awayPitcherPresent: false,
      shouldStopScheduling: false,
      openJobExists: false,
      openJobId: null,
      sameSlotJobExists: false,
      sameSlotJobId: null,
      actualJobExists: false,
      jobStatus: null,
      insertAttempted: false,
      insertedRowCount: 0,
      insertReasonCode: null,
      claimEligible: false,
      claimResult: "not_attempted",
      integrityErrorReason: null,
      canonicalRowId: null,
      probableStarterRowInternalGameId: null,
      conflictingRowId: null,
      legacyRowDetected: false,
      mismatchedRowId: null,
      mismatchedInternalGameId: null,
      reasonCode: null
    };
    const recordDiagnostic = () => diagnostics.push({ ...diagnostic });
    if (Number.isNaN(current.getTime()) || !isV3GameEligible(game)) {
      diagnostic.reasonCode = "PROBABLE_STARTER_GAME_NOT_ELIGIBLE";
      recordDiagnostic();
      continue;
    }
    if (Number.isNaN(startAt.getTime()) || startAt.getTime() <= current.getTime()) {
      diagnostic.reasonCode = "PROBABLE_STARTER_NOT_DUE";
      recordDiagnostic();
      continue;
    }
    const generatedSlots = getV3ProbableStarterSlots(game);
    diagnostic.generatedSlots = generatedSlots.map((slot) => slot.toISOString());
    const slots = generatedSlots.filter((slot) => slot.getTime() <= current.getTime());
    diagnostic.dueSlots = slots.map((slot) => slot.toISOString());
    const latestDueSlot = slots[slots.length - 1] || null;
    if (!latestDueSlot) {
      diagnostic.reasonCode = "PROBABLE_STARTER_NOT_DUE";
      recordDiagnostic();
      continue;
    }
    diagnostic.selectedDueSlot = latestDueSlot.toISOString();
    diagnostic.scheduledSlotAt = latestDueSlot.toISOString();
    const plan = { jobType: "probable_starter_fetch", scheduledSlotAt: latestDueSlot, scheduledAt: latestDueSlot };
    try {
      let stateRow = null;
      try {
        stateRow = await db.prepare(
          "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
        ).bind(game.internalGameId).first();
      } catch {
        // V3 state行が未作成、または旧テストadapterの場合も対象抽出は継続します。
      }
      if (["excluded", "published"].includes(String(stateRow?.state || game?.workflowState || ""))) {
        diagnostic.reasonCode = "PROBABLE_STARTER_GAME_NOT_ELIGIBLE";
        recordDiagnostic();
        continue;
      }
      let probableRow = null;
      try {
        let probableRows = [];
        try {
          probableRows = (await db.prepare(
            `SELECT game_id, internal_game_id, status, data_status, error_code, home_pitcher_name, away_pitcher_name
               FROM probable_starters
              WHERE internal_game_id = ?1
              ORDER BY COALESCE(fetched_at, updated_at) DESC
               LIMIT 3`
          ).bind(game.internalGameId).all()).results || [];
        } catch {
          // Older fixtures may lack the optional data_status column. The
          // canonical UUID scope remains unchanged; only the projection narrows.
          try {
            probableRows = (await db.prepare(
              `SELECT game_id, internal_game_id, status, error_code, home_pitcher_name, away_pitcher_name
                 FROM probable_starters
                WHERE internal_game_id = ?1
                ORDER BY COALESCE(fetched_at, updated_at) DESC
                 LIMIT 3`
            ).bind(game.internalGameId).all()).results || [];
          } catch {
            // Pre-audit schemas may also lack error_code. Keep the canonical
            // UUID lookup and retain the status/pitcher fields needed by V3.
            probableRows = (await db.prepare(
              `SELECT game_id, internal_game_id, status, home_pitcher_name, away_pitcher_name
                 FROM probable_starters
                WHERE internal_game_id = ?1
                ORDER BY updated_at DESC
                 LIMIT 3`
            ).bind(game.internalGameId).all()).results || [];
          }
        }
        const canonical = resolveCanonicalProbableStarterRow(probableRows, game.internalGameId);
        probableRow = canonical.canonicalRow;
        diagnostic.integrityErrorReason = canonical.integrityErrorReason;
        diagnostic.canonicalRowId = canonical.canonicalRowId;
        diagnostic.probableStarterRowInternalGameId = canonical.probableStarterRowInternalGameId;
        diagnostic.conflictingRowId = canonical.conflictingRowId;
        diagnostic.legacyRowDetected = canonical.legacyRowDetected;
        diagnostic.mismatchedRowId = canonical.mismatchedRowId;
        diagnostic.mismatchedInternalGameId = canonical.mismatchedInternalGameId;
        if (canonical.integrityErrorReason) {
          diagnostic.currentDataStatus = "integrity_error";
          diagnostic.shouldStopScheduling = true;
          diagnostic.reasonCode = "DATA_INTEGRITY_ERROR";
          planned.push({ game, plan, created: false, job: null, reasonCode: diagnostic.reasonCode, insertedRowCount: 0, diagnostic: { ...diagnostic } });
          recordDiagnostic();
          continue;
        }
      } catch {
        // 旧adapterまたは未適用の補助スキーマでも、V3 job計画自体は継続します。
      }
      const hasHomePitcher = Boolean(String(probableRow?.home_pitcher_name || "").trim());
      const hasAwayPitcher = Boolean(String(probableRow?.away_pitcher_name || "").trim());
      const stopDecision = shouldStopProbableStarterScheduling({
        dataStatus: probableRow?.data_status,
        status: probableRow?.status,
        errorCode: probableRow?.error_code,
        integrityErrorReason: diagnostic.integrityErrorReason,
        homePitcherName: probableRow?.home_pitcher_name,
        awayPitcherName: probableRow?.away_pitcher_name,
        startAt,
        gameStatus: stateRow?.state === "excluded" ? "excluded" : game?.gameStatus,
        now: current
      });
      diagnostic.currentDataStatus = stopDecision.normalizedDataStatus;
      diagnostic.homePitcherPresent = hasHomePitcher;
      diagnostic.awayPitcherPresent = hasAwayPitcher;
      diagnostic.shouldStopScheduling = stopDecision.shouldStopScheduling;
      if (stopDecision.shouldStopScheduling) {
        diagnostic.reasonCode = stopDecision.reasonCode;
        planned.push({ game, plan, created: false, job: null, reasonCode: stopDecision.reasonCode, insertedRowCount: 0, diagnostic: { ...diagnostic } });
        recordDiagnostic();
        continue;
      }
      const openJob = await db.prepare(
        `SELECT id, status, scheduled_slot_at
           FROM game_jobs_v3
          WHERE internal_game_id = ?1
            AND job_type = ?2
            AND status IN ('pending', 'claimed', 'retry_wait')
          LIMIT 1`
      ).bind(game.internalGameId, plan.jobType).first();
      if (openJob) {
        diagnostic.openJobExists = true;
        diagnostic.openJobId = openJob.id;
        diagnostic.actualJobExists = true;
        diagnostic.jobStatus = openJob.status;
        diagnostic.insertReasonCode = "PROBABLE_STARTER_OPEN_JOB_EXISTS";
        diagnostic.reasonCode = "PROBABLE_STARTER_OPEN_JOB_EXISTS";
        diagnostic.claimEligible = openJob.status === "pending" && new Date(plan.scheduledAt).getTime() <= current.getTime();
        planned.push({
          game,
          plan,
          created: false,
          job: openJob,
          reasonCode: "PROBABLE_STARTER_OPEN_JOB_EXISTS",
          insertedRowCount: 0,
          existingJobId: openJob.id,
          existingScheduledSlotAt: openJob.scheduled_slot_at,
          existingStatus: openJob.status,
          diagnostic: { ...diagnostic }
        });
        recordDiagnostic();
        continue;
      }
      const existingJob = await db.prepare(
        `SELECT id, status, scheduled_slot_at
           FROM game_jobs_v3
          WHERE internal_game_id = ?1
            AND job_type = ?2
            AND scheduled_slot_at = ?3
          LIMIT 1`
      ).bind(game.internalGameId, plan.jobType, latestDueSlot.toISOString()).first();
      if (existingJob) {
        diagnostic.sameSlotJobExists = true;
        diagnostic.sameSlotJobId = existingJob.id;
        diagnostic.actualJobExists = true;
        diagnostic.jobStatus = existingJob.status;
        diagnostic.insertReasonCode = "PROBABLE_STARTER_SLOT_ALREADY_EXISTS";
        diagnostic.reasonCode = "PROBABLE_STARTER_SLOT_ALREADY_EXISTS";
        diagnostic.claimEligible = ["pending", "retry_wait"].includes(String(existingJob.status || ""))
          && new Date(plan.scheduledAt).getTime() <= current.getTime();
        planned.push({
          game,
          plan,
          created: false,
          job: existingJob,
          reasonCode: "PROBABLE_STARTER_JOB_ALREADY_EXISTS",
          insertedRowCount: 0,
          existingJobId: existingJob.id,
          existingScheduledSlotAt: existingJob.scheduled_slot_at,
          existingStatus: existingJob.status,
          diagnostic: { ...diagnostic }
        });
        recordDiagnostic();
        continue;
      }
      diagnostic.insertAttempted = true;
      const result = await createV3Job(db, { internalGameId: game.internalGameId, ...plan });
      diagnostic.insertedRowCount = result.created ? 1 : 0;
      diagnostic.insertReasonCode = result.created ? "PROBABLE_STARTER_JOB_CREATED" : "PROBABLE_STARTER_INSERT_IGNORED";
      diagnostic.reasonCode = result.created ? "PROBABLE_STARTER_JOB_CREATED" : "PROBABLE_STARTER_INSERT_IGNORED";
      diagnostic.sameSlotJobExists = !result.created && Boolean(result.job?.id);
      diagnostic.sameSlotJobId = result.created ? null : result.job?.id || null;
      diagnostic.actualJobExists = Boolean(result.job?.id);
      diagnostic.jobStatus = result.job?.status || (result.created ? "pending" : null);
      diagnostic.claimEligible = Boolean(result.job?.status === "pending"
        && new Date(result.job?.scheduled_at || plan.scheduledAt).getTime() <= current.getTime());
      planned.push({
        game,
        plan,
        ...result,
        reasonCode: result.created ? "PROBABLE_STARTER_JOB_CREATED" : "PROBABLE_STARTER_INSERT_IGNORED",
        insertedRowCount: result.created ? 1 : 0,
        existingJobId: result.created ? null : result.job?.id || null,
        existingScheduledSlotAt: result.created ? null : result.job?.scheduled_slot_at || null,
        existingStatus: result.created ? null : result.job?.status || null,
        diagnostic: { ...diagnostic }
      });
      recordDiagnostic();
    } catch (error) {
      diagnostic.reasonCode = "PROBABLE_STARTER_SLOT_SELECTION_FAILED";
      recordDiagnostic();
      errors.push({ game, plan, error });
    }
  }
  return {
    created: planned.filter((entry) => entry.created).length,
    planned,
    errors,
    diagnostics
  };
}

export async function getV3CanonicalRosterSnapshot(db, internalGameId) {
  const id = normalizeV3InternalGameId(internalGameId);
  try {
    const row = await db.prepare(
      `SELECT internal_game_id, status, player_count, captured_at, updated_at
         FROM game_roster_snapshots
        WHERE internal_game_id = ?1
        ORDER BY updated_at DESC, captured_at DESC
        LIMIT 1`
    ).bind(id).first();
    const exists = Boolean(row
      && String(row.internal_game_id || "") === id
      && String(row.status || "") === "captured"
      && Number(row.player_count || 0) > 0);
    return {
      schemaAvailable: true,
      exists,
      internalGameId: row?.internal_game_id || null,
      status: row?.status || null,
      playerCount: Number(row?.player_count || 0),
      capturedAt: row?.captured_at || null,
      updatedAt: row?.updated_at || null
    };
  } catch {
    return {
      schemaAvailable: false,
      exists: false,
      internalGameId: null,
      status: null,
      playerCount: 0,
      capturedAt: null,
      updatedAt: null
    };
  }
}

export async function planV3RosterJobs(db, games = [], now = new Date()) {
  const planned = [];
  const errors = [];
  const diagnostics = [];
  const current = now instanceof Date ? now : new Date(now);
  for (const game of Array.isArray(games) ? games : []) {
    const diagnostic = {
      internalGameId: game?.internalGameId || null,
      now: Number.isNaN(current.getTime()) ? null : current.toISOString(),
      generatedSlots: [],
      dueSlots: [],
      selectedDueSlot: null,
      actualJobExists: false,
      jobStatus: null,
      planningSkipped: false,
      skipReason: null,
      openJobExists: false,
      existingJobId: null,
      insertAttempted: false,
      insertedRowCount: 0,
      claimResult: "not_attempted",
      rosterSnapshotExists: false,
      rosterSnapshotInternalGameId: null,
      rosterSnapshotStatus: null,
      rosterSnapshotPlayerCount: 0,
      insertReasonCode: null
    };
    diagnostics.push(diagnostic);
    try {
      if (!isV3GameEligible(game)) {
        diagnostic.planningSkipped = true;
        diagnostic.skipReason = "ROSTER_GAME_NOT_ELIGIBLE";
        planned.push({ game, plan: null, created: false, reasonCode: diagnostic.skipReason, diagnostic: { ...diagnostic } });
        continue;
      }
      const generatedSlots = getV3RosterSlots(game);
      diagnostic.generatedSlots = generatedSlots.map((slot) => slot.toISOString());
      const dueSlots = generatedSlots.filter((slot) => slot.getTime() <= current.getTime());
      diagnostic.dueSlots = dueSlots.map((slot) => slot.toISOString());
      if (!dueSlots.length) {
        diagnostic.planningSkipped = true;
        diagnostic.skipReason = "ROSTER_NOT_DUE";
        planned.push({ game, plan: null, created: false, reasonCode: diagnostic.skipReason, diagnostic: { ...diagnostic } });
        continue;
      }
      const snapshot = await getV3CanonicalRosterSnapshot(db, game.internalGameId);
      diagnostic.rosterSnapshotExists = snapshot.exists;
      diagnostic.rosterSnapshotInternalGameId = snapshot.internalGameId;
      diagnostic.rosterSnapshotStatus = snapshot.status;
      diagnostic.rosterSnapshotPlayerCount = snapshot.playerCount;
      if (snapshot.exists) {
        diagnostic.planningSkipped = true;
        diagnostic.skipReason = "ROSTER_SNAPSHOT_ALREADY_EXISTS";
        planned.push({ game, plan: null, created: false, reasonCode: diagnostic.skipReason, diagnostic: { ...diagnostic } });
        continue;
      }

      const rosterJobs = (await db.prepare(
        `SELECT id, status, scheduled_slot_at, scheduled_at, attempt_count, max_attempts,
                next_retry_at, claimed_at, completed_at
           FROM game_jobs_v3
          WHERE internal_game_id = ?1 AND job_type = ?2
          ORDER BY scheduled_slot_at DESC, id DESC`
      ).bind(game.internalGameId, "roster_fetch").all()).results || [];
      const openJob = rosterJobs.find((job) => ["pending", "claimed", "retry_wait"].includes(String(job.status || "")));
      const latestDueSlot = dueSlots[dueSlots.length - 1];
      // Rescue only the latest due slot. Older due slots must not be backfilled
      // one by one after a newer slot has already been processed.
      const selectedDueSlot = latestDueSlot;
      diagnostic.selectedDueSlot = selectedDueSlot.toISOString();
      const selectedExistingJob = rosterJobs.find((job) => String(job.scheduled_slot_at || "") === selectedDueSlot.toISOString()) || null;
      diagnostic.actualJobExists = Boolean(selectedExistingJob || openJob);
      diagnostic.jobStatus = selectedExistingJob?.status || openJob?.status || null;
      diagnostic.existingJobId = selectedExistingJob?.id || openJob?.id || null;
      if (openJob) {
        diagnostic.openJobExists = true;
        diagnostic.insertReasonCode = "ROSTER_OPEN_JOB_EXISTS";
        diagnostic.skipReason = "ROSTER_OPEN_JOB_EXISTS";
        planned.push({
          game,
          plan: { jobType: "roster_fetch", scheduledSlotAt: selectedDueSlot, scheduledAt: selectedDueSlot },
          created: false,
          job: openJob,
          reasonCode: diagnostic.skipReason,
          insertedRowCount: 0,
          existingJobId: openJob.id,
          existingScheduledSlotAt: openJob.scheduled_slot_at,
          existingStatus: openJob.status,
          diagnostic: { ...diagnostic }
        });
        continue;
      }
      if (selectedExistingJob) {
        diagnostic.insertReasonCode = "ROSTER_SLOT_ALREADY_PROCESSED";
        diagnostic.skipReason = diagnostic.insertReasonCode;
        planned.push({
          game,
          plan: { jobType: "roster_fetch", scheduledSlotAt: selectedDueSlot, scheduledAt: selectedDueSlot },
          created: false,
          job: selectedExistingJob,
          reasonCode: diagnostic.skipReason,
          insertedRowCount: 0,
          existingJobId: selectedExistingJob.id,
          existingScheduledSlotAt: selectedExistingJob.scheduled_slot_at,
          existingStatus: selectedExistingJob.status,
          diagnostic: { ...diagnostic }
        });
        continue;
      }
      const plan = { jobType: "roster_fetch", scheduledSlotAt: selectedDueSlot, scheduledAt: selectedDueSlot };
      diagnostic.insertAttempted = true;
      const result = await createV3Job(db, { internalGameId: game.internalGameId, ...plan });
      diagnostic.insertedRowCount = result.created ? 1 : 0;
      diagnostic.insertReasonCode = result.created ? "ROSTER_JOB_CREATED" : "ROSTER_INSERT_IGNORED";
      diagnostic.actualJobExists = Boolean(result.job?.id);
      diagnostic.jobStatus = result.job?.status || (result.created ? "pending" : null);
      diagnostic.existingJobId = result.created ? null : result.job?.id || null;
      planned.push({
        game,
        plan,
        ...result,
        reasonCode: diagnostic.insertReasonCode,
        insertedRowCount: diagnostic.insertedRowCount,
        existingJobId: diagnostic.existingJobId,
        existingScheduledSlotAt: result.created ? null : result.job?.scheduled_slot_at || null,
        existingStatus: result.created ? null : result.job?.status || null,
        diagnostic: { ...diagnostic }
      });
    } catch (error) {
      diagnostic.planningSkipped = true;
      diagnostic.skipReason = "ROSTER_SLOT_PLANNING_FAILED";
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

export function getV3IdentityResolvePlans(game, now = new Date(), workflowState = "") {
  if (!isV3GameEligible(game) || String(workflowState || "") === "published") return [];
  const identityStatus = String(game?.npbIdentityStatus || game?.npb_identity_status || "").trim();
  if (["resolved", "manually_overridden"].includes(identityStatus)) return [];
  const current = now instanceof Date ? now : new Date(now);
  const schedule = deriveV3Schedule(game);
  if (Number.isNaN(current.getTime())) return [];
  const gameDate = String(game?.gameDate || game?.game_date || "").slice(0, 10);
  const slots = [
    jstV3Slot(shiftV3IsoDate(gameDate, -1), 18, 0),
    jstV3Slot(gameDate, 16, 0),
    schedule.lineupPollingStart
  ];
  for (let slot = schedule.lineupPollingStart; slot <= schedule.finalLineupAt; slot = new Date(slot.getTime() + 10 * 60 * 1000)) {
    slots.push(slot);
  }
  const uniqueSlots = [...new Map(slots.filter((slot) => slot && !Number.isNaN(slot.getTime()))
    .map((slot) => [slot.toISOString(), slot])).values()]
    .sort((left, right) => left.getTime() - right.getTime());
  return uniqueSlots
    .filter((slot) => slot.getTime() <= current.getTime())
    .filter((slot) => slot.getTime() <= schedule.finalLineupAt.getTime())
    .map((slot) => ({ jobType: "npb_identity_resolve", scheduledSlotAt: slot, scheduledAt: slot }));
}

function isV3NpbIdentityResolved(game) {
  return ["resolved", "manually_overridden"].includes(String(game?.npbIdentityStatus || game?.npb_identity_status || "").trim());
}

export const V3_JOB_STATE_GATES = Object.freeze({
  prediction_close: ["scheduled"],
  lineup_fetch: ["prediction_closed", "manual_action_required"],
  lineup_finalize: ["prediction_closed", "manual_action_required"],
  score: ["lineup_ready", "manual_action_required"],
  ranking_rebuild: ["scored"],
  publish: ["ranked"]
});

export function getV3DuePlans(game, state, now = new Date()) {
  if (!isV3GameEligible(game)) return [];
  const schedule = deriveV3Schedule(game);
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return [];
  const plans = [];
  if (V3_JOB_STATE_GATES.prediction_close.includes(String(state)) && current >= schedule.predictionDeadline) {
    plans.push({ jobType: "prediction_close", scheduledSlotAt: schedule.predictionDeadline, scheduledAt: schedule.predictionDeadline });
  }
  const lineupState = V3_JOB_STATE_GATES.lineup_fetch.includes(String(state));
  if (lineupState && current >= schedule.lineupPollingStart && current < schedule.finalLineupAt && isV3NpbIdentityResolved(game)) {
    const slot = getV3LineupSlot(schedule.startAt, current);
    if (slot) plans.push({ jobType: "lineup_fetch", scheduledSlotAt: slot, scheduledAt: slot });
  }
  if (V3_JOB_STATE_GATES.lineup_finalize.includes(String(state)) && current >= schedule.finalLineupAt && isV3NpbIdentityResolved(game)) {
    plans.push({ jobType: "lineup_finalize", scheduledSlotAt: schedule.finalLineupAt, scheduledAt: schedule.finalLineupAt });
  }
  if (V3_JOB_STATE_GATES.score.includes(String(state)) && current >= schedule.finalLineupAt) {
    plans.push({ jobType: "score", scheduledSlotAt: schedule.finalLineupAt, scheduledAt: schedule.finalLineupAt });
  }
  if (V3_JOB_STATE_GATES.ranking_rebuild.includes(String(state))) {
    plans.push({ jobType: "ranking_rebuild", scheduledSlotAt: schedule.publicationAt, scheduledAt: schedule.publicationAt });
  }
  if (V3_JOB_STATE_GATES.publish.includes(String(state)) && current >= schedule.publicationAt) {
    plans.push({ jobType: "publish", scheduledSlotAt: schedule.publicationAt, scheduledAt: schedule.publicationAt });
  }
  return plans;
}

export function getV3DuePlan(game, state, now = new Date()) {
  const plans = getV3DuePlans(game, state, now);
  return Array.isArray(plans) ? plans[0] || null : null;
}

export function createV3Error(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function formatV3JobFailureMessage(error) {
  const message = String(error?.message || "V3ジョブに失敗しました。");
  let diagnostics = "";
  if (error?.diagnostics && typeof error.diagnostics === "object") {
    try {
      diagnostics = JSON.stringify(error.diagnostics);
    } catch {
      diagnostics = "";
    }
  }
  return (diagnostics ? `${message} [diagnostics=${diagnostics}]` : message).slice(0, 240);
}

export async function getV3SchemaState(db) {
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('games', 'game_jobs_v3', 'game_automation_v3_state')").all();
  const names = new Set((rows.results || []).map((row) => row.name));
  return {
    games: names.has("games"),
    jobs: names.has("game_jobs_v3"),
    state: names.has("game_automation_v3_state"),
    ready: names.has("games") && names.has("game_jobs_v3") && names.has("game_automation_v3_state")
  };
}

export async function listV3Games(db, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const date = new Date(current.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let columns = new Set();
  try {
    const schema = await db.prepare("PRAGMA table_info(games)").all();
    columns = new Set((schema.results || []).map((row) => String(row.name || "")));
  } catch {
    // Older adapters do not expose PRAGMA; the base V3 projection remains valid.
  }
  const optionalColumns = ["npb_game_url", "source_schedule_key", "npb_identity_status", "npb_identity_resolved_at", "npb_identity_source"]
    .filter((column) => columns.has(column));
  const result = await db.prepare(
    `SELECT internal_game_id, game_date, start_time, home_team, away_team,
            npb_game_code${optionalColumns.length ? `, ${optionalColumns.join(", ")}` : ""},
            game_status, is_active, deleted_at
       FROM games
      WHERE internal_game_id IS NOT NULL AND internal_game_id <> ''
        AND game_date >= date(?1)
      ORDER BY start_time, internal_game_id`
  ).bind(date).all();
  return (result.results || []).map((row) => ({
    internalGameId: row.internal_game_id,
    gameDate: row.game_date,
    startAt: row.start_time,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    npbGameCode: row.npb_game_code || null,
    npbGameUrl: row.npb_game_url || null,
    sourceScheduleKey: row.source_schedule_key || null,
    npbIdentityStatus: row.npb_identity_status || (row.npb_game_code ? "resolved" : "unresolved"),
    npbIdentityResolvedAt: row.npb_identity_resolved_at || null,
    npbIdentitySource: row.npb_identity_source || null,
    npbIdentityState: getV3NpbIdentityState({
      npbIdentityStatus: row.npb_identity_status || (row.npb_game_code ? "resolved" : "unresolved"),
      startAt: row.start_time
    }, current),
    gameStatus: row.game_status,
    isActive: row.is_active,
    deletedAt: row.deleted_at
  }));
}

export async function ensureV3State(db, internalGameId, now = new Date()) {
  const id = normalizeV3InternalGameId(internalGameId);
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  await db.prepare(
    `INSERT INTO game_automation_v3_state
       (internal_game_id, state, version, created_at, updated_at)
     VALUES (?1, 'scheduled', 0, ?2, ?2)
     ON CONFLICT(internal_game_id) DO NOTHING`
  ).bind(id, timestamp).run();
  return db.prepare("SELECT * FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1").bind(id).first();
}

export async function transitionV3State(db, { internalGameId, from, to, now = new Date(), failureCode = null, failureMessage = null } = {}) {
  const id = normalizeV3InternalGameId(internalGameId);
  assertV3Transition(from, to);
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const result = await db.prepare(
    `UPDATE game_automation_v3_state
        SET state = ?1, version = version + 1, failure_code = ?2,
            failure_message = ?3,
            prediction_closed_at = CASE WHEN ?1 = 'prediction_closed' THEN COALESCE(prediction_closed_at, ?4) ELSE prediction_closed_at END,
            lineup_finalized_at = CASE WHEN ?1 = 'lineup_ready' THEN COALESCE(lineup_finalized_at, ?4) ELSE lineup_finalized_at END,
            ranked_at = CASE WHEN ?1 = 'ranked' THEN COALESCE(ranked_at, ?4) ELSE ranked_at END,
            published_at = CASE WHEN ?1 = 'published' THEN COALESCE(published_at, ?4) ELSE published_at END,
            excluded_at = CASE WHEN ?1 = 'excluded' THEN COALESCE(excluded_at, ?4) ELSE excluded_at END,
            updated_at = ?4
      WHERE internal_game_id = ?5 AND state = ?6`
  ).bind(to, failureCode, failureMessage, timestamp, id, from).run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    throw createV3Error("V3_STATE_VERSION_CONFLICT", "V3状態が別の実行で更新されました。");
  }
  return db.prepare("SELECT * FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1").bind(id).first();
}

export async function createV3Job(db, { internalGameId, jobType, scheduledSlotAt, scheduledAt = scheduledSlotAt, maxAttempts = 12, source = "cron" } = {}) {
  const id = normalizeV3InternalGameId(internalGameId);
  if (!V3_JOB_TYPES.includes(jobType)) throw createV3Error("V3_JOB_TYPE_INVALID", "V3ジョブ種別が不正です。");
  const slot = scheduledSlotAt instanceof Date ? scheduledSlotAt : new Date(scheduledSlotAt);
  const due = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  if (Number.isNaN(slot.getTime()) || Number.isNaN(due.getTime())) {
    throw createV3Error("V3_JOB_TIME_INVALID", "V3ジョブの実行時刻が不正です。");
  }
  const timestamp = new Date().toISOString();
  const result = await db.prepare(
    `INSERT OR IGNORE INTO game_jobs_v3
       (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
        attempt_count, max_attempts, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, ?6, ?6)`
  ).bind(id, jobType, due.toISOString(), slot.toISOString(), maxAttempts, timestamp).run();
  const row = await db.prepare(
    `SELECT * FROM game_jobs_v3
      WHERE internal_game_id = ?1 AND job_type = ?2 AND scheduled_slot_at = ?3 LIMIT 1`
  ).bind(id, jobType, slot.toISOString()).first();
  return { created: Number(result?.meta?.changes || 0) === 1, job: row, source };
}

function monotonicV3JobTimestamp(requestedAt, ...minimumValues) {
  const requested = requestedAt instanceof Date ? requestedAt : new Date(requestedAt);
  const values = [requested.getTime(), ...minimumValues.map((value) => new Date(value || "").getTime())]
    .filter((value) => Number.isFinite(value));
  return new Date(Math.max(...values)).toISOString();
}

export async function claimV3Job(db, { jobId, now = new Date(), leaseMilliseconds = 5 * 60 * 1000 } = {}) {
  const current = await db.prepare("SELECT created_at FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
  const timestamp = monotonicV3JobTimestamp(now, current?.created_at);
  const leaseExpiresAt = new Date(new Date(timestamp).getTime() + leaseMilliseconds).toISOString();
  const claimToken = `${timestamp}:${Math.random().toString(36).slice(2)}`;
  const result = await db.prepare(
    `UPDATE game_jobs_v3
        SET status = 'claimed', attempt_count = attempt_count + 1,
            claimed_at = ?1, lease_expires_at = ?2, claim_token = ?3, updated_at = ?1
      WHERE id = ?4 AND (
        status IN ('pending', 'retry_wait')
        OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1)
      )
        AND (next_retry_at IS NULL OR next_retry_at <= ?1)
        AND attempt_count < max_attempts`
  ).bind(timestamp, leaseExpiresAt, claimToken, Number(jobId)).run();
  if (Number(result?.meta?.changes || 0) !== 1) return null;
  return db.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
}

export async function completeV3Job(db, { jobId, claimToken, now = new Date(), failureCode = null, failureMessage = null } = {}) {
  const current = await db.prepare("SELECT created_at, claimed_at FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
  const timestamp = monotonicV3JobTimestamp(now, current?.created_at, current?.claimed_at);
  const result = await db.prepare(
    `UPDATE game_jobs_v3
        SET status = 'completed', completed_at = ?1, lease_expires_at = NULL,
            claim_token = NULL, failure_code = ?2, failure_message = ?3, updated_at = ?1
      WHERE id = ?4 AND status = 'claimed' AND claim_token = ?5`
  ).bind(timestamp, failureCode, failureMessage, Number(jobId), claimToken).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function retryV3Job(db, { jobId, claimToken, attemptCount, maxAttempts, now = new Date(), errorCode, errorMessage, retryAt } = {}) {
  const current = await db.prepare("SELECT created_at, claimed_at FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(jobId)).first();
  const timestamp = monotonicV3JobTimestamp(now, current?.created_at, current?.claimed_at);
  const terminal = Number(attemptCount) >= Number(maxAttempts);
  const retry = retryAt ? new Date(retryAt).toISOString() : null;
  const result = await db.prepare(
    `UPDATE game_jobs_v3
        SET status = ?1, next_retry_at = ?2, lease_expires_at = NULL,
            claim_token = NULL, failure_code = ?3, failure_message = ?4, updated_at = ?5
      WHERE id = ?6 AND status = 'claimed' AND claim_token = ?7`
  ).bind(terminal ? "failed" : "retry_wait", terminal ? null : retry, errorCode || null, errorMessage || null, timestamp, Number(jobId), claimToken).run();
  return { updated: Number(result?.meta?.changes || 0) === 1, status: terminal ? "failed" : "retry_wait" };
}

export async function listDueV3Jobs(db, now = new Date(), limit = 50) {
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const result = await db.prepare(
    `SELECT * FROM game_jobs_v3
      WHERE (status IN ('pending', 'retry_wait')
         OR (status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1))
        AND scheduled_at <= ?1
        AND (next_retry_at IS NULL OR next_retry_at <= ?1)
      ORDER BY scheduled_at, id LIMIT ?2`
  ).bind(timestamp, Math.max(1, Math.min(100, Number(limit) || 50))).all();
  return result.results || [];
}

function assertV3AuxiliaryJobResult(job, result, now) {
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

async function hasOpenV3Job(db, internalGameId, jobType) {
  const row = await db.prepare(
    `SELECT id FROM game_jobs_v3
      WHERE internal_game_id = ?1 AND job_type = ?2
        AND status IN ('pending', 'claimed', 'retry_wait')
      LIMIT 1`
  ).bind(internalGameId, jobType).first();
  return Boolean(row?.id);
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

export async function planV3MainJobs(db, games = [], now = new Date()) {
  const planned = [];
  const errors = [];
  const diagnostics = [];
  for (const game of Array.isArray(games) ? games : []) {
    if (!isV3GameEligible(game)) continue;
    try {
      const stateRow = await readV3StateForPlanning(db, game.internalGameId);
      const state = String(stateRow?.state || game.workflowState || "scheduled");
      const plans = getV3DuePlans(game, state, now);
      for (const plan of plans) {
        const diagnostic = createV3PlanningDiagnostic(game, plan, state);
        const result = await createV3Job(db, { internalGameId: game.internalGameId, ...plan });
        diagnostic.insertAttempted = true;
        diagnostic.insertedRowCount = result.created ? 1 : 0;
        diagnostic.actualJobExists = Boolean(result.job?.id);
        diagnostic.existingJobId = result.created ? null : result.job?.id || null;
        diagnostic.existingStatus = result.created ? "pending" : result.job?.status || null;
        diagnostic.reasonCode = result.created ? "V3_JOB_CREATED" : "V3_JOB_ALREADY_EXISTS";
        const entry = {
          game,
          plan,
          ...result,
          reasonCode: diagnostic.reasonCode,
          insertedRowCount: diagnostic.insertedRowCount,
          existingJobId: diagnostic.existingJobId,
          existingScheduledSlotAt: result.created ? null : result.job?.scheduled_slot_at || null,
          existingStatus: diagnostic.existingStatus,
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

export async function runGameAutomationV3(env, now = new Date(), { executeJob, onError = null, onSuccess = null, onPlan = null } = {}) {
  if (!isGameAutomationV3Enabled(env)) return { enabled: false, processed: 0, created: 0 };
  const schema = await getV3SchemaState(env.AUTH_DB);
  if (!schema.ready) return { enabled: true, schemaReady: false, errorCode: "GAME_AUTOMATION_V3_SCHEMA_UNAVAILABLE", processed: 0, created: 0 };
  const games = await listV3Games(env.AUTH_DB, now);
  let created = 0;
  let processed = 0;
  let failed = 0;
  for (const game of games) {
    try {
      const stateRow = await ensureV3State(env.AUTH_DB, game.internalGameId, now);
      if (!isV3GameEligible(game) && stateRow.state !== "excluded") {
        await transitionV3State(env.AUTH_DB, { internalGameId: game.internalGameId, from: stateRow.state, to: "excluded", now });
      }
    } catch (error) {
      failed += 1;
      if (onError) await onError(error, { game, stage: "state_prepare" });
    }
  }
  const probablePlan = await planV3ProbableStarterJobs(env.AUTH_DB, games, now);
  created += probablePlan.created;
  if (onPlan) {
    for (const entry of probablePlan.planned) {
      try {
        await onPlan({ ...entry, stage: "probable_plan", now });
      } catch (error) {
        failed += 1;
        if (onError) await onError(error, { game: entry.game, plan: entry.plan, stage: "probable_plan_audit" });
      }
    }
  }
  for (const entry of probablePlan.errors) {
    failed += 1;
    if (onError) await onError(entry.error, { game: entry.game, stage: "probable_plan" });
  }
  // Probable-starter completion is auxiliary to roster planning. A confirmed
  // probable starter must never prevent an overdue roster slot from running.
  const rosterPlan = await planV3RosterJobs(env.AUTH_DB, games, now);
  created += rosterPlan.created;
  if (onPlan) {
    for (const entry of rosterPlan.planned) {
      try {
        await onPlan({ ...entry, stage: "roster_plan", now });
      } catch (error) {
        failed += 1;
        if (onError) await onError(error, { game: entry.game, plan: entry.plan, stage: "roster_plan_audit" });
      }
    }
  }
  for (const entry of rosterPlan.errors) {
    failed += 1;
    if (onError) await onError(entry.error, { game: entry.game, stage: "roster_plan" });
  }
  const identityPlan = await planV3IdentityJobs(env.AUTH_DB, games, now);
  created += identityPlan.created;
  if (onPlan) {
    for (const entry of identityPlan.planned) {
      try {
        await onPlan({ ...entry, stage: "identity_plan", now });
      } catch (error) {
        failed += 1;
        if (onError) await onError(error, { game: entry.game, plan: entry.plan, stage: "identity_plan_audit" });
      }
    }
  }
  for (const entry of identityPlan.errors) {
    failed += 1;
    if (onError) await onError(entry.error, { game: entry.game, stage: "identity_plan" });
  }
  const mainPlan = await planV3MainJobs(env.AUTH_DB, games, now);
  created += mainPlan.created;
  if (onPlan) {
    for (const entry of mainPlan.planned) {
      try {
        await onPlan({ ...entry, stage: "main_plan", now });
      } catch (error) {
        failed += 1;
        if (onError) await onError(error, { game: entry.game, plan: entry.plan, stage: "main_plan_audit" });
      }
    }
  }
  for (const entry of mainPlan.errors) {
    failed += 1;
    if (onError) await onError(entry.error, { game: entry.game, stage: "main_plan" });
  }
  const due = await listDueV3Jobs(env.AUTH_DB, now);
  for (const job of due) {
    const claimed = await claimV3Job(env.AUTH_DB, { jobId: job.id, now });
    const planEntry = [...probablePlan.planned, ...rosterPlan.planned]
      .find((entry) => String(entry?.job?.id || "") === String(job.id));
    if (planEntry) {
      const claimAuditResult = claimed ? "claimed" : "claim_conflict";
      planEntry.diagnostic = {
        ...(planEntry.diagnostic || {}),
        actualJobExists: true,
        jobStatus: claimed?.status || job.status || null,
        claimEligible: ["pending", "retry_wait", "claimed"].includes(String(job.status || "")),
        claimResult: claimAuditResult
      };
      if (onPlan) {
        try {
          await onPlan({
            ...planEntry,
            stage: planEntry.plan?.jobType === "probable_starter_fetch"
              ? "probable_claim"
              : `${planEntry.plan?.jobType || job.job_type}_claim`,
            claimResult: claimAuditResult,
            now
          });
        } catch (error) {
          failed += 1;
          if (onError) await onError(error, { game: planEntry.game, plan: planEntry.plan, stage: "v3_job_claim_audit" });
        }
      }
    }
    if (!claimed) continue;
    processed += 1;
    const executionNow = new Date(monotonicV3JobTimestamp(now, claimed.created_at, claimed.claimed_at));
    try {
      const result = await executeJob({ env, job: claimed, internalGameId: claimed.internal_game_id, now: executionNow });
      assertV3AuxiliaryJobResult(claimed, result, executionNow);
      await completeV3Job(env.AUTH_DB, {
        jobId: claimed.id,
        claimToken: claimed.claim_token,
        now: executionNow,
        failureCode: result?.failureCode || null,
        failureMessage: result?.failureMessage || null
      });
      if (result?.stateAfter && result.stateBefore && result.stateAfter !== result.stateBefore) {
        await transitionV3State(env.AUTH_DB, {
          internalGameId: claimed.internal_game_id,
          from: result.stateBefore,
          to: result.stateAfter,
          now: executionNow,
          failureCode: null,
          failureMessage: null
        });
      }
      const completedJob = await env.AUTH_DB.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(claimed.id)).first();
      if (onSuccess) await onSuccess({ job: completedJob || { ...claimed, status: "completed", completed_at: executionNow.toISOString(), updated_at: executionNow.toISOString() }, claimToken: claimed.claim_token, result, now: executionNow });
      if (claimed.job_type === "npb_identity_resolve" && result?.identityResolved) {
        const followupGame = games.find((game) => game.internalGameId === claimed.internal_game_id);
        if (followupGame) {
          followupGame.npbIdentityStatus = "resolved";
          const followupState = await env.AUTH_DB.prepare(
            "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
          ).bind(claimed.internal_game_id).first();
          const followupPlan = getV3DuePlan(followupGame, followupState?.state || "scheduled", now);
          if (followupPlan && ["lineup_fetch", "lineup_finalize"].includes(followupPlan.jobType)) {
            await createV3Job(env.AUTH_DB, { internalGameId: claimed.internal_game_id, ...followupPlan });
          }
        }
      }
    } catch (error) {
      failed += 1;
      await retryV3Job(env.AUTH_DB, {
        jobId: claimed.id,
        claimToken: claimed.claim_token,
        attemptCount: claimed.attempt_count,
        maxAttempts: claimed.max_attempts,
        now: executionNow,
        errorCode: error?.code || "V3_JOB_FAILED",
        errorMessage: formatV3JobFailureMessage(error),
        retryAt: error?.retryAt || new Date(executionNow.getTime() + 10 * 60 * 1000)
      });
      const retryJob = await env.AUTH_DB.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1 LIMIT 1").bind(Number(claimed.id)).first();
      if (onError) await onError(error, { job: retryJob || claimed, claimToken: claimed.claim_token, stage: "execute", stateBefore: claimed.status });
    }
  }
  return {
    enabled: true,
    schemaReady: true,
    gameCount: games.length,
    created,
    processed,
    failed,
    probablePlan,
    rosterPlan,
    identityPlan,
    mainPlan
  };
}
