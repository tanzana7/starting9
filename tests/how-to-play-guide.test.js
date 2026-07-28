const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "how-to-play.html"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("トップページから遊び方・採点ルールへ移動でき、案内ページから戻れる", () => {
  assert.match(index, /href="\.\/how-to-play\.html"[^>]*>遊び方・採点ルール/);
  assert.match(html, /href="\.\/index\.html"[^>]*>← トップへ戻る/);
  assert.match(html, /<title>遊び方・採点ルール \| Starting9<\/title>/);
});

test("案内ページの採点ルールは現在の100点方式と一致する", () => {
  assert.match(script, /player:\s*\{[\s\S]*perHit: 5[\s\S]*bonus: 5[\s\S]*max: 50/);
  assert.match(script, /order:\s*\{[\s\S]*perHit: 3[\s\S]*bonus: 3[\s\S]*max: 30/);
  assert.match(script, /position:\s*\{[\s\S]*perHit: 2[\s\S]*bonus: 2[\s\S]*max: 20/);
  assert.match(html, /1人につき5点/);
  assert.match(html, /9人全員一致でボーナス5点/);
  assert.match(html, /1人につき3点/);
  assert.match(html, /9人全員一致でボーナス3点/);
  assert.match(html, /1人につき2点/);
  assert.match(html, /9人全員一致でボーナス2点/);
  assert.match(html, /合計100点/);
});

test("案内ページは現在のランキング区分と非公式サービスの注意書きを説明する", () => {
  assert.match(html, /月間・年間ランキング/);
  assert.doesNotMatch(html, /デイリーランキング/);
  assert.match(html, /非公式サービス/);
  assert.match(html, /球団、NPB、選手その他の公式団体とは関係ありません/);
  assert.match(html, /スタメン訂正・再採点/);
});

test("案内ページは既存の青基調とモバイル用レイアウトを持つ", () => {
  assert.match(html, /class="guide-steps"/);
  assert.match(html, /class="guide-score-grid"/);
  assert.match(css, /\.guide-section\s*\{[\s\S]*border: 1px solid var\(--border\)/);
  assert.match(css, /\.guide-steps,\s*\.guide-score-grid\s*\{[\s\S]*grid-template-columns: 1fr/);
});
