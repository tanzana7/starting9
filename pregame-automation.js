import schedule from "./game-schedule-2026.json" with { type: "json" };
import { V3_TIMING, deriveV3Schedule } from "./game-automation-v3.js";

let detectedScheduleGames = [];

// 試合前処理の時刻は、クライアントとAuth Workerで同じ定義を使う。
export const ROSTER_CAPTURE_MINUTES_BEFORE_START = V3_TIMING.rosterPregameMinutes;
export const PREDICTION_DEADLINE_MINUTES_BEFORE_START = V3_TIMING.predictionDeadlineMinutes;
export const LINEUP_FETCH_START_MINUTES_BEFORE_START = V3_TIMING.lineupPollingStartMinutes;
export const LINEUP_FETCH_INTERVAL_MINUTES = V3_TIMING.lineupPollingIntervalMinutes;
export const FINAL_LINEUP_FETCH_MINUTES_AFTER_START = V3_TIMING.finalLineupMinutesAfterStart;
export const FINAL_LINEUP_FETCH_INTERVAL_MINUTES = V3_TIMING.lineupPollingIntervalMinutes;
export const FINAL_LINEUP_RETRY_WINDOW_HOURS = 12;
export const RESULT_RELEASE_MINUTES_AFTER_START = V3_TIMING.publicationMinutesAfterStart;
export const PROBABLE_STARTER_RETRY_INTERVAL_MINUTES = 60;
export const ROSTER_AUTO_FETCH_INTERVAL_MINUTES = V3_TIMING.rosterRegularIntervalMinutes;
export const ROSTER_FETCH_RETRY_INTERVAL_MINUTES = 30;
export const ROSTER_PREGAME_CHECK_MINUTES = V3_TIMING.rosterPregameMinutes;
export const NOTICE_MONITOR_START_HOUR_JST = 10;
export const NOTICE_EARLY_INTERVAL_MINUTES = 30;
export const NOTICE_ACTIVE_INTERVAL_MINUTES = 10;

function deriveAutomationSchedule(input = {}) {
  const schedule = deriveV3Schedule(input);
  return {
    internalGameId: input.internalGameId || input.internal_game_id || "",
    gameDate: input.gameDate || input.game_date || "",
    startAt: schedule.startAt.toISOString(),
    homeTeam: input.homeTeam || input.home_team || "",
    awayTeam: input.awayTeam || input.away_team || "",
    npbGameCode: input.npbGameCode || input.npb_game_code || null,
    status: input.status || input.gameStatus || "scheduled",
    updatedBy: input.updatedBy || input.updated_by || "system",
    updatedAt: input.updatedAt || input.updated_at || "",
    predictionDeadline: schedule.predictionDeadline.toISOString(),
    rosterFetchAt1: schedule.rosterFetchAt1.toISOString(),
    rosterFetchAt2: schedule.rosterFetchAt2.toISOString(),
    lineupPollingStart: schedule.lineupPollingStart.toISOString(),
    finalLineupAt: schedule.finalLineupAt.toISOString(),
    publicationAt: schedule.publicationAt.toISOString()
  };
}

function getV3RosterExecutorDecision(schedule, state = {}, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const startAt = schedule?.startAt instanceof Date ? schedule.startAt : new Date(schedule?.startAt || "");
  if (Number.isNaN(current.getTime()) || Number.isNaN(startAt.getTime())) return { due: false, reason: "SCHEDULE_START_AT_UNAVAILABLE" };
  if (current >= startAt) return { due: false, reason: "AFTER_START" };

  const nextCheckAt = state?.nextCheckAt ? new Date(state.nextCheckAt) : null;
  if (nextCheckAt && !Number.isNaN(nextCheckAt.getTime()) && current < nextCheckAt) {
    return { due: false, reason: "RETRY_WAIT" };
  }

  const gameId = String(state?.gameId || "");
  const pregame = new Date(startAt.getTime() - V3_TIMING.rosterPregameMinutes * 60 * 1000);
  if (current >= pregame && state?.lastPregameCheckGameId !== gameId) return { due: true, kind: "pregame" };

  const secondPregame = new Date(startAt.getTime() - V3_TIMING.rosterSecondPregameMinutes * 60 * 1000);
  if (current >= secondPregame && state?.lastPregameCheckGameId !== gameId) return { due: true, kind: "pregame" };

  const successfulAt = state?.lastSuccessfulFetchAt ? new Date(state.lastSuccessfulFetchAt) : null;
  if (!successfulAt || Number.isNaN(successfulAt.getTime())
    || current.getTime() - successfulAt.getTime() >= V3_TIMING.rosterRegularIntervalMinutes * 60 * 1000) {
    return { due: true, kind: "daily" };
  }
  return { due: false, reason: "DAILY_INTERVAL" };
}

