(function registerAdminV3Dom(global) {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[character]));
  }

  function formatJst(value, includeDate = true) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "-";
    const options = { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false };
    if (includeDate) Object.assign(options, { year: "numeric", month: "2-digit", day: "2-digit" });
    return new Intl.DateTimeFormat("ja-JP", options).format(date).replace(/年|月/g, "/").replace("日", "");
  }

  function formatTimelineTime(value) {
    if (Array.isArray(value)) return value.map((item) => formatJst(item)).filter(Boolean).join(" / ");
    return value ? formatJst(value) : "";
  }

  function renderSummaryCard(label, count, tone = "ok") {
    return `<div class="summary-card ${tone}"><strong>${escapeHtml(count)}</strong><span>${escapeHtml(label)}</span></div>`;
  }

  function renderSelectedGameHeader(game, title, description = "") {
    if (!game) return `<div class="today-empty">対象試合を選択してください。</div>`;
    return `<div class="view-heading"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><div class="compact-meta"><strong>${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)}</strong><span>${escapeHtml(formatJst(game.startAt))} JST</span></div></div>`;
  }

  function createAdminV3Dom() {
    return Object.freeze({
      escapeHtml,
      formatJst,
      formatTimelineTime,
      renderSummaryCard,
      renderSelectedGameHeader
    });
  }

  global.Starting9AdminV3 = global.Starting9AdminV3 || {};
  global.Starting9AdminV3.createAdminV3Dom = createAdminV3Dom;
})(window);
