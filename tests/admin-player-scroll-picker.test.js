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

test("manual lineup候補は全件を背番号順のスクロール対象として描画する", () => {
  const renderers = loadRenderers();
  const renderer = renderers.createAdminV3ManualLineupRenderer({ escapeHtml });
  const catalog = [
    { playerId: "F-53", playerName: "水谷 瞬", uniformNumber: "53", category: "外野手", manualRosterActive: true },
    { playerId: "F-3", playerName: "郡司 裕也", uniformNumber: "3", category: "捕手", manualRosterActive: true },
    { playerId: "F-43", playerName: "水野 達稀", uniformNumber: "43", category: "内野手", manualRosterActive: false }
  ];
  const html = renderer.renderCandidates(catalog, { search: "" }, 0);
  assert.ok(html.indexOf("[3]") < html.indexOf("[43]"));
  assert.ok(html.indexOf("[43]") < html.indexOf("[53]"));
  assert.match(html, /捕手 \/ ロースター内/);
  assert.match(html, /内野手 \/ ロースター外（確認要）/);
  assert.match(html, /data-v3-manual-lineup-player-id="F-53"/);
  assert.match(html, /manual-player-candidate-meta/);
  assert.doesNotMatch(html, /slice\(0, 6\)/);
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
  assert.match(html, /inactive \/ active化/);
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
  assert.match(html, /admin-v3\.css\?v=independent-roster-lineup-safety-1-admin-player-scroll-picker-1/);
  assert.match(html, /render-manual-lineup\.js\?v=independent-roster-lineup-safety-1-admin-player-scroll-picker-1/);
  assert.match(html, /render-manual-roster\.js\?v=independent-roster-lineup-safety-1-admin-player-scroll-picker-1/);
});

