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

    function renderScoreResult() {
      const container = document.getElementById("scoreResult");
      const shareButton = document.getElementById("shareResultButton");
      const displayedResult = deps.state.resultHistory.result || deps.state.result;
      deps.renderScoreInsights(displayedResult?.comparison || null);

      if (!displayedResult) {
        container.className = "empty-state";
        if (deps.state.resultHistory.isLoading || deps.state.resultHistory.isDetailLoading) {
          container.textContent = "結果を読み込み中です。";
          shareButton.classList.add("hidden");
          return;
        }
        if (deps.state.resultHistory.detailError) {
          container.textContent = deps.state.resultHistory.detailError;
          shareButton.classList.add("hidden");
          return;
        }
        const resultStatus = deps.state.gameDayNotice.record?.resultStatus;
        container.textContent = resultStatus === "prestart"
          ? "結果は試合開始後に公開されます。"
          : resultStatus === "preparing"
            ? "結果を準備中です。"
            : "採点すると結果が表示されます。";
        shareButton.classList.add("hidden");
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
      const selectedGame = deps.state.resultHistory.games.find((game) => deps.getResultHistoryGameId(game) === displayedResult.gameId);
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
      shareButton.classList.remove("hidden");
    }

    return { preserveDisplayedResult, limitHistory, renderScoreResult };
  }

  publicFrontend.createPublicResultsRenderer = createPublicResultsRenderer;
})();
