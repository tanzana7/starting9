(function registerAdminV3RosterRenderer(global) {
  "use strict";

  function createAdminV3RosterRenderer({ stateLabel, escapeHtml, formatJst, formatTimelineTime, rosterDisplaySlots, rosterDisplayState, statusLabel }) {
    function timelineDetails(game) {
      const diagnostics = game?.rosterDiagnostics || {};
      const details = [];
      const generatedSlots = rosterDisplaySlots(game, diagnostics.generatedSlots);
      const dueSlots = rosterDisplaySlots(game, diagnostics.dueSlots);
      if (generatedSlots.length) details.push(`生成slot: ${formatTimelineTime(generatedSlots)}`);
      if (dueSlots.length) details.push(`期限到達: ${formatTimelineTime(dueSlots)}`);
      if (diagnostics.selectedDueSlot) details.push(`選択slot: ${formatJst(diagnostics.selectedDueSlot)}`);
      const rosterState = rosterDisplayState(game);
      if (diagnostics.actualJobExists) details.push(`job: ${statusLabel(diagnostics.jobStatus)}${diagnostics.existingJobId ? ` #${diagnostics.existingJobId}` : ""}`);
      else details.push(rosterState.status === "ok" ? "job未生成理由: snapshot取得済みのため追加job不要" : "job未生成");
      if (diagnostics.planningSkipped) details.push(`planning: skip (${diagnostics.skipReason || "理由不明"})`);
      if (diagnostics.insertAttempted) details.push(`INSERT: ${diagnostics.insertedRowCount || 0}件`);
      if (diagnostics.claimResult && diagnostics.claimResult !== "not_attempted") details.push(`claim: ${diagnostics.claimResult}`);
      if (diagnostics.rosterSnapshotExists) details.push(`snapshot: ${diagnostics.rosterSnapshotStatus || "captured"}`);
      if (diagnostics.isSnapshotStale) details.push(`snapshot要確認: ${diagnostics.staleReason || "ROSTER_SNAPSHOT_STALE"}`);
      if (diagnostics.noticeState) details.push(`公式確認: ${diagnostics.noticeState}`);
      if (Number.isFinite(Number(diagnostics.totalRosterChanges))) details.push(`変更数: ${diagnostics.totalRosterChanges}`);
      return details.join(" / ") || "本日の予定slot";
    }

    function renderSummary(game) {
      const rosterState = rosterDisplayState(game);
      const job = rosterState.job;
      const diagnostics = game?.rosterDiagnostics || {};
      const generatedSlots = rosterDisplaySlots(game, diagnostics.generatedSlots);
      const dueSlots = rosterDisplaySlots(game, diagnostics.dueSlots);
      const diagnosticRows = [
        ["判定", diagnostics.severity ? `${diagnostics.severity}${diagnostics.label ? ` / ${diagnostics.label}` : ""}` : ""],
        ["reason", diagnostics.reasonCode || ""],
        ["現在時刻（JST）", diagnostics.currentJstTime || ""],
        ["次回確認", formatJst(diagnostics.nextCheckAt)],
        ["生成slot", formatTimelineTime(generatedSlots)],
        ["期限到達slot", formatTimelineTime(dueSlots)],
        ["選択slot", formatJst(diagnostics.selectedDueSlot)],
        ["job実在", diagnostics.actualJobExists ? `${statusLabel(diagnostics.jobStatus)}${diagnostics.existingJobId ? ` (#${diagnostics.existingJobId})` : ""}` : rosterState.status === "ok" ? "未生成（snapshot取得済み）" : "未生成"],
        ["planning", diagnostics.planningSkipped ? `skip: ${diagnostics.skipReason || "-"}` : "継続"],
        ["INSERT", diagnostics.insertAttempted ? `${diagnostics.insertedRowCount || 0}件` : "未実行"],
        ["claim", diagnostics.claimResult || "未実行"],
        ["open roster job", diagnostics.openJobExists ? "あり" : "なし"],
        ["terminal roster job", diagnostics.terminalRosterJobExists ? "あり" : "なし"],
        ["snapshot", diagnostics.rosterSnapshotExists ? `${diagnostics.rosterSnapshotStatus || "captured"} / ${diagnostics.rosterSnapshotPlayerCount || 0}人` : "未取得"],
        ["snapshot取得時刻", formatJst(diagnostics.rosterSnapshotCapturedAt)],
        ["snapshot対象日", diagnostics.rosterSnapshotGameDate || ""],
        ["公示対象日", diagnostics.sourceDate || ""],
        ["freshness", diagnostics.isSnapshotStale ? `stale: ${diagnostics.staleReason || "ROSTER_SNAPSHOT_STALE"}` : diagnostics.isSnapshotFresh ? "fresh" : "未確認"],
        ["公式確認", diagnostics.noticeState || ""],
        ["登録/抹消", Number.isFinite(Number(diagnostics.totalRosterChanges)) ? `home +${diagnostics.registeredCountHome || 0}/-${diagnostics.deregisteredCountHome || 0}, away +${diagnostics.registeredCountAway || 0}/-${diagnostics.deregisteredCountAway || 0}` : ""],
        ["home 登録選手", (diagnostics.registeredPlayersHome || []).join(" / ")],
        ["home 抹消選手", (diagnostics.deregisteredPlayersHome || []).join(" / ")],
        ["away 登録選手", (diagnostics.registeredPlayersAway || []).join(" / ")],
        ["away 抹消選手", (diagnostics.deregisteredPlayersAway || []).join(" / ")],
        ["取得元", diagnostics.sourceUrl || ""],
        ["解析", diagnostics.parserResult || ""]
      ].filter(([, value]) => value && value !== "-");
      const successAt = job?.status === "completed" ? formatJst(job.completed_at || job.updated_at) : diagnostics.isSnapshotFresh ? formatJst(diagnostics.rosterSnapshotCapturedAt) : "-";
      const nextAt = job ? formatJst(job.next_retry_at || job.scheduled_at) : rosterState.status === "ok" ? "追加取得不要" : formatJst(rosterState.nextSlot) || "予定未定";
      const result = job ? `${job.failure_code || "V3 job"} / ${statusLabel(job.status)}` : rosterState.detail || "履歴なし";
      const attempts = job ? `${job.attempt_count || 0}/${job.max_attempts || 0}` : rosterState.status === "ok" ? "不要" : "-";
      return `<div class="roster-summary"><div><strong>最終成功</strong><span>${escapeHtml(successAt)}</span></div><div><strong>次回取得予定</strong><span>${escapeHtml(nextAt)}</span></div><div><strong>取得元・結果</strong><span>${escapeHtml(result)}</span></div><div><strong>試行</strong><span>${escapeHtml(attempts)}</span></div>${diagnosticRows.map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`).join("")}</div>`;
    }

    return Object.freeze({ timelineDetails, renderSummary });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3RosterRenderer = createAdminV3RosterRenderer;
})(window);
