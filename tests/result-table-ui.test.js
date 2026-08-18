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

test("採点結果テーブルは同じ打順を予想と実際で比較する", () => {
  const source = sourceForFunction("createResultTable");
  assert.match(source, /<th class="result-group-heading">あなたの予想/);
  assert.match(source, /<th class="result-group-heading result-actual-group-heading">実際のスタメン/);
  assert.match(source, /<th class="result-group-heading">判定/);
  assert.match(source, /<th class="result-point-heading">点数/);
  assert.match(source, /<th class="result-order-heading">打順/);
  assert.doesNotMatch(source, /実際の打順<\/th>/);
  assert.doesNotMatch(source, /実際は/);
  assert.doesNotMatch(source, /result-actual-order-note/);
  assert.match(source, /createResultPlayerCardHtml\(detail\.player, detail\.position\)/);
  assert.match(source, /createResultPlayerCardHtml\(detail\.actualPlayer \|\| "-", detail\.actualPosition\)/);
  assert.match(source, /class="result-judgement-stack"/);
  assert.match(source, /createHitBadge\(detail\.isPlayerHit, "出場"\)/);
  assert.match(source, /createHitBadge\(detail\.isOrderHit, "打順"\)/);
  assert.match(source, /createHitBadge\(detail\.isPositionHit, "守備"\)/);
  assert.equal((source.match(/createHitBadge\(detail\./g) || []).length, 3);
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

test("実際の打順照合は内部処理として維持し、結果テーブルには表示しない", () => {
  const scoring = sourceForFunction("findActualLineupItem");
  assert.match(scoring, /item\.playerId === playerId/);
  assert.match(scoring, /normalizePlayerKey\(item\.player\)/);
  assert.match(sourceForFunction("scoreLineup"), /actualOrder: actualItem\?\.order \|\| null/);
  const table = sourceForFunction("createResultTable");
  assert.doesNotMatch(table, /detail\.actualOrder/);
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
  assert.match(card, /class="result-player-name"/);
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

test("採点結果テーブルは保存済み予想に近い青い表組みでスマホにも収める", () => {
  assert.match(css, /\.result-table-wrap\s*\{[\s\S]*overflow-x: auto/);
  assert.match(css, /\.result-table\s*\{[\s\S]*min-width: 520px/);
  assert.match(css, /\.result-table\s*\{[\s\S]*border-spacing: 0 5px/);
  assert.match(css, /\.result-table th\s*\{[\s\S]*color: #ffffff[\s\S]*background: var\(--fighters-blue\)/);
  assert.match(css, /\.result-table \.result-order-cell strong\s*\{[\s\S]*color: #ffffff[\s\S]*background: var\(--fighters-blue\)/);
  assert.match(css, /\.result-table tbody tr td:first-child\s*\{[\s\S]*border-left: 1px solid #d3dfeb/);
  assert.match(css, /\.result-table tbody tr td:last-child\s*\{[\s\S]*border-right: 1px solid #d3dfeb/);
  assert.match(css, /\.result-judgement-stack\s*\{[\s\S]*display: flex[\s\S]*flex-wrap: nowrap/);
  assert.match(css, /\.result-judgement-stack \.hit-badge\s*\{[\s\S]*min-width: 0[\s\S]*font-size: 0\.62rem/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*overflow-wrap: anywhere/);
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
  assert.match(canvas, /drawPlayerCard\(detail\.player, detail\.position/);
  assert.match(canvas, /drawPlayerCard\(detail\.actualPlayer/);
  assert.match(canvas, /drawJudgement\(detail\.isPlayerHit, "出場"/);
  assert.match(canvas, /drawJudgement\(detail\.isOrderHit, "打順"/);
  assert.match(canvas, /drawJudgement\(detail\.isPositionHit, "守備"/);
});

test("結果Canvasは判定列・行高・点数バッジを微調整する", () => {
  const canvas = sourceForFunction("createResultCanvas");
  assert.match(canvas, /const rowHeight = 52/);
  assert.match(canvas, /const judgementWidth = displayWidth < 480 \? 94 : 126/);
  assert.match(canvas, /const chipGap = 4/);
  assert.match(canvas, /const isPerfectRow = pointValue >= 10/);
  assert.match(canvas, /const isZeroRow = pointValue === 0/);
  assert.match(canvas, /const pointFill = isPerfectRow/);
  assert.match(canvas, /context\.fillStyle = "#f7fbff"/);
  assert.match(canvas, /drawRoundedRect\(pointX \+ 5/);
});

test("結果Canvasは列座標を使用前に初期化する", () => {
  const canvas = sourceForFunction("createResultCanvas");
  const actualColumnDeclaration = canvas.indexOf("const actualColumnX = predictedColumnX + playerWidth;");
  const actualColumnUse = canvas.indexOf("context.fillRect(actualColumnX + 1");
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
    point: index === 0 ? 10 : index === 1 ? 0 : 7
  }));
  const rendered = context.render({
    total: 48,
    max: 100,
    perfectLabel: "",
    counts: { player: 6, order: 3, position: 5 },
    breakdown: {
      player: { total: 30, max: 50 },
      order: { total: 9, max: 30 },
      position: { total: 10, max: 20 }
    },
    details
  });

  assert.equal(rendered.width, 1240);
  assert.equal(rendered.height, 2 * (12 + 78 + 10 + 70 + 10 + 38 + 9 * 52 + 8 * 4 + 12));
});
