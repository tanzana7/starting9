(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicPredictionFormController(deps) {
    async function handleSubmit(event) {
      event.preventDefault();
      if (deps.state.predictionRemote.isSaving || deps.state.predictionRemote.isSubmitting) {
        return;
      }
      if (!deps.ensurePredictionEditingAllowed()) {
        return;
      }

      deps.state.predictionRemote.isSubmitting = true;
      deps.updatePredictionSaveButton();
      try {
        ["predictionError", "predictionSaveMessage", "predictionResetMessage", "resetMessage"].forEach(deps.clearMessage);
        const lineup = deps.getLineupValues("prediction");
        const validationError = deps.validateLineup(lineup, "予想");
        if (validationError) {
          deps.showMessage("predictionError", validationError);
          deps.markDuplicateSlots("prediction", lineup);
          return;
        }

        deps.state.prediction = {
          gameId: deps.getCurrentGameId(),
          lineup,
          savedAt: new Date().toISOString()
        };
        deps.storage.save(deps.storageKeys.prediction, deps.state.prediction);
        deps.preserveDisplayedResult();
        deps.renderSavedPrediction();
        deps.renderPredictionCta();
        deps.renderPredictionAccountStatus();
        deps.renderPublicGameSelectionMeta();
        deps.renderPicker("prediction");
        if (!deps.getPredictionAccountUser()) {
          deps.showPredictionSaveMessage("この端末に予想を保存しました。");
          return;
        }

        const savedToAccount = await deps.savePredictionToAccount(deps.state.prediction);
        if (savedToAccount) {
          deps.showPredictionSaveMessage("予想を保存しました。");
          return;
        }
        deps.showMessage("predictionError", deps.state.predictionRemote.message || "端末には保存しましたが、アカウントへの保存に失敗しました。");
      } finally {
        deps.state.predictionRemote.isSubmitting = false;
        deps.updatePredictionSaveButton();
      }
    }

    function reset() {
      if (!deps.ensurePredictionEditingAllowed()) {
        return;
      }
      if (!window.confirm("入力中の予想をリセットします。よろしいですか？")) {
        return;
      }

      const remoteGameId = deps.getCurrentGameId();
      deps.state.prediction = null;
      deps.preserveDisplayedResult();
      deps.state.activeOrder.prediction = 0;
      deps.storage.remove(deps.storageKeys.prediction);
      document.getElementById("predictionForm").reset();
      deps.setLineupValues("prediction", []);
      deps.closeAllPositionMenus();
      ["predictionPlayerDetails", "predictionResetMessage"].forEach((elementId) => {
        const element = document.getElementById(elementId);
        if (elementId === "predictionPlayerDetails") {
          element.classList.add("hidden");
          element.innerHTML = "";
        } else {
          element.textContent = "予想をリセットしました。";
        }
      });
      deps.clearMessage("predictionError");
      deps.clearMessage("testPredictionMessage");
      deps.renderSavedPrediction();
      deps.renderScoreResult();
      deps.renderPredictionAccountStatus();
      deps.renderPicker("prediction");
      if (remoteGameId && deps.getPredictionAccountUser()) {
        void deps.deletePredictionFromAccount(remoteGameId);
      }
    }

    return { handleSubmit, reset };
  }

  publicFrontend.createPublicPredictionFormController = createPublicPredictionFormController;
})();
