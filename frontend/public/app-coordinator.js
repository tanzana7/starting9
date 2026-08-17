(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  class PublicAppCoordinator {
    constructor({ appState, state, operations }) {
      this.appState = appState;
      this.state = state;
      this.operations = operations;
    }

    start() {
      if (this.appState.requests.initialization.promise) {
        return this.appState.requests.initialization.promise;
      }

      this.appState.requests.initialization.started = true;
      this.appState.requests.initialization.promise = this.initialize().catch((error) => {
        console.error("公開画面の初期化に失敗しました", error);
        return null;
      });
      return this.appState.requests.initialization.promise;
    }

    async initialize() {
      const ops = this.operations;
      ops.buildLineupPicker("prediction", "predictionLineup", "predictionPlayers");
      ops.loadState();
      ops.bindEvents();
      ops.syncPublicAppState();
      ops.renderAll();

      await ops.initializePublicGameCatalog();
      ops.startPredictionDeadlineTicker();

      void ops.fetchPreviousResultGame({ force: true });
      const probablePromise = ops.initializeProbableStarter();
      const rosterPromise = ops.initializeRosterCandidateSync();
      const authPromise = ops.initializeAuthDependentFeatures();
      void Promise.allSettled([probablePromise, rosterPromise, authPromise]);
      void Promise.allSettled([
        ops.initializePredictionRemoteSync(),
        ops.initializeDailyBestNine()
      ]);
      ops.refreshPredictionDeadlineState();
      ops.syncPublicAppState();
      ops.renderAll();
      void ops.refreshGameDayNoticeStatus({ force: true });
    }

    handleAuthStateChanged() {
      if (this.appState.requests.auth.promise) {
        return this.appState.requests.auth.promise;
      }

      const ops = this.operations;
      const requestId = ++this.appState.requests.auth.sequence;
      this.appState.requests.auth.promise = (async () => {
        ops.renderPredictionCta();
        ops.renderDailyBestNine();
        const results = await Promise.allSettled([
          ops.syncPredictionFromAccount({ force: true }),
          ops.fetchUserAchievements({ force: true }),
          ops.refreshYearlyRanking({ force: true }),
          this.state.rankingView === "monthly" ? ops.refreshMonthlyRanking({ force: true }) : Promise.resolve(),
          this.state.rankingView === "weekly" ? ops.refreshWeeklyRanking({ force: true }) : Promise.resolve(),
          ops.refreshResultHistory({ force: true })
        ]);
        results.forEach((result) => {
          if (result.status === "rejected") {
            console.error("公開画面の認証依存更新に失敗しました", result.reason?.message || "unknown error");
          }
        });
      })().finally(() => {
        if (this.appState.requests.auth.sequence === requestId) {
          this.appState.requests.auth.promise = null;
        }
      });
      return this.appState.requests.auth.promise;
    }
  }

  publicFrontend.PublicAppCoordinator = PublicAppCoordinator;
})();
