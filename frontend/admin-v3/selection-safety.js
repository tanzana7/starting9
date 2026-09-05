(function registerAdminV3SelectionSafety(global) {
  "use strict";

  function jstDate(value = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(value);
    const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : "";
  }

  function shiftDate(dateValue, days) {
    const date = new Date(`${String(dateValue || "").slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return "";
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function gameDate(game) {
    return String(game?.gameDate || game?.game_date || game?.startAt || game?.start_at || game?.startTime || game?.start_time || "").slice(0, 10);
  }

  function gameDayStatus(game, now = new Date()) {
    const date = gameDate(game);
    const today = jstDate(now);
    const tomorrow = shiftDate(today, 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { key: "unknown", label: "日付不明", date, isToday: false, isFuture: false, isPast: false, tone: "warning" };
    }
    if (date === today) return { key: "today", label: "今日", date, isToday: true, isFuture: false, isPast: false, tone: "today" };
    if (date === tomorrow) return { key: "tomorrow", label: "明日", date, isToday: false, isFuture: true, isPast: false, tone: "future" };
    if (date > today) return { key: "future", label: "今後", date, isToday: false, isFuture: true, isPast: false, tone: "future" };
    return { key: "past", label: "過去/別日", date, isToday: false, isFuture: false, isPast: true, tone: "past" };
  }

  function teamName(game, side) {
    return String(game?.[side] || game?.[`${side}Team`] || game?.[`${side}_team`] || "-").trim() || "-";
  }

  function isFightersGame(game) {
    return [teamName(game, "home"), teamName(game, "away")].some((value) => {
      const normalized = value.toLowerCase();
      return normalized === "f" || normalized === "fighters" || normalized.includes("fighter");
    });
  }

  function isUncompletedGame(game) {
    const workflowState = String(game?.state?.state || game?.workflowState || game?.workflow_status || "scheduled").trim().toLowerCase();
    const gameStatus = String(game?.gameStatus || game?.game_status || "scheduled").trim().toLowerCase();
    return !["published", "cancelled", "canceled", "service_unavailable", "excluded"].includes(workflowState)
      && !["completed", "cancelled", "canceled", "service_unavailable"].includes(gameStatus);
  }

  function preferredOperationalGame(games, now = new Date()) {
    const today = jstDate(now);
    return (Array.isArray(games) ? games : [])
      .filter((game) => isFightersGame(game) && gameDate(game) === today && isUncompletedGame(game))
      .sort((left, right) => String(left.startAt || left.start_time || "").localeCompare(String(right.startAt || right.start_time || "")))[0] || null;
  }

  function selectionWarning(game, now = new Date(), { corrected = false } = {}) {
    if (!game) return "";
    const status = gameDayStatus(game, now);
    const card = `${status.date || "日付不明"} ${teamName(game, "home")} vs ${teamName(game, "away")}`;
    if (corrected) return `保存済みの選択を補正し、本日の未完了Fighters戦（${card}）を操作対象にしました。`;
    if (status.key === "today") return "";
    if (status.isFuture) return `⚠ 未来試合を選択中です（${card}）。正式運用対象ではありません。read-only確認に留め、正式スタメン確定は行わないでください。`;
    if (status.isPast) return `⚠ 本日以外の過去/別日試合を選択中です（${card}）。操作対象の日付とinternalGameIdを確認してください。`;
    return `⚠ 対象試合の日付を確認できません（${card}）。正式スタメン確定は行わないでください。`;
  }

  function optionLabel(game, now = new Date()) {
    const status = gameDayStatus(game, now);
    const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
    const time = Number.isNaN(startAt.getTime()) ? "時刻不明" : new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false }).format(startAt);
    return `[${status.label}] ${status.date || "日付不明"} ${teamName(game, "home")} vs ${teamName(game, "away")} / ${time}`;
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3SelectionSafety = () => Object.freeze({
    gameDate,
    gameDayStatus,
    isFightersGame,
    isUncompletedGame,
    preferredOperationalGame,
    selectionWarning,
    optionLabel
  });
})(window);
