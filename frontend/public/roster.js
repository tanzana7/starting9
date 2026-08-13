(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicRosterController(deps) {
    async function syncCurrentGameRoster() {
      const internalGameId = deps.getTargetInternalGameId();
      const gameDate = String(deps.state.predictionTargetGame?.date || "").slice(0, 10);
      const request = deps.requestGuard.begin("roster", { abort: true });
      const requestId = request.id;
      deps.setRosterRequestId(requestId);
      deps.state.publicRoster = {
        internalGameId,
        gameDate,
        status: "pending",
        players: [],
        isLoading: true,
        usableUntil: ""
      };
      deps.syncPublicAppState();
      deps.renderPicker("prediction");
      deps.renderPredictionDeadline();

      const gameSnapshot = await deps.fetchGameDayRosterSnapshot(internalGameId, { signal: request.signal });
      if (!deps.requestGuard.isCurrent("roster", requestId)
        || requestId !== deps.getRosterRequestId()
        || internalGameId !== deps.getTargetInternalGameId()) {
        return;
      }

      deps.state.publicRoster.isLoading = false;
      if (gameSnapshot.ok && gameSnapshot.internalGameId === internalGameId && gameSnapshot.players.length) {
        deps.state.publicRoster = {
          internalGameId,
          gameDate: gameSnapshot.gameDate || gameDate,
          status: gameSnapshot.status === "baseline" ? "baseline" : "fresh",
          players: deps.normalizeRosterEntries(gameSnapshot.players),
          isLoading: false,
          usableUntil: gameSnapshot.usableUntil || ""
        };
        deps.syncPublicAppState();
        deps.storage.save(deps.storageKeys.rosterSnapshot, {
          internalGameId,
          gameDate: gameSnapshot.gameDate || deps.state.predictionTargetGame?.date || "",
          fetchedAt: gameSnapshot.capturedAt || new Date().toISOString(),
          sourceUrl: "auth-worker://game-day-roster",
          method: "game-day-roster-snapshot",
          warning: "",
          httpStatus: 200,
          cacheStatus: gameSnapshot.status === "baseline" ? "game-snapshot-baseline" : "game-snapshot",
          stale: false,
          parsedCount: gameSnapshot.players.length,
          announcedCount: gameSnapshot.players.length,
          players: gameSnapshot.players
        });
      }
      deps.syncPublicAppState();
      deps.renderPicker("prediction");
      deps.renderPredictionDeadline();
    }

    function renderPredictionRosterFilter() {
      const filter = deps.state.candidateRosterFilter === "inactive" ? "inactive" : "active";
      const publicRosterReady = deps.hasUsablePublicRosterForCurrentGame();
      document.querySelectorAll("[data-roster-filter]").forEach((button) => {
        const isSelected = button.dataset.rosterFilter === filter;
        button.classList.toggle("is-selected", isSelected);
        button.setAttribute("aria-pressed", isSelected ? "true" : "false");
        button.setAttribute("aria-selected", isSelected ? "true" : "false");
      });

      document.querySelectorAll('.player-chip[data-picker="prediction"]').forEach((chip) => {
        const player = deps.getPlayerData(chip.dataset.player);
        const shouldShow = publicRosterReady && (filter === "active"
          ? deps.isPlayerInCurrentRoster(player) && player?.isBatterCandidate === true
          : !deps.isPlayerInCurrentRoster(player) && player?.isBatterCandidate === true);
        chip.classList.toggle("hidden", !shouldShow);
      });

      const status = document.getElementById("predictionRosterStatus");
      if (status) {
        status.textContent = publicRosterReady ? "" : "選手一覧を更新中です。しばらくしてから再度ご確認ください。";
        status.classList.toggle("hidden", publicRosterReady);
      }
    }

    return { syncCurrentGameRoster, renderPredictionRosterFilter };
  }

  publicFrontend.createPublicRosterController = createPublicRosterController;
})();
