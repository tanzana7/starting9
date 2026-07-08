const STORAGE_KEYS = {
  prediction: "hamStarting9Prediction",
  actual: "hamStarting9Actual",
  result: "hamStarting9Result"
};

const LINEUP_SIZE = 9;
const SCORE_MAX = 100;
const SCORE_RULES = {
  player: {
    perHit: 5,
    bonus: 5,
    max: 50
  },
  order: {
    perHit: 3,
    bonus: 3,
    max: 30
  },
  position: {
    perHit: 2,
    bonus: 2,
    max: 20
  }
};
const FLICK_DISTANCE = 42;
const DRAG_DATA_TYPE = "application/x-ham-starting9-player";
const positions = [
  "捕",
  "一",
  "二",
  "三",
  "遊",
  "左",
  "中",
  "右",
  "指"
];

const positionAliases = {
  "捕": "捕",
  "C": "捕",
  "キャッチャー": "捕",
  "2": "捕",
  "一": "一",
  "1B": "一",
  "ファースト": "一",
  "3": "一",
  "二": "二",
  "2B": "二",
  "セカンド": "二",
  "4": "二",
  "三": "三",
  "3B": "三",
  "サード": "三",
  "5": "三",
  "遊": "遊",
  "SS": "遊",
  "ショート": "遊",
  "6": "遊",
  "左": "左",
  "LF": "左",
  "レフト": "左",
  "7": "左",
  "中": "中",
  "CF": "中",
  "センター": "中",
  "8": "中",
  "右": "右",
  "RF": "右",
  "ライト": "右",
  "9": "右",
  "指": "指",
  "DH": "指",
  "D": "指",
  "指名打者": "指",
  "0": "指"
};

const state = {
  prediction: null,
  actual: null,
  result: null,
  actualPreview: null,
  adminStatus: "idle",
  adminError: "",
  activeOrder: {
    prediction: 0,
    actual: 0
  },
  flickStart: new Map()
};

document.addEventListener("DOMContentLoaded", () => {
  buildLineupPicker("prediction", "predictionLineup", "predictionPlayers");
  buildLineupPicker("actual", "actualLineup", "actualPlayers");
  loadState();
  bindEvents();
  renderAll();
});

function bindEvents() {
  document.getElementById("predictionForm").addEventListener("submit", handlePredictionSubmit);
  document.getElementById("actualForm").addEventListener("submit", handleActualSubmit);
  document.getElementById("parseActualButton").addEventListener("click", handleActualParsePreview);
  document.getElementById("applyParsedActualButton").addEventListener("click", applyParsedActualPreview);
  document.getElementById("clearActualCandidateButton").addEventListener("click", clearActualCandidate);
  document.getElementById("resetButton").addEventListener("click", resetAllData);
  document.getElementById("sharePredictionButton").addEventListener("click", sharePrediction);
  document.getElementById("shareResultButton").addEventListener("click", shareResult);
}

function buildLineupPicker(pickerName, lineupId, playersId) {
  const lineupContainer = document.getElementById(lineupId);
  const playersContainer = document.getElementById(playersId);
  const lineupFragment = document.createDocumentFragment();
  const playersFragment = document.createDocumentFragment();

  for (let index = 0; index < LINEUP_SIZE; index += 1) {
    lineupFragment.appendChild(createLineupSlot(pickerName, index));
  }

  players.forEach((player) => {
    playersFragment.appendChild(createPlayerChip(pickerName, player));
  });

  lineupContainer.appendChild(lineupFragment);
  playersContainer.appendChild(playersFragment);
}

function createLineupSlot(pickerName, index) {
  const slot = document.createElement("div");
  slot.className = "lineup-slot";
  slot.dataset.picker = pickerName;
  slot.dataset.order = String(index);
  slot.dataset.player = "";
  slot.dataset.position = "";
  slot.setAttribute("role", "button");
  slot.tabIndex = 0;
  slot.draggable = false;
  slot.addEventListener("click", () => setActiveOrder(pickerName, index));
  slot.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActiveOrder(pickerName, index);
    }
  });
  slot.addEventListener("dragstart", (event) => handleSlotDragStart(event, slot));
  slot.addEventListener("dragend", (event) => handleDragEnd(event, slot));
  slot.addEventListener("dragover", handleSlotDragOver);
  slot.addEventListener("dragenter", () => slot.classList.add("is-drop-target"));
  slot.addEventListener("dragleave", () => slot.classList.remove("is-drop-target"));
  slot.addEventListener("drop", (event) => handleSlotDrop(event, slot));

  const order = document.createElement("span");
  order.className = "slot-order";
  order.textContent = `${index + 1}番`;

  const player = document.createElement("span");
  player.className = "slot-player slot-empty";
  player.textContent = "未選択";

  const positionSelect = document.createElement("select");
  positionSelect.className = "position-select";
  positionSelect.setAttribute("aria-label", `${index + 1}番の守備位置`);
  positionSelect.appendChild(createOption("", "守備"));
  positions.forEach((position) => {
    positionSelect.appendChild(createOption(position, position));
  });
  positionSelect.addEventListener("click", (event) => event.stopPropagation());
  positionSelect.addEventListener("change", () => {
    slot.dataset.position = positionSelect.value;
    clearMessage(pickerName === "prediction" ? "predictionError" : "actualError");
    renderPicker(pickerName);
  });

  const clearButton = document.createElement("button");
  clearButton.className = "slot-clear";
  clearButton.type = "button";
  clearButton.setAttribute("aria-label", `${index + 1}番を空にする`);
  clearButton.textContent = "×";
  clearButton.addEventListener("click", (event) => {
    event.stopPropagation();
    clearSlot(pickerName, index);
  });

  slot.append(order, player, positionSelect, clearButton);
  return slot;
}

function createOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

function createPlayerChip(pickerName, player) {
  const button = document.createElement("button");
  button.className = "player-chip";
  button.type = "button";
  button.dataset.picker = pickerName;
  button.dataset.player = player;
  button.draggable = true;
  button.textContent = player;

  button.addEventListener("click", () => {
    if (button.dataset.skipClick === "true") {
      button.dataset.skipClick = "false";
      return;
    }

    assignPlayerToActiveSlot(pickerName, player);
  });
  button.addEventListener("pointerdown", (event) => handlePlayerPointerDown(event, button));
  button.addEventListener("pointerup", (event) => handlePlayerPointerUp(event, button));
  button.addEventListener("pointercancel", () => clearFlickState(button));
  button.addEventListener("lostpointercapture", () => clearFlickState(button));
  button.addEventListener("dragstart", (event) => handlePlayerDragStart(event, button));
  button.addEventListener("dragend", (event) => handleDragEnd(event, button));

  return button;
}

function handlePlayerDragStart(event, button) {
  const dragData = {
    pickerName: button.dataset.picker,
    player: button.dataset.player,
    sourceOrder: null
  };

  setDragData(event, dragData);
  button.classList.add("is-dragging");
}

function handleSlotDragStart(event, slot) {
  const player = slot.dataset.player;

  if (!player) {
    event.preventDefault();
    return;
  }

  const dragData = {
    pickerName: slot.dataset.picker,
    player,
    sourceOrder: Number(slot.dataset.order)
  };

  setDragData(event, dragData);
  slot.classList.add("is-dragging");
}

function setDragData(event, dragData) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(DRAG_DATA_TYPE, JSON.stringify(dragData));
  event.dataTransfer.setData("text/plain", dragData.player);
}

function handleSlotDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

function handleSlotDrop(event, slot) {
  event.preventDefault();
  slot.classList.remove("is-drop-target");

  const dragData = getDragData(event);
  if (!dragData || dragData.pickerName !== slot.dataset.picker) {
    return;
  }

  assignPlayerToSlot(slot.dataset.picker, dragData.player, Number(slot.dataset.order), dragData.sourceOrder);
}

function getDragData(event) {
  const rawData = event.dataTransfer.getData(DRAG_DATA_TYPE);

  if (!rawData) {
    return null;
  }

  try {
    return JSON.parse(rawData);
  } catch (error) {
    console.error("ドラッグデータの読み込みに失敗しました。", error);
    return null;
  }
}

function handleDragEnd(event, element) {
  event.preventDefault();
  element.classList.remove("is-dragging");
  document.querySelectorAll(".lineup-slot.is-drop-target").forEach((slot) => {
    slot.classList.remove("is-drop-target");
  });
}

function handlePlayerPointerDown(event, button) {
  if (event.pointerType === "mouse") {
    return;
  }

  state.flickStart.set(button, {
    x: event.clientX,
    y: event.clientY
  });
  button.classList.add("is-flicking");
}

function handlePlayerPointerUp(event, button) {
  if (event.pointerType === "mouse") {
    return;
  }

  const start = state.flickStart.get(button);
  clearFlickState(button);

  if (!start) {
    return;
  }

  const diffX = event.clientX - start.x;
  const diffY = event.clientY - start.y;
  const isLeftFlick = diffX <= -FLICK_DISTANCE && Math.abs(diffX) > Math.abs(diffY);

  if (isLeftFlick) {
    button.dataset.skipClick = "true";
    assignPlayerToActiveSlot(button.dataset.picker, button.dataset.player);
  }
}

function clearFlickState(button) {
  state.flickStart.delete(button);
  button.classList.remove("is-flicking");
}

function setActiveOrder(pickerName, index) {
  state.activeOrder[pickerName] = index;
  clearMessage(pickerName === "prediction" ? "predictionError" : "actualError");
  renderPicker(pickerName);
}

