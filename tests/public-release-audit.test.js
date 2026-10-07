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
  assert.match(html, /<meta property="og:url" content="https:\/\/starting9-app\.pages\.dev\/">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/starting9-app\.pages\.dev\/assets\/starting9-ogp-20260918\.png">/);
  assert.match(html, /<meta property="og:image:width" content="1200">/);
  assert.match(html, /<meta property="og:image:height" content="630">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<meta name="twitter:image" content="https:\/\/starting9-app\.pages\.dev\/assets\/starting9-ogp-20260918\.png">/);
  assert.doesNotMatch(html, /https:\/\/starting9\.pages\.dev\//);
  assert.doesNotMatch(html, /name="robots" content="noindex/i);
});

test("X/OGP画像は標準比率のPNGとしてリポジトリに存在する", () => {
  const image = fs.readFileSync(path.join(root, "assets/starting9-ogp-20260918.png"));
  assert.deepEqual([...image.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
  assert.ok(image.length < 2_000_000);
});

test("公開トップと遊び方から利用規約・プライバシー・問い合わせへ移動できる", () => {
  for (const file of ["index.html", "how-to-play.html"]) {
    const html = read(file);
    assert.match(html, /href="\.\/how-to-play\.html"/);
    assert.match(html, /href="\.\/terms\.html"/);
    assert.match(html, /href="\.\/privacy\.html"/);
    assert.match(html, /href="\.\/contact\.html"/);
  }
});

test("法務・問い合わせページは公開ページとしてmeta情報と相互導線を持つ", () => {
  for (const file of ["terms.html", "privacy.html", "contact.html"]) {
    const html = read(file);
    assert.match(html, /<title>Starting9 \| [^<]+<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<meta property="og:title"/);
    assert.match(html, /<meta property="og:description"/);
    assert.doesNotMatch(html, /name="robots" content="noindex/i);
    assert.match(html, /href="\.\/terms\.html"/);
    assert.match(html, /href="\.\/privacy\.html"/);
    assert.match(html, /href="\.\/contact\.html"/);
  }
});

test("法務・問い合わせページは非公式サービスと外部リンク方針を明記する", () => {
  const terms = read("terms.html");
  const privacy = read("privacy.html");
  const contact = read("contact.html");
  assert.match(terms, /NPB、球団、選手、NPBaseその他の団体・サービスとは公式な関係がありません/);
  assert.doesNotMatch(`${terms}${privacy}${contact}`, /NPBase公認|NPBase公式連携|NPBaseのデータを転載|スクレイピング|キャッシュ/);
  assert.match(privacy, /Cloudflare Pages、Cloudflare Workers、Cloudflare D1/);
  assert.match(privacy, /外部サイトのデータを転載・収集・保存するものではありません/);
  assert.match(contact, /https:\/\/x\.com\/n3_mmy/);
  assert.match(contact, /不具合報告/);
  assert.match(contact, /削除依頼/);
  assert.match(contact, /リンク掲載/);
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
