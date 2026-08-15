(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicRosterController(deps) {
    function normalizeSnapshotStatus(snapshot) {
      const status = String(snapshot?.status || "").trim().toLowerCase();
      if (status === "captured" || status === "fresh") return "fresh";
      if (status === "attention") return "attention";
      if (["baseline", "stale", "fallback"].includes(status)) return status;
      return "pending";
    }

    function getStoredRosterFallback(internalGameId, gameDate) {
      const snapshot = typeof deps.getRosterSnapshotForCurrentGame === "function"
        ? deps.getRosterSnapshotForCurrentGame()
        : null;
      const players = deps.normalizeRosterEntries(snapshot?.players);
      if (!snapshot || snapshot.internalGameId !== internalGameId || (gameDate && snapshot.gameDate !== gameDate) || !players.length) {
        return null;
      }
      return {
        internalGameId,
        gameDate: snapshot.gameDate || gameDate,
        players,
        status: "stale",
        isLoading: true,
        usableUntil: ""
      };
    }

    async function syncCurrentGameRoster() {
      const internalGameId = deps.getTargetInternalGameId();
      const gameDate = String(deps.state.predictionTargetGame?.date || "").slice(0, 10);
      const request = deps.requestGuard.begin("roster", { abort: true });
      const requestId = request.id;
      deps.setRosterRequestId(requestId);
      const storedFallback = getStoredRosterFallback(internalGameId, gameDate);
      deps.state.publicRoster = storedFallback || {
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
      const snapshotStatus = normalizeSnapshotStatus(gameSnapshot);
      if (gameSnapshot.ok && gameSnapshot.internalGameId === internalGameId
        && gameSnapshot.players.length && snapshotStatus !== "pending") {
        deps.state.publicRoster = {
          internalGameId,
          gameDate: gameSnapshot.gameDate || gameDate,
          status: snapshotStatus,
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
      } else if (storedFallback) {
        deps.state.publicRoster = {
          ...storedFallback,
          isLoading: false
        };
      }
      deps.syncPublicAppState();
      deps.renderPicker("prediction");
      deps.renderPredictionDeadline();
    }

    function renderPredictionRosterFilter() {
      const filter = deps.state.candidateRosterFilter === "inactive" ? "inactive" : "active";
      const publicRosterReady = deps.hasUsablePublicRosterForCurrentGame();
      const rosterStatus = String(deps.state.publicRoster?.status || "pending");
      const hasFallbackRoster = ["baseline", "stale", "fallback", "attention"].includes(rosterStatus) && publicRosterReady;
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
        const message = hasFallbackRoster
          ? "選手情報の更新を確認中です。表示中の選手一覧は前回取得データの場合があります。"
          : publicRosterReady
            ? ""
            : "選手情報を更新中です。選手一覧を取得できるまでお待ちください。";
        status.textContent = message;
        status.classList.toggle("hidden", !message);
      }
    }

    return { syncCurrentGameRoster, renderPredictionRosterFilter };
  }

  publicFrontend.createPublicRosterController = createPublicRosterController;
})();
