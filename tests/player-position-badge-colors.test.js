const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const publicDisplaySource = fs.readFileSync(path.join(root, "frontend", "public", "player-display.js"), "utf8");
const fightersDetailsSource = fs.readFileSync(path.join(root, "frontend", "public", "fighters-player-details.js"), "utf8");
const publicScriptSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
const lineupRendererSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");
const rosterRendererSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-roster.js"), "utf8");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadPublicDisplay() {
  const context = { window: { Starting9Public: {} } };
  vm.runInNewContext(publicDisplaySource, context);
  return context.window.Starting9Public;
}

function loadPublicDisplayWithFightersDetails() {
  const context = { window: { Starting9Public: {} } };
  vm.runInNewContext(fightersDetailsSource, context);
  vm.runInNewContext(publicDisplaySource, context);
  return context.window.Starting9Public;
}

function loadAdminRenderers() {
  const context = { window: { Starting9Public: loadPublicDisplay() } };
  vm.runInNewContext(`${lineupRendererSource}\n${rosterRendererSource}`, context);
  return context.window.Starting9AdminV3;
}

test("打席左右だけを右・左・両の色ラインclassへ変換する", () => {
  const helpers = loadPublicDisplay();
  assert.equal(helpers.getPlayerBattingClass({ bats: "R" }), "player-name--bat-right");
  assert.equal(helpers.getPlayerBattingClass({ battingSide: "左打" }), "player-name--bat-left");
  assert.equal(helpers.getPlayerBattingClass({ batSide: "switch" }), "player-name--bat-switch");
  assert.equal(helpers.getPlayerBattingClass({ handedness: "右投左打" }), "player-name--bat-left");
});

test("Fighters静的詳細の投打情報から打席左右ラインclassを解決する", () => {
  const helpers = loadPublicDisplayWithFightersDetails();
  assert.equal(helpers.getPlayerBattingClass({ playerName: "水谷 瞬" }), "player-name--bat-right");
  assert.equal(helpers.getPlayerBattingClass({ playerName: "郡司 裕也" }), "player-name--bat-right");
  assert.equal(helpers.getPlayerBattingClass({ playerName: "水野 達稀" }), "player-name--bat-left");
  assert.equal(helpers.getPlayerBattingClass({ playerName: "矢澤 宏太" }), "player-name--bat-left");
});

test("守備位置の右左や投球左右は打席左右として誤表示しない", () => {
  const helpers = loadPublicDisplay();
  assert.equal(helpers.getPlayerBattingClass({ position: "右" }), "");
  assert.equal(helpers.getPlayerBattingClass({ throws: "R" }), "");
  assert.equal(helpers.getPlayerBattingClass({ handedness: "右投" }), "");
  assert.equal(helpers.getPlayerBattingClass({ bats: "unknown" }), "");
  assert.equal(helpers.getPlayerBattingClass(null), "");
});

test("既存の背番号fieldだけを選手名の左側表示へ変換し、不正値は隠す", () => {
  const helpers = loadPublicDisplay();
  for (const [field, value] of [
    ["uniformNumber", "53"],
    ["jerseyNumber", 7],
    ["number", "12"],
    ["playerNumber", "8"],
    ["backNumber", "0"],
    ["uniform_no", "99"],
    ["jersey_no", "3"]
  ]) {
    assert.equal(helpers.getPlayerUniformNumber({ [field]: value }), String(value));
  }
  assert.equal(helpers.getPlayerUniformNumber({ metadata: { uniformNumber: "21" } }), "21");
  assert.equal(helpers.getPlayerUniformNumber({ uniformNumber: "53", bats: "L" }), "53");
  for (const value of ["", "unknown", "53番", "1000", null, {}, []]) {
    assert.equal(helpers.getPlayerUniformNumber({ uniformNumber: value }), "");
  }
});

