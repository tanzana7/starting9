(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};
  const NPBASE_MATCHUPS_URL = "https://npbase.jp/?view=labo&tool=matchups&day=today&sort=average&order=desc";
  const PROBABLE_STARTER_REFRESH_INTERVAL_MS = 60 * 1000;

  function createPublicProbableStarterController(deps) {
    // Keep the existing app-owned object as the only state. The controller owns
    // starter selection, accepted reads and rendering, but not prediction selection.
    // Bootstrap and the existing deadline ticker own scheduling; creating this
    // controller must not install listeners, timers or start network requests.
    const probableStarterState = deps.probableStarter;

    function getProbableStarterActualStartAt(game) {
      const candidates = [
        game?.actualStartAt,
        game?.actual_start_at,
        game?.startedAt,
        game?.started_at,
        game?.gameStartedAt,
        game?.game_started_at,
        game?.firstPitchAt,
        game?.first_pitch_at
      ];
      for (const value of candidates) {
        if (!value) continue;
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
      return null;
    }

    function getProbableStarterCutoffAt(game) {
      return getProbableStarterActualStartAt(game)
        || (game?.startAt ? new Date(game.startAt) : deps.parseJstScheduleDateTime(game));
    }

    function selectProbableStarterGame(games = [], now = new Date()) {
      const current = now instanceof Date ? now : new Date(now);
      if (Number.isNaN(current.getTime())) return null;
      return (Array.isArray(games) ? games : [])
        .filter((game) => game?.canonical === true
          && Boolean(game?.internalGameId)
          && deps.isNormalManagedSchedule(game)
          && !deps.isScheduleGameUnavailable(game))
        .map((game) => ({ game, cutoffAt: getProbableStarterCutoffAt(game) }))
        .filter(({ cutoffAt }) => cutoffAt && !Number.isNaN(cutoffAt.getTime()) && cutoffAt.getTime() > current.getTime())
        .sort((left, right) => left.cutoffAt.getTime() - right.cutoffAt.getTime()
          || deps.getScheduleSortValue(left.game).localeCompare(deps.getScheduleSortValue(right.game)))
        [0]?.game || null;
    }

    function getPreferredProbableStarterGame(now = new Date()) {
      return selectProbableStarterGame(deps.getGames(), now);
    }

    function resetProbableStarterDisplay(nextGame, message = "") {
      probableStarterState.nextGame = nextGame || null;
      probableStarterState.matchedGame = null;
      probableStarterState.games = [];
      probableStarterState.fetchedGameId = "";
      probableStarterState.status = nextGame ? "idle" : "noGame";
      probableStarterState.message = message || (nextGame ? "次の試合の予告先発を確認しています。" : "次の試合は未定");
      probableStarterState.nextCheckAt = "";
      probableStarterState.errorCode = "";
      probableStarterState.referenceDiagnostics = null;
      probableStarterState.lastRefreshAt = 0;
    }

    async function initializeProbableStarter() {
      const nextGame = getPreferredProbableStarterGame();
      const currentGameId = String(probableStarterState.nextGame?.internalGameId || "");
      const nextGameId = String(nextGame?.internalGameId || "");
      if (currentGameId !== nextGameId || (probableStarterState.status === "idle" && !nextGame)) {
        deps.requestGuard.begin("probable", { abort: true });
        resetProbableStarterDisplay(nextGame);
      }
      renderProbableStarterDisplay();

      if (probableStarterState.nextGame) {
        await fetchStoredProbableStarter();
      } else {
        renderProbableStarterDisplay();
      }
    }

    function refreshProbableStarterTarget(now = new Date()) {
      const nextGame = getPreferredProbableStarterGame(now);
      const currentId = String(probableStarterState.nextGame?.internalGameId || "");
      const nextId = String(nextGame?.internalGameId || "");
      if (currentId === nextId) {
        const refreshable = ["unannounced", "error", "game_reference_mismatch"].includes(probableStarterState.status);
        const elapsed = Date.now() - Number(probableStarterState.lastRefreshAt || 0);
        if (nextGame && refreshable && elapsed >= PROBABLE_STARTER_REFRESH_INTERVAL_MS) {
          probableStarterState.lastRefreshAt = Date.now();
          void fetchStoredProbableStarter();
        }
        return false;
      }

      deps.requestGuard.begin("probable", { abort: true });
      resetProbableStarterDisplay(nextGame);
      renderProbableStarterDisplay();
      if (nextGame) {
        probableStarterState.lastRefreshAt = Date.now();
        void fetchStoredProbableStarter();
      }
      return true;
    }

    function buildProbableStarterApiUrl(gameId) {
      const baseUrl = deps.getAuthApiBaseUrl().replace(/\/+$/, "");
      const game = gameId && typeof gameId === "object" ? gameId : { gameId };
      const internalGameId = String(game?.internalGameId || "").trim();
      if (!baseUrl || !internalGameId) return "";
      // Retired request shape (never sent): /api/probable-starter?gameId=
      return `${baseUrl}/api/probable-starter?internalGameId=${encodeURIComponent(internalGameId)}`;
    }

    function applyStoredProbableStarter(probableStarter, gameMetadata = {}) {
      const nextGame = probableStarterState.nextGame;
      const canonicalGame = {
        ...nextGame,
        internalGameId: gameMetadata.internalGameId || probableStarter?.internalGameId || nextGame?.internalGameId || "",
        gameId: gameMetadata.legacyGameId || gameMetadata.gameId || nextGame?.gameId || "",
        date: gameMetadata.gameDate || nextGame?.date || "",
        startAt: gameMetadata.startAt || nextGame?.startAt || "",
        homeTeam: gameMetadata.homeTeam || nextGame?.homeTeam || "",
        awayTeam: gameMetadata.awayTeam || nextGame?.awayTeam || ""
      };
      probableStarterState.nextGame = canonicalGame;
      const status = String(probableStarter?.status || "empty");
      probableStarterState.fetchedGameId = canonicalGame.gameId || "";
      probableStarterState.fetchedAt = probableStarter?.fetchedAt || "";
      probableStarterState.sourceUrl = probableStarter?.sourceUrl || deps.starterSourceUrl;
      probableStarterState.fetchedGameCount = probableStarter ? 1 : 0;
      probableStarterState.nextCheckAt = probableStarter?.nextCheckAt || "";
      probableStarterState.errorCode = probableStarter?.errorCode || "";
      probableStarterState.dataStatus = probableStarter?.dataStatus || (probableStarter?.partial ? "partial" : status);
      probableStarterState.referenceDiagnostics = null;
      const hasAnyPitcher = Boolean(String(probableStarter?.homePitcherName || "").trim() || String(probableStarter?.awayPitcherName || "").trim());
      if (status === "external_fetch_disabled" || probableStarter?.errorCode === "EXTERNAL_FETCH_DISABLED") {
        probableStarterState.status = "external_fetch_disabled";
        probableStarterState.message = "公式情報の取得を一時停止しています。";
        probableStarterState.matchedGame = null;
        probableStarterState.games = [];
        return;
      }
      if (!probableStarter || status === "empty" || status === "unannounced" || (status === "announced" && !hasAnyPitcher)) {
        probableStarterState.status = "unannounced";
        probableStarterState.message = "予告先発はまだ発表されていません";
        probableStarterState.matchedGame = null;
        probableStarterState.games = [];
        return;
      }
      if (status === "error") {
        probableStarterState.status = "error";
        probableStarterState.message = "予告先発を取得できませんでした";
        probableStarterState.matchedGame = null;
        probableStarterState.games = [];
        return;
      }
      probableStarterState.status = "success";
      probableStarterState.message = probableStarter.partial ? "予告先発を一部取得しました" : "予告先発を取得しました";
      probableStarterState.matchedGame = {
        ...canonicalGame,
        homeStarter: { name: probableStarter.homePitcherName || "" },
        awayStarter: { name: probableStarter.awayPitcherName || "" }
      };
      probableStarterState.games = [probableStarterState.matchedGame];
    }

    function getProbableStarterReferenceDiagnostics(selectedGame, response, httpStatus = 200) {
      const selectedInternalGameId = String(selectedGame?.internalGameId || "").trim();
      const resolvedInternalGameId = String(response?.internalGameId || "").trim();
      const selectedDate = String(selectedGame?.date || "").trim();
      const resolvedDate = String(response?.gameDate || "").trim();
      const selectedHome = deps.normalizeScheduleTeamCode(selectedGame?.homeTeam);
      const selectedAway = deps.normalizeScheduleTeamCode(selectedGame?.awayTeam);
      const resolvedHome = deps.normalizeScheduleTeamCode(response?.homeTeam);
      const resolvedAway = deps.normalizeScheduleTeamCode(response?.awayTeam);
      const selectedStartAt = selectedGame?.startAt ? new Date(selectedGame.startAt) : deps.parseJstScheduleDateTime(selectedGame);
      const resolvedStartAt = response?.startAt ? new Date(response.startAt) : null;
      const startAtMatches = selectedStartAt && !Number.isNaN(selectedStartAt.getTime()) && resolvedStartAt && !Number.isNaN(resolvedStartAt.getTime())
        ? selectedStartAt.getTime() === resolvedStartAt.getTime()
        : true;
      const mismatches = [];
      if (selectedInternalGameId && resolvedInternalGameId !== selectedInternalGameId) mismatches.push("INTERNAL_GAME_ID_MISMATCH");
      if (!resolvedInternalGameId) mismatches.push("INTERNAL_GAME_ID_MISSING");
      if (selectedDate && resolvedDate !== selectedDate) mismatches.push("GAME_DATE_MISMATCH");
      if (!selectedHome || resolvedHome !== selectedHome) mismatches.push("HOME_TEAM_MISMATCH");
      if (!selectedAway || resolvedAway !== selectedAway) mismatches.push("AWAY_TEAM_MISMATCH");
      if (!startAtMatches) mismatches.push("START_AT_MISMATCH");
      return mismatches.length ? {
        code: "GAME_REFERENCE_MISMATCH",
        requestedInternalGameId: selectedInternalGameId,
        resolvedInternalGameId,
        selectedGameDate: selectedDate,
        selectedHome,
        selectedAway,
        apiStatus: Number(httpStatus || 0),
        mismatches
      } : null;
    }

    async function fetchStoredProbableStarter() {
      const activeRequest = deps.requestState;
      if (probableStarterState.isLoading && !activeRequest?.controller?.signal?.aborted) {
        return;
      }

      if (!probableStarterState.nextGame) {
        probableStarterState.status = "noGame";
        probableStarterState.message = "次の試合を検出できませんでした。";
        renderProbableStarterDisplay();
        return;
      }

      const game = probableStarterState.nextGame;
      const request = deps.requestGuard.begin("probable", { abort: true });
      const url = buildProbableStarterApiUrl(game);
      if (!url) {
        if (!deps.requestGuard.isCurrent("probable", request.id)) return;
        probableStarterState.status = "error";
        probableStarterState.message = "予告先発を取得できませんでした";
        renderProbableStarterDisplay();
        return;
      }
      probableStarterState.isLoading = true;
      probableStarterState.status = "loading";
      probableStarterState.message = "保存済みの予告先発を確認中...";
      renderProbableStarterDisplay();

      try {
        const { response, payload: result } = await deps.apiClient.get(url, { credentials: "include", signal: request.signal });
        if (!deps.requestGuard.isCurrent("probable", request.id)
          || String(probableStarterState.nextGame?.internalGameId || "") !== String(game.internalGameId || "")) return;
        if (!response.ok || !result?.ok) {
          if (result?.code === "EXTERNAL_FETCH_DISABLED" || result?.externalFetchDisabled === true) {
            probableStarterState.status = "external_fetch_disabled";
            probableStarterState.message = "公式情報の取得を一時停止しています。";
            return;
          }
          probableStarterState.status = "error";
          probableStarterState.message = "予告先発を取得できませんでした";
          return;
        }
        const referenceDiagnostics = getProbableStarterReferenceDiagnostics(game, result, response.status);
        if (referenceDiagnostics) {
          probableStarterState.status = "game_reference_mismatch";
          probableStarterState.message = "予告先発の試合参照が一致しませんでした";
          probableStarterState.errorCode = referenceDiagnostics.code;
          probableStarterState.referenceDiagnostics = referenceDiagnostics;
          console.warn("予告先発の試合参照が一致しませんでした", referenceDiagnostics);
          return;
        }
        applyStoredProbableStarter(result.probableStarter, result);
      } catch (error) {
        if (!deps.requestGuard.isCurrent("probable", request.id)) return;
        probableStarterState.status = "error";
        probableStarterState.message = "予告先発を取得できませんでした";
      } finally {
        if (deps.requestGuard.isCurrent("probable", request.id)) {
          probableStarterState.isLoading = false;
          renderProbableStarterDisplay();
        }
      }
    }

    function getFightersStarter(game) {
      if (!game) {
        return null;
      }

      if (game.homeTeam === "fighters") {
        return { fighters: game.homeStarter, opponent: game.awayStarter, opponentName: game.awayTeamName };
      }

      if (game.awayTeam === "fighters") {
        return { fighters: game.awayStarter, opponent: game.homeStarter, opponentName: game.homeTeamName };
      }

      return null;
    }

    function formatScheduledGameForLog(game) {
      if (!game) {
        return "対象なし";
      }

      return `${game.date || "日付不明"} ${game.matchupLabel || `${game.homeTeam || ""} vs ${game.awayTeam || ""}`}`;
    }

    function deriveProbableStarterViewState(probableStarter = {}) {
      const nextGame = probableStarter.nextGame || null;
      const status = String(probableStarter.status || "idle");

      // Game existence is the outer boundary. A missing game must never fall
      // through to the game's missing-starter copy, even if stale starter data
      // remains in memory during a schedule transition.
      if (!nextGame || status === "noGame") return { kind: "noGame", nextGame: null, matchedGame: null };
      if (status === "idle") return { kind: "idle", nextGame, matchedGame: null };
      if (status === "loading") return { kind: "loading", nextGame, matchedGame: null };
      if (status === "error" || status === "external_fetch_disabled" || status === "game_reference_mismatch") {
        return { kind: status, nextGame, matchedGame: null };
      }
      if (status === "success" && probableStarter.matchedGame) {
        return { kind: "announced", nextGame, matchedGame: probableStarter.matchedGame };
      }
      return { kind: "unannounced", nextGame, matchedGame: null };
    }

    function renderProbableStarterDisplay() {
      const container = document.getElementById("probableStarterDisplay");
      if (!container) {
        return;
      }

      const probableStarter = probableStarterState;
      const viewState = deriveProbableStarterViewState(probableStarter);
      if (viewState.kind === "noGame") {
        container.classList.add("hidden");
        container.innerHTML = "";
        return;
      }
      if (viewState.kind === "idle") {
        container.classList.add("hidden");
        container.innerHTML = "";
        return;
      }

      container.classList.remove("hidden");

      if (viewState.kind === "loading") {
        container.className = "probable-starter-card is-loading";
        container.innerHTML = `
      ${createProbableStarterHeadingHtml()}
      <p class="probable-starter-message">予告先発を取得中...</p>
    `;
        return;
      }

      if (viewState.kind === "error") {
        renderProbableStarterNotice(container, viewState.kind, viewState.nextGame);
        return;
      }

      if (viewState.kind === "external_fetch_disabled") {
        renderProbableStarterNotice(container, viewState.kind, viewState.nextGame);
        return;
      }

      if (viewState.kind === "game_reference_mismatch") {
        renderProbableStarterNotice(container, viewState.kind, viewState.nextGame);
        return;
      }

      if (viewState.kind === "unannounced") {
        renderProbableStarterNotice(container, "unannounced", viewState.nextGame);
        return;
      }

      const matchedGame = viewState.matchedGame;
      const fightersStarter = getFightersStarter(matchedGame);
      if (!matchedGame || !fightersStarter) {
        renderProbableStarterNotice(container, "unannounced", viewState.nextGame);
        return;
      }

      const dateText = formatProbableStarterDate(matchedGame.date || probableStarter.nextGame.date);
      const gameInfo = `${dateText} ${matchedGame.startTime || probableStarter.nextGame.startTime || ""}`.trim();
      container.className = "probable-starter-card is-success";
      container.innerHTML = `
    ${createProbableStarterHeadingHtml()}
    <div class="probable-starter-grid">
      ${createProbableStarterTeamHtml("日本ハム", fightersStarter.fighters?.name)}
      ${createProbableStarterTeamHtml(fightersStarter.opponentName || "相手チーム", fightersStarter.opponent?.name)}
    </div>
    <p class="probable-starter-meta">${deps.escapeHtml(gameInfo)}${matchedGame.venue ? ` ・ ${deps.escapeHtml(matchedGame.venue)}` : ""}</p>
    <p class="probable-starter-fetched">予告先発情報：${deps.escapeHtml(deps.formatDateTime(probableStarter.fetchedAt))} 更新</p>
  `;
    }

    function renderProbableStarterNotice(container, status, nextGame) {
      const isError = status === "error";
      const isExternalFetchDisabled = status === "external_fetch_disabled";
      const isReferenceMismatch = status === "game_reference_mismatch";
      const isNoGame = status === "noGame";
      container.className = `probable-starter-card ${isError || isExternalFetchDisabled ? "is-error" : "is-pending"}`;
      if (isReferenceMismatch) container.classList.add("is-error");
      container.innerHTML = `
    ${createProbableStarterHeadingHtml()}
    <p class="probable-starter-message">${isNoGame ? "次の試合は未定" : isReferenceMismatch ? "予告先発の試合参照を確認できませんでした。" : isExternalFetchDisabled ? "公式情報の取得を一時停止しています。" : isError ? "予告先発を取得できませんでした。" : "予告先発 未発表"}</p>
    ${isNoGame ? "" : `<p class="probable-starter-meta">${isReferenceMismatch ? "試合情報を更新して再確認します。" : isExternalFetchDisabled ? "取得を再開した後に確認できます。" : isError ? "次回の自動更新で再試行します。" : "発表され次第、自動で表示されます。"}</p>`}
    ${isNoGame || isError || isReferenceMismatch ? "" : `<p class="probable-starter-meta">${deps.escapeHtml(formatScheduledGameForLog(nextGame))}</p>`}
    ${!isNoGame && !isError && !isReferenceMismatch && probableStarterState.nextCheckAt ? `<p class="probable-starter-meta">次回自動確認：${deps.escapeHtml(deps.formatDateTime(probableStarterState.nextCheckAt))}</p>` : ""}
  `;
    }

    function createProbableStarterHeadingHtml() {
      return `
    <div class="probable-starter-heading">
      <p class="probable-starter-label">予告先発</p>
      <a href="${NPBASE_MATCHUPS_URL}" target="_blank" rel="noopener noreferrer">対予告先発成績を見る</a>
    </div>
    <p class="official-source-note">試合情報の確認元: <a href="https://npb.jp/" target="_blank" rel="noopener noreferrer">NPB公式サイト</a></p>
  `;
    }

    function createProbableStarterTeamHtml(teamName, starterName) {
      return `
    <div class="probable-starter-team">
      <span>${deps.escapeHtml(teamName)}</span>
      <strong>${deps.escapeHtml(deps.formatPlayerNameForDisplay(starterName || "未発表"))}</strong>
    </div>
  `;
    }

    function formatProbableStarterDate(dateValue) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ""));
      return match ? `${Number(match[2])}月${Number(match[3])}日` : "";
    }

    return {
      initialize: initializeProbableStarter,
      refreshTarget: refreshProbableStarterTarget,
      render: renderProbableStarterDisplay
    };
  }

  publicFrontend.createPublicProbableStarterController = createPublicProbableStarterController;
})();
