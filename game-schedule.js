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

function getJapanDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getJapanDateTimeString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function findNextHamGame(schedule = [], now = new Date()) {
  const currentDateTime = getJapanDateTimeString(now);
  return schedule
    .filter((game) => {
      if (typeof game?.date !== "string") {
        return false;
      }
      const scheduledDateTime = `${game.date}T${game.startTime || "23:59"}`;
      return scheduledDateTime >= currentDateTime;
    })
    .slice()
    .sort((left, right) => {
      const leftValue = `${left.date}T${left.startTime || "00:00"}`;
      const rightValue = `${right.date}T${right.startTime || "00:00"}`;
      return leftValue.localeCompare(rightValue);
    })[0] || null;
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
  scheduleRoot.getJapanDateString = getJapanDateString;
  scheduleRoot.getJapanDateTimeString = getJapanDateTimeString;
  scheduleRoot.findNextHamGame = findNextHamGame;
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
      const fallbackSchedule = getLocalScheduleFallback();
      scheduleRoot.HAM_GAME_SCHEDULE = fallbackSchedule;
      scheduleRoot.HAM_GAME_SCHEDULE_ERROR = fallbackSchedule.length > 0
        ? `${message} ローカル確認用の最小日程を使用します。`
        : message;
      addScheduleLog(`日程JSON読み込み失敗：${error.message}`);
      if (fallbackSchedule.length > 0) {
        addScheduleLog(`ローカル確認用日程を使用しました：${fallbackSchedule.length}試合`);
      }
      console.error(message, error);
      return fallbackSchedule;
    });
})();

function getLocalScheduleFallback() {
  if (typeof window === "undefined" || window.location?.protocol !== "file:") {
    return [];
  }

  return [
    {
      gameId: "2026-07-19-b-f-17",
      date: "2026-07-19",
      startTime: "13:00",
      homeTeam: "buffaloes",
      awayTeam: "fighters",
      matchupLabel: "オリックス vs 日本ハム",
      venue: "京セラドーム大阪",
      round: 17,
      npbScoreUrl: "https://npb.jp/scores/2026/0719/b-f-17/",
      rosterAutoFetchStartTime: "10:00",
      lineupAutoFetchStartOffsetMinutes: -50,
      lineupAutoFetchIntervalMinutes: 10
    }
  ];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { NPB_TEAM_CODES, generateNpbScoreUrl, getJapanDateString, getJapanDateTimeString, findNextHamGame };
}
