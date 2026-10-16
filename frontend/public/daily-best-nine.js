(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createDailyBestNineController(deps) {
    let initializationPromise = null;

    function reset(status = "idle") {
      const dailyState = deps.state.dailyBestNine;
      dailyState.isLoading = false;
      dailyState.gameId = "";
      dailyState.status = status;
      dailyState.rows = [];
      dailyState.message = "";
    }

    async function refresh({ force = false } = {}) {
      const dailyState = deps.state.dailyBestNine;
      // This widget always follows the latest publication, independently of
      // the personal result currently selected in the history panel.
      const requestKey = "latest-published";
      if (dailyState.isLoading && !force && dailyState.gameId === requestKey) return;

      const baseUrl = deps.getAuthApiBaseUrl().replace(/\/+$/, "");
      if (!baseUrl) {
        reset("error");
        deps.state.dailyBestNine.message = "今日のベストナインを取得できませんでした。";
        deps.render();
        return;
      }

      const requestId = dailyState.requestId + 1;
      dailyState.requestId = requestId;
      dailyState.gameId = requestKey;
      dailyState.isLoading = true;
      dailyState.status = "loading";
      dailyState.rows = [];
      dailyState.message = "";
      deps.render();

      try {
        const { response, payload } = await deps.apiClient.get(`${baseUrl}/api/results/daily-best-nine`, {
          cache: force ? "no-store" : "default"
        });
        if (!response.ok || !payload?.ok || !Array.isArray(payload.bestNine)) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        if (requestId !== deps.state.dailyBestNine.requestId) return;
        deps.state.dailyBestNine.status = payload.published ? "published" : "unpublished";
        deps.state.dailyBestNine.rows = payload.bestNine;
        deps.state.dailyBestNine.gameId = String(payload.internalGameId || payload.gameId || requestKey);
      } catch (error) {
        if (requestId !== deps.state.dailyBestNine.requestId) return;
        console.error("今日のベストナインの取得に失敗しました", error.message);
        deps.state.dailyBestNine.status = "error";
        deps.state.dailyBestNine.rows = [];
        deps.state.dailyBestNine.message = "今日のベストナインを取得できませんでした。";
      } finally {
        if (requestId === deps.state.dailyBestNine.requestId) {
          deps.state.dailyBestNine.isLoading = false;
          deps.render();
        }
      }
    }

    function initialize() {
      if (!initializationPromise) initializationPromise = refresh({ force: true });
      return initializationPromise;
    }

    return { initialize, refresh, render: deps.render };
  }

  publicFrontend.createDailyBestNineController = createDailyBestNineController;
})();
