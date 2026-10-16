(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};
  const PREVIOUS_RESULT_SESSION_CACHE_TTL_MS = 30 * 1000;
  const RESULT_HISTORY_SESSION_CACHE_TTL_MS = 30 * 1000;

  function createPublicResultsController(deps) {
    // The narrow live state view forwards to the existing app-owned fields.
    // Auth can replace resultHistory, so retain accessors rather than capturing
    // a stale history object. No prediction or Best Nine state is supplied.
    const {
      state,
      apiClient,
      requestGuard,
      storage,
      resultStorageKey,
      getAuthApiBaseUrl,
      getFastPreviousResultGame,
      getPredictionAccountUser,
      syncPublicAppState,
      getPublicResultAvailability,
      getResultHistoryGameId,
      remotePredictionToLocal,
      scoreLineup,
      normalizePlayerKey,
      getHitCounts,
      createScoreBreakdown,
      normalizePosition,
      getPositionCategory,
      createPlayerNameHtml,
      formatPlayerNameForDisplay,
      createPredictionSummary,
      formatPublicJstDateTime,
      escapeHtml,
      LINEUP_SIZE,
      SCORE_MAX,
      afterRenderHistory
    } = deps;
    let previousResultGameRequestPromise = null;
    let fastPreviousResultRequestPromise = null;
    let eventsBound = false;

    function buildPreviousResultGameApiUrl() {
      const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
      return baseUrl ? `${baseUrl}/api/public/previous-result-game` : "";
    }

    function maybeLoadFastPreviousResult() {
      const user = getPredictionAccountUser();
      const candidate = getFastPreviousResultGame();
      const history = state.resultHistory;
      if (!user || !candidate || history.selectedGameId || history.result || history.isDetailLoading || fastPreviousResultRequestPromise) {
        return null;
      }
      const requestPromise = loadResultHistoryGame(candidate.internalGameId, { manual: false, fastPrevious: true });
      const trackedPromise = requestPromise.finally(() => {
        if (fastPreviousResultRequestPromise === trackedPromise) fastPreviousResultRequestPromise = null;
      });
      fastPreviousResultRequestPromise = trackedPromise;
      return trackedPromise;
    }

    function fetchPreviousResultGame({ force = false } = {}) {
      const previous = state.previousResultGame;
      if (!force && (previous.isLoading || previous.isReady)) {
        return previousResultGameRequestPromise || Promise.resolve();
      }
      const requestPromise = (async () => {
        const request = requestGuard.begin("previousResultGame", { abort: true });
        const url = buildPreviousResultGameApiUrl();
        if (!url) {
          previous.isReady = true;
          previous.game = null;
          previous.message = "前回の結果を確認できませんでした。";
          renderScoreResult();
          return;
        }
        previous.isLoading = true;
        previous.isReady = false;
        previous.message = "";
        syncPublicAppState();
        renderScoreResult();
        try {
          const requestOptions = {
            cacheKey: "previous-result-game",
            ttlMs: PREVIOUS_RESULT_SESSION_CACHE_TTL_MS,
            signal: request.signal
          };
          if (force) requestOptions.cache = "no-store";
          const { response, payload } = await apiClient.getCached(url, requestOptions);
          if (!response.ok || !payload?.ok || (payload.game !== null && typeof payload.game !== "object")) {
            throw new Error(payload?.error || `HTTP ${response.status}`);
          }
          if (!requestGuard.isCurrent("previousResultGame", request.id)) return;
          previous.game = payload.game || null;
          previous.isReady = true;
        } catch (error) {
          if (!requestGuard.isCurrent("previousResultGame", request.id)) return;
          previous.game = null;
          previous.isReady = true;
          previous.message = "前回の結果を確認できませんでした。";
          console.warn("前回の公開結果試合の取得に失敗しました", error.message);
        } finally {
          if (requestGuard.isCurrent("previousResultGame", request.id)) {
            previous.isLoading = false;
            syncPublicAppState();
            renderScoreResult();
            resolveResultHistorySelection();
          }
        }
      })();
      previousResultGameRequestPromise = requestPromise;
      return requestPromise.finally(() => {
        if (previousResultGameRequestPromise === requestPromise) previousResultGameRequestPromise = null;
      });
    }

    function buildResultGamesApiUrl(gameId = "") {
      const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
      if (!baseUrl) return "";
      return gameId
        ? `${baseUrl}/api/results/games/${encodeURIComponent(gameId)}`
        : `${baseUrl}/api/results/games`;
    }

    function resolveResultHistorySelection() {
      const history = state.resultHistory;
      const previousGame = state.previousResultGame.isReady ? state.previousResultGame.game : null;
      if (!history.isReady || !state.previousResultGame.isReady || history.selectedGameId || history.isDetailLoading) return;

      const latestParticipatedResultGame = previousGame
        ? history.games.find((game) => (game?.resultsPublished || getPublicResultAvailability(game))
          && getResultHistoryGameId(game) === String(previousGame.internalGameId || ""))
        : null;
      if (latestParticipatedResultGame) {
        void loadResultHistoryGame(getResultHistoryGameId(latestParticipatedResultGame), { manual: false });
        return;
      }

      history.result = null;
      clearStoredPublicResult();
      syncPublicAppState();
      renderScoreResult();
    }

    function formatResultHistoryTeamName(value) {
      const labels = {
        fighters: "日本ハム",
        hawks: "ソフトバンク",
        buffaloes: "オリックス",
        marines: "ロッテ",
        eagles: "楽天",
        lions: "西武",
        giants: "巨人",
        tigers: "阪神",
        baystars: "DeNA",
        carp: "広島",
        dragons: "中日",
        swallows: "ヤクルト"
      };
      const normalized = String(value || "").trim().toLowerCase();
      return labels[normalized] || String(value || "").trim() || "対戦相手";
    }

    function formatResultHistoryMatchup(game) {
      const home = formatResultHistoryTeamName(game?.homeTeam);
      const away = formatResultHistoryTeamName(game?.awayTeam);
      return home && away ? `${home} vs ${away}` : "対戦情報を確認中";
    }

    async function refreshResultHistory({ force = false } = {}) {
      const user = getPredictionAccountUser();
      if (!user) {
        requestGuard.begin("result", { abort: true });
        requestGuard.begin("resultDetail", { abort: true });
        clearStoredPublicResult();
        state.resultHistory = { isLoading: false, isDetailLoading: false, isReady: true, games: [], detailCache: Object.create(null), selectedGameId: "", displayMode: "previous", isExpanded: false, result: null, message: "ログインすると過去の試合結果を確認できます。", detailError: "" };
        syncPublicAppState();
        renderScoreResult();
        renderResultHistory();
        return;
      }
      if (state.resultHistory.isLoading || (!force && state.resultHistory.games.length > 0)) return;
      const request = requestGuard.begin("result", { abort: true });
      if (!fastPreviousResultRequestPromise) requestGuard.begin("resultDetail", { abort: true });
      const url = buildResultGamesApiUrl();
      if (!url) return;
      state.resultHistory.isLoading = true;
      state.resultHistory.isReady = false;
      state.resultHistory.detailError = "";
      state.resultHistory.message = "過去の試合結果を確認中...";
      renderResultHistory();
      void maybeLoadFastPreviousResult();
      try {
        const userId = String(user.id || user.userId || "").trim();
        const requestOptions = {
          cacheKey: userId ? `result-history:${userId}` : "",
          ttlMs: RESULT_HISTORY_SESSION_CACHE_TTL_MS,
          credentials: "include",
          signal: request.signal
        };
        if (force) requestOptions.cache = "no-store";
        const { response, payload } = await apiClient.getCached(url, requestOptions);
        if (!response.ok || !payload?.ok || !Array.isArray(payload.games)) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        if (!requestGuard.isCurrent("result", request.id)) return;
        state.resultHistory.games = limitHistory(payload.games);
        state.resultHistory.isReady = true;
        state.resultHistory.message = state.resultHistory.games.length ? "" : "採点済みの過去試合はありません。";
        // 前回試合の確認が先に終わっていれば、その場で詳細取得を開始します。
        // 未完了なら前回取得側の完了処理から同じ一覧を使って選択します。
        resolveResultHistorySelection();
      } catch (error) {
        if (!requestGuard.isCurrent("result", request.id)) return;
        state.resultHistory.games = [];
        state.resultHistory.isReady = true;
        state.resultHistory.result = null;
        clearStoredPublicResult();
        state.resultHistory.message = "過去の試合結果を取得できませんでした。";
        console.error("過去の試合結果の取得に失敗しました", error.message);
      } finally {
        if (requestGuard.isCurrent("result", request.id)) {
          state.resultHistory.isLoading = false;
          syncPublicAppState();
          renderScoreResult();
          renderResultHistory();
        }
      }
    }

    async function handleResultHistoryClick(event) {
      const toggle = event.target instanceof Element ? event.target.closest("[data-result-history-toggle]") : null;
      if (toggle) {
        state.resultHistory.isExpanded = !state.resultHistory.isExpanded;
        if (state.resultHistory.isExpanded && getPredictionAccountUser() && !state.resultHistory.isReady && !state.resultHistory.isLoading) {
          void refreshResultHistory({ force: false });
        }
        renderResultHistory();
        return;
      }
    }

    async function handleResultHistoryChange(event) {
      const select = event.target instanceof HTMLSelectElement
        ? event.target.closest("[data-result-history-select]")
        : null;
      if (!select?.value) return;
      await loadResultHistoryGame(select.value);
    }

    async function loadResultHistoryGame(gameId, { manual = true, fastPrevious = false } = {}) {
      const history = state.resultHistory;
      const cached = history.detailCache[gameId];
      if (cached && fastPrevious) return cached;
      // Cache hits also supersede an in-flight selection. Otherwise a slower
      // response for B can overwrite a user's cached selection of A.
      const request = requestGuard.begin("resultDetail", { abort: true });
      history.selectedGameId = gameId;
      history.displayMode = manual ? "selected" : "previous";
      history.result = cached || null;
      history.isDetailLoading = !cached;
      history.detailError = "";
      history.message = cached ? "" : "試合結果を読み込み中...";
      if (!cached) {
        renderScoreResult();
        renderResultHistory();
      }
      try {
        let nextResult = cached;
        if (!nextResult) {
          const { response, payload } = await apiClient.get(buildResultGamesApiUrl(gameId), { credentials: "include", signal: request.signal });
          if (!requestGuard.isCurrent("resultDetail", request.id)) return;
          if (!response.ok || !payload?.ok) {
            if (fastPrevious && response.status === 404) {
              history.selectedGameId = "";
              history.message = "";
              return;
            }
            throw new Error(payload?.error || `HTTP ${response.status}`);
          }
          const availability = getPublicResultAvailability(payload);
          if (availability) {
            nextResult = {
              gameId: payload.gameId || gameId,
              internalGameId: payload.internalGameId || "",
              status: payload.status || (availability.key === "service_unavailable" ? "service_unavailable" : "excluded"),
              gameStatus: payload.gameStatus || payload.game?.gameStatus || "",
              resultAvailability: availability.key,
              rankingExcluded: true,
              rankingEligibilityStatus: payload.rankingEligibilityStatus || "excluded",
              serviceUnavailable: availability.key === "service_unavailable",
              serviceUnavailableMessage: availability.message,
              prediction: payload.prediction || null,
              savedAt: payload.updatedAt || payload.submittedAt || ""
            };
          } else {
            if (!payload.resultsPublished) {
              state.result = null;
              history.message = "この試合の結果はまだ公開されていません。";
              return;
            }
            if (!payload.prediction || !Array.isArray(payload.actualLineup)) throw new Error("結果データが不足しています。");
            const prediction = remotePredictionToLocal({ lineup: payload.prediction.lineup }, payload.updatedAt || payload.submittedAt, gameId);
            const actual = remotePredictionToLocal({ lineup: payload.actualLineup }, payload.scoredAt || "", gameId);
            nextResult = {
              ...scoreLineup(prediction.lineup, actual.lineup),
              gameId: payload.internalGameId || payload.gameId || gameId,
              internalGameId: payload.internalGameId || "",
              publishedAt: payload.publishedAt || "",
              totalScore: payload.totalScore ?? payload.score ?? null
            };
          }
          history.detailCache[gameId] = nextResult;
        }
        // One commit path for cached, unavailable, normal and fast-previous details.
        // state.result remains the persisted compatibility projection; history owns selection.
        history.result = nextResult;
        state.result = nextResult;
        history.message = "";
        if (fastPrevious && !getPublicResultAvailability(nextResult)) history.isReady = true;
        return nextResult;
      } catch (error) {
        if (!requestGuard.isCurrent("resultDetail", request.id)) return;
        state.result = null;
        history.result = null;
        history.detailError = "結果を読み込めませんでした。時間をおいて再度お試しください。";
        history.message = "この試合の結果を取得できませんでした。";
        console.error("過去の試合結果の読み込みに失敗しました", error.message);
      } finally {
        if (requestGuard.isCurrent("resultDetail", request.id)) {
          history.isDetailLoading = false;
          syncPublicAppState();
          renderScoreResult();
          renderResultHistory();
        }
      }
    }

    function renderResultHistory() {
      const container = document.getElementById("resultHistoryList");
      if (!container) return;
      const history = state.resultHistory;
      const options = history.games.map((game) => {
        const gameId = getResultHistoryGameId(game);
        const matchup = formatResultHistoryMatchup(game);
        const availability = getPublicResultAvailability(game);
        const statusLabel = availability ? `［${availability.shortLabel}］` : "";
        return `<option value="${escapeHtml(gameId)}"${gameId === history.selectedGameId ? " selected" : ""}>${escapeHtml(game.gameDate || game.date || "日付不明")} ${escapeHtml(matchup)}${game.startTime ? `（${escapeHtml(game.startTime)}）` : ""}${statusLabel}</option>`;
      }).join("");
      const selectedGame = history.games.find((game) => getResultHistoryGameId(game) === history.selectedGameId);
      const selectedLabel = selectedGame
        ? `${selectedGame.gameDate || selectedGame.date || "日付不明"} ${formatResultHistoryMatchup(selectedGame)}${getPublicResultAvailability(selectedGame) ? `［${getPublicResultAvailability(selectedGame).shortLabel}］` : ""}`
        : "";
      const details = history.isLoading
        ? (history.isExpanded ? `<p class="result-history-message" role="status">${escapeHtml(history.message || "過去の試合成績を読み込んでいます...")}</p>` : "")
        : !history.games.length
          ? (history.isExpanded || history.message ? `<p class="result-history-message" role="status">${escapeHtml(history.message || "表示できる保存済み予想はありません。")}</p>` : "")
          : `${history.isExpanded && selectedLabel ? `<p class="result-selected-game">選択中：${escapeHtml(selectedLabel)}</p>` : ""}${history.message ? `<p class="result-history-message" role="status">${escapeHtml(history.message)}</p>` : ""}`;
      container.innerHTML = `<div class="result-history-controls">
      <button type="button" class="secondary-button result-history-toggle" data-result-history-toggle aria-expanded="${history.isExpanded ? "true" : "false"}">${history.isExpanded ? "閉じる" : "過去の成績を見る"}</button>
      ${history.isExpanded && history.games.length ? `<label class="result-history-select-label" for="resultHistorySelect">試合を選択<select id="resultHistorySelect" data-result-history-select><option value="">試合を選択</option>${options}</select></label>` : ""}
    </div>
    ${details}`;
      afterRenderHistory();
    }

    function clearStoredPublicResult() {
      state.result = null;
      if (typeof window !== "undefined" && window.localStorage) {
        storage.remove(resultStorageKey);
      }
    }

    function renderScoreInsights(comparison) {
      const grid = document.getElementById("scoreInsightsGrid");
      const notice = document.getElementById("scoreInsightsNotice");
      if (!grid || !notice) return;

      const values = {
        average: comparison?.average ?? comparison?.averageScore,
        rank: comparison?.rank,
        top: comparison?.top ?? comparison?.topPercent ?? comparison?.percentile
      };
      const hasData = Object.values(values).some((value) => value !== null && value !== undefined && String(value).trim() !== "");
      grid.classList.toggle("hidden", !hasData);
      notice.classList.toggle("hidden", hasData);

      grid.querySelectorAll("[data-score-insight]").forEach((card) => {
        const value = values[card.dataset.scoreInsight];
        const valueElement = card.querySelector("[data-score-insight-value]");
        const hasValue = value !== null && value !== undefined && String(value).trim() !== "";
        card.classList.toggle("hidden", !hasValue);
        if (valueElement) valueElement.textContent = hasValue ? String(value) : "";
      });
    }

    function createActualBasisDetails(sourceDetails, actualLineup = []) {
      const hasProvidedActualLineup = Array.isArray(actualLineup) && actualLineup.length > 0;
      const actualItems = hasProvidedActualLineup
        ? actualLineup
        : sourceDetails.map((detail) => ({
          order: detail.order,
          player: detail.actualPlayer || "",
          playerId: detail.actualPlayerId || "",
          position: detail.actualPosition || ""
        }));

      return Array.from({ length: LINEUP_SIZE }, (_, index) => {
        const actualOrder = index + 1;
        const actualItem = actualItems.find((item) => Number(item?.order || item?.battingOrder) === actualOrder)
          || (!hasProvidedActualLineup ? actualItems[index] || {} : {});
        const actualPlayer = String(actualItem.player || actualItem.name || actualItem.playerName || "").trim();
        const actualPlayerId = String(actualItem.playerId || "").trim();
        const predictionDetail = sourceDetails.find((detail) => {
          const predictedPlayerId = String(detail.playerId || "").trim();
          if (actualPlayerId && predictedPlayerId && predictedPlayerId === actualPlayerId) return true;
          const predictedPlayer = String(detail.player || "").trim();
          return Boolean(actualPlayer && predictedPlayer && normalizePlayerKey(predictedPlayer) === normalizePlayerKey(actualPlayer));
        }) || null;
        const isPlayerHit = Boolean(predictionDetail?.isPlayerHit);
        const isOrderHit = Boolean(predictionDetail?.isOrderHit);
        const isPositionHit = Boolean(predictionDetail?.isPositionHit);
        const isPerfect = Boolean(predictionDetail?.isPerfect ?? (isPlayerHit && isOrderHit && isPositionHit));

        return {
          ...(predictionDetail || {}),
          order: actualOrder,
          predictionOrder: predictionDetail ? Number(predictionDetail.order) || null : null,
          player: predictionDetail?.player || "",
          playerId: predictionDetail?.playerId || "",
          position: predictionDetail?.position || "",
          actualPlayer,
          actualPlayerId,
          actualPosition: actualItem.position || "",
          actualOrder,
          isPlayerHit,
          isOrderHit,
          isPositionHit,
          isPerfect,
          point: predictionDetail ? Number(predictionDetail.point || 0) : 0,
          mark: isPerfect ? "◎" : isPlayerHit ? "◯" : "×",
          label: isPerfect ? "完全一致" : isPlayerHit ? "スタメン入り" : "外れ"
        };
      });
    }

    function mergeRawPredictionSlots(sourceDetails, actualBasisDetails) {
      return actualBasisDetails.map((detail, index) => {
        const predictionDetail = sourceDetails.find((sourceDetail) => Number(sourceDetail.order) === index + 1) || {};
        return {
          ...detail,
          player: predictionDetail.player || "",
          playerId: predictionDetail.playerId || "",
          position: predictionDetail.position || "",
          predictionOrder: predictionDetail.player ? Number(predictionDetail.order) || null : null
        };
      });
    }

    function createResultViewModel(result) {
      const sourceDetails = Array.isArray(result.details) ? result.details : [];

      const normalizedDetails = sourceDetails.map((detail) => {
        const isPlayerHit = Boolean(detail.isPlayerHit ?? detail.mark !== "×");
        const isOrderHit = Boolean(detail.isOrderHit ?? detail.mark === "◎");
        const isPositionHit = Boolean(detail.isPositionHit ?? detail.mark === "◎");
        return {
          ...detail,
          actualPlayer: detail.actualPlayer || "",
          actualPosition: detail.actualPosition || "",
          isPlayerHit,
          isOrderHit,
          isPositionHit
        };
      });
      const actualBasisDetails = createActualBasisDetails(normalizedDetails, result.actualLineup);
      const details = mergeRawPredictionSlots(normalizedDetails, actualBasisDetails);
      const counts = getHitCounts(details);
      const breakdown = createScoreBreakdown(counts);
      const total = breakdown.player.total + breakdown.order.total + breakdown.position.total + breakdown.perfect.total;

      return {
        total,
        max: SCORE_MAX,
        perfectLabel: total === SCORE_MAX ? "完全一致" : "",
        counts,
        breakdown,
        details,
        displayBasis: "actual-lineup"
      };
    }

    function createResultView(viewModel) {
      const wrapper = document.createElement("div");
      wrapper.className = "result-dashboard";
      const canvas = createResultCanvas(viewModel);
      if (!canvas) {
        wrapper.appendChild(createResultFallbackView(viewModel));
        return wrapper;
      }
      canvas.className = "result-canvas";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "採点結果。合計点、得点内訳、あなたの予想と実際のスタメン、判定、点数を表示しています。");
      const accessibleTable = createResultTable(viewModel.details);
      accessibleTable.classList.add("result-canvas-text-fallback");
      wrapper.append(canvas, accessibleTable);
      return wrapper;
    }

    function createResultFallbackView(viewModel) {
      const fallback = document.createElement("div");
      const hero = document.createElement("div");
      hero.className = "result-hero";
      hero.innerHTML = `
    <p class="result-label">合計点</p>
    <div class="score-total"><strong>${viewModel.total}</strong><span>/ ${viewModel.max} 点</span></div>
    ${viewModel.perfectLabel ? `<p class="score-comment">${escapeHtml(viewModel.perfectLabel)}</p>` : ""}
  `;
      const breakdown = document.createElement("div");
      breakdown.className = "hit-breakdown";
      breakdown.innerHTML = `
    ${createBreakdownItem("出場得点", viewModel.breakdown.player.total, viewModel.breakdown.player.max, `出場的中：${viewModel.counts.player} / ${LINEUP_SIZE}`)}
    ${createBreakdownItem("打順得点", viewModel.breakdown.order.total, viewModel.breakdown.order.max, `打順的中：${viewModel.counts.order} / ${LINEUP_SIZE}`)}
    ${createBreakdownItem("守備位置得点", viewModel.breakdown.position.total, viewModel.breakdown.position.max, `守備位置的中：${viewModel.counts.position} / ${LINEUP_SIZE}`)}
    ${createBreakdownItem("完全一致ボーナス", viewModel.breakdown.perfect.total, viewModel.breakdown.perfect.max, `完全一致：${viewModel.counts.perfect} / ${LINEUP_SIZE}`)}
  `;
      const tableWrap = document.createElement("div");
      tableWrap.className = "result-table-wrap";
      tableWrap.appendChild(createResultTable(viewModel.details));
      fallback.append(hero, breakdown, tableWrap);
      return fallback;
    }

    function createResultCanvas(viewModel) {
      if (!viewModel || !Array.isArray(viewModel.details)) return null;
      const viewportWidth = typeof window === "undefined" ? 620 : window.innerWidth || 620;
      const displayWidth = Math.min(590, Math.max(320, viewportWidth - 32));
      const renderScale = Math.max(2, Math.min(3, window.devicePixelRatio || 1));
      const padding = 12;
      const heroHeight = 78;
      const breakdownHeight = 70;
      const headerHeight = 38;
      const rowHeight = 50;
      const rowGap = 0;
      const sectionGap = 10;
      const tableHeight = headerHeight + viewModel.details.length * rowHeight + Math.max(0, viewModel.details.length - 1) * rowGap;
      const canvasHeight = padding + heroHeight + sectionGap + breakdownHeight + sectionGap + tableHeight + padding;
      const canvas = document.createElement("canvas");
      canvas.width = displayWidth * renderScale;
      canvas.height = canvasHeight * renderScale;
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.scale(renderScale, renderScale);

      const colors = {
        background: "#eef5fb",
        hero: "#164a79",
        header: "#1168a8",
        text: "#172033",
        muted: "#55687b",
        border: "#b9cfe2",
        grid: "#d3dfeb",
        row: "#ffffff",
        order: "#1168a8",
        hit: "#f0c766",
        hitText: "#4a3500",
        miss: "#f1f4f7",
        missText: "#55687b",
        perfect: "#f0c766",
        perfectBorder: "#d4aa52",
        position: {
          "category-catcher": "#eaf5fc",
          "category-infielder": "#fff8df",
          "category-outfielder": "#eaf6ed",
          "category-dh": "#f9eaf2",
          empty: "#edf1f5"
        }
      };
      const drawRoundedRect = (x, y, width, height, radius, fill, stroke) => {
        const safeRadius = Math.min(radius, width / 2, height / 2);
        context.beginPath();
        context.moveTo(x + safeRadius, y);
        context.arcTo(x + width, y, x + width, y + height, safeRadius);
        context.arcTo(x + width, y + height, x, y + height, safeRadius);
        context.arcTo(x, y + height, x, y, safeRadius);
        context.arcTo(x, y, x + width, y, safeRadius);
        context.closePath();
        if (fill) {
          context.fillStyle = fill;
          context.fill();
        }
        if (stroke) {
          context.strokeStyle = stroke;
          context.stroke();
        }
      };
      const drawText = (value, x, y, width, font, color, align = "center") => {
        context.font = font;
        context.fillStyle = color;
        context.textAlign = align;
        context.textBaseline = "middle";
        context.fillText(String(value ?? ""), align === "center" ? x + width / 2 : x, y);
      };
      const drawName = (value, x, y, width, height) => {
        let fontSize = displayWidth < 480 ? 12 : 15;
        const text = String(value || "-");
        while (fontSize > 10) {
          context.font = `700 ${fontSize}px "Yu Gothic", "Noto Sans JP", sans-serif`;
          if (context.measureText(text).width <= width - 10) break;
          fontSize -= 1;
        }
        drawText(text, x, y + height / 2, width, `700 ${fontSize}px "Yu Gothic", "Noto Sans JP", sans-serif`, colors.text);
      };
      const drawPlayerCard = (player, position, x, y, width, height, cardFill = colors.row, cardBorder = colors.border) => {
        const normalizedPosition = normalizePosition(position);
        const category = normalizedPosition ? getPositionCategory(normalizedPosition) : "empty";
        context.lineWidth = 1.5;
        drawRoundedRect(x, y, width, height, 0, cardFill, cardBorder);
        if (player === "未予想") {
          drawText(player, x, y + height / 2, width, `700 ${displayWidth < 480 ? 11 : 13}px "Yu Gothic", "Noto Sans JP", sans-serif`, colors.muted);
          return;
        }
        const tileWidth = Math.min(30, Math.max(24, width * 0.22));
        context.fillStyle = colors.position[category] || colors.position.empty;
        context.fillRect(x + 1, y + 1, tileWidth - 1, height - 2);
        context.strokeStyle = colors.border;
        context.beginPath();
        context.moveTo(x + tileWidth, y + 1);
        context.lineTo(x + tileWidth, y + height - 1);
        context.stroke();
        drawText(normalizedPosition || "－", x + 1, y + height / 2, tileWidth - 1, "900 13px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", colors.text);
        const displayName = formatPlayerNameForDisplay(player || "-");
        drawName(displayName, x + tileWidth + 2, y, width - tileWidth - 2, height);
      };
      const drawJudgement = (isHit, label, x, y, width, height) => {
        const badgeInset = 3;
        const badgeHeight = Math.min(30, height - badgeInset * 2);
        const badgeX = x + badgeInset;
        const badgeY = y + (height - badgeHeight) / 2;
        const badgeWidth = width - badgeInset * 2;
        drawRoundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 7, isHit ? colors.hit : colors.miss, colors.border);
        const textColor = isHit ? colors.hitText : colors.missText;
        drawText(isHit ? "○" : "×", badgeX + 2, badgeY + badgeHeight / 2, Math.max(10, badgeWidth * 0.34), `950 ${displayWidth < 480 ? 10 : 14}px Arial, sans-serif`, textColor);
        drawText(label, badgeX + badgeWidth * 0.34, badgeY + badgeHeight / 2, badgeWidth * 0.62, `900 ${displayWidth < 480 ? 8 : 9}px Arial, sans-serif`, textColor);
      };

      context.fillStyle = colors.background;
      context.fillRect(0, 0, displayWidth, canvasHeight);

      const contentWidth = displayWidth - padding * 2;
      let y = padding;
      drawRoundedRect(padding, y, contentWidth, heroHeight, 6, colors.hero, null);
      drawText("Starting9 結果発表", padding + 14, y + 11, 150, "800 9px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", "#b8dcf5", "left");
      const totalFont = `950 ${displayWidth < 480 ? 36 : 42}px Arial, sans-serif`;
      const maxFont = `900 ${displayWidth < 480 ? 15 : 18}px Arial, sans-serif`;
      const maxLabel = `/ ${viewModel.max} 点`;
      context.font = totalFont;
      const totalTextWidth = context.measureText(String(viewModel.total ?? "")).width;
      context.font = maxFont;
      const maxTextWidth = context.measureText(maxLabel).width;
      const scoreGap = displayWidth < 480 ? 8 : 12;
      const scoreStartX = padding + (contentWidth - totalTextWidth - scoreGap - maxTextWidth) / 2;
      const scoreGroupWidth = totalTextWidth + scoreGap + maxTextWidth;
      drawText("合計点", scoreStartX, y + 29, scoreGroupWidth, "900 10px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", "#d7ecff");
      drawText(viewModel.total, scoreStartX, y + 54, totalTextWidth, totalFont, "#ffffff", "left");
      drawText(maxLabel, scoreStartX + totalTextWidth + scoreGap, y + 57, maxTextWidth, maxFont, "#eaf4ff", "left");
      if (viewModel.perfectLabel) {
        drawRoundedRect(displayWidth - 96, y + 13, 74, 26, 0, "#ffffff", null);
        drawText(viewModel.perfectLabel, displayWidth - 96, y + 26, 74, "900 10px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", colors.hero);
      }
      y += heroHeight + sectionGap;

      drawRoundedRect(padding, y, contentWidth, breakdownHeight, 0, "#f8fbff", colors.border);
      const perfectBreakdown = viewModel.breakdown.perfect || { total: 0, max: LINEUP_SIZE };
      const perfectCount = Number.isFinite(Number(viewModel.counts.perfect)) ? Number(viewModel.counts.perfect) : 0;
      const breakdowns = [
        ["出場得点", viewModel.breakdown.player, viewModel.counts.player, "出場的中"],
        ["打順得点", viewModel.breakdown.order, viewModel.counts.order, "打順的中"],
        ["守備位置得点", viewModel.breakdown.position, viewModel.counts.position, "守備位置的中"],
        ["完全一致ボーナス", perfectBreakdown, perfectCount, "完全一致"]
      ];
      const breakdownWidth = contentWidth / breakdowns.length;
      breakdowns.forEach(([label, score, count, countLabel], index) => {
        const x = padding + index * breakdownWidth;
        if (index > 0) {
          context.strokeStyle = colors.border;
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(x, y + breakdownHeight);
          context.stroke();
        }
        drawText(label, x + 8, y + 15, breakdownWidth - 16, "800 9px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", colors.muted, "left");
        drawText(`${score.total} / ${score.max}`, x + 8, y + 37, breakdownWidth - 16, "900 15px Arial, sans-serif", colors.text, "left");
        drawText(`${countLabel}：${count} / ${LINEUP_SIZE}`, x + 8, y + 57, breakdownWidth - 16, "800 8px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", colors.muted, "left");
      });
      y += breakdownHeight + sectionGap;

      const tableX = padding;
      const orderWidth = displayWidth < 480 ? 38 : 46;
      const pointWidth = displayWidth < 480 ? 34 : 44;
      const judgementWidth = displayWidth < 480 ? 94 : 126;
      const playerWidth = (contentWidth - orderWidth - pointWidth - judgementWidth) / 2;
      const columns = [orderWidth, playerWidth, playerWidth, judgementWidth, pointWidth];
      const headings = ["打順", "あなたの予想", "実際のスタメン", "判定", "点数"];
      drawRoundedRect(tableX, y, contentWidth, headerHeight, 0, colors.header, null);
      let columnX = tableX;
      columns.forEach((width, index) => {
        if (index > 0) {
          context.strokeStyle = "rgba(255, 255, 255, 0.22)";
          context.beginPath();
          context.moveTo(columnX, y);
          context.lineTo(columnX, y + headerHeight);
          context.stroke();
        }
        drawText(headings[index], columnX, y + headerHeight / 2, width, `900 ${displayWidth < 480 ? 9 : 11}px \"Yu Gothic\", \"Noto Sans JP\", sans-serif`, "#ffffff");
        columnX += width;
      });
      const actualJudgementBoundary = tableX + orderWidth + playerWidth * 2;
      context.strokeStyle = colors.grid;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(actualJudgementBoundary, y);
      context.lineTo(actualJudgementBoundary, y + headerHeight);
      context.stroke();
      y += headerHeight;

      viewModel.details.forEach((detail, index) => {
        const rowY = y + index * (rowHeight + rowGap);
        const predictedColumnX = tableX + orderWidth;
        const actualColumnX = predictedColumnX + playerWidth;
        const predictedX = predictedColumnX;
        const actualX = actualColumnX;
        const pointValue = Number(detail.point);
        const isPerfectRow = Boolean(detail.isPerfect ?? (pointValue >= 11));
        const isZeroRow = pointValue === 0;
        const rowFill = isPerfectRow ? "#fffaf0" : colors.row;
        const rowBorder = isPerfectRow ? "#e6c978" : colors.grid;
        context.lineWidth = 1;
        drawRoundedRect(tableX, rowY, contentWidth, rowHeight, 0, rowFill, rowBorder);
        context.fillStyle = isPerfectRow ? "#fff8e8" : colors.row;
        context.fillRect(actualColumnX, rowY, playerWidth, rowHeight);
        drawRoundedRect(tableX, rowY, orderWidth, rowHeight, 0, colors.order, null);
        drawText(detail.order, tableX, rowY + rowHeight / 2, orderWidth, `900 ${displayWidth < 480 ? 14 : 16}px Arial, sans-serif`, "#ffffff");
        const judgementX = tableX + orderWidth + playerWidth * 2;
        for (const boundary of [predictedColumnX, actualColumnX, judgementX, judgementX + judgementWidth]) {
          context.strokeStyle = colors.grid;
          context.beginPath();
          context.moveTo(boundary, rowY);
          context.lineTo(boundary, rowY + rowHeight);
          context.stroke();
        }
        const actualCardFill = isPerfectRow ? "#fff6dc" : colors.row;
        const actualCardBorder = isPerfectRow ? colors.perfectBorder : colors.border;
        drawPlayerCard(detail.player || "未予想", detail.position, predictedX, rowY, playerWidth, rowHeight, colors.row, colors.border);
        drawPlayerCard(detail.actualPlayer || "-", detail.actualPosition, actualX, rowY, playerWidth, rowHeight, actualCardFill, actualCardBorder);
        const chipGap = 0;
        const chipWidth = judgementWidth / 3;
        drawJudgement(detail.isPlayerHit, "出場", judgementX, rowY, chipWidth, rowHeight);
        drawJudgement(detail.isOrderHit, "打順", judgementX + chipWidth + chipGap, rowY, chipWidth, rowHeight);
        drawJudgement(detail.isPositionHit, "守備", judgementX + (chipWidth + chipGap) * 2, rowY, chipWidth, rowHeight);
        const pointX = judgementX + judgementWidth;
        context.strokeStyle = "#c2d7e9";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(pointX, rowY);
        context.lineTo(pointX, rowY + rowHeight);
        context.stroke();
        const pointFill = isPerfectRow ? "#fff1c7" : "#ffffff";
        const pointBorder = isPerfectRow ? colors.perfectBorder : "#c2ceda";
        const pointBadgeInset = displayWidth < 480 ? 4 : 6;
        const pointBadgeHeight = 32;
        const pointBadgeY = rowY + (rowHeight - pointBadgeHeight) / 2;
        drawRoundedRect(pointX + pointBadgeInset, pointBadgeY, pointWidth - pointBadgeInset * 2, pointBadgeHeight, 8, pointFill, pointBorder);
        drawText(detail.point, pointX + pointBadgeInset, pointBadgeY + pointBadgeHeight / 2, pointWidth - pointBadgeInset * 2, `950 ${displayWidth < 480 ? 13 : 15}px Arial, sans-serif`, isPerfectRow ? colors.perfectBorder : colors.text);
        context.strokeStyle = colors.grid;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(judgementX, rowY);
        context.lineTo(judgementX, rowY + rowHeight);
        context.stroke();
      });

      const bodyTop = y;
      for (let boundaryIndex = 0; boundaryIndex <= viewModel.details.length; boundaryIndex += 1) {
        const boundaryY = bodyTop + boundaryIndex * rowHeight;
        context.strokeStyle = colors.grid;
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(tableX, boundaryY);
        context.lineTo(tableX + contentWidth, boundaryY);
        context.stroke();
      }

      return canvas;
    }

    function createBreakdownItem(label, score, max, countText) {
      return `
    <div class="breakdown-item">
      <span>${label}</span>
      <strong>${score} / ${max}</strong>
      <small>${countText}</small>
    </div>
  `;
    }

    function createResultTable(details) {
      const table = document.createElement("table");
      table.className = "result-table";
      table.innerHTML = `
    <thead>
      <tr>
        <th class="result-order-heading">打順</th>
        <th class="result-group-heading">あなたの予想</th>
        <th class="result-group-heading result-actual-group-heading">実際のスタメン</th>
        <th class="result-group-heading result-judgement-heading">判定</th>
        <th class="result-point-heading">点数</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

      const tbody = table.querySelector("tbody");
      details.forEach((detail) => {
        const row = document.createElement("tr");
        row.innerHTML = `
      <td class="result-order-cell"><strong>${detail.order}</strong></td>
      <td class="result-player-cell">${createResultPlayerCardHtml(detail.player || "未予想", detail.position)}</td>
      <td class="result-player-cell result-actual-group-cell">${createResultPlayerCardHtml(detail.actualPlayer || "-", detail.actualPosition)}</td>
      <td class="result-judgements-cell">
        <span class="result-judgement-stack">
          ${createHitBadge(detail.isPlayerHit, "出場")}
          ${createHitBadge(detail.isOrderHit, "打順")}
          ${createHitBadge(detail.isPositionHit, "守備")}
        </span>
      </td>
      <td class="result-point-cell"><strong>${detail.point}</strong></td>
    `;
        tbody.appendChild(row);
      });

      return table;
    }

    function createResultPlayerCardHtml(player, position) {
      if (player === "未予想") {
        return `
      <span class="result-player-card result-player-card-empty">
        ${createPlayerNameHtml("未予想", "result-player-name")}
      </span>
    `;
      }
      return `
    <span class="result-player-card">
      ${createResultPositionTileHtml(position)}
      ${createPlayerNameHtml(player || "-", "result-player-name")}
    </span>
  `;
    }

    function createHitBadge(isHit, label) {
      const status = isHit ? "的中" : "不一致";
      return `
    <span class="hit-badge ${isHit ? "is-hit" : "is-miss"}" aria-label="${escapeHtml(label)}：${status}">
      <span class="hit-mark" aria-hidden="true">${isHit ? "○" : "×"}</span>
      <span>${escapeHtml(label)}</span>
    </span>
  `;
    }

    function createResultPositionTileHtml(position) {
      const normalizedPosition = normalizePosition(position);
      const category = normalizedPosition ? getPositionCategory(normalizedPosition) : "empty";
      return `
    <span class="result-position-tile is-${category}" aria-label="守備位置 ${escapeHtml(normalizedPosition || "未選択")}">
      ${escapeHtml(normalizedPosition || "－")}
    </span>
  `;
    }

    function preserveDisplayedResult() {
      const latest = deps.state.resultHistory.result || deps.state.result || null;
      deps.state.result = latest;
      if (latest) {
        deps.storage.save(deps.resultStorageKey, latest);
      } else {
        deps.storage.remove(deps.resultStorageKey);
      }
    }

    function limitHistory(games) {
      return Array.isArray(games) ? games.slice(0, 5) : [];
    }

    function getDisplayedResult() {
      const history = deps.state.resultHistory;
      if (!history.isReady) return null;
      if (history.result) return history.result;

      const storedResult = deps.state.result;
      const resultId = deps.getResultHistoryGameId(storedResult);
      const participated = resultId && history.games.some((game) => deps.getResultHistoryGameId(game) === resultId);
      return participated ? storedResult : null;
    }

    function getPreviousPublicGame() {
      return deps.state.previousResultGame?.game || null;
    }

    function formatPreviousResultDate(game) {
      const rawDate = String(game?.gameDate || game?.date || "");
      const match = rawDate.match(/(?:^|\/)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|T|\s)/);
      if (match) return `${Number(match[2])}/${Number(match[3])}`;
      const shortMatch = rawDate.match(/^(\d{1,2})[-/](\d{1,2})$/);
      return shortMatch ? `${Number(shortMatch[1])}/${Number(shortMatch[2])}` : "";
    }

    function updateResultHeader(game, hasResult, displayMode = "previous") {
      const heading = document.getElementById("result-title");
      const legend = document.getElementById("result-legend");
      const date = formatPreviousResultDate(game);
      const availability = deps.getPublicResultAvailability?.(game) || null;
      if (heading) {
        if (availability) {
          heading.textContent = displayMode === "selected"
            ? (date ? `選択した試合（${date}）の結果` : "選択した試合の結果")
            : (date ? `前回（${date}）の試合結果` : "前回の試合結果");
        } else {
          heading.textContent = displayMode === "selected"
            ? (date ? `${date}の採点結果` : "選択した試合の採点結果")
            : (date ? `前回（${date}）の採点結果` : "前回の採点結果");
        }
      }
      if (legend) {
        legend.classList.toggle("hidden", !hasResult);
        if (availability) legend.classList.add("hidden");
      }
    }

    function renderScoreResult() {
      const container = document.getElementById("scoreResult");
      if (!container) return;
      const history = deps.state.resultHistory;
      const displayedResult = getDisplayedResult();
      const previousGame = getPreviousPublicGame();
      const selectedGame = displayedResult
        ? history.games.find((game) => deps.getResultHistoryGameId(game) === displayedResult.gameId)
        : null;
      const availability = deps.getPublicResultAvailability?.(displayedResult || selectedGame || previousGame) || null;
      updateResultHeader(selectedGame || previousGame, Boolean(displayedResult) && !availability, history.displayMode);
      // Keep score comparison data available internally, but do not render it in the public result UI for now.

      if (!displayedResult) {
        if (deps.state.previousResultGame?.isLoading || !deps.state.previousResultGame?.isReady) {
          container.className = "empty-state";
          container.textContent = "前回の結果を確認中です。";
          return;
        }
        if (deps.state.previousResultGame?.message) {
          container.className = "empty-state";
          container.textContent = deps.state.previousResultGame.message;
          return;
        }
        const previousAvailability = deps.getPublicResultAvailability?.(previousGame) || null;
        if (previousAvailability) {
          container.className = "empty-state result-unavailable-card";
          container.innerHTML = `<strong class="result-unavailable-title">${deps.escapeHtml(previousAvailability.title)}</strong><p>${deps.escapeHtml(previousAvailability.message)}</p>`;
          return;
        }
        if (!deps.getPredictionAccountUser()) {
          container.className = "empty-state";
          container.textContent = "ログインすると前回の採点結果を確認できます。";
          return;
        }
        if (!history.isReady) {
          container.className = "empty-state";
          container.textContent = "結果を確認中です。";
          return;
        }
        container.className = "empty-state";
        if (history.isLoading || history.isDetailLoading) {
          container.textContent = "結果を読み込み中です。";
          return;
        }
        if (history.detailError) {
          container.textContent = history.detailError;
          return;
        }
        if (previousGame) {
          container.className = "result-history-no-participation";
          container.textContent = "前回は参加していません。過去に参加した試合は「過去の試合成績を見る」から確認できます。";
          return;
        }
        container.textContent = "結果公開後に表示されます。";
        return;
      }

      if (availability) {
        container.className = "empty-state result-unavailable-card";
        container.innerHTML = `<strong class="result-unavailable-title">${deps.escapeHtml(availability.title)}</strong><p>${deps.escapeHtml(availability.message)}</p>`;
        if (displayedResult.prediction?.lineup) {
          container.appendChild(deps.createPredictionSummary({
            lineup: displayedResult.prediction.lineup,
            savedAt: displayedResult.savedAt || ""
          }));
        }
        return;
      }

      container.className = "summary-box";
      container.innerHTML = "";
      const resultHeading = document.createElement("p");
      resultHeading.className = "result-selected-game";
      resultHeading.textContent = selectedGame
        ? `表示中：${selectedGame.displayLabel || `${selectedGame.gameDate || selectedGame.date || ""} ${formatResultHistoryMatchup(selectedGame)}`}`
        : "表示中の試合結果";
      container.appendChild(resultHeading);
      if (displayedResult.publishedAt) {
        const publishedAt = document.createElement("p");
        publishedAt.className = "result-selected-game";
        publishedAt.textContent = `公開：${deps.formatPublicJstDateTime(displayedResult.publishedAt)}`;
        container.appendChild(publishedAt);
      }
      container.appendChild(createResultView(createResultViewModel(displayedResult)));
    }

    function bindEvents() {
      if (eventsBound) return;
      eventsBound = true;
      document.getElementById("resultHistoryList")?.addEventListener("click", handleResultHistoryClick);
      document.getElementById("resultHistoryList")?.addEventListener("change", handleResultHistoryChange);
    }

    return {
      fetchPrevious: fetchPreviousResultGame,
      refresh: refreshResultHistory,
      maybeLoadFastPrevious: maybeLoadFastPreviousResult,
      render: renderScoreResult,
      renderHistory: renderResultHistory,
      preserveDisplayedResult,
      bindEvents
    };
  }

  publicFrontend.createPublicResultsController = createPublicResultsController;
})();
