const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

function sourceForFunction(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  const next = script.indexOf("\nfunction ", start + 1);
  return script.slice(start, next === -1 ? script.length : next);
}

test("採点結果テーブルは予想、実際、判定、点数の順で構成する", () => {
  const source = sourceForFunction("createResultTable");
  assert.match(source, /colspan="2" class="result-group-heading">あなたの予想/);
  assert.match(source, /colspan="2" class="result-group-heading">実際/);
  assert.match(source, /colspan="3" class="result-group-heading">判定/);
  assert.match(source, /rowspan="2" class="result-point-heading">点数/);
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

test("採点結果テーブルはスマホでも内容を保持して横スクロールできる", () => {
  assert.match(css, /\.result-table-wrap\s*\{[\s\S]*overflow-x: auto/);
  assert.match(css, /\.result-table\s*\{[\s\S]*min-width: 760px/);
  assert.match(css, /\.result-table \.result-player-cell\s*\{[\s\S]*overflow-wrap: anywhere/);
});
