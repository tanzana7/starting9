const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const players = fs.readFileSync(path.join(root, "players.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("吉田賢吾だけに確定済みNPBase個別URLを持たせる", () => {
  assert.match(players, /name: "吉田賢吾"[\s\S]*?npbasePlayerUrl: "https:\/\/npbase\.jp\/players\/f-1ndh33l"/);
  assert.equal((players.match(/npbasePlayerUrl:/g) || []).length, 1);
  assert.match(players, /aliases: \["吉田", "吉田賢", "吉田賢吾", "吉田 賢吾"/);
});

test("選手カードに選択と分離した詳細導線を持つ", () => {
  assert.match(script, /detailButton\.className = "player-chip-detail-button"/);
  assert.match(script, /detailButton\.textContent = "詳細"/);
  assert.match(script, /event\.stopPropagation\(\)/);
  assert.match(script, /assignPlayerToActiveSlot\(pickerName, player\)/);
  assert.match(html, /id="predictionPlayerDetails" class="player-detail-overlay hidden"/);
});

test("詳細パネルは吉田の個別URL、他選手の汎用URL、NPBaseリンクを分ける", () => {
  assert.match(script, /const NPBASE_PLAYER_FALLBACK_URL = "https:\/\/npbase\.jp\/"/);
  assert.match(script, /function getNpbasePlayerUrl\(player\)/);
  assert.match(script, /選手成績を見る（NPBase）/);
  assert.doesNotMatch(script, /対予告先発成績（NPBase）/);
  assert.match(script, /function createProbableStarterHeadingHtml\(\)/);
  assert.match(script, /対予告先発成績/);
  assert.match(script, /target="_blank" rel="noopener noreferrer"/);
  assert.match(script, /成績表示は準備中です。現在はNPBaseへのリンクから確認できます。/);
  assert.match(script, /この選手を選択/);
  assert.doesNotMatch(script, /NPBase公認|NPBase公式連携|提供: NPBase/);
});

test("詳細パネルは登録区分とS9上の候補分類を別データとして表示する", () => {
  assert.match(script, /function getPredictionCandidateLabel\(player, classification = "その他"\)/);
  assert.match(script, /<dt>登録区分<\/dt><dd>\$\{escapeHtml\(player\.registeredPosition \|\| "未設定"\)\}<\/dd>/);
  assert.match(script, /<dt>S9上の扱い<\/dt><dd>\$\{escapeHtml\(predictionCandidateLabel\)\}<\/dd>/);
  assert.doesNotMatch(script, /<dt>登録区分<\/dt><dd>\$\{escapeHtml\(playerCategoryNames\[mainCategory\]/);
  assert.match(players, /name: "矢澤宏太"[\s\S]*?registeredPosition: "投手"[\s\S]*?predictionCandidateLabel: "野手運用候補"/);
  assert.match(players, /name: "山﨑福也"[\s\S]*?registeredPosition: "投手"[\s\S]*?predictionCandidateLabel: "特殊DH候補"/);
  assert.match(players, /name: "柴田獅子"[\s\S]*?registeredPosition: "投手"[\s\S]*?predictionCandidateLabel: "DH候補"/);
});

test("詳細パネルはPC modal、スマホ bottom sheet、閉じる操作を持つ", () => {
  assert.match(script, /function closePlayerDetails\(\)/);
  assert.match(script, /event\.key === "Escape"[\s\S]*?closePlayerDetails\(\)/);
  assert.match(script, /player-detail-close/);
  assert.match(css, /\.player-detail-overlay\s*\{[\s\S]*position: fixed[\s\S]*inset: 0/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.player-detail-overlay[\s\S]*align-items: end[\s\S]*\.player-detail-dialog[\s\S]*border-radius: 16px 16px 0 0/);
});

test("公開assetのcache busterは登録区分分離版へ更新される", () => {
  assert.match(html, /players\.js\?v=public-player-detail-registered-position-1/);
  assert.match(html, /script\.js\?v=public-player-detail-registered-position-1/);
  assert.match(html, /style\.css\?v=public-player-detail-registered-position-1/);
});
