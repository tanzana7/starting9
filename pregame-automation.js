import schedule from "./game-schedule-2026.json" with { type: "json" };

let detectedScheduleGames = [];

// 試合前処理の時刻は、クライアントとAuth Workerで同じ定義を使う。
export const ROSTER_CAPTURE_MINUTES_BEFORE_START = 120;
export const PREDICTION_DEADLINE_MINUTES_BEFORE_START = 60;
export const LINEUP_FETCH_START_MINUTES_BEFORE_START = 50;
export const LINEUP_FETCH_INTERVAL_MINUTES = 10;
export const FINAL_LINEUP_FETCH_MINUTES_AFTER_START = 1;
export const FINAL_LINEUP_FETCH_INTERVAL_MINUTES = 10;
export const RESULT_RELEASE_MINUTES_AFTER_START = 5;
export const PROBABLE_STARTER_RETRY_INTERVAL_MINUTES = 60;
export const ROSTER_AUTO_FETCH_INTERVAL_MINUTES = 360;
export const ROSTER_FETCH_RETRY_INTERVAL_MINUTES = 30;
export const ROSTER_PREGAME_CHECK_MINUTES = 180;
export const NOTICE_MONITOR_START_HOUR_JST = 10;
export const NOTICE_EARLY_INTERVAL_MINUTES = 30;
export const NOTICE_ACTIVE_INTERVAL_MINUTES = 10;

export function getScheduledGame(gameId) {
  const normalized = typeof gameId === "string" ? gameId.trim() : "";
  return [...detectedScheduleGames, ...schedule].find((game) => game?.gameId === normalized) || null;
}

export function setDetectedScheduleGames(games) {
  detectedScheduleGames = Array.isArray(games) ? games.filter((game) => game?.gameId) : [];
}

// 実行対象外の中止試合も、Cronの観測要約では状態を区別するために参照します。
export function getScheduledGames() {
  const ids = new Set();
  return [...detectedScheduleGames, ...schedule]
    .filter((game) => game?.gameId && !ids.has(game.gameId) && Boolean(ids.add(game.gameId)));
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
  if (!game || isScheduleGameUnavailable(game)) return null;
  const startAt = parseJstScheduleStart(game);
  if (!startAt) return null;
  const offset = (minutes) => new Date(startAt.getTime() - minutes * 60 * 1000);
  return {
    game,
    gameId: game.gameId,
    startAt,
    rosterCaptureAt: offset(ROSTER_CAPTURE_MINUTES_BEFORE_START),
    predictionDeadlineAt: offset(PREDICTION_DEADLINE_MINUTES_BEFORE_START),
    lineupFetchStartAt: offset(LINEUP_FETCH_START_MINUTES_BEFORE_START),
    finalLineupFetchAt: new Date(startAt.getTime() + FINAL_LINEUP_FETCH_MINUTES_AFTER_START * 60 * 1000),
    resultReleaseAt: new Date(startAt.getTime() + RESULT_RELEASE_MINUTES_AFTER_START * 60 * 1000)
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

export function getRosterFetchDecision(timeline, state = {}, now = new Date()) {
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
