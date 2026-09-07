import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(root, "frontend", "admin-v3");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

function loadModules() {
  const context = {
    window: {},
    Map,
    Set,
    URLSearchParams,
    Intl,
    Date
  };
  vm.createContext(context);
  for (const name of [
    "state",
    "../public/player-display",
    "api-client",
    "dom",
    "selection-safety",
    "render-manual-lineup",
    "render-lineup-correction",
    "render-manual-roster",
    "render-game-progress",
    "render-job-details",
    "render-roster",
    "render-diagnostics",
    "render-ranking-reset",
    "render-perfect-score-preview",
    "app-coordinator"
  ]) {
    vm.runInContext(fs.readFileSync(path.join(moduleDir, `${name}.js`), "utf8"), context);
  }
  return context.window.Starting9AdminV3;
}

test("admin-v3はstate/API/描画module/coordinator/entryの順で読み込む", () => {
  const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scripts, [
    "frontend/admin-v3/state.js?v=independent-roster-lineup-safety-1-game-selection-safety-1",
    "frontend/public/fighters-player-details.js?v=fighters-player-details-20260903-1",
    "frontend/public/player-display.js?v=public-player-display-1-batting-hand-player-number-1-player-details-1",
    "frontend/admin-v3/api-client.js?v=independent-roster-lineup-safety-1",
    "frontend/admin-v3/dom.js?v=manual-lineup-finalize-safety-1",
    "frontend/admin-v3/selection-safety.js?v=admin-game-selection-safety-1",
    "frontend/admin-v3/render-manual-lineup.js?v=independent-roster-lineup-safety-1-admin-player-scroll-picker-1-game-selection-safety-1-lineup-order-mobile-zoom-1",
    "frontend/admin-v3/render-lineup-correction.js?v=admin-v3-lineup-correction-1",
    "frontend/admin-v3/render-manual-roster.js?v=independent-roster-lineup-safety-1-admin-player-scroll-picker-1",
    "frontend/admin-v3/render-game-progress.js?v=manual-lineup-finalize-safety-1-v35-v4-semi-auto-diagnostics-1",
    "frontend/admin-v3/render-job-details.js?v=admin-v3-v35-diagnostics-readability-1",
    "frontend/admin-v3/render-roster.js?v=admin-v3-v35-diagnostics-readability-1",
    "frontend/admin-v3/render-diagnostics.js?v=admin-v3-v35-diagnostics-readability-1-v4-ops",
    "frontend/admin-v3/render-ranking-reset.js?v=admin-v3-v35-diagnostics-readability-1",
    "frontend/admin-v3/render-perfect-score-preview.js?v=admin-v3-v35-diagnostics-readability-1",
    "frontend/admin-v3/render-manual-game-preview.js?v=admin-v3-v35-diagnostics-readability-1",
    "frontend/admin-v3/app-coordinator.js?v=independent-roster-lineup-safety-1-preserve-picker-scroll-1",
    "admin-v3.js?v=independent-roster-lineup-safety-1-game-selection-safety-1-lineup-order-mobile-zoom-1-lineup-correction-1-admin-v3-game-progress-history-1"
  ]);
  const modules = loadModules();
  assert.equal(typeof modules.createAdminV3State, "function");
  assert.equal(typeof modules.createAdminV3ApiClient, "function");
  assert.equal(typeof modules.createAdminV3Dom, "function");
  assert.equal(typeof modules.createAdminV3SelectionSafety, "function");
  assert.equal(typeof modules.createAdminV3ManualLineupRenderer, "function");
  assert.equal(typeof modules.createAdminV3LineupCorrectionRenderer, "function");
  assert.equal(typeof modules.createAdminV3ManualRosterRenderer, "function");
  assert.equal(typeof modules.createAdminV3GameProgressRenderer, "function");
  assert.equal(typeof modules.createAdminV3JobDetailsRenderer, "function");
  assert.equal(typeof modules.createAdminV3RosterRenderer, "function");
  assert.equal(typeof modules.createAdminV3DiagnosticsRenderer, "function");
  assert.equal(typeof modules.createAdminV3RankingResetRenderer, "function");
  assert.equal(typeof modules.createAdminV3PerfectScoreRenderer, "function");
  assert.equal(typeof modules.createAdminV3Coordinator, "function");
});

