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
      ops.restoreAdminWorkflowLogsExpanded();
      ops.removeLegacyAdminQueryParameter();
      this.state.isAdminMode = false;
      ops.buildLineupPicker("prediction", "predictionLineup", "predictionPlayers");
      ops.buildLineupPicker("actual", "actualLineup", "actualPlayers");
      ops.loadState();
      ops.bindEvents();
      window.addEventListener("ham-schedule-log-updated", ops.renderScheduleLoadLog);
      ops.renderScheduleLoadLog();
      ops.restoreAdminGameInfoInputs();
      ops.applyAdminMode();
      ops.syncPublicAppState();
      ops.renderAll();

      await ops.initializePublicGameCatalog();
      await this.initializeSchedule();
      ops.startAutoScoringCountdown();
      ops.startPredictionDeadlineTicker();

      const probablePromise = ops.initializeProbableStarter();
      const rosterPromise = ops.initializeRosterCandidateSync();
      const authPromise = ops.initializeAuthDependentFeatures();
      await Promise.allSettled([probablePromise, rosterPromise, authPromise]);
      await ops.initializePredictionRemoteSync();
      await ops.initializeDailyBestNine();
      ops.refreshPredictionDeadlineState();
      ops.syncPublicAppState();
      ops.renderAll();
      void ops.refreshGameDayNoticeStatus({ force: true });
    }

    async initializeSchedule() {
      const ops = this.operations;
      const scheduleReady = window.HAM_GAME_SCHEDULE_READY;
      if (scheduleReady && typeof scheduleReady.then === "function") {
        try {
          await scheduleReady;
          if (window.HAM_GAME_SCHEDULE_ERROR) {
            ops.setScheduleLoaderMessage(window.HAM_GAME_SCHEDULE_ERROR, "error");
          }
        } catch (error) {
          ops.setScheduleLoaderMessage("日程情報を読み込めませんでした。", "error");
          console.warn("日程データの初期化に失敗しました", error?.message || "unknown error");
        }
      }
      ops.initializeGameSchedule();
      ops.refreshPredictionDeadlineState();
      ops.renderAll();
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
          ops.refreshAdminAccess(),
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
