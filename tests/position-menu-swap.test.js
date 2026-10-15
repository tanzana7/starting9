const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

function getFunctionSource(name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  let depth = 0;
  let bodyStarted = false;
  for (let index = start; index < script.length; index += 1) {
    if (script[index] === "{") {
      depth += 1;
      bodyStarted = true;
    } else if (script[index] === "}") {
      depth -= 1;
      if (bodyStarted && depth === 0) return script.slice(start, index + 1);
    }
  }
  throw new Error(`${name} の終端を見つけられません`);
}

function runLineupFunction(name, lineup, ...args) {
  const context = vm.createContext({
    LINEUP_SIZE: 9,
    normalizePlayerName: (value) => String(value || "").trim(),
    normalizePosition: (value) => String(value || "")
  });
  vm.runInContext(`${getFunctionSource("createLineupItem")}; ${getFunctionSource("normalizeLineup")}; ${getFunctionSource(name)}; this.run = ${name};`, context);
  return context.run(lineup, ...args);
}

function resolveAutoFillPosition(positions, usedPositions) {
  const context = vm.createContext({
    AUTO_FILL_POSITIONS: new Set(["捕", "一", "二", "三", "遊", "指"]),
    OUTFIELD_POSITIONS: ["左", "中", "右"],
    normalizePosition: (value) => ({ "1B": "一", "2B": "二", "3B": "三", OF: "", LF: "左", CF: "中", RF: "右" }[String(value || "")] || String(value || "")),
    normalizeDisplayPosition: (value) => ["OF", "外", "外野"].includes(String(value || "")) ? "外" : String(value || "")
  });
  vm.runInContext(`${getFunctionSource("resolveAutoFillPosition")}; this.run = resolveAutoFillPosition;`, context);
  return JSON.parse(JSON.stringify(context.run(positions, new Set(usedPositions))));
}

test("選手一覧に主ポジションの凡例があり、既存カテゴリ色を再利用する", () => {
  assert.match(html, /class="player-category-legend"/);
  assert.match(html, /色は主ポジション/);
  assert.match(html, /player-category-legend-item is-category-catcher/);
  assert.match(css, /\.player-category-legend-item\.is-category-catcher/);
  assert.match(css, /\.player-category-legend-item\.is-category-infielder/);
  assert.match(css, /\.player-category-legend-item\.is-category-outfielder/);
  assert.match(css, /\.player-category-legend-item\.is-category-dh/);
});

test("選手を削除すると選手と守備位置を同時にクリアする", () => {
  const result = runLineupFunction("clearLineupItem", [{ player: "田宮裕涼", position: "捕" }], 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result[0])), { order: 1, player: "", position: "" });
});

test("守備位置チップはPCでdrag可能で、未選択の?もswap対象になる", () => {
  const positionControl = getFunctionSource("createPositionControl");
  const dragStart = getFunctionSource("handlePositionDragStart");
  const positionPointerDown = getFunctionSource("handlePositionPointerDown");
  assert.match(positionControl, /button\.dataset\.picker = pickerName/);
  assert.match(positionControl, /button\.dataset\.order = String\(index\)/);
  assert.match(positionControl, /button\.addEventListener\("pointerdown"/);
  assert.match(positionControl, /Date\.now\(\) < state\.pointerSuppressClickUntil/);
  assert.match(positionPointerDown, /event\.pointerType !== "mouse"/);
  assert.match(positionPointerDown, /activateOnMove: true/);
  assert.doesNotMatch(dragStart, /if \(!position\)/);
  assert.match(dragStart, /kind: "position"/);
  assert.match(dragStart, /position,/);
});

test("守備位置チップのdragは同じ行では変更せず、別行では選手名を維持してswapする", () => {
  const lineup = [
    { player: "レイエス", position: "指" },
    { player: "郡司裕也", position: "三" },
    { player: "", position: "" }
  ];
  const sameRow = JSON.parse(JSON.stringify(runLineupFunction("moveLineupPosition", lineup, 0, 0)));
  assert.deepEqual(sameRow.slice(0, 3), lineup.map((item, index) => ({ order: index + 1, ...item })));
  const swapped = JSON.parse(JSON.stringify(runLineupFunction("moveLineupPosition", lineup, 0, 1)));
  assert.deepEqual(swapped.slice(0, 3).map((item) => item.position), ["三", "指", ""]);
  assert.deepEqual(swapped.slice(0, 3).map((item) => item.player), ["レイエス", "郡司裕也", ""]);
  const emptySwap = JSON.parse(JSON.stringify(runLineupFunction("moveLineupPosition", lineup, 0, 2)));
  assert.deepEqual(emptySwap.slice(0, 3).map((item) => item.position), ["", "三", "指"]);
  assert.deepEqual(emptySwap.slice(0, 3).map((item) => item.player), ["レイエス", "郡司裕也", ""]);
});

test("ドラッグ経路で別選手を設定すると前の選手の守備位置を引き継がない", () => {
  const result = runLineupFunction("moveLineupItem", [{ player: "田宮裕涼", position: "捕" }], "清宮幸太郎", 0, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result[0])), { order: 1, player: "清宮幸太郎", position: "" });
});

test("使用済みポジションはグレー表示でもdisabledにせず、入れ替え案内を付ける", () => {
  assert.match(css, /\.position-menu-option\.is-used/);
  const usedOptionCss = css.slice(css.indexOf(".position-menu-option.is-used"), css.indexOf(".position-menu-option.is-used:hover"));
  assert.doesNotMatch(usedOptionCss, /cursor:\s*not-allowed/);
});

test("保存時の既存重複検証を維持する", () => {
  const validation = getFunctionSource("validateLineup");
  assert.match(validation, /hasDuplicatePositions\(lineup\)/);
  assert.match(validation, /同じ守備位置が複数回選ばれています/);
});

test("OFの空きが複数ある場合は後続の2Bへ自動入力しない", () => {
  const result = resolveAutoFillPosition(["1B", "3B", "OF", "2B"], ["一", "三"]);
  assert.deepEqual(result, { position: "", ambiguous: true });
});

test("OFの空きがLFだけならLFを自動入力する", () => {
  const result = resolveAutoFillPosition(["1B", "3B", "OF", "2B"], ["一", "三", "中", "右"]);
  assert.deepEqual(result, { position: "左", ambiguous: false });
});

test("外野がすべて埋まっている場合は2Bへ進む", () => {
  const result = resolveAutoFillPosition(["1B", "3B", "OF", "2B"], ["一", "三", "左", "中", "右"]);
  assert.deepEqual(result, { position: "二", ambiguous: false });
});

test("通常の具体ポジション候補は空いている3Bを自動入力する", () => {
  const result = resolveAutoFillPosition(["1B", "3B"], ["一"]);
  assert.deepEqual(result, { position: "三", ambiguous: false });
});
