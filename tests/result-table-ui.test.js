const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const publicResultsRenderer = fs.readFileSync(path.join(root, "frontend/public/render-results.js"), "utf8");

function sourceForFunction(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  const next = script.indexOf("\nfunction ", start + 1);
  return script.slice(start, next === -1 ? script.length : next);
}

function findActualLineupItem(predictionItem, actualLineup) {
  const context = vm.createContext({
    normalizePlayerKey: (value) => String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "")
  });
  vm.runInContext(`${sourceForFunction("findActualLineupItem")}; this.find = findActualLineupItem;`, context);
  return context.find(predictionItem, actualLineup);
}

function createActualBasisDetails(sourceDetails, actualLineup) {
  const context = vm.createContext({
    LINEUP_SIZE: 9,
    normalizePlayerKey: (value) => String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "")
  });
  vm.runInContext(`${sourceForFunction("createActualBasisDetails")}; this.build = createActualBasisDetails;`, context);
  return context.build(sourceDetails, actualLineup);
}

function createDisplayDetails(sourceDetails, actualLineup) {
  const context = vm.createContext({
    LINEUP_SIZE: 9,
    normalizePlayerKey: (value) => String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "")
  });
  vm.runInContext(`${sourceForFunction("createActualBasisDetails")};${sourceForFunction("mergeRawPredictionSlots")}; this.build = (source, actual) => mergeRawPredictionSlots(source, createActualBasisDetails(source, actual));`, context);
  return context.build(sourceDetails, actualLineup);
}

