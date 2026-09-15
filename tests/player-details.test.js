const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const detailsSource = fs.readFileSync(path.join(root, "frontend", "public", "fighters-player-details.js"), "utf8");
const displaySource = fs.readFileSync(path.join(root, "frontend", "public", "player-display.js"), "utf8");
const publicScriptSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const lineupSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");
const rosterSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-roster.js"), "utf8");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadPublicHelpers() {
  const window = { Starting9Public: {} };
  vm.runInNewContext(detailsSource, { window });
  vm.runInNewContext(displaySource, { window, globalThis: window });
  return { helpers: window.Starting9Public, details: window.Starting9FightersPlayerDetails };
}

test("NPB一覧由来の静的詳細を84選手へ紐付け、未登録名は安全に未解決にする", () => {
  const { helpers, details } = loadPublicHelpers();
  assert.equal(Object.keys(details).length, 84);
  assert.equal(helpers.getPlayerDetails({ name: "水谷 瞬" }).uniformNumber, "53");
  assert.equal(helpers.getPlayerDetails({ playerName: "郡司 裕也" }).uniformNumber, "3");
  assert.equal(helpers.getPlayerDetails("今川優馬").uniformNumber, "61");
  assert.equal(helpers.getPlayerDetails("存在しない選手"), null);
  assert.equal(helpers.getPlayerDetails({ name: "水谷 瞬" }).registrationType, "支配下");
  assert.equal(helpers.getPlayerDetails({ name: "加藤 大和" }).registrationType, "育成");
});

test("詳細データは投打・カテゴリ・備考を入力資料どおりに保持する", () => {
  const { helpers } = loadPublicHelpers();
  const gunji = helpers.getPlayerDetails("郡司裕也");
  const katou = helpers.getPlayerDetails("加藤大和");
  const transfer = helpers.getPlayerDetails("杉浦稔大");
  assert.deepEqual({ throwingHand: gunji.throwingHand, battingHand: gunji.battingHand, category: gunji.category }, { throwingHand: "右", battingHand: "右", category: "捕手" });
  assert.deepEqual({ throwingHand: katou.throwingHand, battingHand: katou.battingHand, category: katou.category }, { throwingHand: "左", battingHand: "左", category: "投手" });
  assert.equal(transfer.note, "4/14 中日へ移籍");
  assert.equal(helpers.getPlayerDetails("水谷瞬").note, "");
});

test("公開詳細と既存の背番号・打席左右ラインを共存させる", () => {
  assert.match(publicScriptSource, /getPlayerDetails/);
  assert.match(publicScriptSource, /registrationType/);
  assert.match(publicScriptSource, /throwingHand.*battingHand/);
  assert.match(publicScriptSource, /data-player-detail-only/);
  assert.match(publicScriptSource, /player-number/);
  assert.match(indexHtml, /frontend\/public\/fighters-player-details\.js\?v=fighters-player-details-20260903-1/);
  assert.ok(indexHtml.indexOf("fighters-player-details.js") < indexHtml.indexOf("player-display.js"));
});

test("admin-v3のroster候補は詳細を維持し、lineup候補はcompact表示にする", () => {
  const context = { window: { Starting9Public: loadPublicHelpers().helpers } };
  vm.runInNewContext(`${lineupSource}\n${rosterSource}`, context);
  const lineup = context.window.Starting9AdminV3.createAdminV3ManualLineupRenderer({ escapeHtml });
  const roster = context.window.Starting9AdminV3.createAdminV3ManualRosterRenderer({ escapeHtml });
  const catalog = [{ playerId: "F-53", playerName: "水谷 瞬", uniformNumber: "53", bats: "R" }];
  const lineupHtml = lineup.renderCandidates(catalog, { search: "" }, 0);
  const rosterHtml = roster.render({ catalog, entries: [] });
  assert.doesNotMatch(lineupHtml, /player-inline-details|生年月日|詳細/);
  assert.match(rosterHtml, /player-inline-details/);
  assert.match(adminHtml, /fighters-player-details\.js\?v=fighters-player-details-20260903-1/);
});

test("詳細表示はraw JSONや外部fetchを追加せず、保存payloadから分離される", () => {
  assert.doesNotMatch(detailsSource, /fetch\s*\(/);
  assert.doesNotMatch(detailsSource, /rawHtml|rawResponse|responseBody/);
  assert.doesNotMatch(publicScriptSource, /lineupItem\.player.*registrationType|registrationType.*lineupItem\.player/);
  assert.match(publicScriptSource, /showPlayerDetails\("prediction", trigger\.dataset\.playerDetailOnly, \{ allowSelect: false \}\)/);
});