export function getScheduledGame(gameId) {
  const normalized = typeof gameId === "string" ? gameId.trim() : "";
  const merged = getScheduledGames();
  const exact = merged.find((game) => game?.gameId === normalized);
  if (exact) return exact;
  const raw = [...detectedScheduleGames, ...schedule].find((game) => game?.gameId === normalized);
  if (!raw) return null;
  const identity = getScheduleIdentity(raw);
  const enriched = identity ? merged.find((game) => getScheduleIdentity(game) === identity) : null;
  return enriched ? { ...enriched, gameId: normalized } : raw;
}

export function setDetectedScheduleGames(games) {
  detectedScheduleGames = Array.isArray(games) ? games.filter((game) => game?.gameId) : [];
}

// 実行対象外の中止試合も、Cronの観測要約では状態を区別するために参照します。
export function getScheduledGames() {
  const identities = new Map();
  for (const game of [...detectedScheduleGames, ...schedule]) {
    if (!game?.gameId) continue;
    const key = getScheduleIdentity(game);
    if (!key || !identities.has(key)) {
      identities.set(key || `id:${game.gameId}`, game);
      continue;
    }
    const current = identities.get(key);
    // D1で保持したフォールバックIDを維持しつつ、静的日程の公式gameCodeを補完します。
    const currentGameCode = getScheduleGameCode(current);
    const candidateGameCode = getScheduleGameCode(game);
    if (!currentGameCode && candidateGameCode) {
      identities.set(key, { ...current, gameCode: candidateGameCode });
    }
  }
  return [...identities.values()];
}

