const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

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

test("採点結果テーブルは予想、実際、判定、点数の順で構成する", () => {
  const source = sourceForFunction("createResultTable");
  assert.match(source, /colspan="2" class="result-group-heading">あなたの予想/);
  assert.match(source, /rowspan="2" class="result-actual-order-heading">実際の打順/);
  assert.match(source, /colspan="2" class="result-group-heading result-actual-group-heading">実際のスタメン/);
  assert.match(source, /colspan="3" class="result-group-heading">判定/);
  assert.match(source, /rowspan="2" class="result-point-heading">点数/);
  assert.match(source, /rowspan="2" class="result-order-heading">予想打順/);
  assert.match(source, /result-actual-order-cell/);
  assert.match(source, /detail\.actualOrder \? `\$\{detail\.actualOrder\}番` : "—"/);
  assert.match(source, /result-player-cell .*detail\.player/);
  assert.match(source, /result-player-cell .*detail\.actualPlayer/);
  assert.match(source, /createHitBadge\(detail\.isPlayerHit, "出場"\)/);
  assert.match(source, /createHitBadge\(detail\.isOrderHit, "打順"\)/);
  assert.match(source, /createHitBadge\(detail\.isPositionHit, "守備"\)/);
});

test("判定バッジは○×だけでなく判定対象ラベルを表示する", () => {
  const source = sourceForFunction("createHitBadge");
  assert.match(source, /function createHitBadge\(isHit, label\)/);
  assert.match(source, /hit-mark/);
  assert.match(source, /escapeHtml\(label\)/);
  assert.match(css, /\.hit-badge\s*\{[\s\S]*display: inline-flex/);
});

test("実際の打順はplayerIdを優先し、見つからない場合は未表示にする", () => {
  const scoring = sourceForFunction("findActualLineupItem");
  assert.match(scoring, /item\.playerId === playerId/);
  assert.match(scoring, /normalizePlayerKey\(item\.player\)/);
  assert.match(sourceForFunction("scoreLineup"), /actualOrder: actualItem\?\.order \|\| null/);
  assert.match(sourceForFunction("createResultTable"), /: "—"/);

  const idMatch = findActualLineupItem(
    { player: "同名選手", playerId: "F-9" },
    [
      { order: 1, player: "同名選手", playerId: "F-10" },
      { order: 2, player: "別表記", playerId: "F-9" }
    ]
  );
  assert.equal(idMatch.order, 2);
});

test("採点結果テーブルはスマホでも内容を保持して横スクロールできる", () => {
  assert.match(css, /\.result-table-wrap\s*\{[\s\S]*overflow-x: auto/);
  assert.match(css, /\.result-table\s*\{[\s\S]*min-width: 760px/);
  assert.match(css, /\.result-table \.result-player-cell\s*\{[\s\S]*overflow-wrap: anywhere/);
});
