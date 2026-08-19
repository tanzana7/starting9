(function registerAdminV3ManualGamePreviewRenderer(global) {
  "use strict";

  const TEAMS = Object.freeze([
    ["fighters", "ファイターズ"], ["hawks", "ホークス"], ["buffaloes", "バファローズ"],
    ["lions", "ライオンズ"], ["eagles", "イーグルス"], ["marines", "マリーンズ"],
    ["giants", "ジャイアンツ"], ["tigers", "タイガース"], ["baystars", "ベイスターズ"],
    ["carp", "カープ"], ["dragons", "ドラゴンズ"], ["swallows", "スワローズ"]
  ]);

  function createAdminV3ManualGamePreviewRenderer({ escapeHtml }) {
    const escape = (value) => escapeHtml(String(value ?? ""));
    const json = (value) => escape(JSON.stringify(value ?? null, null, 2));

    function teamOptions(selected) {
      return TEAMS.map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label} (${value})</option>`).join("");
    }

    function resultMarkup(state) {
      if (state.error) return `<div class="manual-game-preview-error" role="alert">${escape(state.error)}</div>`;
      if (state.loading) return `<div class="manual-game-preview-loading" role="status">読み取り専用の重複確認を実行中…</div>`;
      const result = state.result;
      if (!result) return `<p class="muted">入力後にプレビューを実行すると、既存試合との重複候補と登録準備状態を表示します。</p>`;
      const duplicate = result.duplicateCheck || {};
      const readiness = result.registrationReadiness || {};
      const plan = result.expectedPlan || {};
      const warnings = Array.isArray(duplicate.warnings) && duplicate.warnings.length
        ? `<ul class="manual-game-preview-list">${duplicate.warnings.map((item) => `<li><strong>${escape(item.code)}</strong> ${escape(item.message)}</li>`).join("")}</ul>`
        : "<p class=muted>重複警告はありません。</p>";
      const matches = Array.isArray(duplicate.matches) && duplicate.matches.length
        ? `<ul class="manual-game-preview-list">${duplicate.matches.map((item) => `<li><code>${escape(item.matchType)}</code> / ${escape(item.source)} / ${escape(item.internalGameId || item.game_id || "候補")}</li>`).join("")}</ul>`
        : "<p class=muted>既存の重複候補は見つかりませんでした。</p>";
      return `<div class="manual-game-preview-result" data-v3-manual-game-preview-result>
        <div class="manual-game-preview-status ${duplicate.hasBlockingDuplicate ? "blocking" : "clear"}"><strong>${duplicate.hasBlockingDuplicate ? "blocking duplicateあり" : "登録候補として重複なし"}</strong><span>nextSafeAction: <code>${escape(result.nextSafeAction)}</code></span></div>
        <div class="manual-game-preview-grid">
          <div><dt>idempotencyKey</dt><dd><code>${escape(result.idempotencyKey)}</code></dd></div>
          <div><dt>validation</dt><dd>${result.validation?.ok ? "OK" : "確認が必要"}</dd></div>
          <div><dt>willWrite</dt><dd><code>${escape(result.willWrite)}</code></dd></div>
          <div><dt>detected schedule</dt><dd>${escape(duplicate.detectedScheduleCheck?.status || "not_available")}</dd></div>
          <div><dt>schema</dt><dd>${escape(readiness.reason)}</dd></div>
        </div>
        <section><h3>duplicate warnings</h3>${warnings}</section>
        <section><h3>matches</h3>${matches}</section>
        <section><h3>registrationReadiness</h3><pre>${json(readiness)}</pre></section>
        <section><h3>expectedPlan</h3><pre>${json(plan)}</pre></section>
      </div>`;
    }

    function render(state = {}) {
      const input = state.input || {};
      return `<div class="view-heading"><div><h2>追加試合プレビュー</h2><p>追加試合候補をread-onlyで検証します。本登録はこの画面から行いません。</p></div></div>
        <section class="v3-panel manual-game-preview-panel">
          <div class="manual-game-preview-warning"><strong>この操作は書き込みを行いません。</strong><span>本登録は未実装です。migration適用後に正式登録Phaseへ進みます。</span></div>
          <form class="manual-game-preview-form" data-v3-manual-game-preview-form>
            <label>gameDate <input type="date" data-v3-manual-game-field="gameDate" value="${escape(input.gameDate)}" required></label>
            <label>startAt <input type="datetime-local" data-v3-manual-game-field="startAt" value="${escape(input.startAt)}" required></label>
            <label>homeTeam <select data-v3-manual-game-field="homeTeam" required>${teamOptions(input.homeTeam || "fighters")}</select></label>
            <label>awayTeam <select data-v3-manual-game-field="awayTeam" required>${teamOptions(input.awayTeam || "hawks")}</select></label>
            <label>venue <input type="text" data-v3-manual-game-field="venue" value="${escape(input.venue)}" maxlength="120"></label>
            <label>npbGameCode <input type="text" data-v3-manual-game-field="npbGameCode" value="${escape(input.npbGameCode)}" placeholder="任意 / 例: f-h-18"></label>
            <label class="manual-game-preview-check"><input type="checkbox" data-v3-manual-game-field="rankingEligible" ${input.rankingEligible !== false ? "checked" : ""}> rankingEligible</label>
            <label class="manual-game-preview-wide">reason <textarea data-v3-manual-game-field="reason" maxlength="240" required>${escape(input.reason)}</textarea></label>
            <label class="manual-game-preview-wide manual-game-preview-check"><input type="checkbox" data-v3-manual-game-field="confirmPreview" ${input.confirmPreview ? "checked" : ""}> preview実行を確認しました</label>
            <button type="button" data-v3-manual-game-preview ${state.loading ? "disabled" : ""}>プレビュー</button>
          </form>
          ${resultMarkup(state)}
        </section>`;
    }

    return Object.freeze({ render });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3ManualGamePreviewRenderer = createAdminV3ManualGamePreviewRenderer;
})(window);
