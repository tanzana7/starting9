(function registerAdminV3RankingResetRenderer(global) {
  "use strict";

  function createAdminV3RankingResetRenderer({ state, escapeHtml, formatJst }) {
    function statusLabel(game) {
      const status = String(game.gameStatus || "scheduled").toLowerCase();
      if (["cancelled", "canceled"].includes(status)) return "中止";
      if (status === "service_unavailable") return "サービス対象外";
      if (status === "postponed") return "延期";
      if (game.resultsPublished) return "公開済み";
      if (game.ranked) return "ランキング反映済み";
      if (game.scored) return "採点済み";
      return status || "予定";
    }

    function eligibilityLabel(game) {
      if (game.rankingStatusLabel) return game.rankingStatusLabel;
      if (game.rankingExcluded) return "手動で対象外";
      if (game.rankingEligible === true && (game.scored || game.ranked)) return "対象";
      return "ランキング処理前";
    }

    function matchesFilter(game, filter) {
      if (filter === "cancelled") return ["cancelled", "canceled", "service_unavailable", "postponed"].includes(String(game.gameStatus || "").toLowerCase());
      if (filter === "published") return game.resultsPublished === true;
      if (filter === "scored") return game.scored === true;
      if (filter === "rankingExcluded") return game.rankingExcluded === true;
      return true;
    }

    function matchesSearch(game, search) {
      if (!search) return true;
      return [game.gameDate, game.homeTeam, game.awayTeam, game.npbGameCode, game.internalGameId]
        .some((value) => String(value || "").toLowerCase().includes(search));
    }

    function renderGameAction(game) {
      if (game.publishedReadOnly) return `<span class="ranking-game-action muted">公開済み・読み取り専用</span>`;
      if (game.rankingExcluded) return `<span class="ranking-game-action success">${escapeHtml(game.rankingActionLabel || "ランキング対象外済み")}</span>`;
      if (!game.canExclude) return `<span class="ranking-game-action muted">${escapeHtml(game.actionUnavailableReason || "操作対象外")}</span>`;
      return `<form class="v3-ranking-exclusion-form ranking-game-exclusion-form" data-v3-ranking-exclusion-form="${escapeHtml(game.internalGameId)}" data-v3-ranking-revocation-required="${game.rankingRevocationConfirmationRequired ? "true" : "false"}"><label>対象外理由<input type="text" data-v3-ranking-exclusion-reason maxlength="240" placeholder="ランキング対象外の理由" required></label><label class="ranking-exclusion-confirm"><input type="checkbox" data-v3-ranking-exclusion-confirm> 対象外にすることを確認</label>${game.rankingRevocationConfirmationRequired ? `<label>取消確認<input type="text" data-v3-ranking-exclusion-confirmation-text placeholder="ランキング取消と入力" data-v3-ranking-exclusion-confirmation-text></label>` : ""}<button type="button" data-v3-ranking-exclude="${escapeHtml(game.internalGameId)}">ランキング対象外にする</button></form>`;
    }

    function renderGame(game) {
      const timestamp = formatJst(game.startAt || game.gameDate);
      const reflection = game.rankingReflectionStatus === "revoked"
        ? "反映取消済み"
        : game.rankingReflectionStatus === "reflected" || game.rankingReflection?.hasReflectedRevision && !game.rankingExcluded
          ? "反映済み"
          : "未反映";
      return `<article class="ranking-game-picker-row"><div class="ranking-game-picker-main"><strong>${escapeHtml(timestamp)} JST</strong><strong>${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)}</strong><span>internalGameId: <code>${escapeHtml(game.internalGameId)}</code></span><span>NPB: ${escapeHtml(game.npbGameCode || "未解決")}</span></div><div class="ranking-game-picker-meta"><span>状態: <strong>${escapeHtml(statusLabel(game))}</strong></span><span>workflow: ${escapeHtml(game.workflowState || "-")}</span><span>採点: ${game.scored ? "完了" : "未完了"}</span><span>ranking: ${escapeHtml(eligibilityLabel(game))} / ${escapeHtml(reflection)}</span><span>更新: ${escapeHtml(formatJst(game.lastUpdatedAt))}</span></div><div class="ranking-game-picker-action">${renderGameAction(game)}</div></article>`;
    }

    function render() {
      const reset = state.rankingReset;
      const preview = reset.preview;
      const markerMarkup = reset.markers.length
        ? reset.markers.map((marker) => `<div class="ranking-reset-marker"><strong>${escapeHtml(marker.period_type)} ${escapeHtml(marker.period_key)}</strong><span>基準 ${escapeHtml(formatJst(marker.reset_at))}</span><span>理由: ${escapeHtml(marker.reason)}</span><span>作成 ${escapeHtml(formatJst(marker.created_at))}</span></div>`).join("")
        : `<p class="muted">有効なリセットマーカーはありません。</p>`;
      const previewMarkup = preview
        ? `<div class="ranking-reset-preview-result"><strong>プレビュー結果</strong><div class="detail-grid"><div><dt>対象外となる試合</dt><dd>${escapeHtml(preview.gamesExcluded)}</dd></div><div><dt>残る対象試合</dt><dd>${escapeHtml(preview.gamesRemaining)}</dd></div><div><dt>対象外となる予想</dt><dd>${escapeHtml(preview.predictionsExcluded)}</dd></div><div><dt>残る予想</dt><dd>${escapeHtml(preview.predictionsRemaining)}</dd></div><div><dt>集計境界</dt><dd>${escapeHtml(preview.resetBoundary)} JST</dd></div></div><p class="muted">この操作はデータを削除・更新せず、ランキング集計の境界だけを変更します。</p></div>`
        : `<p class="muted">プレビューを実行すると、既存データを変更せず影響範囲を確認できます。</p>`;
      const games = Array.isArray(reset.games) ? reset.games : [];
      const filter = reset.gameFilter || "all";
      const search = String(reset.gameSearch || "").trim().toLowerCase();
      const visibleGames = games.filter((game) => matchesFilter(game, filter) && matchesSearch(game, search));
      const gameListMarkup = reset.gamesLoading
        ? `<p class="muted">過去試合を読み込んでいます。</p>`
        : reset.gamesError
          ? `<p class="attention-text">${escapeHtml(reset.gamesError)}</p>`
          : visibleGames.length
            ? visibleGames.map(renderGame).join("")
            : `<p class="muted">条件に一致する試合はありません。</p>`;
      return `<div class="view-heading"><div><h2>ランキング対象外</h2><p>過去の試合を選び、既存のランキング対象外化APIで安全に除外します。</p></div></div><section class="v3-panel ranking-game-picker-panel"><div class="ranking-reset-warning"><strong>操作前に確認してください</strong><span>試合・予想・採点履歴は削除されません。理由と確認チェックが必須です。公開済み試合は読み取り専用です。</span></div><div class="ranking-game-picker-toolbar"><label>表示<select data-v3-ranking-exclusion-filter="gameFilter"><option value="all" ${filter === "all" ? "selected" : ""}>すべて</option><option value="cancelled" ${filter === "cancelled" ? "selected" : ""}>中止・対象外</option><option value="published" ${filter === "published" ? "selected" : ""}>公開済み</option><option value="scored" ${filter === "scored" ? "selected" : ""}>採点済み</option><option value="rankingExcluded" ${filter === "rankingExcluded" ? "selected" : ""}>ランキング対象外</option></select></label><label>検索<input type="search" value="${escapeHtml(reset.gameSearch || "")}" placeholder="日付・チーム・NPB code・internalGameId" data-v3-ranking-exclusion-search></label><button type="button" data-v3-ranking-exclusion-refresh ${reset.gamesLoading ? "disabled" : ""}>過去試合を更新</button></div><p class="muted">直近30試合を表示しています。対象外化後はランキング・perfect・daily-best-nineから除外されます。</p><div class="ranking-game-picker-list">${gameListMarkup}</div></section><section class="v3-panel ranking-reset-panel"><div class="ranking-reset-warning">実行後は同じ期間に新しいマーカーを重ねて作成できません。予想・採点結果・公開結果は削除されません。</div><div class="ranking-reset-form"><label>期間<select data-v3-ranking-reset-field="periodType"><option value="yearly" ${reset.periodType === "yearly" ? "selected" : ""}>年間</option><option value="monthly" ${reset.periodType === "monthly" ? "selected" : ""}>月間</option></select></label><label>期間キー<input type="text" value="${escapeHtml(reset.periodKey)}" placeholder="YYYY または YYYY-MM" data-v3-ranking-reset-field="periodKey"></label><label>リセット基準日時（JST）<input type="datetime-local" value="${escapeHtml(reset.resetAtLocal)}" data-v3-ranking-reset-field="resetAtLocal"></label><label class="ranking-reset-wide">理由<input type="text" maxlength="240" value="${escapeHtml(reset.reason)}" placeholder="正式リリース前のテストデータを除外するため" data-v3-ranking-reset-field="reason"></label><label class="ranking-reset-wide">実行確認（プレビュー後）<input type="text" value="${escapeHtml(reset.confirmation)}" placeholder="RESET YEARLY 2026" data-v3-ranking-reset-field="confirmation"></label></div><div class="v3-operation-actions"><button type="button" data-v3-ranking-reset-preview ${reset.loading ? "disabled" : ""}>影響範囲をプレビュー</button><button type="button" data-v3-ranking-reset-execute ${reset.loading || !preview ? "disabled" : ""}>リセットマーカーを作成</button></div><p class="v3-operation-result" data-v3-ranking-reset-status>${escapeHtml(reset.error || "")}</p>${previewMarkup}</section><section class="v3-panel"><h3>有効なリセットマーカー</h3><div class="ranking-reset-markers">${markerMarkup}</div></section>`;
    }

    return Object.freeze({ render });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3RankingResetRenderer = createAdminV3RankingResetRenderer;
})(window);
