(function registerAdminV3RankingResetRenderer(global) {
  "use strict";

  function createAdminV3RankingResetRenderer({ state, escapeHtml, formatJst }) {
    function render() {
      const reset = state.rankingReset;
      const preview = reset.preview;
      const markerMarkup = reset.markers.length
        ? reset.markers.map((marker) => `<div class="ranking-reset-marker"><strong>${escapeHtml(marker.period_type)} ${escapeHtml(marker.period_key)}</strong><span>基準 ${escapeHtml(formatJst(marker.reset_at))}</span><span>理由: ${escapeHtml(marker.reason)}</span><span>作成 ${escapeHtml(formatJst(marker.created_at))}</span></div>`).join("")
        : `<p class="muted">有効なリセットマーカーはありません。</p>`;
      const previewMarkup = preview
        ? `<div class="ranking-reset-preview-result"><strong>プレビュー結果</strong><div class="detail-grid"><div><dt>対象外となる試合</dt><dd>${escapeHtml(preview.gamesExcluded)}</dd></div><div><dt>残る対象試合</dt><dd>${escapeHtml(preview.gamesRemaining)}</dd></div><div><dt>対象外となる予想</dt><dd>${escapeHtml(preview.predictionsExcluded)}</dd></div><div><dt>残る予想</dt><dd>${escapeHtml(preview.predictionsRemaining)}</dd></div><div><dt>集計境界</dt><dd>${escapeHtml(preview.resetBoundary)} JST</dd></div></div><p class="muted">この操作はデータを削除・更新せず、ランキング集計の境界だけを変更します。</p></div>`
        : `<p class="muted">プレビューを実行すると、既存データを変更せず影響範囲を確認できます。</p>`;
      return `<div class="view-heading"><div><h2>ランキングリセット</h2><p>正式リリース前の年間・月間ランキングを、履歴を保持したまま集計境界で切り替えます。</p></div></div><section class="v3-panel ranking-reset-panel"><div class="ranking-reset-warning">実行後は同じ期間に新しいマーカーを重ねて作成できません。予想・採点結果・公開結果は削除されません。</div><div class="ranking-reset-form"><label>期間<select data-v3-ranking-reset-field="periodType"><option value="yearly" ${reset.periodType === "yearly" ? "selected" : ""}>年間</option><option value="monthly" ${reset.periodType === "monthly" ? "selected" : ""}>月間</option></select></label><label>期間キー<input type="text" value="${escapeHtml(reset.periodKey)}" placeholder="YYYY または YYYY-MM" data-v3-ranking-reset-field="periodKey"></label><label>リセット基準日時（JST）<input type="datetime-local" value="${escapeHtml(reset.resetAtLocal)}" data-v3-ranking-reset-field="resetAtLocal"></label><label class="ranking-reset-wide">理由<input type="text" maxlength="240" value="${escapeHtml(reset.reason)}" placeholder="正式リリース前のテストデータを除外するため" data-v3-ranking-reset-field="reason"></label><label class="ranking-reset-wide">実行確認（プレビュー後）<input type="text" value="${escapeHtml(reset.confirmation)}" placeholder="RESET YEARLY 2026" data-v3-ranking-reset-field="confirmation"></label></div><div class="v3-operation-actions"><button type="button" data-v3-ranking-reset-preview ${reset.loading ? "disabled" : ""}>影響範囲をプレビュー</button><button type="button" data-v3-ranking-reset-execute ${reset.loading || !preview ? "disabled" : ""}>リセットマーカーを作成</button></div><p class="v3-operation-result" data-v3-ranking-reset-status>${escapeHtml(reset.error || "")}</p>${previewMarkup}</section><section class="v3-panel"><h3>有効なリセットマーカー</h3><div class="ranking-reset-markers">${markerMarkup}</div></section>`;
    }

    return Object.freeze({ render });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3RankingResetRenderer = createAdminV3RankingResetRenderer;
})(window);
