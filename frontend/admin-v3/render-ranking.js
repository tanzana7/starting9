(function registerAdminV3RankingRenderer(global) {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function defaultPeriodKey(periodType, now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short"
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
    if (periodType === "yearly") return values.year;
    if (periodType === "monthly") return `${values.year}-${values.month}`;
    const daysSinceMonday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - daysSinceMonday);
    return date.toISOString().slice(0, 10);
  }

  function periodLabel(periodType) {
    return { weekly: "週間", monthly: "月間", yearly: "年間" }[periodType] || "ランキング";
  }

  function createAdminV3RankingRenderer() {
    function render(state) {
      const periodType = ["weekly", "monthly", "yearly"].includes(state?.periodType) ? state.periodType : "weekly";
      const periodKey = String(state?.periodKey || defaultPeriodKey(periodType));
      const rows = Array.isArray(state?.rows) ? state.rows : [];
      const summary = state?.summary || {};
      const content = state?.loading
        ? '<p class="muted">ランキングを読み込んでいます。</p>'
        : state?.error
          ? `<p class="v3-operation-result error">${escapeHtml(state.error)}</p>`
          : rows.length === 0
            ? '<p class="muted">この期間のランキングデータはありません。</p>'
            : `<div class="admin-ranking-table-wrap"><table class="admin-ranking-table"><thead><tr><th scope="col">順位</th><th scope="col">ユーザー名</th><th scope="col">平均点</th><th scope="col">合計点</th><th scope="col">参加</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.rank ?? "-")}</td><td>${escapeHtml(row.username || "-")}</td><td>${escapeHtml(Number(row.averageScore || 0).toFixed(2))}</td><td>${escapeHtml(row.totalScore ?? 0)}</td><td>${escapeHtml(`${row.gamesPlayed ?? 0} / ${row.eligibleGames ?? 0}`)}</td></tr>`).join("")}</tbody></table></div>`;
      return `<section class="v3-panel admin-ranking-panel" aria-labelledby="adminRankingTitle">
        <div class="v3-panel-heading"><div><h2 id="adminRankingTitle">ランキング</h2><p class="muted">管理者専用の週間・月間・年間ランキングです。</p></div><button type="button" data-v3-ranking-refresh ${state?.loading ? "disabled" : ""}>更新</button></div>
        <div class="admin-ranking-controls"><label for="adminRankingPeriod">期間</label><select id="adminRankingPeriod" data-v3-ranking-period><option value="weekly" ${periodType === "weekly" ? "selected" : ""}>週間</option><option value="monthly" ${periodType === "monthly" ? "selected" : ""}>月間</option><option value="yearly" ${periodType === "yearly" ? "selected" : ""}>年間</option></select><label for="adminRankingPeriodKey">対象</label><input id="adminRankingPeriodKey" data-v3-ranking-period-key value="${escapeHtml(periodKey)}" inputmode="numeric" autocomplete="off"><span class="muted">${escapeHtml(periodLabel(periodType))}</span></div>
        <p class="admin-ranking-summary">表示 ${escapeHtml(rows.length)}人 / 対象 ${escapeHtml(summary.totalUsers ?? 0)}人・対象試合 ${escapeHtml(summary.eligibleGames ?? 0)}試合</p>
        ${content}
      </section>`;
    }

    return Object.freeze({ defaultPeriodKey, render });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3RankingRenderer = createAdminV3RankingRenderer;
})(window);
