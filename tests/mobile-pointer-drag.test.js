const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");

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

class FakeElement {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.capturedPointerId = null;
    this.classNames = new Set();
    this.closestResult = null;
    this.classList = {
      add: (...names) => names.forEach((name) => this.classNames.add(name)),
      remove: (...names) => names.forEach((name) => this.classNames.delete(name))
    };
  }

  closest() {
    return this.closestResult;
  }

  setPointerCapture(pointerId) {
    this.capturedPointerId = pointerId;
  }

  hasPointerCapture(pointerId) {
    return this.capturedPointerId === pointerId;
  }

  releasePointerCapture(pointerId) {
    assert.equal(this.capturedPointerId, pointerId);
    this.capturedPointerId = null;
  }
}

function createPointerHarness() {
  const timers = [];
  const target = new FakeElement({ picker: "prediction", order: "2" });
  target.closestResult = target;
  let moved = null;
  let assigned = null;
  const context = vm.createContext({
    Element: FakeElement,
    Math,
    Date,
    POINTER_LONG_PRESS_MS: 250,
    POINTER_DRAG_DISTANCE: 8,
    state: { pointerInteraction: null, pointerSuppressClickUntil: 0 },
    isPredictionEditingLocked: () => false,
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length - 1;
    },
    clearTimeout: (timerId) => {
      timers[timerId] = null;
    },
    document: {
      elementFromPoint: () => target,
      querySelectorAll: () => []
    },
    moveLineupSlot: (...args) => {
      moved = args;
    },
    assignPlayerToSlot: (...args) => {
      assigned = args;
    }
  });
  const functions = [
    "beginPointerInteraction",
    "activatePointerInteraction",
    "handlePointerInteractionMove",
    "handlePointerInteractionEnd",
    "handlePointerInteractionCancel",
    "clearPointerInteraction"
  ].map(getFunctionSource).join("\n");
  vm.runInContext(`${functions}; this.api = { beginPointerInteraction, handlePointerInteractionMove, handlePointerInteractionEnd, handlePointerInteractionCancel };`, context);
  return { context, timers, target, getMoved: () => moved, getAssigned: () => assigned };
}

function pointerEvent(pointerId, x = 0, y = 0, target = new FakeElement()) {
  return {
    pointerId,
    pointerType: "touch",
    clientX: x,
    clientY: y,
    target,
    preventDefault() {}
  };
}

test("選手名の子要素からでも選手行の長押しドラッグを開始できる", () => {
  const harness = createPointerHarness();
  const player = new FakeElement({ picker: "prediction", player: "選手A" });
  const playerName = new FakeElement();
  playerName.closestResult = player;
  harness.context.api.beginPointerInteraction(pointerEvent(1, 10, 10, playerName), player, "player");
  assert.ok(harness.context.state.pointerInteraction);
  harness.timers[0]();
  harness.context.api.handlePointerInteractionMove(pointerEvent(1, 10, 20, playerName));
  harness.context.api.handlePointerInteractionEnd(pointerEvent(1, 10, 20, playerName));
  assert.deepEqual(harness.getAssigned(), ["prediction", "選手A", 2, null]);
});

test("長押し前の8px超移動はスクロールとしてキャンセルする", () => {
  const harness = createPointerHarness();
  const slot = new FakeElement({ picker: "prediction", order: "1", player: "選手A" });
  harness.context.api.beginPointerInteraction(pointerEvent(1, 10, 10, slot), slot, "lineup");
  harness.context.api.handlePointerInteractionMove(pointerEvent(1, 10, 19, slot));
  assert.equal(harness.context.state.pointerInteraction, null);
  assert.equal(harness.getMoved(), null);
});

test("pointerId不一致の移動を無視し、pointerupとpointercancelで状態を完全に解除する", () => {
  const harness = createPointerHarness();
  const slot = new FakeElement({ picker: "prediction", order: "1", player: "選手A" });
  harness.context.api.beginPointerInteraction(pointerEvent(7, 10, 10, slot), slot, "lineup");
  harness.timers[0]();
  harness.context.api.handlePointerInteractionMove(pointerEvent(8, 10, 20, slot));
  assert.equal(harness.context.state.pointerInteraction.pointerId, 7);
  harness.context.api.handlePointerInteractionCancel(pointerEvent(7, 10, 20, slot));
  assert.equal(harness.context.state.pointerInteraction, null);

  harness.context.api.beginPointerInteraction(pointerEvent(9, 10, 10, slot), slot, "lineup");
  harness.timers[1]();
  harness.context.api.handlePointerInteractionEnd(pointerEvent(9, 10, 20, slot));
  assert.equal(harness.context.state.pointerInteraction, null);
  assert.equal(slot.capturedPointerId, null);
});

test("打順ドラッグでは既存の共通移動関数へ渡す", () => {
  const harness = createPointerHarness();
  const slot = new FakeElement({ picker: "prediction", order: "1", player: "選手A" });
  harness.context.api.beginPointerInteraction(pointerEvent(1, 10, 10, slot), slot, "lineup");
  harness.timers[0]();
  harness.context.api.handlePointerInteractionMove(pointerEvent(1, 10, 20, slot));
  harness.context.api.handlePointerInteractionEnd(pointerEvent(1, 10, 10, slot));
  assert.deepEqual(harness.getMoved(), ["prediction", 1, 2]);
});
