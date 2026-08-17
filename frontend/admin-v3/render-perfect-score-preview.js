(function registerAdminV3PerfectScoreRenderer(global) {
  "use strict";

  function createAdminV3PerfectScoreRenderer({ state, escapeHtml }) {
    function render(game) {
      const previewState = state.perfectScorePreview.internalGameId === game.internalGameId
        ? state.perfectScorePreview
        : { reason: "", loading: false, result: null, error: "" };
      const result = previewState.result;
      const breakdown = result?.scoringBreakdown || {};
      const lineupMarkup = Array.isArray(result?.officialLineup)
        ? result.officialLineup.map((player) => `<li>${escapeHtml(player.battingOrder)}番 ${escapeHtml(player.displayName || player.playerName || player.name)} / ${escapeHtml(player.position)} / ${escapeHtml(player.playerId)}</li>`).join("")
        : "";
      const resultMarkup = result
        ? `<div class="perfect-score-preview-result"><div class="detail-grid"><div><dt>期待スコア</dt><dd><strong>${escapeHtml(result.expectedScore)} / ${escapeHtml(result.maxScore)}</strong></dd></div><div><dt>満点判定</dt><dd>${result.isMaxScore ? "満点" : "要確認"}</dd></div><div><dt>lineup revision</dt><dd>${escapeHtml(result.lineupRevision?.revisionId || "-")}</dd></div><div><dt>書き込み</dt><dd>なし（previewのみ）</dd></div><div><dt>選手一致</dt><dd>${escapeHtml(breakdown.player?.hits ?? 0)} / 9</dd></div><div><dt>打順一致</dt><dd>${escapeHtml(breakdown.order?.hits ?? 0)} / 9</dd></div><div><dt>守備一致</dt><dd>${escapeHtml(breakdown.position?.hits ?? 0)} / 9</dd></div></div><h4>正式スタメン</h4><ol class="perfect-score-preview-lineup">${lineupMarkup}</ol></div>`
        : `<p class="muted">正式スタメン確定後に、仮想予想の満点判定を確認できます。</p>`;
      return `<section class="v3-panel perfect-score-preview-panel"><div class="view-heading"><div><h3>満点確認（管理者preview）</h3><p>確定済みの正式スタメンから仮想予想を作り、既存の採点コアだけを読み取りでシミュレーションします。</p></div></div><div class="perfect-score-preview-warning">本番予想、ランキング、公開結果、監査データは変更しません。D1にも保存しません。</div><label class="perfect-score-preview-reason">確認理由<input type="text" maxlength="240" value="${escapeHtml(previewState.reason || "")}" placeholder="採点コアの満点確認" data-v3-perfect-score-field="reason"></label><div class="v3-operation-actions"><button type="button" data-v3-perfect-score-preview ${previewState.loading ? "disabled" : ""}>正式スタメンからpreview</button></div><p class="v3-operation-result" data-v3-perfect-score-status>${escapeHtml(previewState.error || "")}</p>${resultMarkup}</section>`;
    }

    return Object.freeze({ render });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3PerfectScoreRenderer = createAdminV3PerfectScoreRenderer;
})(window);