function getScheduleGameCode(game) {
  const explicit = String(game?.gameCode || "").trim().toLowerCase();
  if (/^[a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+$/.test(explicit)) return explicit;
  const fromId = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(String(game?.gameId || ""))?.[1] || "";
  if (/^[a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+$/i.test(fromId)) return fromId.toLowerCase();
  const fromUrl = /\/scores\/\d{4}\/\d{4}\/([a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+)\//i.exec(String(game?.npbScoreUrl || ""))?.[1] || "";
  return fromUrl.toLowerCase();
}

function getScheduleIdentity(game) {
  const date = String(game?.date || "");
  const homeTeam = String(game?.homeTeam || "").trim().toLowerCase();
  const awayTeam = String(game?.awayTeam || "").trim().toLowerCase();
  const startAt = game?.startAt instanceof Date ? game.startAt : parseJstScheduleStart(game);
  if (!date || !homeTeam || !awayTeam || !startAt || Number.isNaN(startAt.getTime())) return "";
  return `${date}|${startAt.toISOString()}|${homeTeam}|${awayTeam}`;
}

export function parseJstScheduleStart(game) {
  const date = typeof game?.date === "string" ? game.date : "";
  const startTime = typeof game?.startTime === "string" ? game.startTime : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) return null;
  const startAt = new Date(`${date}T${startTime}:00+09:00`);
  return Number.isNaN(startAt.getTime()) ? null : startAt;
}

export function isScheduleGameUnavailable(game) {
  return ["cancelled", "canceled", "postponed"].includes(String(game?.status || "").toLowerCase());
}

export function getPregameTimeline(gameId) {
  const game = getScheduledGame(gameId);
  return buildPregameTimeline(game);
}

// D1で検出した日程も、静的日程と同じ基準時刻から処理できるようにします。
export function buildPregameTimeline(game) {
  if (!game || isScheduleGameUnavailable(game)) return null;
  const storedStartAt = game.startAt instanceof Date ? game.startAt : new Date(game.startAt || "");
  const startAt = !Number.isNaN(storedStartAt.getTime())
    ? storedStartAt
    : parseJstScheduleStart(game);
  if (!startAt) return null;
  const canonical = deriveAutomationSchedule({
    internalGameId: game.internalGameId || game.internal_game_id || game.gameId,
    gameDate: game.date || game.game_date,
    startAt,
    homeTeam: game.homeTeam || game.home_team,
    awayTeam: game.awayTeam || game.away_team,
    npbGameCode: game.gameCode || game.game_code,
    status: game.status || game.game_status || "scheduled",
    updatedBy: game.updatedBy || game.updated_by || "system",
    updatedAt: game.updatedAt || game.updated_at || ""
  });
  if (!canonical) return null;
  const offset = (minutes) => new Date(startAt.getTime() - minutes * 60 * 1000);
  return {
    game,
    gameId: game.gameId,
    startAt,
    canonical,
    rosterCaptureAt: new Date(canonical.rosterFetchAt1),
    rosterFetchAt1: new Date(canonical.rosterFetchAt1),
    rosterFetchAt2: new Date(canonical.rosterFetchAt2),
    predictionDeadlineAt: new Date(canonical.predictionDeadline),
    lineupFetchStartAt: new Date(canonical.lineupPollingStart),
    finalLineupFetchAt: new Date(canonical.finalLineupAt),
    resultReleaseAt: new Date(canonical.publicationAt)
  };
}

export function getPregameTimelines() {
  return getScheduledGames()
    .map((game) => getPregameTimeline(game.gameId)).filter(Boolean);
}

export function getJstDateString(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getNoticePollingPlan(timelines, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const date = getJstDateString(current);
  if (!date || Number.isNaN(current.getTime())) return { date: "", due: false, intervalMinutes: null, slotKey: "", activeGameIds: [] };
  const today = (Array.isArray(timelines) ? timelines : []).filter((timeline) => {
    return timeline?.game?.date === date && current < timeline.predictionDeadlineAt;
  });
  const monitorStart = new Date(`${date}T${String(NOTICE_MONITOR_START_HOUR_JST).padStart(2, "0")}:00:00+09:00`);
  if (current < monitorStart || today.length === 0) {
    return { date, due: false, intervalMinutes: null, slotKey: "", activeGameIds: today.map((timeline) => timeline.gameId) };
  }

  const highFrequency = today.some((timeline) => current >= new Date(timeline.startAt.getTime() - 2 * 60 * 60 * 1000));
  const intervalMinutes = highFrequency ? NOTICE_ACTIVE_INTERVAL_MINUTES : NOTICE_EARLY_INTERVAL_MINUTES;
  const anchor = highFrequency
    ? new Date(Math.min(...today.map((timeline) => timeline.startAt.getTime() - 2 * 60 * 60 * 1000)))
    : monitorStart;
  const elapsedMinutes = Math.floor((current.getTime() - anchor.getTime()) / (60 * 1000));
  const slot = Math.max(0, Math.floor(elapsedMinutes / intervalMinutes));
  return {
    date,
    due: true,
    intervalMinutes,
    slotKey: `${date}:${intervalMinutes}:${slot}`,
    activeGameIds: today.map((timeline) => timeline.gameId)
  };
}

// Cronは毎分でなくてもよい。現在時刻が入っている10分枠を一度だけ処理する。
export function getDueLineupAttemptAt(timeline, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime()) || current < timeline.lineupFetchStartAt || current > timeline.startAt) return null;
  const elapsed = current.getTime() - timeline.lineupFetchStartAt.getTime();
  const interval = LINEUP_FETCH_INTERVAL_MINUTES * 60 * 1000;
  return new Date(timeline.lineupFetchStartAt.getTime() + Math.floor(elapsed / interval) * interval);
}

export function getDueFinalLineupAttemptAt(timeline, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const first = timeline?.finalLineupFetchAt || (timeline?.startAt ? new Date(timeline.startAt.getTime() + FINAL_LINEUP_FETCH_MINUTES_AFTER_START * 60 * 1000) : null);
  if (!first || Number.isNaN(current.getTime()) || current < first) return null;
  const elapsed = current.getTime() - first.getTime();
  const interval = FINAL_LINEUP_FETCH_INTERVAL_MINUTES * 60 * 1000;
  return new Date(first.getTime() + Math.floor(elapsed / interval) * interval);
}

export function getFinalLineupRetryDeadline(timeline) {
  const startAt = timeline?.startAt instanceof Date ? timeline.startAt : new Date(timeline?.startAt || "");
  if (!Number.isNaN(startAt.getTime())) {
    return new Date(startAt.getTime() + FINAL_LINEUP_RETRY_WINDOW_HOURS * 60 * 60 * 1000);
  }
  const gameDate = String(timeline?.game?.date || timeline?.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) return null;
  const nextMorning = new Date(`${gameDate}T06:00:00+09:00`);
  nextMorning.setUTCDate(nextMorning.getUTCDate() + 1);
  return Number.isNaN(nextMorning.getTime()) ? null : nextMorning;
}

export function isFinalLineupRetryExpired(timeline, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const deadline = getFinalLineupRetryDeadline(timeline);
  return Boolean(deadline && !Number.isNaN(current.getTime()) && current >= deadline);
}

export function getRosterFetchDecision(timeline, state = {}, now = new Date()) {
  const v3Decision = getV3RosterExecutorDecision({
    gameDate: timeline?.game?.date || timeline?.date,
    startAt: timeline?.startAt,
    predictionDeadline: timeline?.predictionDeadlineAt,
    lineupPollingStart: timeline?.lineupFetchStartAt,
    finalLineupAt: timeline?.finalLineupFetchAt
  }, { ...state, gameId: timeline?.gameId }, now);
  if (v3Decision.reason === "SCHEDULE_START_AT_UNAVAILABLE") return { due: false, reason: "invalid" };
  if (v3Decision.reason === "AFTER_START") return { due: false, reason: "after_start" };
  if (v3Decision.reason === "RETRY_WAIT") return { due: false, reason: "retry_wait" };
  if (v3Decision.reason === "DAILY_INTERVAL") return { due: false, reason: "interval" };
  if (v3Decision.due) {
    const decision = { due: true, kind: v3Decision.kind === "daily" ? "regular" : v3Decision.kind };
    if (v3Decision.slot) decision.slot = v3Decision.slot;
    return decision;
  }
  const current = now instanceof Date ? now : new Date(now);
  const startAt = timeline?.startAt instanceof Date ? timeline.startAt : new Date(timeline?.startAt || "");
  const gameId = String(timeline?.gameId || "");
  if (!gameId || Number.isNaN(current.getTime()) || Number.isNaN(startAt.getTime())) {
    return { due: false, reason: "invalid" };
  }
  if (current >= startAt) {
    return { due: false, reason: "after_start" };
  }

  const nextCheckAt = state?.nextCheckAt ? new Date(state.nextCheckAt) : null;
  if (nextCheckAt && !Number.isNaN(nextCheckAt.getTime()) && current < nextCheckAt) {
    return { due: false, reason: "retry_wait" };
  }

  const pregameAt = new Date(startAt.getTime() - ROSTER_PREGAME_CHECK_MINUTES * 60 * 1000);
  if (current >= pregameAt && state?.lastPregameCheckGameId !== gameId) {
    return { due: true, kind: "pregame" };
  }

  const successfulAt = state?.lastSuccessfulFetchAt ? new Date(state.lastSuccessfulFetchAt) : null;
  if (!successfulAt || Number.isNaN(successfulAt.getTime())
    || current.getTime() - successfulAt.getTime() >= ROSTER_AUTO_FETCH_INTERVAL_MINUTES * 60 * 1000) {
    return { due: true, kind: "regular" };
  }
  return { due: false, reason: "interval" };
}

if (typeof window !== "undefined") {
  window.STARTING9_PREGAME_CONFIG = Object.freeze({
    rosterCaptureMinutesBeforeStart: ROSTER_CAPTURE_MINUTES_BEFORE_START,
    predictionDeadlineMinutesBeforeStart: PREDICTION_DEADLINE_MINUTES_BEFORE_START,
    lineupFetchStartMinutesBeforeStart: LINEUP_FETCH_START_MINUTES_BEFORE_START,
    lineupFetchIntervalMinutes: LINEUP_FETCH_INTERVAL_MINUTES,
    finalLineupFetchMinutesAfterStart: FINAL_LINEUP_FETCH_MINUTES_AFTER_START,
    finalLineupFetchIntervalMinutes: FINAL_LINEUP_FETCH_INTERVAL_MINUTES,
    finalLineupRetryWindowHours: FINAL_LINEUP_RETRY_WINDOW_HOURS,
    resultReleaseMinutesAfterStart: RESULT_RELEASE_MINUTES_AFTER_START,
    probableStarterRetryIntervalMinutes: PROBABLE_STARTER_RETRY_INTERVAL_MINUTES,
    rosterAutoFetchIntervalMinutes: ROSTER_AUTO_FETCH_INTERVAL_MINUTES,
    rosterFetchRetryIntervalMinutes: ROSTER_FETCH_RETRY_INTERVAL_MINUTES,
    rosterPregameCheckMinutes: ROSTER_PREGAME_CHECK_MINUTES,
    noticeMonitorStartHourJst: NOTICE_MONITOR_START_HOUR_JST,
    noticeEarlyIntervalMinutes: NOTICE_EARLY_INTERVAL_MINUTES,
    noticeActiveIntervalMinutes: NOTICE_ACTIVE_INTERVAL_MINUTES
  });
}