function assignPlayerToActiveSlot(pickerName, player) {
  const lineup = getLineupValues(pickerName);
  const currentIndex = lineup.findIndex((item) => item.player === player);
  const targetIndex = getTargetOrder(pickerName, lineup);
  const targetPosition = lineup[targetIndex]?.position || "";

  if (currentIndex !== -1 && currentIndex !== targetIndex) {
    lineup[currentIndex] = createLineupItem(currentIndex, "", lineup[currentIndex]?.position || "");
  }

  lineup[targetIndex] = createLineupItem(targetIndex, player, targetPosition);
  setLineupValues(pickerName, lineup);
  state.activeOrder[pickerName] = findNextEmptyIndex(lineup, targetIndex);
  renderPicker(pickerName);
}

function assignPlayerToSlot(pickerName, player, targetIndex, sourceIndex) {
  const lineup = getLineupValues(pickerName);
  const currentIndex = lineup.findIndex((item) => item.player === player);
  const replacedItem = lineup[targetIndex];
  const movingItem = createLineupItem(targetIndex, player, sourceIndex !== null && sourceIndex !== undefined ? lineup[sourceIndex]?.position || "" : replacedItem?.position || "");

  if (sourceIndex !== null && sourceIndex !== undefined && sourceIndex !== targetIndex) {
    lineup[sourceIndex] = createLineupItem(sourceIndex, replacedItem?.player || "", replacedItem?.position || "");
  } else if (currentIndex !== -1 && currentIndex !== targetIndex) {
    lineup[currentIndex] = createLineupItem(currentIndex, "", lineup[currentIndex]?.position || "");
  }

  lineup[targetIndex] = movingItem;
  setLineupValues(pickerName, lineup);
  state.activeOrder[pickerName] = targetIndex;
  clearMessage(pickerName === "prediction" ? "predictionError" : "actualError");
  renderPicker(pickerName);
}

function getTargetOrder(pickerName, lineup) {
  const activeIndex = state.activeOrder[pickerName] ?? 0;

  if (!lineup[activeIndex]?.player) {
    return activeIndex;
  }

  return activeIndex;
}

function findNextEmptyIndex(lineup, startIndex) {
  for (let offset = 1; offset <= LINEUP_SIZE; offset += 1) {
    const index = (startIndex + offset) % LINEUP_SIZE;
    if (!lineup[index]?.player) {
      return index;
    }
  }

  return startIndex;
}

function clearSlot(pickerName, index) {
  const lineup = getLineupValues(pickerName);
  lineup[index] = createLineupItem(index, "", lineup[index]?.position || "");
  setLineupValues(pickerName, lineup);
  state.activeOrder[pickerName] = index;
  renderPicker(pickerName);
}

function handleActualParsePreview() {
  clearMessage("parserError");
  clearMessage("actualError");
  clearMessage("resetMessage");

  const rawText = document.getElementById("actualPasteInput").value;
  const parseResult = parseActualLineupText(rawText);

  if (!parseResult.ok) {
    state.actualPreview = null;
    state.adminStatus = "error";
    state.adminError = parseResult.message;
    renderAdminFlow();
    showMessage("parserError", parseResult.message);
    return;
  }

  state.actualPreview = parseResult.lineup;
  state.adminStatus = "preview";
  state.adminError = "";
  renderAdminFlow();
}

function applyParsedActualPreview() {
  clearMessage("parserError");
  clearMessage("actualError");

  if (!state.actualPreview) {
    showMessage("parserError", "先に貼り付け内容をプレビューしてください。");
    return;
  }

  setLineupValues("actual", state.actualPreview);
  state.actual = {
    lineup: normalizeLineup(state.actualPreview),
    savedAt: new Date().toISOString()
  };
  state.actualPreview = null;
  state.adminStatus = "approved";
  state.adminError = "";
  state.result = null;
  saveToStorage(STORAGE_KEYS.actual, state.actual);
  removeFromStorage(STORAGE_KEYS.result);
  renderActualLineup();
  renderAdminFlow();
  renderScoreResult();
  showMessage("parserError", "");
}

function clearActualCandidate() {
  state.actualPreview = null;
  state.adminError = "";
  state.adminStatus = state.actual ? "approved" : "idle";
  clearMessage("parserError");
  clearMessage("actualError");
  renderAdminFlow();
}

function parseActualLineupText(rawText) {
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  if (lines.length < LINEUP_SIZE) {
    return { ok: false, message: "実スタメンは9人分入力してください。" };
  }

  const lineup = [];
  const seenOrders = new Set();
  const seenPlayers = new Set();

  for (const line of lines) {
    const parsedLine = parseActualLine(line);

    if (!parsedLine.ok) {
      return parsedLine;
    }

    const { order, position, player } = parsedLine.item;
    const playerKey = normalizePlayerKey(player);

    if (seenOrders.has(order)) {
      return { ok: false, message: `打順が重複しています：${order}番` };
    }

    if (seenPlayers.has(playerKey)) {
      return { ok: false, message: `選手が重複しています：${player}` };
    }

    seenOrders.add(order);
    seenPlayers.add(playerKey);
    lineup[order - 1] = createLineupItem(order - 1, player, position);
  }

  if (seenOrders.size !== LINEUP_SIZE || lineup.some((item) => !item)) {
    return { ok: false, message: "1〜9番まですべての打順を入力してください。" };
  }

  const validationError = validateLineup(lineup, "実スタメン");
  if (validationError) {
    return { ok: false, message: validationError };
  }

  return { ok: true, lineup };
}

