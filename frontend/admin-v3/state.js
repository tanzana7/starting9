(function registerAdminV3State(global) {
  "use strict";

  function createAdminV3State() {
    return {
      payload: null,
      view: "dashboard",
      filter: "all",
      selectedGameId: "",
      lastUpdatedAt: null,
      operationDetails: new Map(),
      jobDetails: new Map(),
      jobDetailsOpen: new Set(),
      jobDetailsLoading: new Set(),
      jobDetailsCopyStatus: new Map(),
      manualOperations: new Map(),
      automationLogs: null,
      automationLogFilters: { runId: "", internalGameId: "", jobType: "", status: "", reasonCode: "", failureCode: "" },
      rankingReset: {
        periodType: "yearly",
        periodKey: String(new Date().getFullYear()),
        resetAtLocal: "",
        reason: "",
        confirmation: "",
        preview: null,
        activeMarker: null,
        markers: [],
        games: [],
        gameFilter: "all",
        gameSearch: "",
        gamesLoading: false,
        gamesLoaded: false,
        gamesError: "",
        loading: false,
        loaded: false
      },
      perfectScorePreview: {
        internalGameId: "",
        reason: "",
        loading: false,
        result: null,
        error: ""
      },
      manualGamePreview: {
        loading: false,
        result: null,
        error: ""
      }
    };
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3State = createAdminV3State;
})(window);
