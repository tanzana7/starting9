(function registerAdminV3GameProgressRenderer(global) {
  "use strict";

  function createAdminV3GameProgressRenderer({
    escapeHtml,
    formatJst,
    formatTimelineTime,
    renderSummaryCard,
    renderSelectedGameHeader,
    statusLabel,
    statusClass,
    identityStatusLabel,
    npbIdentityDisplay,
    gameHasAttention,
    gameDateForFilter,
    nextActionText,
    latestJob,
    normalizedPhaseState,
    rosterDisplaySlots,
    rosterDisplayState,
    lineupDisplayState,
    rosterTimelineDetails,
    renderRosterSummary,
    renderJobRows,
    renderTodayOps,
    renderPerfectScorePreview,
    listItems,
    filterGames,
    normalizeRevisionList,
    selectedDetails,
    selectedGame,
    jstDate,
    jobTypes,
    jobLabels,
    manualOperation,
    renderManualLineup
  }) {
    const MANUAL_STAGE_TYPES = Object.freeze([
      ["schedule_register", "日程登録", false],
      ["probable_starter_fetch", "予告先発取得", true],
      ["roster_fetch", "ロースター取得", true],
      ["prediction_close", "予想締切", true],
      ["npb_identity_resolve", "NPB識別情報解決", true],
      ["lineup_fetch", "スタメン取得", true],
      ["lineup_finalize", "正式スタメン確定", true],
      ["score", "採点", true],
      ["ranking_rebuild", "ランキング反映", true],
      ["publish", "結果公開", true]
    ]);

    function diagnosticValue(value) {
      if (value === null || value === undefined || value === "") return "-";
      if (typeof value === "boolean") return value ? "あり" : "なし";
      return String(value);
    }

    function renderDiagnosticGrid(items) {
      return `<dl class="v3-job-diagnostic-grid">${items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(diagnosticValue(value))}</dd></div>`).join("")}</dl>`;
    }

    function renderJobDiagnosis(diagnosis) {
      const context = diagnosis?.diagnosticContext;
      if (!diagnosis || !context) return "";
      const latest = context.latestJob || {};
      const related = diagnosis.relatedDataSummary || {};
      const artifact = context.artifactHealth || diagnosis.workflowArtifactHealth || {};
      const lineup = artifact.lineup || related.artifactHealth?.lineup || {};
      const recovery = context.recovery || {};
      const cancellation = context.cancellation || {};
      const attention = diagnosis.manualActionRequired || diagnosis.completedArtifactMismatch || context.jobTimelineError || context.workflowTransitionsError;
      const terminal = latest.status === "failed" || (latest.status === "retry_wait" && Number(latest.attemptCount || 0) >= Number(latest.maxAttempts || 0));
      const currentStatus = diagnosis.completedArtifactMismatch
        ? `ATTENTION / ${diagnosis.completedArtifactMismatch.code}`
        : terminal ? `ATTENTION / ${latest.status} terminal` : diagnosis.canRun ? "実行可能" : "実行不可";
      const jobMarkup = renderDiagnosticGrid([
        ["現在workflow state", diagnosis.currentWorkflowState],
        ["現在の診断", currentStatus],
        ["job id", latest.id || diagnosis.latestJobId],
        ["status", latest.status || diagnosis.latestJobStatus],
        ["scheduledAt", latest.scheduledAt || diagnosis.latestJobScheduledAt],
        ["scheduledSlotAt", latest.scheduledSlotAt],
        ["createdAt", latest.createdAt],
        ["claimedAt", latest.claimedAt || diagnosis.latestJobClaimedAt],
        ["completedAt", latest.completedAt || diagnosis.latestJobCompletedAt],
        ["failedAt", latest.failedAt],
        ["attempt", latest.attemptCount],
        ["terminal", terminal],
        ["nextRetryAt", latest.nextRetryAt],
        ["last reason/error", latest.failureCode || diagnosis.latestJobError?.code || latest.failureMessage || diagnosis.latestJobError?.message]
      ]);
      const recoveryMarkup = renderDiagnosticGrid([
        ["terminal job", recovery.terminalJobId ? `#${recovery.terminalJobId} (${recovery.terminalStatus})` : "なし"],
        ["recovery job created", recovery.recoveryJobCreated],
        ["recovery job id", recovery.recoveryJobId ? `#${recovery.recoveryJobId}` : null],
        ["recovery status", recovery.recoveryJobStatus],
        ["recovery scheduledAt", recovery.recoveryScheduledAt],
        ["recovery completedAt", recovery.recoveryCompletedAt],
        ["recovery note", recovery.reason]
      ]);
      const artifactMarkup = renderDiagnosticGrid([
        ["artifact health", artifact.available === false ? "unavailable" : artifact.available === true ? "available" : null],
        ["lineup candidate", lineup.candidateExists],
        ["candidate id", lineup.candidateId],
        ["candidate internalGameId", lineup.candidateInternalGameId],
        ["candidate row count", lineup.candidateRowCount],
        ["candidate createdAt", lineup.candidateCreatedAt],
        ["candidate count / valid", lineup.candidateCount === null || lineup.candidateCount === undefined ? null : `${lineup.candidateCount} / ${lineup.candidateValidCount ?? "-"}`],
        ["canonical exists", lineup.canonicalExists ?? lineup.canonicalDataReady],
        ["canonical id", lineup.canonicalId],
        ["canonical internalGameId", lineup.canonicalInternalGameId],
        ["canonical row count", lineup.canonicalRowCount],
        ["canonical createdAt", lineup.canonicalCreatedAt],
        ["finalized exists", lineup.finalizedLineupExists],
        ["finalized id", lineup.finalizedId],
        ["finalized internalGameId", lineup.finalizedInternalGameId],
        ["finalized row count", lineup.finalizedRowCount],
        ["finalized createdAt", lineup.finalizedCreatedAt],
        ["finalized valid", lineup.finalizedValid],
        ["artifact verification", lineup.verificationStatus || (lineup.artifactVerified ? "verified" : null)],
        ["scoring eligibility", artifact.scoring?.ready === true ? "eligible" : artifact.scoring?.available === false ? "unknown" : "not_ready"],
        ["row validation", lineup.validation ? JSON.stringify(lineup.validation) : null]
      ]);
      const transitions = Array.isArray(context.workflowTransitions) && context.workflowTransitions.length
        ? `<ul class="v3-job-diagnostic-list">${context.workflowTransitions.slice(0, 8).map((item) => `<li>${escapeHtml(`${item.occurredAt || "-"} / ${item.jobType || "job"} #${item.jobId || "-"}: ${item.stateBefore || "-"} → ${item.stateAfter || "-"}${item.failureCode ? ` / ${item.failureCode}` : ""}`)}</li>`).join("")}</ul>`
        : "<p class=muted>state遷移履歴はありません。</p>";
      const timeline = Array.isArray(context.jobTimeline) && context.jobTimeline.length
        ? `<ul class="v3-job-diagnostic-list">${context.jobTimeline.slice(0, 8).map((item) => `<li>${escapeHtml(`#${item.id || "-"} ${item.status || "-"} / slot ${item.scheduledSlotAt || "-"} / attempt ${item.attemptCount ?? "-"}${item.failureCode ? ` / ${item.failureCode}` : ""}`)}</li>`).join("")}</ul>`
        : "<p class=muted>同種job履歴はありません。</p>";
      const npbMarkup = renderDiagnosticGrid([
        ["NPB response code", context.npbResponse?.code || related.npbResponseCode],
        ["NPB response source", context.npbResponse?.source],
        ["last observed", context.npbResponse?.lastObservedAt],
        ["response/error", context.npbResponse?.message || diagnosis.latestJobError?.message]
      ]);
      const cancellationMarkup = renderDiagnosticGrid([
        ["gameStatus", cancellation.gameStatus],
        ["cancellationStatus", cancellation.cancellationStatus],
        ["source", cancellation.source],
        ["reason", cancellation.reason],
        ["detectedAt", cancellation.detectedAt],
        ["cancelledAt", cancellation.cancelledAt],
        ["excludedAt", cancellation.excludedAt],
        ["stopped jobs", cancellation.stoppedJobsTotal],
        ["rankingExcluded", cancellation.rankingExcluded],
        ["read-only", cancellation.readOnly]
      ]);
      const safeAction = cancellation.isUnavailable
        ? "中止・対象外のためlineup_fetch以降は不要です。停止jobと中止監査を確認してください。"
        : diagnosis.nextSafeAction || diagnosis.cannotRunReason || "成果物と現在状態を確認してください。";
      return `<details class="v3-job-diagnostic ${attention ? "attention" : ""}" data-v3-job-diagnostic ${attention ? "open" : ""}><summary>詳細診断${attention ? " / ATTENTION" : ""}</summary><section><h4>job lifecycle</h4>${jobMarkup}</section><section><h4>recovery / retry</h4>${recoveryMarkup}<h5>同種job履歴</h5>${timeline}</section><section><h4>workflow state transition</h4>${transitions}</section><section><h4>artifact health</h4>${artifactMarkup}</section><section><h4>NPB response / blocking reason</h4>${npbMarkup}<p class="v3-job-diagnostic-note">${escapeHtml(safeAction)}</p></section><section><h4>cancelled / excluded</h4>${cancellationMarkup}</section></details>`;
    }

    function renderManualControls(game) {
      if (!game?.internalGameId) return "";
      const gameUnavailable = ["cancelled", "canceled", "postponed", "service_unavailable"].includes(String(game?.gameStatus || "").toLowerCase());
      const rows = MANUAL_STAGE_TYPES.map(([jobType, label, canRun]) => {
        const operation = typeof manualOperation === "function" ? manualOperation(game.internalGameId, jobType) || {} : {};
        const loading = operation.status === "loading";
        const publishedReadOnly = String(game?.state?.state || "") === "published" || game?.workflowArtifactHealth?.publication?.published === true;
        const result = operation.message ? `<small class="manual-job-result ${operation.error ? "error" : "success"}">${escapeHtml(operation.message)}</small>` : "";
        const runButton = canRun && !publishedReadOnly && !gameUnavailable
          ? `<button type="button" data-v3-job-run="${escapeHtml(game.internalGameId)}" data-v3-job-type="${escapeHtml(jobType)}" ${loading ? "disabled" : ""}>再実行</button>`
          : `<span class="manual-job-unavailable">${publishedReadOnly ? "公開済み / 読み取り専用" : gameUnavailable ? "中止・対象外 / 停止" : "正式runnerなし"}</span>`;
        return `<div class="manual-job-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(operation.diagnosis?.currentWorkflowState || game.state?.state || "scheduled")}</span><div class="manual-job-actions"><button type="button" data-v3-job-diagnose="${escapeHtml(game.internalGameId)}" data-v3-job-type="${escapeHtml(jobType)}" ${loading ? "disabled" : ""}>診断</button>${runButton}</div>${result}${renderJobDiagnosis(operation.diagnosis)}</div>`;
      }).join("");
      const reconcileOperation = typeof manualOperation === "function" ? manualOperation(game.internalGameId, "state_reconcile") || {} : {};
      const reconcileResult = reconcileOperation.message ? `<small class="manual-job-result ${reconcileOperation.error ? "error" : "success"}">${escapeHtml(reconcileOperation.message)}</small>` : "";
      const reconcileLoading = reconcileOperation.status === "loading";
      return `<section class="v3-panel manual-job-controls" aria-labelledby="manualJobControlsHeading"><div class="view-heading"><div><h3 id="manualJobControlsHeading">V3工程の診断・手動再実行</h3><p>再実行は正式V3 jobを投入し、Cronのexecutorへ渡します。状態再同期は成果物確認済みの場合だけ実行できます。</p></div></div><div class="manual-job-list">${rows}</div><div class="manual-job-row manual-state-reconcile"><strong>workflow state</strong><span>${escapeHtml(game.state?.state || "scheduled")}</span><div class="manual-job-actions"><button type="button" data-v3-state-reconcile="${escapeHtml(game.internalGameId)}" ${reconcileLoading || gameUnavailable ? "disabled" : ""}>成果物を確認して状態再同期</button></div>${reconcileResult}</div></section>`;
    }
    function renderGameSummary(game, buttonLabel = "試合進行を見る") {
      const identity = identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState);
      const probable = game.probableStarter;
      const probableStatus = probable?.dataStatus || probable?.status || "unannounced";
      return `<article class="game-card"><div class="game-heading"><h3>${escapeHtml(gameDateForFilter(game))} ${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)}</h3>${gameHasAttention(game) ? "<span class=attention-badge>要対応</span>" : ""}</div><div class="game-meta"><span>開始 ${escapeHtml(formatJst(game.startAt, false))} JST</span><span>state: ${escapeHtml(game.state?.state || "scheduled")}</span><span>NPB: ${escapeHtml(identity)}</span><span>予告先発: ${escapeHtml(probableStatus)}</span><span>次: ${escapeHtml(nextActionText(game))}</span></div><div class="game-card-actions"><button type="button" data-v3-select-game="${escapeHtml(game.internalGameId)}">${escapeHtml(buttonLabel)}</button></div></article>`;
    }

    function probableStarterDetails(game, job, now = new Date()) {
      const starter = game?.probableStarter;
      const diagnostics = game?.probableStarterDiagnostics;
      const details = [];
      const dataStatus = starter?.dataStatus || (starter?.status === "announced" ? "announced" : starter?.status);
      if (diagnostics?.currentDataStatus || dataStatus) details.push(`normalizedDataStatus: ${diagnostics?.currentDataStatus || dataStatus}`);
      if (diagnostics?.rawStatus || starter?.status) details.push(`raw status: ${diagnostics?.rawStatus || starter.status}`);
      if (diagnostics?.rawDataStatus || starter?.dataStatus) details.push(`raw dataStatus: ${diagnostics?.rawDataStatus || starter.dataStatus}`);
      if (diagnostics?.rawErrorCode || starter?.errorCode) details.push(`raw errorCode: ${diagnostics?.rawErrorCode || starter.errorCode}`);
      if (typeof diagnostics?.shouldStopScheduling === "boolean") details.push(`後続取得: ${diagnostics.shouldStopScheduling ? "停止" : "継続"}`);
      if (diagnostics?.reasonCode) details.push(`stopReason: ${diagnostics.reasonCode}`);
      if (diagnostics?.shouldStopScheduling && diagnostics?.reasonCode) details.push(`停止理由: ${diagnostics.reasonCode}`);
      const integrityFields = [
        ["integrityErrorReason", diagnostics?.integrityErrorReason],
        ["internalGameId", diagnostics?.internalGameId],
        ["probableStarterRowInternalGameId", diagnostics?.probableStarterRowInternalGameId],
        ["canonical row id", diagnostics?.canonicalRowId],
        ["conflicting row id", diagnostics?.conflictingRowId],
        ["legacy row detected", diagnostics?.legacyRowDetected],
        ["mismatched row id", diagnostics?.mismatchedRowId],
        ["mismatched internalGameId", diagnostics?.mismatchedInternalGameId],
        ["homeTeam", diagnostics?.homeTeam],
        ["awayTeam", diagnostics?.awayTeam],
        ["fetchedHomeTeam", diagnostics?.fetchedHomeTeam],
        ["fetchedAwayTeam", diagnostics?.fetchedAwayTeam],
        ["gameDate", diagnostics?.gameDate],
        ["fetchedGameDate", diagnostics?.fetchedGameDate],
        ["npbGameCode", diagnostics?.npbGameCode],
        ["fetchedNpbGameCode", diagnostics?.fetchedNpbGameCode],
        ["homePitcherPresent", diagnostics?.homePitcherPresent],
        ["awayPitcherPresent", diagnostics?.awayPitcherPresent]
      ];
      integrityFields.forEach(([label, value]) => {
        if (value !== undefined) details.push(`${label}: ${value === null || value === "" ? "null" : value}`);
      });
      if (dataStatus === "announced" || dataStatus === "partial") {
        details.push(`home: ${starter?.homePitcherName || "未発表"} / away: ${starter?.awayPitcherName || "未発表"}`);
        if (dataStatus === "partial") details.push("一部発表・自動確認継続中");
      } else if (starter?.status) {
        details.push({ unannounced: "未発表", transient_error: "一時的に取得失敗", integrity_error: "データ整合性エラー" }[dataStatus] || dataStatus);
      }
      if (job?.scheduled_slot_at) details.push(`対象slot: ${formatJst(job.scheduled_slot_at)}`);
      if (job?.claimed_at || job?.completed_at) details.push(`実行: ${formatJst(job.completed_at || job.claimed_at)}`);
      if (dataStatus) details.push(`取得結果: ${dataStatus}`);
      if (starter?.sourceUrl) details.push(`取得元: ${starter.sourceUrl}`);
      if (starter?.fetchedAt) details.push(`最終取得: ${formatJst(starter.fetchedAt)}`);
      const nextCheckAt = game?.probableStarterNextCheckAt || starter?.nextCheckAt || diagnostics?.nextCheckAt;
      if (nextCheckAt) details.push(`次回自動確認: ${formatJst(nextCheckAt)}`);
      const nextJob = game?.probableStarterJob;
      if (nextCheckAt) {
        if (nextJob?.actualJobExists) {
          details.push(`${formatJst(nextCheckAt)} job: ${statusLabel(nextJob.jobStatus)} / 試行 ${nextJob.attemptCount || 0}/${nextJob.maxAttempts || 0}`);
          if (nextJob.scheduledSlotAt) details.push(`実在scheduledSlotAt: ${formatJst(nextJob.scheduledSlotAt)}`);
        } else details.push(`${formatJst(nextCheckAt)} job: 未生成`);
      }
      if (diagnostics?.reasonCode && (!nextJob?.actualJobExists || diagnostics.reasonCode !== "PROBABLE_STARTER_JOB_CREATED")) details.push(`未生成理由: ${diagnostics.reasonCode}`);
      if (diagnostics?.conflictingJobId) details.push(`競合job: ${diagnostics.conflictingJobId}`);
      if (diagnostics?.conflictingScheduledSlotAt) details.push(`競合slot: ${formatJst(diagnostics.conflictingScheduledSlotAt)}`);
      if (diagnostics?.conflictingStatus) details.push(`競合status: ${diagnostics.conflictingStatus}`);
      if (job?.failure_code || diagnostics?.errorCode) details.push(`errorCode: ${job?.failure_code || diagnostics?.errorCode}`);
      if (diagnostics?.httpStatus || diagnostics?.parserResult || diagnostics?.candidateCount !== null) details.push(`診断: HTTP ${diagnostics.httpStatus ?? "-"} / ${diagnostics.parserResult || "-"} / 候補 ${diagnostics.candidateCount ?? "-"}`);
      if (job && Number.isFinite(Number(job.attempt_count))) details.push(`試行 ${job.attempt_count || 0}/${job.max_attempts || 0}`);
      const scheduledAt = game?.schedule?.probableStarterNextAt ? new Date(game.schedule.probableStarterNextAt) : null;
      if (!job && scheduledAt && scheduledAt.getTime() <= now.getTime()) details.push("実行待ち / job未生成 / 要確認");
      return details.join(" / ") || (job ? "" : "前日18:00予定");
    }

    function timelineStep(name, job, fallbackStatus, detail = "", scheduledAt = "", labelOverride = "", statusOverride = "") {
      const status = statusOverride || (job ? String(job.status) : fallbackStatus);
      const klass = status === "complete" ? "complete" : status === "action" ? "action" : status === "wait" ? "wait" : statusClass(status);
      const label = labelOverride || (job ? statusLabel(status) : ({ complete: "完了", scheduled: "予定", wait: "待機中", action: "要対応" }[fallbackStatus] || "待機中"));
      const completedAt = job && (status === "completed" || status === "complete" || klass === "complete")
        ? (job.completed_at || job.updated_at || job.claimed_at || "")
        : "";
      const time = completedAt || scheduledAt || (job ? (status === "retry_wait" ? job.next_retry_at : job.scheduled_at) : "");
      const timeLabel = completedAt ? "完了日時" : "";
      const failure = job?.failure_code ? ` / ${job.failure_code}` : "";
      const timeMarkup = formatTimelineTime(time) || (detail && !failure ? detail : "予定未定");
      return `<article class="timeline-step ${klass}"><span class="status-badge ${klass === "complete" ? "ok" : klass === "retry" ? "retry" : klass === "failed" || klass === "action" ? "action" : klass === "excluded" ? "excluded" : "wait"}">${escapeHtml(label)}</span><h4>${escapeHtml(name)}</h4><p class="step-time">${escapeHtml(timeLabel ? `${timeLabel}: ${timeMarkup}` : timeMarkup)}</p><p>${escapeHtml(detail || failure || (job ? `試行 ${job.attempt_count || 0}/${job.max_attempts || 0}` : ""))}</p></article>`;
    }

    function timelinePhaseStep(name, game, phase, job, fallbackStatus, detail = "", scheduledAt = "") {
      const normalized = normalizedPhaseState(game, phase);
      if (!normalized) return timelineStep(name, job, fallbackStatus, detail, scheduledAt);
      return timelineStep(name, job, normalized.fallbackStatus, normalized.detail || detail, normalized.nextCheckAt || scheduledAt, normalized.label, normalized.fallbackStatus);
    }

    function renderTimeline(game) {
      const schedule = game.schedule || {};
      const state = String(game.state?.state || "scheduled");
      const identityStatus = String(game.npbIdentityStatus || "");
      const identityState = String(game.npbIdentityState || "");
      const identityJob = latestJob(game, "npb_identity_resolve");
      const identityDisplay = npbIdentityDisplay(game);
      const identityFallback = identityStatus === "resolved" || identityStatus === "manually_overridden" ? "complete" : identityState === "manual_action_required" ? "action" : identityState === "retry_wait" ? "retry" : "scheduled";
      const predictionJob = latestJob(game, "prediction_close");
      const lineupJob = latestJob(game, "lineup_fetch");
      const finalizeJob = latestJob(game, "lineup_finalize");
      const scoreJob = latestJob(game, "score");
      const rankingJob = latestJob(game, "ranking_rebuild");
      const publishJob = latestJob(game, "publish");
      const rosterState = rosterDisplayState(game);
      const baseLineupState = lineupDisplayState(game);
      const lineupGate = game?.workflowDiagnostics?.lineupFetch || {};
      const lineupState = lineupGate.blockingReasons?.length
        ? {
            ...baseLineupState,
            fallbackStatus: "action",
            label: lineupGate.blockingReasons.length > 1
              ? "複数の前提未解決"
              : lineupGate.blockingReasonCode === "NPB_GAME_CODE_NOT_AVAILABLE"
                ? "NPB識別情報待ち"
                : "state gateで待機",
            reasonCode: lineupGate.blockingReasonCode || "V3_LINEUP_FETCH_BLOCKED",
            detail: lineupGate.blockingReasons.map((reason) => `${reason.code}: ${reason.message}`).join(" / "),
            nextCheckAt: null
          }
        : baseLineupState;
      const displayRosterSlots = rosterDisplaySlots(game, schedule.rosterFetchSlots);
      const probableJob = latestJob(game, "probable_starter_fetch");
      const probableSlot = schedule.probableStarterNextAt ? new Date(schedule.probableStarterNextAt) : null;
      const probableMissingPastSlot = !probableJob && probableSlot && probableSlot.getTime() <= Date.now();
      const probableDataStatus = game?.probableStarter?.dataStatus || game?.probableStarter?.status;
      const probableFallback = probableMissingPastSlot ? "action" : probableDataStatus === "announced" ? "complete" : "wait";
      const probableTime = probableJob || probableMissingPastSlot ? "" : schedule.probableStarterNextAt;
      const steps = [
        timelineStep("日程登録", null, "complete", "games登録済み", schedule.startAt),
        timelineStep("予告先発取得", probableJob, probableFallback, probableStarterDetails(game, probableJob), probableTime),
        timelineStep("ロースター取得", rosterState.job, rosterState.fallbackStatus, rosterState.job?.failure_code || rosterTimelineDetails(game), displayRosterSlots),
        timelineStep("予想締切", predictionJob, state === "scheduled" ? "scheduled" : "complete", "締切は開始時刻から60分前", schedule.predictionDeadline),
        timelineStep("NPB識別情報解決", identityJob, identityFallback, `job: ${identityDisplay.jobStatus} / game code: ${identityDisplay.code}`),
        timelineStep("スタメン取得", lineupState.job || lineupJob, lineupState.fallbackStatus, lineupState.detail, lineupState.nextCheckAt || schedule.lineupPollingStart, lineupState.label, lineupState.fallbackStatus),
        timelineStep("正式スタメン確定", finalizeJob, ["lineup_ready", "scored", "ranked", "published"].includes(state) ? "complete" : "scheduled", "最新候補を開始2分後に確定", schedule.finalLineupAt),
        timelinePhaseStep("採点", game, "score", scoreJob, ["scored", "ranked", "published"].includes(state) ? "complete" : "scheduled", scoreJob ? "" : "正式スタメン確定後", schedule.scoringEarliestAt),
        timelinePhaseStep("ランキング反映", game, "ranking", rankingJob, ["ranked", "published"].includes(state) ? "complete" : "scheduled", rankingJob ? "" : "採点完了後"),
        timelinePhaseStep("結果公開", game, "publish", publishJob, state === "published" ? "complete" : "scheduled", "開始10分後", schedule.publicationAt)
      ];
      return `<div class="timeline">${steps.join("")}</div>`;
    }

    function renderWorkflowDiagnostics(game) {
      const diagnostics = game?.workflowDiagnostics || {};
      const historicalLineupWarnings = diagnostics.lineupFetch?.historicalWarnings || [];
      const historicalNote = diagnostics.lineupFetch?.currentStageStatus === "excluded"
        ? "現在は対象外試合として処理を停止しています。"
        : "現在は後続成果物によりスタメン取得を完了扱いにしています。";
      const messages = [
        diagnostics.predictionClose?.warning,
        diagnostics.identity?.warning,
        ...(diagnostics.completedStateMismatches || [])
          .filter((mismatch) => mismatch.jobType !== "prediction_close")
          .map((mismatch) => `${mismatch.code}: ${mismatch.message}`),
        ...(diagnostics.artifactBlockingReasons || []).map((reason) => `${reason.code}: ${reason.message}`),
        ...(diagnostics.lineupFetch?.blockingReasons || []).map((reason) => `${reason.code}: ${reason.message}`)
      ].filter(Boolean);
      const uniqueMessages = [...new Set(messages)];
      const history = historicalLineupWarnings.length
        ? `<details class="v3-operation-result historical-warning" data-v3-historical-warnings><summary>過去の警告（現在状態には影響しません）</summary><ul>${historicalLineupWarnings.map((warning) => `<li>${escapeHtml(`${warning.code}: ${warning.message}`)}</li>`).join("")}</ul><p>${escapeHtml(historicalNote)}</p></details>`
        : "";
      if (!uniqueMessages.length) return history;
      return `${history}<div class="v3-operation-result" data-v3-workflow-diagnostics><strong>現在の状態診断</strong><ul>${uniqueMessages.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul></div>`;
    }

    function renderV35DerivedDiagnostics(game) {
      const diagnostics = game?.v35DerivedDiagnostics;
      const title = "V3.5診断（試験中・read-only）";
      const readOnlyNote = "この診断はjob作成・state変更・DB書き込みを行いません。現行V3の状態を読み取り、V3.5視点で派生判定しています。";
      if (!diagnostics || diagnostics.enabled === false || diagnostics.status === "unavailable") {
        const reason = diagnostics?.reason || diagnostics?.errorCode || "V35_DERIVED_DIAGNOSTICS_UNAVAILABLE";
        const message = diagnostics?.status === "unavailable"
          ? (diagnostics.warning || "V3.5診断を取得できませんでした。現行V3の動作には影響ありません。")
          : diagnostics?.enabled === false
            ? `V3.5診断は無効です。理由: ${reason}`
            : "V3.5診断を取得できませんでした。現行V3の動作には影響ありません。";
        return `<section class="v35-derived-diagnostics v35-derived-diagnostics-unavailable" data-v35-derived-diagnostics><div class="v35-derived-header"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(readOnlyNote)}</p></div><span class="v35-derived-status">要確認</span></div><p class="v35-derived-message">${escapeHtml(message)}</p><code>${escapeHtml(reason)}</code></section>`;
      }
      const stages = diagnostics.stages && typeof diagnostics.stages === "object" ? diagnostics.stages : {};
      const v4SemiAuto = diagnostics.automationMode?.isV4SemiAuto === true;
      const stageLabels = {
        schedule_registration: "日程登録",
        npb_game_identify: "NPB識別",
        probable_starter: "予告先発",
        roster_fetch: "ロースター取得",
        prediction_close: "予想締切",
        lineup_fetch: "スタメン取得",
        lineup_finalize: "正式スタメン確定",
        scoring: "採点",
        ranking_reflect: "ランキング反映",
        publish: "結果公開"
      };
      const v4StageCopy = {
        roster_fetch: { status: "手動運用", reason: "V4では自動取得を使用しません", action: "no_action" },
        lineup_fetch: { status: "手動運用", reason: "V4では手動ラインナップを使用します", action: "no_action" },
        lineup_finalize: { status: "完了", reason: "手動canonical lineup revision確認済み", action: "no_action" }
      };
      const healthLabels = {
        COMPLETED_ARTIFACT_READY: "完了",
        COMPLETED_ARTIFACT_MISSING: "要対応",
        MISSING_JOB: "要対応",
        RETRY_WAIT_DUE: "要対応",
        TERMINAL_FAILED: "要対応",
        BLOCKED_BY_PREREQUISITE: "待機中",
        MANUAL_MODE: "手動運用",
        NOT_DUE: "未到来",
        DUE: "処理待ち"
      };
      const stageRows = Object.entries(stageLabels).map(([stage, label]) => {
        const item = stages[stage] || {};
        const manualCopy = v4SemiAuto ? v4StageCopy[stage] : null;
        const manualFinalReady = stage === "lineup_finalize" && item.manualArtifactReady === true;
        const attentionClass = item.attentionLevel === "ATTENTION" && !manualFinalReady ? " v35-stage-attention" : "";
        const status = manualCopy?.status || healthLabels[item.healthStatus] || item.healthStatus || "UNKNOWN";
        const reason = manualCopy?.reason || item.blockingReason || item.recoveryReason || (item.healthStatus === "NOT_DUE" ? "まだdue前" : "-");
        const action = manualCopy?.action || item.nextSafeAction || "-";
        return `<div class="v35-stage-row${attentionClass}"><strong>${escapeHtml(label)}</strong><span>状態: ${escapeHtml(manualFinalReady ? "完了" : status)}</span><span>理由: ${escapeHtml(manualFinalReady ? "manual lineup revision確認済み" : reason)}</span><span>対応: ${escapeHtml(manualFinalReady ? "no_action" : action)}</span><small class="v35-stage-code">healthStatus: ${escapeHtml(item.healthStatus || "UNKNOWN")}</small></div>`;
      }).join("");
      const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings.filter(Boolean) : [];
      const informationalNotices = Array.isArray(diagnostics.informationalNotices) ? diagnostics.informationalNotices.filter(Boolean) : [];
      const warningMarkup = warnings.length
        ? `<ul class="v35-derived-warnings">${warnings.map((warning) => `<li>${escapeHtml(`${warning.code || "WARNING"}: ${warning.message || ""}`)}</li>`).join("")}</ul>`
        : "<p class=muted>派生診断上の警告はありません。</p>";
      const informationalMarkup = informationalNotices.length
        ? `<ul class="v35-derived-info">${informationalNotices.map((notice) => `<li>${escapeHtml(`${notice.code || "INFO"}: ${notice.message || ""}`)}</li>`).join("")}</ul>`
        : "";
      const stateLabel = (value) => value === "schedule_registered" ? "scheduled（日程登録済み）" : (value || "-");
      const hasAttention = Object.values(stages).some((item) => item?.attentionLevel === "ATTENTION");
      const currentState = diagnostics.publishedHealthy
        ? "正常（published・成果物確認済み）"
        : diagnostics.stateMismatch || hasAttention
          ? "要対応"
          : "進行中";
      const currentStateClass = diagnostics.publishedHealthy
        ? ""
        : diagnostics.stateMismatch || hasAttention
          ? " v35-current-state-attention"
          : " v35-current-state-running";
      const modeNotice = v4SemiAuto
        ? "V4半自動運営: 予告先発は自動、ロースター・スタメン取得は手動。正式処理はcanonical lineup確定後にCronが継続します。"
        : "V3自動運営モードのread-only診断です。";
      return `<section class="v35-derived-diagnostics" data-v35-derived-diagnostics><div class="v35-derived-header"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(readOnlyNote)}</p><p class="v35-mode-notice">${escapeHtml(modeNotice)}</p></div><span class="v35-derived-status">表示専用</span></div><div class="v35-current-state${currentStateClass}"><span>現在状態</span><strong>${escapeHtml(currentState)}</strong></div><div class="v35-derived-state-grid"><div><span>effectiveState</span><strong>${escapeHtml(stateLabel(diagnostics.effectiveState))}</strong></div><div><span>persistedState</span><strong>${escapeHtml(stateLabel(diagnostics.persistedState))}</strong></div><div><span>stateMismatch</span><strong>${diagnostics.stateMismatch ? "あり" : "なし"}</strong></div></div><h4>stageHealth</h4><div class="v35-stage-list">${stageRows}</div>${informationalMarkup ? `<h4>V4補助情報</h4>${informationalMarkup}` : ""}<h4>warnings</h4>${warningMarkup}</section>`;
    }

    function renderV35ShadowRecoveryPlan(game) {
      const plan = game?.v35ShadowRecoveryPlan;
      const title = "V3.5復旧提案（試験中・read-only）";
      const readOnlyNote = "この提案は実行されません。job作成・state変更・DB書き込みは行いません。";
      if (!plan || plan.enabled === false || plan.error) {
        const reason = plan?.error || "V35_SHADOW_RECOVERY_PLAN_UNAVAILABLE";
        return `<section class="v35-shadow-recovery-plan v35-shadow-recovery-plan-unavailable" data-v35-shadow-recovery-plan><div class="v35-derived-header"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(readOnlyNote)}</p></div><span class="v35-derived-status">要確認</span></div><p class="v35-derived-message">V3.5復旧提案を生成できませんでした。現行V3の動作には影響ありません。</p><code>${escapeHtml(reason)}</code></section>`;
      }
      const itemMarkup = (item) => `<article class="v35-shadow-plan-item"><strong>${escapeHtml(item.stage || "-")}</strong><span>action: ${escapeHtml(item.actionType || "-")}</span><span>reason: ${escapeHtml(item.reason || "-")}</span><span>priority: ${escapeHtml(item.priority || "-")}</span><span>blocked: ${item.blocked ? "true" : "false"}</span><span>blockedReason: ${escapeHtml(item.blockedReason || "-")}</span><code>${escapeHtml(item.idempotencyKey || "-")}</code></article>`;
      const recommendations = Array.isArray(plan.recommendations) ? plan.recommendations : [];
      const blockedRecommendations = Array.isArray(plan.blockedRecommendations) ? plan.blockedRecommendations : [];
      const noActionReasons = Array.isArray(plan.noActionReasons) ? plan.noActionReasons.filter(Boolean) : [];
      const recommendationsMarkup = recommendations.length
        ? recommendations.map(itemMarkup).join("")
        : "<p class=muted>推奨アクションはありません。</p>";
      const blockedMarkup = blockedRecommendations.length
        ? blockedRecommendations.map(itemMarkup).join("")
        : "<p class=muted>保留中の提案はありません。</p>";
      const noActionLabels = {
        "roster_fetch:manual_mode": "ロースター取得: V4手動運用のため自動jobは作成しません",
        "lineup_fetch:manual_mode": "スタメン取得: V4手動運用のため自動jobは作成しません",
        "lineup_finalize:manual_mode": "ラインナップ確定: 手動canonical lineupを確認します"
      };
      const noActionMarkup = noActionReasons.length
        ? `<ul class="v35-shadow-plan-reasons">${noActionReasons.map((reason) => `<li>${escapeHtml(noActionLabels[reason] || reason)}</li>`).join("")}</ul>`
        : "<p class=muted>実行なし理由はありません。</p>";
      return `<section class="v35-shadow-recovery-plan" data-v35-shadow-recovery-plan><div class="v35-derived-header"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(readOnlyNote)}</p></div><span class="v35-derived-status">表示専用</span></div><div class="v35-shadow-plan-state"><div><span>mode</span><strong>${escapeHtml(plan.mode || "shadow_read_only")}</strong></div><div><span>canExecute</span><strong>false</strong></div><div><span>hasRecommendedActions</span><strong>${plan.hasRecommendedActions ? "true" : "false"}</strong></div></div><h4>推奨</h4><div class="v35-shadow-plan-list">${recommendationsMarkup}</div><h4>保留</h4><div class="v35-shadow-plan-list">${blockedMarkup}</div><h4>実行なし理由</h4>${noActionMarkup}</section>`;
    }

    function renderDashboard(payload, games) {
      const allGames = listItems(payload?.games, "games");
      const todayGames = filterGames(allGames, "today");
      const allJobs = allGames.flatMap((game) => listItems(game?.jobs, "jobs"));
      const todayJobs = todayGames.flatMap((game) => listItems(game?.jobs, "jobs"));
      const historicalGames = allGames.filter((game) => !todayGames.includes(game));
      const historicalJobs = historicalGames.flatMap((game) => listItems(game?.jobs, "jobs"));
      const v4SemiAuto = payload?.automationMode?.isV4SemiAuto === true;
      const operationAttention = (game) => {
        if (!v4SemiAuto) return gameHasAttention(game);
        const state = String(game?.state?.state || "");
        const diagnostics = game?.workflowDiagnostics || {};
        const jobs = listItems(game?.jobs, "jobs");
        return ["manual_action_required"].includes(state)
          || ["unresolved", "manual_action_required"].includes(String(game?.npbIdentityState || ""))
          || diagnostics.predictionClose?.overdue === true
          || diagnostics.predictionClose?.stateMismatch === true
          || diagnostics.completedStateMismatches?.length > 0
          || diagnostics.identity?.blocking === true
          || jobs.some((job) => ["failed", "retry_wait", "manual_action_required"].includes(String(job.status || "")));
      };
      const attention = todayGames.filter(operationAttention).length;
      const failed = todayJobs.filter((job) => job.status === "failed").length;
      const retry = todayJobs.filter((job) => job.status === "retry_wait").length;
      const historicalFailed = historicalJobs.filter((job) => job.status === "failed").length;
      const pendingIdentity = todayGames.filter((game) => ["pending", "retry_wait"].includes(game.npbIdentityState)).length;
      const completedToday = todayGames.reduce((count, game) => count + listItems(game?.jobs, "jobs").filter((job) => job.status === "completed" && String(job.completed_at || "").slice(0, 10) === jstDate()).length, 0);
      const publicationWait = todayGames.filter((game) => game.state?.state === "ranked").length;
      const cards = todayGames.length ? todayGames.map((game) => renderGameSummary(game)).join("") : `<div class="today-empty">本日の試合はありません</div>`;
      return `<div class="view-heading"><div><h2>ダッシュボード</h2><p>今日の運営状態と、過去試合の残留jobを分けて確認できます。</p></div></div>${renderTodayOps(payload, games)}<section class="today-card"><h3>本日の試合</h3>${cards}</section><section class="summary-grid">${renderSummaryCard("今日の要対応", attention, attention ? "attention" : "ok")}${renderSummaryCard("今日の失敗job", failed, failed ? "error" : "ok")}${renderSummaryCard("今日のretry_wait", retry, retry ? "attention" : "ok")}${renderSummaryCard("過去の失敗job", historicalFailed, historicalFailed ? "attention" : "ok")}${renderSummaryCard("今日の掲載待ち", pendingIdentity, pendingIdentity ? "attention" : "ok")}${renderSummaryCard("本日の完了job", completedToday)}${renderSummaryCard("今日の公開待ち", publicationWait, publicationWait ? "attention" : "ok")}</section><section class="v3-panel"><div class="view-heading"><div><h3>今日の自動処理</h3><p>詳細は試合進行メニューから確認できます。</p></div></div>${todayGames.length ? todayGames.map((game) => `<div class="compact-meta"><strong>${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)}</strong><span>次: ${escapeHtml(nextActionText(game))}</span><span>${escapeHtml(operationAttention(game) ? "要対応" : "正常")}</span></div>`).join("") : "<span class=muted>今日の処理履歴はありません。</span>"}</section>`;
    }

    function displayStatusForGame(game) {
      const supplied = game?.displayStatus;
      if (supplied?.key && supplied?.label) return supplied;
      const workflowState = String(game?.state?.state || game?.workflowState || "scheduled").toLowerCase();
      if (workflowState === "published" || game?.workflowArtifactHealth?.publication?.published === true) {
        return { key: "completed", label: "完了", reason: "公開済みです。", stage: "publish" };
      }
      if (gameHasAttention(game)) return { key: "needs_attention", label: "要対応", reason: "診断またはjob履歴を確認してください。", stage: "workflow" };
      const date = gameDateForFilter(game);
      const today = typeof jstDate === "function" ? jstDate() : "";
      if (date && today && date > today) return { key: "scheduled", label: "予定", reason: "未来試合です。", stage: "schedule" };
      return { key: "in_progress", label: "進行中", reason: "通常の処理対象です。", stage: workflowState };
    }

    function displayStatusClass(key) {
      return ({ completed: "ok", reprocessing: "retry", needs_attention: "action", in_progress: "running", scheduled: "scheduled" }[String(key || "")] || "wait");
    }

    function renderGamesView(games) {
      const rows = games.map((game) => {
        const progress = displayStatusForGame(game);
        const progressClass = displayStatusClass(progress.key);
        const reason = progress.reason ? `<small class="game-progress-reason">${escapeHtml(progress.reason)}</small>` : "";
        const response = progress.key === "needs_attention" ? "<span class=attention-badge>要対応</span>" : progress.key === "completed" ? "<span class=\"status-badge ok\">read-only</span>" : "<span class=\"status-badge wait\">確認</span>";
        return `<tr><td>${escapeHtml(gameDateForFilter(game))}</td><td>${escapeHtml(formatJst(game.startAt, false))}</td><td>${escapeHtml(game.homeTeam)}</td><td>${escapeHtml(game.awayTeam)}</td><td><span class="status-badge ${progressClass}" data-v3-game-progress-status="${escapeHtml(progress.key)}">${escapeHtml(progress.label)}</span>${reason}</td><td>${escapeHtml(progress.stage || "-")}</td><td>${escapeHtml(game.state?.state || "scheduled")}</td><td>${escapeHtml(identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState))}</td><td>${escapeHtml(nextActionText(game))}</td><td>${response}</td><td><button type="button" data-v3-select-game="${escapeHtml(game.internalGameId)}">詳細</button></td></tr>`;
      }).join("");
      return `<div class="view-heading"><div><h2>試合進行</h2><p>最近のFighters戦を新しい順に表示します。公開済み試合も履歴として残し、完了判定は現在の採点revisionと反映・公開成果物の一致で確認します。</p></div></div><div class="games-table-wrap"><table class="games-table"><thead><tr><th>日付</th><th>開始</th><th>home</th><th>away</th><th>進行状況</th><th>次段階</th><th>workflow</th><th>NPB</th><th>次の処理</th><th>対応</th><th></th></tr></thead><tbody>${rows || "<tr><td colspan=11>対象試合はありません。</td></tr>"}</tbody></table></div>`;
    }

    function renderWorkflowView(game) {
      if (!game) return renderSelectedGameHeader(null, "試合進行");
      const identity = npbIdentityDisplay(game);
      return `${renderSelectedGameHeader(game, "試合進行", "V3 jobの状態と監査結果を試合単位で確認します。自動処理はCronが実行します。")}<section class="v3-panel">${renderV35DerivedDiagnostics(game)}${renderV35ShadowRecoveryPlan(game)}<div class="compact-meta"><span>現在: <strong>${escapeHtml(game.state?.state || "scheduled")}</strong></span><span>次の処理: <strong>${escapeHtml(nextActionText(game))}</strong></span><span>NPB識別job: <strong>${escapeHtml(identity.jobStatus)}</strong></span><span>NPB game code: <strong>${escapeHtml(identity.code)}</strong></span></div>${renderWorkflowDiagnostics(game)}${renderTimeline(game)}<details class="roster-details"><summary>ロースター取得の詳細</summary>${renderRosterSummary(game)}</details><h3>job履歴</h3>${renderJobRows(game, jobTypes)}</section>${renderManualControls(game)}`;
    }

    function renderLineupView(game) {
      if (!game) return renderSelectedGameHeader(null, "スタメン");
      const details = selectedDetails();
      const current = details.lineup?.currentRevision;
      const finalRevision = details.lineup?.finalRevision || (current?.isFinal ? current : null);
      const canonicalStatus = details.lineup?.lineupStatus || "pending";
      const persistedState = game.state?.state || game.workflowState || "scheduled";
      const effectiveState = game.effectiveState || game.workflowDiagnostics?.effectiveState || game.workflowDiagnostics?.state || persistedState;
      const revisions = normalizeRevisionList(details.revisions);
      const revisionMarkup = revisions.items.map((revision) => `<div class="revision-row"><span><strong>${escapeHtml(revision.revisionId)}</strong> / ${escapeHtml(revision.source)} / ${escapeHtml(revision.reason || "-")}</span><span>${revision.isFinal ? "final" : "candidate"} ${escapeHtml(formatJst(revision.createdAt))}</span></div>`).join("") || "<span class=muted>revision履歴はありません。</span>";
      const revisionWarning = revisions.unexpected ? `<p class="v3-operation-result"><code>REVISION_SHAPE_UNEXPECTED</code> revision履歴の形式を確認できませんでした。</p>` : "";
      const stateWarning = persistedState !== effectiveState ? `<p class="v3-operation-warning" data-v3-state-mismatch-warning>workflow state不一致: persisted=${escapeHtml(persistedState)} / effective=${escapeHtml(effectiveState)}。成果物の反映後に正式Cronの状態同期を待ってください。</p>` : "";
      const manualMarkup = typeof renderManualLineup === "function" ? renderManualLineup(game, details) : "";
      return `${renderSelectedGameHeader(game, "スタメン", "V3が取得・確定したスタメンrevisionを確認します。")}<section class="v3-panel"><div class="detail-grid"><div><dt>最新revision</dt><dd>${escapeHtml(current?.revisionId || "未作成")}</dd></div><div><dt>revision状態</dt><dd>${finalRevision?.isFinal ? "final（正式revision）" : "candidate（下書き）"}</dd></div><div><dt>canonical lineup</dt><dd>${escapeHtml(canonicalStatus)}</dd></div><div><dt>workflow persisted</dt><dd>${escapeHtml(persistedState)}</dd></div><div><dt>workflow effective</dt><dd>${escapeHtml(effectiveState)}</dd></div><div><dt>finalizedAt</dt><dd>${escapeHtml(formatJst(details.lineup?.finalizedAt || finalRevision?.finalizedAt))}</dd></div></div>${stateWarning}<p class="muted">revisionの正式確定とcanonical lineupの採点状態は別管理です。canonicalがpendingでもrevision finalの確定記録は保持されます。</p><h3>revision履歴</h3>${revisionWarning}<div class="revision-list">${revisionMarkup}</div><h3>取得・確定job</h3>${renderJobRows(game, ["lineup_fetch", "lineup_finalize"])}</section>${manualMarkup}`;
    }

    function renderScoringView(game) {
      if (!game) return renderSelectedGameHeader(null, "採点・ランキング");
      const details = selectedDetails();
      const scoring = details.ranking?.scoring || {};
      const publication = details.publication?.publication || {};
      const noOpNotice = scoring.noOpReason ? `<div class="v3-operation-result" data-v3-scoring-no-op>予想0件または採点対象なしのため、採点はno-opで完了しました。<code>${escapeHtml(scoring.noOpReason)}</code></div>` : "";
      const rankingNoOpNotice = details.ranking?.rankingNoOpReason ? `<div class="v3-operation-result" data-v3-ranking-no-op>ランキング対象なしのため、ランキング反映はno-opで完了します。<code>${escapeHtml(details.ranking.rankingNoOpReason)}</code></div>` : "";
      return `${renderSelectedGameHeader(game, "採点・ランキング", "V3が進めた採点・ランキング・公開の状態を確認します。")}<section class="v3-panel"><div class="detail-grid"><div><dt>対象予想数</dt><dd>${escapeHtml(scoring.eligiblePredictionCount ?? "-")}</dd></div><div><dt>採点済み / 失敗</dt><dd>${escapeHtml(`${scoring.scoredPredictionCount ?? "-"} / ${scoring.failedPredictionCount ?? "-"}`)}</dd></div><div><dt>active scoring revision</dt><dd>${escapeHtml(details.ranking?.activeScoringRevision?.id || "-")}</dd></div><div><dt>ranking</dt><dd>${escapeHtml(details.ranking?.ranking?.gameStatus || "-")}</dd></div><div><dt>publication</dt><dd>${escapeHtml(publication.status || "pending")}</dd></div><div><dt>publishedAt</dt><dd>${escapeHtml(formatJst(publication.publishedAt))}</dd></div><div><dt>公開lineup revision</dt><dd>${escapeHtml(publication.publishedLineupRevision?.revision_id || publication.publishedLineupRevision?.id || "-")}</dd></div><div><dt>公開scoring revision</dt><dd>${escapeHtml(publication.publishedScoringRevision?.id || "-")}</dd></div></div>${noOpNotice}${rankingNoOpNotice}<h3>処理job</h3>${renderJobRows(game, ["score", "ranking_rebuild", "publish"])}</section>${renderPerfectScorePreview(game)}`;
    }

    function renderScheduleView(games) {
      const game = selectedGame(games);
      const details = selectedDetails();
      const schedule = details.schedule?.schedule;
      if (!game) return `<div class="view-heading"><div><h2>日程管理</h2><p>対象試合を選択してください。</p></div></div>`;
      const start = new Date(schedule?.startAt || game.startAt || "");
      const localStart = Number.isNaN(start.getTime()) ? "" : [
        `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`,
        `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`
      ].join("T");
      const status = String(game.gameStatus || "scheduled");
      const operation = typeof manualOperation === "function" ? manualOperation(game.internalGameId, "schedule") || {} : {};
      const scheduleOperation = schedule?.operation || {};
      const result = operation.message ? `<small class="manual-job-result ${operation.error ? "error" : "success"}">${escapeHtml(operation.message)}</small>` : "";
      const readOnly = String(game?.state?.state || "") === "published" || game?.workflowArtifactHealth?.publication?.published === true;
      const stoppedJobs = (scheduleOperation.stoppedJobs || []).map((item) => `${item.jobType}: ${item.count}`).join(", ") || "なし";
      const rankingReflection = scheduleOperation.rankingReflection || {};
      const rankingReflectionStatus = rankingReflection.latestStatus === "revoked"
        ? "取消済み"
        : rankingReflection.hasReflectedRevision ? "反映済み" : rankingReflection.latestStatus || "未反映";
      const rankingRevocationWarning = scheduleOperation.rankingRevocationConfirmationRequired
        ? `<p class="v3-operation-warning">ランキング反映済みの可能性があります。中止するとランキング・perfect・daily-best-nineから除外し、reflectionを取消します。対象スコープ: ${escapeHtml((rankingReflection.affectedScopes || []).join(", ") || "確認中")}</p>`
        : "";
      const rankingEligible = details.eligibility?.rankingEligibility?.rankingEligible === true
        ? "true"
        : details.eligibility?.rankingEligibility?.rankingEligible === false ? "false" : "-";
      const operationMeta = `<div class="detail-grid v3-cancellation-meta"><div><dt>gameStatus</dt><dd>${escapeHtml(status)}</dd></div><div><dt>rankingEligible</dt><dd>${rankingEligible}</dd></div><div><dt>ranking reflection</dt><dd>${escapeHtml(rankingReflectionStatus)}</dd></div><div><dt>中止/対象外理由</dt><dd>${escapeHtml(scheduleOperation.reason || "-")}</dd></div><div><dt>実行者 / 実行時刻</dt><dd>${escapeHtml(`${scheduleOperation.changedBy || "-"} / ${formatJst(scheduleOperation.changedAt)}`)}</dd></div><div><dt>停止job</dt><dd>${escapeHtml(stoppedJobs)}</dd></div><div><dt>public表示</dt><dd>${escapeHtml(scheduleOperation.publicNotice || "通常表示")}</dd></div><div><dt>次の安全な操作</dt><dd>${escapeHtml(scheduleOperation.nextSafeAction || "-")}</dd></div></div>`;
      const eligibility = details.eligibility?.rankingEligibility || {};
      const rankingControls = readOnly
        ? `<p class="muted">公開済み試合のランキング対象状態は読み取り専用です。</p>`
        : `<form class="v3-ranking-exclusion-form" data-v3-ranking-exclusion-form="${escapeHtml(game.internalGameId)}"><label>ランキング対象外理由 <input type="text" data-v3-ranking-exclusion-reason maxlength="240" placeholder="ランキング対象外の理由" required></label><label><input type="checkbox" data-v3-ranking-exclusion-confirm> ランキングから除外することを確認しました</label>${scheduleOperation.rankingRevocationConfirmationRequired ? `<label>ランキング取消確認 <input type="text" data-v3-ranking-exclusion-confirmation-text placeholder="ランキング取消と入力" data-v3-ranking-exclusion-confirmation-text></label>` : ""}<button type="button" data-v3-ranking-exclude="${escapeHtml(game.internalGameId)}" ${eligibility.rankingEligibilityStatus === "excluded" ? "disabled" : ""}>ランキング対象外にする</button></form>`;
      const controls = readOnly
        ? `<p class="muted">公開済み試合は読み取り専用です。日程変更は公開後訂正フローで扱います。</p>`
        : `<form class="v3-schedule-form" data-v3-schedule-form="${escapeHtml(game.internalGameId)}"><label>開始時刻 <input type="datetime-local" data-v3-schedule-start value="${escapeHtml(localStart)}" required></label><label>状態 <select data-v3-schedule-status><option value="scheduled" ${status === "scheduled" ? "selected" : ""}>scheduled（予定）</option><option value="cancelled" ${status === "cancelled" ? "selected" : ""}>cancelled（中止）</option><option value="postponed" ${status === "postponed" ? "selected" : ""}>postponed（延期）</option><option value="service_unavailable" ${status === "service_unavailable" ? "selected" : ""}>service_unavailable（対象外）</option></select></label><label>理由 <input type="text" data-v3-schedule-reason maxlength="240" placeholder="中止・対象外の理由" required></label><label><input type="checkbox" data-v3-schedule-confirm> 締切後の変更・中止を確認しました</label>${scheduleOperation.strongConfirmationRequired ? `<label>強い確認 <input type="text" data-v3-schedule-confirmation-text placeholder="中止と入力" data-v3-schedule-confirmation-text></label>` : ""}${scheduleOperation.rankingRevocationConfirmationRequired ? `<label>ランキング取消確認 <input type="text" data-v3-schedule-ranking-confirmation-text placeholder="ランキング取消と入力" data-v3-schedule-ranking-confirmation-text></label>` : ""}${rankingRevocationWarning}<div class="v3-schedule-actions"><button type="button" data-v3-schedule-save="${escapeHtml(game.internalGameId)}" ${operation.status === "loading" ? "disabled" : ""}>日程を更新</button>${scheduleOperation.canCancel && !["cancelled", "canceled", "postponed", "service_unavailable"].includes(status.toLowerCase()) ? `<button type="button" class="danger-button" data-v3-schedule-cancel="${escapeHtml(game.internalGameId)}" ${operation.status === "loading" ? "disabled" : ""}>この試合を中止にする</button>` : ""}</div></form>${result}`;
      return `${renderSelectedGameHeader(game, "日程管理", "日程とV3が算出した処理時刻を確認します。状態変更は理由・確認・監査付きです。")}<section class="v3-panel">${operationMeta}<div class="detail-grid"><div><dt>試合開始</dt><dd>${escapeHtml(formatJst(schedule?.startAt || game.startAt))}</dd></div><div><dt>予想締切</dt><dd>${escapeHtml(formatJst(schedule?.predictionDeadline))}</dd></div><div><dt>lineupPollingStart</dt><dd>${escapeHtml(formatJst(schedule?.lineupPollingStart))}</dd></div><div><dt>ランキング対象状態</dt><dd>${escapeHtml(eligibility.rankingEligibilityStatus || "未取得")}</dd></div></div>${controls}<h3>ランキング対象外化</h3>${rankingControls}<p class="muted">中止・対象外試合は未実行jobを停止し、保存済み予想と監査履歴は保持します。公開済み試合は変更できません。</p></section>`;
    }

    return Object.freeze({ renderGameSummary, renderTimeline, renderDashboard, renderGamesView, renderWorkflowView, renderLineupView, renderScoringView, renderScheduleView, renderManualControls });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3GameProgressRenderer = createAdminV3GameProgressRenderer;
})(window);
