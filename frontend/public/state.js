(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createRequestState() {
    return { sequence: 0, controller: null };
  }

  function createPublicAppState(state) {
    return {
      gameCatalog: state.publicGameCatalog,
      currentGame: null,
      predictionForm: { gameId: "", isHydrated: false },
      roster: state.publicRoster,
      results: { latest: null, history: state.resultHistory },
      ranking: { yearly: state.yearlyRanking, monthly: state.monthlyRanking },
      dailyBestNine: state.dailyBestNine,
      account: { status: "idle", gameId: "" },
      requests: {
        initialization: { started: false, promise: null },
        auth: { sequence: 0, promise: null },
        catalog: createRequestState(),
        roster: createRequestState(),
        target: createRequestState(),
        probable: createRequestState(),
        result: createRequestState(),
        resultDetail: createRequestState(),
        account: createRequestState()
      }
    };
  }

  function syncPublicAppState(appState, state) {
    appState.gameCatalog = state.publicGameCatalog;
    appState.currentGame = state.predictionTargetGame || null;
    appState.predictionForm.gameId = state.predictionTargetGameId || "";
    appState.predictionForm.isHydrated = Boolean(state.predictionTargetGameId);
    appState.roster = state.publicRoster;
    appState.results.latest = state.resultHistory.result || state.result || null;
    appState.results.history = state.resultHistory;
    appState.ranking.yearly = state.yearlyRanking;
    appState.ranking.monthly = state.monthlyRanking;
    appState.dailyBestNine = state.dailyBestNine;
    appState.account.status = state.predictionRemote.status;
    appState.account.gameId = state.predictionRemote.gameId || "";
  }

  publicFrontend.state = { createPublicAppState, syncPublicAppState };
})();
