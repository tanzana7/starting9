const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const sharedSource = fs.readFileSync(path.join(root, "frontend", "shared", "lineup-builder.js"), "utf8");
const detailsSource = fs.readFileSync(path.join(root, "frontend", "public", "fighters-player-details.js"), "utf8");
const displaySource = fs.readFileSync(path.join(root, "frontend", "public", "player-display.js"), "utf8");
const lineupSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");
const rosterSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-roster.js"), "utf8");
const coordinatorSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "app-coordinator.js"), "utf8");
const publicScriptSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const adminCss = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function loadRenderers() {
  const context = { window: {}, Map, Set, Number, Intl, Date };
  vm.createContext(context);
  vm.runInContext(detailsSource, context);
  vm.runInContext(displaySource, context);
  vm.runInContext(sharedSource, context);
  vm.runInContext(`${lineupSource}\n${rosterSource}`, context);
  return context.window;
}

test("publicとadminは共有lineup builderの選手名・背番号・候補ソートを使う", () => {
  const window = loadRenderers();
  const player = { playerId: "F-53", playerName: "水谷 瞬", uniformNumber: "53", bats: "R" };
  const markup = window.Starting9LineupBuilder.renderPlayerName(player, escapeHtml);
  assert.match(markup, /player-name--bat-right/);
  assert.match(markup, /\[53\]<\/span> 水谷 瞬/);
  const sorted = window.Starting9LineupBuilder.sortPlayers([
    { playerId: "inactive", playerName: "後列", uniformNumber: "1", manualRosterActive: false },
    { playerId: "active", playerName: "先頭", uniformNumber: "99", manualRosterActive: true }
  ]);
  assert.deepEqual(Array.from(sorted, (entry) => entry.playerId), ["active", "inactive"]);
  assert.match(publicScriptSource, /Starting9LineupBuilder\?\.renderPlayerName/);
});

test("admin manual lineupはpublic同様の2ペイン・9スロット・候補一覧を使い、formal actionを維持する", () => {
  const window = loadRenderers();
  const renderer = window.Starting9AdminV3.createAdminV3ManualLineupRenderer({ escapeHtml });
  const rows = renderer.createBlankRows();
  rows[2] = { ...rows[2], playerId: "F-53", playerName: "水谷 瞬", uniformNumber: "53", position: "右", search: "" };
  const catalog = [
    { playerId: "F-3", playerName: "郡司 裕也", uniformNumber: "3", bats: "R", category: "捕手" },
    { playerId: "F-43", playerName: "水野 達稀", uniformNumber: "43", bats: "L", category: "内野手" },
    { playerId: "F-53", playerName: "水谷 瞬", uniformNumber: "53", bats: "R", category: "外野手" }
  ];
  const markup = renderer.render(
    { gameDate: "2026-09-14", homeTeam: "fighters", awayTeam: "hawks", startAt: "2026-09-14T09:00:00.000Z", internalGameId: "game-1" },
    { lineup: { playerCatalog: catalog } },
    { rows, activeIndex: 2 }
  );
  assert.equal((markup.match(/data-v3-manual-lineup-slot=/g) || []).length, 9);
  assert.match(markup, /class="lineup-builder manual-lineup-builder manual-lineup-grid"/);
  assert.match(markup, /data-v3-manual-lineup-search="2"/);
  assert.match(markup, /data-v3-manual-lineup-candidates="2"/);
  assert.match(markup, /data-v3-manual-lineup-player="2"/);
  assert.match(markup, /\[53\]<\/span> 水谷 瞬/);
  assert.match(markup, /data-v3-manual-lineup-save/);
  assert.match(markup, /data-v3-manual-lineup-finalize/);
  assert.doesNotMatch(markup, /prediction.*save/i);
});

test("選択スロットを変えると候補の追加先だけが変わり、候補カードはcompact表示になる", () => {
  const window = loadRenderers();
  const renderer = window.Starting9AdminV3.createAdminV3ManualLineupRenderer({ escapeHtml });
  const row = renderer.createBlankRows()[0];
  const catalog = [{ playerId: "F-3", playerName: "郡司 裕也", uniformNumber: "3", bats: "R", category: "捕手", manualRosterActive: false }];
  const candidates = renderer.renderCandidates(catalog, row, 5);
  assert.match(candidates, /class="player-chip manual-lineup-candidate/);
  assert.match(candidates, /data-v3-manual-lineup-player="5"/);
  assert.doesNotMatch(candidates, /詳細|manual-player-candidate-meta|ロースター外/);
  const markup = renderer.render({}, { lineup: { playerCatalog: catalog } }, { rows: renderer.createBlankRows(), activeIndex: 5 });
  assert.match(markup, /manual-lineup-confirmation-list/);
  assert.match(markup, /data-v3-manual-lineup-search="5"/);
  assert.match(markup, /class="slot-order" aria-label="打順 1番">1番<\/span>/);
  assert.doesNotMatch(markup, /manual-lineup-fixed-order|manual-lineup-position-label/);
  assert.match(rosterSource, /Starting9LineupBuilder/);
});

test("adminはクリックしたスロットを候補追加先として選び、公開保存経路を呼ばない", () => {
  const context = { window: {} };
  vm.runInNewContext(coordinatorSource, context);
  const listeners = new Map();
  const calls = [];
  const document = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    getElementById() { return null; },
    querySelector() { return null; }
  };
  const actions = new Proxy({
    restoreInitialRoute() {},
    load() {},
    selectManualLineupSlot(index) { calls.push(index); }
  }, { get(target, property) { return target[property] || (() => {}); } });
  context.window.Starting9AdminV3.createAdminV3Coordinator({
    document, window: { addEventListener() {} }, state: {}, actions
  }).start();
  const slot = {
    dataset: { v3ManualLineupSlot: "4" },
    closest(selector) {
      return selector === "[data-v3-manual-lineup-slot]" ? this : null;
    }
  };
  listeners.get("click")({ target: slot });
  assert.deepEqual(calls, [4]);
  assert.doesNotMatch(coordinatorSource, /savePrediction/);
});

test("shared lineup builderの配信順とadmin mobile layoutが定義されている", () => {
  assert.ok(indexHtml.indexOf("frontend/shared/lineup-builder.js") < indexHtml.indexOf("script.js"));
  assert.ok(adminHtml.indexOf("frontend/shared/lineup-builder.js") < adminHtml.indexOf("admin-v3.js"));
  assert.match(adminCss, /\.manual-lineup-builder\s*\{/);
  assert.match(adminCss, /@media \(max-width: 540px\)[\s\S]*?\.manual-lineup-builder \{ grid-template-columns: 1fr; \}/);
});
