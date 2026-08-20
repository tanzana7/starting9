(function registerAdminV3Coordinator(global) {
  "use strict";

  function createAdminV3Coordinator({ document, window, state, actions }) {
    function closestFromEvent(event, selector) {
      const target = event?.target;
      if (target && typeof target.closest === "function") return target.closest(selector);
      const parent = target?.parentElement;
      return parent && typeof parent.closest === "function" ? parent.closest(selector) : null;
    }

    function bindInputEvents() {
      document.addEventListener("input", (event) => {
        const field = closestFromEvent(event, "[data-v3-ranking-reset-field]");
        if (field) {
          state.rankingReset[field.dataset.v3RankingResetField] = field.value;
          return;
        }
        const perfectField = closestFromEvent(event, "[data-v3-perfect-score-field]");
        if (perfectField) state.perfectScorePreview[perfectField.dataset.v3PerfectScoreField] = perfectField.value;
      });
    }

    function bindClickEvents() {
      document.addEventListener("click", async (event) => {
        const navButton = closestFromEvent(event, "[data-v3-view]");
        if (navButton) { actions.chooseView(navButton.dataset.v3View); return; }
        if (closestFromEvent(event, "[data-v3-ranking-reset-preview]")) { await actions.previewRankingReset(); return; }
        if (closestFromEvent(event, "[data-v3-ranking-reset-execute]")) { await actions.executeRankingReset(); return; }
        if (closestFromEvent(event, "[data-v3-perfect-score-preview]")) { await actions.previewPerfectScore("perfect"); return; }
        if (closestFromEvent(event, "[data-v3-manual-game-preview]")) { await actions.previewManualGame(); return; }
        if (closestFromEvent(event, "[data-v3-automation-log-refresh]")) { await actions.refreshAutomationLogs(); return; }

        const diagnoseButton = closestFromEvent(event, "[data-v3-job-diagnose]");
        if (diagnoseButton) {
          await actions.diagnoseJob(diagnoseButton.dataset.v3JobDiagnose, diagnoseButton.dataset.v3JobType);
          return;
        }
        const runButton = closestFromEvent(event, "[data-v3-job-run]");
        if (runButton) {
          await actions.runJob(runButton.dataset.v3JobRun, runButton.dataset.v3JobType);
          return;
        }
        const reconcileButton = closestFromEvent(event, "[data-v3-state-reconcile]");
        if (reconcileButton) {
          await actions.reconcileState(reconcileButton.dataset.v3StateReconcile);
          return;
        }
        const scheduleButton = closestFromEvent(event, "[data-v3-schedule-save]");
        if (scheduleButton) {
          await actions.saveSchedule(scheduleButton.dataset.v3ScheduleSave);
          return;
        }
        const rankingExcludeButton = closestFromEvent(event, "[data-v3-ranking-exclude]");
        if (rankingExcludeButton) {
          await actions.excludeFromRanking(rankingExcludeButton.dataset.v3RankingExclude);
          return;
        }

        const selectButton = closestFromEvent(event, "[data-v3-select-game]");
        if (selectButton) { await actions.selectGame(selectButton.dataset.v3SelectGame); return; }

        if (closestFromEvent(event, "#mobileNavToggle")) {
          const navigation = document.getElementById("v3Navigation");
          const open = navigation?.classList.toggle("open");
          closestFromEvent(event, "#mobileNavToggle")?.setAttribute("aria-expanded", String(Boolean(open)));
          return;
        }

        const jobCopyButton = closestFromEvent(event, "[data-v3-job-copy]");
        if (jobCopyButton) { await actions.copyJobDetail(jobCopyButton); return; }

        const jobDetailRefreshButton = closestFromEvent(event, "[data-v3-job-detail-refresh]");
        if (jobDetailRefreshButton) {
          await actions.refreshJobDetail(jobDetailRefreshButton.dataset.v3JobDetailRefresh, jobDetailRefreshButton.dataset.v3JobDetailRefreshId);
          return;
        }

        const jobDetailButton = closestFromEvent(event, "[data-v3-job-detail]");
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