function parseActualLine(line) {
  const normalizedLine = line.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
  const parts = normalizedLine.split(" ");

  if (parts.length < 3) {
    return { ok: false, message: `行の形式が不正です：${line}` };
  }

  const order = Number(parts[0]);
  const rawPosition = parts[1];
  const rawPlayer = parts.slice(2).join(" ");
  const position = normalizePosition(rawPosition);
  const player = normalizePlayerName(rawPlayer);

  if (!Number.isInteger(order) || order < 1 || order > LINEUP_SIZE) {
    return { ok: false, message: `打順が不正です：${parts[0]}` };
  }

  if (!position) {
    return { ok: false, message: `守備位置が不正です：${rawPosition}` };
  }

  if (!player) {
    return { ok: false, message: `選手名が不正です：${line}` };
  }

  return {
    ok: true,
    item: createLineupItem(order - 1, player, position)
  };
}

function normalizePosition(value) {
  const key = normalizePositionKey(value);
  return positionAliases[key] || "";
}

function normalizePositionKey(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").toUpperCase();
}

function normalizePlayerName(value) {
  const trimmedName = String(value || "").replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
  const playerKey = normalizePlayerKey(trimmedName);
  const rosterPlayer = players.find((player) => normalizePlayerKey(player) === playerKey);
  return rosterPlayer || trimmedName;
}

function normalizePlayerKey(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "");
}

function handlePredictionSubmit(event) {
  event.preventDefault();
  clearMessage("predictionError");
  clearMessage("resetMessage");

  const nickname = document.getElementById("nickname").value.trim();
  const lineup = getLineupValues("prediction");
  const validationError = validateLineup(lineup, "予想");

  if (!nickname) {
    showMessage("predictionError", "ニックネームを入力してください。");
    return;
  }

  if (validationError) {
    showMessage("predictionError", validationError);
    markDuplicateSlots("prediction", lineup);
    return;
  }

  state.prediction = {
    nickname,
    lineup,
    savedAt: new Date().toISOString()
  };

  saveToStorage(STORAGE_KEYS.prediction, state.prediction);
  state.result = null;
  removeFromStorage(STORAGE_KEYS.result);
  renderAll();
}

function handleActualSubmit(event) {
  event.preventDefault();
  clearMessage("actualError");
  clearMessage("parserError");
  clearMessage("resetMessage");

  if (!state.prediction) {
    showMessage("actualError", "先にスタメン予想を保存してください。");
    return;
  }

  if (!state.actual) {
    showMessage("actualError", "承認済みの実スタメンがありません。候補を読み取り、承認してから採点してください。");
    return;
  }

  const lineup = normalizeLineup(state.actual.lineup);
  const validationError = validateLineup(lineup, "承認済み実スタメン");

  if (validationError) {
    showMessage("actualError", validationError);
    markDuplicateSlots("actual", lineup);
    return;
  }

  state.result = scoreLineup(state.prediction.lineup, state.actual.lineup);

  saveToStorage(STORAGE_KEYS.result, state.result);
  renderAll();
}

function getLineupValues(pickerName) {
  const normalizedName = normalizePickerName(pickerName);
  return Array.from(document.querySelectorAll(`.lineup-slot[data-picker="${normalizedName}"]`)).map((slot, index) => {
    return createLineupItem(index, slot.dataset.player || "", slot.dataset.position || "");
  });
}

function setLineupValues(pickerName, lineup) {
  const normalizedName = normalizePickerName(pickerName);
  const slots = document.querySelectorAll(`.lineup-slot[data-picker="${normalizedName}"]`);
  const normalizedLineup = normalizeLineup(lineup);

  slots.forEach((slot, index) => {
    slot.dataset.player = normalizedLineup[index]?.player || "";
    slot.dataset.position = normalizedLineup[index]?.position || "";
  });

  renderPicker(normalizedName);
}

function createLineupItem(index, player, position) {
  const normalizedPosition = position ? normalizePosition(position) : "";

  return {
    order: index + 1,
    player: player || "",
    position: normalizedPosition
  };
}

function normalizeLineup(lineup) {
  const source = Array.isArray(lineup) ? lineup : [];

  return Array.from({ length: LINEUP_SIZE }, (_, index) => {
    const item = source[index];

    if (typeof item === "string") {
      return createLineupItem(index, item, "");
    }

    return createLineupItem(index, item?.player || "", item?.position || "");
  });
}

function normalizePickerName(pickerName) {
  if (pickerName === "prediction-player") {
    return "prediction";
  }

  if (pickerName === "actual-player") {
    return "actual";
  }

  return pickerName;
}

