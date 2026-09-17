(function registerAdminV3PreBetaPurgeRenderer(global) {
  "use strict";

  function createAdminV3PreBetaPurgeRenderer({ escapeHtml, formatJst }) {
    function renderTargets(plan) {
      const games = Array.isArray(plan?.targetGames) ? plan.targetGames : [];
      if (!games.length) return "<p>削除対象の過去試合はありません。</p>";
      return `<ol class="pre-beta-purge-games">${games.map((game) => {
        const date = String(game.game_date || "").slice(0, 10) || formatJst(game.start_time, false);
        const gameId = game.internal_game_id || game.game_id || "-";
        return `<li><strong>${escapeHtml(date || "-")}</strong> <span>${escapeHtml(game.source || "対象")}</span> <code>${escapeHtml(gameId)}</code></li>`;
      }).join("")}</ol>`;
    }

    function renderCounts(plan) {
      const counts = plan?.counts && typeof plan.counts === "object" ? plan.counts : {};
      const rows = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
      if (!rows.length) return "<p>削除予定件数はありません。</p>";
      return `<table class="pre-beta-purge-table"><thead><tr><th>対象テーブル</th><th>予定件数</th></tr></thead><tbody>${rows.map(([table, count]) => `<tr><td><code>${escapeHtml(table)}</code></td><td>${escapeHtml(count)}</td></tr>`).join("")}</tbody><tfoot><tr><th>合計</th><th>${escapeHtml(plan?.totalRows ?? 0)}</th></tr></tfoot></table>`;
    }

    function render(state = {}) {
      if (state.loading) return '<section class="pre-beta-purge-panel"><div class="pre-beta-purge-header"><h2>公開前データdry-run</h2><p>削除予定を読み込んでいます…</p></div></section>';
      if (state.error) return `<section class="pre-beta-purge-panel"><div class="pre-beta-purge-header"><h2>公開前データdry-run</h2><p role="alert">${escapeHtml(state.error)}</p><button type="button" data-v3-pre-beta-purge-refresh>再取得</button></div></section>`;
      const plan = state.plan;
      if (!plan) return '<section class="pre-beta-purge-panel"><div class="pre-beta-purge-header"><h2>公開前データdry-run</h2><p>dry-run結果はまだ取得されていません。</p><button type="button" data-v3-pre-beta-purge-refresh>dry-runを取得</button></div></section>';
      const cronEnabled = state.cron?.gameAutomationV3 === "enabled";
      const activeJobs = plan.activeJobs || {};
      return `<section class="pre-beta-purge-panel">
        <div class="pre-beta-purge-header">
          <h2>公開前データdry-run</h2>
          <p>読み取り専用の削除予定確認です。この画面から削除は実行できません。</p>
          <button type="button" data-v3-pre-beta-purge-refresh>再取得</button>
        </div>
        <section class="pre-beta-purge-section">
          <h3>対象範囲</h3>
          <div class="pre-beta-purge-meta"><span>基準日時: <strong>${escapeHtml(plan.cutoff || "-")}</strong></span><span>plan version: <code>${escapeHtml(plan.version || "-")}</code></span><span>対象試合数: <strong>${escapeHtml(Array.isArray(plan.targetGames) ? plan.targetGames.length : 0)}</strong></span><span>dry-run: <strong>実行済み</strong></span></div>
          ${renderTargets(plan)}
        </section>
        <section class="pre-beta-purge-section"><h3>削除予定</h3>${renderCounts(plan)}<p class="pre-beta-purge-note">users、sessions、日程、player master、roster、settings、Audit D1はallowlist対象外です。</p></section>
        <section class="pre-beta-purge-section"><h3>競合確認</h3><div class="pre-beta-purge-status"><span>V3 Cron: <strong>${cronEnabled ? "稼働中" : "停止中"}</strong></span><span>game_jobs_v3: <strong>${escapeHtml(activeJobs.gameJobs ?? 0)}</strong></span><span>game_job_runs: <strong>${escapeHtml(activeJobs.gameJobRuns ?? 0)}</strong></span><span>削除POST: <strong>この画面では提供なし</strong></span></div></section>
        <section class="pre-beta-purge-section"><h3>保持対象・再生成防止</h3><p class="pre-beta-purge-note">TEST9・一般ユーザーのアカウントと認証情報、未開催・進行中の試合、選手・ロースター定義を保持します。対象試合のactive jobがある場合、正式削除処理は拒否されます。</p></section>
      </section>`;
    }

    return Object.freeze({ render });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3PreBetaPurgeRenderer = createAdminV3PreBetaPurgeRenderer;
})(window);
