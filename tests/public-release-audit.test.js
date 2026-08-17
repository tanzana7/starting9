const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("公開HTMLには公開準備向けの基本メタ情報があり、noindexがない", () => {
  const html = read("index.html");
  assert.match(html, /<title>Starting9 \| ファイターズのスタメン予想<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.match(html, /<meta property="og:title"/);
  assert.match(html, /<meta property="og:description"/);
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.doesNotMatch(html, /name="robots" content="noindex/i);
});

test("公開画面に管理・修復・fixtureの一般導線やdebug残骸を含めない", () => {
  const html = read("index.html");
  const script = read("script.js");
  assert.doesNotMatch(html, /admin-v3|game-identity-repair|RELEASE_DEBUG|debug_fixture|fixtureKey/i);
  assert.doesNotMatch(script, /\/api\/admin|RELEASE_DEBUG|debug_fixture|fixtureKey|game-identity-repair/i);
  assert.doesNotMatch(html, /スコアの比較|全国平均|比較データは参加者が増え次第表示されます/);
});

test("admin-v3は検索除外され、公開結果の比較ブロックは描画しない", () => {
  const adminHtml = read("admin-v3.html");
  const resultRenderer = read("frontend/public/render-results.js");
  assert.match(adminHtml, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(adminHtml, /admin-v3\.js/);
  assert.doesNotMatch(resultRenderer, /スコアの比較|全国平均|比較データは参加者が増え次第表示されます/);
});

test("NPBase外部リンクは誤認を招く表現なしで安全なrel属性を持つ", () => {
  const script = read("script.js");
  assert.match(script, /選手成績を見る（NPBase）/);
  assert.match(script, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(script, /NPBase公認|NPBase公式連携|提供データ/);
});
