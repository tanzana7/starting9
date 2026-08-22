const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const displaySource = fs.readFileSync(path.join(root, "frontend", "public", "player-display.js"), "utf8");
const scriptSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const playersSource = fs.readFileSync(path.join(root, "players.js"), "utf8");

function loadDisplayHelpers() {
  const window = { Starting9Public: {} };
  vm.runInNewContext(displaySource, { window, globalThis: window });
  return window.Starting9Public;
}

test("日本人選手の表示名だけを姓と名に分ける", () => {
  const helpers = loadDisplayHelpers();
  const names = {
    郡司裕也: "郡司 裕也",
    田宮裕涼: "田宮 裕涼",
    上川畑大悟: "上川畑 大悟",
    清宮幸太郎: "清宮 幸太郎",
    水野達稀: "水野 達稀",
    進藤勇也: "進藤 勇也",
    奈良間大己: "奈良間 大己",
    吉田賢吾: "吉田 賢吾",
    野村佑希: "野村 佑希",
    有薗直輝: "有薗 直輝",
    五十幡亮汰: "五十幡 亮汰"
  };
  Object.entries(names).forEach(([raw, expected]) => {
    assert.equal(helpers.formatPlayerNameForDisplay(raw), expected);
  });
});

test("外国人登録名・カタカナ名・未知の名前は変更しない", () => {
  const helpers = loadDisplayHelpers();
  assert.equal(helpers.formatPlayerNameForDisplay("レイエス"), "レイエス");
  assert.equal(helpers.formatPlayerNameForDisplay("カストロ"), "カストロ");
  assert.equal(helpers.formatPlayerNameForDisplay("エドポロケイン"), "エドポロケイン");
  assert.equal(helpers.formatPlayerNameForDisplay("リン"), "リン");
  assert.equal(helpers.formatPlayerNameForDisplay("登録名"), "登録名");
});

test("表示メタデータの姓・名にも対応し、既存の空白は安全に扱う", () => {
  const helpers = loadDisplayHelpers();
  assert.equal(
    helpers.formatJapanesePlayerNameForDisplay("テスト選手", { familyName: "テスト", givenName: "選手" }),
    "テスト 選手"
  );
  assert.equal(helpers.formatPlayerNameForDisplay("郡司 裕也"), "郡司 裕也");
  assert.equal(helpers.formatPlayerNameForDisplay({ name: "水野達稀" }), "水野 達稀");
});

test("表示整形は保存値・照合用のcanonical nameを変更しない", () => {
  assert.match(playersSource, /name: "郡司裕也"/);
  assert.match(playersSource, /name: "田宮裕涼"/);
  assert.match(scriptSource, /playerName: player\.name/);
  assert.match(scriptSource, /formatPlayerNameForDisplay\(lineupItem\.player/);
  assert.match(scriptSource, /const displayName = formatPlayerNameForDisplay\(player \|\| "-"\)/);
  assert.match(scriptSource, /formatPlayerNameForDisplay\(player \|\| "-"\)/);
});

test("公開entryは選手表示フォーマッタをcache buster付きで先に読み込む", () => {
  const cacheBuster = "public-load-performance-optimization-1";
  assert.match(html, new RegExp(`frontend/public/player-display\\.js\\?v=${cacheBuster}`));
  assert.match(html, new RegExp(`script\\.js\\?v=${cacheBuster}`));
  assert.ok(html.indexOf("frontend/public/player-display.js") < html.indexOf("script.js"));
});