test("admin-v3 entry pointは画面描画moduleへ委譲し、旧描画実装を重複保持しない", () => {
  const entry = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  assert.match(entry, /createAdminV3GameProgressRenderer/);
  assert.match(entry, /createAdminV3JobDetailsRenderer/);
  assert.match(entry, /createAdminV3DiagnosticsRenderer/);
  assert.doesNotMatch(entry, /function renderTimeline\(/);
  assert.doesNotMatch(entry, /function renderInlineJobDetail\(/);
  assert.doesNotMatch(entry, /function renderDiagnosticsView\(/);
  assert.doesNotMatch(entry, /function renderRosterSummary\(/);
});

test("スタメン修正rendererは変更前後の差分と正式再採点ボタンを表示する", () => {
  const modules = loadModules();
  const renderer = modules.createAdminV3LineupCorrectionRenderer({
    escapeHtml: (value) => String(value ?? ""),
    formatJst: (value) => String(value || ""),
    renderCandidates: () => "<button data-v3-manual-lineup-player=\"0\" data-v3-manual-lineup-player-id=\"p2\">候補</button>"
  });
  const before = Array.from({ length: 9 }, (_, index) => ({ battingOrder: index + 1, position: index === 0 ? "捕" : "内野", playerId: `p${index + 1}`, playerName: `選手${index + 1}` }));
  const after = before.map((row, index) => index === 0 ? { ...row, playerId: "p10", playerName: "訂正選手" } : row);
  assert.match(renderer.diffLineup(before, after).join("\n"), /1番の選手/);
  const html = renderer.render({
    games: [{ internalGameId: "game-1", gameDate: "2026-09-05", homeTeam: "fighters", awayTeam: "hawks", workflowState: "published", publicationStatus: "published" }],
    selectedGameId: "game-1",
    details: { targetGame: { internalGameId: "game-1", gameDate: "2026-09-05", startAt: "09:00", homeTeam: "fighters", awayTeam: "hawks", scoringStatus: "scored", publicationStatus: "published", rankingStatus: "scored" }, canonicalRevision: { lineup: before }, playerCatalog: after, manualRoster: null, readOnlyStatuses: { scoringStatus: "scored", rankingStatus: "scored", publicationStatus: "published" } },
    rows: after,
    reason: "公式訂正",
    confirmed: true
  });
  assert.match(html, /data-v3-lineup-correction-submit/);
  assert.match(html, /修正を確定して再採点/);
  assert.match(html, /data-v3-lineup-correction-player/);
});

test("admin API clientは認証付きGET/POSTとendpoint境界を集約する", async () => {
  const calls = [];
  const api = loadModules().createAdminV3ApiClient({
    location: { hostname: "starting9.pages.dev" },
    productionBase: "https://auth.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ ok: true }) };
    }
  });
  await api.getSession();
  await api.previewPerfectScore({ internalGameId: "game-1", reason: "release review" });
  assert.equal(calls[0].url, "https://auth.example.test/api/admin/me");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[1].options.method, "POST");
  assert.match(calls[1].url, /perfect-score-test\/preview/);
});

test("stateは管理者previewの状態を通常workflow stateから分離する", () => {
  const state = loadModules().createAdminV3State();
  assert.equal(state.rankingReset.preview, null);
  assert.equal(state.rankingReset.confirmation, "");
  assert.equal("fixtureKey" in state.perfectScorePreview, false);
  assert.equal(state.perfectScorePreview.result, null);
});
