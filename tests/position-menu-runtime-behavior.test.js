const test = require("node:test");
const assert = require("node:assert/strict");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

const POSITION_VALUES = ["", "捕", "一", "二", "三", "遊", "左", "中", "右", "指"];

function createPositionRuntime() {
  const runtime = createPublicRuntime({
    ui: true,
    positionMenuRuntime: true,
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

function getLineup(runtime) {
  return runtime.elements.get("predictionLineup").querySelectorAll('.lineup-slot[data-picker="prediction"]');
}

function getPlayers(runtime) {
  return runtime.elements.get("predictionPlayers").querySelectorAll('.player-chip[data-picker="prediction"]');
}

function getPositionButton(slot) {
  return slot.querySelector(".position-button");
}

function getPositionMenu(slot) {
  return slot.querySelector(".position-menu");
}

async function choosePosition(slot, position) {
  const button = getPositionButton(slot);
  await button.emit("click");
  const menu = getPositionMenu(slot);
  const option = menu.querySelectorAll(".position-menu-option")
    .find((candidate) => candidate.dataset.position === position);
  assert.ok(option, `position option ${position || "empty"} should exist`);
  await option.emit("click");
}

test("position menu is opened by the real slot control and exposes all current positions", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const [slot] = getLineup(runtime);
  const button = getPositionButton(slot);

  assert.equal(button.textContent, "?");
  await button.emit("click");

  const menu = getPositionMenu(slot);
  assert.equal(menu.classList.contains("hidden"), false);
  assert.deepEqual(
    menu.querySelectorAll(".position-menu-option").map((option) => option.dataset.position),
    POSITION_VALUES
  );
  assert.equal(button.getAttribute("aria-expanded"), "true");
});

test("selecting a position updates only the active slot and closes the menu", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const slots = getLineup(runtime);

  await choosePosition(slots[0], "遊");

  assert.equal(slots[0].dataset.position, "遊");
  assert.equal(getPositionButton(slots[0]).textContent, "遊");
  assert.equal(getPositionMenu(slots[0]).classList.contains("hidden"), true);
  assert.equal(slots[1].dataset.position, "");
});

test("outside click and Escape close the open menu without changing the lineup", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const [slot] = getLineup(runtime);
  await getPositionButton(slot).emit("click");

  await runtime.emitDocument("click");
  assert.equal(getPositionMenu(slot).classList.contains("hidden"), true);
  assert.equal(slot.dataset.position, "");

  await getPositionButton(slot).emit("click");
  await runtime.emitDocument("keydown", { key: "Escape" });
  assert.equal(getPositionMenu(slot).classList.contains("hidden"), true);
  assert.equal(slot.dataset.position, "");
});

test("changing a position keeps the player in the same slot", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const [slot] = getLineup(runtime);
  const [player] = getPlayers(runtime);

  await player.emit("click");
  await choosePosition(slot, "遊");
  await choosePosition(slot, "二");

  assert.equal(slot.dataset.player, player.dataset.player);
  assert.equal(slot.dataset.position, "二");
});

test("normal player selection does not autofill a position", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const [slot] = getLineup(runtime);
  const [player] = getPlayers(runtime);

  await player.emit("click");

  assert.equal(slot.dataset.player, player.dataset.player);
  assert.equal(slot.dataset.position, "");
  assert.equal(getPositionButton(slot).textContent, "?");
});

test("clear control removes both the selected player and position", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const [slot] = getLineup(runtime);
  const [player] = getPlayers(runtime);

  await player.emit("click");
  await choosePosition(slot, "捕");
  await slot.querySelector(".slot-clear").emit("click");

  assert.equal(slot.dataset.player, "");
  assert.equal(slot.dataset.position, "");
});

test("changing a player keeps the explicitly selected position", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const slots = getLineup(runtime);
  const players = getPlayers(runtime);

  await players[0].emit("click");
  await choosePosition(slots[0], "遊");
  await slots[0].emit("click");
  await players[1].emit("click");

  assert.equal(slots[0].dataset.player, players[1].dataset.player);
  assert.equal(slots[0].dataset.position, "遊");
  assert.equal(slots[1].dataset.player, "");
});

test("registered position does not restrict the explicit menu choice", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const [slot] = getLineup(runtime);
  const [player] = getPlayers(runtime);

  await player.emit("click");
  await choosePosition(slot, "遊");

  assert.equal(slot.dataset.position, "遊");
});

test("selecting the same player again moves the player without creating a duplicate", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const slots = getLineup(runtime);
  const [player] = getPlayers(runtime);

  await player.emit("click");
  await slots[1].emit("click");
  await player.emit("click");

  assert.equal(slots.filter((slot) => slot.dataset.player === player.dataset.player).length, 1);
  assert.equal(slots[1].dataset.player, player.dataset.player);
  assert.equal(slots[0].dataset.player, "");
});

test("a position choice in one slot does not leak into another slot", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const slots = getLineup(runtime);

  await choosePosition(slots[0], "捕");
  await choosePosition(slots[1], "遊");

  assert.equal(slots[0].dataset.position, "捕");
  assert.equal(slots[1].dataset.position, "遊");
});

test("selecting an occupied position follows the current swap behavior without changing players", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const slots = getLineup(runtime);
  const players = getPlayers(runtime);

  await players[0].emit("click");
  await choosePosition(slots[0], "捕");
  await slots[1].emit("click");
  await players[1].emit("click");
  await choosePosition(slots[1], "捕");

  assert.equal(slots[0].dataset.player, players[0].dataset.player);
  assert.equal(slots[0].dataset.position, "");
  assert.equal(slots[1].dataset.player, players[1].dataset.player);
  assert.equal(slots[1].dataset.position, "捕");
});

test("opening another slot closes the previous menu and targets the new slot", async (t) => {
  const runtime = createPositionRuntime();
  t.after(() => runtime.dispose());
  const slots = getLineup(runtime);

  await getPositionButton(slots[0]).emit("click");
  await getPositionButton(slots[1]).emit("click");

  assert.equal(getPositionMenu(slots[0]).classList.contains("hidden"), true);
  assert.equal(getPositionMenu(slots[1]).classList.contains("hidden"), false);
  assert.equal(getPositionButton(slots[0]).getAttribute("aria-expanded"), "false");
  assert.equal(getPositionButton(slots[1]).getAttribute("aria-expanded"), "true");
});
