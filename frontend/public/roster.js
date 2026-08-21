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
        displayRosterSource: "fallback_snapshot",
        sourceOfTruth: "stale_snapshot",
        rosterUse: "stale_snapshot",
        canUseForPrediction: true,
        warning: "公式liveを取得できないため、前回取得データを表示しています。",
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
      deps.state.publicRoster = {
        internalGameId,
        gameDate,
        status: "pending",
        players: [],
        displayRosterSource: "",
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
      const acceptedSources = ["official_live", "verified_snapshot", "stale_snapshot", "baseline_snapshot"];
      const apiSource = String(gameSnapshot.rosterUse || gameSnapshot.sourceOfTruth || "");
      const legacyApiSource = gameSnapshot.displayRosterSource === "latest_official_live" && gameSnapshot.status === "fresh"
        ? "official_live"
        : gameSnapshot.displayRosterSource === "stale_snapshot" && gameSnapshot.status === "stale"
          ? "stale_snapshot"
          : gameSnapshot.displayRosterSource === "baseline_snapshot" && gameSnapshot.status === "baseline"
            ? "baseline_snapshot"
            : "";
      const adoptedApiSource = acceptedSources.includes(apiSource) ? apiSource : legacyApiSource;
      const canUseApiRoster = (gameSnapshot.canUseForPrediction === true && acceptedSources.includes(apiSource))
        || Boolean(adoptedApiSource);
      if (gameSnapshot.ok && gameSnapshot.internalGameId === internalGameId
        && gameSnapshot.players.length && snapshotStatus !== "pending" && canUseApiRoster) {
        const cached = typeof deps.getRosterSnapshotForCurrentGame === "function"
          ? deps.getRosterSnapshotForCurrentGame()
          : null;
        if (cached?.fingerprint && gameSnapshot.fingerprint && cached.fingerprint !== gameSnapshot.fingerprint) {
          deps.storage.remove(deps.storageKeys.rosterSnapshot);
        }
        deps.state.publicRoster = {
          internalGameId,
          gameDate: gameSnapshot.gameDate || gameDate,
          status: snapshotStatus,
          displayRosterSource: typeof gameSnapshot.displayRosterSource === "string"
            ? gameSnapshot.displayRosterSource
            : snapshotStatus === "fresh" ? "fresh_snapshot" : "",
          sourceOfTruth: adoptedApiSource,
          rosterUse: adoptedApiSource,
          canUseForPrediction: true,
          verified: gameSnapshot.verified === true,
          fingerprint: gameSnapshot.fingerprint || "",
          verifiedAt: gameSnapshot.verifiedAt || "",
          officialPlayerCount: gameSnapshot.officialPlayerCount ?? null,
          snapshotPlayerCount: gameSnapshot.snapshotPlayerCount ?? null,
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
          warning: typeof gameSnapshot.warning === "string" ? gameSnapshot.warning : "",
          httpStatus: 200,
          cacheStatus: gameSnapshot.cacheStatus
            || (gameSnapshot.status === "baseline" ? "game-snapshot-baseline" : "game-snapshot"),
          stale: gameSnapshot.stale === true || ["baseline", "stale", "attention"].includes(snapshotStatus),
          fingerprint: gameSnapshot.fingerprint || "",
          verifiedAt: gameSnapshot.verifiedAt || "",
          sourceOfTruth: adoptedApiSource,
          rosterUse: adoptedApiSource,
          verified: gameSnapshot.verified === true,
          officialPlayerCount: gameSnapshot.officialPlayerCount ?? null,
          snapshotPlayerCount: gameSnapshot.snapshotPlayerCount ?? null,
          canUseForPrediction: true,
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
      const displayRosterSource = String(deps.state.publicRoster?.displayRosterSource || "");
      const hasLatestOfficialRoster = ["latest_official_snapshot", "latest_official_live"].includes(displayRosterSource);
      const hasFallbackRoster = ["baseline", "stale", "fallback"].includes(rosterStatus)
        && publicRosterReady
        && (!hasLatestOfficialRoster || rosterStatus === "baseline");
      const hasRosterAttention = rosterStatus === "attention";
      const isRegisteredFielderCandidate = (player) => typeof deps.isRegisteredFielderCandidate === "function"
        ? deps.isRegisteredFielderCandidate(player)
        : deps.isPlayerInCurrentRoster(player)
          && player?.isBatterCandidate === true
          && player?.predictionCandidateRole !== "special_dh";
      document.querySelectorAll("[data-roster-filter]").forEach((button) => {
        const isSelected = button.dataset.rosterFilter === filter;
        button.classList.toggle("is-selected", isSelected);
        button.setAttribute("aria-pressed", isSelected ? "true" : "false");
        button.setAttribute("aria-selected", isSelected ? "true" : "false");
      });

      document.querySelectorAll('.player-chip[data-picker="prediction"]').forEach((chip) => {
        const player = deps.getPlayerData(chip.dataset.player);
        const shouldShow = publicRosterReady && (filter === "active"
          ? isRegisteredFielderCandidate(player)
          : !isRegisteredFielderCandidate(player) && player?.isBatterCandidate === true);
        chip.classList.toggle("hidden", !shouldShow);
      });

      const status = document.getElementById("predictionRosterStatus");
      if (status) {
        const message = hasFallbackRoster || hasRosterAttention
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
