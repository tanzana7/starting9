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

function createPositionSelection(lineup, targetIndex, position) {
  const context = vm.createContext({
    normalizeLineup: (items) => items.map((item, index) => ({ order: index + 1, player: item.player, position: item.position || "" })),
    normalizePosition: (value) => value,
    createLineupItem: (index, player, selectedPosition) => ({ order: index + 1, player, position: selectedPosition })
  });
  vm.runInContext(`${getFunctionSource("createPositionSelectionLineup")}; this.select = createPositionSelectionLineup;`, context);
  return context.select(lineup, targetIndex, position);
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

function runLineupSlotMove(lineup, sourceIndex, targetIndex) {
  let movedLineup = null;
  const context = vm.createContext({
    LINEUP_SIZE: 9,
    state: { activeOrder: { actual: 0 } },
    ensurePredictionEditingAllowed: () => true,
    getLineupValues: () => lineup,
    setLineupValues: (_pickerName, nextLineup) => {
      movedLineup = nextLineup;
    },
    clearMessage: () => {},
    normalizePlayerName: (value) => String(value || "").trim(),
    normalizePosition: (value) => String(value || "")
  });
  vm.runInContext(`${getFunctionSource("createLineupItem")}; ${getFunctionSource("normalizeLineup")}; ${getFunctionSource("moveLineupSlot")}; this.run = moveLineupSlot;`, context);
  context.run("actual", sourceIndex, targetIndex);
  return JSON.parse(JSON.stringify(movedLineup));
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

test("別選手を設定すると前の選手の守備位置を引き継がない", () => {
  const result = runLineupFunction("moveLineupItem", [{ player: "田宮裕涼", position: "捕" }], "清宮幸太郎", 0, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result[0])), { order: 1, player: "清宮幸太郎", position: "" });
});

test("上下移動は選手と守備位置をセットで入れ替え、重複を作らない", () => {
  const result = runLineupSlotMove([
    { player: "田宮裕涼", position: "捕" },
    { player: "清宮幸太郎", position: "一" }
  ], 0, 1);
  assert.deepEqual(result.slice(0, 2), [
    { order: 1, player: "清宮幸太郎", position: "一" },
    { order: 2, player: "田宮裕涼", position: "捕" }
  ]);
  assert.equal(result.filter((item) => item.player === "田宮裕涼").length, 1);
});

test("使用済みポジションはグレー表示でもdisabledにせず、入れ替え案内を付ける", () => {
  const menuState = getFunctionSource("updatePositionMenuState");
  assert.match(menuState, /classList\.toggle\("is-used", isUsed\)/);
  assert.match(menuState, /選択するとポジションを入れ替えます/);
  assert.doesNotMatch(menuState, /disabled|aria-disabled/);
  assert.match(css, /\.position-menu-option\.is-used/);
  assert.doesNotMatch(css, /\.position-menu-option\.is-used[\s\S]*?cursor:\s*not-allowed/);
});

test("使用済みポジションを選ぶと、2行のポジションを入れ替える", () => {
  const lineup = [
    { player: "マルティネス", position: "一" },
    { player: "清宮幸太郎", position: "左" }
  ];
  const result = createPositionSelection(lineup, 1, "一");
  assert.deepEqual(result.map((item) => item.position), ["左", "一"]);
  assert.deepEqual(result.map((item) => item.player), ["マルティネス", "清宮幸太郎"]);
});

test("元ポジションが未選択なら、使用していた行を未選択に戻す", () => {
  const lineup = [
    { player: "マルティネス", position: "一" },
    { player: "清宮幸太郎", position: "" }
  ];
  const result = createPositionSelection(lineup, 1, "一");
  assert.deepEqual(result.map((item) => item.position), ["", "一"]);
});

test("現在選択中のポジションを選んでも他行を変更しない", () => {
  const lineup = [
    { player: "マルティネス", position: "一" },
    { player: "清宮幸太郎", position: "左" }
  ];
  const result = createPositionSelection(lineup, 1, "左");
  assert.deepEqual(result.map((item) => item.position), ["一", "左"]);
});

test("保存時の既存重複検証を維持する", () => {
  const validation = getFunctionSource("validateLineup");
  assert.match(validation, /hasDuplicatePositions\(lineup\)/);
  assert.match(validation, /同じ守備位置が複数回選ばれています/);
});
