import schedule from "./game-schedule-2026.json" with { type: "json" };

let detectedScheduleGames = [];

// 試合前処理の時刻は、クライアントとAuth Workerで同じ定義を使う。
export const ROSTER_CAPTURE_MINUTES_BEFORE_START = 120;
export const PREDICTION_DEADLINE_MINUTES_BEFORE_START = 60;
export const LINEUP_FETCH_START_MINUTES_BEFORE_START = 60;
export const LINEUP_FETCH_INTERVAL_MINUTES = 10;
export const RESULT_RELEASE_MINUTES_AFTER_START = 0;
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
    resultReleaseAt: new Date(startAt.getTime() + RESULT_RELEASE_MINUTES_AFTER_START * 60 * 1000)
  };
}

export function getPregameTimelines() {
  const ids = new Set();
  return [...detectedScheduleGames, ...schedule]
    .filter((game) => game?.gameId && !ids.has(game.gameId) && Boolean(ids.add(game.gameId)))
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

if (typeof window !== "undefined") {
  window.STARTING9_PREGAME_CONFIG = Object.freeze({
    rosterCaptureMinutesBeforeStart: ROSTER_CAPTURE_MINUTES_BEFORE_START,
    predictionDeadlineMinutesBeforeStart: PREDICTION_DEADLINE_MINUTES_BEFORE_START,
    lineupFetchStartMinutesBeforeStart: LINEUP_FETCH_START_MINUTES_BEFORE_START,
    lineupFetchIntervalMinutes: LINEUP_FETCH_INTERVAL_MINUTES,
    resultReleaseMinutesAfterStart: RESULT_RELEASE_MINUTES_AFTER_START,
    noticeMonitorStartHourJst: NOTICE_MONITOR_START_HOUR_JST,
    noticeEarlyIntervalMinutes: NOTICE_EARLY_INTERVAL_MINUTES,
    noticeActiveIntervalMinutes: NOTICE_ACTIVE_INTERVAL_MINUTES
  });
}