function validateLineup(lineup, label) {
  if (lineup.some((item) => !item.player)) {
    return `${label}は1番から9番まで全て選択してください。`;
  }

  if (lineup.some((item) => !item.position)) {
    return `${label}は1番から9番まで守備位置を全て選択してください。`;
  }

  if (hasDuplicatePlayers(lineup)) {
    return `${label}に同じ選手が複数回選ばれています。別の選手を選んでください。`;
  }

  if (hasDuplicatePositions(lineup)) {
    return `${label}に同じ守備位置が複数回選ばれています。別の守備位置を選んでください。`;
  }

  return "";
}

function hasDuplicatePlayers(lineup) {
  const playerNames = lineup.map((item) => item.player).filter(Boolean);
  return new Set(playerNames).size !== playerNames.length;
}

function hasDuplicatePositions(lineup) {
  const positionNames = lineup.map((item) => item.position).filter((position) => position && position !== "指");
  return new Set(positionNames).size !== positionNames.length;
}

function hasCompletePositions(lineup) {
  return normalizeLineup(lineup).every((item) => item.position);
}

function scoreLineup(predictionLineup, actualLineup) {
  const normalizedPrediction = normalizeLineup(predictionLineup);
  const normalizedActual = normalizeLineup(actualLineup);
  const actualByPlayer = new Map(normalizedActual.map((item) => [item.player, item]));
  const details = normalizedPrediction.map((predictionItem, index) => {
    const actualItem = actualByPlayer.get(predictionItem.player);
    const actualOrderItem = normalizedActual[index] || createLineupItem(index, "", "");
    const isInStartingLineup = Boolean(actualItem);
    const isExactOrder = normalizedActual[index]?.player === predictionItem.player;
    const isExactPosition = isInStartingLineup && actualItem.position === predictionItem.position;
    const point = (isInStartingLineup ? SCORE_RULES.player.perHit : 0) +
      (isExactOrder ? SCORE_RULES.order.perHit : 0) +
      (isExactPosition ? SCORE_RULES.position.perHit : 0);
    const isPerfect = isInStartingLineup && isExactOrder && isExactPosition;

    return {
      order: index + 1,
      player: predictionItem.player,
      position: predictionItem.position,
      actualPlayer: actualOrderItem.player,
      actualPosition: actualOrderItem.position,
      isPlayerHit: isInStartingLineup,
      isOrderHit: isExactOrder,
      isPositionHit: isExactPosition,
      point,
      mark: isPerfect ? "◎" : isInStartingLineup ? "◯" : "×",
      label: isPerfect ? "完全一致" : isInStartingLineup ? "スタメン入り" : "外れ"
    };
  });
  const counts = getHitCounts(details);
  const breakdown = createScoreBreakdown(counts);

  return {
    total: Math.min(SCORE_MAX, breakdown.player.total + breakdown.order.total + breakdown.position.total),
    max: SCORE_MAX,
    counts,
    breakdown,
    details,
    scoredAt: new Date().toISOString()
  };
}

function getHitCounts(details) {
  return {
    player: details.filter((detail) => detail.isPlayerHit).length,
    order: details.filter((detail) => detail.isOrderHit).length,
    position: details.filter((detail) => detail.isPositionHit).length
  };
}

function createScoreBreakdown(counts) {
  const playerBase = counts.player * SCORE_RULES.player.perHit;
  const orderBase = counts.order * SCORE_RULES.order.perHit;
  const positionBase = counts.position * SCORE_RULES.position.perHit;

  return {
    player: {
      base: playerBase,
      bonus: counts.player === LINEUP_SIZE ? SCORE_RULES.player.bonus : 0,
      total: playerBase + (counts.player === LINEUP_SIZE ? SCORE_RULES.player.bonus : 0),
      max: SCORE_RULES.player.max
    },
    order: {
      base: orderBase,
      bonus: counts.order === LINEUP_SIZE ? SCORE_RULES.order.bonus : 0,
      total: orderBase + (counts.order === LINEUP_SIZE ? SCORE_RULES.order.bonus : 0),
      max: SCORE_RULES.order.max
    },
    position: {
      base: positionBase,
      bonus: counts.position === LINEUP_SIZE ? SCORE_RULES.position.bonus : 0,
      total: positionBase + (counts.position === LINEUP_SIZE ? SCORE_RULES.position.bonus : 0),
      max: SCORE_RULES.position.max
    }
  };
}

function loadState() {
  state.prediction = loadFromStorage(STORAGE_KEYS.prediction);
  state.actual = loadFromStorage(STORAGE_KEYS.actual);
  state.result = loadFromStorage(STORAGE_KEYS.result);

  if (state.prediction?.lineup) {
    state.prediction.lineup = normalizeLineup(state.prediction.lineup);
  }

  if (state.actual?.lineup) {
    state.actual.lineup = normalizeLineup(state.actual.lineup);
    state.adminStatus = "approved";
  }

  if (state.prediction?.lineup && state.actual?.lineup && hasCompletePositions(state.prediction.lineup) && hasCompletePositions(state.actual.lineup)) {
    state.result = scoreLineup(state.prediction.lineup, state.actual.lineup);
    saveToStorage(STORAGE_KEYS.result, state.result);
  } else if (state.result?.max !== SCORE_MAX) {
    state.result = null;
    removeFromStorage(STORAGE_KEYS.result);
  }
}

function saveToStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function loadFromStorage(key) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch (error) {
    console.error(`localStorageの読み込みに失敗しました: ${key}`, error);
    return null;
  }
}

function removeFromStorage(key) {
  localStorage.removeItem(key);
}

function renderAll() {
  renderSavedPrediction();
  renderActualLineup();
  renderScoreResult();
  renderAdminFlow();
  renderPicker("prediction");
  renderPicker("actual");
}

function renderAdminFlow() {
  if (!state.adminStatus || state.adminStatus === "idle") {
    state.adminStatus = state.actual ? "approved" : "idle";
  }

  renderAdminStatus();
  renderActualPreview(state.actualPreview);
  updateAdminButtons();
}

function renderAdminStatus() {
  const statusContainer = document.getElementById("adminFlowStatus");

  if (!statusContainer) {
    return;
  }

  const statusMap = {
    idle: {
      className: "is-idle",
      title: "未読み取り",
      body: "実スタメンを貼り付けて、候補を読み取ってください。"
    },
    preview: {
      className: "is-preview",
      title: "候補プレビュー中",
      body: "この候補はまだ正式な実スタメンではありません。内容を確認してから承認してください。"
    },
    approved: {
      className: "is-approved",
      title: "実スタメンを承認済みです",
      body: state.actual?.savedAt ? `承認済み：${formatDateTime(state.actual.savedAt)}` : "承認済みです。"
    },
    error: {
      className: "is-error",
      title: "エラーあり",
      body: state.adminError || "入力内容を修正して、もう一度候補を読み取ってください。"
    }
  };
  const current = statusMap[state.adminStatus] || statusMap.idle;
  const approvedList = state.adminStatus === "approved" && state.actual ? createLineupPreviewHtml(state.actual.lineup) : "";

  statusContainer.className = `admin-flow-status ${current.className}`;
  statusContainer.innerHTML = `
    <strong>${current.title}</strong>
    <span>${escapeHtml(current.body)}</span>
    ${approvedList}
  `;
}

function updateAdminButtons() {
  const applyButton = document.getElementById("applyParsedActualButton");
  const clearButton = document.getElementById("clearActualCandidateButton");

  if (!applyButton || !clearButton) {
    return;
  }

  const hasPreview = state.adminStatus === "preview" && Boolean(state.actualPreview);
  const hasCandidateState = Boolean(state.actualPreview) || state.adminStatus === "error";
  applyButton.classList.toggle("hidden", !hasPreview);
  applyButton.disabled = !hasPreview;
  clearButton.classList.toggle("hidden", !hasCandidateState);
}

function renderActualPreview(lineup) {
  const previewContainer = document.getElementById("actualPreview");

  if (!previewContainer) {
    return;
  }

  if (!lineup) {
    previewContainer.classList.add("hidden");
    previewContainer.innerHTML = "";
    return;
  }

  const normalizedLineup = normalizeLineup(lineup);
  previewContainer.classList.remove("hidden");
  previewContainer.innerHTML = "";

  const title = document.createElement("p");
  title.className = "preview-title";
  title.textContent = "候補スタメンプレビュー";
  previewContainer.append(title);
  previewContainer.insertAdjacentHTML("beforeend", createLineupPreviewHtml(normalizedLineup));
}

function createLineupPreviewHtml(lineup) {
  const items = normalizeLineup(lineup).map((item) => {
    return `
      <li>
        <strong>${item.order}番</strong>
        <span>${escapeHtml(item.position)}</span>
        <span>${escapeHtml(item.player)}</span>
      </li>
    `;
  }).join("");

  return `<ul class="preview-list">${items}</ul>`;
}

function renderPicker(pickerName) {
  const lineup = getLineupValues(pickerName);
  const usedPlayers = new Set(lineup.map((item) => item.player).filter(Boolean));
  const duplicatedPlayers = getDuplicatedPlayers(lineup);
  const duplicatedPositions = getDuplicatedPositions(lineup);

  document.querySelectorAll(`.lineup-slot[data-picker="${pickerName}"]`).forEach((slot, index) => {
    const player = slot.dataset.player || "";
    const position = slot.dataset.position || "";
    const playerElement = slot.querySelector(".slot-player");
    const positionSelect = slot.querySelector(".position-select");
    const clearButton = slot.querySelector(".slot-clear");

    slot.classList.toggle("is-active", state.activeOrder[pickerName] === index);
    slot.classList.toggle("has-player", Boolean(player));
    slot.classList.toggle("is-duplicate", duplicatedPlayers.has(player) || duplicatedPositions.has(position));
    slot.draggable = Boolean(player);
    slot.setAttribute("aria-label", `${index + 1}番 ${position || "守備未選択"} ${player || "未選択"}`);
    playerElement.textContent = player || "未選択";
    playerElement.classList.toggle("slot-empty", !player);
    positionSelect.value = position;
    clearButton.classList.toggle("hidden", !player);
  });

  document.querySelectorAll(`.player-chip[data-picker="${pickerName}"]`).forEach((chip) => {
    const isUsed = usedPlayers.has(chip.dataset.player);
    chip.classList.toggle("is-used", isUsed);
  });
}

