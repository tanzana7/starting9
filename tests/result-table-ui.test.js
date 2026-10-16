const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "frontend/public/results.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const publicResultsRenderer = fs.readFileSync(path.join(root, "frontend/public/render-results.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "frontend/public/results.js"), "utf8");

function sourceForFunction(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  const next = script.indexOf("\n    function ", start + 1);
  return script.slice(start, next === -1 ? script.length : next);
}

test("判定バッジは○×だけでなく判定対象ラベルを表示する", () => {
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

test("公開結果画面ではスコア比較ブロックを表示しない", () => {
  assert.doesNotMatch(html, /scoreInsights|スコアの比較|全国平均|比較データは参加者が増え次第表示されます/);
  assert.doesNotMatch(publicResultsRenderer, /deps\.renderScoreInsights\(/);
});

test("結果テーブルの選手セルにはカテゴリ背景クラスを付けず、守備位置表示は維持する", () => {
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
  const canvas = sourceForFunction("createResultCanvas");
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

test("結果Canvasは代表的な採点結果を実行時に描画できる", async (t) => {
  const drawContext = {
    scale() {}, beginPath() {}, moveTo() {}, arcTo() {}, closePath() {},
    fill() {}, stroke() {}, fillRect() {}, lineTo() {}, fillText() {},
    measureText(value) { return { width: String(value).length * 8 }; }
  };
  let app;
  let rendered;
  const lineup = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"].map((position, index) => ({
    battingOrder: index + 1, playerName: "選手" + index, position
  }));
  app = createPublicRuntime({
    ui: true,
    dragRuntime: true,
    canvasFactory: () => {
      rendered = app.createElement();
      rendered.getContext = () => drawContext;
      return rendered;
    },
    fetchImpl: async (url) => {
      const game = { internalGameId: "a", resultId: "a", resultsPublished: true };
      const path = new URL(url).pathname;
      const payload = path === "/api/public/previous-result-game"
        ? { ok: true, game }
        : path === "/api/results/games"
          ? { ok: true, games: [game] }
          : { ok: true, internalGameId: "a", resultsPublished: true, prediction: { lineup }, actualLineup: lineup };
      return { ok: true, status: 200, json: async () => payload };
    }
  });
  t.after(app.dispose);
  for (const id of ["scoreResult", "result-title", "result-legend"]) app.elements.set(id, app.createElement());
  await app.operations.fetchPreviousResultGame();
  await app.operations.refreshResultHistory();
  await new Promise(setImmediate);

  assert.ok(rendered, "the public result path must render a canvas");
  assert.equal(rendered.width, 1180);
  assert.equal(rendered.height, 2 * (12 + 78 + 10 + 70 + 10 + 38 + 9 * 50 + 12));
  assert.equal(rendered.getAttribute("role"), "img");
  assert.ok(app.elements.get("scoreResult").children.some((node) => node.children.includes(rendered)));
});
