const STORAGE_KEYS = {
  prediction: "hamStarting9Prediction",
  actual: "hamStarting9Actual",
  result: "hamStarting9Result",
  gameInfo: "hamStarting9GameInfo",
  rosterSnapshot: "hamStarting9RosterSnapshot",
  candidateRosterFilter: "hamStarting9CandidateRosterFilter"
};
const LINEUP_SIZE = 9;
const SCORE_MAX = 100;
const SHARE_HASHTAGS = "#lovefighters #starting9";
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
const POINTER_LONG_PRESS_MS = 250;
const POINTER_DRAG_DISTANCE = 8;
const DRAG_DATA_TYPE = "application/x-ham-starting9-player";
const NPB_STARTER_SOURCE_URL = "https://npb.jp/announcement/starter/";
const NPBASE_MATCHUPS_URL = "https://npbase.jp/?view=labo&tool=matchups&day=today&sort=average&order=desc";
const NPBASE_PLAYER_FALLBACK_URL = "https://npbase.jp/";
const RANKING_DISPLAY_LIMIT = 50;
const MONTHLY_RANKING_MIN_YEAR = 2020;
const YEARLY_RANKING_MIN_YEAR = 2020;
const RANKING_SERVICE_START_YEAR = 2026;
const PREDICTION_DEADLINE_REFRESH_MS = 30 * 1000;
const ROSTER_SNAPSHOT_CACHE_TTL_MS = 60 * 60 * 1000;
const AUTO_FILL_POSITIONS = new Set(["捕", "一", "二", "三", "遊", "指"]);
const OUTFIELD_POSITIONS = ["左", "中", "右"];
// 日程・NPB取得の長いチームコードは維持し、選手IDだけ短い球団IDを使います。
const TEAM_PLAYER_ID_PREFIXES = Object.freeze({
  fighters: "F",
  hawks: "H",
  buffaloes: "Bs",
  marines: "M",
  eagles: "E",
  lions: "L",
  giants: "G",
  tigers: "T",
  baystars: "DB",
  carp: "C",
  dragons: "D",
  swallows: "S"
});
const DEFAULT_PLAYER_TEAM_CODE = "fighters";
let predictionSaveMessageTimerId = null;
let predictionDeadlineTimerId = null;
let publicRosterSyncRequestId = 0;
const FIGHTERS_TEAM_KEYWORDS = [
  "北海道日本ハムファイターズ",
  "北海道日本ハム",
  "日本ハム",
  "ファイターズ"
];
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
const playerCategoryLabels = {
  catcher: "捕",
  infielder: "内",
  outfielder: "外",
  dh: "DH"
};
const playerCategoryNames = {
  catcher: "捕手",
  infielder: "内野手",
  outfielder: "外野手",
  dh: "DHメイン"
};

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
  gameInfo: {
    scoreUrl: "",
    gameStartAt: "",
    matchup: "",
    selectedGameId: "",
    manualGameSelection: false,
    manualStartOverride: false
  },
  candidateRosterFilter: "active",
  achievements: {
    isLoading: false,
    requestId: 0,
    items: [],
    message: ""
  },
  probableStarter: {
    isLoading: false,
    status: "idle",
    message: "",
    nextGame: null,
    matchedGame: null,
    games: [],
    fetchedAt: "",
    sourceUrl: NPB_STARTER_SOURCE_URL,
    fetchedGameCount: 0,
    nextCheckAt: "",
    errorCode: "",
    referenceDiagnostics: null,
    logs: [],
    fetchedGameId: ""
  },
  predictionTargetGameId: "",
  predictionTargetGame: null,
  predictionTargetNotice: "",
  publicGameCatalog: {
    isLoading: false,
    games: [],
    message: ""
  },
  publicRoster: {
    internalGameId: "",
    gameDate: "",
    status: "pending",
    players: [],
    isLoading: false,
    usableUntil: ""
  },
  resultHistory: {
    isLoading: false,
    isDetailLoading: false,
    games: [],
    selectedGameId: "",
    isExpanded: false,
    result: null,
    message: "",
    detailError: ""
  },
  yearlyRanking: {
    isLoading: false,
    isLoadingSelf: false,
    requestId: 0,
    rows: [],
    summary: null,
    pagination: null,
    self: null,
    message: "",
    year: getJapanYearMonth().year
  },
  dailyBestNine: {
    isLoading: false,
    requestId: 0,
    gameId: "",
    status: "idle",
    rows: [],
    totalCount: 0,
    message: "",
  },
  rankingView: "weekly",
  monthlyRanking: {
    isLoading: false,
    isLoadingSelf: false,
    requestId: 0,
    rows: [],
    summary: null,
    pagination: null,
    self: null,
    message: "",
    ...getJapanYearMonth()
  },
  weeklyRanking: {
    isLoading: false,
    isLoadingSelf: false,
    requestId: 0,
    rows: [],
    summary: null,
    pagination: null,
    self: null,
    message: "",
    weekStart: getJapanWeekRange().startAt
  },
  predictionRemote: {
    isLoading: false,
    isSaving: false,
    isSubmitting: false,
    isDeleting: false,
    status: "idle",
    message: "",
    gameId: "",
    prediction: null,
    submittedAt: "",
    updatedAt: "",
    locked: false,
    conflict: false,
    score: null,
    maxScore: null,
    scoredAt: "",
    resultsPublished: false
  },
  predictionDeadline: {
    gameId: "",
    game: null,
    status: "loading",
    message: "試合情報を確認しています。",
    startAt: "",
    deadlineAt: "",
    isClosed: true,
    override: "auto"
  },
  gameDayNotice: {
    isLoading: false,
    gameId: "",
    record: null,
    message: ""
  },
  activeOrder: {
    prediction: 0,
    actual: 0
  },
  pointerInteraction: null,
  pointerSuppressClickUntil: 0
};

const publicFrontend = window.Starting9Public;
const publicStorage = publicFrontend.createPublicStorage(window.localStorage);
const appState = publicFrontend.state.createPublicAppState(state);
const publicRequestGuard = publicFrontend.createPublicRequestGuard(appState.requests);
const publicApiClient = publicFrontend.createPublicApiClient();

function syncPublicAppState() {
  publicFrontend.state.syncPublicAppState(appState, state);
}

function beginPublicRequest(name, { abort = false } = {}) {
  return publicRequestGuard.begin(name, { abort });
}

function isCurrentPublicRequest(name, id) {
  return publicRequestGuard.isCurrent(name, id);
}

function preserveDisplayedPublicResult() {
  return publicResultsRenderer.preserveDisplayedResult();
}

function discardStoredStateForGame(gameId) {
  const currentId = String(gameId || "").trim();
  if (!currentId) return;
  ["prediction", "actual", "result"].forEach((key) => {
    const value = state[key];
    if (value?.gameId && String(value.gameId) !== currentId) {
      state[key] = null;
      removeFromStorage(STORAGE_KEYS[key]);
    }
  });
}

const publicResultsRenderer = publicFrontend.createPublicResultsRenderer({
  state,
  storage: publicStorage,
  storageKeys: STORAGE_KEYS,
    renderScoreInsights,
  escapeHtml,
  createPredictionSummary,
  getResultHistoryGameId,
  formatResultHistoryMatchup,
  formatPublicJstDateTime,
  createResultView,
  createResultViewModel
});
const publicRankingRenderer = publicFrontend.createPublicRankingRenderer({
  getPredictionAccountUser,
  escapeHtml,
  formatRankingScore,
  formatParticipationRate,
  createRankingAchievementBadgesHtml
});
const publicRosterController = publicFrontend.createPublicRosterController({
  state,
  storage: publicStorage,
  storageKeys: STORAGE_KEYS,
  requestGuard: publicRequestGuard,
  getTargetInternalGameId: getGameDayRosterTargetInternalGameId,
  getRosterRequestId: () => publicRosterSyncRequestId,
  setRosterRequestId: (requestId) => { publicRosterSyncRequestId = requestId; },
  syncPublicAppState,
  renderPicker,
  renderPredictionDeadline,
  fetchGameDayRosterSnapshot,
  normalizeRosterEntries,
  getRosterSnapshotForCurrentGame,
  hasUsablePublicRosterForCurrentGame,
  getPlayerData,
  isPlayerInCurrentRoster,
  isRegisteredFielderCandidate
});
const publicPredictionFormController = publicFrontend.createPublicPredictionFormController({
  state,
  storage: publicStorage,
  storageKeys: STORAGE_KEYS,
  ensurePredictionEditingAllowed,
  updatePredictionSaveButton,
  clearMessage,
  getLineupValues,
  validateLineup,
  showMessage,
  markDuplicateSlots,
  getCurrentGameId,
  preserveDisplayedResult: preserveDisplayedPublicResult,
  renderSavedPrediction,
  renderPredictionCta,
  renderPredictionAccountStatus,
  renderPublicGameSelectionMeta,
  renderPicker,
  getPredictionAccountUser,
  showPredictionSaveMessage,
  savePredictionToAccount,
  setLineupValues,
  closeAllPositionMenus,
  renderScoreResult,
  deletePredictionFromAccount
});
const publicAppCoordinator = new publicFrontend.PublicAppCoordinator({
  appState,
  state,
  operations: {
    buildLineupPicker,
    loadState,
    bindEvents,
    syncPublicAppState,
    renderAll,
    initializePublicGameCatalog,
    startPredictionDeadlineTicker,
    initializeProbableStarter,
    initializeRosterCandidateSync,
    initializeAuthDependentFeatures,
    initializePredictionRemoteSync,
    initializeDailyBestNine,
    refreshPredictionDeadlineState,
    refreshGameDayNoticeStatus,
    renderPredictionCta,
    renderDailyBestNine,
    fetchDailyBestNine,
    syncPredictionFromAccount,
    fetchUserAchievements,
    refreshYearlyRanking,
    refreshMonthlyRanking,
    refreshWeeklyRanking,
    refreshResultHistory
  }
});
if (typeof window !== "undefined") {
  window.PublicAppCoordinator = publicFrontend.PublicAppCoordinator;
  window.publicAppState = appState;
}

document.addEventListener("DOMContentLoaded", () => {
  void publicAppCoordinator.start();
});

async function initializeAuthDependentFeatures() {
  const auth = window.starting9Auth;
  const ready = typeof auth?.whenInitialized === "function"
    ? auth.whenInitialized()
    : window.starting9AuthReady;

  if (!ready || typeof ready.then !== "function") {
    console.error("認証初期化Promiseを取得できませんでした。");
    return;
  }

  await ready;
  // 初期イベントは待機中に発火していても、解決済みPromiseから現在状態を必ず評価できます。
  window.addEventListener("starting9-auth-state-changed", handleAuthStateChanged);
  // 認証依存の取得はcanonical game確定後に、この初期化経路だけで開始します。
    const results = await Promise.allSettled([
      fetchUserAchievements({ force: true }),
      refreshWeeklyRanking({ force: true }),
      refreshResultHistory({ force: true })
    ]);
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const labels = ["実績", "ランキング", "過去結果"];
      console.error(`${labels[index]}の初期化に失敗しました`, result.reason?.message || "unknown error");
    }
  });
}

function bindEvents() {
  document.getElementById("predictionForm").addEventListener("submit", handlePredictionSubmit);
  document.getElementById("resetPredictionButton").addEventListener("click", resetPredictionInput);
  document.getElementById("refreshAchievementsButton")?.addEventListener("click", () => fetchUserAchievements({ force: true }));
  document.getElementById("sharePredictionButton").addEventListener("click", sharePrediction);
  document.getElementById("predictionCtaButton")?.addEventListener("click", handlePredictionCtaClick);
  document.getElementById("editSavedPredictionButton")?.addEventListener("click", scrollToPredictionForm);
  document.getElementById("showYearlyRankingButton")?.addEventListener("click", () => selectRankingView("yearly"));
  document.getElementById("showMonthlyRankingButton")?.addEventListener("click", () => selectRankingView("monthly"));
  document.getElementById("showWeeklyRankingButton")?.addEventListener("click", () => selectRankingView("weekly"));
  document.getElementById("rankingContent")?.addEventListener("click", handleRankingPeriodContentClick);
  document.getElementById("resultHistoryList")?.addEventListener("click", handleResultHistoryClick);
  document.getElementById("resultHistoryList")?.addEventListener("change", handleResultHistoryChange);
  document.addEventListener("pointermove", handlePointerInteractionMove, { passive: false });
  document.addEventListener("pointerup", handlePointerInteractionEnd);
  document.addEventListener("pointercancel", handlePointerInteractionCancel);
  document.addEventListener("touchstart", handleTouchInteractionStart, { passive: true });
  document.addEventListener("touchmove", handleTouchInteractionMove, { passive: false });
  document.addEventListener("touchend", handleTouchInteractionEnd, { passive: false });
  document.addEventListener("touchcancel", handleTouchInteractionCancel, { passive: false });
  document.querySelectorAll("[data-roster-filter]").forEach((button) => {
    button.addEventListener("click", () => setCandidateRosterFilter(button.dataset.rosterFilter));
  });
  document.addEventListener("click", () => closeAllPositionMenus());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAllPositionMenus();
      closePlayerDetails();
    }
  });
}

function buildAchievementsApiUrl() {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/me/achievements` : "";
}

function renderAchievements() {
  const panel = document.getElementById("achievementsPanel");
  const list = document.getElementById("achievementsList");
  if (!panel || !list) return;
  const user = getPredictionAccountUser();
  const hasAchievements = state.achievements.items.length > 0;
  panel.classList.toggle("hidden", !user || !hasAchievements);
  if (!user || !hasAchievements) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = state.achievements.items.map((achievement) => createAchievementCardHtml(achievement)).join("");
}

function createAchievementCardHtml(achievement) {
  const rarity = ACHIEVEMENT_RARITY_LABELS[achievement.rarity] ? achievement.rarity : "common";
  const icon = ACHIEVEMENT_ICONS[achievement.iconKey] || "*";
  const earned = achievement.earnedAt ? `<p class="achievement-earned">獲得：${escapeHtml(formatDateTime(achievement.earnedAt))}</p>` : "";
  return `<article class="achievement-card is-${escapeHtml(rarity)}">
    <span class="achievement-icon" aria-hidden="true">${escapeHtml(icon)}</span>
    <div class="achievement-body">
      <p class="achievement-rarity">${escapeHtml(ACHIEVEMENT_RARITY_LABELS[rarity])}</p>
      <h3>${escapeHtml(achievement.name)}</h3>
      <p>${escapeHtml(achievement.description)}</p>
      ${earned}
    </div>
  </article>`;
}

async function fetchUserAchievements({ force = false } = {}) {
  const user = getPredictionAccountUser();
  if (!user) {
    state.achievements = { isLoading: false, requestId: state.achievements.requestId + 1, items: [], message: "" };
    renderAchievements();
    return;
  }
  if (state.achievements.isLoading && !force) return;
  const url = buildAchievementsApiUrl();
  if (!url) return;
  const requestId = state.achievements.requestId + 1;
  state.achievements.requestId = requestId;
  state.achievements.isLoading = true;
  state.achievements.message = "";
  renderAchievements();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !Array.isArray(payload.achievements)) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    if (requestId !== state.achievements.requestId || getPredictionAccountUser()?.id !== user.id) return;
    state.achievements.items = payload.achievements;
  } catch (error) {
    if (requestId !== state.achievements.requestId) return;
    console.error("実績の取得に失敗しました", error.message);
    state.achievements.items = [];
    state.achievements.message = "実績を取得できませんでした。";
  } finally {
    if (requestId === state.achievements.requestId) {
      state.achievements.isLoading = false;
      renderAchievements();
    }
  }
}

function buildLineupPicker(pickerName, lineupId, playersId) {
  const lineupContainer = document.getElementById(lineupId);
  const playersContainer = document.getElementById(playersId);
  const lineupFragment = document.createDocumentFragment();
  const playersFragment = document.createDocumentFragment();

  for (let index = 0; index < LINEUP_SIZE; index += 1) {
    lineupFragment.appendChild(createLineupSlot(pickerName, index));
  }

  const pickerPlayers = pickerName === "prediction" ? getPredictionCandidateNames() : playerNames;
  pickerPlayers.forEach((player) => {
    playersFragment.appendChild(createPlayerChip(pickerName, player));
  });

  lineupContainer.appendChild(lineupFragment);
  playersContainer.appendChild(playersFragment);
}

function getPredictionCandidateNames() {
  return players
    .filter((player) => player.isBatterCandidate === true)
    .map((player) => player.name);
}

function hasUsablePublicRosterForCurrentGame() {
  const internalGameId = getGameDayRosterTargetInternalGameId();
  const gameDate = String(state.predictionTargetGame?.date || "").slice(0, 10);
  const roster = state.publicRoster;
  const baselineUsableUntil = roster?.status === "baseline"
    ? Date.parse(String(roster.usableUntil || ""))
    : Number.POSITIVE_INFINITY;
  return Boolean(
    roster
    && ["fresh", "baseline", "stale", "fallback", "attention"].includes(roster.status)
    && roster.internalGameId === internalGameId
    && (!gameDate || roster.gameDate === gameDate)
    && (roster.status !== "baseline" || baselineUsableUntil > Date.now())
    && roster.players.length
  );
}

function setCandidateRosterFilter(filter) {
  state.candidateRosterFilter = filter === "inactive" ? "inactive" : "active";
  saveToStorage(STORAGE_KEYS.candidateRosterFilter, state.candidateRosterFilter);
  renderPicker("prediction");
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
  slot.addEventListener("click", () => {
    if (Date.now() < state.pointerSuppressClickUntil || slot.dataset.skipClick === "true") {
      slot.dataset.skipClick = "false";
      return;
    }
    if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
    setActiveOrder(pickerName, index);
    showSlotPlayerDetails(pickerName, slot);
  });
  slot.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
      setActiveOrder(pickerName, index);
      showSlotPlayerDetails(pickerName, slot);
    }
  });
  slot.addEventListener("dragover", (event) => handleSlotDragOver(event, slot));
  slot.addEventListener("dragenter", () => slot.classList.add("is-drop-target"));
  slot.addEventListener("dragleave", () => slot.classList.remove("is-drop-target"));
  slot.addEventListener("drop", (event) => handleSlotDrop(event, slot));
  slot.addEventListener("dragstart", (event) => handleSlotDragStart(event, slot));
  slot.addEventListener("dragend", (event) => handleDragEnd(event, slot));
  slot.addEventListener("pointerdown", (event) => handleLineupPointerDown(event, slot));
  if (pickerName === "prediction") {
    slot.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
  }

  const order = document.createElement("span");
  order.className = "slot-order";
  order.textContent = `${index + 1}番`;

  const dragHandle = pickerName === "actual" ? document.createElement("button") : null;
  if (dragHandle) {
    dragHandle.className = "slot-drag-handle";
    dragHandle.type = "button";
    dragHandle.draggable = false;
    dragHandle.textContent = "⠿";
    dragHandle.setAttribute("aria-label", `${index + 1}番をドラッグして並び替え`);
    dragHandle.addEventListener("click", (event) => event.stopPropagation());
    dragHandle.addEventListener("dragstart", (event) => handleSlotDragStart(event, slot));
    dragHandle.addEventListener("dragend", (event) => handleDragEnd(event, slot));
  }

  const player = document.createElement("span");
  player.className = "slot-player slot-empty";
  player.textContent = "未選択";
  player.addEventListener("click", (event) => {
    event.stopPropagation();
    if (Date.now() < state.pointerSuppressClickUntil) return;
    setActiveOrder(pickerName, index);
    showSlotPlayerDetails(pickerName, slot);
  });

  const positionControl = createPositionControl(pickerName, index, slot);

  const clearButton = document.createElement("button");
  clearButton.className = "slot-clear";
  clearButton.type = "button";
  clearButton.setAttribute("aria-label", `${index + 1}番を空にする`);
  clearButton.textContent = "×";
  clearButton.addEventListener("click", (event) => {
    event.stopPropagation();
    clearSlot(pickerName, index);
  });

  slot.append(
    ...(dragHandle ? [dragHandle] : []),
    order,
    player,
    positionControl,
    clearButton
  );
  return slot;
}

function createPositionControl(pickerName, index, slot) {
  const control = document.createElement("div");
  control.className = "position-control";

  const button = document.createElement("button");
  const menu = document.createElement("div");
  const menuId = `${pickerName}-position-menu-${index}`;

  button.className = "position-button is-empty";
  button.type = "button";
  button.dataset.picker = pickerName;
  button.dataset.order = String(index);
  button.dataset.positionDnd = pickerName === "prediction" ? "true" : "false";
  button.draggable = pickerName === "actual" && shouldUseNativeDrag(pickerName);
  button.textContent = "?";
  button.setAttribute("aria-label", `${index + 1}番の守備位置を選択`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", menuId);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
    if (Date.now() < state.pointerSuppressClickUntil) return;
    if (button.dataset.skipClick === "true") {
      button.dataset.skipClick = "false";
      return;
    }
    togglePositionMenu(menu, button, pickerName, index);
  });
  button.addEventListener("pointerdown", (event) => handlePositionPointerDown(event, button, slot));
  if (pickerName === "actual") {
    button.addEventListener("dragstart", (event) => handlePositionDragStart(event, button, slot));
    button.addEventListener("dragend", (event) => handlePositionDragEnd(event, button));
  }

  menu.id = menuId;
  menu.className = "position-menu hidden";
  menu.setAttribute("role", "menu");
  ["", ...positions].forEach((position) => {
    const optionButton = document.createElement("button");
    optionButton.className = "position-menu-option";
    optionButton.type = "button";
    optionButton.textContent = position || "?";
    optionButton.dataset.position = position;
    optionButton.setAttribute("role", "menuitem");
    optionButton.setAttribute("aria-label", position ? `${position}を選択` : "守備位置を未選択にする");
    optionButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
      selectPositionForSlot(pickerName, index, position);
      clearMessage(pickerName === "prediction" ? "predictionError" : "actualError");
      closeAllPositionMenus();
    });
    menu.appendChild(optionButton);
  });

  control.append(button, menu);
  return control;
}

function togglePositionMenu(menu, button, pickerName, index) {
  if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
  const shouldOpen = menu.classList.contains("hidden");
  closeAllPositionMenus();

  if (shouldOpen) {
    updatePositionMenuState(menu, pickerName, index);
    menu.classList.remove("hidden");
    positionMobilePositionMenu(menu, button);
    button.setAttribute("aria-expanded", "true");
  }
}

function positionMobilePositionMenu(menu, button) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  if (!window.matchMedia("(max-width: 767px)").matches) return;

  menu.classList.add("is-mobile-position-menu");
  const buttonRect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const viewportPadding = 8;
  const maxLeft = Math.max(viewportPadding, window.innerWidth - menuRect.width - viewportPadding);
  const left = Math.min(Math.max(viewportPadding, buttonRect.left), maxLeft);
  const preferredTop = buttonRect.bottom + 6;
  const maxTop = window.innerHeight - menuRect.height - viewportPadding;
  const top = maxTop >= viewportPadding
    ? Math.min(preferredTop, maxTop)
    : viewportPadding;

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(viewportPadding, top))}px`;
}

