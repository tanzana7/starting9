import {
  PREDICTION_DEADLINE_MINUTES_BEFORE_START,
  getScheduledGame,
  isScheduleGameUnavailable,
  parseJstScheduleStart
} from "./pregame-automation.js";

export { PREDICTION_DEADLINE_MINUTES_BEFORE_START, getScheduledGame, parseJstScheduleStart };
export const PREDICTION_DEADLINE_MILLISECONDS = PREDICTION_DEADLINE_MINUTES_BEFORE_START * 60 * 1000;

export function getPredictionDeadlineStatus(gameId, now = new Date()) {
  const game = getScheduledGame(gameId);
  if (!game) {
    return {
      ok: false,
      code: "PREDICTION_SCHEDULE_UNAVAILABLE",
      message: "この試合の日程情報を確認できないため、予想は保存できません。"
    };
  }

  if (isScheduleGameUnavailable(game)) {
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