function markDuplicateSlots(pickerName, lineup) {
  const duplicatedPlayers = getDuplicatedPlayers(lineup);
  const duplicatedPositions = getDuplicatedPositions(lineup);
  document.querySelectorAll(`.lineup-slot[data-picker="${pickerName}"]`).forEach((slot) => {
    slot.classList.toggle("is-duplicate", duplicatedPlayers.has(slot.dataset.player) || duplicatedPositions.has(slot.dataset.position));
  });
}

function getDuplicatedPlayers(lineup) {
  const counts = new Map();
  lineup.map((item) => item.player).filter(Boolean).forEach((player) => {
    counts.set(player, (counts.get(player) || 0) + 1);
  });

  return new Set(Array.from(counts.entries()).filter((entry) => entry[1] > 1).map((entry) => entry[0]));
}

function getDuplicatedPositions(lineup) {
  const counts = new Map();
  lineup.map((item) => item.position).filter((position) => position && position !== "指").forEach((position) => {
    counts.set(position, (counts.get(position) || 0) + 1);
  });

  return new Set(Array.from(counts.entries()).filter((entry) => entry[1] > 1).map((entry) => entry[0]));
}

function renderSavedPrediction() {
  const container = document.getElementById("savedPrediction");
  const shareButton = document.getElementById("sharePredictionButton");

  if (!state.prediction) {
    container.className = "empty-state";
    container.textContent = "まだ予想が保存されていません。";
    shareButton.classList.add("hidden");
    return;
  }

  document.getElementById("nickname").value = state.prediction.nickname;
  setLineupValues("prediction", state.prediction.lineup);
  container.className = "summary-box";
  container.innerHTML = "";
  container.appendChild(createPredictionSummary(state.prediction));
  shareButton.classList.remove("hidden");
}

function renderActualLineup() {
  if (state.actual) {
    setLineupValues("actual", state.actual.lineup);
  }
}

function renderScoreResult() {
  const container = document.getElementById("scoreResult");
  const shareButton = document.getElementById("shareResultButton");

  if (!state.result) {
    container.className = "empty-state";
    container.textContent = "採点すると結果が表示されます。";
    shareButton.classList.add("hidden");
    return;
  }

  container.className = "summary-box";
  container.innerHTML = "";
  container.appendChild(createResultView(createResultViewModel(state.result)));
  shareButton.classList.remove("hidden");
}

function createResultViewModel(result) {
  const details = result.details.map((detail) => {
    const isPlayerHit = Boolean(detail.isPlayerHit ?? detail.mark !== "×");
    const isOrderHit = Boolean(detail.isOrderHit ?? detail.mark === "◎");
    const isPositionHit = Boolean(detail.isPositionHit ?? detail.mark === "◎");

    return {
      ...detail,
      actualPlayer: detail.actualPlayer || "",
      actualPosition: detail.actualPosition || "",
      isPlayerHit,
      isOrderHit,
      isPositionHit
    };
  });
  const counts = result.counts || getHitCounts(details);
  const breakdown = result.breakdown || createScoreBreakdown(counts);

  return {
    total: result.total,
    max: SCORE_MAX,
    perfectLabel: result.total === SCORE_MAX ? "PERFECT" : "",
    counts,
    breakdown,
    details
  };
}

function createResultView(viewModel) {
  const wrapper = document.createElement("div");
  wrapper.className = "result-dashboard";

  const hero = document.createElement("div");
  hero.className = "result-hero";
  hero.innerHTML = `
    <p class="result-label">TOTAL SCORE</p>
    <div class="score-total"><strong>${viewModel.total}</strong><span>/ ${viewModel.max} 点</span></div>
    ${viewModel.perfectLabel ? `<p class="score-comment">${escapeHtml(viewModel.perfectLabel)}</p>` : ""}
  `;

  const breakdown = document.createElement("div");
  breakdown.className = "hit-breakdown";
  breakdown.innerHTML = `
    ${createBreakdownItem("出場得点", viewModel.breakdown.player.total, viewModel.breakdown.player.max, `出場的中：${viewModel.counts.player} / ${LINEUP_SIZE}`)}
    ${createBreakdownItem("打順得点", viewModel.breakdown.order.total, viewModel.breakdown.order.max, `打順的中：${viewModel.counts.order} / ${LINEUP_SIZE}`)}
    ${createBreakdownItem("守備位置得点", viewModel.breakdown.position.total, viewModel.breakdown.position.max, `守備位置的中：${viewModel.counts.position} / ${LINEUP_SIZE}`)}
  `;

  const tableWrap = document.createElement("div");
  tableWrap.className = "result-table-wrap";
  tableWrap.appendChild(createResultTable(viewModel.details));

  wrapper.append(hero, breakdown, tableWrap);
  return wrapper;
}

