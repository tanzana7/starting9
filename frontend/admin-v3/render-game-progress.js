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
    normalizeRevisionList,
    selectedDetails,
    selectedGame,
    jstDate,
    jobTypes,
    jobLabels
  }) {
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
      const time = scheduledAt || (job ? (status === "retry_wait" ? job.next_retry_at : job.scheduled_at) : "");
      const failure = job?.failure_code ? ` / ${job.failure_code}` : "";
      return `<article class="timeline-step ${klass}"><span class="status-badge ${klass === "complete" ? "ok" : klass === "retry" ? "retry" : klass === "failed" || klass === "action" ? "action" : klass === "excluded" ? "excluded" : "wait"}">${escapeHtml(label)}</span><h4>${escapeHtml(name)}</h4><p class="step-time">${escapeHtml(formatTimelineTime(time) || (detail && !failure ? detail : "予定未定"))}</p><p>${escapeHtml(detail || failure || (job ? `試行 ${job.attempt_count || 0}/${job.max_attempts || 0}` : ""))}</p></article>`;
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
      const lineupState = lineupDisplayState(game);
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

    function renderDashboard(payload, games) {
      const allGames = listItems(payload?.games, "games");
      const todayGames = filterGames(allGames, "today");
      const allJobs = allGames.flatMap((game) => listItems(game?.jobs, "jobs"));
      const attention = allGames.filter(gameHasAttention).length;
      const failed = allJobs.filter((job) => job.status === "failed").length;
      const retry = allJobs.filter((job) => job.status === "retry_wait").length;
      const pendingIdentity = allGames.filter((game) => ["pending", "retry_wait"].includes(game.npbIdentityState)).length;
      const completedToday = todayGames.reduce((count, game) => count + listItems(game?.jobs, "jobs").filter((job) => job.status === "completed" && String(job.completed_at || "").slice(0, 10) === jstDate()).length, 0);
      const publicationWait = allGames.filter((game) => game.state?.state === "ranked").length;
      const cards = todayGames.length ? todayGames.map((game) => renderGameSummary(game)).join("") : `<div class="today-empty">本日の試合はありません</div>`;
      return `<div class="view-heading"><div><h2>ダッシュボード</h2><p>本日の試合と要対応項目を最初に確認できます。</p></div></div>${renderTodayOps(payload, games)}<section class="today-card"><h3>本日の試合</h3>${cards}</section><section class="summary-grid">${renderSummaryCard("要対応", attention, attention ? "attention" : "ok")}${renderSummaryCard("失敗job", failed, failed ? "error" : "ok")}${renderSummaryCard("retry_wait", retry, retry ? "attention" : "ok")}${renderSummaryCard("掲載待ち", pendingIdentity, pendingIdentity ? "attention" : "ok")}${renderSummaryCard("本日の完了job", completedToday)}${renderSummaryCard("公開待ち", publicationWait, publicationWait ? "attention" : "ok")}</section><section class="v3-panel"><div class="view-heading"><div><h3>今日の自動処理</h3><p>詳細は試合進行メニューから確認できます。</p></div></div>${todayGames.length ? todayGames.map((game) => `<div class="compact-meta"><strong>${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)}</strong><span>次: ${escapeHtml(nextActionText(game))}</span><span>${escapeHtml(gameHasAttention(game) ? "要対応" : "正常")}</span></div>`).join("") : "<span class=muted>今日の処理履歴はありません。</span>"}</section>`;
    }

    function renderGamesView(games) {
      const rows = games.map((game) => `<tr><td>${escapeHtml(gameDateForFilter(game))}</td><td>${escapeHtml(formatJst(game.startAt, false))}</td><td>${escapeHtml(game.homeTeam)}</td><td>${escapeHtml(game.awayTeam)}</td><td>${escapeHtml(game.state?.state || "scheduled")}</td><td>${escapeHtml(identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState))}</td><td>${escapeHtml(nextActionText(game))}</td><td>${gameHasAttention(game) ? "<span class=attention-badge>要対応</span>" : "<span class=\"status-badge ok\">正常</span>"}</td><td><button type="button" data-v3-select-game="${escapeHtml(game.internalGameId)}">詳細</button></td></tr>`).join("");
      return `<div class="view-heading"><div><h2>試合一覧</h2><p>日付、進行状態、次の処理を比較します。</p></div></div><div class="games-table-wrap"><table class="games-table"><thead><tr><th>日付</th><th>開始</th><th>home</th><th>away</th><th>state</th><th>NPB</th><th>次の処理</th><th>対応</th><th></th></tr></thead><tbody>${rows || "<tr><td colspan=9>対象試合はありません。</td></tr>"}</tbody></table></div>`;
    }

    function renderWorkflowView(game) {
      if (!game) return renderSelectedGameHeader(null, "試合進行");
      const identity = npbIdentityDisplay(game);
      return `${renderSelectedGameHeader(game, "試合進行", "V3 jobの状態と監査結果を試合単位で確認します。自動処理はCronが実行します。")}<section class="v3-panel"><div class="compact-meta"><span>現在: <strong>${escapeHtml(game.state?.state || "scheduled")}</strong></span><span>次の処理: <strong>${escapeHtml(nextActionText(game))}</strong></span><span>NPB識別job: <strong>${escapeHtml(identity.jobStatus)}</strong></span><span>NPB game code: <strong>${escapeHtml(identity.code)}</strong></span></div>${renderTimeline(game)}<details class="roster-details"><summary>ロースター取得の詳細</summary>${renderRosterSummary(game)}</details><h3>job履歴</h3>${renderJobRows(game, jobTypes)}</section>`;
    }

    function renderLineupView(game) {
      if (!game) return renderSelectedGameHeader(null, "スタメン");
      const details = selectedDetails();
      const current = details.lineup?.currentRevision;
      const revisions = normalizeRevisionList(details.revisions);
      const revisionMarkup = revisions.items.map((revision) => `<div class="revision-row"><span><strong>${escapeHtml(revision.revisionId)}</strong> / ${escapeHtml(revision.source)} / ${escapeHtml(revision.reason || "-")}</span><span>${revision.isFinal ? "final" : "candidate"} ${escapeHtml(formatJst(revision.createdAt))}</span></div>`).join("") || "<span class=muted>revision履歴はありません。</span>";
      const revisionWarning = revisions.unexpected ? `<p class="v3-operation-result"><code>REVISION_SHAPE_UNEXPECTED</code> revision履歴の形式を確認できませんでした。</p>` : "";
      return `${renderSelectedGameHeader(game, "スタメン", "V3が取得・確定したスタメンrevisionを確認します。")}<section class="v3-panel"><div class="detail-grid"><div><dt>最新revision</dt><dd>${escapeHtml(current?.revisionId || "未作成")}</dd></div><div><dt>正式確定</dt><dd>${escapeHtml(details.lineup?.lineupStatus || "待機")}</dd></div><div><dt>source / finalizedAt</dt><dd>${escapeHtml(`${current?.source || "-"} / ${formatJst(details.lineup?.finalizedAt)}`)}</dd></div></div><h3>revision履歴</h3>${revisionWarning}<div class="revision-list">${revisionMarkup}</div><h3>取得・確定job</h3>${renderJobRows(game, ["lineup_fetch", "lineup_finalize"])}</section>`;
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
      return `${renderSelectedGameHeader(game, "日程管理", "日程とV3が算出した処理時刻を確認します。")}<section class="v3-panel"><div class="detail-grid"><div><dt>試合開始</dt><dd>${escapeHtml(formatJst(schedule?.startAt || game.startAt))}</dd></div><div><dt>予想締切</dt><dd>${escapeHtml(formatJst(schedule?.predictionDeadline))}</dd></div><div><dt>lineupPollingStart</dt><dd>${escapeHtml(formatJst(schedule?.lineupPollingStart))}</dd></div><div><dt>ランキング対象状態</dt><dd>${escapeHtml(details.eligibility?.rankingEligibility?.rankingEligibilityStatus || "未取得")}</dd></div></div><p class="muted">日程とランキング対象状態は自動処理の監査情報として表示しています。</p></section>`;
    }

    return Object.freeze({ renderGameSummary, renderTimeline, renderDashboard, renderGamesView, renderWorkflowView, renderLineupView, renderScoringView, renderScheduleView });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3GameProgressRenderer = createAdminV3GameProgressRenderer;
})(window);
