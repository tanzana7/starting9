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
    "render-ranking-test-users",
    "app-coordinator"
  ]) {
    vm.runInContext(fs.readFileSync(path.join(moduleDir, `${name}.js`), "utf8"), context);
  }
  return context.window.Starting9AdminV3;
}

test("admin-v3はstate/API/描画module/coordinator/entryの順で読み込む", () => {
  const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scripts, [
    "frontend/admin-v3/state.js?v=independent-roster-lineup-safety-1-game-selection-safety-1-manual-lineup-explicit-confirmation-1-ranking-test-global-settings-1-ranking-test-fixed-presets-1-manual-lineup-two-step-confirmation-1",
    "frontend/public/fighters-player-details.js?v=fighters-player-details-20260903-1",
    "frontend/public/player-display.js?v=public-player-display-1-batting-hand-player-number-1-player-details-1",
    "frontend/admin-v3/api-client.js?v=independent-roster-lineup-safety-1-ranking-test-global-settings-1-ranking-test-fixed-presets-1",
    "frontend/admin-v3/dom.js?v=manual-lineup-finalize-safety-1",
    "frontend/admin-v3/selection-safety.js?v=admin-game-selection-safety-1",
    "frontend/admin-v3/render-manual-lineup.js?v=independent-roster-lineup-safety-1-admin-player-scroll-picker-1-game-selection-safety-1-lineup-order-mobile-zoom-1-admin-lineup-registration-emergency-fix-1-admin-lineup-lock-reason-1-manual-lineup-late-registration-1-manual-lineup-two-step-confirmation-1",
    "frontend/admin-v3/render-lineup-correction.js?v=admin-v3-lineup-correction-1",
    "frontend/admin-v3/render-manual-roster.js?v=independent-roster-lineup-safety-1-admin-player-scroll-picker-1",
    "frontend/admin-v3/render-game-progress.js?v=v4-canonical-status-1",
    "frontend/admin-v3/render-job-details.js?v=v4-canonical-status-1",
    "frontend/admin-v3/render-roster.js?v=v4-canonical-status-1",
    "frontend/admin-v3/render-diagnostics.js?v=v4-canonical-status-1",
    "frontend/admin-v3/render-ranking-reset.js?v=v4-canonical-status-1",
    "frontend/admin-v3/render-perfect-score-preview.js?v=v4-canonical-status-1",
    "frontend/admin-v3/render-ranking-test-users.js?v=ranking-test-users-1-global-settings-1-ranking-test-fixed-presets-1-display-name-slot-binding-1",
    "frontend/admin-v3/render-manual-game-preview.js?v=v4-canonical-status-1",
    "frontend/admin-v3/app-coordinator.js?v=independent-roster-lineup-safety-1-preserve-picker-scroll-1-admin-lineup-registration-emergency-fix-1-manual-lineup-two-step-confirmation-1-ranking-test-global-settings-1-ranking-test-fixed-presets-1-display-name-slot-binding-1",
    "admin-v3.js?v=independent-roster-lineup-safety-1-game-selection-safety-1-lineup-order-mobile-zoom-1-lineup-correction-1-admin-v3-game-progress-history-1-admin-lineup-registration-emergency-fix-1-admin-lineup-lock-reason-1-manual-lineup-late-registration-1-manual-lineup-two-step-confirmation-1-ranking-test-global-settings-1-ranking-test-fixed-presets-1-v4-canonical-status-1-display-name-slot-binding-1"
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
  assert.equal(typeof modules.createAdminV3RankingTestRenderer, "function");
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

test("手動スタメンは打順を行順に固定し、守備位置だけを各行で編集できる", () => {
  const modules = loadModules();
  const renderer = modules.createAdminV3ManualLineupRenderer({
    escapeHtml: (value) => String(value ?? ""),
    formatJst: (value) => String(value || ""),
    getFinalizeSafety: () => ({ allowed: true, message: "" }),
    getGameDayStatus: () => ({ key: "today", label: "今日", tone: "today", isFuture: false, isPast: false })
  });
  const rows = renderer.createBlankRows().map((row, index) => ({ ...row, battingOrder: 9, position: index === 0 ? "捕" : "" }));
  const html = renderer.render(
    { internalGameId: "game-1", gameDate: "2026-09-08", startAt: "2026-09-08T18:00:00+09:00", homeTeam: "fighters", awayTeam: "hawks", workflowState: "scheduled" },
    { lineup: { playerCatalog: [{ playerId: "p1", playerName: "選手1", uniformNumber: "1" }] } },
    { rows, confirmed: false, latestRevision: null, loading: false }
  );
  assert.equal((html.match(/data-v3-manual-lineup-position=/g) || []).length, 9);
  assert.equal((html.match(/data-v3-manual-lineup-order=/g) || []).length, 0);
  assert.match(html, /class="manual-lineup-fixed-order" aria-label="打順 1番"/);
  assert.match(html, /class="manual-lineup-fixed-order" aria-label="打順 9番"/);
  assert.match(html, /value="捕" selected/);
});

test("試合切替はmanual stateと詳細レスポンスの試合境界を守り、訂正画面の打順編集は維持する", () => {
  const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  const coordinator = fs.readFileSync(path.join(moduleDir, "app-coordinator.js"), "utf8");
  const payloadSource = admin.slice(admin.indexOf("function manualLineupPayload"), admin.indexOf("async function saveV3ManualLineup"));
  const detailLoader = admin.slice(admin.indexOf("async function loadV3OperationDetails"), admin.indexOf("\nasync function loadV3()"));
  const selection = admin.slice(admin.indexOf("async function selectV3Game"), admin.indexOf("async function copyV3JobDetail"));
  assert.match(payloadSource, /state\.rows\.map\(\(row, index\) => \(\{\s*battingOrder: index \+ 1/s);
  assert.match(detailLoader, /responseGameId/);
  assert.match(detailLoader, /requestToken !== Number\(v3State\.operationDetailsRequestToken/);
  assert.match(detailLoader, /id !== v3State\.selectedGameId/);
  assert.match(detailLoader, /operationDetails\.delete\(id\)/);
  assert.match(selection, /ensureV3ManualLineupState\(v3State\.selectedGameId\)/);
  assert.doesNotMatch(coordinator, /data-v3-manual-lineup-order/);
  assert.match(coordinator, /data-v3-lineup-correction-order/);
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
