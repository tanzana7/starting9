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

function runTargetOrder(lineup, activeIndex) {
  const context = vm.createContext({
    LINEUP_SIZE: 9,
    state: { activeOrder: { prediction: activeIndex } }
  });
  vm.runInContext(
    `${getFunctionSource("findFirstEmptyIndex")}; ${getFunctionSource("findNextEmptyIndex")}; ${getFunctionSource("getTargetOrder")}; this.run = getTargetOrder;`,
    context
  );
  return context.run("prediction", lineup);
}

function runNextEmptyIndex(lineup, startIndex) {
  const context = vm.createContext({ LINEUP_SIZE: 9 });
  vm.runInContext(`${getFunctionSource("findNextEmptyIndex")}; this.run = findNextEmptyIndex;`, context);
  return context.run(lineup, startIndex);
}

function runSlotMove(lineup, sourceIndex, targetIndex) {
  const context = vm.createContext({
    LINEUP_SIZE: 9,
    state: { activeOrder: { prediction: 0 } },
    ensurePredictionEditingAllowed: () => true,
    getLineupValues: () => lineup,
    setLineupValues: (_pickerName, nextLineup) => {
      context.movedLineup = nextLineup;
    },
    clearMessage: () => {},
    normalizePlayerName: (value) => String(value || "").trim(),
    normalizePosition: (value) => String(value || "")
  });
  vm.runInContext(
    `${getFunctionSource("createLineupItem")}; ${getFunctionSource("normalizeLineup")}; ${getFunctionSource("findNextEmptyIndex")}; ${getFunctionSource("moveLineupSlot")}; this.run = moveLineupSlot;`,
    context
  );
  context.run("prediction", sourceIndex, targetIndex);
  return {
    activeIndex: context.state.activeOrder.prediction,
    lineup: JSON.parse(JSON.stringify(context.movedLineup))
  };
}

test("ドラッグ後は現在位置より後ろの最初の空き打順を選ぶ", () => {
  const lineup = [{ player: "A" }, { player: "" }, { player: "B" }, { player: "" }];
  assert.equal(runNextEmptyIndex(lineup, 0), 1);
});

test("後ろに空きがなければ先頭から最初の空き打順を選ぶ", () => {
  const lineup = Array.from({ length: 9 }, (_, index) => ({ player: index === 2 ? "" : `P${index}` }));
  assert.equal(runNextEmptyIndex(lineup, 8), 2);
});

test("全打順が埋まっている場合は安全のため投入先を解除する", () => {
  const lineup = Array.from({ length: 9 }, (_, index) => ({ player: `P${index}` }));
  assert.equal(runNextEmptyIndex(lineup, 8), -1);
  assert.equal(runTargetOrder(lineup, -1), -1);
});

test("既存打順へのドラッグ移動後も次の空き打順へ移動する", () => {
  const result = runSlotMove(
    [{ player: "A", position: "遊" }, { player: "B", position: "中" }, { player: "" }],
    0,
    1
  );
  assert.equal(result.activeIndex, 2);
  assert.deepEqual(result.lineup.slice(0, 2).map((item) => item.player), ["B", "A"]);
});

test("守備位置メニューはviewport固定クラスとcache busterを持つ", () => {
  assert.match(script, /is-viewport-positioned/);
  assert.match(css, /\.position-menu\.is-viewport-positioned\s*\{/);
  assert.match(html, /public-result-raw-lineup-comparison-1/);
});
