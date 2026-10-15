const test = require("node:test");
const assert = require("node:assert/strict");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

function createDragRuntime() {
  const runtime = createPublicRuntime({
    ui: true,
    positionMenuRuntime: true,
    dragRuntime: true,
    now: "2026-10-15T12:00:00+09:00"
  });
  runtime.state.publicRoster = {
    internalGameId: "canonical-game",
    gameDate: "2099-07-21",
    status: "fresh",
    rosterUse: "official_live",
    canUseForPrediction: true,
    players: [{ name: "マルティネス", playerId: "npb:00000001", position: "捕手" }]
  };
  runtime.state.predictionDeadline = {
    gameId: "canonical-game",
    game: runtime.state.predictionTargetGame,
    status: "open",
    message: "予想を受け付けています。",
    startAt: "2099-07-21T09:00:00.000Z",
    deadlineAt: "2099-07-21T08:00:00.000Z",
    isClosed: false,
    override: "auto"
  };
  runtime.operations.buildLineupPicker("prediction", "predictionLineup", "predictionPlayers");
  runtime.operations.bindEvents();
  return runtime;
}

function getSlots(runtime) {
  return runtime.elements.get("predictionLineup").querySelectorAll('.lineup-slot[data-picker="prediction"]');
}

function getPlayers(runtime) {
  return runtime.elements.get("predictionPlayers").querySelectorAll('.player-chip[data-picker="prediction"]');
}

function getPlayer(runtime, name) {
  const player = getPlayers(runtime).find((candidate) => candidate.dataset.player === name);
  assert.ok(player, `${name} should be rendered as a candidate`);
  return player;
}

function pointerEvent(type, target, values = {}) {
  return {
    type,
    target,
    pointerId: 7,
    pointerType: "pen",
    inputSource: "pointer",
    clientX: 0,
    clientY: 0,
    ...values
  };
}

function touch(identifier, clientX = 0, clientY = 0) {
  return { identifier, clientX, clientY };
}

async function selectPosition(runtime, slot, position) {
  await slot.querySelector(".position-button").dispatchEvent({ type: "click" });
  const menu = runtime.body.querySelectorAll(".position-menu")
    .find((candidate) => !candidate.classList.contains("hidden"));
  assert.ok(menu, "the clicked slot should own the visible position menu");
  const option = menu.querySelectorAll(".position-menu-option")
    .find((candidate) => candidate.dataset.position === position);
  assert.ok(option, `${position} option should be rendered`);
  await option.dispatchEvent({ type: "click" });
}

async function fillTwoSlots(runtime) {
  const players = getPlayers(runtime);
  await getPlayer(runtime, "レイエス").dispatchEvent({ type: "click" });
  await getPlayer(runtime, "清宮幸太郎").dispatchEvent({ type: "click" });
  return { slots: getSlots(runtime), players };
}

async function beginPointerDrag(runtime, source, pointerId = 7) {
  await source.dispatchEvent(pointerEvent("pointerdown", source, { pointerId }));
  assert.ok(runtime.state.pointerInteraction, "pointerdown should create drag state");
  await runtime.tickTimers();
  assert.equal(runtime.state.pointerInteraction.active, true, "long press should activate drag");
  assert.equal(source.hasPointerCapture(pointerId), true, "active pointer should be captured");
}

async function moveAndDropPointer(runtime, target, pointerId = 7) {
  runtime.setPointTarget(target);
  await runtime.emitDocument("pointermove", pointerEvent("pointermove", target, { pointerId, clientX: 120, clientY: 40 }));
  await runtime.emitDocument("pointerup", pointerEvent("pointerup", target, { pointerId, clientX: 120, clientY: 40 }));
}

test("pointer player drag commits to the hit slot and preserves drag autofill", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const source = getPlayer(runtime, "レイエス");
  const [target] = getSlots(runtime);

  await beginPointerDrag(runtime, source);
  assert.equal(target.dataset.player, "", "pointer move must not commit before drop");
  await moveAndDropPointer(runtime, target);

  assert.equal(target.dataset.player, "レイエス");
  assert.equal(target.dataset.position, "指", "drag path keeps the existing position autofill");
  assert.equal(runtime.state.pointerInteraction, null);
  assert.equal(source.hasPointerCapture(7), false);
  assert.equal(target.classList.contains("is-drop-target"), false);
});

test("pointer slot drag swaps players without duplication or loss", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const { slots } = await fillTwoSlots(runtime);

  await beginPointerDrag(runtime, slots[0]);
  await moveAndDropPointer(runtime, slots[1]);

  assert.deepEqual(slots.slice(0, 2).map((slot) => slot.dataset.player), ["清宮幸太郎", "レイエス"]);
  assert.equal(slots.filter((slot) => slot.dataset.player === "レイエス").length, 1);
  assert.equal(slots.filter((slot) => slot.dataset.player === "清宮幸太郎").length, 1);
});

