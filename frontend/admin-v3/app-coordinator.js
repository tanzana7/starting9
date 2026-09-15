(function registerAdminV3Coordinator(global) {
  "use strict";

  function createAdminV3Coordinator({ document, window, state, actions }) {
    const composingManualSearches = new Set();
    let manualRosterSearchComposing = false;
    const manualDragThreshold = 10;
    let manualPointer = null;
    let suppressManualClickUntil = 0;

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

    function clearManualPointerClasses() {
      document.querySelectorAll("[data-v3-manual-lineup-slot].is-dragging, [data-v3-manual-lineup-slot].is-drop-target, [data-v3-manual-lineup-player].is-dragging, [data-v3-manual-lineup-player].is-drop-target").forEach((element) => {
        element.classList.remove("is-dragging", "is-drop-target");
      });
    }

    function closeManualPositionMenus() {
      document.querySelectorAll(".manual-lineup-position-menu").forEach((menu) => {
        menu.classList.add("hidden");
        menu.classList.remove("is-viewport-positioned", "is-portal-position-menu");
        ["left", "top", "right", "max-width", "box-sizing"].forEach((property) => menu.style?.removeProperty?.(property));
        const host = menu._manualPositionMenuHost;
        if (host && menu.parentElement !== host) host.appendChild(menu);
        delete menu._manualPositionMenuHost;
      });
      document.querySelectorAll("[data-v3-manual-lineup-position-button]").forEach((button) => button.setAttribute("aria-expanded", "false"));
    }

    function positionManualPositionMenu(menu, button) {
      if (!menu || !button || !document.body || typeof button.getBoundingClientRect !== "function") return;
      if (!menu._manualPositionMenuHost) menu._manualPositionMenuHost = menu.parentElement;
      if (menu.parentElement !== document.body) document.body.appendChild(menu);
      menu.classList.add("is-portal-position-menu", "is-viewport-positioned");
      const viewportWidth = Number(window.visualViewport?.width) || Number(window.innerWidth) || document.documentElement?.clientWidth || 0;
      const viewportHeight = Number(window.visualViewport?.height) || Number(window.innerHeight) || document.documentElement?.clientHeight || 0;
      const padding = 8;
      menu.style.right = "auto";
      menu.style.maxWidth = `${Math.max(0, viewportWidth - padding * 2)}px`;
      menu.style.boxSizing = "border-box";
      const buttonRect = button.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const menuWidth = Math.min(menuRect.width, Math.max(0, viewportWidth - padding * 2));
      const left = Math.min(Math.max(padding, buttonRect.left), Math.max(padding, viewportWidth - menuWidth - padding));
      const maxTop = viewportHeight - menuRect.height - padding;
      const top = maxTop >= padding ? Math.min(buttonRect.bottom + 6, maxTop) : padding;
      menu.style.left = `${Math.round(left)}px`;
      menu.style.top = `${Math.round(Math.max(padding, top))}px`;
    }

    function updateManualPositionMenuState(menu) {
      const slot = menu?.closest?.("[data-v3-manual-lineup-slot]") || menu?._manualPositionMenuHost?.closest?.("[data-v3-manual-lineup-slot]");
      const current = slot?.querySelector?.("[data-v3-manual-lineup-position-button]")?.textContent?.trim() || "?";
      const usedPositions = new Set(Array.from(document.querySelectorAll("[data-v3-manual-lineup-position-button]"))
        .map((button) => button.textContent.trim())
        .filter((value) => value && value !== "?"));
      menu?.querySelectorAll?.("[data-v3-manual-lineup-position-option]").forEach((option) => {
        const position = option.dataset.position || "";
        const isCurrent = (position || "?") === current;
        const isUsed = Boolean(position) && !isCurrent && usedPositions.has(position);
        option.classList.toggle("is-current", isCurrent);
        option.classList.toggle("is-used", isUsed);
        option.title = isUsed ? "選択するとポジションを入れ替えます" : "";
        option.setAttribute("aria-label", position ? `${position}を選択${isUsed ? "（他の打順で使用中。選択すると入れ替えます）" : ""}` : "守備位置を未選択にする");
      });
    }

    function manualPointerTarget(event) {
      const candidate = closestFromEvent(event, "[data-v3-manual-lineup-player]");
      if (candidate) return { kind: "candidate", element: candidate, index: Number(candidate.dataset.v3ManualLineupPlayer), playerId: candidate.dataset.v3ManualLineupPlayerId || "" };
      const slot = closestFromEvent(event, "[data-v3-manual-lineup-slot]");
      if (slot) return { kind: "slot", element: slot, index: Number(slot.dataset.v3ManualLineupSlot), playerId: slot.dataset.v3ManualLineupPlayerId || "" };
      return null;
    }

    function beginManualPointer(event) {
      if (event?.button !== undefined && event.button !== 0) return;
      const target = manualPointerTarget(event);
      if (!target || (target.kind === "slot" && !target.playerId)) return;
      if (target.kind === "slot" && closestFromEvent(event, "select, input, textarea, summary, [data-v3-manual-lineup-clear], [data-v3-manual-lineup-position-button], [data-v3-manual-lineup-position-option]")) return;
      manualPointer = {
        pointerId: event.pointerId,
        kind: target.kind,
        element: target.element,
        sourceIndex: target.index,
        playerId: target.playerId,
        startX: Number(event.clientX) || 0,
        startY: Number(event.clientY) || 0,
        dragging: false,
        targetIndex: null
      };
    }

    function updateManualPointer(event) {
      if (!manualPointer || (manualPointer.pointerId !== undefined && event.pointerId !== undefined && manualPointer.pointerId !== event.pointerId)) return;
      const dx = (Number(event.clientX) || 0) - manualPointer.startX;
      const dy = (Number(event.clientY) || 0) - manualPointer.startY;
      if (!manualPointer.dragging && Math.hypot(dx, dy) < manualDragThreshold) return;
      if (!manualPointer.dragging) {
        manualPointer.dragging = true;
        manualPointer.element.classList.add("is-dragging");
        try { manualPointer.element.setPointerCapture?.(event.pointerId); } catch { /* capture is best effort on older mobile browsers */ }
      }
      event.preventDefault?.();
      const point = document.elementFromPoint?.(Number(event.clientX) || 0, Number(event.clientY) || 0);
      const slot = point?.closest?.("[data-v3-manual-lineup-slot]");
      clearManualPointerClasses();
      manualPointer.element.classList.add("is-dragging");
      if (slot) {
        const index = Number(slot.dataset.v3ManualLineupSlot);
        if (Number.isInteger(index)) {
          manualPointer.targetIndex = index;
          slot.classList.add("is-drop-target");
        }
      }
    }

    function finishManualPointer(event, cancelled = false) {
      if (!manualPointer || (manualPointer.pointerId !== undefined && event?.pointerId !== undefined && manualPointer.pointerId !== event.pointerId)) return;
      const current = manualPointer;
      manualPointer = null;
      if (!current.dragging || cancelled) {
        clearManualPointerClasses();
        return;
      }
      event?.preventDefault?.();
      suppressManualClickUntil = Date.now() + 400;
      clearManualPointerClasses();
      if (!Number.isInteger(current.targetIndex) || current.targetIndex < 0) return;
      if (current.kind === "candidate") {
        preservePickerScroll(`[data-v3-manual-lineup-candidates="${current.sourceIndex}"]`, () => actions.assignManualLineupPlayerToSlot(current.targetIndex, current.playerId));
      } else if (current.sourceIndex !== current.targetIndex) {
        actions.reorderManualLineup(current.sourceIndex, current.targetIndex);
      }
    }

    function bindManualPointerEvents() {
      document.addEventListener("pointerdown", beginManualPointer, { passive: true });
      document.addEventListener("pointermove", updateManualPointer, { passive: false });
      document.addEventListener("pointerup", (event) => finishManualPointer(event), { passive: false });
      document.addEventListener("pointercancel", (event) => finishManualPointer(event, true), { passive: true });
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
        if (Date.now() < suppressManualClickUntil) {
          suppressManualClickUntil = 0;
          return;
        }
        const navButton = closestFromEvent(event, "[data-v3-view]");
        if (navButton) { actions.chooseView(navButton.dataset.v3View); return; }
        if (closestFromEvent(event, "[data-v3-ranking-reset-preview]")) { await actions.previewRankingReset(); return; }
        if (closestFromEvent(event, "[data-v3-ranking-reset-execute]")) { await actions.executeRankingReset(); return; }
        if (closestFromEvent(event, "[data-v3-perfect-score-preview]")) { await actions.previewPerfectScore("perfect"); return; }
        if (closestFromEvent(event, "[data-v3-manual-game-preview]")) { await actions.previewManualGame(); return; }
        if (closestFromEvent(event, "[data-v3-automation-log-refresh]")) { await actions.refreshAutomationLogs(); return; }
        if (closestFromEvent(event, "[data-v3-ranking-exclusion-refresh]")) { await actions.refreshRankingExclusionGames(true); return; }
        if (closestFromEvent(event, "[data-v3-lineup-roster-refresh]")) { await actions.refreshLineupRoster?.(); return; }
        const manualSlot = closestFromEvent(event, "[data-v3-manual-lineup-slot]");
        if (manualSlot && !closestFromEvent(event, "button, input, select, option, summary, textarea")) {
          actions.selectManualLineupSlot(Number(manualSlot.dataset.v3ManualLineupSlot));
          return;
        }
        const manualPositionOption = closestFromEvent(event, "[data-v3-manual-lineup-position-option]");
        if (manualPositionOption) {
          const index = Number(manualPositionOption.dataset.v3ManualLineupPositionOption);
          closeManualPositionMenus();
          preservePickerScroll(`[data-v3-manual-lineup-candidates="${index}"]`, () => actions.updateManualLineupPosition(index, manualPositionOption.dataset.position || ""));
          return;
        }
        const manualPositionButton = closestFromEvent(event, "[data-v3-manual-lineup-position-button]");
        if (manualPositionButton) {
          const menu = document.getElementById(manualPositionButton.getAttribute("aria-controls"));
          const shouldOpen = Boolean(menu?.classList.contains("hidden"));
          closeManualPositionMenus();
          if (menu && shouldOpen) {
            updateManualPositionMenuState(menu);
            menu.classList.remove("hidden");
            positionManualPositionMenu(menu, manualPositionButton);
            manualPositionButton.setAttribute("aria-expanded", "true");
          }
          return;
        }
        const manualPlayer = closestFromEvent(event, "[data-v3-manual-lineup-player]");
        if (manualPlayer) {
          preservePickerScroll(`[data-v3-manual-lineup-candidates="${Number(manualPlayer.dataset.v3ManualLineupPlayer)}"]`, () => actions.selectManualLineupPlayer(Number(manualPlayer.dataset.v3ManualLineupPlayer), manualPlayer.dataset.v3ManualLineupPlayerId));
          return;
        }
        const manualFilter = closestFromEvent(event, "[data-v3-manual-lineup-roster-filter]");
        if (manualFilter) {
          preservePickerScroll(`[data-v3-manual-lineup-candidates="${Number(state.manualLineup?.activeIndex || 0)}"]`, () => actions.setManualLineupRosterFilter(manualFilter.dataset.v3ManualLineupRosterFilter));
          return;
        }
        const manualClear = closestFromEvent(event, "[data-v3-manual-lineup-clear]");
        if (manualClear) {
          actions.clearManualLineupSlot(Number(manualClear.dataset.v3ManualLineupClear));
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
        const rankingTestNameSave = closestFromEvent(event, "[data-v3-ranking-test-name-save]");
        if (rankingTestNameSave) { await actions.saveRankingTestDisplayName(Number(rankingTestNameSave.dataset.v3RankingTestNameSave)); return; }
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

    function bindRosterActivityEvents() {
      const refreshWhenActive = () => {
        if (document.visibilityState === "hidden") return;
        void Promise.resolve(actions.refreshLineupRoster?.()).catch((error) => {
          console.warn("選択中試合のロースター再確認に失敗しました", error);
        });
      };
      document.addEventListener("visibilitychange", refreshWhenActive);
      window.addEventListener("focus", refreshWhenActive);
      window.addEventListener("pageshow", refreshWhenActive);
    }

    return Object.freeze({
      start() {
        bindManualSearchCompositionEvents();
        bindInputEvents();
        bindClickEvents();
        bindManualPointerEvents();
        bindToolbarEvents();
        bindRosterActivityEvents();
        window.addEventListener("resize", closeManualPositionMenus);
        document.addEventListener("scroll", closeManualPositionMenus, true);
        actions.restoreInitialRoute();
        actions.load();
      }
    });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3Coordinator = createAdminV3Coordinator;
})(window);
