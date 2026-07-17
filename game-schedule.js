(function loadHamGameSchedule() {
  const scheduleUrl = "game-schedule-2026.json";
  const scheduleRoot = typeof window !== "undefined" ? window : globalThis;

  scheduleRoot.HAM_GAME_SCHEDULE = [];
  scheduleRoot.HAM_GAME_SCHEDULE_ERROR = "";

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
      return schedule;
    })
    .catch((error) => {
      const message = `試合スケジュールの読み込みに失敗しました: ${error.message}`;
      scheduleRoot.HAM_GAME_SCHEDULE = [];
      scheduleRoot.HAM_GAME_SCHEDULE_ERROR = message;
      console.error(message, error);
      return [];
    });
})();
