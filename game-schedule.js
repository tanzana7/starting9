const NPB_TEAM_CODES = Object.freeze({
  fighters: "f",
  buffaloes: "b",
  hawks: "h",
  lions: "l",
  eagles: "e",
  marines: "m",
  giants: "g",
  tigers: "t",
  baystars: "db",
  carp: "c",
  dragons: "d",
  swallows: "s"
});

function generateNpbScoreUrl(game) {
  const date = typeof game?.date === "string" ? game.date : "";
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dateMatch) {
    throw new Error("dateがYYYY-MM-DD形式ではありません");
  }
  const dateValue = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== date) {
    throw new Error("dateが実在する日付ではありません");
  }

  const homeCode = NPB_TEAM_CODES[game?.homeTeam];
  const awayCode = NPB_TEAM_CODES[game?.awayTeam];
  if (!homeCode || !awayCode) {
    throw new Error(`未知のチームコードです: ${game?.homeTeam || ""}-${game?.awayTeam || ""}`);
  }

  const round = Number(game?.round);
  if (!Number.isInteger(round) || round < 1) {
    throw new Error("roundが正の整数ではありません");
  }

  return `https://npb.jp/scores/${dateMatch[1]}/${dateMatch[2]}${dateMatch[3]}/${homeCode}-${awayCode}-${round}/`;
}

(function loadHamGameSchedule() {
  if (typeof window === "undefined" || typeof fetch !== "function") {
    return;
  }

  const scheduleUrl = "game-schedule-2026.json";
  const scheduleRoot = typeof window !== "undefined" ? window : globalThis;

  scheduleRoot.HAM_GAME_SCHEDULE = [];
  scheduleRoot.HAM_GAME_SCHEDULE_ERROR = "";
  scheduleRoot.HAM_GAME_SCHEDULE_LOG = [];

  const addScheduleLog = (message) => {
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
    scheduleRoot.HAM_GAME_SCHEDULE_LOG.push(`[${time}] ${message}`);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("ham-schedule-log-updated"));
    }
  };

  scheduleRoot.addHamScheduleLog = addScheduleLog;
  scheduleRoot.generateNpbScoreUrl = generateNpbScoreUrl;
  addScheduleLog("日程JSONの読み込みを開始");

  scheduleRoot.HAM_GAME_SCHEDULE_READY = fetch(scheduleUrl, { cache: "no-store" })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    })
    .then((schedule) => {
      if (!Array.isArray(schedule)) {
        throw new Error("JSONのルートが配列ではありません");
      }

      const gameIds = schedule.map((game) => game?.gameId);
      if (gameIds.some((gameId) => typeof gameId !== "string" || !gameId.trim())) {
        throw new Error("gameIdがない試合が含まれています");
      }

      const duplicateIds = gameIds.filter((gameId, index) => gameIds.indexOf(gameId) !== index);
      if (duplicateIds.length > 0) {
        throw new Error(`gameIdが重複しています: ${[...new Set(duplicateIds)].join(", ")}`);
      }

      schedule.sort((left, right) => {
        const leftValue = `${left.date || left.startDateTime || ""}T${left.startTime || ""}`;
        const rightValue = `${right.date || right.startDateTime || ""}T${right.startTime || ""}`;
        return leftValue.localeCompare(rightValue);
      });

      scheduleRoot.HAM_GAME_SCHEDULE = schedule;
      addScheduleLog(`日程JSONを読み込みました：${schedule.length}試合`);
      return schedule;
    })
    .catch((error) => {
      const message = `試合スケジュールの読み込みに失敗しました: ${error.message}`;
      scheduleRoot.HAM_GAME_SCHEDULE = [];
      scheduleRoot.HAM_GAME_SCHEDULE_ERROR = message;
      addScheduleLog(`日程JSON読み込み失敗：${error.message}`);
      console.error(message, error);
      return [];
    });
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { NPB_TEAM_CODES, generateNpbScoreUrl };
}
