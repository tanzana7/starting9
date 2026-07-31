const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const normalScreenCss = css.slice(css.lastIndexOf("/* 通常画面:"));

test("通常画面の野球UI調整は管理画面クラスの外側に限定される", () => {
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\)/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\)/);
  assert.doesNotMatch(normalScreenCss, /\.admin-details\s*\{/);
});

test("予想入力に必要な既存のIDと動的要素の参照を維持する", () => {
  for (const id of [
    "predictionForm",
    "predictionLineup",
    "predictionPlayers",
    "savePredictionButton",
    "resetPredictionButton",
    "probableStarterDisplay",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} が維持されていません`);
  }

  assert.match(script, /slot\.className = "lineup-slot"/);
  assert.match(script, /button\.className = "player-chip"/);
});

test("オーダー表は1番から9番までの順序とモバイル折り返しを維持する", () => {
  assert.match(script, /const LINEUP_SIZE = 9/);
  assert.match(script, /for \(let index = 0; index < LINEUP_SIZE; index \+= 1\)/);
  assert.match(script, /order\.textContent = `\$\{index \+ 1\}番`/);
  assert.match(css, /\.lineup-slot\s*\{[\s\S]*grid-template-columns:/);
  assert.match(css, /\.slot-player\s*\{[\s\S]*white-space: normal/);
  assert.match(css, /@media \(max-width: 430px\)/);
  assert.match(css, /grid-template-columns: 28px 40px minmax\(0, 1fr\) 40px 32px/);
});

test("通常画面の固定幅を避け、保存操作の既存IDを維持する", () => {
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.(?:primary-button|#savePredictionButton)/);
  assert.doesNotMatch(css, /\.app-layout:not\(\.is-admin-screen\)[^{]*min-width:\s*\d{4}px/);
  assert.match(html, /id="savePredictionButton"/);
});

test("スマホの通常画面はオーダー表と選手一覧を1列に積む", () => {
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.lineup-builder[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.lineup-slot[\s\S]*min-width: 0/);
  assert.doesNotMatch(css, /body\s*\{[\s\S]*overflow-x:\s*hidden/);
});

test("選手フィルターは初期状態をactiveとして保持し、選択状態を読み上げられる", () => {
  assert.match(script, /candidateRosterFilter: "active"/);
  assert.match(script, /button\.setAttribute\("aria-pressed", isSelected \? "true" : "false"\)/);
  assert.match(script, /button\.setAttribute\("aria-selected", isSelected \? "true" : "false"\)/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.roster-filter-button\.is-selected[\s\S]*font-weight: 950/);
});

test("タッチ端末向けに上下移動ボタンで選手と守備位置を同時に入れ替えられる", () => {
  assert.match(script, /function moveLineupSlot\(pickerName, sourceIndex, targetIndex\)/);
  assert.match(script, /reorderButton\.dataset\.lineupMove = direction/);
  assert.match(script, /slotActions\.append\(reorderControls, clearButton\)/);
  assert.match(script, /button\.disabled = isLocked \|\| targetIndex < 0 \|\| targetIndex >= LINEUP_SIZE/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.slot-reorder-button[\s\S]*min-height: 44px/);
});