test("採点結果テーブルは予想欄を先に、実際のスタメン順で比較する", () => {
  const source = sourceForFunction("createResultTable");
  assert.match(source, /<th class="result-group-heading">あなたの予想/);
  assert.match(source, /<th class="result-group-heading result-actual-group-heading">実際のスタメン/);
  assert.ok(source.indexOf("あなたの予想") < source.indexOf("実際のスタメン"));
  assert.match(source, /<th class="result-group-heading result-judgement-heading">判定/);
  assert.match(source, /<th class="result-point-heading">点数/);
  assert.match(source, /<th class="result-order-heading">打順/);
  assert.doesNotMatch(source, /実際の打順<\/th>/);
  assert.doesNotMatch(source, /実際は/);
  assert.doesNotMatch(source, /result-actual-order-note/);
  assert.match(source, /createResultPlayerCardHtml\(detail\.player \|\| "未予想", detail\.position\)/);
  assert.match(source, /createResultPlayerCardHtml\(detail\.actualPlayer \|\| "-", detail\.actualPosition\)/);
  assert.doesNotMatch(source, /detail\.predictionOrder/);
  assert.match(source, /class="result-judgement-stack"/);
  assert.match(source, /createHitBadge\(detail\.isPlayerHit, "出場"\)/);
  assert.match(source, /createHitBadge\(detail\.isOrderHit, "打順"\)/);
  assert.match(source, /createHitBadge\(detail\.isPositionHit, "守備"\)/);
  assert.equal((source.match(/createHitBadge\(detail\./g) || []).length, 3);
  const viewModel = sourceForFunction("createResultViewModel");
  assert.match(viewModel, /createActualBasisDetails\(normalizedDetails, result\.actualLineup\)/);
  assert.match(viewModel, /mergeRawPredictionSlots\(normalizedDetails, actualBasisDetails\)/);
});

test("結果表示モデルは実際のスタメン順に並べ、同じ選手の予想と行点を保持する", () => {
  const sourceDetails = [
    { order: 1, player: "別選手", position: "遊", actualOrder: null, point: 0, isPlayerHit: false, isOrderHit: false, isPositionHit: false },
    { order: 2, player: "カストロ", position: "中", actualOrder: 7, actualPlayer: "今川優馬", actualPosition: "左", point: 7, isPlayerHit: true, isOrderHit: false, isPositionHit: true },
    { order: 3, player: "レイエス", position: "指", actualOrder: 4, actualPlayer: "吉田賢吾", actualPosition: "一", point: 7, isPlayerHit: true, isOrderHit: false, isPositionHit: true },
    { order: 4, player: "野村佑希", position: "左", point: 0, isPlayerHit: false, isOrderHit: false, isPositionHit: false },
    { order: 5, player: "今川優馬", position: "右", actualOrder: 2, actualPlayer: "有薗直輝", actualPosition: "三", point: 5, isPlayerHit: true, isOrderHit: false, isPositionHit: false },
    { order: 7, player: "有薗直輝", position: "三", actualOrder: 5, point: 7, isPlayerHit: true, isOrderHit: false, isPositionHit: true }
  ];
  const actualLineup = [
    { order: 1, player: "水野達稀", position: "遊", playerId: "p1" },
    { order: 2, player: "今川優馬", position: "左", playerId: "p2" },
    { order: 3, player: "吉田賢吾", position: "一", playerId: "p3" },
    { order: 4, player: "レイエス", position: "指", playerId: "p4" },
    { order: 5, player: "有薗直輝", position: "三", playerId: "p5" },
    { order: 7, player: "カストロ", position: "中", playerId: "p6" }
  ];
  const details = createActualBasisDetails(sourceDetails, actualLineup);
  const displayDetails = createDisplayDetails(sourceDetails, actualLineup);

  assert.equal(details[0].order, 1);
  assert.equal(details[0].actualPlayer, "水野達稀");
  assert.equal(details[0].player, "");
  assert.equal(details[1].order, 2);
  assert.equal(details[1].actualPlayer, "今川優馬");
  assert.equal(details[1].player, "今川優馬");
  assert.equal(details[1].predictionOrder, 5);
  assert.equal(details[1].point, 5);
  assert.equal(details[2].actualPlayer, "吉田賢吾");
  assert.equal(details[2].player, "");
  assert.equal(details[2].point, 0);
  assert.equal(details[3].actualPlayer, "レイエス");
  assert.equal(details[3].player, "レイエス");
  assert.equal(details[3].predictionOrder, 3);
  assert.equal(details[3].point, 7);
  assert.equal(details[6].actualPlayer, "カストロ");
  assert.equal(details[6].player, "カストロ");
  assert.equal(details[6].predictionOrder, 2);
  assert.equal(details[6].point, 7);
  assert.equal(details.reduce((total, detail) => total + detail.point, 0), 26);
  assert.equal(displayDetails[0].player, "別選手");
  assert.equal(displayDetails[1].player, "カストロ");
  assert.equal(displayDetails[2].player, "レイエス");
  assert.equal(displayDetails[2].actualPlayer, "吉田賢吾");
  assert.equal(displayDetails[2].point, 0);
  assert.equal(displayDetails[3].player, "野村佑希");
  assert.equal(displayDetails[3].actualPlayer, "レイエス");
  assert.equal(displayDetails[3].point, 7);
  assert.equal(displayDetails[6].player, "有薗直輝");
  assert.equal(displayDetails[6].actualPlayer, "カストロ");
  assert.equal(displayDetails[6].point, 7);
});

test("実際選手基準の点数と予想スロット表示を分離する", () => {
  const sourceDetails = [
    { order: 3, player: "レイエス", position: "指", point: 7, isPlayerHit: true, isOrderHit: false, isPositionHit: true },
    { order: 5, player: "今川優馬", position: "右", actualOrder: 2, point: 5, isPlayerHit: true, isOrderHit: false, isPositionHit: false }
  ];
  const details = createActualBasisDetails(sourceDetails, [
    { order: 1, player: "水野達稀", position: "遊", playerId: "p1" },
    { order: 2, player: "今川優馬", position: "左", playerId: "p2" },
    { order: 3, player: "吉田賢吾", position: "一", playerId: "p3" },
    { order: 4, player: "レイエス", position: "指", playerId: "p4" }
  ]);
  const displayDetails = createDisplayDetails(sourceDetails, [
    { order: 1, player: "水野達稀", position: "遊", playerId: "p1" },
    { order: 2, player: "今川優馬", position: "左", playerId: "p2" },
    { order: 3, player: "吉田賢吾", position: "一", playerId: "p3" },
    { order: 4, player: "レイエス", position: "指", playerId: "p4" }
  ]);

  assert.equal(details[1].player, "今川優馬");
  assert.equal(details[1].point, 5);
  assert.equal(details[2].actualPlayer, "吉田賢吾");
  assert.equal(details[2].player, "");
  assert.equal(details[2].point, 0);
  assert.equal(details[2].isPlayerHit, false);
  assert.equal(details[2].isOrderHit, false);
  assert.equal(details[2].isPositionHit, false);
  assert.equal(displayDetails[2].player, "レイエス");
  assert.equal(displayDetails[2].actualPlayer, "吉田賢吾");
  assert.equal(displayDetails[2].point, 0);
  assert.equal(displayDetails[3].player, "");
  assert.equal(displayDetails[3].actualPlayer, "レイエス");
});

test("実スタメン配列がない保存済み結果も実際選手順を維持する", () => {
  const sourceDetails = [
    {
      order: 1,
      player: "今川優馬",
      position: "右",
      actualOrder: 2,
      actualPlayer: "今川優馬",
      actualPosition: "左",
      point: 5,
      isPlayerHit: true,
      isOrderHit: false,
      isPositionHit: false
    },
    {
      order: 2,
      player: "カストロ",
      position: "中",
      actualOrder: 1,
      actualPlayer: "カストロ",
      actualPosition: "中",
      point: 7,
      isPlayerHit: true,
      isOrderHit: false,
      isPositionHit: true
    }
  ];
  const details = createActualBasisDetails(sourceDetails, []);

  assert.equal(details[0].actualPlayer, "今川優馬");
  assert.equal(details[0].player, "今川優馬");
  assert.equal(details[0].predictionOrder, 1);
  assert.equal(details[0].point, 5);
  assert.equal(details[1].actualPlayer, "カストロ");
  assert.equal(details[1].player, "カストロ");
  assert.equal(details[1].predictionOrder, 2);
  assert.equal(details[1].point, 7);
});

test("判定バッジは○×だけでなく判定対象ラベルを表示する", () => {
  const source = sourceForFunction("createHitBadge");
  assert.match(source, /function createHitBadge\(isHit, label\)/);
  assert.match(source, /hit-mark/);
  assert.match(source, /escapeHtml\(label\)/);
  assert.match(css, /\.hit-badge\s*\{[\s\S]*display: inline-flex/);
  assert.match(css, /\.hit-badge\s*\{[\s\S]*padding: 4px 6px/);
  assert.match(css, /\.hit-badge\s*\{[\s\S]*font-size: 0\.74rem/);
});

test("結果判定は正解だけgoldで強調し、不正解と0点行はneutral表示にする", () => {
  const canvas = sourceForFunction("createResultCanvas");
  assert.match(css, /\.hit-badge\.is-hit\s*\{[\s\S]*color: #4a3500[\s\S]*background: #f0c766/);
  assert.match(css, /\.hit-badge\.is-miss\s*\{[\s\S]*color: #55687b[\s\S]*background: #f1f4f7/);
  assert.doesNotMatch(css, /\.hit-badge\.is-miss\s*\{[^}]*opacity/);
  assert.match(canvas, /hit: "#f0c766"/);
  assert.match(canvas, /hitText: "#4a3500"/);
  assert.match(canvas, /miss: "#f1f4f7"/);
  assert.match(canvas, /missText: "#55687b"/);
  assert.match(canvas, /const textColor = isHit \? colors\.hitText : colors\.missText/);
  assert.match(canvas, /const rowFill = isPerfectRow \? "#fffaf0" : colors\.row/);
  assert.match(canvas, /const actualCardFill = isPerfectRow \? "#fff6dc" : colors\.row/);
  assert.match(canvas, /const pointFill = isPerfectRow \? "#fff1c7" : "#ffffff"/);
});

test("比較データの内部rendererは将来復活用に維持する", () => {
  const source = sourceForFunction("renderScoreInsights");
  assert.match(source, /comparison\?\.average \?\? comparison\?\.averageScore/);
  assert.match(source, /grid\.classList\.toggle\("hidden", !hasData\)/);
  assert.match(source, /notice\.classList\.toggle\("hidden", hasData\)/);
});

test("比較データがある場合は値のあるカードだけを表示できる", () => {
  const source = sourceForFunction("renderScoreInsights");
  assert.match(source, /top: comparison\?\.top \?\? comparison\?\.topPercent \?\? comparison\?\.percentile/);
  assert.match(source, /card\.classList\.toggle\("hidden", !hasValue\)/);
  assert.match(source, /valueElement\.textContent = hasValue \? String\(value\) : ""/);
});

test("公開結果画面ではスコア比較ブロックを表示しない", () => {
  assert.doesNotMatch(html, /scoreInsights|スコアの比較|全国平均|比較データは参加者が増え次第表示されます/);
  assert.doesNotMatch(publicResultsRenderer, /deps\.renderScoreInsights\(/);
});

test("実際の打順照合は採点内部に維持し、表示モデルは実際の選手順にする", () => {
  const scoring = sourceForFunction("findActualLineupItem");
  assert.match(scoring, /item\.playerId === playerId/);
  assert.match(scoring, /normalizePlayerKey\(item\.player\)/);
  assert.match(sourceForFunction("scoreLineup"), /actualOrder: actualItem\?\.order \|\| null/);
  const table = sourceForFunction("createResultTable");
  assert.doesNotMatch(table, /実際は/);

  const idMatch = findActualLineupItem(
    { player: "同名選手", playerId: "F-9" },
    [
      { order: 1, player: "同名選手", playerId: "F-10" },
      { order: 2, player: "別表記", playerId: "F-9" }
    ]
  );
  assert.equal(idMatch.order, 2);
});

test("結果テーブルの選手セルにはカテゴリ背景クラスを付けず、守備位置表示は維持する", () => {
  const table = sourceForFunction("createResultTable");
  const card = sourceForFunction("createResultPlayerCardHtml");
  assert.doesNotMatch(table, /getPlayerCategoryClassNames\(detail\.(player|actualPlayer)\)/);
  assert.match(card, /class="result-player-card"/);
  assert.match(card, /createResultPositionTileHtml\(position\)/);
  assert.match(card, /result-player-name/);
  assert.match(card, /function createResultPlayerCardHtml\(player, position\)/);
  assert.match(card, /result-player-card-empty/);
  assert.doesNotMatch(card, /result-player-order/);
  assert.doesNotMatch(css, /\.result-table td\.is-category-/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*background: #ffffff/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*border: 1px solid var\(--border\)/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*border-radius: 7px/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*font-size: 0\.92rem/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*font-weight: 800/);
});

test("結果テーブルの選手カードは守備位置と名前を薄い枠線で一体化する", () => {
  assert.match(css, /\.result-player-card\s*\{[\s\S]*border: 1px solid var\(--border\)/);
  assert.match(css, /\.result-player-card\s*\{[\s\S]*border-radius: 7px/);
  assert.match(css, /\.result-player-card \.result-position-tile\s*\{[\s\S]*border-right: 1px solid #b9cfe2/);
  assert.match(css, /\.result-player-card \.result-player-name\s*\{[\s\S]*border: 0/);
});

test("結果テーブルの選手名ブロックはPCとスマホで幅を揃える", () => {
  assert.match(css, /\.result-player-name\s*\{[\s\S]*width: auto[\s\S]*min-width: 0[\s\S]*max-width: none/);
  assert.match(css, /\.result-player-card \.result-player-name\s*\{[\s\S]*flex: 1 1 auto/);
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*\.result-player-name\s*\{[\s\S]*width: auto[\s\S]*min-width: 0[\s\S]*max-width: none/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*overflow-wrap: anywhere/);
});

test("採点結果テーブルは罫線主体のExcel風表組みでスマホにも収める", () => {
  assert.match(css, /\.result-table-wrap\s*\{[\s\S]*overflow-x: auto/);
  assert.match(css, /\.result-table\s*\{[\s\S]*min-width: 520px/);
  assert.match(css, /\.result-table\s*\{[\s\S]*border-collapse: collapse/);
  assert.match(css, /\.result-table-wrap\s*\{[\s\S]*border-radius: 0/);
  assert.match(css, /\.result-table th\s*\{[\s\S]*color: #ffffff[\s\S]*background: var\(--fighters-blue\)/);
  assert.match(css, /\.result-table \.result-order-cell strong\s*\{[\s\S]*color: #ffffff[\s\S]*background: var\(--fighters-blue\)/);
  assert.match(css, /\.result-table th,[\s\S]*\.result-table td\s*\{[\s\S]*border: 1px solid #d3dfeb/);
  assert.match(css, /\.result-player-card\s*\{[\s\S]*border-radius: 0/);
  assert.match(css, /\.result-judgement-stack\s*\{[\s\S]*display: flex[\s\S]*flex-wrap: nowrap/);
  assert.match(css, /\.result-judgement-stack\s*\{[\s\S]*gap: 2px/);
  assert.match(css, /\.result-judgement-stack \.hit-badge\s*\{[\s\S]*min-width: 0[\s\S]*border-radius: 7px[\s\S]*font-size: 0\.62rem/);
  assert.match(css, /\.result-table \.result-point-cell strong\s*\{[\s\S]*border-radius: 8px[\s\S]*background: #ffffff/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*overflow-wrap: anywhere/);
});

test("実スタメンと判定の境界線をヘッダーと全行で明示する", () => {
  const table = sourceForFunction("createResultTable");
  const canvas = sourceForFunction("createResultCanvas");
  assert.match(table, /result-actual-group-heading">実際のスタメン/);
  assert.match(table, /result-judgement-heading">判定/);
  assert.match(css, /\.result-table \.result-actual-group-heading,[\s\S]*border-right: 1px solid #d3dfeb/);
  assert.match(css, /\.result-table \.result-judgement-heading,[\s\S]*border-left: 1px solid #d3dfeb/);
  assert.match(canvas, /const actualJudgementBoundary = tableX \+ orderWidth \+ playerWidth \* 2/);
  assert.match(canvas, /context\.moveTo\(actualJudgementBoundary, y\)/);
  assert.match(canvas, /context\.moveTo\(judgementX, rowY\)/);
  assert.match(canvas, /context\.strokeStyle = colors\.grid/);
});

test("結果表の横罫線を判定・点数列まで連続させる", () => {
  const canvas = sourceForFunction("createResultCanvas");
  assert.match(css, /\.result-table tbody tr > td\s*\{[\s\S]*border-top: 1px solid #d3dfeb/);
  assert.match(css, /\.result-table tbody tr:last-child > td\s*\{[\s\S]*border-bottom: 1px solid #d3dfeb/);
  assert.match(canvas, /const bodyTop = y/);
  assert.match(canvas, /boundaryIndex <= viewModel\.details\.length/);
  assert.match(canvas, /context\.moveTo\(tableX, boundaryY\)/);
  assert.match(canvas, /context\.lineTo\(tableX \+ contentWidth, boundaryY\)/);
});

test("公開結果エリアは保存済み予想に近い青白い配色を使う", () => {
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.app-layout:not\(\.is-admin-screen\) > \.result-card\s*\{[\s\S]*background: #eef5fb/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.result-table th,[\s\S]*background: #1168a8/);
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.result-table tbody td\s*\{[\s\S]*background: #ffffff/);
});

test("採点結果は既存のviewModelからCanvas画像として表示する", () => {
  const view = sourceForFunction("createResultView");
  const canvas = sourceForFunction("createResultCanvas");
  assert.match(view, /createResultCanvas\(viewModel\)/);
  assert.match(view, /className = "result-canvas"/);
  assert.match(view, /setAttribute\("role", "img"\)/);
  assert.match(canvas, /viewModel\.breakdown\.player/);
  assert.match(canvas, /viewModel\.details\.forEach/);
  assert.match(canvas, /drawPlayerCard\(detail\.player \|\| "未予想", detail\.position/);
  assert.match(canvas, /drawPlayerCard\(detail\.actualPlayer \|\| "-", detail\.actualPosition/);
  assert.ok(canvas.indexOf("drawPlayerCard(detail.player") < canvas.indexOf("drawPlayerCard(detail.actualPlayer"));
  assert.doesNotMatch(canvas, /detail\.predictionOrder/);
  assert.match(canvas, /drawJudgement\(detail\.isPlayerHit, "出場"/);
  assert.match(canvas, /drawJudgement\(detail\.isOrderHit, "打順"/);
  assert.match(canvas, /drawJudgement\(detail\.isPositionHit, "守備"/);
  assert.doesNotMatch(canvas, /drawPerfectBadge|"PERFECT"/);
});

test("結果Canvasは判定列・行高・点数バッジを微調整する", () => {
  const canvas = sourceForFunction("createResultCanvas");
  assert.match(canvas, /const displayWidth = Math\.min\(590/);
  assert.match(canvas, /const rowHeight = 50/);
  assert.match(canvas, /const judgementWidth = displayWidth < 480 \? 94 : 126/);
  assert.match(canvas, /const isPerfectRow = Boolean\(detail\.isPerfect \?\? \(pointValue >= 11\)\)/);
  assert.match(canvas, /const isZeroRow = pointValue === 0/);
  assert.match(canvas, /const rowGap = 0/);
  assert.match(canvas, /const pointFill = isPerfectRow/);
  assert.match(canvas, /context\.fillStyle = isPerfectRow \? "#fff8e8" : colors\.row/);
  assert.match(canvas, /const pointBadgeInset = displayWidth < 480 \? 4 : 6/);
  assert.match(canvas, /const pointBadgeHeight = 32/);
  assert.match(canvas, /drawRoundedRect\(pointX \+ pointBadgeInset, pointBadgeY,[\s\S]*8, pointFill/);
  assert.match(canvas, /const badgeInset = 3/);
  assert.match(canvas, /drawRoundedRect\(badgeX, badgeY, badgeWidth, badgeHeight, 7/);
  assert.match(canvas, /const scoreStartX = padding \+ \(contentWidth - totalTextWidth - scoreGap - maxTextWidth\) \/ 2/);
  assert.match(canvas, /Starting9 結果発表/);
  assert.match(canvas, /const scoreGroupWidth = totalTextWidth \+ scoreGap \+ maxTextWidth/);
  assert.match(canvas, /drawText\("合計点", scoreStartX, y \+ 29, scoreGroupWidth/);
  assert.match(canvas, /const isZeroRow = pointValue === 0/);
  assert.match(canvas, /hit: "#f0c766"/);
  assert.match(canvas, /miss: "#f1f4f7"/);
  assert.match(canvas, /perfect: "#f0c766"/);
  assert.match(canvas, /perfectBorder: "#d4aa52"/);
  assert.match(canvas, /`950 \$\{displayWidth < 480 \? 13 : 15\}px Arial/);
  assert.match(canvas, /drawPlayerCard\(detail\.actualPlayer \|\| "-", detail\.actualPosition,[\s\S]*actualCardFill, actualCardBorder\)/);
  assert.match(canvas, /`700 \$\{fontSize\}px "Yu Gothic"/);
  assert.match(canvas, /const actualCardFill = isPerfectRow \? "#fff6dc" : colors\.row/);
  assert.match(canvas, /const actualCardBorder = isPerfectRow \? colors\.perfectBorder : colors\.border/);
  assert.match(canvas, /context\.moveTo\(pointX, rowY\)/);
});

test("結果Canvasは列座標を使用前に初期化する", () => {
  const canvas = sourceForFunction("createResultCanvas");
  const predictedColumnDeclaration = canvas.indexOf("const predictedColumnX = tableX + orderWidth;");
  const actualColumnDeclaration = canvas.indexOf("const actualColumnX = predictedColumnX + playerWidth;");
  const actualColumnUse = canvas.indexOf("context.fillRect(actualColumnX,");
  assert.notEqual(predictedColumnDeclaration, -1);
  assert.notEqual(actualColumnDeclaration, -1);
  assert.notEqual(actualColumnUse, -1);
  assert.ok(actualColumnDeclaration < actualColumnUse, "actualColumnXを宣言前に参照しない");
});

test("結果Canvasは代表的な採点結果を実行時に描画できる", () => {
  const drawContext = {
    scale() {},
    beginPath() {},
    moveTo() {},
    arcTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    fillRect() {},
    lineTo() {},
    fillText() {},
    measureText(value) {
      return { width: String(value).length * 8 };
    }
  };
  const fakeCanvas = {
    getContext() {
      return drawContext;
    }
  };
  const context = vm.createContext({
    window: { innerWidth: 1200 },
    document: {
      createElement(tagName) {
        assert.equal(tagName, "canvas");
        return fakeCanvas;
      }
    },
    normalizePosition: (value) => value,
    getPositionCategory: () => "category-infielder",
    formatPlayerNameForDisplay: (value) => String(value || ""),
    LINEUP_SIZE: 9
  });
  vm.runInContext(`${sourceForFunction("createResultCanvas")}; this.render = createResultCanvas;`, context);

  const details = Array.from({ length: 9 }, (_, index) => ({
    order: index + 1,
    player: `予想${index + 1}`,
    position: "遊",
    actualPlayer: `実際${index + 1}`,
    actualPosition: "遊",
    isPlayerHit: index % 2 === 0,
    isOrderHit: index % 3 === 0,
    isPositionHit: index % 4 === 0,
    isPerfect: index === 0,
    point: index === 0 ? 11 : index === 1 ? 0 : 7
  }));
  const rendered = context.render({
    total: 48,
    max: 99,
    perfectLabel: "",
    counts: { player: 6, order: 3, position: 2, perfect: 1 },
    breakdown: {
      player: { total: 30, max: 45 },
      order: { total: 9, max: 27 },
      position: { total: 10, max: 18 },
      perfect: { total: 1, max: 9 }
    },
    details
  });

  assert.equal(rendered.width, 1180);
  assert.equal(rendered.height, 2 * (12 + 78 + 10 + 70 + 10 + 38 + 9 * 50 + 12));
});
