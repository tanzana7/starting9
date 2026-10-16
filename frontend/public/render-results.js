(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};

  function createPublicResultsRenderer(deps) {
    // Retain this existing renderer contract for the independent latest-published
    // Best Nine widget. History/detail rendering is owned by results.js.
    function renderDailyBestNine() {
      const card = document.getElementById("dailyBestNineCard");
      const container = document.getElementById("dailyBestNineContent");
      if (!card || !container) return;

      const bestNine = deps.state.dailyBestNine;
      const isPublished = bestNine.status === "published";
      card.classList.toggle("hidden", !isPublished);
      if (!isPublished) {
        container.innerHTML = "";
        return;
      }
      if (bestNine.isLoading) {
        container.innerHTML = '<p class="daily-best-nine-message">今日のベストナインを確認中です。</p>';
        return;
      }
      if (bestNine.message) {
        container.innerHTML = `<p class="daily-best-nine-message is-error">${deps.escapeHtml(bestNine.message)}</p>`;
        return;
      }
      if (!bestNine.rows.length) {
        container.innerHTML = '<p class="daily-best-nine-message">この試合は表示できる予想がありません。</p>';
        return;
      }

      container.innerHTML = `<ol class="daily-best-nine-list">${bestNine.rows.map((row) => `
        <li>
          <span class="daily-best-nine-rank">${deps.escapeHtml(row.rank)}位</span>
          <strong>${deps.escapeHtml(row.username)}</strong>
          <span class="daily-best-nine-score">${deps.escapeHtml(row.score)}点</span>
          ${row.isPerfect ? '<span class="daily-best-nine-badge">満点</span>' : ""}
        </li>
      `).join("")}</ol>`;
    }

    return { renderDailyBestNine };
  }

  publicFrontend.createPublicResultsRenderer = createPublicResultsRenderer;
})();
