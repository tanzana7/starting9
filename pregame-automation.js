import schedule from "./game-schedule-2026.json" with { type: "json" };

// 試合前処理の時刻は、クライアントとAuth Workerで同じ定義を使う。
export const ROSTER_CAPTURE_MINUTES_BEFORE_START = 120;
export const PREDICTION_DEADLINE_MINUTES_BEFORE_START = 60;
export const LINEUP_FETCH_START_MINUTES_BEFORE_START = 60;
export const LINEUP_FETCH_INTERVAL_MINUTES = 10;
export const RESULT_RELEASE_MINUTES_AFTER_START = 0;

export function getScheduledGame(gameId) {
  const normalized = typeof gameId === "string" ? gameId.trim() : "";
  return schedule.find((game) => game?.gameId === normalized) || null;
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
  return schedule.map((game) => getPregameTimeline(game?.gameId)).filter(Boolean);
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
    resultReleaseMinutesAfterStart: RESULT_RELEASE_MINUTES_AFTER_START
  });
}
