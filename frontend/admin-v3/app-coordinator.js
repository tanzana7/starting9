(function registerAdminV3Coordinator(global) {
  "use strict";

  function createAdminV3Coordinator({ document, window, state, actions }) {
    const composingManualSearches = new Set();
    let manualRosterSearchComposing = false;

    function closestFromEvent(event, selector) {
      const target = event?.target;
      if (target && typeof target.closest === "function") return target.closest(selector);
      const parent = target?.parentElement;
      return parent && typeof parent.closest === "function" ? parent.closest(selector) : null;
    }

    function manualSearchIndex(field) {
      return Number(field?.dataset?.v3ManualLineupSearch);
    }

    function isManualSearchComposing(event, field) {
      return event?.isComposing === true || composingManualSearches.has(manualSearchIndex(field));
    }

    function preservePickerScroll(selector, callback) {
      const before = document.querySelector(selector);
      const scrollTop = Number(before?.scrollTop);
      try {
        return callback();
      } finally {
        if (before && Number.isFinite(scrollTop)) {
          const after = document.querySelector(selector);
          if (after) after.scrollTop = scrollTop;
        }
      }
    }

    function bindManualSearchCompositionEvents() {
      document.addEventListener("compositionstart", (event) => {
        const field = closestFromEvent(event, "[data-v3-manual-lineup-search]");
        if (field) composingManualSearches.add(manualSearchIndex(field));
        if (closestFromEvent(event, "[data-v3-manual-roster-search]")) manualRosterSearchComposing = true;
      });
      document.addEventListener("compositionend", (event) => {
        const field = closestFromEvent(event, "[data-v3-manual-lineup-search]");
        if (field) {
          const index = manualSearchIndex(field);
          composingManualSearches.delete(index);
          actions.updateManualLineupSearch(index, field.value);
        }
        const rosterField = closestFromEvent(event, "[data-v3-manual-roster-search]");
        if (rosterField) {
          manualRosterSearchComposing = false;
          actions.updateManualRosterSearch(rosterField.value);
        }
      });
      document.addEventListener("keydown", (event) => {
        const field = closestFromEvent(event, "[data-v3-manual-lineup-search]");
        if (field && event.key === "Enter" && isManualSearchComposing(event, field)) event.preventDefault();
      });
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
        const rankingSearch = closestFromEvent(event, "[data-v3-ranking-exclusion-search]");
        if (rankingSearch) {
          state.rankingReset.gameSearch = rankingSearch.value;
          actions.renderRankingExclusionGames();
          return;
        }
        const manualSearch = closestFromEvent(event, "[data-v3-manual-lineup-search]");
        if (manualSearch) {
          if (isManualSearchComposing(event, manualSearch)) return;
          actions.updateManualLineupSearch(manualSearchIndex(manualSearch), manualSearch.value);
        }
        const correctionSearch = closestFromEvent(event, "[data-v3-lineup-correction-search]");
        if (correctionSearch) actions.updateLineupCorrectionSearch(Number(correctionSearch.dataset.v3LineupCorrectionSearch), correctionSearch.value);
        const correctionReason = closestFromEvent(event, "[data-v3-lineup-correction-reason]");
        if (correctionReason) { state.lineupCorrection.reason = correctionReason.value; state.lineupCorrection.error = ""; return; }
        const rosterSearch = closestFromEvent(event, "[data-v3-manual-roster-search]");
        if (rosterSearch) {
          if (event.isComposing || manualRosterSearchComposing) return;
          actions.updateManualRosterSearch(rosterSearch.value);
        }
        const rankingTestName = closestFromEvent(event, "[data-v3-ranking-test-name]");
        if (rankingTestName) actions.updateRankingTestDisplayName(rankingTestName.value);
      });
      document.addEventListener("change", (event) => {
        const rankingFilter = closestFromEvent(event, "[data-v3-ranking-exclusion-filter]");
        if (rankingFilter) {
          state.rankingReset.gameFilter = rankingFilter.value;
          actions.renderRankingExclusionGames();
          return;
        }
        const position = closestFromEvent(event, "[data-v3-manual-lineup-position]");
        if (position) {
          preservePickerScroll(`[data-v3-manual-lineup-candidates="${Number(position.dataset.v3ManualLineupPosition)}"]`, () => actions.updateManualLineupRow(Number(position.dataset.v3ManualLineupPosition), { position: position.value }));
          return;
        }
        const correctionOrder = closestFromEvent(event, "[data-v3-lineup-correction-order]");
        if (correctionOrder) { preservePickerScroll(`[data-v3-lineup-correction-candidates="${Number(correctionOrder.dataset.v3LineupCorrectionOrder)}"]`, () => actions.updateLineupCorrectionRow(Number(correctionOrder.dataset.v3LineupCorrectionOrder), { battingOrder: Number(correctionOrder.value) })); return; }
        const correctionPosition = closestFromEvent(event, "[data-v3-lineup-correction-position]");
        if (correctionPosition) { preservePickerScroll(`[data-v3-lineup-correction-candidates="${Number(correctionPosition.dataset.v3LineupCorrectionPosition)}"]`, () => actions.updateLineupCorrectionRow(Number(correctionPosition.dataset.v3LineupCorrectionPosition), { position: correctionPosition.value })); return; }
        const rosterStatus = closestFromEvent(event, "[data-v3-manual-roster-status]");
        if (rosterStatus) { preservePickerScroll("[data-v3-manual-roster-candidates]", () => actions.updateManualRosterEntry(rosterStatus.dataset.v3ManualRosterStatus, { status: rosterStatus.value })); return; }
        const rosterNote = closestFromEvent(event, "[data-v3-manual-roster-note]");
        if (rosterNote) { preservePickerScroll("[data-v3-manual-roster-candidates]", () => actions.updateManualRosterEntry(rosterNote.dataset.v3ManualRosterNote, { note: rosterNote.value })); return; }
        const rosterConfirm = closestFromEvent(event, "[data-v3-manual-roster-confirm]");
        if (rosterConfirm) { state.manualRoster.confirmed = rosterConfirm.checked === true; }
        const rankingTestName = closestFromEvent(event, "[data-v3-ranking-test-name]");
        if (rankingTestName) actions.updateRankingTestDisplayName(rankingTestName.value);
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
        if (closestFromEvent(event, "[data-v3-ranking-exclusion-refresh]")) { await actions.refreshRankingExclusionGames(true); return; }
        const manualPlayer = closestFromEvent(event, "[data-v3-manual-lineup-player]");
        if (manualPlayer) {
          preservePickerScroll(`[data-v3-manual-lineup-candidates="${Number(manualPlayer.dataset.v3ManualLineupPlayer)}"]`, () => actions.selectManualLineupPlayer(Number(manualPlayer.dataset.v3ManualLineupPlayer), manualPlayer.dataset.v3ManualLineupPlayerId));
          return;
        }
        const correctionPlayer = closestFromEvent(event, "[data-v3-lineup-correction-player]");
        if (correctionPlayer) {
          preservePickerScroll(`[data-v3-lineup-correction-candidates="${Number(correctionPlayer.dataset.v3LineupCorrectionPlayer)}"]`, () => actions.selectLineupCorrectionPlayer(Number(correctionPlayer.dataset.v3LineupCorrectionPlayer), correctionPlayer.dataset.v3LineupCorrectionPlayerId));
          return;
        }
        const correctionGame = closestFromEvent(event, "[data-v3-lineup-correction-game]");
        if (correctionGame) { await actions.selectLineupCorrection(correctionGame.dataset.v3LineupCorrectionGame); return; }
        const correctionConfirm = closestFromEvent(event, "[data-v3-lineup-correction-confirm]");
        if (correctionConfirm) { state.lineupCorrection.confirmed = correctionConfirm.checked === true; return; }
        if (closestFromEvent(event, "[data-v3-lineup-correction-submit]")) { await actions.submitLineupCorrection(); return; }
        if (closestFromEvent(event, "[data-v3-manual-lineup-preview]")) { await actions.saveManualLineup(); return; }
        if (closestFromEvent(event, "[data-v3-manual-lineup-finalize]")) { await actions.finalizeManualLineup(); return; }
        const lineupCancel = closestFromEvent(event, "[data-v3-manual-lineup-revision-cancel]");
        if (lineupCancel) { await actions.cancelManualLineup(lineupCancel.dataset.v3ManualLineupRevisionCancel); return; }
        const rosterAdd = closestFromEvent(event, "[data-v3-manual-roster-add]");
        if (rosterAdd) { preservePickerScroll("[data-v3-manual-roster-candidates]", () => actions.addManualRosterPlayer(rosterAdd.dataset.v3ManualRosterAdd)); return; }
        const rosterRemove = closestFromEvent(event, "[data-v3-manual-roster-remove]");
        if (rosterRemove) { preservePickerScroll("[data-v3-manual-roster-candidates]", () => actions.updateManualRosterEntry(rosterRemove.dataset.v3ManualRosterRemove, { status: "inactive" })); return; }
        if (closestFromEvent(event, "[data-v3-manual-roster-save]")) { await actions.saveManualRoster(); return; }
        const rankingTestSlot = closestFromEvent(event, "[data-v3-ranking-test-slot]");
        if (rankingTestSlot) { actions.selectRankingTestSlot(Number(rankingTestSlot.dataset.v3RankingTestSlot)); return; }
        if (closestFromEvent(event, "[data-v3-ranking-test-toggle]")) { await actions.toggleRankingTestPublic(); return; }
        if (closestFromEvent(event, "[data-v3-ranking-test-name-save]")) { await actions.saveRankingTestDisplayName(); return; }
        if (closestFromEvent(event, "[data-v3-ranking-test-global]")) { await actions.toggleRankingTestGlobal(); return; }

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
        const cancelButton = closestFromEvent(event, "[data-v3-schedule-cancel]");
        if (cancelButton) {
          await actions.cancelGame(cancelButton.dataset.v3ScheduleCancel);
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
        bindManualSearchCompositionEvents();
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
