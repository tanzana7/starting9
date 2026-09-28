const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const lineupSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");
const rosterSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-roster.js"), "utf8");
const html = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const css = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadRenderers() {
  const context = { window: { Starting9Public: {} } };
  vm.runInNewContext(`${lineupSource}\n${rosterSource}`, context);
  return context.window.Starting9AdminV3;
}

test("manual lineup候補はactive rosterを先頭にして背番号順の2列compactカードとして描画する", () => {
  const renderers = loadRenderers();
  const renderer = renderers.createAdminV3ManualLineupRenderer({ escapeHtml });
  const catalog = [
    { playerId: "F-53", playerName: "水谷 瞬", uniformNumber: "53", category: "外野手", manualRosterActive: true },
    { playerId: "F-3", playerName: "郡司 裕也", uniformNumber: "3", category: "捕手", manualRosterActive: true },
    { playerId: "F-43", playerName: "水野 達稀", uniformNumber: "43", category: "内野手", manualRosterActive: false }
  ];
  const html = renderer.renderCandidates(catalog, { search: "" }, 0);
  assert.ok(html.indexOf("[3]") < html.indexOf("[53]"));
  assert.ok(html.indexOf("[53]") < html.indexOf("[43]"));
  assert.equal((html.match(/data-v3-manual-lineup-player-id=/g) || []).length, 3);
  assert.doesNotMatch(html, /捕手|内野手|ロースター内|ロースター外|manual-player-candidate-meta|詳細/);
  assert.match(html, /data-v3-manual-lineup-player-id="F-53"/);
  assert.doesNotMatch(html, /slice\(0, 6\)/);
});

test("manual lineup候補はplayerIdを優先し、必要時だけ既存の名前正規化でroster判定する", () => {
  const renderers = loadRenderers();
  const renderer = renderers.createAdminV3ManualLineupRenderer({ escapeHtml });
  const catalog = [
    { playerId: "F-53", playerName: "同名", uniformNumber: "53", category: "外野手" },
    { playerId: "F-3", playerName: "同名", uniformNumber: "3", category: "捕手" },
    { playerId: "", playerName: "  名前　fallback。 ", uniformNumber: "7", category: "内野手" },
    { playerId: "F-2", playerName: "ロースター外", uniformNumber: "2", category: "内野手" },
    { playerId: "F-99", playerName: "番号不明", uniformNumber: "", category: "外野手" }
  ];
  const manualRoster = {
    isManualSaved: true,
    entries: [
      { playerId: "F-53", playerName: "同名", status: "active" },
      { playerId: "F-3", playerName: "同名", status: "inactive" },
      { playerId: "", playerName: "[7] 名前\u3000fallback。", status: "active" }
    ]
  };
  const html = renderer.renderCandidates(catalog, { search: "" }, 0, manualRoster);
  assert.ok(html.indexOf("[53]") < html.indexOf("[2]"));
  assert.ok(html.indexOf("[2]") < html.indexOf("[3]"));
  assert.ok(html.indexOf("[3]") < html.indexOf("番号不明"));
  assert.equal((html.match(/data-v3-manual-lineup-player-id=/g) || []).length, 5);
  assert.doesNotMatch(html, /manual-player-candidate-meta|詳細/);
  assert.ok(html.indexOf("名前") < html.indexOf("[53]"));
});

test("manual rosterのAUTOはeffectiveActiveを使い、INACTIVEはroster外として扱う", () => {
  const renderers = loadRenderers();
  const renderer = renderers.createAdminV3ManualLineupRenderer({ escapeHtml });
  const catalog = [
    { playerId: "F-10", playerName: "Active ten", uniformNumber: "10" },
    { playerId: "F-01", playerName: "Inactive one", uniformNumber: "1" },
    { playerId: "F-21", playerName: "Active twenty one", uniformNumber: "21" },
    { playerId: "F-05", playerName: "AUTO inactive five", uniformNumber: "5" },
    { playerId: "F-02", playerName: "Active two", uniformNumber: "2" },
    { playerId: "F-22", playerName: "AUTO active twenty two", uniformNumber: "22" },
    { playerId: "F-99", playerName: "Unknown number", uniformNumber: "" }
  ];
  const html = renderer.renderCandidates(catalog, { search: "" }, 0, {
    isManualSaved: true,
    entries: [
      { playerId: "F-10", mode: "active" },
      { playerId: "F-01", mode: "inactive" },
      { playerId: "F-21", mode: "active" },
      { playerId: "F-05", mode: "auto", effectiveActive: false },
      { playerId: "F-02", mode: "active" },
      { playerId: "F-22", mode: "auto", effectiveActive: true }
    ]
  });
  assert.ok(html.indexOf("[2]") < html.indexOf("[10]"));
  assert.ok(html.indexOf("[10]") < html.indexOf("[21]"));
  assert.ok(html.indexOf("[21]") < html.indexOf("[22]"));
  assert.ok(html.indexOf("[22]") < html.indexOf("[1]"));
  assert.ok(html.indexOf("[1]") < html.indexOf("[5]"));
  assert.ok(html.indexOf("[5]") < html.indexOf("Unknown number"));
});

