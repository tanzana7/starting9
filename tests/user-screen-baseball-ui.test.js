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

test("スマホの通常画面はオーダー表40%と選手一覧60%の2列にする", () => {
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.lineup-builder[\s\S]*grid-template-columns: minmax\(0, 0\.4fr\) minmax\(0, 0\.6fr\)/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.lineup-slot[\s\S]*min-width: 0/);
  assert.doesNotMatch(css, /body\s*\{[\s\S]*overflow-x:\s*hidden/);
});

test("選手フィルターは初期状態をactiveとして保持し、選択状態を読み上げられる", () => {
  assert.match(script, /candidateRosterFilter: "active"/);
  assert.match(script, /button\.setAttribute\("aria-pressed", isSelected \? "true" : "false"\)/);
  assert.match(script, /button\.setAttribute\("aria-selected", isSelected \? "true" : "false"\)/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.roster-filter-button\.is-selected[\s\S]*font-weight: 950/);
});

test("タッチ端末向けに長押しドラッグで選手と守備位置を同時に入れ替えられる", () => {
  assert.match(script, /function moveLineupSlot\(pickerName, sourceIndex, targetIndex\)/);
  assert.match(script, /const POINTER_LONG_PRESS_MS = 250/);
  assert.match(script, /const POINTER_DRAG_DISTANCE = 8/);
  assert.match(script, /function handleLineupPointerDown\(event, slot\)/);
  assert.match(script, /function handlePointerInteractionMove\(event\)/);
  assert.match(script, /moveLineupSlot\(interaction\.pickerName, interaction\.sourceIndex, targetIndex\)/);
  assert.doesNotMatch(script, /slot-reorder-button|reorderButton/);
  assert.match(script, /const dragHandle = pickerName === "actual"/);
  assert.match(css, /\.slot-drag-handle/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.lineup-slot,\r?\n\.app-layout:not\(\.is-admin-screen\) \.player-chip[\s\S]*touch-action: pan-y/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.lineup-slot\.is-dragging[\s\S]*box-shadow/);
});

test("スマホの選手一覧はページ全体でスクロールし、2列のコンパクト表示になる", () => {
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.player-list[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.player-list[\s\S]*max-height: none/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.player-list[\s\S]*overflow: visible/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.player-chip \.player-name[\s\S]*text-overflow: ellipsis/);
});

