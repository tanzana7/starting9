(function registerAdminV3State(global) {
  "use strict";

  function createAdminV3State() {
    return {
      payload: null,
      view: "dashboard",
      filter: "all",
      selectedGameId: "",
      selectionSource: "default",
      selectionValidated: false,
      selectionSafetyNotice: "",
      lastUpdatedAt: null,
      operationDetails: new Map(),
      operationDetailsRequestToken: 0,
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
      },
      manualLineup: {
        gameId: "",
        rows: Array.from({ length: 9 }, (_, index) => ({
          battingOrder: index + 1,
          position: "",
          playerId: "",
          playerName: "",
          uniformNumber: "",
          search: ""
        })),
        reason: "",
        confirmed: false,
        confirmation: {
          internalGameId: "",
          revisionId: "",
          lineupFingerprint: "",
          previewed: false,
          checked: false
        },
        latestRevision: null,
        detailsHydrated: false,
        loading: false,
        error: "",
        message: ""
      },
      manualRoster: {
        teamCode: "fighters",
        entries: [],
        catalog: [],
        search: "",
        confirmed: false,
        loading: false,
        loaded: false,
        schemaAvailable: null,
        source: null,
        isManualSaved: false,
        updatedAt: null,
        updatedBy: null,
        error: "",
        message: ""
      },
      lineupCorrection: {
        games: [],
        selectedGameId: "",
        details: null,
        rows: [],
        reason: "",
        confirmed: false,
        loading: false,
        gamesLoaded: false,
        error: "",
        message: ""
      },
      rankingTestUsers: {
        internalGameId: "",
        selectedSlot: 1,
        slots: [],
        globalSettings: { globalEnabled: false, slotNames: {}, displayNames: {} },
        displayNameDraft: "",
        setting: { includeInPublicRanking: false },
        positionLabels: {},
        rows: [],
        loading: false,
        error: "",
        message: ""
      }
    };
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3State = createAdminV3State;
})(window);
