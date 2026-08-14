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
  assert.match(positionPointerDown, /event\.pointerType !== "mouse"/);
  assert.match(positionPointerDown, /activateOnMove: true/);
  assert.doesNotMatch(dragStart, /if \(!position\)/);
  assert.match(dragStart, /kind: "position"/);
  assert.match(dragStart, /position,/);
});

test("実DOM風のpointerdown→pointermove→pointerupでposition chipだけがswapされる", () => {
  class FakeClassList {
    constructor() {
      this.values = new Set();
    }

    add(...names) {
      names.forEach((name) => this.values.add(name));
    }

    remove(...names) {
      names.forEach((name) => this.values.delete(name));
    }
  }

  class FakeElement extends EventTarget {
    constructor(dataset) {
      super();
      this.dataset = dataset;
      this.classList = new FakeClassList();
      this.capturedPointerId = null;
    }

    setPointerCapture(pointerId) {
      this.capturedPointerId = pointerId;
    }

    hasPointerCapture(pointerId) {
      return this.capturedPointerId === pointerId;
    }

    releasePointerCapture(pointerId) {
      if (this.capturedPointerId === pointerId) this.capturedPointerId = null;
    }

    closest() {
      return this;
    }
  }

  class FakeDocument extends EventTarget {
    constructor(target) {
      super();
      this.target = target;
    }

    elementFromPoint() {
      return this.target;
    }

    querySelectorAll(selector) {
      return selector.includes('data-picker="prediction"') ? [source, target] : [];
    }
  }

  const source = new FakeElement({ picker: "prediction", order: "0" });
  const target = new FakeElement({ picker: "prediction", order: "1" });
  const document = new FakeDocument(target);
  let swap = null;
  const context = vm.createContext({
    document,
    Element: FakeElement,
    Date,
    Math,
    setTimeout,
    clearTimeout,
    state: { pointerInteraction: null, pointerSuppressClickUntil: 0 },
    POINTER_DRAG_DISTANCE: 6,
    POINTER_LONG_PRESS_MS: 500,
    isPredictionEditingLocked: () => false,
    closeAllPositionMenus: () => {},
    movePositionBetweenSlots: (...args) => {
      swap = args;
    }
  });
  vm.runInContext(
    `${getFunctionSource("handlePositionPointerDown")}; ${getFunctionSource("beginPointerInteraction")}; ${getFunctionSource("activatePointerInteraction")}; ${getFunctionSource("handlePointerInteractionMove")}; ${getFunctionSource("handlePointerInteractionEnd")}; ${getFunctionSource("handlePointerInteractionCancel")}; ${getFunctionSource("clearPointerInteraction")}; this.handlePositionPointerDown = handlePositionPointerDown; this.handlePointerInteractionMove = handlePointerInteractionMove; this.handlePointerInteractionEnd = handlePointerInteractionEnd;`,
    context
  );
  source.draggable = true;
  source.addEventListener("pointerdown", (event) => context.handlePositionPointerDown(event, source, source));
  document.addEventListener("pointermove", (event) => context.handlePointerInteractionMove(event));
  document.addEventListener("pointerup", (event) => context.handlePointerInteractionEnd(event));

  const pointerEvent = (type, values) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.entries({ pointerId: 7, pointerType: "mouse", inputSource: "pointer", ...values }).forEach(([key, value]) => {
      Object.defineProperty(event, key, { configurable: true, value });
    });
    return event;
  };

  source.dispatchEvent(pointerEvent("pointerdown", { clientX: 0, clientY: 0 }));
  document.dispatchEvent(pointerEvent("pointermove", { clientX: 20, clientY: 0 }));
  document.dispatchEvent(pointerEvent("pointerup", { clientX: 20, clientY: 0 }));

  assert.deepEqual(swap, ["prediction", 0, 1]);
  assert.equal(source.dataset.order, "0");
  assert.equal(target.dataset.order, "1");
  assert.equal(source.draggable, true);
});

test("守備位置チップのdragは同じ行では変更せず、別行では選手名を維持してswapする", () => {
  const lineup = [
    { player: "レイエス", position: "指" },
    { player: "郡司裕也", position: "三" },
    { player: "未選択", position: "" }
  ];
  const sameRow = JSON.parse(JSON.stringify(runLineupFunction("moveLineupPosition", lineup, 0, 0)));
  assert.deepEqual(sameRow.slice(0, 3), lineup.map((item, index) => ({ order: index + 1, ...item })));
  const swapped = JSON.parse(JSON.stringify(runLineupFunction("moveLineupPosition", lineup, 0, 1)));
  assert.deepEqual(swapped.slice(0, 3).map((item) => item.position), ["三", "指", ""]);
  assert.deepEqual(swapped.slice(0, 3).map((item) => item.player), ["レイエス", "郡司裕也", "未選択"]);
  const emptySwap = JSON.parse(JSON.stringify(runLineupFunction("moveLineupPosition", lineup, 0, 2)));
  assert.deepEqual(emptySwap.slice(0, 3).map((item) => item.position), ["", "三", "指"]);
  assert.deepEqual(emptySwap.slice(0, 3).map((item) => item.player), ["レイエス", "郡司裕也", "未選択"]);
});

test("別選手を設定すると前の選手の守備位置を引き継がない", () => {
  const result = runLineupFunction("moveLineupItem", [{ player: "田宮裕涼", position: "捕" }], "清宮幸太郎", 0, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result[0])), { order: 1, player: "清宮幸太郎", position: "" });
});

test("ドラッグ移動は選手と守備位置をセットで入れ替え、重複を作らない", () => {
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