test("pointer position drag swaps positions, closes the menu, and restores capture-owned state", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const { slots } = await fillTwoSlots(runtime);
  await selectPosition(runtime, slots[0], "一");
  await selectPosition(runtime, slots[1], "三");

  await slots[0].querySelector(".position-button").dispatchEvent(pointerEvent("pointerdown", slots[0].querySelector(".position-button"), {
    pointerType: "mouse",
    pointerId: 11
  }));
  assert.equal(runtime.body.querySelectorAll(".position-menu").every((menu) => menu.classList.contains("hidden")), true);
  runtime.setPointTarget(slots[1]);
  await runtime.emitDocument("pointermove", pointerEvent("pointermove", slots[1], { pointerType: "mouse", pointerId: 11, clientX: 120, clientY: 40 }));
  await runtime.emitDocument("pointerup", pointerEvent("pointerup", slots[1], { pointerType: "mouse", pointerId: 11, clientX: 120, clientY: 40 }));

  assert.deepEqual(slots.slice(0, 2).map((slot) => slot.dataset.position), ["三", "一"]);
  assert.equal(runtime.state.pointerInteraction, null);
  assert.equal(slots[0].draggable, true, "native drag state is restored after position pointer drag");
});

test("pointer cancel keeps lineup unchanged and releases temporary state", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const source = getPlayer(runtime, "レイエス");
  const [target] = getSlots(runtime);
  const before = target.dataset.player;

  await beginPointerDrag(runtime, source);
  runtime.setPointTarget(target);
  await runtime.emitDocument("pointermove", pointerEvent("pointermove", target));
  await runtime.emitDocument("pointercancel", pointerEvent("pointercancel", target));

  assert.equal(target.dataset.player, before);
  assert.equal(runtime.state.pointerInteraction, null);
  assert.equal(source.hasPointerCapture(7), false);
  assert.equal(target.classList.contains("is-drop-target"), false);
});

test("wrong pointer id cannot move or finish the active drag", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const source = getPlayer(runtime, "レイエス");
  const [target] = getSlots(runtime);

  await beginPointerDrag(runtime, source);
  runtime.setPointTarget(target);
  await runtime.emitDocument("pointermove", pointerEvent("pointermove", target, { pointerId: 99 }));
  await runtime.emitDocument("pointerup", pointerEvent("pointerup", target, { pointerId: 99 }));
  assert.equal(target.dataset.player, "");
  assert.ok(runtime.state.pointerInteraction, "wrong pointer must not clear active state");

  await moveAndDropPointer(runtime, target, 7);
  assert.equal(target.dataset.player, "レイエス");
});

test("touch drag uses the same target and commit semantics and cleans the mobile ghost", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const source = getPlayer(runtime, "レイエス");
  const [target] = getSlots(runtime);
  const startTouch = touch(41);

  await runtime.emitDocument("touchstart", { target: source, touches: [startTouch], changedTouches: [startTouch] });
  assert.ok(runtime.state.pointerInteraction);
  await runtime.tickTimers();
  assert.equal(runtime.state.pointerInteraction.active, true);
  assert.equal(runtime.body.querySelectorAll(".mobile-drag-ghost").length, 1);
  runtime.setPointTarget(target);
  const moveTouch = touch(41, 120, 40);
  await runtime.emitDocument("touchmove", { target: source, touches: [moveTouch], changedTouches: [moveTouch] });
  await runtime.emitDocument("touchend", { target: source, touches: [], changedTouches: [moveTouch] });

  assert.equal(target.dataset.player, "レイエス");
  assert.equal(target.dataset.position, "指");
  assert.equal(runtime.state.pointerInteraction, null);
  assert.equal(runtime.body.querySelectorAll(".mobile-drag-ghost").length, 0);
});

test("touch cancel and multitouch do not commit a lineup change", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const source = getPlayer(runtime, "レイエス");
  const [target] = getSlots(runtime);
  const firstTouch = touch(51);
  const secondTouch = touch(52);

  await runtime.emitDocument("touchstart", { target: source, touches: [firstTouch, secondTouch], changedTouches: [firstTouch, secondTouch] });
  assert.equal(runtime.state.pointerInteraction, null, "multitouch is ignored by the current guard");
  await runtime.emitDocument("touchstart", { target: source, touches: [firstTouch], changedTouches: [firstTouch] });
  await runtime.tickTimers();
  runtime.setPointTarget(target);
  const moveTouch = touch(51, 120, 40);
  await runtime.emitDocument("touchmove", { target: source, touches: [moveTouch], changedTouches: [moveTouch] });
  await runtime.emitDocument("touchcancel", { target: source, touches: [], changedTouches: [moveTouch] });

  assert.equal(target.dataset.player, "");
  assert.equal(runtime.state.pointerInteraction, null);
  assert.equal(runtime.body.querySelectorAll(".mobile-drag-ghost").length, 0);
});

