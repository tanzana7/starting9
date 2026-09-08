(function registerAdminV3DiagnosticsRenderer(global) {
  "use strict";

  function createAdminV3DiagnosticsRenderer({
    state,
    escapeHtml,
    formatJst,
    listItems,
    filterGames,
    jstDate,
    gameDateForFilter,
    currentFailedJobs,
    currentRetryWaitJobs,
    normalizedPhaseState,
    rosterDisplayState,
    lineupDisplayState,
    nextActionText,
    renderSelectedGameHeader,
    renderJobRows,
    latestJob,
    jobTypes,
    statusLabel,
    identityStatusLabel
  }) {
    const statusLabels = Object.freeze({ ok: "OK", waiting: "WAITING", attention: "ATTENTION" });

    const normalizeDiagnosticJobType = (value) => {
      const normalized = String(value || "").trim();
      return normalized === "unknown" || normalized === "plan" || !normalized
        ? "legacy_or_unclassified"
        : normalized;
    };

    const normalizeDiagnosticCounts = (counts) => Object.entries(counts || {}).reduce((normalized, [jobType, count]) => {
      const key = normalizeDiagnosticJobType(jobType);
      normalized[key] = (normalized[key] || 0) + Number(count || 0);
      return normalized;
    }, {});

    const normalizeCronSummaryDetails = (details) => ({
      ...details,
      plannedByJobType: normalizeDiagnosticCounts(details?.plannedByJobType),
      createdByJobType: normalizeDiagnosticCounts(details?.createdByJobType),
      failedByJobType: normalizeDiagnosticCounts(details?.failedByJobType)
    });

    function statusClass(status) {
      return status === "attention" ? "attention" : status === "ok" ? "ok" : "waiting";
    }

    function statusBadge(status) {
      const normalized = statusClass(status);
      return `<span class="today-ops-status ${normalized}">${statusLabels[normalized]}</span>`;
    }

    function latestOpsJob(game, statuses = []) {
      const jobs = listItems(game?.jobs, "jobs").filter((job) => !statuses.length || statuses.includes(String(job.status || "")));
      return [...jobs].sort((left, right) => String(right.completed_at || right.updated_at || right.scheduled_at || "").localeCompare(String(left.completed_at || left.updated_at || left.scheduled_at || "")))[0] || null;
    }

    function stepStatus(game, step, now = new Date(), options = {}) {
      const phaseByStep = { probable: "probable_starter", roster: "roster", lineup: "lineup_fetch", scoring: "score", ranking: "ranking", publication: "publish" };
      const gameState = String(game?.state?.state || "scheduled");
      const canonical = game?.canonicalArtifacts?.aggregate || null;
      if (options.semiAuto && step === "roster") {
        return game?.rosterDiagnostics?.rosterSnapshotExists ? "ok" : "waiting";
      }
      if (options.semiAuto && step === "lineup") {
        if (canonical) return canonical.lineupReady ? "ok" : canonical.needsAttention ? "attention" : "waiting";
        return ["lineup_ready", "scored", "ranked", "published"].includes(gameState) ? "ok" : "waiting";
      }
      if (canonical && step === "scoring") return canonical.scoringReady ? "ok" : canonical.needsAttention ? "attention" : "waiting";
      if (canonical && step === "ranking") return canonical.rankingReady ? "ok" : canonical.needsAttention ? "attention" : "waiting";
      if (canonical && step === "publication") return canonical.publicationReady ? "ok" : canonical.needsAttention ? "attention" : "waiting";
      const normalized = normalizedPhaseState(game, phaseByStep[step]);
      if (normalized) return normalized.status;
      const schedule = game?.schedule || {};
      const jobs = listItems(game?.jobs, "jobs");
      const stepJobTypes = {
        probable: ["probable_starter_fetch"],
        roster: ["roster_fetch"],
        lineup: ["lineup_fetch", "lineup_finalize"],
        scoring: ["score", "scoring"],
        ranking: ["ranking_rebuild"],
        publication: ["publish", "publication"]
      };
      const types = step === "all" ? [] : (stepJobTypes[step] || []);
      const hasFailed = currentFailedJobs(game, types).length > 0 || (step === "all" || types.length > 0) && jobs.some((job) => String(job.status || "") === "manual_action_required" && (step === "all" || types.includes(String(job.job_type || ""))));
      if (hasFailed) return "attention";
      if (step === "probable") return String(game?.probableStarter?.dataStatus || game?.probableStarter?.status || "unannounced") === "announced" ? "ok" : "waiting";
      if (step === "roster") return rosterDisplayState(game).status;
      if (step === "lineup") return lineupDisplayState(game, now).status;
      if (step === "scoring") return ["scored", "ranked", "published"].includes(gameState) ? "ok" : "waiting";
      if (step === "ranking") return ["ranked", "published"].includes(gameState) ? "ok" : "waiting";
      if (step === "publication") {
        if (gameState === "published" || game?.publicationStatus === "published") return "ok";
        const publicationAt = new Date(schedule.publicationAt || "").getTime();
        return Number.isFinite(publicationAt) && publicationAt <= now.getTime() ? "attention" : "waiting";
      }
      return "waiting";
    }

    function buildTodayOpsModel(payload, games, now = new Date()) {
      const gameItems = listItems(games, "games");
      const todayGames = filterGames(gameItems, "today");
      const todayJst = jstDate(now);
      const activeFutureGames = gameItems.filter((game) => gameDateForFilter(game) > todayJst && Number(game.isActive ?? 1) !== 0 && !game.deletedAt && (String(game.homeTeam || game.home_team || "").toLowerCase() === "fighters" || String(game.awayTeam || game.away_team || "").toLowerCase() === "fighters"));
      const reportedFutureGames = payload?.todayOps?.futureGamesCount;
      const hasReportedFutureGames = typeof reportedFutureGames === "number" && Number.isFinite(reportedFutureGames);
      const futureGames = hasReportedFutureGames ? reportedFutureGames : activeFutureGames.length;
      const futureGamesMinimum = Number(payload?.todayOps?.futureGamesMinimum) || 3;
      const futureScheduleSync = payload?.todayOps?.futureScheduleSync || null;
      const syncAfter = Number(futureScheduleSync?.futureGamesAfter);
      const syncTarget = Number(futureScheduleSync?.futureGamesTarget) || futureGamesMinimum;
      const futureScheduleSyncAttention = Boolean(futureScheduleSync?.errorCode || (Number.isFinite(syncAfter) && syncAfter < syncTarget) || (futureScheduleSync?.syncNeeded && Number.isFinite(syncAfter) && syncAfter < syncTarget && Number(futureScheduleSync?.gamesInserted || 0) === 0 && Number(futureScheduleSync?.gamesUpdated || 0) === 0));
      const v4SemiAuto = payload?.automationMode?.isV4SemiAuto === true;
      const todayJobs = todayGames.flatMap((game) => listItems(game?.jobs, "jobs"));
      const historicalJobs = gameItems.filter((game) => !todayGames.includes(game)).flatMap((game) => listItems(game?.jobs, "jobs"));
      const latestCompleted = latestOpsJob({ jobs: todayJobs }, ["completed"]);
      const latestFailed = latestOpsJob({ jobs: currentFailedJobs({ jobs: todayJobs }) }, ["failed"]);
      const cronLastRunAt = payload?.todayOps?.cronLastRunAt || null;
      const cronIntervalMinutes = Number(payload?.todayOps?.cronIntervalMinutes) || 1;
      const cronGraceMinutes = Number.isFinite(Number(payload?.todayOps?.cronGraceMinutes)) ? Number(payload.todayOps.cronGraceMinutes) : 2;
      const cronIntervalMs = Number.isFinite(cronIntervalMinutes) && cronIntervalMinutes > 0 ? cronIntervalMinutes * 60 * 1000 : 0;
      const cronGraceMs = Number.isFinite(cronGraceMinutes) && cronGraceMinutes >= 0 ? cronGraceMinutes * 60 * 1000 : 0;
      const cronLastRunMs = cronLastRunAt ? new Date(cronLastRunAt).getTime() : Number.NaN;
      const nextCronEstimateMs = Number.isFinite(cronLastRunMs) && cronIntervalMs ? cronLastRunMs + cronIntervalMs : Number.NaN;
      const nextCronEstimate = Number.isFinite(nextCronEstimateMs) ? new Date(nextCronEstimateMs).toISOString() : null;
      const cronStale = !Number.isFinite(cronLastRunMs) || !Number.isFinite(nextCronEstimateMs) || now.getTime() > nextCronEstimateMs + cronGraceMs;
      const futureShortage = futureGames < futureGamesMinimum;
      const gameModels = todayGames.map((game) => {
        const gameState = String(game?.state?.state || "scheduled");
        const canonical = game?.canonicalArtifacts?.aggregate || null;
        const publicationAt = new Date(game?.schedule?.publicationAt || "").getTime();
        const published = gameState === "published" || game?.publicationStatus === "published";
        const failedJob = currentFailedJobs(game)[0] || null;
        const manualAction = gameState === "manual_action_required";
        const lineupOverdue = !v4SemiAuto && !["lineup_ready", "scored", "ranked", "published"].includes(gameState) && Number.isFinite(new Date(game?.startAt || "").getTime()) && new Date(game.startAt).getTime() <= now.getTime();
        const publicationOverdue = !published && Number.isFinite(publicationAt) && publicationAt <= now.getTime();
        const attention = Boolean(failedJob || manualAction || lineupOverdue || publicationOverdue || canonical?.needsAttention === true);
        const lineupStatus = v4SemiAuto
          ? { status: canonical ? (canonical.lineupReady ? "ok" : canonical.needsAttention ? "attention" : "waiting") : (["lineup_ready", "scored", "ranked", "published"].includes(gameState) ? "ok" : "waiting"), detail: canonical?.lineupReady ? "正式スタメン確定済み" : "V4: 管理者が手動入力・正式確定" }
          : lineupDisplayState(game, now);
        const rosterStatus = v4SemiAuto && !game?.rosterDiagnostics?.rosterSnapshotExists
          ? { status: "waiting", detail: "V4: ロースター自動取得OFF（手動管理はP1）" }
          : rosterDisplayState(game);
        return {
          game,
          state: gameState,
          attention,
          status: attention ? "attention" : listItems(game?.jobs, "jobs").some((job) => ["pending", "claimed", "retry_wait"].includes(job.status)) ? "waiting" : "ok",
          nextAction: nextActionText(game),
          steps: {
            probable: stepStatus(game, "probable", now),
            roster: stepStatus(game, "roster", now, { semiAuto: v4SemiAuto }),
            rosterDetail: rosterStatus.detail,
            lineup: lineupStatus.status,
            lineupDetail: lineupStatus.detail,
            scoring: stepStatus(game, "scoring", now),
            ranking: stepStatus(game, "ranking", now),
            publication: stepStatus(game, "publication", now)
          }
        };
      });
      const attention = gameModels.some((model) => model.attention) || futureShortage || cronStale || futureScheduleSyncAttention;
      return {
        todayGames,
        gameModels,
        futureGames,
        futureGamesMinimum,
        futureShortage,
        futureScheduleSync,
        futureScheduleSyncAttention,
        futureScheduleSyncStatus: futureScheduleSyncAttention ? "attention" : futureScheduleSync ? "ok" : "waiting",
        cronLastRunAt,
        cronStale,
        cronSchedule: payload?.todayOps?.cronSchedule || "* * * * *",
        cronDescription: payload?.todayOps?.cronDescription || "毎分",
        nextCronEstimate,
        cronStatus: cronStale ? "attention" : "ok",
        overallStatus: attention ? "attention" : gameModels.some((model) => model.status === "waiting") ? "waiting" : "ok",
        openJobs: todayJobs.filter((job) => ["pending", "claimed", "retry_wait"].includes(job.status)).length,
        retryWaitJobs: todayJobs.filter((job) => job.status === "retry_wait").length,
        failedJobs: currentFailedJobs({ jobs: todayJobs }).length,
        todayFailedJobs: currentFailedJobs({ jobs: todayJobs }).length,
        historicalFailedJobs: currentFailedJobs({ jobs: historicalJobs }).length,
        historicalRetryWaitJobs: historicalJobs.filter((job) => job.status === "retry_wait").length,
        latestCompleted,
        latestFailed
      };
    }

    function renderOpsJob(job) {
      if (!job) return "未実行";
      return `${escapeHtml(job.jobLabel || job.job_type)} / ${escapeHtml(formatJst(job.completed_at || job.updated_at || job.scheduled_at))}`;
    }

    function renderScheduleSync(model) {
      const sync = model.futureScheduleSync;
      if (!sync) return `<div class="today-ops-diagnostics"><div class="today-ops-diagnostics-heading"><strong>未来試合同期診断</strong>${statusBadge("waiting")}</div><p class="muted">まだ同期監査がありません。</p></div>`;
      const before = sync.futureGamesBefore ?? "-";
      const after = sync.futureGamesAfter ?? "-";
      const target = sync.futureGamesTarget ?? model.futureGamesMinimum;
      const range = sync.fetchRangeStart || sync.fetchRangeEnd ? `${sync.fetchRangeStart || "-"} 〜 ${sync.fetchRangeEnd || "-"}` : "-";
      const lastSync = sync.lastScheduleSyncAt ? formatJst(sync.lastScheduleSyncAt) : "-";
      return `<div class="today-ops-diagnostics"><div class="today-ops-diagnostics-heading"><strong>未来試合同期診断</strong>${statusBadge(model.futureScheduleSyncStatus)}</div><div class="today-ops-diagnostic-grid"><span>未来試合</span><strong>${escapeHtml(before)} → ${escapeHtml(after)} / target ${escapeHtml(target)}</strong><span>syncNeeded</span><strong>${escapeHtml(sync.syncNeeded === true ? "true" : sync.syncNeeded === false ? "false" : "-")}</strong><span>fetchRange</span><strong>${escapeHtml(range)}</strong><span>expandedTo30Days</span><strong>${escapeHtml(sync.expandedTo30Days === true ? "true" : "false")}</strong><span>取得 / 追加 / 更新</span><strong>${escapeHtml(`${sync.gamesFetched ?? 0} / ${sync.gamesInserted ?? 0} / ${sync.gamesUpdated ?? 0}`)}</strong><span>skipReason</span><strong>${escapeHtml(sync.skipReason || "-")}</strong><span>errorCode</span><strong>${escapeHtml(sync.errorCode || "-")}</strong><span>lastScheduleSyncAt</span><strong>${escapeHtml(lastSync)}</strong></div></div>`;
    }

    function renderStep(label, status, detail = "") {
      return `<div class="today-ops-step"><span>${escapeHtml(label)}</span>${statusBadge(status)}${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>`;
    }

    function renderTodayOps(payload, games) {
      const model = buildTodayOpsModel(payload, games);
      const cronLastDetail = model.cronLastRunAt ? formatJst(model.cronLastRunAt) : "記録なし";
      const nextCronDetail = model.nextCronEstimate ? formatJst(model.nextCronEstimate) : "不明";
      const gameCards = model.gameModels.length
        ? model.gameModels.map(({ game, state, status, nextAction, steps }) => `<article class="today-ops-game"><div class="today-ops-game-heading"><strong>${escapeHtml(gameDateForFilter(game))} ${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)}</strong>${statusBadge(status)}</div><div class="today-ops-game-meta"><span>state: ${escapeHtml(state)}</span><span>次: ${escapeHtml(nextAction)}</span></div><div class="today-ops-steps">${renderStep("予告先発", steps.probable)}${renderStep("ロースター", steps.roster, steps.rosterDetail)}${renderStep("スタメン", steps.lineup, steps.lineupDetail)}${renderStep("採点", steps.scoring)}${renderStep("ランキング", steps.ranking)}${renderStep("公開", steps.publication)}</div></article>`).join("")
        : "<p class=muted>本日の対象試合はありません。</p>";
      const historyNotice = model.historicalFailedJobs || model.historicalRetryWaitJobs
        ? `過去試合の残留: failed ${model.historicalFailedJobs} / retry_wait ${model.historicalRetryWaitJobs}（参考。今日の判定とは分離）`
        : "過去試合の残留jobはありません";
      const modeNotice = payload?.automationMode?.isV4SemiAuto
        ? "V4: 予告先発は自動、ロースター・スタメン取得は停止中。スタメン9人を管理者が確定後、締切・採点・ランキング・公開をCronが継続します。"
        : "本日のV3自動処理を試合単位で確認します。";
      return `<section class="today-ops-panel" aria-labelledby="todayOpsHeading"><div class="today-ops-heading"><div><h3 id="todayOpsHeading">Today Ops / Automation Health</h3><p>${escapeHtml(modeNotice)}</p></div>${statusBadge(model.overallStatus)}</div><div class="today-ops-metrics"><div><strong>${escapeHtml(model.todayGames.length)}</strong><span>今日の試合</span></div><div><strong>${escapeHtml(model.openJobs)}</strong><span>今日のopen job</span></div><div><strong>${escapeHtml(model.retryWaitJobs)}</strong><span>今日のretry_wait</span></div><div><strong>${escapeHtml(model.todayFailedJobs)}</strong><span>今日のfailed</span></div><div><strong>${escapeHtml(model.historicalFailedJobs)}</strong><span>過去のfailed（参考）</span></div><div><strong>${escapeHtml(model.futureGames)}</strong><span>未来試合登録数</span></div><div><strong>${escapeHtml(model.cronSchedule)}</strong><span>Cron設定${model.cronDescription ? `（${escapeHtml(model.cronDescription)}）` : ""}</span></div><div><strong>${escapeHtml(cronLastDetail)}</strong><span>Cron最終監査</span></div><div><strong>${escapeHtml(nextCronDetail)}</strong><span>次Cron目安</span></div><div><strong>${escapeHtml(model.cronStatus === "attention" ? "ATTENTION" : "直近")}</strong><span>Cron状態</span></div></div><div class="today-ops-notices"><span>最後に完了: ${renderOpsJob(model.latestCompleted)}</span><span>最後に失敗: ${renderOpsJob(model.latestFailed)}</span><span>${escapeHtml(historyNotice)}</span><span>${model.futureShortage ? "未来試合が3試合未満" : "未来試合数は充足"}</span><span>${model.cronStale ? "Cron監査が古い、または未記録" : "Cron監査は直近"}</span></div>${renderScheduleSync(model)}<div class="today-ops-games">${gameCards}</div></section>`;
    }

    function renderGameDiagnostics(game) {
      if (!game) return "<div class=today-empty>対象試合を選択してください。</div>";
      const npbGameCode = String(game.npbGameCode || "");
      const identityJob = latestJob(game, "npb_identity_resolve");
      const jobs = renderJobRows(game, jobTypes);
      return `<article class="game-card"><div class="game-heading"><h3>${escapeHtml(gameDateForFilter(game))} ${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)}</h3><code>${escapeHtml(game.internalGameId)}</code></div><div class="game-meta"><span>開始 ${escapeHtml(formatJst(game.startAt))} JST</span><span>DB home: ${escapeHtml(game.homeTeam)}</span><span>DB away: ${escapeHtml(game.awayTeam)}</span><span class="npb-identity-status">NPB識別情報: ${escapeHtml(identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState))}</span><span>コード ${escapeHtml(npbGameCode || "未登録")}</span><span class="state">state: ${escapeHtml(game.state?.state || "scheduled")}</span></div><div class="npb-identity-details"><span>解決元: ${escapeHtml(game.npbIdentitySource || "-")}</span><span>解決時刻: ${escapeHtml(formatJst(game.npbIdentityResolvedAt))}</span><span>URL: ${game.npbGameUrl ? `<a href="${escapeHtml(game.npbGameUrl)}" target="_blank" rel="noreferrer">${escapeHtml(game.npbGameUrl)}</a>` : "-"}</span></div><div class="npb-identity-auto-job"><strong>NPB自動解決job</strong><span>次回予定: ${escapeHtml(identityJob ? formatJst(identityJob.status === "retry_wait" ? identityJob.next_retry_at : identityJob.scheduled_at) : "未作成")}</span><span>最終実行: ${escapeHtml(formatJst(identityJob?.completed_at || identityJob?.updated_at))}</span><span>次回retry: ${escapeHtml(formatJst(identityJob?.next_retry_at))}</span><span>結果: ${escapeHtml(identityJob?.failure_code || identityJob?.status || "-")}</span><span>試行: ${escapeHtml(identityJob ? `${identityJob.attempt_count || 0}/${identityJob.max_attempts || 0}` : "-")}</span></div><div class="job-list">${jobs}</div></article>`;
    }

    function renderAutomationLogs() {
      const logs = state.automationLogs;
      const filters = state.automationLogFilters;
      const input = (key, label, placeholder = "") => `<label>${escapeHtml(label)}<input type="text" value="${escapeHtml(filters[key])}" placeholder="${escapeHtml(placeholder)}" data-v3-automation-log-filter="${escapeHtml(key)}"></label>`;
      if (!logs) return `<section class="v3-panel automation-logs-panel"><div class="view-heading"><div><h3>V3 Cron監査</h3><p>runId、planner、executor、状態遷移を次回Cronから確認できます。</p></div></div><p class="muted">監査ログを読み込んでいます。</p></section>`;
      if (logs.error) return `<section class="v3-panel automation-logs-panel"><div class="view-heading"><div><h3>V3 Cron監査</h3><p>監査APIの失敗は管理者セッションを終了させません。</p></div></div><p class="attention-text">${escapeHtml(logs.error)}</p></section>`;
      const summary = logs.latestCronSummary;
      const summaryDetails = normalizeCronSummaryDetails(summary?.details || {});
      const counts = summaryDetails.counts || {};
      const gameRuns = listItems(logs.gameRuns, "gameRuns");
      const jobTimeline = listItems(logs.jobTimeline, "jobTimeline");
      const summaryMarkup = summary
        ? `<div class="automation-log-summary"><strong>最新Cron</strong><span>${escapeHtml(summary.occurredAt || "-")}</span><span>runId: <code>${escapeHtml(summaryDetails.runId || "-")}</code></span><span>status: ${escapeHtml(summaryDetails.status || "-")}</span><span>games ${escapeHtml(counts.games ?? 0)} / created ${escapeHtml(counts.created ?? 0)} / claimed ${escapeHtml(counts.claimed ?? 0)} / processed ${escapeHtml(counts.processed ?? 0)} / failed ${escapeHtml(counts.failed ?? 0)}</span><pre>${escapeHtml(JSON.stringify(summaryDetails, null, 2))}</pre></div>`
        : `<p class="muted">Cronサマリーはまだありません。次回のV3 Cron実行後に表示されます。</p>`;
      const runMarkup = gameRuns.slice(0, 20).map((run) => `<div class="automation-log-run"><strong>${escapeHtml(run.latestOccurredAt || "-")}</strong><code>${escapeHtml(run.runId)}</code><span>events ${escapeHtml(run.events)} / failures ${escapeHtml(run.failureCount)} / games ${escapeHtml(listItems(run.internalGameIds, "internalGameIds").length)}</span></div>`).join("") || `<p class="muted">run単位の監査はありません。</p>`;
      const timelineMarkup = jobTimeline.slice(0, 100).map((row) => {
        const detail = row.details || {};
        return `<div class="automation-log-row"><time>${escapeHtml(row.occurredAt || "-")}</time><span>${escapeHtml(row.eventType || "job")}</span><code>${escapeHtml(row.jobType || "-")}</code><span>${escapeHtml(detail.status || row.stateAfter || "-")}</span><span>${escapeHtml(row.failureCode || detail.reasonCode || "-")}</span><small>${escapeHtml(row.internalGameId || "-")} / run ${escapeHtml(detail.runId || "-")}</small><pre>${escapeHtml(JSON.stringify(detail, null, 2))}</pre></div>`;
      }).join("") || `<p class="muted">条件に一致するjob監査はありません。</p>`;
      return `<section class="v3-panel automation-logs-panel"><div class="view-heading"><div><h3>V3 Cron監査</h3><p>planner、executor、状態遷移、run単位の集計を既存V3監査から表示します。</p></div><button type="button" data-v3-automation-log-refresh>監査を更新</button></div><div class="automation-log-filters">${input("runId", "runId")}${input("internalGameId", "internalGameId")}${input("jobType", "jobType", "lineup_fetch")}${input("status", "status", "completed")}${input("reasonCode", "reasonCode")}${input("failureCode", "failureCode")}<button type="button" data-v3-automation-log-refresh>絞り込む</button></div>${summaryMarkup}<details open><summary>game run summaries（${escapeHtml(gameRuns.length)}）</summary><div class="automation-log-runs">${runMarkup}</div></details><details open><summary>job timeline（${escapeHtml(jobTimeline.length)}）</summary><div class="automation-log-timeline">${timelineMarkup}</div></details></section>`;
    }

    function renderView(game) {
      return `${renderSelectedGameHeader(game, "診断・監査", "UUID、job、lease、failure codeなどの技術情報をこの画面へ集約しています。")}${renderAutomationLogs()}<section class="diagnostics-list">${renderGameDiagnostics(game)}</section>`;
    }

    return Object.freeze({ buildTodayOpsModel, renderTodayOps, renderGameDiagnostics, renderAutomationLogs, renderView });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3DiagnosticsRenderer = createAdminV3DiagnosticsRenderer;
})(window);