test("公開画面は選手名欄と保存済み表示へ打席左右classを適用し、既存処理を残す", () => {
  assert.match(publicScriptSource, /getPlayerBattingClass/);
  assert.match(publicScriptSource, /getPlayerUniformNumber/);
  assert.match(publicScriptSource, /player-number/);
  assert.match(publicScriptSource, /createPlayerNameHtml\(playerName/);
  assert.match(publicScriptSource, /createPlayerNameHtml\(lineupItem\.player, "saved-lineup-name"\)/);
  assert.match(publicScriptSource, /createPlayerNameHtml\(player \|\| "-", "result-player-name"\)/);
  assert.match(publicScriptSource, /player\.position/);
});

test("admin manual lineup候補と選択済み表示に打席左右ラインclassを付ける", () => {
  const renderers = loadAdminRenderers();
  const renderer = renderers.createAdminV3ManualLineupRenderer({ escapeHtml });
  const catalog = [
    { playerId: "F-1", playerName: "右打選手", uniformNumber: "1", bats: "R" },
    { playerId: "F-2", playerName: "左打選手", uniformNumber: "2", bats: "L" },
    { playerId: "F-3", playerName: "両打選手", uniformNumber: "3", bats: "S" },
    { playerId: "F-4", playerName: "不明選手", uniformNumber: "4", position: "右" }
  ];
  const html = renderer.renderCandidates(catalog, { search: "" }, 0);
  assert.match(html, /player-name player-name--bat-right">[\s\S]*\[1\][\s\S]*右打選手/);
  assert.match(html, /player-name player-name--bat-left">[\s\S]*\[2\][\s\S]*左打選手/);
  assert.match(html, /player-name player-name--bat-switch">[\s\S]*\[3\][\s\S]*両打選手/);
  assert.match(html, /class="player-name">[\s\S]*\[4\][\s\S]*不明選手/);
  const selected = renderer.render({ workflowState: "scheduled" }, { lineup: { playerCatalog: catalog } }, {
    rows: [{ battingOrder: 1, position: "右", playerId: "F-1", search: "" }, ...Array.from({ length: 8 }, (_, index) => ({ battingOrder: index + 2, position: "", playerId: "", search: "" }))]
  });
  assert.match(selected, /player-name player-name--bat-right">[\s\S]*\[1\][\s\S]*右打選手/);
});

test("admin manual roster候補と登録済み表示に打席左右ラインclassを付け、未知値は表示しない", () => {
  const renderers = loadAdminRenderers();
  const renderer = renderers.createAdminV3ManualRosterRenderer({ escapeHtml });
  const state = {
    catalog: [
      { playerId: "F-1", playerName: "左打選手", uniformNumber: "1", battingSide: "left" },
      { playerId: "F-2", playerName: "不明選手", uniformNumber: "2", position: "左" }
    ],
    entries: [{ playerId: "F-1", status: "active", note: "" }]
  };
  const html = renderer.render(state);
  assert.match(html, /player-name player-name--bat-left">[\s\S]*\[1\][\s\S]*左打選手/);
  assert.match(html, /class="player-name">[\s\S]*\[2\][\s\S]*不明選手/);
});

test("admin表示もFighters静的詳細の打席左右を選手名へ反映する", () => {
  const context = { window: { Starting9Public: loadPublicDisplayWithFightersDetails() } };
  vm.runInNewContext(`${lineupRendererSource}\n${rosterRendererSource}`, context);
  const lineupRenderer = context.window.Starting9AdminV3.createAdminV3ManualLineupRenderer({ escapeHtml });
  const rosterRenderer = context.window.Starting9AdminV3.createAdminV3ManualRosterRenderer({ escapeHtml });
  const catalog = [
    { playerId: "F-53", playerName: "水谷 瞬", uniformNumber: "53" },
    { playerId: "F-43", playerName: "水野 達稀", uniformNumber: "43" }
  ];
  const lineup = lineupRenderer.renderCandidates(catalog, { search: "" }, 0);
  const roster = rosterRenderer.render({ catalog, entries: [] });
  assert.match(lineup, /player-name player-name--bat-right[\s\S]*\[53\][\s\S]*水谷 瞬/);
  assert.match(lineup, /player-name player-name--bat-left[\s\S]*\[43\][\s\S]*水野 達稀/);
  assert.match(roster, /player-name player-name--bat-right[\s\S]*\[53\][\s\S]*水谷 瞬/);
  assert.match(roster, /player-name player-name--bat-left[\s\S]*\[43\][\s\S]*水野 達稀/);
});

test("admin表示は不正な背番号を表示せず、正常値は#形式を重ねない", () => {
  const renderers = loadAdminRenderers();
  const lineupRenderer = renderers.createAdminV3ManualLineupRenderer({ escapeHtml });
  const rosterRenderer = renderers.createAdminV3ManualRosterRenderer({ escapeHtml });
  const catalog = [
    { playerId: "F-1", playerName: "背番号選手", uniformNumber: "53" },
    { playerId: "F-2", playerName: "不正番号", uniformNumber: "53番" }
  ];
  const lineup = lineupRenderer.renderCandidates(catalog, { search: "" }, 0);
  assert.match(lineup, /\[53\][\s\S]*背番号選手/);
  assert.doesNotMatch(lineup, /#53/);
  assert.match(lineup, /不正番号/);
  assert.doesNotMatch(lineup, /\[53番\]/);
  const roster = rosterRenderer.render({ catalog, entries: [] });
  assert.match(roster, /\[53\][\s\S]*背番号選手/);
  assert.doesNotMatch(roster, /#53/);
  assert.match(roster, /不正番号/);
  assert.doesNotMatch(roster, /\[53番\]/);
});

test("色ラインは固定幅でスマホ表示を圧迫せず、未知・空値は余白を追加しない", () => {
  const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
  const adminCss = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
  for (const source of [css, adminCss]) {
    assert.match(source, /:has\(\.player-name--bat-right\)::before[\s\S]*inset: 4px auto 4px 0[\s\S]*width: 4px/);
    assert.match(source, /:has\(\.player-name--bat-right\)::before[\s\S]*background: #d64545/);
    assert.match(source, /:has\(\.player-name--bat-left\)::before[\s\S]*background: #2878c8/);
    assert.match(source, /:has\(\.player-name--bat-switch\)::before[\s\S]*background: #2f9a62/);
  }
  assert.match(css, /\.lineup-slot:has\(\.player-name--bat-right\)::before/);
  assert.match(css, /\.saved-lineup-row:has\(\.player-name--bat-left\)::before/);
  assert.match(adminCss, /\.manual-player-candidate-row:has\(\.player-name--bat-right\)::before/);
  assert.match(adminCss, /\.manual-roster-row:has\(\.player-name--bat-left\)::before/);
});
