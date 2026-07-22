import schedule from "./game-schedule-2026.json" with { type: "json" };

export const PREDICTION_DEADLINE_MINUTES_BEFORE_START = 10;
export const PREDICTION_DEADLINE_MILLISECONDS = PREDICTION_DEADLINE_MINUTES_BEFORE_START * 60 * 1000;

export function getScheduledGame(gameId) {
  const normalizedGameId = typeof gameId === "string" ? gameId.trim() : "";
  return schedule.find((game) => game?.gameId === normalizedGameId) || null;
}

export function parseJstScheduleStart(game) {
  const date = typeof game?.date === "string" ? game.date : "";
  const startTime = typeof game?.startTime === "string" ? game.startTime : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime)) {
    return null;
  }

  const startAt = new Date(`${date}T${startTime}:00+09:00`);
  return Number.isNaN(startAt.getTime()) ? null : startAt;
}

export function getPredictionDeadlineStatus(gameId, now = new Date()) {
  const game = getScheduledGame(gameId);
  if (!game) {
    return {
      ok: false,
      code: "PREDICTION_SCHEDULE_UNAVAILABLE",
      message: "この試合の日程情報を確認できないため、予想は保存できません。"
    };
  }

  if (["cancelled", "canceled", "postponed"].includes(String(game.status || "").toLowerCase())) {
    return {
      ok: false,
      code: "GAME_NOT_AVAILABLE",
      message: "この試合は予想を受け付けていません。"
    };
  }

  const startAt = parseJstScheduleStart(game);
  if (!startAt) {
    return {
      ok: false,
      code: "PREDICTION_SCHEDULE_UNAVAILABLE",
      message: "試合開始時刻を確認できないため、予想は保存できません。"
    };
  }

  const deadlineAt = new Date(startAt.getTime() - PREDICTION_DEADLINE_MILLISECONDS);
  const currentTime = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(currentTime.getTime())) {
    return {
      ok: false,
      code: "PREDICTION_SCHEDULE_UNAVAILABLE",
      message: "現在時刻を確認できないため、予想は保存できません。"
    };
  }

  return {
    ok: true,
    game,
    gameId: game.gameId,
    startAt: startAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    isClosed: currentTime.getTime() >= deadlineAt.getTime(),
    code: currentTime.getTime() >= deadlineAt.getTime() ? "PREDICTION_DEADLINE_PASSED" : "PREDICTION_DEADLINE_OPEN",
    message: currentTime.getTime() >= deadlineAt.getTime()
      ? "この試合の予想受付は終了しました。"
      : "予想を受け付けています。"
  };
}
