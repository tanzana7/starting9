(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicResultsRenderer(deps) {
    function preserveDisplayedResult() {
      const latest = deps.state.resultHistory.result || deps.state.result || null;
      deps.state.result = latest;
      if (latest) {
        deps.storage.save(deps.storageKeys.result, latest);
      } else {
        deps.storage.remove(deps.storageKeys.result);
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
      const match = rawDate.match(/(?:^|\/)(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (match) return `${Number(match[2])}/${Number(match[3])}`;
      const shortMatch = rawDate.match(/^(\d{1,2})[-/](\d{1,2})$/);
      return shortMatch ? `${Number(shortMatch[1])}/${Number(shortMatch[2])}` : "";
    }

    function updateResultHeader(game, hasResult) {
      const heading = document.getElementById("result-title");
      const legend = document.getElementById("result-legend");
      const date = formatPreviousResultDate(game);
      if (heading) heading.textContent = date ? `前回（${date}）の採点結果` : "前回の採点結果";
      if (legend) legend.classList.toggle("hidden", !hasResult);
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
      updateResultHeader(selectedGame || previousGame, Boolean(displayedResult));
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

      if (displayedResult.serviceUnavailable) {
        container.className = "empty-state service-unavailable-result";
        container.innerHTML = `<p>${deps.escapeHtml(displayedResult.serviceUnavailableMessage || "この試合はサービス未稼働のため集計対象外です。")}</p>`;
        if (displayedResult.prediction?.lineup) {
          container.appendChild(deps.createPredictionSummary({
            lineup: displayedResult.prediction.lineup,
            savedAt: displayedResult.savedAt || ""
          }));
        }
        shareButton.classList.add("hidden");
        return;
      }

      container.className = "summary-box";
      container.innerHTML = "";
      const resultHeading = document.createElement("p");
      resultHeading.className = "result-selected-game";
      resultHeading.textContent = selectedGame
        ? `表示中：${selectedGame.displayLabel || `${selectedGame.gameDate || selectedGame.date || ""} ${deps.formatResultHistoryMatchup(selectedGame)}`}`
        : "表示中の試合結果";
      container.appendChild(resultHeading);
      if (displayedResult.publishedAt) {
        const publishedAt = document.createElement("p");
        publishedAt.className = "result-selected-game";
        publishedAt.textContent = `公開：${deps.formatPublicJstDateTime(displayedResult.publishedAt)}`;
        container.appendChild(publishedAt);
      }
      container.appendChild(deps.createResultView(deps.createResultViewModel(displayedResult)));
    }

    function renderDailyBestNine() {
      const card = document.getElementById("dailyBestNineCard");
      const container = document.getElementById("dailyBestNineContent");
      const count = document.getElementById("dailyBestNineCount");
      if (!card || !container || !count) return;

      const bestNine = deps.state.dailyBestNine;
      const isPublished = bestNine.status === "published";
      card.classList.toggle("hidden", !isPublished);
      count.textContent = bestNine.totalCount > 0 ? `${bestNine.totalCount}人中` : "";
      if (!isPublished) {
        container.innerHTML = "";
        return;
      }
      if (bestNine.isLoading) {
        container.innerHTML = '<p class="daily-best-nine-message">今日のベストナインを確認中です。</p>';
        return;
      }
      if (bestNine.message) {
        container.innerHTML = `<p class="daily-best-nine-message is-error">${deps.escapeHtml(bestNine.message)}</p>`;
        return;
      }
      if (!bestNine.rows.length) {
        container.innerHTML = '<p class="daily-best-nine-message">この試合は表示できる予想がありません。</p>';
        return;
      }

      container.innerHTML = `<ol class="daily-best-nine-list">${bestNine.rows.map((row) => `
        <li>
          <span class="daily-best-nine-rank">${deps.escapeHtml(row.rank)}位</span>
          <strong>${deps.escapeHtml(row.username)}</strong>
          <span class="daily-best-nine-score">${deps.escapeHtml(row.score)}点</span>
          ${row.isPerfect ? '<span class="daily-best-nine-badge">満点</span>' : ""}
        </li>
      `).join("")}</ol>`;
    }

    return { preserveDisplayedResult, limitHistory, renderScoreResult, renderDailyBestNine };
  }

  publicFrontend.createPublicResultsRenderer = createPublicResultsRenderer;
})();
