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
  assert.match(source, /colspan="2" class="result-group-heading">あなたの予想/);
  assert.match(source, /colspan="2" class="result-group-heading result-actual-group-heading">実際のスタメン/);
  assert.match(source, /colspan="3" class="result-group-heading">判定/);
  assert.match(source, /rowspan="2" class="result-point-heading">点数/);
  assert.match(source, /rowspan="2" class="result-order-heading">打順/);
  assert.doesNotMatch(source, /実際の打順<\/th>/);
  assert.doesNotMatch(source, /実際は/);
  assert.doesNotMatch(source, /result-actual-order-note/);
  assert.match(source, /createResultPlayerCardHtml\(detail\.player, detail\.position\)/);
  assert.match(source, /createResultPlayerCardHtml\(detail\.actualPlayer \|\| "-", detail\.actualPosition\)/);
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
  assert.match(css, /\.result-player-name\s*\{[\s\S]*font-size: 1\.05rem/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*font-weight: 500/);
});

test("結果テーブルの選手カードは守備位置と名前を薄い枠線で一体化する", () => {
  assert.match(css, /\.result-player-card\s*\{[\s\S]*border: 1px solid var\(--border\)/);
  assert.match(css, /\.result-player-card\s*\{[\s\S]*border-radius: 7px/);
  assert.match(css, /\.result-player-card \.result-position-tile\s*\{[\s\S]*border-right: 1px solid var\(--border\)/);
  assert.match(css, /\.result-player-card \.result-player-name\s*\{[\s\S]*border: 0/);
});

test("結果テーブルの選手名ブロックはPCとスマホで幅を揃える", () => {
  assert.match(css, /\.result-player-name\s*\{[\s\S]*width: 132px[\s\S]*min-width: 132px[\s\S]*max-width: 132px/);
  assert.match(css, /\.result-player-card \.result-player-name\s*\{[\s\S]*flex: 0 0 132px[\s\S]*min-width: 132px/);
  assert.match(css, /@media \(max-width: 430px\)[\s\S]*\.result-player-name\s*\{[\s\S]*width: 112px[\s\S]*min-width: 112px[\s\S]*max-width: 112px[\s\S]*\.result-player-card \.result-player-name\s*\{[\s\S]*flex-basis: 112px[\s\S]*min-width: 112px/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*overflow-wrap: anywhere/);
});

test("採点結果テーブルはスマホでも内容を保持して横スクロールできる", () => {
  assert.match(css, /\.result-table-wrap\s*\{[\s\S]*overflow-x: auto/);
  assert.match(css, /\.result-table\s*\{[\s\S]*min-width: 700px/);
  assert.match(css, /\.result-player-name\s*\{[\s\S]*overflow-wrap: anywhere/);
});