function updatePositionMenuState(menu, pickerName, index) {
  const lineup = getLineupValues(pickerName);
  const currentPosition = lineup[index]?.position || "";
  const usedByOtherSlots = new Set(
    lineup
      .filter((_, lineupIndex) => lineupIndex !== index)
      .map((item) => item.position)
      .filter(Boolean)
  );

  menu.querySelectorAll(".position-menu-option").forEach((optionButton) => {
    const position = optionButton.dataset.position || "";
    const isCurrent = position === currentPosition;
    const isUsed = Boolean(position) && !isCurrent && usedByOtherSlots.has(position);
    optionButton.classList.toggle("is-current", isCurrent);
    optionButton.classList.toggle("is-used", isUsed);
    optionButton.title = isUsed ? "選択するとポジションを入れ替えます" : "";
    optionButton.setAttribute(
      "aria-label",
      position
        ? `${position}を選択${isUsed ? "（他の打順で使用中。選択すると入れ替えます）" : ""}`
        : "守備位置を未選択にする"
    );
  });
}

function selectPositionForSlot(pickerName, index, position) {
  if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
  const lineup = getLineupValues(pickerName);
  const updatedLineup = createPositionSelectionLineup(lineup, index, position);
  setLineupValues(pickerName, updatedLineup);
}

function createPositionSelectionLineup(lineup, targetIndex, position) {
  const updatedLineup = normalizeLineup(lineup);
  const target = updatedLineup[targetIndex];
  if (!target) {
    return updatedLineup;
  }

  const nextPosition = position ? normalizePosition(position) : "";
  const previousPosition = target.position || "";
  if (nextPosition === previousPosition) {
    return updatedLineup;
  }

  const occupiedIndex = nextPosition
    ? updatedLineup.findIndex((item, lineupIndex) => lineupIndex !== targetIndex && item.position === nextPosition)
    : -1;

  updatedLineup[targetIndex] = createLineupItem(targetIndex, target.player, nextPosition);
  if (occupiedIndex !== -1) {
    const occupied = updatedLineup[occupiedIndex];
    updatedLineup[occupiedIndex] = createLineupItem(occupiedIndex, occupied.player, previousPosition);
  }

  return updatedLineup;
}

function closeAllPositionMenus() {
  document.querySelectorAll(".position-menu").forEach((menu) => {
    menu.classList.add("hidden");
    menu.classList.remove("is-mobile-position-menu");
    menu.style.removeProperty("left");
    menu.style.removeProperty("top");
  });
  document.querySelectorAll(".position-button").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
}

function createPlayerChip(pickerName, player) {
  const button = document.createElement("button");
  button.className = "player-chip";
  button.type = "button";
  button.dataset.picker = pickerName;
  button.dataset.player = player;
  button.title = player;
  button.draggable = shouldUseNativeDrag(pickerName);
  button.innerHTML = createPlayerLabelHtml(player);
  applyPlayerCategoryClass(button, player);

  if (pickerName === "prediction") {
    const detailButton = document.createElement("span");
    detailButton.className = "player-chip-detail-button";
    detailButton.textContent = "詳細";
    detailButton.setAttribute("role", "button");
    detailButton.setAttribute("draggable", "false");
    detailButton.tabIndex = 0;
    detailButton.setAttribute("aria-label", `${player}の詳細を開く`);
    const openDetails = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!button.disabled) showPlayerDetails(pickerName, player);
    };
    detailButton.addEventListener("pointerdown", (event) => event.stopPropagation());
    detailButton.addEventListener("click", openDetails);
    detailButton.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") openDetails(event);
    });
    button.appendChild(detailButton);
  }

  button.addEventListener("click", () => {
    if (Date.now() < state.pointerSuppressClickUntil) return;
    if (button.dataset.skipClick === "true") {
      button.dataset.skipClick = "false";
      return;
    }

    if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
    assignPlayerToActiveSlot(pickerName, player);
  });
  button.addEventListener("pointerdown", (event) => handlePlayerPointerDown(event, button));
  if (pickerName === "prediction") {
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
  }
  button.addEventListener("dragstart", (event) => handlePlayerDragStart(event, button));
  button.addEventListener("dragend", (event) => handleDragEnd(event, button));

  return button;
}

function handlePlayerDragStart(event, button) {
  if (button.dataset.picker === "prediction" && !ensurePredictionEditingAllowed()) {
    event.preventDefault();
    return;
  }
  const dragData = {
    kind: "player",
    pickerName: button.dataset.picker,
    player: button.dataset.player,
    sourceOrder: null
  };

  setDragData(event, dragData);
  button.classList.add("is-dragging");
}

function handleSlotDragStart(event, slot) {
  if (slot.dataset.picker === "prediction" && !ensurePredictionEditingAllowed()) {
    event.preventDefault();
    return;
  }
  const player = slot.dataset.player;

  if (!player) {
    event.preventDefault();
    return;
  }

  const dragData = {
    kind: "lineup",
    pickerName: slot.dataset.picker,
    player,
    sourceOrder: Number(slot.dataset.order)
  };

  setDragData(event, dragData);
  slot.classList.add("is-dragging");
}

function handlePositionDragStart(event, button, slot) {
  closeAllPositionMenus();

  if (slot.dataset.picker === "prediction" && !ensurePredictionEditingAllowed()) {
    event.preventDefault();
    return;
  }

  const position = slot.dataset.position;

  button.dataset.skipClick = "true";
  setDragData(event, {
    kind: "position",
    pickerName: slot.dataset.picker,
    position,
    sourceOrder: Number(slot.dataset.order)
  });
  button.classList.add("is-dragging");
}

function handlePositionDragEnd(event, button) {
  handleDragEnd(event, button);
  closeAllPositionMenus();
  setTimeout(() => {
    button.dataset.skipClick = "false";
  }, 0);
}

function setDragData(event, dragData) {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(DRAG_DATA_TYPE, JSON.stringify(dragData));
  event.dataTransfer.setData("text/plain", dragData.player || dragData.position || "");
}