test("PCの予想入力は900px以上で左420px以上のオーダー表と広い選手一覧を使う", () => {
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.lineup-builder[\s\S]*grid-template-columns: minmax\(420px, 0\.9fr\) minmax\(0, 1\.3fr\)/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.container[\s\S]*width: calc\(100% - 48px\)[\s\S]*max-width: 75rem/);
  assert.match(css, /@media \(min-width: 78\.125rem\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.player-list[\s\S]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(min-width: 64rem\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.lineup-builder[\s\S]*grid-template-columns: minmax\(480px, 0\.95fr\) minmax\(0, 1\.3fr\)/);
});

test("PC用CSSは実DOMの入力要素へ適用できるセレクタを持ち、更新済みURLで読み込む", () => {
  assert.match(html, /<link rel="stylesheet" href="style\.css\?v=public-remove-next-game-card-1">/);
  for (const [className, label, source] of [
    ["lineup-builder", "左右カラム", html],
    ["lineup-panel", "予想オーダー", html],
    ["player-panel", "選手一覧パネル", html],
    ["lineup-slot", "オーダー行", script],
    ["slot-player", "選手名", script],
    ["roster-filter", "登録状態タブ", html],
    ["player-list", "選手一覧", html]
  ]) {
    assert.match(source, source === script ? new RegExp(`className = "${className}`) : new RegExp(`class="[^"]*\\b${className}\\b`), `${label}のDOM生成元がありません`);
    assert.match(css, new RegExp(`\\.app-layout:not\\(\\.is-admin-screen\\) \\.${className}`), `${label}へ適用する通常画面セレクタがありません`);
  }
  for (const id of ["predictionForm", "predictionError", "savePredictionButton", "resetPredictionButton"]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id}の実DOMがありません`);
  }
  assert.match(css, /#predictionForm > \.message,[\s\S]*grid-column: 1 \/ -1/);
});

test("PCのオーダー行は固定列と省略表示を使い、通知・操作領域はフォーム幅に揃える", () => {
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.lineup-slot[\s\S]*grid-template-columns: 30px 54px minmax\(180px, 1fr\) 44px 38px/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.lineup-slot\[data-picker="prediction"\][\s\S]*grid-template-columns: 56px minmax\(0, 1fr\) 56px 44px/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*column-gap: 12px/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*\.slot-player[\s\S]*padding-inline-start: 12px/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*\.slot-player[\s\S]*width: auto[\s\S]*max-width: none[\s\S]*min-width: 0/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*\.position-button[\s\S]*width: 56px/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*\.position-button[\s\S]*justify-self: end/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*\.slot-clear[\s\S]*width: 44px/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*\.slot-clear[\s\S]*justify-self: end/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*\.slot-order[\s\S]*grid-column: 1[\s\S]*justify-self: start/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*\.position-control[\s\S]*grid-column: 2[\s\S]*justify-self: center/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*\.slot-player[\s\S]*grid-column: 3/);
  assert.match(css, /\.lineup-slot\[data-picker="prediction"\][\s\S]*\.slot-clear[\s\S]*grid-column: 4/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*#predictionForm #predictionLineup > \.lineup-slot\[data-picker="prediction"\][\s\S]*display: grid[\s\S]*grid-template-columns: 56px 56px minmax\(0, 1fr\) 44px[\s\S]*grid-template-areas: "order position player clear"/);
  assert.match(css, /#predictionForm #predictionLineup > \.lineup-slot\[data-picker="prediction"\] > \.slot-order[\s\S]*grid-area: order/);
  assert.match(css, /#predictionForm #predictionLineup > \.lineup-slot\[data-picker="prediction"\] > \.position-control[\s\S]*grid-area: position/);
  assert.match(css, /#predictionForm #predictionLineup > \.lineup-slot\[data-picker="prediction"\] > \.slot-player[\s\S]*grid-area: player/);
  assert.match(css, /#predictionForm #predictionLineup > \.lineup-slot\[data-picker="prediction"\] > \.slot-clear[\s\S]*grid-area: clear/);
  assert.match(css, /#predictionLineup[\s\S]*gap: 6px[\s\S]*border-top: 0/);
  assert.match(css, /#predictionLineup \.lineup-slot\[data-picker="prediction"\][\s\S]*border: 1px solid #d7e1eb[\s\S]*border-radius: 7px[\s\S]*box-shadow: 0 1px 3px/);
  assert.match(css, /#predictionLineup \.lineup-slot\[data-picker="prediction"\]\.is-active[\s\S]*background: #eef6fc[\s\S]*box-shadow: inset 3px 0 0 var\(--fighters-blue\)/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.slot-player,[\s\S]*white-space: nowrap/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.slot-player,[\s\S]*padding-inline-start: 10px/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.player-category-legend[\s\S]*display: none/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*#predictionForm > \.message,[\s\S]*grid-column: 1 \/ -1/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*#savePredictionButton[\s\S]*min-width: 220px/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*#resetPredictionButton[\s\S]*min-width: 180px/);
});

test("iPhone向けTouch Eventsフォールバックも既存のPointer状態更新を利用する", () => {
  assert.match(script, /touchstart.*handleTouchInteractionStart/);
  assert.match(script, /touchmove.*handleTouchInteractionMove/);
  assert.match(script, /touchend.*handleTouchInteractionEnd/);
  assert.match(script, /touchcancel.*handleTouchInteractionCancel/);
  assert.match(script, /function createTouchPointerEvent\(touch, sourceEvent\)/);
  assert.match(script, /beginPointerInteraction\(createTouchPointerEvent\(touch, event\), target, kind\)/);
  assert.match(script, /handlePointerInteractionMove\(createTouchPointerEvent\(touch, event\)\)/);
});

test("iPhone向けの選択抑止と公示ブロックの位置を通常画面だけに適用する", () => {
  assert.match(css, /-webkit-user-select:\s*none/);
  assert.match(css, /-webkit-touch-callout:\s*none/);
  assert.match(css, /-webkit-tap-highlight-color:\s*transparent/);
  assert.match(script, /event\.target\.closest\("button, \.position-menu"\)/);
  assert.match(script, /element\.setPointerCapture\(interaction\.pointerId\)/);
  assert.match(script, /interaction\.pointerId !== event\.pointerId/);
  assert.match(script, /function shouldUseNativeDrag\(pickerName\)/);
  assert.doesNotMatch(script, /data-lineup-move/);
  const noticeIndex = html.indexOf('id="gameDayNoticeStatus"');
  const lineupIndex = html.indexOf('<div class="lineup-builder" data-picker="prediction">');
  assert.ok(noticeIndex >= 0 && noticeIndex < lineupIndex, "公示ブロックが左右カラムの外にありません");
});