test("manual rosterのstatic fallbackではcatalogのactive表示と優先順を維持する", () => {
  const renderers = loadRenderers();
  const renderer = renderers.createAdminV3ManualLineupRenderer({ escapeHtml });
  const html = renderer.renderCandidates([
    { playerId: "F-18", playerName: "投手", uniformNumber: "18", manualRosterActive: false, manualRosterStatus: null },
    { playerId: "F-53", playerName: "野手", uniformNumber: "53", manualRosterActive: true, manualRosterStatus: "active" }
  ], { search: "" }, 0, { schemaAvailable: false, source: "static-fallback", entries: [] });
  assert.ok(html.indexOf("[53]") < html.indexOf("[18]"));
  assert.doesNotMatch(html, /manual-player-candidate-meta|ロースター内|ロースター外（確認要）/);
});

test("manual roster候補はactive/inactiveを含む全選手をスクロール選択できる", () => {
  const renderers = loadRenderers();
  const renderer = renderers.createAdminV3ManualRosterRenderer({ escapeHtml });
  const catalog = [
    { playerId: "F-53", playerName: "水谷 瞬", uniformNumber: "53", category: "外野手" },
    { playerId: "F-3", playerName: "郡司 裕也", uniformNumber: "3", category: "捕手" },
    { playerId: "F-43", playerName: "水野 達稀", uniformNumber: "43", category: "内野手" }
  ];
  const html = renderer.render({
    catalog,
    entries: [
      { playerId: "F-3", status: "inactive", note: "" },
      { playerId: "F-43", status: "active", note: "" }
    ],
    search: ""
  });
  assert.ok(html.indexOf("[3]") < html.indexOf("[43]"));
  assert.ok(html.indexOf("[43]") < html.indexOf("[53]"));
  assert.match(html, /manual-roster-candidate selected inactive/);
  assert.match(html, /INACTIVE \/ 手動固定 \/ INACTIVE \/ ACTIVE化/);
  assert.match(html, /AUTO \/ 公式ロースター追従/);
  assert.doesNotMatch(html, /data-v3-manual-roster-add="F-3"[^>]*disabled/);
  assert.match(html, /data-v3-manual-roster-add="F-43"[^>]*disabled/);
  assert.match(html, /data-v3-manual-roster-add="F-53"/);
  assert.doesNotMatch(html, /slice\(0, 12\)/);
});

test("admin-v3候補領域は内部スクロールとcache busterを持つ", () => {
  assert.match(css, /\.manual-lineup-candidates[^\{]*\{[^}]*max-height: 220px/);
  assert.match(css, /\.manual-lineup-candidates[^\{]*\{[^}]*overflow-y: auto/);
  assert.match(css, /\.manual-roster-candidates[^\{]*\{[^}]*max-height: 300px/);
  assert.match(css, /\.manual-roster-candidates[^\{]*\{[^}]*overflow-y: auto/);
  assert.match(css, /overscroll-behavior: contain/);
  assert.match(css, /\.manual-lineup-builder \.manual-lineup-candidates\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)/);
  assert.match(html, /admin-v3\.css\?v=independent-roster-lineup-safety-1-admin-player-scroll-picker-1-selection-highlight-1-lineup-order-mobile-zoom-1/);
  assert.match(html, /render-manual-lineup\.js\?v=independent-roster-lineup-safety-1-admin-player-scroll-picker-1-game-selection-safety-1-lineup-order-mobile-zoom-1/);
  assert.match(html, /render-manual-roster\.js\?v=independent-roster-lineup-safety-1-admin-player-scroll-picker-1-manual-roster-auto-1-manual-roster-persistent-mode-1/);
});

test("admin-v3のmobile候補タップは16px以上・touch-actionを使い、viewportでズームを無効化しない", () => {
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 720px)"));
  assert.match(mobileBlock, /\.admin-v3-shell button[\s\S]*\.admin-v3-shell textarea \{ font-size: 16px; \}/);
  assert.match(mobileBlock, /\.manual-lineup-candidate,[\s\S]*\.manual-roster-candidate \{ touch-action: manipulation; \}/);
  assert.doesNotMatch(html, /user-scalable\s*=\s*["']?no/i);
  assert.doesNotMatch(html, /maximum-scale\s*=\s*1(?:\.0+)?/i);
  assert.match(mobileBlock, /\.manual-lineup-grid \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.manual-lineup-candidates[^\{]*\{[^}]*overflow-y: auto/);
});