function handleSlotDragOver(event, slot) {
  if (slot?.dataset?.picker === "prediction" && isPredictionEditingLocked()) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

function handleSlotDrop(event, slot) {
  event.preventDefault();
  slot.classList.remove("is-drop-target");

  if (slot.dataset.picker === "prediction" && !ensurePredictionEditingAllowed()) return;

  const dragData = getDragData(event);
  if (!dragData || dragData.pickerName !== slot.dataset.picker) {
    return;
  }

  if (dragData.kind === "position") {
    closeAllPositionMenus();
    movePositionBetweenSlots(slot.dataset.picker, dragData.sourceOrder, Number(slot.dataset.order));
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
  element.dataset.skipClick = "true";
  setTimeout(() => {
    element.dataset.skipClick = "false";
  }, 0);
  document.querySelectorAll(".lineup-slot.is-drop-target").forEach((slot) => {
    slot.classList.remove("is-drop-target");
  });
}

function handlePlayerPointerDown(event, button) {
  beginPointerInteraction(event, button, "player");
}

function handleLineupPointerDown(event, slot) {
  if (slot.dataset.picker !== "prediction" || !slot.dataset.player) return;
  beginPointerInteraction(event, slot, "lineup");
}

function handlePositionPointerDown(event, button, slot) {
  if (button.dataset.picker !== "prediction" || event.pointerType !== "mouse" || isPredictionEditingLocked()) return;
  event.stopPropagation();
  slot.dataset.positionParentDraggable = slot.draggable ? "true" : "false";
  slot.draggable = false;
  beginPointerInteraction(event, button, "position", { allowMouse: true, activateOnMove: true, nativeDragOwner: slot });
}

function beginPointerInteraction(event, element, kind, options) {
  const { allowMouse = false, activateOnMove = false, nativeDragOwner = null } = options || {};
  if (element.dataset.picker !== "prediction" || (event.pointerType === "mouse" && !allowMouse) || isPredictionEditingLocked()) return;
  if (kind === "lineup" && event.target instanceof Element && event.target.closest("button, .position-menu")) return;

  clearPointerInteraction();
  const interaction = {
    pointerId: event.pointerId,
    element,
    kind,
    pickerName: element.dataset.picker,
    sourceIndex: kind === "lineup" || kind === "position" ? Number(element.dataset.order) : null,
    player: element.dataset.player,
    startX: event.clientX,
    startY: event.clientY,
    targetIndex: null,
    active: false,
    inputSource: event.inputSource || "pointer",
    pointerType: event.pointerType || "",
    activeTouchIdentifier: event.inputSource === "touch" ? event.pointerId : null,
    activateOnMove,
    nativeDragOwner,
    timerId: activateOnMove ? null : setTimeout(() => activatePointerInteraction(interaction), POINTER_LONG_PRESS_MS)
  };

  state.pointerInteraction = interaction;
  element.classList.add("is-pressing");
  try {
    element.setPointerCapture(interaction.pointerId);
  } catch {
    // Pointer capture is unavailable in some Safari versions; document listeners remain the fallback.
  }
}

function activatePointerInteraction(interaction) {
  if (state.pointerInteraction !== interaction || isPredictionEditingLocked()) return;
  if (interaction.kind === "position") closeAllPositionMenus();
  interaction.active = true;
  interaction.element.classList.remove("is-pressing");
  interaction.element.classList.add("is-dragging");
  if ((interaction.kind === "player" || interaction.kind === "lineup") && typeof createMobileDragGhost === "function") {
    createMobileDragGhost(interaction);
  }
  try {
    interaction.element.setPointerCapture(interaction.pointerId);
  } catch {
    // Pointer capture is unavailable in some embedded browsers; document listeners still handle cleanup.
  }
}

function handlePointerInteractionMove(event) {
  const interaction = state.pointerInteraction;
  if (!interaction || interaction.inputSource !== (event.inputSource || "pointer") || interaction.pointerId !== event.pointerId) return;

  const distance = Math.hypot(event.clientX - interaction.startX, event.clientY - interaction.startY);
  if (!interaction.active) {
    if (distance > POINTER_DRAG_DISTANCE) {
      if (interaction.activateOnMove) {
        activatePointerInteraction(interaction);
      } else {
        clearPointerInteraction();
      }
    }
    if (!interaction.active) return;
  }

  event.preventDefault();
  if (typeof updateMobileDragGhost === "function") {
    updateMobileDragGhost(interaction, event.clientX, event.clientY);
  }
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(
    `.lineup-slot[data-picker="${interaction.pickerName}"]`
  );
  document.querySelectorAll(`.lineup-slot[data-picker="${interaction.pickerName}"].is-drop-target`).forEach((slot) => {
    slot.classList.remove("is-drop-target");
  });

  if (!target) {
    interaction.targetIndex = null;
    return;
  }

  interaction.targetIndex = Number(target.dataset.order);
  target.classList.add("is-drop-target");
}

function handlePointerInteractionEnd(event) {
  const interaction = state.pointerInteraction;
  if (!interaction || interaction.inputSource !== (event.inputSource || "pointer") || interaction.pointerId !== event.pointerId) return;

  if (interaction.active) {
    event.preventDefault();
    const targetIndex = interaction.targetIndex;
    if (Number.isInteger(targetIndex)) {
      if (interaction.kind === "lineup") {
        moveLineupSlot(interaction.pickerName, interaction.sourceIndex, targetIndex);
      } else if (interaction.kind === "position") {
        movePositionBetweenSlots(interaction.pickerName, interaction.sourceIndex, targetIndex);
      } else {
        assignPlayerToSlot(interaction.pickerName, interaction.player, targetIndex, null);
      }
    }
    state.pointerSuppressClickUntil = Date.now() + 400;
  }

  clearPointerInteraction();
}

function handlePointerInteractionCancel(event) {
  const interaction = state.pointerInteraction;
  if (!interaction || interaction.inputSource !== (event.inputSource || "pointer") || interaction.pointerId !== event.pointerId) return;
  if (interaction.active) state.pointerSuppressClickUntil = Date.now() + 400;
  clearPointerInteraction();
}

function clearPointerInteraction() {
  const interaction = state.pointerInteraction;
  if (!interaction) return;

  clearTimeout(interaction.timerId);
  interaction.element.classList.remove("is-pressing", "is-dragging");
  if (typeof clearMobileDragGhost === "function") {
    clearMobileDragGhost(interaction);
  }
  if (interaction.kind === "position" && interaction.nativeDragOwner) {
    interaction.nativeDragOwner.draggable = interaction.nativeDragOwner.dataset.positionParentDraggable === "true";
    delete interaction.nativeDragOwner.dataset.positionParentDraggable;
  }
  document.querySelectorAll(".lineup-slot.is-drop-target").forEach((slot) => {
    slot.classList.remove("is-drop-target");
  });
  try {
    if (interaction.element.hasPointerCapture?.(interaction.pointerId)) {
      interaction.element.releasePointerCapture(interaction.pointerId);
    }
  } catch {
    // Pointer capture cleanup is best effort.
  }
  state.pointerInteraction = null;
}

function createMobileDragGhost(interaction) {
  if (interaction.pointerType !== "touch" || !interaction.player || typeof document === "undefined") return;

  const ghost = document.createElement("div");
  ghost.className = "mobile-drag-ghost";
  ghost.textContent = interaction.player;
  ghost.setAttribute("aria-hidden", "true");
  document.body.appendChild(ghost);
  interaction.ghost = ghost;
  updateMobileDragGhost(interaction, interaction.startX, interaction.startY);
}

function updateMobileDragGhost(interaction, clientX, clientY) {
  const ghost = interaction.ghost;
  if (!ghost || typeof window === "undefined") return;

  const viewportPadding = 8;
  const maxLeft = Math.max(viewportPadding, window.innerWidth - ghost.offsetWidth - viewportPadding);
  const maxTop = Math.max(viewportPadding, window.innerHeight - ghost.offsetHeight - viewportPadding);
  const ghostOffset = 40;
  const preferredLeft = clientX - ghost.offsetWidth / 2;
  const preferredTop = clientY - ghost.offsetHeight - ghostOffset;
  const left = Math.min(Math.max(viewportPadding, preferredLeft), maxLeft);
  const top = Math.min(Math.max(viewportPadding, preferredTop), maxTop);
  ghost.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
}

function clearMobileDragGhost(interaction) {
  if (!interaction?.ghost) return;
  interaction.ghost.remove();
  interaction.ghost = null;
}

function createTouchPointerEvent(touch, sourceEvent) {
  return {
    pointerId: touch.identifier,
    pointerType: "touch",
    clientX: touch.clientX,
    clientY: touch.clientY,
    target: sourceEvent.target,
    inputSource: "touch",
    preventDefault: () => sourceEvent.preventDefault()
  };
}

function getTouchInteractionTarget(event) {
  if (event.touches.length !== 1 || !(event.target instanceof Element)) return null;
  const target = event.target.closest(
    '.player-chip[data-picker="prediction"], .lineup-slot[data-picker="prediction"]'
  );
  if (!target || (target.classList.contains("lineup-slot") && !target.dataset.player)) return null;
  return target;
}

function handleTouchInteractionStart(event) {
  const target = getTouchInteractionTarget(event);
  const touch = event.changedTouches[0];
  if (!target || !touch) return;

  const existingInteraction = state.pointerInteraction;
  if (existingInteraction) {
    if (existingInteraction.pointerType !== "touch" || existingInteraction.element !== target) return;
    existingInteraction.inputSource = "touch";
    existingInteraction.activeTouchIdentifier = touch.identifier;
    existingInteraction.pointerId = touch.identifier;
    return;
  }

  const kind = target.classList.contains("player-chip") ? "player" : "lineup";
  beginPointerInteraction(createTouchPointerEvent(touch, event), target, kind);
}

function getChangedTouch(event, interaction) {
  const touchIdentifier = interaction.activeTouchIdentifier ?? interaction.pointerId;
  return Array.from(event.changedTouches).find((touch) => touch.identifier === touchIdentifier);
}

function handleTouchInteractionMove(event) {
  const interaction = state.pointerInteraction;
  if (!interaction || interaction.inputSource !== "touch") return;
  const touch = getChangedTouch(event, interaction);
  if (touch) handlePointerInteractionMove(createTouchPointerEvent(touch, event));
}

function handleTouchInteractionEnd(event) {
  const interaction = state.pointerInteraction;
  if (!interaction || interaction.inputSource !== "touch") return;
  const touch = getChangedTouch(event, interaction);
  if (touch) handlePointerInteractionEnd(createTouchPointerEvent(touch, event));
}

function handleTouchInteractionCancel(event) {
  const interaction = state.pointerInteraction;
  if (!interaction || interaction.inputSource !== "touch") return;
  const touch = getChangedTouch(event, interaction);
  if (touch) handlePointerInteractionCancel(createTouchPointerEvent(touch, event));
}

function shouldUseNativeDrag(pickerName) {
  if (pickerName === "actual") return true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(pointer: fine)").matches;
}

function setActiveOrder(pickerName, index) {
  state.activeOrder[pickerName] = index;
  clearMessage(pickerName === "prediction" ? "predictionError" : "actualError");
  renderPicker(pickerName);
}

function assignPlayerToActiveSlot(pickerName, player) {
  if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
  const lineup = getLineupValues(pickerName);
  const currentIndex = lineup.findIndex((item) => item.player === player);
  const targetIndex = getTargetOrder(pickerName, lineup);
  const targetPlayer = lineup[targetIndex]?.player || "";
  const targetPosition = targetPlayer === player ? lineup[targetIndex]?.position || "" : "";

  if (currentIndex !== -1 && currentIndex !== targetIndex) {
    lineup[currentIndex] = createLineupItem(currentIndex, "", "");
  }

  lineup[targetIndex] = createLineupItem(targetIndex, player, targetPosition);
  autoFillPredictionPosition(pickerName, lineup, targetIndex);
  setLineupValues(pickerName, lineup);
  state.activeOrder[pickerName] = findNextEmptyIndex(lineup, targetIndex);
  renderPicker(pickerName);
}

function assignPlayerToSlot(pickerName, player, targetIndex, sourceIndex) {
  if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
  const lineup = getLineupValues(pickerName);
  const movedLineup = moveLineupItem(lineup, player, targetIndex, sourceIndex);
  autoFillPredictionPosition(pickerName, movedLineup, targetIndex);
  setLineupValues(pickerName, movedLineup);
  state.activeOrder[pickerName] = targetIndex;
  clearMessage(pickerName === "prediction" ? "predictionError" : "actualError");
  renderPicker(pickerName);
}

function moveLineupItem(lineup, player, targetIndex, sourceIndex) {
  const movedLineup = normalizeLineup(lineup);
  const currentIndex = movedLineup.findIndex((item) => item.player === player);
  const replacedItem = movedLineup[targetIndex];
  const hasSource = sourceIndex !== null && sourceIndex !== undefined;
  const movingPosition = hasSource
    ? movedLineup[sourceIndex]?.position || ""
    : replacedItem?.player === player ? replacedItem.position || "" : "";

  if (hasSource && sourceIndex !== targetIndex) {
    movedLineup[sourceIndex] = createLineupItem(sourceIndex, replacedItem?.player || "", replacedItem?.position || "");
  } else if (currentIndex !== -1 && currentIndex !== targetIndex) {
    movedLineup[currentIndex] = createLineupItem(currentIndex, "", "");
  }

  movedLineup[targetIndex] = createLineupItem(targetIndex, player, movingPosition);
  return movedLineup;
}

function movePositionBetweenSlots(pickerName, sourceIndex, targetIndex) {
  if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
  const lineup = getLineupValues(pickerName);
  const movedLineup = moveLineupPosition(lineup, sourceIndex, targetIndex);
  setLineupValues(pickerName, movedLineup);
  state.activeOrder[pickerName] = targetIndex;
  clearMessage(pickerName === "prediction" ? "predictionError" : "actualError");
  renderPicker(pickerName);
}

function moveLineupSlot(pickerName, sourceIndex, targetIndex) {
  if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
  if (targetIndex < 0 || targetIndex >= LINEUP_SIZE || sourceIndex === targetIndex) return;

  const lineup = normalizeLineup(getLineupValues(pickerName));
  const sourceItem = lineup[sourceIndex];
  const targetItem = lineup[targetIndex];
  if (!sourceItem || !targetItem) return;

  lineup[sourceIndex] = createLineupItem(sourceIndex, targetItem.player, targetItem.position);
  lineup[targetIndex] = createLineupItem(targetIndex, sourceItem.player, sourceItem.position);
  state.activeOrder[pickerName] = targetIndex;
  setLineupValues(pickerName, lineup);
  clearMessage(pickerName === "prediction" ? "predictionError" : "actualError");
}

function moveLineupPosition(lineup, sourceIndex, targetIndex) {
  const movedLineup = normalizeLineup(lineup);

  if (sourceIndex === targetIndex) {
    return movedLineup;
  }

  const sourcePosition = movedLineup[sourceIndex]?.position || "";
  const targetPosition = movedLineup[targetIndex]?.position || "";
  movedLineup[sourceIndex] = createLineupItem(sourceIndex, movedLineup[sourceIndex]?.player || "", targetPosition);
  movedLineup[targetIndex] = createLineupItem(targetIndex, movedLineup[targetIndex]?.player || "", sourcePosition);
  return movedLineup;
}

function autoFillPredictionPosition(pickerName, lineup, targetIndex) {
  if (pickerName !== "prediction" || lineup[targetIndex]?.position) {
    return;
  }

  const player = getPlayerData(lineup[targetIndex]?.player);
  if (!player || !Array.isArray(player.positions) || !player.positions.length) {
    return;
  }

  const usedPositions = new Set(
    lineup
      .filter((_, index) => index !== targetIndex)
      .map((item) => item.position)
      .filter(Boolean)
  );
  const decision = resolveAutoFillPosition(player.positions, usedPositions);

  if (decision.position) {
    lineup[targetIndex] = createLineupItem(targetIndex, player.name, decision.position);
  }
}

// An ambiguous candidate group must stop fallback so a low-priority position is not guessed.
function resolveAutoFillPosition(positions, usedPositions) {
  const normalizedUsedPositions = new Set(
    Array.from(usedPositions || [])
      .map((position) => normalizePosition(position))
      .filter(Boolean)
  );

  for (const position of Array.isArray(positions) ? positions : []) {
    const normalizedPosition = normalizePosition(position);
    const isConcretePosition = AUTO_FILL_POSITIONS.has(normalizedPosition) || OUTFIELD_POSITIONS.includes(normalizedPosition);

    if (isConcretePosition) {
      if (!normalizedUsedPositions.has(normalizedPosition)) {
        return { position: normalizedPosition, ambiguous: false };
      }
      continue;
    }

    if (normalizeDisplayPosition(position) !== "外") {
      continue;
    }

    const unusedOutfieldPositions = OUTFIELD_POSITIONS.filter((outfieldPosition) => !normalizedUsedPositions.has(outfieldPosition));
    if (unusedOutfieldPositions.length === 1) {
      return { position: unusedOutfieldPositions[0], ambiguous: false };
    }

    if (unusedOutfieldPositions.length > 1) {
      return { position: "", ambiguous: true };
    }
  }

  return { position: "", ambiguous: false };
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
  if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
  const lineup = getLineupValues(pickerName);
  setLineupValues(pickerName, clearLineupItem(lineup, index));
  state.activeOrder[pickerName] = index;
  closeAllPositionMenus();
  const detailsPanel = document.getElementById(`${normalizePickerName(pickerName)}PlayerDetails`);
  if (detailsPanel) {
    detailsPanel.classList.add("hidden");
    detailsPanel.innerHTML = "";
  }
  renderPicker(pickerName);
}

function clearLineupItem(lineup, index) {
  const clearedLineup = normalizeLineup(lineup);
  clearedLineup[index] = createLineupItem(index, "", "");
  return clearedLineup;
}

function normalizeRosterSnapshot(snapshot) {
  return {
    internalGameId: typeof snapshot?.internalGameId === "string" ? snapshot.internalGameId : "",
    gameDate: typeof snapshot?.gameDate === "string" ? snapshot.gameDate.slice(0, 10) : "",
    fetchedAt: typeof snapshot?.fetchedAt === "string" ? snapshot.fetchedAt : "",
    sourceUrl: typeof snapshot?.sourceUrl === "string" ? snapshot.sourceUrl : "",
    method: typeof snapshot?.method === "string" ? snapshot.method : "",
    warning: typeof snapshot?.warning === "string" ? snapshot.warning : "",
    httpStatus: Number(snapshot?.httpStatus) || 0,
    cacheStatus: typeof snapshot?.cacheStatus === "string" ? snapshot.cacheStatus : "",
    stale: snapshot?.stale === true,
    parsedCount: Number(snapshot?.parsedCount) || 0,
    announcedCount: Number(snapshot?.announcedCount) || 0,
    players: normalizeRosterEntries(snapshot?.players)
  };
}

function normalizeRosterEntries(players) {
  if (!Array.isArray(players)) {
    return [];
  }

  const seen = new Set();
  const normalizedEntries = [];

  players.forEach((player) => {
    const source = typeof player === "object" && player !== null ? player : { name: player };
    const displayName = String(source.name || "").replace(/\u3000/g, " ").replace(/\s+/g, " ").trim().replace(/[\s\u3000]/g, "");
    const key = createRosterEntryKey({ number: source.number, name: displayName });
    if (!displayName || !key || seen.has(key)) {
      return;
    }

    seen.add(key);
    normalizedEntries.push({
      position: String(source.position || "").trim(),
      number: String(source.number || "").trim(),
      name: displayName
    });
  });

  return normalizedEntries;
}

function diffRosterPlayers(previousPlayers, currentPlayers) {
  const previousMap = createRosterPlayerMap(previousPlayers);
  const currentMap = createRosterPlayerMap(currentPlayers);
  const added = [];
  const removed = [];

  currentMap.forEach((player, key) => {
    if (!previousMap.has(key)) {
      added.push(player);
    }
  });

  previousMap.forEach((player, key) => {
    if (!currentMap.has(key)) {
      removed.push(player);
    }
  });

  return { added, removed };
}

function createRosterPlayerMap(players) {
  const playerMap = new Map();

  normalizeRosterEntries(players).forEach((player) => {
    playerMap.set(createRosterEntryKey(player), player.name);
  });

  return playerMap;
}

function createRosterEntryKey(player) {
  const number = String(player?.number || "").trim();
  return number ? `number:${number}` : `name:${normalizePlayerKey(player?.name)}`;
}

function isRosterSnapshotFresh(snapshot, now = Date.now()) {
  const fetchedAtMs = Date.parse(snapshot?.fetchedAt || "");
  return Number.isFinite(fetchedAtMs)
    && now - fetchedAtMs >= 0
    && now - fetchedAtMs < ROSTER_SNAPSHOT_CACHE_TTL_MS;
}

function canUseRosterSnapshot(snapshot) {
  return Boolean(snapshot?.players?.length) && !snapshot.warning;
}

function getGameDayRosterTargetInternalGameId() {
  return String(
    state.predictionTargetGame?.internalGameId
    || state.probableStarter.nextGame?.internalGameId
    || getCurrentGameId()
    || ""
  ).trim();
}

function getRosterSnapshotForCurrentGame() {
  const snapshot = normalizeRosterSnapshot(loadFromStorage(STORAGE_KEYS.rosterSnapshot));
  const internalGameId = getGameDayRosterTargetInternalGameId();
  const gameDate = String(state.predictionTargetGame?.date || "").slice(0, 10);
  if (!internalGameId || snapshot.internalGameId !== internalGameId || (gameDate && snapshot.gameDate !== gameDate)) {
    return { ...snapshot, players: [] };
  }
  return snapshot;
}

function isPlayerInCurrentRoster(player) {
  if (!hasUsablePublicRosterForCurrentGame()) return false;
  return state.publicRoster.players.some((entry) => rosterEntryMatchesPlayer(entry, player));
}

function isRegisteredFielderCandidate(player) {
  if (!player || player.isBatterCandidate !== true) return false;
  if (player.predictionCandidateRole === "special_dh") return false;
  return isPlayerInCurrentRoster(player);
}

function rosterEntryMatchesPlayer(entry, player) {
  const rosterNumber = String(entry?.number || "").trim();
  const masterNumber = String(player?.uniformNumber || "").trim();
  if (rosterNumber && masterNumber) {
    return rosterNumber === masterNumber;
  }

  const rosterNameKey = normalizePlayerKey(entry?.name);
  if (!rosterNameKey) {
    return false;
  }
  return [player?.name, ...(Array.isArray(player?.aliases) ? player.aliases : [])]
    .some((name) => normalizePlayerKey(name) === rosterNameKey);
}

async function initializeRosterCandidateSync() {
  return publicRosterController.syncCurrentGameRoster();
}

async function initializeProbableStarter() {
  const schedule = await getLoadedGameSchedule();
  const previousGame = state.predictionTargetGame || state.probableStarter.nextGame;
  const previousGameId = previousGame?.gameId || state.predictionTargetGameId || "";
  const catalogGame = state.publicGameCatalog.games.length
    ? selectInitialPublicGame(state.publicGameCatalog.games)
    : null;
  const nextGame = catalogGame || await resolvePredictionTargetGame(schedule, true);
  const preservedGame = catalogGame || nextGame || null;
  state.probableStarter.nextGame = preservedGame;
  state.predictionTargetGame = preservedGame;
  state.predictionTargetGameId = state.probableStarter.nextGame?.internalGameId || state.probableStarter.nextGame?.gameId || "";
  if (nextGame && previousGameId && (previousGameId !== state.predictionTargetGameId || previousGame?.internalGameId !== nextGame.internalGameId)) {
    state.predictionTargetNotice = "予想対象試合が次の試合へ切り替わりました。";
    state.prediction = null;
    state.actual = null;
    removeFromStorage(STORAGE_KEYS.prediction);
    removeFromStorage(STORAGE_KEYS.actual);
  }
  renderProbableStarter();
  renderPredictionTargetNotice();

  if (state.probableStarter.nextGame) {
    await fetchStoredProbableStarter();
  } else {
    state.probableStarter.status = "noGame";
    state.probableStarter.message = "次の試合を検出できませんでした。";
    renderProbableStarter();
  }
}

async function refreshPredictionTarget({ retryUnannounced = true, useServer = true } = {}) {
  const request = beginPublicRequest("target", { abort: true });
  const schedule = await getLoadedGameSchedule();
  const catalogGame = state.publicGameCatalog.games.length
    ? selectInitialPublicGame(state.publicGameCatalog.games)
    : null;
  const nextGame = catalogGame || await resolvePredictionTargetGame(schedule, useServer);
  if (!isCurrentPublicRequest("target", request.id)) return;
  const previousGame = state.predictionTargetGame || state.probableStarter.nextGame;
  const previousGameId = state.predictionTargetGameId || previousGame?.internalGameId || "";
  if (!nextGame) {
    setPublicCurrentGame(null);
    renderAll();
    void initializeRosterCandidateSync();
    return;
  }
  if ((nextGame?.internalGameId || "") !== previousGameId) {
    setPublicCurrentGame(nextGame);
    state.probableStarter.matchedGame = null;
    state.probableStarter.games = [];
    state.probableStarter.fetchedGameId = "";
    state.probableStarter.status = nextGame ? "idle" : "noGame";
    state.probableStarter.message = nextGame ? "次の試合を確認しています。" : "次の試合を検出できませんでした。";
    state.probableStarter.nextCheckAt = "";
    state.probableStarter.errorCode = "";
    state.probableStarter.referenceDiagnostics = null;
    state.predictionTargetNotice = nextGame ? "予想対象試合が次の試合へ切り替わりました。" : "";
    renderAll();
    void refreshGameDayNoticeStatus({ force: true });
    void initializeRosterCandidateSync();
    if (nextGame) await fetchStoredProbableStarter();
    return;
  }
  // 未発表の再取得はAuth Worker Cronがnext_check_atを基準に行います。
  // ブラウザ側は試合進行を起動せず、保存済み状態の表示だけを担当します。
}

async function resolvePredictionTargetGame(schedule, useServer) {
  void schedule;
  void useServer;
  return null;
}

function buildPredictionTargetApiUrl() {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/prediction-target` : "";
}

function normalizeServerPredictionTarget(target) {
  return {
    ...target,
    startDateTime: target.startAt || `${target.date || ""}T${target.startTime || "00:00"}:00+09:00`,
    matchupLabel: `${target.homeTeam || ""} vs ${target.awayTeam || ""}`
  };
}

async function getLoadedGameSchedule() {
  if (typeof window === "undefined") {
    return [];
  }

  if (window.HAM_GAME_SCHEDULE_READY && typeof window.HAM_GAME_SCHEDULE_READY.then === "function") {
    return (await window.HAM_GAME_SCHEDULE_READY) || [];
  }

  return Array.isArray(window.HAM_GAME_SCHEDULE) ? window.HAM_GAME_SCHEDULE : [];
}

function buildPublicGamesApiUrl() {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/public/games` : "";
}

function mergePublicGameSchedules(staticGames = [], apiGames = []) {
  // Public cards are only allowed to use the canonical games API. Static schedule
  // data can be stale and must not select or label a user-facing prediction game.
  void staticGames;
  return (Array.isArray(apiGames) ? apiGames : [])
    .filter((game) => Boolean(game?.internalGameId) && isNormalManagedSchedule(game))
    .map((game) => ({
      ...game,
      canonical: true,
      gameId: game.internalGameId,
      matchupLabel: game.displayLabel || `${game.homeTeamName || game.homeTeam || ""} vs ${game.awayTeamName || game.awayTeam || ""}`,
      startDateTime: game.startAt || ""
    }))
    .filter((game) => !isScheduleGameUnavailable(game))
    .sort((left, right) => getScheduleSortValue(left).localeCompare(getScheduleSortValue(right)));
}

function getPublicSelectableGames(games = [], now = new Date()) {
  const today = getJapanDateString(now);
  const sorted = (Array.isArray(games) ? games : [])
    .filter((game) => game?.canonical === true && Boolean(game?.internalGameId) && isNormalManagedSchedule(game) && !isScheduleGameUnavailable(game))
    .sort((left, right) => getScheduleSortValue(left).localeCompare(getScheduleSortValue(right)));
  const todayGames = sorted.filter((game) => getScheduleDate(game) === today);
  const futureGames = sorted.filter((game) => getScheduleDate(game) > today).slice(0, 5);
  return [...todayGames, ...futureGames];
}

function selectInitialPublicGame(games = [], now = new Date()) {
  const selectable = getPublicSelectableGames(games, now);
  const today = getJapanDateString(now);
  const todayGames = selectable.filter((game) => getScheduleDate(game) === today);
  const todayUpcoming = todayGames.find((game) => {
    if (isPublicGamePublished(game)) return false;
    const startAt = game?.startAt ? new Date(game.startAt) : parseJstScheduleDateTime(game);
    return Number.isFinite(startAt?.getTime()) && startAt > now;
  });
  const todayOpen = todayGames.find((game) => !isPublicGamePublished(game)
    && resolvePredictionDeadline(game.internalGameId || game.gameId, now).status === "open");
  const nextOpen = selectable.find((game) => getScheduleDate(game) > today
    && !isPublicGamePublished(game)
    && resolvePredictionDeadline(game.internalGameId || game.gameId, now).status === "open");
  return todayUpcoming || todayOpen || nextOpen || null;
}

function formatPublicPredictionGameLabel(game) {
  const date = getScheduleDate(game);
  const time = getScheduleStartTime(game);
  const matchup = game?.displayLabel || game?.matchupLabel || `${game?.homeTeamName || game?.homeTeam || ""} vs ${game?.awayTeamName || game?.awayTeam || ""}`;
  return `${date.replace(/^(\d{4})-/, "$1/").replace(/-/, "/")} ${time} ${matchup}`.trim();
}

function getPublicPredictionGameMetaLines(game) {
  const date = String(getScheduleDate(game) || "").replace(/^(\d{4})-/, "$1/").replace(/-/, "/");
  const time = String(getScheduleStartTime(game) || "");
  const dateTime = `${date} ${time}`.trim();
  const label = formatPublicPredictionGameLabel(game);
  const matchup = label.startsWith(dateTime) ? label.slice(dateTime.length).trim() : label;
  return { dateTime, matchup: matchup || "対戦カード未定" };
}

function setPublicCurrentGame(nextGame) {
  const previousGame = state.predictionTargetGame;
  const previousId = String(state.predictionTargetGameId || previousGame?.internalGameId || "");
  const nextId = String(nextGame?.internalGameId || "");
  const changed = previousId !== nextId;
  const keepPrediction = Boolean(nextId && state.prediction?.gameId && String(state.prediction.gameId) === nextId);
  const keepActual = Boolean(nextId && state.actual?.gameId && String(state.actual.gameId) === nextId);
  const keepResult = Boolean(nextId && state.result?.gameId && String(state.result.gameId) === nextId);

  if (changed) {
    beginPublicRequest("account", { abort: true });
    beginPublicRequest("probable", { abort: true });
    state.predictionRemote = createEmptyPredictionRemoteState();
    if (!keepPrediction) {
      state.prediction = null;
      removeFromStorage(STORAGE_KEYS.prediction);
    }
    if (!keepActual) {
      state.actual = null;
      removeFromStorage(STORAGE_KEYS.actual);
    }
    if (!keepResult) {
      preserveDisplayedPublicResult();
    }
  }

  state.predictionTargetGameId = nextId;
  state.predictionTargetGame = nextGame || null;
  state.probableStarter.nextGame = nextGame || null;
  state.predictionTargetNotice = changed && nextGame ? "予想対象試合が次の試合へ切り替わりました。" : "";
  discardStoredStateForGame(nextId);
  appState.currentGame = nextGame || null;
  appState.predictionForm.gameId = nextId;
  syncPublicAppState();
  return changed;
}

async function initializePublicGameCatalog() {
  const catalog = state.publicGameCatalog;
  const request = beginPublicRequest("catalog", { abort: true });
  catalog.isLoading = true;
  try {
    let apiGames = [];
    const url = buildPublicGamesApiUrl();
    if (url) {
      const { response, payload } = await publicApiClient.get(url, { signal: request.signal });
      if (response.ok && payload?.ok && Array.isArray(payload.games)) {
        apiGames = payload.games;
      }
    }
    if (!isCurrentPublicRequest("catalog", request.id)) return;
    catalog.games = mergePublicGameSchedules([], apiGames);
    catalog.message = "";
    const initialGame = selectInitialPublicGame(catalog.games);
    setPublicCurrentGame(initialGame);
    refreshPredictionDeadlineState();
  } catch (error) {
    if (!isCurrentPublicRequest("catalog", request.id)) return;
    catalog.games = [];
    catalog.message = "試合情報を取得できませんでした。";
    console.warn("公開試合一覧の取得に失敗しました", error.message);
  } finally {
    if (isCurrentPublicRequest("catalog", request.id)) {
      catalog.isLoading = false;
      syncPublicAppState();
      renderPublicGameSelectionMeta();
    }
  }
}

function isPublicGamePublished(game, remoteState = state.predictionRemote) {
  const gameIds = [game?.internalGameId, game?.gameId].filter(Boolean);
  const remoteMatchesGame = Boolean(remoteState?.gameId && gameIds.includes(remoteState.gameId));
  return Boolean(game?.isPublished || game?.publicationStatus === "published" || (remoteMatchesGame && remoteState?.resultsPublished));
}

function buildProbableStarterApiUrl(gameId) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  const game = gameId && typeof gameId === "object" ? gameId : { gameId };
  const internalGameId = String(game?.internalGameId || "").trim();
  if (!baseUrl || !internalGameId) return "";
  // Retired request shape (never sent): /api/probable-starter?gameId=
  return `${baseUrl}/api/probable-starter?internalGameId=${encodeURIComponent(internalGameId)}`;
}

function applyStoredProbableStarter(probableStarter, gameMetadata = {}) {
  const nextGame = state.probableStarter.nextGame;
  const canonicalGame = {
    ...nextGame,
    internalGameId: gameMetadata.internalGameId || probableStarter?.internalGameId || nextGame?.internalGameId || "",
    gameId: gameMetadata.legacyGameId || gameMetadata.gameId || nextGame?.gameId || "",
    date: gameMetadata.gameDate || nextGame?.date || "",
    startAt: gameMetadata.startAt || nextGame?.startAt || "",
    homeTeam: gameMetadata.homeTeam || nextGame?.homeTeam || "",
    awayTeam: gameMetadata.awayTeam || nextGame?.awayTeam || ""
  };
  state.probableStarter.nextGame = canonicalGame;
  state.predictionTargetGame = canonicalGame;
  const status = String(probableStarter?.status || "empty");
  state.probableStarter.fetchedGameId = canonicalGame.gameId || "";
  state.probableStarter.fetchedAt = probableStarter?.fetchedAt || "";
  state.probableStarter.sourceUrl = probableStarter?.sourceUrl || NPB_STARTER_SOURCE_URL;
  state.probableStarter.fetchedGameCount = probableStarter ? 1 : 0;
  state.probableStarter.nextCheckAt = probableStarter?.nextCheckAt || "";
  state.probableStarter.errorCode = probableStarter?.errorCode || "";
  state.probableStarter.dataStatus = probableStarter?.dataStatus || (probableStarter?.partial ? "partial" : status);
  state.probableStarter.referenceDiagnostics = null;
  const hasAnyPitcher = Boolean(String(probableStarter?.homePitcherName || "").trim() || String(probableStarter?.awayPitcherName || "").trim());
  if (!probableStarter || status === "empty" || status === "unannounced" || (status === "announced" && !hasAnyPitcher)) {
    state.probableStarter.status = "unannounced";
    state.probableStarter.message = "予告先発はまだ発表されていません";
    state.probableStarter.matchedGame = null;
    state.probableStarter.games = [];
    return;
  }
  if (status === "error") {
    state.probableStarter.status = "error";
    state.probableStarter.message = "予告先発を取得できませんでした";
    state.probableStarter.matchedGame = null;
    state.probableStarter.games = [];
    return;
  }
  state.probableStarter.status = "success";
  state.probableStarter.message = probableStarter.partial ? "予告先発を一部取得しました" : "予告先発を取得しました";
  state.probableStarter.matchedGame = {
    ...canonicalGame,
    homeStarter: { name: probableStarter.homePitcherName || "" },
    awayStarter: { name: probableStarter.awayPitcherName || "" }
  };
  state.probableStarter.games = [state.probableStarter.matchedGame];
}

function getProbableStarterReferenceDiagnostics(selectedGame, response, httpStatus = 200) {
  const selectedInternalGameId = String(selectedGame?.internalGameId || "").trim();
  const resolvedInternalGameId = String(response?.internalGameId || "").trim();
  const selectedDate = String(selectedGame?.date || "").trim();
  const resolvedDate = String(response?.gameDate || "").trim();
  const selectedHome = normalizeScheduleTeamCode(selectedGame?.homeTeam);
  const selectedAway = normalizeScheduleTeamCode(selectedGame?.awayTeam);
  const resolvedHome = normalizeScheduleTeamCode(response?.homeTeam);
  const resolvedAway = normalizeScheduleTeamCode(response?.awayTeam);
  const selectedStartAt = selectedGame?.startAt ? new Date(selectedGame.startAt) : parseJstScheduleDateTime(selectedGame);
  const resolvedStartAt = response?.startAt ? new Date(response.startAt) : null;
  const startAtMatches = selectedStartAt && !Number.isNaN(selectedStartAt.getTime()) && resolvedStartAt && !Number.isNaN(resolvedStartAt.getTime())
    ? selectedStartAt.getTime() === resolvedStartAt.getTime()
    : true;
  const mismatches = [];
  if (selectedInternalGameId && resolvedInternalGameId !== selectedInternalGameId) mismatches.push("INTERNAL_GAME_ID_MISMATCH");
  if (!resolvedInternalGameId) mismatches.push("INTERNAL_GAME_ID_MISSING");
  if (selectedDate && resolvedDate !== selectedDate) mismatches.push("GAME_DATE_MISMATCH");
  if (!selectedHome || resolvedHome !== selectedHome) mismatches.push("HOME_TEAM_MISMATCH");
  if (!selectedAway || resolvedAway !== selectedAway) mismatches.push("AWAY_TEAM_MISMATCH");
  if (!startAtMatches) mismatches.push("START_AT_MISMATCH");
  return mismatches.length ? {
    code: "GAME_REFERENCE_MISMATCH",
    requestedInternalGameId: selectedInternalGameId,
    resolvedInternalGameId,
    selectedGameDate: selectedDate,
    selectedHome,
    selectedAway,
    apiStatus: Number(httpStatus || 0),
    mismatches
  } : null;
}

async function fetchStoredProbableStarter() {
  const activeRequest = appState.requests.probable;
  if (state.probableStarter.isLoading && !activeRequest?.controller?.signal?.aborted) {
    return;
  }

  if (!state.probableStarter.nextGame) {
    state.probableStarter.status = "noGame";
    state.probableStarter.message = "次の試合を検出できませんでした。";
    renderProbableStarter();
    return;
  }

  const game = state.probableStarter.nextGame;
  const request = beginPublicRequest("probable", { abort: true });
  const url = buildProbableStarterApiUrl(game);
  if (!url) {
    if (!isCurrentPublicRequest("probable", request.id)) return;
    state.probableStarter.status = "error";
    state.probableStarter.message = "予告先発を取得できませんでした";
    renderProbableStarter();
    return;
  }
  state.probableStarter.isLoading = true;
  state.probableStarter.status = "loading";
  state.probableStarter.message = "保存済みの予告先発を確認中...";
  renderProbableStarter();

  try {
    const { response, payload: result } = await publicApiClient.get(url, { credentials: "include", signal: request.signal });
    if (!isCurrentPublicRequest("probable", request.id) || getCurrentGameId() !== game.internalGameId) return;
    if (!response.ok || !result?.ok) {
      state.probableStarter.status = "error";
      state.probableStarter.message = "予告先発を取得できませんでした";
      return;
    }
    const referenceDiagnostics = getProbableStarterReferenceDiagnostics(game, result, response.status);
    if (referenceDiagnostics) {
      state.probableStarter.status = "game_reference_mismatch";
      state.probableStarter.message = "予告先発の試合参照が一致しませんでした";
      state.probableStarter.errorCode = referenceDiagnostics.code;
      state.probableStarter.referenceDiagnostics = referenceDiagnostics;
      console.warn("予告先発の試合参照が一致しませんでした", referenceDiagnostics);
      return;
    }
    applyStoredProbableStarter(result.probableStarter, result);
  } catch (error) {
    if (!isCurrentPublicRequest("probable", request.id)) return;
    state.probableStarter.status = "error";
    state.probableStarter.message = "予告先発を取得できませんでした";
  } finally {
    if (isCurrentPublicRequest("probable", request.id)) {
      state.probableStarter.isLoading = false;
      renderProbableStarter();
    }
  }
}

async function fetchProbableStarter({ force = false } = {}) {
  void force;
  return fetchStoredProbableStarter();
}

function normalizeScheduleTeamCode(value) {
  const key = String(value || "").trim().toLowerCase();
  return ["fighters", "buffaloes", "hawks", "lions", "eagles", "marines", "giants", "tigers", "baystars", "carp", "dragons", "swallows"].includes(key)
    ? key
    : "";
}

function getFightersStarter(game) {
  if (!game) {
    return null;
  }

  if (game.homeTeam === "fighters") {
    return { fighters: game.homeStarter, opponent: game.awayStarter, opponentName: game.awayTeamName };
  }

  if (game.awayTeam === "fighters") {
    return { fighters: game.awayStarter, opponent: game.homeStarter, opponentName: game.homeTeamName };
  }

  return null;
}

function formatScheduledGameForLog(game) {
  if (!game) {
    return "対象なし";
  }

  return `${game.date || "日付不明"} ${game.matchupLabel || `${game.homeTeam || ""} vs ${game.awayTeam || ""}`}`;
}

function handleAuthStateChanged() {
  if (publicAppCoordinator) {
    void publicAppCoordinator.handleAuthStateChanged();
    return;
  }
}

function startPredictionDeadlineTicker() {
  if (predictionDeadlineTimerId) {
    clearInterval(predictionDeadlineTimerId);
  }
  refreshPredictionDeadlineState();
  predictionDeadlineTimerId = setInterval(() => {
    refreshPredictionDeadlineState();
    if (state.publicRoster.status === "baseline" && !hasUsablePublicRosterForCurrentGame()) {
      state.publicRoster.status = "pending";
      state.publicRoster.players = [];
      state.publicRoster.usableUntil = "";
      renderPicker("prediction");
      renderPredictionDeadline();
    }
    void refreshPredictionTarget({ retryUnannounced: false });
  }, PREDICTION_DEADLINE_REFRESH_MS);
}

function getPredictionDeadlineGameId() {
  return getCurrentGameId();
}

function parseJstScheduleDateTime(game) {
  const date = getScheduleDate(game);
  const time = getScheduleStartTime(game);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return null;
  }
  const value = new Date(`${date}T${time}:00+09:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function getPredictionDeadlineMinutesBeforeStart() {
  const configured = Number(window.STARTING9_PREGAME_CONFIG?.predictionDeadlineMinutesBeforeStart);
  return Number.isFinite(configured) && configured > 0 ? configured : 60;
}

function isScheduleGameUnavailable(game) {
  return ["cancelled", "canceled", "postponed"].includes(String(game?.status || "").toLowerCase());
}

function resolvePredictionDeadline(gameId, now = new Date()) {
  const game = state.publicGameCatalog.games.find((item) => item?.gameId === gameId || item?.internalGameId === gameId)
    || (state.predictionTargetGame?.gameId === gameId || state.predictionTargetGame?.internalGameId === gameId ? state.predictionTargetGame : null);
  if (!game) {
    return {
      gameId: gameId || "",
      game: null,
      status: "unavailable",
      message: "試合日程を確認できないため、予想は保存できません。",
      startAt: "",
      deadlineAt: "",
      isClosed: true
    };
  }
  if (isScheduleGameUnavailable(game)) {
    return {
      gameId,
      game,
      status: "unavailable",
      message: "この試合は予想を受け付けていません。",
      startAt: "",
      deadlineAt: "",
      isClosed: true
    };
  }

  const startAt = game.startAt
    ? new Date(game.startAt)
    : parseJstScheduleDateTime(game);
  if (!startAt || Number.isNaN(startAt.getTime())) {
    return {
      gameId,
      game,
      status: "unavailable",
      message: "試合開始時刻を確認できないため、予想は保存できません。",
      startAt: "",
      deadlineAt: "",
      isClosed: true
    };
  }

  const deadlineAt = new Date(startAt.getTime() - getPredictionDeadlineMinutesBeforeStart() * 60 * 1000);
  const isClosed = now.getTime() >= deadlineAt.getTime();
  return {
    gameId,
    game,
    status: isClosed ? "closed" : "open",
    message: isClosed ? "この試合の予想受付は終了しました。" : "予想を受け付けています。",
    startAt: startAt.toISOString(),
    deadlineAt: deadlineAt.toISOString(),
    isClosed
  };
}

function getEffectivePredictionDeadline(deadline = state.predictionDeadline) {
  return deadline;
}

function refreshPredictionDeadlineState() {
  const deadline = resolvePredictionDeadline(getPredictionDeadlineGameId());
  state.predictionDeadline = {
    ...deadline,
    override: state.predictionDeadline.override
  };
  renderPredictionDeadline();
  renderGameDayNoticeStatus();
  renderPicker("prediction");
}

function isPredictionEditingLocked() {
  return getEffectivePredictionDeadline().isClosed;
}

function ensurePredictionEditingAllowed() {
  if (!isPredictionEditingLocked()) return true;
  const deadline = getEffectivePredictionDeadline();
  closeAllPositionMenus();
  showMessage("predictionError", deadline.message || "この試合の予想受付は終了しました。");
  return false;
}

function formatPredictionDeadlineDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function renderPredictionDeadline() {
  const container = document.getElementById("predictionDeadlineStatus");
  const saveButton = document.getElementById("savePredictionButton");
  const resetButton = document.getElementById("resetPredictionButton");
  const deadline = getEffectivePredictionDeadline();
  const deadlineText = formatPredictionDeadlineDateTime(deadline.deadlineAt);

  if (container) {
    const isSoon = deadline.status === "open" && deadline.deadlineAt
      && new Date(deadline.deadlineAt).getTime() - Date.now() <= 2 * 60 * 60 * 1000;
    container.className = `prediction-deadline-status is-${deadline.status}${isSoon ? " is-soon" : ""}`;
    if (deadline.status === "open") {
      container.innerHTML = `
        <div class="deadline-heading"><strong>⏰ 予想締切</strong><time>${escapeHtml(deadlineText)}</time></div>
        <div class="deadline-countdown">
          <span>試合開始まで <strong>${escapeHtml(formatPublicRemainingTime(deadline.startAt))}</strong></span>
          <span>締切まで <strong>${escapeHtml(formatPublicRemainingTime(deadline.deadlineAt))}</strong></span>
        </div>
      `;
    } else {
      container.textContent = deadline.message || "予想の受付状況を確認しています。";
    }
  }
  if (saveButton) saveButton.disabled = Boolean(deadline.isClosed) || !hasUsablePublicRosterForCurrentGame() || state.predictionRemote.isSaving || state.predictionRemote.isSubmitting;
  if (resetButton) resetButton.disabled = Boolean(deadline.isClosed) || state.predictionRemote.isDeleting;
  renderPublicGameSelectionMeta();
}

function getCurrentGameId() {
  return state.predictionTargetGame?.internalGameId || state.probableStarter.nextGame?.internalGameId || "";
}

function getAuthApiBaseUrl() {
  if (typeof window !== "undefined" && window.starting9Auth?.getApiBaseUrl) {
    return window.starting9Auth.getApiBaseUrl();
  }
  // auth.js が環境ごとのURLを一元管理します。
  return "";
}

function buildYearlyRankingApiUrl({ year, qualifiedOnly = false } = {}) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  const url = new URL(`${baseUrl}/api/rankings/yearly`, window.location.href);
  url.searchParams.set("year", String(year));
  url.searchParams.set("limit", String(RANKING_DISPLAY_LIMIT));
  url.searchParams.set("qualifiedOnly", qualifiedOnly ? "true" : "false");
  return url.href;
}

function buildMyYearlyRankingApiUrl({ year } = {}) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  const url = new URL(`${baseUrl}/api/me/ranking/yearly`, window.location.href);
  url.searchParams.set("year", String(year));
  return url.href;
}

function getJapanYearMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month) };
}

function getJapanWeekRange(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const calendarDate = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  const daysSinceMonday = (calendarDate.getUTCDay() + 6) % 7;
  const startDate = new Date(calendarDate);
  startDate.setUTCDate(startDate.getUTCDate() - daysSinceMonday);
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 7);
  const format = (value) => [
    value.getUTCFullYear(),
    String(value.getUTCMonth() + 1).padStart(2, "0"),
    String(value.getUTCDate()).padStart(2, "0")
  ].join("-");
  return { startAt: format(startDate), endAt: format(endDate) };
}

function formatWeeklyRankingDisplayEnd(endExclusive) {
  const endDate = new Date(`${String(endExclusive || "")}T12:00:00Z`);
  if (Number.isNaN(endDate.getTime())) return String(endExclusive || "");
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  return endDate.toISOString().slice(0, 10);
}

function buildMonthlyRankingApiUrl({ year, month, qualifiedOnly = false } = {}) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  const url = new URL(`${baseUrl}/api/rankings/monthly`, window.location.href);
  url.searchParams.set("year", String(year));
  url.searchParams.set("month", String(month));
  url.searchParams.set("limit", String(RANKING_DISPLAY_LIMIT));
  url.searchParams.set("qualifiedOnly", qualifiedOnly ? "true" : "false");
  return url.href;
}

function buildMyMonthlyRankingApiUrl({ year, month } = {}) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  const url = new URL(`${baseUrl}/api/me/ranking/monthly`, window.location.href);
  url.searchParams.set("year", String(year));
  url.searchParams.set("month", String(month));
  return url.href;
}

function buildWeeklyRankingApiUrl({ weekStart, qualifiedOnly = false } = {}) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  const url = new URL(`${baseUrl}/api/rankings/weekly`, window.location.href);
  url.searchParams.set("weekStart", String(weekStart));
  url.searchParams.set("limit", String(RANKING_DISPLAY_LIMIT));
  url.searchParams.set("qualifiedOnly", qualifiedOnly ? "true" : "false");
  return url.href;
}

function buildMyWeeklyRankingApiUrl({ weekStart } = {}) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  const url = new URL(`${baseUrl}/api/me/ranking/weekly`, window.location.href);
  url.searchParams.set("weekStart", String(weekStart));
  return url.href;
}

function buildDailyBestNineApiUrl(gameId = "") {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  const reference = String(gameId || "").trim();
  if (!baseUrl || !reference) return "";
  const url = new URL(`${baseUrl}/api/results/daily-best-nine`, window.location.href);
  if (state.resultHistory.result?.internalGameId) {
    url.searchParams.set("internalGameId", reference);
  } else {
    url.searchParams.set("gameId", reference);
  }
  return url.href;
}

function getDailyBestNineGameId() {
  const result = state.resultHistory.result;
  return String(result?.internalGameId || result?.gameId || state.resultHistory.selectedGameId || "").trim();
}

function resetDailyBestNine(status = "idle") {
  state.dailyBestNine = {
    isLoading: false,
    requestId: state.dailyBestNine?.requestId || 0,
    gameId: "",
    status,
    rows: [],
    totalCount: 0,
    message: ""
  };
}

async function initializeDailyBestNine() {
  await fetchDailyBestNine({ force: true });
}

async function fetchDailyBestNine({ gameId = "", force = false } = {}) {
  const dailyState = state.dailyBestNine;
  const reference = String(gameId || getDailyBestNineGameId()).trim();
  if (!reference) {
    resetDailyBestNine();
    renderDailyBestNine();
    return;
  }
  if (dailyState.isLoading && !force && dailyState.gameId === reference) return;

  const url = buildDailyBestNineApiUrl(reference);
  if (!url) {
    resetDailyBestNine("error");
    state.dailyBestNine.message = "今日のベストナインを取得できませんでした。";
    renderDailyBestNine();
    return;
  }

  const requestId = dailyState.requestId + 1;
  dailyState.requestId = requestId;
  dailyState.gameId = reference;
  dailyState.isLoading = true;
  dailyState.status = "loading";
  dailyState.rows = [];
  dailyState.totalCount = 0;
  dailyState.message = "";
  renderDailyBestNine();

  try {
    const { response, payload } = await publicApiClient.get(url, {
      cache: force ? "no-store" : "default"
    });
    if (!response.ok || !payload?.ok || !Array.isArray(payload.bestNine)) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    if (requestId !== dailyState.requestId) return;
    dailyState.status = payload.published ? "published" : "unpublished";
    dailyState.rows = payload.bestNine;
    dailyState.totalCount = Math.max(0, Number(payload.totalCount || payload.bestNine.length));
  } catch (error) {
    if (requestId !== dailyState.requestId) return;
    console.error("今日のベストナインの取得に失敗しました", error.message);
    dailyState.status = "error";
    dailyState.rows = [];
    dailyState.totalCount = 0;
    dailyState.message = "今日のベストナインを取得できませんでした。";
  } finally {
    if (requestId === dailyState.requestId) {
      dailyState.isLoading = false;
      renderDailyBestNine();
    }
  }
}

async function refreshYearlyRanking({ force = false } = {}) {
  const ranking = state.yearlyRanking;
  if (ranking.isLoading && !force) return;
  const period = { year: ranking.year };
  const publicUrl = buildYearlyRankingApiUrl({ ...period, qualifiedOnly: false });
  if (!publicUrl) {
    ranking.message = "ランキングの接続先を確認できません。";
    renderRankingPanel();
    return;
  }

  const user = getPredictionAccountUser();
  const requestId = ranking.requestId + 1;
  ranking.requestId = requestId;
  ranking.isLoading = true;
  ranking.isLoadingSelf = Boolean(user);
  ranking.message = "";
  if (!user) ranking.self = null;
  renderRankingPanel();

  try {
    const publicRequest = publicApiClient.request(publicUrl, { credentials: "include", cache: force ? "no-store" : "default" })
      .then(({ response, payload }) => {
        if (!response.ok || !Array.isArray(payload?.ranking)) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        return payload;
      });
    const selfRequest = user ? publicApiClient.get(buildMyYearlyRankingApiUrl(period), { credentials: "include" })
      .then(({ response, payload }) => {
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        return payload.rankingData || null;
      })
      .catch((error) => {
        console.error("自分の年間成績の取得に失敗しました", error.message);
        return null;
      }) : Promise.resolve(null);
    const [publicPayload, self] = await Promise.all([publicRequest, selfRequest]);
    if (requestId !== ranking.requestId || ranking.year !== period.year) return;
    ranking.rows = publicPayload.ranking;
    ranking.summary = publicPayload.summary || null;
    ranking.pagination = publicPayload.pagination || null;
    ranking.self = self;
  } catch (error) {
    if (requestId !== ranking.requestId) return;
    console.error("年間ランキングの取得に失敗しました", error.message);
    ranking.rows = [];
    ranking.summary = null;
    ranking.pagination = null;
    ranking.self = null;
    ranking.message = "ランキングの取得に失敗しました。";
  } finally {
    if (requestId === ranking.requestId) {
      ranking.isLoading = false;
      ranking.isLoadingSelf = false;
      renderRankingPanel();
    }
  }
}

async function refreshMonthlyRanking({ force = false } = {}) {
  const ranking = state.monthlyRanking;
  if (ranking.isLoading && !force) return;
  const period = { year: ranking.year, month: ranking.month };
  const publicUrl = buildMonthlyRankingApiUrl({ ...period, qualifiedOnly: false });
  if (!publicUrl) {
    ranking.message = "ランキングの接続先を確認できません。";
    renderRankingPanel();
    return;
  }

  const user = getPredictionAccountUser();
  const requestId = ranking.requestId + 1;
  ranking.requestId = requestId;
  ranking.isLoading = true;
  ranking.isLoadingSelf = Boolean(user);
  ranking.message = "";
  if (!user) ranking.self = null;
  renderRankingPanel();

  try {
    const publicRequest = publicApiClient.request(publicUrl, { credentials: "include", cache: force ? "no-store" : "default" })
      .then(({ response, payload }) => {
        if (!response.ok || !Array.isArray(payload?.ranking)) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        return payload;
      });
    const selfRequest = user ? publicApiClient.get(buildMyMonthlyRankingApiUrl(period), { credentials: "include" })
      .then(({ response, payload }) => {
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        return payload.rankingData || null;
      })
      .catch((error) => {
        console.error("自分の月間成績の取得に失敗しました", error.message);
        return null;
      }) : Promise.resolve(null);
    const [publicPayload, self] = await Promise.all([publicRequest, selfRequest]);
    if (requestId !== ranking.requestId || ranking.year !== period.year || ranking.month !== period.month) return;
    ranking.rows = publicPayload.ranking;
    ranking.summary = publicPayload.summary || null;
    ranking.pagination = publicPayload.pagination || null;
    ranking.self = self;
  } catch (error) {
    if (requestId !== ranking.requestId) return;
    console.error("月間ランキングの取得に失敗しました", error.message);
    ranking.rows = [];
    ranking.summary = null;
    ranking.pagination = null;
    ranking.self = null;
    ranking.message = "月間ランキングの取得に失敗しました。";
  } finally {
    if (requestId === ranking.requestId) {
      ranking.isLoading = false;
      ranking.isLoadingSelf = false;
      renderRankingPanel();
    }
  }
}

async function refreshWeeklyRanking({ force = false } = {}) {
  const ranking = state.weeklyRanking;
  if (ranking.isLoading && !force) return;
  const period = { weekStart: ranking.weekStart };
  const publicUrl = buildWeeklyRankingApiUrl({ ...period, qualifiedOnly: false });
  if (!publicUrl) {
    ranking.message = "ランキングの接続先を確認できません。";
    renderRankingPanel();
    return;
  }

  const user = getPredictionAccountUser();
  const requestId = ranking.requestId + 1;
  ranking.requestId = requestId;
  ranking.isLoading = true;
  ranking.isLoadingSelf = Boolean(user);
  ranking.message = "";
  if (!user) ranking.self = null;
  renderRankingPanel();

  try {
    const publicRequest = publicApiClient.request(publicUrl, { credentials: "include", cache: force ? "no-store" : "default" })
      .then(({ response, payload }) => {
        if (!response.ok || !Array.isArray(payload?.ranking)) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        return payload;
      });
    const selfRequest = user ? publicApiClient.get(buildMyWeeklyRankingApiUrl(period), { credentials: "include" })
      .then(({ response, payload }) => {
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        return payload.rankingData || null;
      })
      .catch((error) => {
        console.error("自分の週間成績の取得に失敗しました", error.message);
        return null;
      }) : Promise.resolve(null);
    const [publicPayload, self] = await Promise.all([publicRequest, selfRequest]);
    if (requestId !== ranking.requestId || ranking.weekStart !== period.weekStart) return;
    ranking.rows = publicPayload.ranking;
    ranking.summary = publicPayload.summary || null;
    ranking.pagination = publicPayload.pagination || null;
    ranking.self = self;
  } catch (error) {
    if (requestId !== ranking.requestId) return;
    console.error("週間ランキングの取得に失敗しました", error.message);
    ranking.rows = [];
    ranking.summary = null;
    ranking.pagination = null;
    ranking.self = null;
    ranking.message = "週間ランキングの取得に失敗しました。";
  } finally {
    if (requestId === ranking.requestId) {
      ranking.isLoading = false;
      ranking.isLoadingSelf = false;
      renderRankingPanel();
    }
  }
}

function selectRankingView(view) {
  if (!["yearly", "monthly", "weekly"].includes(view)) return;
  state.rankingView = view;
  renderRankingPanel();
  if (view === "yearly") {
    void refreshYearlyRanking({ force: true });
  } else if (view === "monthly") {
    void refreshMonthlyRanking({ force: true });
  } else {
    void refreshWeeklyRanking({ force: true });
  }
}

function handleRankingPeriodContentClick(event) {
  const yearlyButton = event.target.closest("[data-yearly-ranking-move]");
  if (yearlyButton && !yearlyButton.disabled) {
    const direction = Number(yearlyButton.dataset.yearlyRankingMove);
    if (Number.isInteger(direction) && direction !== 0) {
      const ranking = state.yearlyRanking;
      const nextYear = ranking.year + direction;
      const currentYear = getJapanYearMonth().year;
      if (nextYear >= RANKING_SERVICE_START_YEAR && nextYear <= currentYear) {
        ranking.year = nextYear;
        ranking.self = null;
        void refreshYearlyRanking({ force: true });
      }
    }
    return;
  }
  const weeklyButton = event.target.closest("[data-weekly-ranking-move]");
  if (weeklyButton && !weeklyButton.disabled) {
    const weeklyDirection = Number(weeklyButton.dataset.weeklyRankingMove);
    if (!Number.isInteger(weeklyDirection) || weeklyDirection === 0) return;
    const weekly = state.weeklyRanking;
    const candidateWeek = new Date(`${weekly.weekStart}T12:00:00+09:00`);
    candidateWeek.setUTCDate(candidateWeek.getUTCDate() + weeklyDirection * 7);
    const nextWeek = getJapanWeekRange(candidateWeek).startAt;
    const currentWeek = getJapanWeekRange();
    const firstServiceWeek = getJapanWeekRange(new Date(`${RANKING_SERVICE_START_YEAR}-01-01T12:00:00+09:00`)).startAt;
    if (nextWeek < firstServiceWeek || nextWeek > currentWeek.startAt) return;
    weekly.weekStart = nextWeek;
    weekly.self = null;
    void refreshWeeklyRanking({ force: true });
    return;
  }
  const button = event.target.closest("[data-monthly-ranking-move]");
  if (!button || button.disabled) return;
  const direction = Number(button.dataset.monthlyRankingMove);
  if (!Number.isInteger(direction) || direction === 0) return;
  const current = state.monthlyRanking;
  const candidate = new Date(Date.UTC(current.year, current.month - 1 + direction, 1));
  const next = { year: candidate.getUTCFullYear(), month: candidate.getUTCMonth() + 1 };
  const present = getJapanYearMonth();
  if (next.year < MONTHLY_RANKING_MIN_YEAR || next.year > present.year || (next.year === present.year && next.month > present.month)) {
    return;
  }
  current.year = next.year;
  current.month = next.month;
  current.self = null;
  void refreshMonthlyRanking({ force: true });
}

function renderRankingPanel() {
  const panel = document.getElementById("rankingPanel");
  const container = document.getElementById("rankingContent");
  if (!panel || !container) return;

  if (state.rankingView === "monthly") {
    renderMonthlyRanking();
    return;
  }
  if (state.rankingView === "weekly") {
    renderWeeklyRanking();
    return;
  }

  renderRankingHeading("yearly");
  const ranking = state.yearlyRanking;
  const currentYear = getJapanYearMonth().year;
  const canMoveToPreviousYear = ranking.year > RANKING_SERVICE_START_YEAR;
  const canMoveToNextYear = ranking.year < currentYear;
  const periodControls = `<div class="ranking-month-controls" aria-label="年間ランキングの対象年">
    ${canMoveToPreviousYear ? '<button class="compact-button" type="button" data-yearly-ranking-move="-1">前年</button>' : '<span aria-hidden="true"></span>'}
    <strong>${escapeHtml(ranking.year)}年</strong>
    ${canMoveToNextYear ? '<button class="compact-button" type="button" data-yearly-ranking-move="1">翌年</button>' : '<span aria-hidden="true"></span>'}
  </div>`;
  renderRankingContent(ranking, {
    selfTitle: "あなたの年間成績",
    emptyMessage: "この年のランキング対象試合はありません。",
    prefixHtml: periodControls
  });
}

function renderMonthlyRanking() {
  renderRankingHeading("monthly");
  const ranking = state.monthlyRanking;
  const current = getJapanYearMonth();
  const isCurrentMonth = ranking.year === current.year && ranking.month === current.month;
  const periodControls = `<div class="ranking-month-controls" aria-label="月間ランキングの対象月">
    <button class="compact-button" type="button" data-monthly-ranking-move="-1">前月</button>
    <strong>${escapeHtml(ranking.year)}年${escapeHtml(ranking.month)}月</strong>
    <button class="compact-button" type="button" data-monthly-ranking-move="1"${isCurrentMonth ? " disabled" : ""}>次月</button>
  </div>`;
  renderRankingContent(ranking, {
    selfTitle: "あなたの月間成績",
    emptyMessage: "この月のランキング対象試合はありません。",
    prefixHtml: periodControls
  });
}

function renderWeeklyRanking() {
  renderRankingHeading("weekly");
  const ranking = state.weeklyRanking;
  const current = getJapanWeekRange();
  const isCurrentWeek = ranking.weekStart === current.startAt;
  const weekRange = getJapanWeekRange(new Date(`${ranking.weekStart}T12:00:00+09:00`));
  const weekEnd = formatWeeklyRankingDisplayEnd(weekRange.endAt);
  const firstServiceWeek = getJapanWeekRange(new Date(`${RANKING_SERVICE_START_YEAR}-01-01T12:00:00+09:00`)).startAt;
  const periodControls = `<div class="ranking-month-controls" aria-label="週間ランキングの対象週">
    ${ranking.weekStart > firstServiceWeek ? '<button class="compact-button" type="button" data-weekly-ranking-move="-1">前週</button>' : '<span aria-hidden="true"></span>'}
    <strong>${escapeHtml(ranking.weekStart)}〜${escapeHtml(weekEnd)}</strong>
    ${isCurrentWeek ? '<span aria-hidden="true"></span>' : '<button class="compact-button" type="button" data-weekly-ranking-move="1">次週</button>'}
  </div>`;
  renderRankingContent(ranking, {
    selfTitle: "あなたの週間成績",
    emptyMessage: "今週はまだ公開済み試合がありません。",
    prefixHtml: periodControls
  });
}

function renderRankingHeading(view) {
  return publicRankingRenderer.renderHeading(view);
}

const RANKING_DISPLAY_OPTIONS = Object.freeze({ hideIneligibleRankings: false });

function filterRankingRowsForDisplay(rows, { hideIneligibleRankings = RANKING_DISPLAY_OPTIONS.hideIneligibleRankings } = {}) {
  return publicRankingRenderer.filterRows(rows, { hideIneligibleRankings });
}

function renderRankingContent(ranking, { selfTitle, emptyMessage, prefixHtml = "" }) {
  return publicRankingRenderer.renderContent(ranking, {
    selfTitle,
    emptyMessage,
    prefixHtml,
    hideIneligibleRankings: RANKING_DISPLAY_OPTIONS.hideIneligibleRankings
  });
}

function renderMyRanking(ranking, row, title) {
  return publicRankingRenderer.renderMyRanking(ranking, row, title);
}

function createRankingCardHtml(row, { reference = false } = {}) {
  return publicRankingRenderer.createCardHtml(row, { reference });
}

function formatRankingQualification(row, { reference = false } = {}) {
  return publicRankingRenderer.formatQualification(row, { reference });
}

function createRankingAchievementBadgesHtml(row) {
  const achievements = Array.isArray(row.achievements) ? row.achievements : [];
  if (!achievements.length) return "";
  const badges = achievements.map((achievement) => {
    const rarity = ACHIEVEMENT_RARITY_LABELS[achievement.rarity] || ACHIEVEMENT_RARITY_LABELS.common;
    return `<span class="ranking-achievement-badge is-${escapeHtml(achievement.rarity || "common")}">${escapeHtml(rarity)} ${escapeHtml(achievement.name)}</span>`;
  });
  const hiddenCount = Math.max(0, Number(row.achievementCount || achievements.length) - achievements.length);
  if (hiddenCount > 0) badges.push(`<span class="ranking-achievement-more">+${hiddenCount}</span>`);
  return `<span class="ranking-achievements">${badges.join("")}</span>`;
}

function formatRankingScore(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric.toFixed(1) : "0.0";
}

function formatParticipationRate(value) {
  const numeric = Number(value || 0) * 100;
  return Number.isFinite(numeric) ? `${numeric.toFixed(1)}%` : "0.0%";
}

async function initializePredictionRemoteSync() {
  await syncPredictionFromAccount({ force: true });
}

function buildResultGamesApiUrl(gameId = "") {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  return gameId
    ? `${baseUrl}/api/results/games/${encodeURIComponent(gameId)}`
    : `${baseUrl}/api/results/games`;
}

function getResultHistoryGameId(game) {
  return String(game?.resultId || game?.internalGameId || game?.gameId || "");
}

function formatResultHistoryTeamName(value) {
  const labels = {
    fighters: "日本ハム",
    hawks: "ソフトバンク",
    buffaloes: "オリックス",
    marines: "ロッテ",
    eagles: "楽天",
    lions: "西武",
    giants: "巨人",
    tigers: "阪神",
    baystars: "DeNA",
    carp: "広島",
    dragons: "中日",
    swallows: "ヤクルト"
  };
  const normalized = String(value || "").trim().toLowerCase();
  return labels[normalized] || String(value || "").trim() || "対戦相手";
}

function formatResultHistoryMatchup(game) {
  const home = formatResultHistoryTeamName(game?.homeTeam);
  const away = formatResultHistoryTeamName(game?.awayTeam);
  return home && away ? `${home} vs ${away}` : "対戦情報を確認中";
}

async function refreshResultHistory({ force = false } = {}) {
  const user = getPredictionAccountUser();
  if (!user) {
    beginPublicRequest("result", { abort: true });
    beginPublicRequest("resultDetail", { abort: true });
    state.resultHistory = { isLoading: false, isDetailLoading: false, games: [], selectedGameId: "", isExpanded: false, result: null, message: "ログインすると過去の試合結果を確認できます。", detailError: "" };
    resetDailyBestNine();
    syncPublicAppState();
    renderResultHistory();
    return;
  }
  if (state.resultHistory.isLoading || (!force && state.resultHistory.games.length > 0)) return;
  const request = beginPublicRequest("result", { abort: true });
  beginPublicRequest("resultDetail", { abort: true });
  const url = buildResultGamesApiUrl();
  if (!url) return;
  state.resultHistory.isLoading = true;
  state.resultHistory.detailError = "";
  state.resultHistory.message = "過去の試合結果を確認中...";
  renderResultHistory();
  try {
    const { response, payload } = await publicApiClient.get(url, { credentials: "include", signal: request.signal });
    if (!response.ok || !payload?.ok || !Array.isArray(payload.games)) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    if (!isCurrentPublicRequest("result", request.id)) return;
    state.resultHistory.games = publicResultsRenderer.limitHistory(payload.games);
    state.resultHistory.message = state.resultHistory.games.length ? "" : "採点済みの過去試合はありません。";
    const latestPublishedGame = state.resultHistory.games.find((game) => game?.resultsPublished && getResultHistoryGameId(game));
    if (!state.resultHistory.selectedGameId && latestPublishedGame) {
      await loadResultHistoryGame(getResultHistoryGameId(latestPublishedGame));
    } else if (!latestPublishedGame && !state.resultHistory.selectedGameId) {
      state.resultHistory.result = null;
      resetDailyBestNine("unpublished");
    }
  } catch (error) {
    if (!isCurrentPublicRequest("result", request.id)) return;
    state.resultHistory.games = [];
    state.resultHistory.message = "過去の試合結果を取得できませんでした。";
    console.error("過去の試合結果の取得に失敗しました", error.message);
  } finally {
    if (isCurrentPublicRequest("result", request.id)) {
      state.resultHistory.isLoading = false;
      syncPublicAppState();
      renderResultHistory();
    }
  }
}

async function handleResultHistoryClick(event) {
  const toggle = event.target instanceof Element ? event.target.closest("[data-result-history-toggle]") : null;
  if (toggle) {
    state.resultHistory.isExpanded = !state.resultHistory.isExpanded;
    renderResultHistory();
    return;
  }
  const target = event.target instanceof Element ? event.target.closest("[data-result-game-id]") : null;
  if (!target) return;
  const gameId = target.dataset.resultGameId;
  if (!gameId) return;
  await loadResultHistoryGame(gameId);
}

async function handleResultHistoryChange(event) {
  const select = event.target instanceof HTMLSelectElement
    ? event.target.closest("[data-result-history-select]")
    : null;
  if (!select?.value) return;
  await loadResultHistoryGame(select.value);
}

async function loadResultHistoryGame(gameId) {
  const request = beginPublicRequest("resultDetail", { abort: true });
  state.resultHistory.selectedGameId = gameId;
  state.resultHistory.result = null;
  state.resultHistory.isDetailLoading = true;
  state.resultHistory.detailError = "";
  state.resultHistory.message = "試合結果を読み込み中...";
  renderScoreResult();
  renderResultHistory();
  try {
    const { response, payload } = await publicApiClient.get(buildResultGamesApiUrl(gameId), { credentials: "include", signal: request.signal });
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    if (!isCurrentPublicRequest("resultDetail", request.id)) return;
    if (payload.serviceUnavailable) {
      state.resultHistory.result = {
        gameId,
        internalGameId: "",
        serviceUnavailable: true,
        serviceUnavailableMessage: payload.serviceUnavailableMessage || "この試合はサービス未稼働のため集計対象外です。",
        prediction: payload.prediction || null,
        savedAt: payload.updatedAt || payload.submittedAt || ""
      };
      state.result = state.resultHistory.result;
      state.resultHistory.message = "";
      resetDailyBestNine("unpublished");
      renderScoreResult();
      renderResultHistory();
      return;
    }
    if (!payload.resultsPublished) {
      state.result = null;
      resetDailyBestNine("unpublished");
      state.resultHistory.message = "この試合の結果はまだ公開されていません。";
      renderResultHistory();
      return;
    }
    if (!payload.prediction || !Array.isArray(payload.actualLineup)) {
      throw new Error("結果データが不足しています。");
    }
    const prediction = remotePredictionToLocal({ lineup: payload.prediction.lineup }, payload.updatedAt || payload.submittedAt, gameId);
    const actual = remotePredictionToLocal({ lineup: payload.actualLineup }, payload.scoredAt || "", gameId);
    state.resultHistory.result = {
      ...scoreLineup(prediction.lineup, actual.lineup),
      gameId: payload.internalGameId || payload.gameId || gameId,
      internalGameId: payload.internalGameId || "",
      publishedAt: payload.publishedAt || "",
      totalScore: payload.totalScore ?? payload.score ?? null
    };
    state.result = state.resultHistory.result;
    state.resultHistory.message = "";
    await fetchDailyBestNine({ gameId: payload.internalGameId || payload.gameId || gameId, force: true });
    renderScoreResult();
  } catch (error) {
    if (!isCurrentPublicRequest("resultDetail", request.id)) return;
    state.result = null;
    state.resultHistory.result = null;
    resetDailyBestNine("error");
    state.resultHistory.detailError = "結果を読み込めませんでした。時間をおいて再度お試しください。";
    state.resultHistory.message = "この試合の結果を取得できませんでした。";
    console.error("過去の試合結果の読み込みに失敗しました", error.message);
  } finally {
    if (isCurrentPublicRequest("resultDetail", request.id)) {
      state.resultHistory.isDetailLoading = false;
      syncPublicAppState();
    }
  }
  renderScoreResult();
  renderResultHistory();
}

function renderResultHistory() {
  const container = document.getElementById("resultHistoryList");
  if (!container) return;
  const history = state.resultHistory;
  if (history.isLoading) {
    container.innerHTML = `<p class="result-history-message">${escapeHtml(history.message || "読み込み中...")}</p>`;
    renderPublicPredictionSurface(state.predictionTargetGame, getPublicGameStatusView(state.predictionTargetGame, getEffectivePredictionDeadline()));
    return;
  }
  if (!history.games.length) {
    container.innerHTML = `<p class="result-history-message">${escapeHtml(history.message || "表示できる保存済み予想はありません。")}</p>`;
    renderPublicPredictionSurface(state.predictionTargetGame, getPublicGameStatusView(state.predictionTargetGame, getEffectivePredictionDeadline()));
    return;
  }
  const options = history.games.map((game) => {
    const gameId = getResultHistoryGameId(game);
    const matchup = formatResultHistoryMatchup(game);
    return `<option value="${escapeHtml(gameId)}"${gameId === history.selectedGameId ? " selected" : ""}>${escapeHtml(game.gameDate || game.date || "日付不明")} ${escapeHtml(matchup)}${game.startTime ? `（${escapeHtml(game.startTime)}）` : ""}</option>`;
  }).join("");
  const selectedGame = history.games.find((game) => getResultHistoryGameId(game) === history.selectedGameId);
  const selectedLabel = selectedGame
    ? `${selectedGame.gameDate || selectedGame.date || "日付不明"} ${formatResultHistoryMatchup(selectedGame)}`
    : "";
  container.innerHTML = `<div class="result-history-controls">
      <button type="button" class="secondary-button result-history-toggle" data-result-history-toggle aria-expanded="${history.isExpanded ? "true" : "false"}">${history.isExpanded ? "閉じる" : "過去の成績を見る"}</button>
      ${history.isExpanded ? `<label class="result-history-select-label" for="resultHistorySelect">試合を選択<select id="resultHistorySelect" data-result-history-select><option value="">試合を選択</option>${options}</select></label>` : ""}
    </div>
    ${history.isExpanded && selectedLabel ? `<p class="result-selected-game">選択中：${escapeHtml(selectedLabel)}</p>` : ""}
    ${history.message ? `<p class="result-history-message" role="status">${escapeHtml(history.message)}</p>` : ""}`;
  renderPublicPredictionSurface(state.predictionTargetGame, getPublicGameStatusView(state.predictionTargetGame, getEffectivePredictionDeadline()));
}

function buildCurrentPredictionApiUrl(gameId) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl || !gameId) {
    return "";
  }
  const url = new URL(`${baseUrl}/api/predictions/current`, window.location.href);
  url.searchParams.set("internalGameId", gameId);
  return url.href;
}

function getPredictionAccountUser() {
  return window.starting9Auth?.getUser?.() || null;
}

function getPredictionAccountSaveErrorMessage(error) {
  const code = String(error?.code || "");
  const status = Number(error?.status || 0);
  if (code === "SESSION_EXPIRED" || code === "AUTH_SESSION_EXPIRED") {
    return "端末には保存しました。ログイン状態が切れているため、再ログインしてください。";
  }
  if (code === "AUTH_REQUIRED" || status === 401) {
    return "端末には保存しました。ログインするとアカウントにも保存できます。";
  }
  if (code === "PREDICTION_DEADLINE_PASSED" || code === "PREDICTION_CLOSED" || status === 409 && /受付|締切/.test(String(error?.message || ""))) {
    return "予想受付は終了しました。";
  }
  if (code === "INVALID_GAME_ID" || code === "INTERNAL_GAME_ID_REQUIRED" || code === "GAME_SCHEDULE_NOT_FOUND" || code === "GAME_ID_RESOLUTION_FAILED") {
    return "対象試合を確認できないため、アカウント保存できませんでした。";
  }
  if (code === "PREDICTION_SAVE_FAILED" || status >= 500) {
    return "端末には保存しましたが、アカウント保存に失敗しました。時間をおいて再試行してください。";
  }
  return "端末には保存しましたが、アカウント保存に失敗しました。";
}

async function syncPredictionFromAccount({ force = false } = {}) {
  const user = getPredictionAccountUser();
  if (!user) {
    beginPublicRequest("account", { abort: true });
    state.predictionRemote = createEmptyPredictionRemoteState();
    syncPublicAppState();
    renderPredictionAccountStatus();
    return;
  }

  const gameId = getCurrentGameId();
  const remoteState = state.predictionRemote;
  if (!gameId) {
    beginPublicRequest("account", { abort: true });
    remoteState.status = "noGame";
    remoteState.message = "対象試合が決まるとアカウントの予想を確認できます。";
    renderPredictionAccountStatus();
    return;
  }
  if (remoteState.isLoading || remoteState.isSaving || remoteState.isSubmitting || (!force && remoteState.gameId === gameId)) {
    return;
  }

  const request = beginPublicRequest("account", { abort: true });

  const url = buildCurrentPredictionApiUrl(gameId);
  if (!url) {
    remoteState.status = "unavailable";
    remoteState.gameId = gameId;
    remoteState.message = "認証APIが未設定のため、予想はこの端末に保存されます。";
    renderPredictionAccountStatus();
    return;
  }

  remoteState.isLoading = true;
  remoteState.status = "loading";
  if (remoteState.gameId !== gameId) {
    remoteState.prediction = null;
    remoteState.submittedAt = "";
    remoteState.updatedAt = "";
    remoteState.locked = false;
    remoteState.conflict = false;
    remoteState.score = null;
    remoteState.maxScore = null;
    remoteState.scoredAt = "";
    remoteState.resultsPublished = false;
  }
  remoteState.gameId = gameId;
  remoteState.message = "アカウントの予想を確認中...";
  renderPredictionAccountStatus();

  try {
    const { response, payload } = await publicApiClient.get(url, { credentials: "include", signal: request.signal });
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    if (!isCurrentPublicRequest("account", request.id) || getCurrentGameId() !== gameId) return;

    remoteState.status = "success";
    remoteState.message = "";
    remoteState.prediction = payload.prediction ? remotePredictionToLocal(payload.prediction, payload.updatedAt || payload.submittedAt, gameId) : null;
    remoteState.submittedAt = payload.submittedAt || "";
    remoteState.updatedAt = payload.updatedAt || "";
    remoteState.locked = Boolean(payload.locked);
    remoteState.score = Number.isFinite(payload.score) ? Number(payload.score) : null;
    remoteState.maxScore = Number.isFinite(payload.maxScore) ? Number(payload.maxScore) : null;
    remoteState.scoredAt = payload.scoredAt || "";
    remoteState.resultsPublished = Boolean(payload.resultsPublished);
    remoteState.conflict = Boolean(remoteState.prediction && state.prediction && !predictionsMatch(remoteState.prediction, state.prediction));
    if (remoteState.prediction && !state.prediction) {
      state.prediction = { ...remoteState.prediction, lineup: normalizeLineup(remoteState.prediction.lineup) };
      saveToStorage(STORAGE_KEYS.prediction, state.prediction);
      preserveDisplayedPublicResult();
      renderSavedPrediction();
      renderPredictionCta();
      renderPicker("prediction");
    }
    if (remoteState.prediction && Array.isArray(payload.actualLineup) && payload.status === "scored") {
      const actual = remotePredictionToLocal({ lineup: payload.actualLineup }, payload.scoredAt || "", gameId);
      state.result = { ...scoreLineup(remoteState.prediction.lineup, actual.lineup), gameId };
      saveToStorage(STORAGE_KEYS.result, state.result);
      renderScoreResult();
    }
  } catch (error) {
    if (!isCurrentPublicRequest("account", request.id)) return;
    console.error("アカウント予想の取得に失敗しました", error.message);
    remoteState.status = "error";
    remoteState.message = "アカウントの予想を取得できませんでした。端末の予想はそのまま利用できます。";
    remoteState.prediction = null;
    remoteState.conflict = false;
  } finally {
    if (isCurrentPublicRequest("account", request.id)) {
      remoteState.isLoading = false;
      syncPublicAppState();
      renderPredictionAccountStatus();
    }
  }
}

function createEmptyPredictionRemoteState() {
  return {
    isLoading: false,
    isSaving: false,
    isSubmitting: false,
    isDeleting: false,
    status: "idle",
    message: "",
    gameId: "",
    prediction: null,
    submittedAt: "",
    updatedAt: "",
    locked: false,
    conflict: false,
    score: null,
    maxScore: null,
    scoredAt: "",
    resultsPublished: false
  };
}

function createPlayerId(teamCode, uniformNumber) {
  const teamId = TEAM_PLAYER_ID_PREFIXES[teamCode];
  if (!teamId || typeof uniformNumber !== "string" || !/^\d{1,3}$/.test(uniformNumber)) {
    return "";
  }

  return `${teamId}-${uniformNumber}`;
}

function getUniquePlayerData(playerName) {
  const playerKey = normalizePlayerKey(playerName);
  const matchedPlayers = players.filter((player) => normalizePlayerKey(player.name) === playerKey);
  return matchedPlayers.length === 1 ? matchedPlayers[0] : null;
}

function createPredictionPayload(prediction) {
  const lineup = normalizeLineup(prediction?.lineup || []);
  const serializedLineup = [];

  for (const item of lineup) {
    const player = getUniquePlayerData(item.player);
    const teamCode = player?.teamCode || DEFAULT_PLAYER_TEAM_CODE;
    const uniformNumber = player?.uniformNumber;
    const teamId = TEAM_PLAYER_ID_PREFIXES[teamCode];
    const playerId = createPlayerId(teamCode, uniformNumber);

    // 古いlocalStorageの予想も、マスタ上で一意に一致する場合だけ補完します。
    if (!player || !teamId || !playerId) {
      return {
        ok: false,
        error: `「${item.player || "未選択"}」の選手IDを確認できません。選手を選び直してから保存してください。`
      };
    }

    serializedLineup.push({
      playerId,
      teamId,
      teamCode,
      uniformNumber,
      playerName: player.name,
      battingOrder: Number(item.order),
      position: item.position
    });
  }

  return {
    ok: true,
    prediction: {
      schemaVersion: 1,
      lineup: serializedLineup
    }
  };
}

function remotePredictionToLocal(prediction, savedAt = "", gameId = "") {
  const lineup = Array.isArray(prediction?.lineup)
    ? prediction.lineup.map((item) => ({
      order: Number(item.battingOrder ?? item.order),
      player: String(item.playerName ?? item.player ?? "").trim(),
      position: normalizePosition(item.position)
    }))
    : [];
  return {
    gameId,
    lineup: normalizeLineup(lineup),
    savedAt: savedAt || new Date().toISOString()
  };
}

function predictionsMatch(left, right) {
  if (!left || !right) {
    return false;
  }
  const leftLineup = normalizeLineup(left.lineup).map((item) => `${item.order}:${normalizePlayerKey(item.player)}:${item.position}`).join("|");
  const rightLineup = normalizeLineup(right.lineup).map((item) => `${item.order}:${normalizePlayerKey(item.player)}:${item.position}`).join("|");
  return leftLineup === rightLineup;
}

async function savePredictionToAccount(prediction = state.prediction) {
  if (!ensurePredictionEditingAllowed()) {
    return false;
  }
  const user = getPredictionAccountUser();
  const gameId = getCurrentGameId();
  if (!user) {
    return false;
  }
  if (!prediction || !gameId) {
    state.predictionRemote.status = "warning";
    state.predictionRemote.message = "保存する予想と対象試合を確認してください。";
    return false;
  }
  if (state.predictionRemote.gameId === gameId && state.predictionRemote.locked) {
    state.predictionRemote.status = "warning";
    state.predictionRemote.message = "この試合の予想受付は終了しています。";
    return false;
  }

  const predictionPayload = createPredictionPayload(prediction);
  if (!predictionPayload.ok) {
    state.predictionRemote.status = "warning";
    state.predictionRemote.message = predictionPayload.error;
    return false;
  }

  const url = buildCurrentPredictionApiUrl(gameId);
  if (!url) {
    state.predictionRemote.status = "unavailable";
    state.predictionRemote.message = "認証APIが未設定のため、端末の予想だけ保存しました。";
    return false;
  }

  state.predictionRemote.isSaving = true;
  state.predictionRemote.status = "saving";
  state.predictionRemote.message = "アカウントへ予想を保存中...";
  updatePredictionSaveButton();

  try {
    const { response, payload } = await publicApiClient.request(url, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      // Retired request shape: body: JSON.stringify({ gameId, prediction: predictionPayload.prediction })
      body: JSON.stringify({ internalGameId: gameId, prediction: predictionPayload.prediction })
    });
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error || `HTTP ${response.status}`);
      error.code = payload?.code || "PREDICTION_SAVE_FAILED";
      error.status = response.status;
      throw error;
    }

    state.predictionRemote.status = "success";
    state.predictionRemote.gameId = gameId;
    state.predictionRemote.message = "アカウントにも予想を保存しました。";
    state.predictionRemote.prediction = prediction;
    state.predictionRemote.submittedAt = payload.submittedAt || state.predictionRemote.submittedAt;
    state.predictionRemote.updatedAt = payload.updatedAt || new Date().toISOString();
    state.predictionRemote.conflict = false;
    return true;
  } catch (error) {
    console.error("アカウント予想の保存に失敗しました", error.message);
    state.predictionRemote.status = "error";
    state.predictionRemote.message = getPredictionAccountSaveErrorMessage(error)
      || "端末には保存しましたが、アカウント保存に失敗しました。";
    return false;
  } finally {
    state.predictionRemote.isSaving = false;
    updatePredictionSaveButton();
  }
}

function loadPredictionFromAccount() {
  const remotePrediction = state.predictionRemote.prediction;
  if (!remotePrediction) {
    return;
  }
  if (state.prediction && !window.confirm("アカウントに保存された予想で、現在の予想を置き換えますか？")) {
    return;
  }

  state.prediction = { ...remotePrediction, lineup: normalizeLineup(remotePrediction.lineup) };
  saveToStorage(STORAGE_KEYS.prediction, state.prediction);
  preserveDisplayedPublicResult();
  state.predictionRemote.conflict = false;
  state.predictionRemote.message = "アカウントの予想を読み込みました。";
  renderSavedPrediction();
  renderPredictionCta();
  renderPredictionAccountStatus();
  renderPicker("prediction");
  renderScoreResult();
}

async function deletePredictionFromAccount(gameId) {
  if (!ensurePredictionEditingAllowed()) {
    return false;
  }
  const user = getPredictionAccountUser();
  const url = buildCurrentPredictionApiUrl(gameId);
  if (!user || !url) {
    return;
  }

  state.predictionRemote.isDeleting = true;
  state.predictionRemote.message = "アカウントの予想を削除中...";
  renderPredictionAccountStatus();
  try {
    const { response, payload } = await publicApiClient.request(url, { method: "DELETE", credentials: "include" });
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.predictionRemote = createEmptyPredictionRemoteState();
    state.predictionRemote.status = "success";
    state.predictionRemote.gameId = gameId;
    state.predictionRemote.message = "アカウントの予想も削除しました。";
  } catch (error) {
    console.error("アカウント予想の削除に失敗しました", error.message);
    state.predictionRemote.status = "error";
    state.predictionRemote.message = "端末の予想はリセットしましたが、アカウントの予想削除に失敗しました。";
  } finally {
    state.predictionRemote.isDeleting = false;
    renderPredictionAccountStatus();
  }
}

function renderPredictionAccountStatus() {
  updatePredictionSaveButton();
  renderPublicGameSelectionMeta();
}

function updatePredictionSaveButton() {
  const button = document.getElementById("savePredictionButton");
  if (!button) {
    return;
  }

  const isSaving = state.predictionRemote.isSaving;
  const isSubmitting = state.predictionRemote.isSubmitting;
  button.disabled = isSaving || isSubmitting || isPredictionEditingLocked() || !hasUsablePublicRosterForCurrentGame();
  button.textContent = isSaving || isSubmitting ? "保存中..." : "予想を保存する";
  button.setAttribute("aria-busy", isSaving || isSubmitting ? "true" : "false");
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
  const aliasPlayer = playerAliases[playerKey];
  if (aliasPlayer) {
    return aliasPlayer;
  }

  const rosterPlayer = playerNames.find((player) => normalizePlayerKey(player) === playerKey);
  return rosterPlayer || trimmedName;
}

function normalizePlayerKey(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "");
}

async function handlePredictionSubmit(event) {
  return publicPredictionFormController.handleSubmit(event);
}

function resetPredictionInput() {
  return publicPredictionFormController.reset();
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
  const normalizedPlayer = player ? normalizePlayerName(player) : "";
  const normalizedPosition = position ? normalizePosition(position) : "";

  return {
    order: index + 1,
    player: normalizedPlayer,
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
  const normalizedPrediction = normalizeScoringLineup(predictionLineup);
  const normalizedActual = normalizeScoringLineup(actualLineup);
  const details = normalizedPrediction.map((predictionItem, index) => {
    const actualItem = findActualLineupItem(predictionItem, normalizedActual);
    const actualOrderItem = normalizedActual[index] || createLineupItem(index, "", "");
    const isInStartingLineup = Boolean(actualItem);
    const isExactOrder = Boolean(actualItem && actualItem.order === predictionItem.order);
    const isExactPosition = isInStartingLineup && actualItem.position === predictionItem.position;
    const point = (isInStartingLineup ? SCORE_RULES.player.perHit : 0) +
      (isExactOrder ? SCORE_RULES.order.perHit : 0) +
      (isExactPosition ? SCORE_RULES.position.perHit : 0);
    const isPerfect = isInStartingLineup && isExactOrder && isExactPosition;

    return {
      order: index + 1,
      player: predictionItem.player,
      playerId: predictionItem.playerId,
      position: predictionItem.position,
      actualPlayer: actualOrderItem.player,
      actualPlayerId: actualOrderItem.playerId,
      actualPosition: actualOrderItem.position,
      actualOrder: actualItem?.order || null,
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

function normalizeScoringLineup(lineup) {
  const source = Array.isArray(lineup) ? lineup : [];
  return normalizeLineup(source).map((item, index) => ({
    ...item,
    playerId: typeof source[index]?.playerId === "string" && source[index].playerId
      ? source[index].playerId
      : getLineupPlayerId(item)
  }));
}

function getLineupPlayerId(item) {
  const explicitPlayerId = typeof item?.playerId === "string" ? item.playerId.trim() : "";
  if (explicitPlayerId) {
    return explicitPlayerId;
  }

  const player = getUniquePlayerData(item?.player);
  return player ? createPlayerId(player.teamCode || DEFAULT_PLAYER_TEAM_CODE, player.uniformNumber) : "";
}

function findActualLineupItem(predictionItem, actualLineup) {
  const playerId = predictionItem?.playerId || "";
  if (playerId) {
    const idMatch = actualLineup.find((item) => item.playerId === playerId);
    if (idMatch) {
      return idMatch;
    }
  }

  const playerKey = normalizePlayerKey(predictionItem?.player);
  return actualLineup.find((item) => normalizePlayerKey(item.player) === playerKey) || null;
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
  state.gameInfo = normalizeGameInfo(loadFromStorage(STORAGE_KEYS.gameInfo));
  state.candidateRosterFilter = loadFromStorage(STORAGE_KEYS.candidateRosterFilter) === "inactive" ? "inactive" : "active";
  if (state.prediction?.lineup) {
    const { nickname: legacyNickname, ...prediction } = state.prediction;
    state.prediction = {
      ...prediction,
      lineup: normalizeLineup(prediction.lineup)
    };
    if (legacyNickname !== undefined) {
      saveToStorage(STORAGE_KEYS.prediction, state.prediction);
    }
  }

  if (state.actual?.lineup) {
    state.actual.lineup = normalizeLineup(state.actual.lineup);
  }

  if (state.prediction?.lineup && state.actual?.lineup && hasCompletePositions(state.prediction.lineup) && hasCompletePositions(state.actual.lineup)) {
    state.result = {
      ...scoreLineup(state.prediction.lineup, state.actual.lineup),
      gameId: state.result?.gameId || getCurrentGameId()
    };
    saveToStorage(STORAGE_KEYS.result, state.result);
  } else if (state.result?.max !== SCORE_MAX) {
    state.result = null;
    removeFromStorage(STORAGE_KEYS.result);
  }
}

function normalizeGameInfo(gameInfo) {
  return {
    scoreUrl: typeof gameInfo?.scoreUrl === "string" ? gameInfo.scoreUrl : "",
    gameStartAt: typeof gameInfo?.gameStartAt === "string" ? gameInfo.gameStartAt : "",
    matchup: typeof gameInfo?.matchup === "string" ? gameInfo.matchup : "",
    selectedGameId: typeof gameInfo?.selectedGameId === "string" ? gameInfo.selectedGameId : "",
    manualGameSelection: gameInfo?.manualGameSelection === true,
    manualStartOverride: gameInfo?.manualStartOverride === true
  };
}

function isNormalManagedSchedule(schedule) {
  const gameType = String(schedule?.type || schedule?.gameType || "").toLowerCase();
  const gameId = String(schedule?.gameId || "").toLowerCase();
  return schedule?.isTestGame !== true
    && schedule?.isAutoScoringTest !== true
    && schedule?.testGame !== true
    && !["test", "auto_scoring_test", "auto-scoring-test"].includes(gameType)
    && !gameId.includes("auto-scoring-test");
}

function getScheduleDate(schedule) {
  if (typeof schedule?.date === "string" && schedule.date) {
    return schedule.date;
  }

  return String(schedule?.startDateTime || "").slice(0, 10);
}

function getScheduleStartTime(schedule) {
  if (typeof schedule?.startTime === "string" && schedule.startTime) {
    return schedule.startTime;
  }

  return String(schedule?.startDateTime || "").slice(11, 16);
}

function getScheduleSortValue(schedule) {
  return `${getScheduleDate(schedule)}T${getScheduleStartTime(schedule)}`;
}

function getJapanDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function saveToStorage(key, value) {
  return publicStorage.save(key, value);
}

function loadFromStorage(key) {
  return publicStorage.load(key);
}

function removeFromStorage(key) {
  return publicStorage.remove(key);
}

function renderAll() {
  renderPublicGameSelectionMeta();
  renderProbableStarter();
  renderSavedPrediction();
  renderPredictionCta();
  renderPredictionAccountStatus();
  renderPredictionDeadline();
  renderPredictionTargetNotice();
  renderAchievements();
  renderResultHistory();
  renderScoreResult();
  renderDailyBestNine();
  renderRankingPanel();
  renderPicker("prediction");
}

function formatPublicJstDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "予定未定";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}/${parts.month}/${parts.day} ${parts.hour}:${parts.minute} JST`;
}

function formatPublicRemainingTime(value, now = new Date()) {
  const target = new Date(value || "");
  if (Number.isNaN(target.getTime())) return "-";
  const minutes = Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 60000));
  if (minutes <= 0) return "まもなく";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}時間${remainder}分` : `${remainder}分`;
}

function getPublicGameStatusView(game, deadline, remoteState = state.predictionRemote, now = new Date()) {
  const workflowState = String(game?.workflowState || "").toLowerCase();
  const published = isPublicGamePublished(game, remoteState);
  const saved = Boolean(remoteState?.prediction || (state.prediction && [game?.internalGameId, game?.gameId].includes(state.prediction.gameId)));
  if (published) {
    return { key: "ok", label: "結果公開済み", status: "結果公開済み", saved, nextAction: "結果とランキングを確認できます。" };
  }
  if (deadline?.status === "open") {
    const remaining = new Date(deadline.deadlineAt).getTime() - now.getTime();
    const near = Number.isFinite(remaining) && remaining <= 30 * 60 * 1000;
    return {
      key: near ? "attention" : "ok",
      label: near ? "締切間近" : "予想受付中",
      status: near ? "締切間近" : "予想受付中",
      saved,
      nextAction: saved ? "保存済みの予想を確認・更新できます。" : "スタメンを選んで予想を保存してください。"
    };
  }
  if (deadline?.status === "closed") {
    const lineupWaiting = ["prediction_closed", "lineup_polling", "lineup_candidate_captured", "final_lineup_pending"].includes(workflowState);
    return {
      key: "waiting",
      label: lineupWaiting ? "スタメン待ち" : "締切済み",
      status: lineupWaiting ? "スタメン発表待ち" : "予想受付は終了しました",
      saved,
      nextAction: lineupWaiting ? "正式スタメンと採点結果をお待ちください。" : "採点または結果公開をお待ちください。"
    };
  }
  return { key: "waiting", label: "確認中", status: "試合情報を確認しています", saved, nextAction: "試合情報を読み込み中です。" };
}

function renderPublicPredictionSurface(selectedGame) {
  const editor = document.getElementById("predictionEditor");
  if (!selectedGame) {
    if (editor) editor.classList.add("hidden");
    return;
  }
  if (editor) editor.classList.remove("hidden");
}

function renderPublicGameSelectionMeta() {
  const meta = document.getElementById("publicGameSelectionMeta");
  if (!meta) return;
  const game = state.predictionTargetGame || state.publicGameCatalog.games.find((item) => item.internalGameId === getCurrentGameId()) || null;
  const deadline = getEffectivePredictionDeadline();
  if (!game && !deadline.game) {
    meta.textContent = state.publicGameCatalog.isLoading
      ? "試合情報を確認しています。"
      : "現在、予想受付中の試合はありません。";
    renderPublicPredictionSurface(null);
    return;
  }
  const selectedGame = game || deadline.game;
  const view = getPublicGameStatusView(selectedGame, deadline, state.predictionRemote);
  const savedAt = state.predictionRemote.updatedAt || state.prediction?.savedAt || "";
  const savedText = view.saved
    ? `保存済み${savedAt ? `（${formatPublicJstDateTime(savedAt)}）` : ""}`
    : "未保存";
  if (deadline.status === "open") {
    const gameMeta = getPublicPredictionGameMetaLines(selectedGame);
    const compactDeadline = formatPublicJstDateTime(deadline.deadlineAt)
      .replace(/^\d{4}\//, "")
      .replace(/^0/, "");
    meta.innerHTML = `
      <span class="public-game-meta-line public-game-meta-date">${escapeHtml(gameMeta.dateTime)}</span>
      <span class="public-game-meta-line public-game-meta-matchup">${escapeHtml(gameMeta.matchup)}</span>
      <span class="public-game-meta-line public-game-meta-status">予想締切: ${escapeHtml(compactDeadline)} ・ ${escapeHtml(savedText)}</span>
    `;
  } else {
    meta.textContent = `${view.status} ・ ${savedText}`;
  }
  renderPublicPredictionSurface(selectedGame);
}

function renderPredictionTargetNotice() {
  const container = document.getElementById("predictionTargetNotice");
  if (!container) return;
  const message = String(state.predictionTargetNotice || "").trim();
  container.textContent = message;
  container.classList.toggle("hidden", !message);
}

function renderProbableStarter() {
  renderProbableStarterDisplay();
}

function renderProbableStarterDisplay() {
  const container = document.getElementById("probableStarterDisplay");
  if (!container) {
    return;
  }

  const probableStarter = state.probableStarter;
  if (!probableStarter.nextGame || probableStarter.status === "idle" || probableStarter.status === "noGame") {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  container.classList.remove("hidden");

  if (probableStarter.status === "loading") {
    container.className = "probable-starter-card is-loading";
    container.innerHTML = `
      ${createProbableStarterHeadingHtml()}
      <p class="probable-starter-message">予告先発を取得中...</p>
    `;
    return;
  }

  if (probableStarter.status === "error") {
    renderProbableStarterNotice(container, "error", probableStarter.nextGame);
    return;
  }

  if (probableStarter.status === "game_reference_mismatch") {
    renderProbableStarterNotice(container, "game_reference_mismatch", probableStarter.nextGame);
    return;
  }

  if (probableStarter.status === "unannounced") {
    renderProbableStarterNotice(container, "unannounced", probableStarter.nextGame);
    return;
  }

  const matchedGame = probableStarter.matchedGame;
  const fightersStarter = getFightersStarter(matchedGame);
  if (!matchedGame || !fightersStarter) {
    renderProbableStarterNotice(container, "unannounced", probableStarter.nextGame);
    return;
  }

  const dateText = formatProbableStarterDate(matchedGame.date || probableStarter.nextGame.date);
  const gameInfo = `${dateText} ${matchedGame.startTime || probableStarter.nextGame.startTime || ""}`.trim();
  container.className = "probable-starter-card is-success";
  container.innerHTML = `
    ${createProbableStarterHeadingHtml()}
    <div class="probable-starter-grid">
      ${createProbableStarterTeamHtml("日本ハム", fightersStarter.fighters?.name)}
      ${createProbableStarterTeamHtml(fightersStarter.opponentName || "相手チーム", fightersStarter.opponent?.name)}
    </div>
    <p class="probable-starter-meta">${escapeHtml(gameInfo)}${matchedGame.venue ? ` ・ ${escapeHtml(matchedGame.venue)}` : ""}</p>
    <p class="probable-starter-fetched">取得：${escapeHtml(formatDateTime(probableStarter.fetchedAt))}</p>
  `;
}

function renderProbableStarterNotice(container, status, nextGame) {
  const isError = status === "error";
  const isReferenceMismatch = status === "game_reference_mismatch";
  container.className = `probable-starter-card ${isError ? "is-error" : "is-pending"}`;
  if (isReferenceMismatch) container.classList.add("is-error");
  container.innerHTML = `
    ${createProbableStarterHeadingHtml()}
    <p class="probable-starter-message">${isReferenceMismatch ? "予告先発の試合参照を確認できませんでした。" : isError ? "予告先発を取得できませんでした。" : "現在、次の試合の予告先発はまだ発表されていません。"}</p>
    <p class="probable-starter-meta">${isReferenceMismatch ? "試合情報を更新して再確認します。" : isError ? "次回の自動更新で再試行します。" : "発表され次第、自動で表示されます。"}</p>
    ${isError || isReferenceMismatch ? "" : `<p class="probable-starter-meta">${escapeHtml(formatScheduledGameForLog(nextGame))}</p>`}
    ${!isError && !isReferenceMismatch && state.probableStarter.nextCheckAt ? `<p class="probable-starter-meta">次回自動確認：${escapeHtml(formatDateTime(state.probableStarter.nextCheckAt))}</p>` : ""}
  `;
}

function createProbableStarterHeadingHtml() {
  return `
    <div class="probable-starter-heading">
      <p class="probable-starter-label">予告先発</p>
      <a href="${NPBASE_MATCHUPS_URL}" target="_blank" rel="noopener noreferrer">対予告先発成績</a>
    </div>
  `;
}

function createProbableStarterTeamHtml(teamName, starterName) {
  return `
    <div class="probable-starter-team">
      <span>${escapeHtml(teamName)}</span>
      <strong>${escapeHtml(starterName || "未発表")}</strong>
    </div>
  `;
}

function formatProbableStarterDate(dateValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ""));
  return match ? `${Number(match[2])}月${Number(match[3])}日` : "";
}

function getGameDayNoticeTarget() {
  return {
    internalGameId: state.predictionTargetGame?.internalGameId || state.probableStarter.nextGame?.internalGameId || "",
    gameId: ""
  };
}

function buildGameDayNoticeApiUrl({ internalGameId = "", gameId = "" } = {}) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  if (internalGameId) return `${baseUrl}/api/game-day-status?internalGameId=${encodeURIComponent(internalGameId)}`;
  return gameId ? `${baseUrl}/api/game-day-status?gameId=${encodeURIComponent(gameId)}` : "";
}

function renderGameDayNoticeStatus() {
  const container = document.getElementById("gameDayNoticeStatus");
  if (!container) return;
  const record = state.gameDayNotice.record;
  const registeredCount = Number(record?.registeredCount || 0);
  const removedCount = Number(record?.removedCount || 0);
  const hasNotice = record?.sourceStatus !== "error" && (registeredCount > 0 || removedCount > 0);
  if (!hasNotice) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML = `<span>選手登録・抹消：登録${registeredCount}人 / 抹消${removedCount}人</span>`;
}

async function refreshGameDayNoticeStatus({ force = false } = {}) {
  const target = getGameDayNoticeTarget();
  const gameId = target.internalGameId || target.gameId;
  const url = buildGameDayNoticeApiUrl(target);
  if (!url) return;
  if (state.gameDayNotice.isLoading && state.gameDayNotice.gameId === gameId) return;
  if (state.gameDayNotice.isLoading && !force) return;
  state.gameDayNotice.isLoading = true;
  state.gameDayNotice.gameId = gameId;
  state.gameDayNotice.message = "";
  renderGameDayNoticeStatus();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error || `HTTP ${response.status}`);
      error.httpStatus = response.status;
      throw error;
    }
    state.gameDayNotice.record = payload;
  } catch (error) {
    const httpStatus = Number(error?.httpStatus || 0);
    if (httpStatus >= 500 || !httpStatus) {
      console.error("本日の公示状態取得に失敗しました", error.message);
    } else {
      console.warn("本日の公示状態を確認できませんでした", error.message);
    }
    state.gameDayNotice.record = null;
    state.gameDayNotice.message = "";
  } finally {
    state.gameDayNotice.isLoading = false;
    renderGameDayNoticeStatus();
    renderScoreResult();
  }
}

async function fetchGameDayRosterSnapshot(internalGameId = getGameDayRosterTargetInternalGameId(), { signal } = {}) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!internalGameId || !baseUrl) return { ok: false, players: [] };
  try {
    const { response, payload } = await publicApiClient.get(`${baseUrl}/api/game-day-roster?internalGameId=${encodeURIComponent(internalGameId)}`, { credentials: "include", signal });
    if (!response.ok || !payload?.ok || !Array.isArray(payload.players)) return { ok: false, players: [] };
    return payload;
  } catch (error) {
    console.error("試合別ロースターの取得に失敗しました", error.message);
    return { ok: false, players: [] };
  }
}

function renderPicker(pickerName) {
  const lineup = getLineupValues(pickerName);
  const usedPlayers = new Set(lineup.map((item) => item.player).filter(Boolean));
  const duplicatedPlayers = getDuplicatedPlayers(lineup);
  const duplicatedPositions = getDuplicatedPositions(lineup);
  const isLocked = pickerName === "prediction" && isPredictionEditingLocked();

  document.querySelectorAll(`.lineup-slot[data-picker="${pickerName}"]`).forEach((slot, index) => {
    const player = slot.dataset.player || "";
    const position = slot.dataset.position || "";
    const playerElement = slot.querySelector(".slot-player");
    const positionButton = slot.querySelector(".position-button");
    const clearButton = slot.querySelector(".slot-clear");

    slot.classList.toggle("is-active", state.activeOrder[pickerName] === index);
    slot.classList.toggle("has-player", Boolean(player));
    slot.classList.toggle("is-duplicate", duplicatedPlayers.has(player) || duplicatedPositions.has(position));
    slot.classList.toggle("is-locked", isLocked);
    slot.draggable = shouldUseNativeDrag(pickerName) && Boolean(player) && !isLocked;
    slot.setAttribute("aria-disabled", isLocked ? "true" : "false");
    slot.setAttribute("aria-label", `${index + 1}番 ${position || "守備未選択"} ${player || "未選択"}`);
    playerElement.innerHTML = player ? createPlayerLabelHtml(player) : "未選択";
    playerElement.classList.toggle("slot-empty", !player);
    applyPlayerCategoryClass(slot, player);
    renderPositionButton(positionButton, position, index);
    positionButton.disabled = isLocked;
    positionButton.draggable = pickerName === "actual" && shouldUseNativeDrag(pickerName) && Boolean(position) && !isLocked;
    clearButton.disabled = isLocked;
    clearButton.classList.toggle("hidden", !player);
    const dragHandle = slot.querySelector(".slot-drag-handle");
    if (dragHandle) {
      dragHandle.disabled = isLocked;
      dragHandle.draggable = Boolean(player) && !isLocked;
      dragHandle.classList.toggle("is-disabled", !player || isLocked);
    }
  });

  document.querySelectorAll(`.player-chip[data-picker="${pickerName}"]`).forEach((chip) => {
    const isUsed = usedPlayers.has(chip.dataset.player);
    chip.classList.toggle("is-used", isUsed);
    chip.disabled = isLocked;
    chip.draggable = shouldUseNativeDrag(pickerName) && !isLocked;
  });

  if (pickerName === "prediction") {
    renderPredictionRosterFilter();
  }
}

function renderPredictionRosterFilter() {
  return publicRosterController.renderPredictionRosterFilter();
}

function renderPositionButton(button, position, index) {
  ["empty", "catcher", "infielder", "outfielder", "dh"].forEach((category) => {
    button.classList.remove(`is-${category}`);
  });

  button.textContent = position || "?";
  button.classList.add(position ? `is-${getPositionCategory(position)}` : "is-empty");
  button.setAttribute("aria-label", `${index + 1}番の守備位置：${position || "未選択"}`);
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
  const editButton = document.getElementById("editSavedPredictionButton");
  const shareButton = document.getElementById("sharePredictionButton");

  if (!state.prediction) {
    container.className = "empty-state";
    container.textContent = "まだ予想が保存されていません。";
    editButton?.classList.add("hidden");
    shareButton.classList.add("hidden");
    return;
  }

  setLineupValues("prediction", state.prediction.lineup);
  container.className = "summary-box";
  container.innerHTML = "";
  container.appendChild(createPredictionSummary(state.prediction));
  editButton?.classList.remove("hidden");
  shareButton.classList.remove("hidden");
}

function renderPredictionCta() {
  const button = document.getElementById("predictionCtaButton");
  if (!button) return;
  const isLoggedIn = Boolean(getPredictionAccountUser());
  const hasPrediction = Boolean(state.prediction || state.predictionRemote?.prediction);
  const selectedGame = state.predictionTargetGame || null;
  button.classList.toggle("hidden", !isLoggedIn || !selectedGame);
  button.textContent = hasPrediction ? "予想を編集する" : "この試合を予想する";
}

function handlePredictionCtaClick() {
  scrollToPredictionForm();
}

function scrollToPredictionForm() {
  const form = document.getElementById("predictionForm");
  form?.scrollIntoView({ behavior: "smooth", block: "start" });
  form?.querySelector("button, input, select")?.focus({ preventScroll: true });
}

function renderScoreResult() {
  return publicResultsRenderer.renderScoreResult();
}

function renderDailyBestNine() {
  return publicResultsRenderer.renderDailyBestNine();
}

function renderScoreInsights(comparison) {
  const grid = document.getElementById("scoreInsightsGrid");
  const notice = document.getElementById("scoreInsightsNotice");
  if (!grid || !notice) return;

  const values = {
    average: comparison?.average ?? comparison?.averageScore,
    rank: comparison?.rank,
    top: comparison?.top ?? comparison?.topPercent ?? comparison?.percentile
  };
  const hasData = Object.values(values).some((value) => value !== null && value !== undefined && String(value).trim() !== "");
  grid.classList.toggle("hidden", !hasData);
  notice.classList.toggle("hidden", hasData);

  grid.querySelectorAll("[data-score-insight]").forEach((card) => {
    const value = values[card.dataset.scoreInsight];
    const valueElement = card.querySelector("[data-score-insight-value]");
    const hasValue = value !== null && value !== undefined && String(value).trim() !== "";
    card.classList.toggle("hidden", !hasValue);
    if (valueElement) valueElement.textContent = hasValue ? String(value) : "";
  });
}

function createResultViewModel(result) {
  const sourceDetails = Array.isArray(result.details) ? result.details : [];
  const actualOrderById = new Map();
  const actualOrderByName = new Map();
  sourceDetails.forEach((detail) => {
    const order = Number(detail.order);
    if (!Number.isInteger(order) || order < 1) {
      return;
    }
    const actualPlayerId = typeof detail.actualPlayerId === "string" ? detail.actualPlayerId.trim() : "";
    const actualPlayerKey = normalizePlayerKey(detail.actualPlayer);
    if (actualPlayerId) {
      actualOrderById.set(actualPlayerId, order);
    }
    if (actualPlayerKey) {
      actualOrderByName.set(actualPlayerKey, order);
    }
  });

  const details = sourceDetails.map((detail) => {
    const isPlayerHit = Boolean(detail.isPlayerHit ?? detail.mark !== "×");
    const isOrderHit = Boolean(detail.isOrderHit ?? detail.mark === "◎");
    const isPositionHit = Boolean(detail.isPositionHit ?? detail.mark === "◎");
    const playerId = typeof detail.playerId === "string" ? detail.playerId.trim() : "";
    const existingActualOrder = Number(detail.actualOrder);
    const actualOrder = Number.isInteger(existingActualOrder) && existingActualOrder > 0
      ? existingActualOrder
      : actualOrderById.get(playerId) || actualOrderByName.get(normalizePlayerKey(detail.player)) || null;

    return {
      ...detail,
      actualPlayer: detail.actualPlayer || "",
      actualPosition: detail.actualPosition || "",
      actualOrder,
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
    perfectLabel: result.total === SCORE_MAX ? "完全一致" : "",
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
    <p class="result-label">合計点</p>
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
        <th rowspan="2" class="result-order-heading">打順</th>
        <th colspan="2" class="result-group-heading">あなたの予想</th>
        <th colspan="2" class="result-group-heading result-actual-group-heading">実際のスタメン</th>
        <th colspan="3" class="result-group-heading">判定</th>
        <th rowspan="2" class="result-point-heading">点数</th>
      </tr>
      <tr>
        <th class="result-subheading">選手</th>
        <th class="result-subheading">守備位置</th>
        <th class="result-subheading result-actual-group-heading">選手</th>
        <th class="result-subheading">守備位置</th>
        <th class="result-subheading">出場</th>
        <th class="result-subheading">打順</th>
        <th class="result-subheading">守備</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector("tbody");
  details.forEach((detail) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${detail.order}番</strong></td>
      <td class="result-player-cell">${createResultPlayerCardHtml(detail.player, detail.position)}</td>
      <td class="result-player-cell result-actual-group-cell">${createResultPlayerCardHtml(detail.actualPlayer || "-", detail.actualPosition)}</td>
      <td>${createHitBadge(detail.isPlayerHit, "出場")}</td>
      <td class="result-judgement-cell">
        ${createHitBadge(detail.isOrderHit, "打順")}
      </td>
      <td>${createHitBadge(detail.isPositionHit, "守備")}</td>
      <td class="result-point-cell"><strong>${detail.point}</strong></td>
    `;
    tbody.appendChild(row);
  });

  return table;
}

