const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

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
