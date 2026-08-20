const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const normalScreenCss = css.slice(css.lastIndexOf("/* 通常画面:"));

test("TOPは試合情報、予告先発、CTA、説明、β版の順で視覚配置する", () => {
  assert.match(normalScreenCss, /grid-template-areas:[\s\S]*"game game"[\s\S]*"starter starter"[\s\S]*"hero hero"[\s\S]*"lead lead"[\s\S]*"beta beta"/);
  assert.match(html, /id="probableStarterDisplay"/);
  assert.match(html, /id="predictionCtaButton"/);
  assert.match(html, /class="beta-panel"/);
});

test("ロゴとアカウント操作はコンパクトなTOP領域として維持する", () => {
  assert.match(normalScreenCss, /\.header-logo\s*\{[\s\S]*width: min\(100%, 276px\)/);
  assert.match(normalScreenCss, /#authPanel\s*\{[\s\S]*padding: 0/);
  assert.match(html, /id="openLoginButton"/);
  assert.match(html, /id="openRegisterButton"/);
  assert.match(html, /id="logoutButton"/);
});

test("通常画面のCTAは既存IDを使い、スマホでは全幅になる", () => {
  assert.match(normalScreenCss, /\.hero-cta\s*\{[\s\S]*min-width: 250px/);
  assert.match(normalScreenCss, /@media \(max-width: 759px\)[\s\S]*\.hero-cta\s*\{[\s\S]*width: 100%/);
  assert.match(normalScreenCss, /@media \(max-width: 430px\)/);
  assert.match(html, /id="predictionCtaButton"/);
});

test("追加CSSは管理画面のセレクタへ直接適用しない", () => {
  assert.match(normalScreenCss, /body:not\(:has\(\.app-layout\.is-admin-screen\)\)/);
  assert.match(normalScreenCss, /\.app-layout:not\(\.is-admin-screen\)/);
  assert.doesNotMatch(normalScreenCss, /\.admin-details\s*\{/);
  assert.doesNotMatch(normalScreenCss, /[;{]\s*width:\s*\d{4}px/);
});
