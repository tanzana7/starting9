const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const sharedSource = fs.readFileSync(path.join(root, "frontend", "shared", "lineup-builder.js"), "utf8");
const lineupSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");
const coordinatorSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "app-coordinator.js"), "utf8");
const adminSource = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const adminCss = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function createRenderer() {
  const context = vm.createContext({ window: {}, Map, Set, Intl, Date });
  vm.runInContext(sharedSource, context);
  vm.runInContext(lineupSource, context);
  return context.window.Starting9AdminV3.createAdminV3ManualLineupRenderer({
    escapeHtml,
    formatJst: (value) => String(value || "-"),
    getFinalizeSafety: () => ({ allowed: true, message: "" }),
    getGameDayStatus: () => ({ key: "today", label: "今日", tone: "today", isFuture: false, isPast: false })
  });
}

const catalog = [
  { playerId: "p1", playerName: "先頭", uniformNumber: "1", candidateVisibility: "auto" },
  { playerId: "p2", playerName: "控え", uniformNumber: "2", candidateVisibility: "auto" },
  { playerId: "pitcher", playerName: "投手", uniformNumber: "18", candidateVisibility: "hide" }
];
const manualRoster = { entries: [{ playerId: "p1", status: "active" }, { playerId: "p2", status: "inactive" }] };

test("public/adminで共有candidate policyと行reorder helperを利用できる", () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(sharedSource, context);
  const builder = context.window.Starting9LineupBuilder;
  assert.equal(builder.isLineupCandidate({ candidateVisibility: "hide" }), false);
  assert.equal(builder.isLineupCandidate({ candidateVisibility: "show" }), true);
  assert.equal(builder.isLineupCandidate({ isBatterCandidate: false }), false);
  assert.equal(builder.isLineupCandidate({ isBatterCandidate: true }), true);
  assert.deepEqual(Array.from(builder.positionValues), ["", "捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);
  const rows = [{ battingOrder: 1, playerId: "a", position: "捕" }, { battingOrder: 2, playerId: "b", position: "一" }, { battingOrder: 3, playerId: "c", position: "二" }];
  const moved = builder.reorderLineupRows(rows, 0, 2);
  assert.deepEqual(Array.from(moved, (row) => row.playerId), ["b", "c", "a"]);
  assert.deepEqual(Array.from(moved, (row) => row.battingOrder), [1, 2, 3]);
  assert.equal(rows[0].battingOrder, 1);
});

test("admin候補はpublicと同じactive/inactive切替とcandidateVisibilityを使う", () => {
  const renderer = createRenderer();
  const row = renderer.createBlankRows()[0];
  const active = renderer.renderCandidates(catalog, row, 0, manualRoster, "active");
  const inactive = renderer.renderCandidates(catalog, row, 0, manualRoster, "inactive");
  assert.match(active, /先頭/);
  assert.doesNotMatch(active, /控え/);
  assert.doesNotMatch(active, /投手/);
  assert.match(inactive, /控え/);
  assert.doesNotMatch(inactive, /先頭/);
  assert.doesNotMatch(inactive, /投手/);
});

test("admin lineupはpublicと同じbuilder構造・roster toggle・drag対象を描画する", () => {
  const renderer = createRenderer();
  const markup = renderer.render({ internalGameId: "game-1", gameDate: "2026-09-14", homeTeam: "fighters", awayTeam: "hawks" }, { lineup: { playerCatalog: catalog, manualRoster } }, {
    rows: renderer.createBlankRows(), activeIndex: 0, candidateRosterFilter: "active", loading: false
  });
  assert.match(markup, /class="lineup-builder manual-lineup-builder manual-lineup-grid"/);
  assert.equal((markup.match(/class="lineup-slot manual-lineup-slot/g) || []).length, 9);
  assert.match(markup, /data-v3-manual-lineup-roster-filter="active"/);
  assert.match(markup, /data-v3-manual-lineup-roster-filter="inactive"/);
  assert.equal((markup.match(/data-v3-manual-lineup-clear=/g) || []).length, 9);
  assert.equal((markup.match(/data-v3-manual-lineup-position-button=/g) || []).length, 9);
  assert.equal((markup.match(/data-v3-manual-lineup-position-option=/g) || []).length, 90);
  assert.doesNotMatch(markup, /<select[^>]*data-v3-manual-lineup-position/);
  assert.match(markup, /data-picker="actual" data-v3-manual-lineup-slot/);
  assert.match(markup, /data-picker="actual" data-v3-manual-lineup-player/);
  assert.match(markup, /data-v3-manual-lineup-save/);
  assert.match(markup, /data-v3-manual-lineup-finalize/);
});

test("admin pointer操作はthreshold・pointer capture・tap fallbackを持ち、操作payloadは既存actionへ渡す", () => {
  assert.match(coordinatorSource, /manualDragThreshold = 10/);
  assert.match(coordinatorSource, /setPointerCapture/);
  assert.match(coordinatorSource, /actions\.assignManualLineupPlayerToSlot/);
  assert.match(coordinatorSource, /actions\.reorderManualLineup/);
  assert.match(coordinatorSource, /actions\.selectManualLineupPlayer/);
  assert.match(coordinatorSource, /data-v3-manual-lineup-position-option/);
  assert.match(adminSource, /function updateV3ManualLineupPosition/);
  assert.match(coordinatorSource, /preventDefault\?\./);
  assert.doesNotMatch(adminSource, /manualLineupPayload\(state\)[\s\S]*candidateRosterFilter/);
  assert.match(adminHtml, /lineup-builder\.js\?v=shared-lineup-builder-3-position-picker-parity-1/);
  assert.match(adminCss, /manual-lineup-builder\s+\.manual-lineup-slot\.is-drop-target/);
});
