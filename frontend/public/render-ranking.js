(() => {
  const publicFrontend = window.Starting9Public = window.Starting9Public || {};
  const PUBLIC_RANKING_DISPLAY_LIMIT = 10;

  function createPublicRankingRenderer(deps) {
    function renderHeading(view) {
      const title = document.getElementById("rankingTitle");
      const description = document.getElementById("rankingDescription");
      const yearlyButton = document.getElementById("showYearlyRankingButton");
      const monthlyButton = document.getElementById("showMonthlyRankingButton");
      const weeklyButton = document.getElementById("showWeeklyRankingButton");
      const isYearly = view === "yearly";
      const isMonthly = view === "monthly";
      const isWeekly = view === "weekly";
      if (title) title.textContent = "ランキング";
      if (description) description.textContent = "公開済み試合の参加状況と成績をもとにランキングを表示しています。";
      yearlyButton?.classList.toggle("is-active", isYearly);
      monthlyButton?.classList.toggle("is-active", isMonthly);
      weeklyButton?.classList.toggle("is-active", isWeekly);
      yearlyButton?.setAttribute("aria-selected", String(isYearly));
      monthlyButton?.setAttribute("aria-selected", String(isMonthly));
      weeklyButton?.setAttribute("aria-selected", String(isWeekly));
    }

    function filterRows(rows, { hideIneligibleRankings = false } = {}) {
      const normalizedRows = Array.isArray(rows) ? rows : [];
      const eligibleRows = hideIneligibleRankings ? normalizedRows.filter((row) => row?.isQualified) : normalizedRows;
      return eligibleRows.filter((row) => {
        if (row?.rank === null || row?.rank === undefined || row?.rank === "") return true;
        const rank = Number(row?.rank);
        // Unqualified users have no competition rank; keep their existing
        // reference section while limiting ranked public entries to Top 10.
        return Number.isInteger(rank) && rank >= 1 && rank <= PUBLIC_RANKING_DISPLAY_LIMIT;
      });
    }

    function formatQualification(row, { reference = false } = {}) {
      if (row?.isQualified && !reference) return "規定到達";
      return `あと${Math.max(0, Number(row?.gamesNeeded || 0))}試合連続参加で規定到達`;
    }

    function renderMyRanking(ranking, row, title) {
      const user = deps.getPredictionAccountUser();
      if (!user) return "";
      if (ranking.isLoadingSelf) {
        return `<section class="ranking-self"><h3>${deps.escapeHtml(title)}</h3><p>成績を読み込んでいます。</p></section>`;
      }
      if (!row) {
        return `<section class="ranking-self"><h3>${deps.escapeHtml(title)}</h3><p>まだランキング対象試合への参加記録がありません。</p></section>`;
      }
      const qualification = row.isQualified
        ? `規定到達・現在 ${row.rank}位`
        : `${formatQualification(row)}（規定未到達）`;
      return `<section class="ranking-self">
        <h3>${deps.escapeHtml(title)}</h3>
        <p><strong>平均${deps.escapeHtml(deps.formatRankingScore(row.averageScore))}点</strong> ${deps.escapeHtml(qualification)}</p>
        <p>${deps.escapeHtml(row.gamesPlayed)} / ${deps.escapeHtml(row.eligibleGames)}試合参加・参加率${deps.escapeHtml(deps.formatParticipationRate(row.participationRate))}</p>
      </section>`;
    }

    function createCardHtml(row, { reference = false } = {}) {
      const user = deps.getPredictionAccountUser();
      const isSelf = Boolean(user && ((row.username && row.username === user.username) || (row.userId && String(row.userId) === String(user.id))));
      const medal = { 1: "🥇", 2: "🥈", 3: "🥉" }[Number(row.rank)] || "";
      const rankLabel = reference ? "参考記録" : `${medal}${row.rank}位`;
      const qualification = formatQualification(row, { reference });
      return `<li class="ranking-entry${reference ? " is-reference" : ""}${isSelf ? " is-self" : ""}">
        <p class="ranking-rank">${deps.escapeHtml(rankLabel)}</p>
        <div class="ranking-entry-main">
          <div class="ranking-user-line"><strong>${deps.escapeHtml(row.username)}${isSelf ? "（あなた）" : ""}</strong>${deps.createRankingAchievementBadgesHtml(row)}</div>
          <p>平均 ${deps.escapeHtml(deps.formatRankingScore(row.averageScore))}点${reference ? "（参考）" : ""}</p>
          <p>${deps.escapeHtml(row.gamesPlayed)} / ${deps.escapeHtml(row.eligibleGames)}試合・参加率 ${deps.escapeHtml(deps.formatParticipationRate(row.participationRate))}・${deps.escapeHtml(qualification)}</p>
          <p>合計 ${deps.escapeHtml(row.totalScore)}点・満点 ${deps.escapeHtml(row.perfectCount)}回</p>
        </div>
      </li>`;
    }

    function renderContent(ranking, { selfTitle, emptyMessage, prefixHtml = "", hideIneligibleRankings = false }) {
      const container = document.getElementById("rankingContent");
      if (!container) return;
      if (ranking.isLoading && !ranking.summary) {
        container.innerHTML = `${prefixHtml}<p class="empty-state">ランキングを読み込んでいます。</p>`;
        return;
      }
      if (ranking.message) {
        container.innerHTML = `${prefixHtml}<p class="empty-state">${deps.escapeHtml(ranking.message)}</p>`;
        return;
      }
      const summary = ranking.summary;
      if (!summary || Number(summary.eligibleGames || 0) === 0) {
        container.innerHTML = `${prefixHtml}<p class="empty-state">${deps.escapeHtml(emptyMessage)}</p>`;
        return;
      }
      const displayRows = filterRows(ranking.rows, { hideIneligibleRankings });
      const qualified = displayRows.filter((row) => row.isQualified);
      const unqualified = displayRows.filter((row) => !row.isQualified);
      const qualifiedContent = qualified.length
        ? `<ol class="ranking-list">${qualified.map((row) => createCardHtml(row)).join("")}</ol>`
        : '<p class="ranking-empty">まだ規定到達者はいません。</p>';
      const unqualifiedContent = unqualified.length
        ? `<details class="ranking-unqualified"><summary>規定未到達者を見る（${unqualified.length}人）</summary><ol class="ranking-list is-reference">${unqualified.map((row) => createCardHtml(row, { reference: true })).join("")}</ol></details>`
        : "";
      const summaryText = `対象 ${summary.eligibleGames}試合 / 規定 ${summary.requiredGames}試合以上`;
      container.innerHTML = `${prefixHtml}
        <p class="ranking-summary">${deps.escapeHtml(summaryText)}</p>
        ${renderMyRanking(ranking, ranking.self, selfTitle)}
        <section class="ranking-qualified-section" aria-labelledby="rankingQualifiedTitle">
          <h3 id="rankingQualifiedTitle">ランキング</h3>
          ${qualifiedContent}
        </section>
        ${unqualifiedContent}`;
    }

    return { renderHeading, filterRows, formatQualification, renderContent, renderMyRanking, createCardHtml };
  }

  publicFrontend.createPublicRankingRenderer = createPublicRankingRenderer;
})();