test("wrong touch identifier is ignored until the active touch ends", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const source = getPlayer(runtime, "レイエス");
  const [target] = getSlots(runtime);
  const startTouch = touch(61);

  await runtime.emitDocument("touchstart", { target: source, touches: [startTouch], changedTouches: [startTouch] });
  await runtime.tickTimers();
  runtime.setPointTarget(target);
  const wrongTouch = touch(62, 120, 40);
  await runtime.emitDocument("touchmove", { target: source, touches: [wrongTouch], changedTouches: [wrongTouch] });
  await runtime.emitDocument("touchend", { target: source, touches: [], changedTouches: [wrongTouch] });
  assert.equal(target.dataset.player, "");
  assert.ok(runtime.state.pointerInteraction);

  const activeTouch = touch(61, 120, 40);
  await runtime.emitDocument("touchmove", { target: source, touches: [activeTouch], changedTouches: [activeTouch] });
  await runtime.emitDocument("touchend", { target: source, touches: [], changedTouches: [activeTouch] });
  assert.equal(target.dataset.player, "レイエス");
});

test("outside and same-slot drops leave the lineup unchanged, then a repeated drag works", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const source = getPlayer(runtime, "レイエス");
  const [firstSlot, secondSlot] = getSlots(runtime);

  await beginPointerDrag(runtime, source, 71);
  runtime.setPointTarget(null);
  await runtime.emitDocument("pointermove", pointerEvent("pointermove", null, { pointerId: 71 }));
  await runtime.emitDocument("pointerup", pointerEvent("pointerup", null, { pointerId: 71 }));
  assert.equal(firstSlot.dataset.player, "");
  assert.equal(runtime.state.pointerInteraction, null);

  await beginPointerDrag(runtime, source, 72);
  await moveAndDropPointer(runtime, firstSlot, 72);
  assert.equal(firstSlot.dataset.player, "レイエス");

  await beginPointerDrag(runtime, firstSlot, 73);
  await moveAndDropPointer(runtime, firstSlot, 73);
  assert.equal(firstSlot.dataset.player, "レイエス");
  assert.equal(secondSlot.dataset.player, "");

  await beginPointerDrag(runtime, firstSlot, 74);
  await moveAndDropPointer(runtime, secondSlot, 74);
  assert.equal(secondSlot.dataset.player, "レイエス");
  assert.equal(firstSlot.dataset.player, "");
});

test("click selection keeps the Phase 11 no-autofill contract while drag remains autofilled", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const player = getPlayer(runtime, "レイエス");
  const [slot] = getSlots(runtime);

  await player.dispatchEvent({ type: "click" });
  assert.equal(slot.dataset.player, "レイエス");
  assert.equal(slot.dataset.position, "");
});

test("player child target still starts the real player drag", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const source = getPlayer(runtime, "レイエス");
  const child = source.querySelector(".player-name");
  const [target] = getSlots(runtime);

  await source.dispatchEvent(pointerEvent("pointerdown", child, { pointerId: 81 }));
  await runtime.tickTimers();
  runtime.setPointTarget(target);
  await runtime.emitDocument("pointermove", pointerEvent("pointermove", child, { pointerId: 81, clientX: 120, clientY: 40 }));
  await runtime.emitDocument("pointerup", pointerEvent("pointerup", child, { pointerId: 81, clientX: 120, clientY: 40 }));

  assert.equal(target.dataset.player, "レイエス");
});

test("movement beyond the threshold before long press cancels as scroll", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const source = getPlayer(runtime, "レイエス");

  await source.dispatchEvent(pointerEvent("pointerdown", source, { pointerId: 82, clientX: 10, clientY: 10 }));
  await runtime.emitDocument("pointermove", pointerEvent("pointermove", source, { pointerId: 82, clientX: 10, clientY: 19 }));

  assert.equal(runtime.state.pointerInteraction, null);
  assert.equal(getSlots(runtime)[0].dataset.player, "");
});

test("active pointer can hand off to touch without losing the shared drag state", async (t) => {
  const runtime = createDragRuntime();
  t.after(() => runtime.dispose());
  const source = getPlayer(runtime, "レイエス");
  const [target] = getSlots(runtime);
  const touchStart = touch(91, 10, 10);

  await source.dispatchEvent(pointerEvent("pointerdown", source, { pointerId: 83, pointerType: "touch" }));
  await runtime.emitDocument("touchstart", { target: source, touches: [touchStart], changedTouches: [touchStart] });
  assert.equal(runtime.state.pointerInteraction.inputSource, "touch");
  assert.equal(runtime.state.pointerInteraction.activeTouchIdentifier, 91);

  await runtime.emitDocument("pointercancel", pointerEvent("pointercancel", source, { pointerId: 83 }));
  assert.ok(runtime.state.pointerInteraction, "the old pointer cancel must not clear the handoff");
  await runtime.tickTimers();
  runtime.setPointTarget(target);
  const activeTouch = touch(91, 120, 40);
  await runtime.emitDocument("touchmove", { target: source, touches: [activeTouch], changedTouches: [activeTouch] });
  await runtime.emitDocument("touchend", { target: source, touches: [], changedTouches: [activeTouch] });

  assert.equal(target.dataset.player, "レイエス");
  assert.equal(runtime.state.pointerInteraction, null);
});
