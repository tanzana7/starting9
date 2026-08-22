const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const publicRoster = fs.readFileSync(path.join(root, "frontend", "public", "roster.js"), "utf8");
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

test("スマホの通常画面はオーダー表と選手一覧を2ペインにする", () => {
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.lineup-builder[\s\S]*grid-template-columns: minmax\(0, 60fr\) minmax\(0, 40fr\)/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.lineup-slot[\s\S]*min-width: 0/);
  assert.doesNotMatch(css, /body\s*\{[\s\S]*overflow-x:\s*hidden/);
});

test("選手フィルターは初期状態をactiveとして保持し、選択状態を読み上げられる", () => {
  assert.match(script, /candidateRosterFilter: "active"/);
  assert.match(publicRoster, /button\.setAttribute\("aria-pressed", isSelected \? "true" : "false"\)/);
  assert.match(publicRoster, /button\.setAttribute\("aria-selected", isSelected \? "true" : "false"\)/);
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

test("予想オーダーの守備位置チップはPCでdrag可能で、既存の行dropへ接続される", () => {
  assert.match(script, /button\.draggable = shouldUseNativeDrag\(pickerName\)/);
  assert.match(script, /button\.addEventListener\("dragstart", \(event\) => handlePositionDragStart\(event, button, slot\)\)/);
  assert.match(script, /if \(dragData\.kind === "position"\)/);
  assert.match(script, /movePositionBetweenSlots\(slot\.dataset\.picker, dragData\.sourceOrder, Number\(slot\.dataset\.order\)\)/);
  assert.match(css, /\.position-button\[draggable="true"\][\s\S]*cursor: grab/);
  assert.match(css, /\.position-button\.is-dragging/);
});

test("スマホの選手一覧はページ全体でスクロールし、1人1行の表示になる", () => {
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.player-list[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.player-list[\s\S]*max-height: none/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.player-list[\s\S]*overflow: visible/);
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.player-chip \.player-name[\s\S]*text-overflow: ellipsis/);
});

test("中幅の予想入力は2カラムを維持し、十分な幅では広く使う", () => {
  assert.match(css, /\.app-layout:not\(\.is-admin-screen\) \.lineup-builder[\s\S]*grid-template-columns: minmax\(0, 1fr\)[\s\S]*width: 100%[\s\S]*max-width: 100%/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.lineup-builder[\s\S]*grid-template-columns: minmax\(0, 60fr\) minmax\(0, 40fr\)/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.container[\s\S]*width: calc\(100% - 48px\)[\s\S]*max-width: 75rem/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.lineup-builder[\s\S]*grid-template-columns: minmax\(380px, 480px\) minmax\(320px, 1fr\)[\s\S]*gap: 20px/);
  assert.match(css, /@media \(min-width: 78\.125rem\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.player-list[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(120px, 1fr\)\)/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.player-panel[\s\S]*min-width: 0/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.player-list[\s\S]*min-width: 0[\s\S]*max-width: 100%[\s\S]*\.player-chip[\s\S]*min-width: 120px/);
});

test("公開画面は900px以上でも予想入力から結果までを縦積みにする", () => {
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*> \.lineup-card[\s\S]*grid-column: 1/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*> \.result-card[\s\S]*grid-column: 1[\s\S]*grid-row: 4/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*> #rankingPanel[\s\S]*grid-column: 1[\s\S]*grid-row: 5/);
  assert.match(css, /@media \(min-width: 768px\) and \(max-width: 899px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
});

test("スマホの予想入力は2カラムを維持し、守備位置を打順の隣に置く", () => {
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.lineup-builder \{[\s\S]*?grid-template-columns: minmax\(0, 60fr\) minmax\(0, 40fr\)/);
  assert.match(css, /#predictionLineup > \.lineup-slot\[data-picker="prediction"\][\s\S]*?grid-template-areas: "order position player clear"/);
  assert.match(css, /#predictionLineup > \.lineup-slot\[data-picker="prediction"\] > \.position-control[\s\S]*?grid-area: position/);
  assert.match(css, /\.position-menu\.is-viewport-positioned[\s\S]*?z-index: 1400/);
});

test("PCの出場候補・その他選手一覧は2列カードgridで表示する", () => {
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)[\s\S]*max-width: 100%/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list[\s\S]*max-height: none[\s\S]*overflow: visible/);
  assert.doesNotMatch(css, /@media \(min-width: 900px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list[\s\S]*grid-template-columns: repeat\(auto-fit/);
  assert.doesNotMatch(css, /@media \(min-width: 900px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list[\s\S]*grid-template-columns: minmax\(0, 1fr\)[\s\S]*max-height: 560px/);
  assert.match(html, /data-roster-filter="active"/);
  assert.match(html, /data-roster-filter="inactive"/);
});

test("PCの予想入力エリアを全幅にし、オーダーを1から9番の1列で維持する", () => {
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.app-layout:not\(\.is-admin-screen\)[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.lineup-builder[\s\S]*grid-template-columns: minmax\(0, 0\.92fr\) minmax\(0, 1\.08fr\)/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) #predictionLineup[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /@media \(min-width: 900px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) #predictionLineup[\s\S]*grid-auto-flow: column/);
  assert.match(css, /@media \(min-width: 768px\) and \(max-width: 899px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) #predictionLineup[\s\S]*grid-template-columns: minmax\(0, 1fr\)[\s\S]*grid-auto-flow: row/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) #predictionLineup[\s\S]*grid-template-columns: minmax\(0, 1fr\)[\s\S]*grid-auto-flow: row/);
});

test("公開画面の残り時間表示は公開用関数に分離され、管理画面のタイマーと衝突しない", () => {
  assert.match(script, /function formatPublicRemainingTime/);
  assert.match(script, /function formatPublicRemainingTime[\s\S]*const hours = Math\.floor/);
  assert.doesNotMatch(script, /function formatAdminScoringRemainingTime|function formatRemainingTime/);
});

test("予想オーダーの選手名と未選択表示はブロック型の選択領域になる", () => {
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) #predictionLineup \.slot-player[\s\S]*min-height: 42px[\s\S]*padding: 7px 12px[\s\S]*border: 1px solid #c7d7e8[\s\S]*border-radius: 7px[\s\S]*background: #f7fbff/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) #predictionLineup \.slot-player\.slot-empty[\s\S]*border-style: dashed[\s\S]*background: #fbfcfd/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) #predictionLineup \.slot-player \.player-name[\s\S]*overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*#predictionLineup \.slot-player[\s\S]*min-height: 44px/);
});

test("PC/スマホの選手一覧もカード型で表示する", () => {
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list \.player-chip[\s\S]*min-height: 48px[\s\S]*padding: 9px 12px[\s\S]*border: 1px solid #c7d7e8[\s\S]*border-radius: 7px[\s\S]*background: #ffffff/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list \.player-chip \.player-name[\s\S]*overflow-wrap: anywhere/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.player-list \.player-chip[\s\S]*min-height: 48px/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list \.player-chip\.is-used[\s\S]*background: #ffffff/);
});

test("公開予想画面の選手カードは主ポジション色を使わず中立表示にする", () => {
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list \.player-chip\.is-category-catcher,[\s\S]*\.player-chip\.is-category-infielder,[\s\S]*\.player-chip\.is-category-outfielder,[\s\S]*\.player-chip\.is-category-dh[\s\S]*border-color: #c7d7e8[\s\S]*background: #ffffff/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-category-legend[\s\S]*display: none/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list \.player-chip\.is-used[\s\S]*background: #ffffff/);
});

test("公開予想画面の選手カードは白背景と適度な間隔を使う", () => {
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list \.player-chip[\s\S]*background: #ffffff/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list[\s\S]*gap: 14px/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list[\s\S]*gap: 12px/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.player-list \.player-chip\.is-used[\s\S]*background: #ffffff/);
});

test("保存済み予想は打順・守備位置・選手名の表形式で表示する", () => {
  assert.match(script, /wrapper\.className = "saved-lineup-summary"/);
  assert.match(script, /listItem\.className = "saved-lineup-row"/);
  assert.match(script, /class="saved-lineup-order"/);
  assert.match(script, /class="saved-lineup-detail"/);
  assert.match(script, /class="result-position-tile saved-position-chip is-\$\{positionCategory\}"/);
  assert.match(script, /class="saved-lineup-name"/);
  assert.match(script, /saved-lineup-table-header/);
  assert.match(script, /<span>打順<\/span><span>守備<\/span><span>選手名<\/span>/);
  assert.match(script, /createSavedPredictionPreview\(state\.prediction\)/);
  assert.match(script, /createSavedPredictionCanvas\(prediction\)/);
  assert.match(script, /className = "saved-lineup-canvas"/);
  assert.match(script, /title\.textContent = "保存済みのスタメン予想"/);
  assert.match(script, /meta\.textContent = `最後に更新：\$\{formatDateTime\(prediction\.savedAt\)\}`/);
  assert.match(script, /const displayWidth = Math\.min\(240/);
  assert.match(script, /const tableWidth = displayWidth - 8/);
  assert.match(script, /drawCenteredText\(`\$\{index \+ 1\}`, tableX \+ 5, rowY \+ rowHeight \/ 2, orderWidth - 10, "800 17px \\\"Bahnschrift SemiBold\\\", \\\"Bahnschrift\\\", \\\"Arial Narrow Bold\\\", \\\"Arial Narrow\\\", Arial, sans-serif", "#ffffff"\)/);
  assert.match(script, /const positionWidth = 52/);
  assert.doesNotMatch(script, /drawDigitalOrderNumber/);
  assert.match(script, /drawCenteredText\(formatPlayerNameForDisplay\(lineupItem\.player \|\| "未選択"\),[\s\S]*"800 17px \\\"Yu Gothic\\\"/);
  assert.match(script, /navy: "#0b5ea8"/);
  assert.match(script, /order: "#0b5ea8"/);
  assert.match(script, /drawCenteredText\("選手名", tableX \+ orderWidth \+ positionWidth, tableY \+ headerHeight \/ 2, nameWidth/);
  assert.match(script, /drawCenteredText\(formatPlayerNameForDisplay\(lineupItem\.player \|\| "未選択"\), tableX \+ orderWidth \+ positionWidth \+ 3, rowY \+ rowHeight \/ 2, nameWidth - 6/);
  assert.doesNotMatch(script, /drawCenteredText\(`\$\{index \+ 1\}番`/);
  assert.doesNotMatch(script, /drawLeftText\("あなたの予想"/);
  assert.doesNotMatch(script, /drawLeftText\(`最後に更新：/);
  assert.match(script, /nameWidth - 6/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) #editSavedPredictionButton,[\s\S]*#sharePredictionButton[\s\S]*display: none !important/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) #saveSavedPredictionImageButton[\s\S]*display: inline-flex/);
  assert.match(script, /saveSavedPredictionImage/);
  assert.match(script, /canvas\.toBlob/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.saved-lineup-summary[\s\S]*width: min\(100%, 470px\)/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.saved-lineup-table-header[\s\S]*grid-template-columns: 42px 40px minmax\(0, 1fr\)[\s\S]*gap: 6px[\s\S]*background: var\(--fighters-deep-blue\)/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.saved-lineup-summary > \.lineup-list[\s\S]*gap: 3px[\s\S]*padding: 4px[\s\S]*border-top: 0[\s\S]*background: #f3f6fa/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.saved-lineup-summary li\.saved-lineup-row[\s\S]*grid-template-columns: 42px 40px minmax\(0, 1fr\)[\s\S]*gap: 6px[\s\S]*padding: 4px 2px 4px 4px[\s\S]*border: 1px solid #d9dee7[\s\S]*background: #f8fbff/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.saved-lineup-summary \.saved-lineup-detail[\s\S]*display: contents/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.saved-lineup-summary \.saved-lineup-name[\s\S]*grid-column: 3[\s\S]*width: 100%[\s\S]*min-width: 0[\s\S]*max-width: none[\s\S]*background: #ffffff/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.saved-lineup-summary li\.saved-lineup-row[\s\S]*grid-template-columns: 40px 38px minmax\(0, 1fr\)[\s\S]*gap: 6px[\s\S]*padding: 5px/);
});

test("PC用CSSは実DOMの入力要素へ適用できるセレクタを持ち、更新済みURLで読み込む", () => {
  assert.match(html, /<link rel="stylesheet" href="style\.css\?v=public-load-performance-optimization-1">/);
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
  assert.match(css, /#predictionForm > #predictionEditor[\s\S]*grid-column: 1 \/ -1/);
});

test("公開予想入力は結果画面と共通の青系テーマを使い、操作領域を維持する", () => {
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\):has\(#predictionForm\)/);
  assert.match(css, /#predictionForm \.slot-order[\s\S]*color: #ffffff[\s\S]*background: #1168a8/);
  assert.match(css, /#predictionForm \.roster-filter-button\.is-selected[\s\S]*background: #1168a8[\s\S]*#d5a11e/);
  assert.match(css, /#predictionForm \.position-menu[\s\S]*border-color: #9fc2df/);
  assert.match(css, /#predictionForm \.player-chip[\s\S]*border-color: #b9cfe2/);
  assert.match(css, /#predictionForm \.lineup-slot\.is-drop-target/);
  assert.match(html, /style\.css\?v=public-load-performance-optimization-1/);
  assert.match(html, /script\.js\?v=public-load-performance-optimization-1/);
  assert.match(script, /function togglePositionMenu\(/);
  assert.match(script, /function handlePlayerDragStart\(/);
  assert.match(script, /function assignPlayerToActiveSlot\(/);
});

test("公開画面はスコアボード風の落ち着いたテーマを使い、管理画面へ漏らさない", () => {
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \{/);
  assert.match(css, /--fighters-deep-blue: #14213d/);
  assert.match(css, /background: #f4f6f8/);
  assert.match(css, /\.daily-best-nine-card[\s\S]*border-left-color: var\(--fighters-gold\)/);
  assert.match(css, /\.ranking-tab\.is-active[\s\S]*background: var\(--fighters-deep-blue\)/);
  assert.match(css, /\.ranking-achievement-badge\.is-epic[\s\S]*background: #fbf7e8/);
  assert.match(css, /\.achievement-card\.is-epic \.achievement-icon[\s\S]*color: #d6b458/);
  assert.doesNotMatch(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.admin-details\s*\{/);
});

test("トップの案内文は自動採点を案内する", () => {
  assert.match(html, /発表後に99点満点で自動採点されます。/);
  assert.doesNotMatch(html, /発表後に99点満点で採点しよう。/);
  assert.match(html, /表示される締切まで予想できます。試合後は結果画面で答え合わせできます。/);
  assert.doesNotMatch(html, /表示される締切まで予想可能。試合後は自動採点され/);
  assert.doesNotMatch(html, /スタメン9人\+打順\+守備位置/);
  assert.match(html, /スタメン9人・打順・守備位置/);
});

test("PCのオーダー行は固定列と省略表示を使い、通知・操作領域はフォーム幅に揃える", () => {
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.lineup-slot[\s\S]*grid-template-columns: 30px 54px minmax\(180px, 1fr\) 44px 38px/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*\.lineup-slot\[data-picker="prediction"\][\s\S]*grid-template-columns: 56px minmax\(0, 1fr\) 56px 44px/);
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
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*#predictionForm #predictionLineup > \.lineup-slot\[data-picker="prediction"\][\s\S]*display: grid[\s\S]*grid-template-columns: 56px 56px minmax\(0, 1fr\) 44px[\s\S]*grid-template-areas: "order position player clear"/);
  assert.match(css, /#predictionForm #predictionLineup > \.lineup-slot\[data-picker="prediction"\] > \.slot-order[\s\S]*grid-area: order/);
  assert.match(css, /#predictionForm #predictionLineup > \.lineup-slot\[data-picker="prediction"\] > \.position-control[\s\S]*grid-area: position/);
  assert.match(css, /#predictionForm #predictionLineup > \.lineup-slot\[data-picker="prediction"\] > \.slot-player[\s\S]*grid-area: player/);
  assert.match(css, /#predictionForm #predictionLineup > \.lineup-slot\[data-picker="prediction"\] > \.slot-clear[\s\S]*grid-area: clear/);
  assert.match(css, /#predictionLineup[\s\S]*gap: 6px[\s\S]*border-top: 0/);
  assert.match(css, /#predictionLineup \.lineup-slot\[data-picker="prediction"\][\s\S]*border: 1px solid #d7e1eb[\s\S]*border-radius: 7px[\s\S]*box-shadow: 0 1px 3px/);
  assert.match(css, /#predictionLineup \.lineup-slot\[data-picker="prediction"\]\.is-active[\s\S]*background: #eef6fc[\s\S]*box-shadow: inset 3px 0 0 var\(--fighters-blue\)/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.slot-player,[\s\S]*white-space: nowrap/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.slot-player,[\s\S]*padding-inline-start: 10px/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*\.app-layout:not\(\.is-admin-screen\) \.player-category-legend[\s\S]*display: none/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*#predictionForm > \.message,[\s\S]*grid-column: 1 \/ -1/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*#savePredictionButton[\s\S]*min-width: 220px/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*#resetPredictionButton[\s\S]*min-width: 180px/);
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