function createBreakdownItem(label, score, max, countText) {
  return `
    <div class="breakdown-item">
      <span>${label}</span>
      <strong>${score} / ${max}</strong>
      <small>${countText}</small>
    </div>
  `;
}

function createResultTable(details) {
  const table = document.createElement("table");
  table.className = "result-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>打順</th>
        <th>予想選手</th>
        <th>実際の選手</th>
        <th>予想守備</th>
        <th>実際守備</th>
        <th>出場</th>
        <th>打順</th>
        <th>守備</th>
        <th>点</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector("tbody");
  details.forEach((detail) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${detail.order}番</strong></td>
      <td>${escapeHtml(detail.player)}</td>
      <td>${escapeHtml(detail.actualPlayer || "-")}</td>
      <td>${escapeHtml(detail.position || "-")}</td>
      <td>${escapeHtml(detail.actualPosition || "-")}</td>
      <td>${createHitBadge(detail.isPlayerHit)}</td>
      <td>${createHitBadge(detail.isOrderHit)}</td>
      <td>${createHitBadge(detail.isPositionHit)}</td>
      <td><strong>${detail.point}</strong></td>
    `;
    tbody.appendChild(row);
  });

  return table;
}

function createHitBadge(isHit) {
  return `<span class="hit-badge ${isHit ? "is-hit" : "is-miss"}">${isHit ? "○" : "×"}</span>`;
}

function createPredictionSummary(prediction) {
  const wrapper = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `${prediction.nickname}さんの予想`;

  const meta = document.createElement("div");
  meta.className = "summary-meta";
  meta.textContent = `保存日時：${formatDateTime(prediction.savedAt)}`;

  const list = document.createElement("ul");
  list.className = "lineup-list";
  normalizeLineup(prediction.lineup).forEach((lineupItem, index) => {
    const listItem = document.createElement("li");
    listItem.innerHTML = `<strong>${index + 1}番</strong><span>${escapeHtml(lineupItem.position)} ${escapeHtml(lineupItem.player)}</span>`;
    list.appendChild(listItem);
  });

  wrapper.append(title, meta, list);
  return wrapper;
}

function formatDateTime(isoString) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(isoString));
}

function sharePrediction() {
  if (!state.prediction) {
    showMessage("predictionError", "共有する予想がありません。");
    return;
  }

  openXShare(createPredictionShareText(state.prediction));
}

function shareResult() {
  if (!state.result) {
    showMessage("actualError", "共有する採点結果がありません。");
    return;
  }

  openXShare(createResultShareText(state.result));
}

function createPredictionShareText(prediction) {
  const lineup = normalizeLineup(prediction.lineup);
  const lines = [
    "ハムスタメンチャレンジ予想",
    "",
    `${prediction.nickname}さんのスタメン予想`,
    "",
    ...lineup.map((item, index) => `${index + 1}番 ${item.position} ${item.player}`),
    "",
    "#日ハム #lovefighters #スタメン予想"
  ];

  return lines.join("\n");
}

function createResultShareText(result) {
  const viewModel = createResultViewModel(result);
  const lines = [
    "Starting9 結果発表！",
    `スコア：${viewModel.total} / ${viewModel.max}点`,
    `出場的中：${viewModel.counts.player} / ${LINEUP_SIZE}`,
    `打順的中：${viewModel.counts.order} / ${LINEUP_SIZE}`,
    `守備位置的中：${viewModel.counts.position} / ${LINEUP_SIZE}`,
    "",
    "#日ハム #lovefighters #スタメン予想"
  ];

  return lines.join("\n");
}

function openXShare(text) {
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function resetAllData() {
  Object.values(STORAGE_KEYS).forEach(removeFromStorage);
  state.prediction = null;
  state.actual = null;
  state.result = null;
  state.actualPreview = null;
  state.adminStatus = "idle";
  state.adminError = "";
  state.activeOrder.prediction = 0;
  state.activeOrder.actual = 0;

  document.getElementById("predictionForm").reset();
  document.getElementById("actualPasteInput").value = "";
  setLineupValues("prediction", []);
  setLineupValues("actual", []);
  clearMessage("predictionError");
  clearMessage("actualError");
  clearMessage("parserError");
  showMessage("resetMessage", "保存データを削除しました。");
  renderAll();
}

function showMessage(elementId, message) {
  document.getElementById(elementId).textContent = message;
}

function clearMessage(elementId) {
  document.getElementById(elementId).textContent = "";
}

function escapeHtml(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}