function createResultPlayerCardHtml(player, position) {
  return `
    <span class="result-player-card">
      ${createResultPositionTileHtml(position)}
      <span class="result-player-name">${escapeHtml(player || "-")}</span>
    </span>
  `;
}

function createHitBadge(isHit, label) {
  const status = isHit ? "的中" : "不一致";
  return `
    <span class="hit-badge ${isHit ? "is-hit" : "is-miss"}" aria-label="${escapeHtml(label)}：${status}">
      <span class="hit-mark" aria-hidden="true">${isHit ? "○" : "×"}</span>
      <span>${escapeHtml(label)}</span>
    </span>
  `;
}

function createResultPositionTileHtml(position) {
  const normalizedPosition = normalizePosition(position);
  const category = normalizedPosition ? getPositionCategory(normalizedPosition) : "empty";
  return `
    <span class="result-position-tile is-${category}" aria-label="守備位置 ${escapeHtml(normalizedPosition || "未選択")}">
      ${escapeHtml(normalizedPosition || "－")}
    </span>
  `;
}

function createPredictionSummary(prediction) {
  const wrapper = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "保存済みのスタメン予想";

  const meta = document.createElement("div");
  meta.className = "summary-meta";
  meta.textContent = `最後に更新：${formatDateTime(prediction.savedAt)}`;

  const list = document.createElement("ul");
  list.className = "lineup-list";
  normalizeLineup(prediction.lineup).forEach((lineupItem, index) => {
    const listItem = document.createElement("li");
    const normalizedPosition = normalizePosition(lineupItem.position);
    const positionCategory = normalizedPosition ? getPositionCategory(normalizedPosition) : "empty";
    listItem.className = "saved-lineup-row";
    listItem.innerHTML = `
      <strong class="saved-lineup-order">${index + 1}番</strong>
      <span class="saved-lineup-detail">
        <span class="result-position-tile saved-position-chip is-${positionCategory}" aria-label="守備位置 ${escapeHtml(normalizedPosition || "未選択")}">
          ${escapeHtml(normalizedPosition || "－")}
        </span>
        <span class="saved-lineup-name">${escapeHtml(lineupItem.player)}</span>
      </span>
    `;
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
    minute: "2-digit",
    timeZone: "Asia/Tokyo"
  }).format(new Date(isoString));
}

