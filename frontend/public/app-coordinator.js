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

    scheduleOptionalWork(callback) {
      const run = () => {
        try {
          void Promise.resolve(callback()).catch((error) => {
            console.error("公開画面の遅延初期化に失敗しました", error);
          });
        } catch (error) {
          console.error("公開画面の遅延初期化に失敗しました", error);
        }
      };
      if (typeof window?.requestIdleCallback === "function") {
        window.requestIdleCallback(run, { timeout: 1200 });
      } else {
        setTimeout(run, 0);
      }
    }

    async initialize() {
      const ops = this.operations;
      ops.buildLineupPicker("prediction", "predictionLineup", "predictionPlayers");
      ops.loadState();
      ops.bindEvents();
      this.state.publicGameCatalog.isLoading = true;
      ops.syncPublicAppState();
      ops.renderAll();

      // Keep the first paint independent from the public catalog and all optional data.
      // Result history is loaded after auth is ready and scheduled as non-critical work.
      void ops.initializeAuthDependentFeatures().catch((error) => {
        console.error("認証依存の後続初期化に失敗しました", error);
      });
      void ops.initializePublicGameCatalog()
        .then(() => {
          void ops.maybeLoadFastPreviousResult();
          ops.startPredictionDeadlineTicker();
          this.scheduleOptionalWork(() => Promise.allSettled([
            ops.initializeProbableStarter(),
            ops.initializeRosterCandidateSync(),
            ops.initializePredictionRemoteSync()
          ]));
          ops.refreshPredictionDeadlineState();
          ops.syncPublicAppState();
          ops.renderAll();
          this.scheduleOptionalWork(() => ops.refreshGameDayNoticeStatus({ force: true }));
        })
        .catch((error) => {
          console.error("公開試合情報の後続初期化に失敗しました", error);
        });
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
        const criticalResults = await Promise.allSettled([
          ops.syncPredictionFromAccount({ force: true })
        ]);
        criticalResults.forEach((result) => {
          if (result.status === "rejected") {
            console.error("公開画面の認証依存更新に失敗しました", result.reason?.message || "unknown error");
          }
        });
        const loadNonCritical = () => Promise.allSettled([
          ops.refreshResultHistory({ force: true }),
          ops.fetchUserAchievements({ force: true })
        ]).then((results) => {
          results.forEach((result) => {
            if (result.status === "rejected") {
              console.error("公開画面の補助データ更新に失敗しました", result.reason?.message || "unknown error");
            }
          });
        });
        if (typeof window?.requestIdleCallback === "function") {
          window.requestIdleCallback(() => { void loadNonCritical(); }, { timeout: 1500 });
        } else {
          setTimeout(() => { void loadNonCritical(); }, 0);
        }
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
