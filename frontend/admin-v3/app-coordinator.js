(function registerAdminV3Coordinator(global) {
  "use strict";

  function createAdminV3Coordinator({ document, window, state, actions }) {
    function bindInputEvents() {
      document.addEventListener("input", (event) => {
        const field = event.target.closest("[data-v3-ranking-reset-field]");
        if (field) {
          state.rankingReset[field.dataset.v3RankingResetField] = field.value;
          return;
        }
        const perfectField = event.target.closest("[data-v3-perfect-score-field]");
        if (perfectField) state.perfectScorePreview[perfectField.dataset.v3PerfectScoreField] = perfectField.value;
      });
    }

    function bindClickEvents() {
      document.addEventListener("click", async (event) => {
        const navButton = event.target.closest("[data-v3-view]");
        if (navButton) { actions.chooseView(navButton.dataset.v3View); return; }
        if (event.target.closest("[data-v3-ranking-reset-preview]")) { await actions.previewRankingReset(); return; }
        if (event.target.closest("[data-v3-ranking-reset-execute]")) { await actions.executeRankingReset(); return; }
        if (event.target.closest("[data-v3-perfect-score-preview]")) { await actions.previewPerfectScore("perfect"); return; }
        if (event.target.closest("[data-v3-manual-game-preview]")) { await actions.previewManualGame(); return; }
        if (event.target.closest("[data-v3-automation-log-refresh]")) { await actions.refreshAutomationLogs(); return; }

        const diagnoseButton = event.target.closest("[data-v3-job-diagnose]");
        if (diagnoseButton) {
          await actions.diagnoseJob(diagnoseButton.dataset.v3JobDiagnose, diagnoseButton.dataset.v3JobType);
          return;
        }
        const runButton = event.target.closest("[data-v3-job-run]");
        if (runButton) {
          await actions.runJob(runButton.dataset.v3JobRun, runButton.dataset.v3JobType);
          return;
        }
        const reconcileButton = event.target.closest("[data-v3-state-reconcile]");
        if (reconcileButton) {
          await actions.reconcileState(reconcileButton.dataset.v3StateReconcile);
          return;
        }
        const scheduleButton = event.target.closest("[data-v3-schedule-save]");
        if (scheduleButton) {
          await actions.saveSchedule(scheduleButton.dataset.v3ScheduleSave);
          return;
        }
        const rankingExcludeButton = event.target.closest("[data-v3-ranking-exclude]");
        if (rankingExcludeButton) {
          await actions.excludeFromRanking(rankingExcludeButton.dataset.v3RankingExclude);
          return;
        }

        const selectButton = event.target.closest("[data-v3-select-game]");
        if (selectButton) { await actions.selectGame(selectButton.dataset.v3SelectGame); return; }

        if (event.target.closest("#mobileNavToggle")) {
          const navigation = document.getElementById("v3Navigation");
          const open = navigation?.classList.toggle("open");
          event.target.closest("#mobileNavToggle")?.setAttribute("aria-expanded", String(Boolean(open)));
          return;
        }

        const jobCopyButton = event.target.closest("[data-v3-job-copy]");
        if (jobCopyButton) { await actions.copyJobDetail(jobCopyButton); return; }

        const jobDetailRefreshButton = event.target.closest("[data-v3-job-detail-refresh]");
        if (jobDetailRefreshButton) {
          await actions.refreshJobDetail(jobDetailRefreshButton.dataset.v3JobDetailRefresh, jobDetailRefreshButton.dataset.v3JobDetailRefreshId);
          return;
        }

        const jobDetailButton = event.target.closest("[data-v3-job-detail]");
        if (jobDetailButton) await actions.toggleJobDetail(jobDetailButton.dataset.v3JobDetail, jobDetailButton.dataset.v3JobId);
      });
    }

    function bindToolbarEvents() {
      document.getElementById("refreshV3")?.addEventListener("click", actions.load);
      document.getElementById("refreshV3View")?.addEventListener("click", actions.load);
      document.getElementById("v3GameFilter")?.addEventListener("change", (event) => actions.changeFilter(event.target.value));
      document.getElementById("v3GameSelect")?.addEventListener("change", (event) => actions.selectGameFromToolbar(event.target.value));
      window.addEventListener("hashchange", actions.handleHashChange);
    }

    return Object.freeze({
      start() {
        bindInputEvents();
        bindClickEvents();
        bindToolbarEvents();
        actions.restoreInitialRoute();
        actions.load();
      }
    });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3Coordinator = createAdminV3Coordinator;
})(window);
