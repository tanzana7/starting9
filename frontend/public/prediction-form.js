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
        if (typeof deps.waitForAuthInitialization === "function") {
          try {
            await deps.waitForAuthInitialization();
          } catch {
            // 認証初期化の失敗は端末保存を壊さず、現在の認証状態で安全に分岐します。
          }
        }
        if (!deps.getPredictionAccountUser()) {
          const authStatus = typeof deps.getPredictionAccountStatus === "function"
            ? deps.getPredictionAccountStatus()
            : null;
          const authUnavailable = Number(authStatus?.errorStatus || 0) === 503
            || Boolean(authStatus?.errorCode && authStatus.errorCode !== "AUTH_REQUIRED");
          if (authUnavailable) {
            // 認証確認だけが失敗した場合は、既存セッションを保存APIで一度だけ判定します。
            // API側の401/503/通信失敗をそのまま分類し、無限retryは行いません。
            const savedToAccount = await deps.savePredictionToAccount(deps.state.prediction, { allowAuthProbe: true });
            if (savedToAccount) {
              deps.showPredictionSaveMessage("予想を保存しました。");
            } else {
              deps.showMessage("predictionError", deps.state.predictionRemote.message || "端末には保存しましたが、アカウント保存の結果を確認できませんでした。");
            }
          } else {
            deps.showPredictionSaveMessage("この端末に予想を保存しました。ログインするとアカウントにも保存できます。");
          }
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