function sharePrediction() {
  if (!state.prediction) {
    showMessage("predictionError", "共有する予想がありません。");
    return;
  }

  openXShare(createPredictionShareText(state.prediction));
}

function createPredictionShareText(prediction) {
  const lineup = normalizeLineup(prediction.lineup);
  const gameLabel = state.predictionTargetGame?.matchupLabel || state.gameInfo.matchup || "";
  const serviceUrl = getPredictionShareUrl();
  const lines = [
    "ハムスタメンチャレンジ予想",
    ...(gameLabel ? ["", gameLabel] : []),
    "",
    ...lineup.map((item, index) => `${index + 1}番 ${item.position} ${item.player}`),
    ...(serviceUrl ? ["", serviceUrl] : []),
    "",
    SHARE_HASHTAGS
  ];

  return lines.join("\n");
}

function getPredictionShareUrl() {
  if (!window.location?.origin || window.location.origin === "null") {
    return "";
  }
  return `${window.location.origin}${window.location.pathname}`;
}

function openXShare(text) {
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

function showMessage(elementId, message) {
  const element = document.getElementById(elementId);
  if (element) element.textContent = message;
}

function showPredictionSaveMessage(message) {
  const element = document.getElementById("predictionSaveMessage");
  if (!element) {
    return;
  }

  if (predictionSaveMessageTimerId) {
    clearTimeout(predictionSaveMessageTimerId);
  }
  element.classList.add("success-message");
  element.textContent = message;
  predictionSaveMessageTimerId = setTimeout(() => {
    element.textContent = "";
    element.classList.remove("success-message");
    predictionSaveMessageTimerId = null;
  }, 4000);
}

function clearMessage(elementId) {
  const element = document.getElementById(elementId);
  if (element) element.textContent = "";
}

function escapeHtml(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

function getPlayerData(playerName) {
  const playerKey = normalizePlayerKey(playerName);
  return players.find((player) => normalizePlayerKey(player.name) === playerKey) || null;
}

function createPlayerCategoryBadgeHtml(playerName) {
  const player = getPlayerData(playerName);
  const label = player ? playerCategoryLabels[player.category] : "";

  if (!player || !label) {
    return "";
  }

  return `<span class="player-category-badge is-${escapeHtml(player.category)}" aria-label="${escapeHtml(player.category)}">${escapeHtml(label)}</span>`;
}

function createPlayerPositionBadgesHtml(playerName) {
  const player = getPlayerData(playerName);
  const sourcePositions = Array.isArray(player?.positions) ? player.positions : [];
  const normalizedPositions = Array.from(new Set(
    sourcePositions.map((position) => normalizeDisplayPosition(position)).filter(Boolean)
  ));

  if (!normalizedPositions.length) {
    return createPlayerCategoryBadgeHtml(playerName);
  }

  const badges = normalizedPositions.map((position) => {
    return `<span class="player-position-badge is-${getPositionCategory(position)}" aria-label="守備位置 ${escapeHtml(position)}">${escapeHtml(position)}</span>`;
  }).join("");

  return `<span class="player-position-badges">${badges}</span>`;
}

function normalizeDisplayPosition(value) {
  const key = normalizePositionKey(value);

  if (["左", "中", "右", "LF", "CF", "RF", "外", "外野", "OF"].includes(key)) {
    return "外";
  }

  return normalizePosition(key);
}

function getPositionCategory(position) {
  if (position === "捕") {
    return "catcher";
  }

  if (["一", "二", "三", "遊"].includes(position)) {
    return "infielder";
  }

  if (["外", "左", "中", "右"].includes(position)) {
    return "outfielder";
  }

  return "dh";
}

function createPlayerLabelHtml(playerName) {
  return `<span class="player-name">${escapeHtml(playerName)}</span>`;
}

function getPlayerCategoryClass(playerName) {
  const player = getPlayerData(playerName);
  const category = player?.mainCategory || player?.category;
  return playerCategoryNames[category] ? `is-category-${category}` : "";
}

function getPlayerCategoryClassNames(playerName) {
  return getPlayerCategoryClass(playerName);
}

function applyPlayerCategoryClass(element, playerName) {
  Object.keys(playerCategoryNames).forEach((category) => {
    element.classList.remove(`is-category-${category}`);
    element.classList.remove(`is-subcategory-${category}`);
  });

  getPlayerCategoryClassNames(playerName).split(" ").filter(Boolean).forEach((className) => {
    element.classList.add(className);
  });
}

function showSlotPlayerDetails(pickerName, slot) {
  if (slot.dataset.player) {
    showPlayerDetails(pickerName, slot.dataset.player);
  }
}

function showPlayerDetails(pickerName, playerName) {
  const player = getPlayerData(playerName);
  const panel = document.getElementById(`${pickerName}PlayerDetails`);

  if (!panel || !player) {
    return;
  }

  const npbasePlayerUrl = getNpbasePlayerUrl(player);
  const positions = createPlayerPositionBadgesHtml(player.name);
  panel.className = "player-detail-overlay";
  panel.setAttribute("aria-hidden", "false");
  panel.innerHTML = `
    <div class="player-detail-dialog" role="document">
      <div class="player-detail-header">
        <div>
          <p class="player-detail-kicker">選手詳細</p>
          <h2 id="playerDetailTitle">${escapeHtml(player.name)}</h2>
        </div>
        <button class="player-detail-close" type="button" aria-label="選手詳細を閉じる">×</button>
      </div>
      <dl class="player-detail-meta">
        <div><dt>背番号</dt><dd>${escapeHtml(player.uniformNumber || "-")}</dd></div>
        <div><dt>登録区分</dt><dd>${escapeHtml(player.registeredPosition || "未設定")}</dd></div>
      </dl>
      <div class="player-detail-positions">
        <strong>守備候補</strong>
        ${positions}
      </div>
      <p class="player-detail-notice">成績表示は準備中です。現在はNPBaseへのリンクから確認できます。</p>
      <div class="player-detail-links">
        <a href="${escapeHtml(npbasePlayerUrl)}" target="_blank" rel="noopener noreferrer">選手成績を見る（NPBase）</a>
      </div>
      <button class="primary-button player-detail-select" type="button">この選手を選択</button>
    </div>
  `;
  panel.classList.remove("hidden");
  if (panel.dataset.bound !== "true") {
    panel.addEventListener("click", handlePlayerDetailsOverlayClick);
    panel.dataset.bound = "true";
  }
  panel.querySelector(".player-detail-close")?.addEventListener("click", closePlayerDetails);
  panel.querySelector(".player-detail-select")?.addEventListener("click", () => {
    assignPlayerToActiveSlot(pickerName, player.name);
    closePlayerDetails();
  });
  panel.querySelector(".player-detail-close")?.focus();
}

function handlePlayerDetailsOverlayClick(event) {
  if (event.target === event.currentTarget) closePlayerDetails();
}

function closePlayerDetails() {
  document.querySelectorAll(".player-detail-overlay").forEach((panel) => {
    panel.classList.add("hidden");
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = "";
  });
}

function getNpbasePlayerUrl(player) {
  const candidate = String(player?.npbasePlayerUrl || "").trim();
  return candidate.startsWith("https://npbase.jp/") ? candidate : NPBASE_PLAYER_FALLBACK_URL;
}
