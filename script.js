const STORAGE_KEYS = {
  prediction: "hamStarting9Prediction",
  actual: "hamStarting9Actual",
  result: "hamStarting9Result",
  gameInfo: "hamStarting9GameInfo",
  rosterSnapshot: "hamStarting9RosterSnapshot",
  candidateRosterFilter: "hamStarting9CandidateRosterFilter"
};
const GAME_SCOPED_STORAGE_KEYS = new Set([
  STORAGE_KEYS.prediction,
  STORAGE_KEYS.actual,
  STORAGE_KEYS.result,
  STORAGE_KEYS.rosterSnapshot
]);
const LINEUP_SIZE = 9;
const SCORE_MAX = 99;
const SHARE_HASHTAGS = "#lovefighters #starting9";
const SCORE_RULES = {
  player: {
    perHit: 5,
    max: 45
  },
  order: {
    perHit: 3,
    max: 27
  },
  position: {
    perHit: 2,
    max: 18
  },
  perfect: {
    perHit: 1,
    max: 9
  }
};
const POINTER_LONG_PRESS_MS = 250;
const POINTER_DRAG_DISTANCE = 8;
const DRAG_DATA_TYPE = "application/x-ham-starting9-player";
const NPB_STARTER_SOURCE_URL = "https://npb.jp/announcement/starter/";
const NPBASE_PLAYER_FALLBACK_URL = "https://npbase.jp/";
const PREDICTION_DEADLINE_REFRESH_MS = 30 * 1000;
const PUBLIC_GAMES_SESSION_CACHE_TTL_MS = 30 * 1000;
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
let openPositionMenuState = null;
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
    fetchedGameId: "",
    lastRefreshAt: 0
  },
  predictionTargetGameId: "",
  predictionTargetGame: null,
  predictionTargetNotice: "",
  publicGameCatalog: {
    isLoading: false,
    games: [],
    message: ""
  },
  previousResultGame: {
    isLoading: false,
    isReady: false,
    game: null,
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
    isReady: false,
    games: [],
    detailCache: Object.create(null),
    selectedGameId: "",
    displayMode: "previous",
    isExpanded: false,
    result: null,
    message: "",
    detailError: ""
  },
  dailyBestNine: {
    isLoading: false,
    requestId: 0,
    gameId: "",
    status: "idle",
    rows: [],
    message: "",
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
const publicPredictionValidation = publicFrontend.createPublicPredictionValidation({ normalizeLineup });
const formatPlayerNameForDisplay = publicFrontend.formatPlayerNameForDisplay || ((player) => {
  if (typeof player === "object" && player !== null) return String(player.name || player.playerName || "");
  return String(player || "");
});
const basePublicStorage = publicFrontend.createPublicStorage(window.localStorage);

function getGameScopedStorageKey(key, gameId) {
  const normalizedGameId = String(gameId || "").trim();
  return normalizedGameId ? `${key}:game:${encodeURIComponent(normalizedGameId)}` : key;
}

function getStorageValueGameId(key, value) {
  if (!GAME_SCOPED_STORAGE_KEYS.has(key)) return "";
  return String(value?.internalGameId || value?.gameId || "").trim();
}

function getActiveStorageGameId() {
  return String(state.predictionTargetGameId || state.predictionTargetGame?.internalGameId || "").trim();
}

function saveGameScopedStorage(key, value) {
  if (!GAME_SCOPED_STORAGE_KEYS.has(key)) return basePublicStorage.save(key, value);
  const gameId = getStorageValueGameId(key, value) || getActiveStorageGameId();
  return basePublicStorage.save(getGameScopedStorageKey(key, gameId), value);
}

function loadGameScopedStorage(key) {
  if (!GAME_SCOPED_STORAGE_KEYS.has(key)) return basePublicStorage.load(key);
  const gameId = getActiveStorageGameId();
  if (!gameId) return basePublicStorage.load(key);
  const scopedValue = basePublicStorage.load(getGameScopedStorageKey(key, gameId));
  if (scopedValue) return scopedValue;

  // 旧キーは、保存された試合IDが現在試合と一致する場合だけ移行します。
  const legacyValue = basePublicStorage.load(key);
  const legacyGameId = getStorageValueGameId(key, legacyValue);
  if (legacyValue && legacyGameId === gameId) {
    basePublicStorage.save(getGameScopedStorageKey(key, gameId), legacyValue);
    return legacyValue;
  }
  return null;
}

function removeGameScopedStorage(key) {
  if (!GAME_SCOPED_STORAGE_KEYS.has(key)) return basePublicStorage.remove(key);
  const gameId = getActiveStorageGameId();
  if (!gameId) return basePublicStorage.remove(key);
  return basePublicStorage.remove(getGameScopedStorageKey(key, gameId));
}

const publicStorage = {
  save: saveGameScopedStorage,
  load: loadGameScopedStorage,
  remove: removeGameScopedStorage
};
const appState = publicFrontend.state.createPublicAppState(state);
const publicRequestGuard = publicFrontend.createPublicRequestGuard(appState.requests);
const publicApiClient = publicFrontend.createPublicApiClient();
const publicPredictionPersistence = publicFrontend.createPublicPredictionPersistence({ apiClient: publicApiClient });

function syncPublicAppState() {
  publicFrontend.state.syncPublicAppState(appState, state);
}

function beginPublicRequest(name, { abort = false } = {}) {
  return publicRequestGuard.begin(name, { abort });
}

function isCurrentPublicRequest(name, id) {
  return publicRequestGuard.isCurrent(name, id);
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
  state: { get dailyBestNine() { return state.dailyBestNine; } },
  escapeHtml
});
const publicDailyBestNineController = publicFrontend.createDailyBestNineController({
  state: {
    get dailyBestNine() { return state.dailyBestNine; }
  },
  apiClient: publicApiClient,
  getAuthApiBaseUrl,
  render: publicResultsRenderer.renderDailyBestNine
});
const publicResultsController = publicFrontend.createPublicResultsController({
  state: {
    get resultHistory() { return state.resultHistory; },
    set resultHistory(value) { state.resultHistory = value; },
    get previousResultGame() { return state.previousResultGame; },
    get result() { return state.result; },
    set result(value) { state.result = value; }
  },
  apiClient: publicApiClient,
  requestGuard: publicRequestGuard,
  storage: publicStorage,
  resultStorageKey: STORAGE_KEYS.result,
  getAuthApiBaseUrl,
  getFastPreviousResultGame,
  getPredictionAccountUser,
  syncPublicAppState,
  getPublicResultAvailability,
  getResultHistoryGameId,
  remotePredictionToLocal,
  scoreLineup,
  normalizePlayerKey,
  getHitCounts,
  createScoreBreakdown,
  normalizePosition,
  getPositionCategory,
  createPlayerNameHtml,
  formatPlayerNameForDisplay,
  createPredictionSummary,
  formatPublicJstDateTime,
  escapeHtml,
  LINEUP_SIZE,
  SCORE_MAX,
  // Results rendering can refresh the shared prediction surface through this
  // orchestration boundary, without reading or owning its state.
  afterRenderHistory: () => renderPublicPredictionSurface(state.predictionTargetGame,
    getPublicGameStatusView(state.predictionTargetGame, getEffectivePredictionDeadline()))
});
const publicRosterController = publicFrontend.createPublicRosterController({
  state,
  storage: publicStorage,
  storageKeys: STORAGE_KEYS,
  requestGuard: publicRequestGuard,
  getTargetInternalGameId: getGameDayRosterTargetInternalGameId,
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
const publicProbableStarterController = publicFrontend.createPublicProbableStarterController({
  probableStarter: state.probableStarter,
  getGames: () => state.publicGameCatalog.games,
  requestState: appState.requests.probable,
  requestGuard: publicRequestGuard,
  apiClient: publicApiClient,
  starterSourceUrl: NPB_STARTER_SOURCE_URL,
  getAuthApiBaseUrl,
  parseJstScheduleDateTime,
  isNormalManagedSchedule,
  isScheduleGameUnavailable,
  getScheduleSortValue,
  normalizeScheduleTeamCode,
  escapeHtml,
  formatDateTime,
  formatPlayerNameForDisplay
});
const publicPredictionFormController = publicFrontend.createPublicPredictionFormController({
  state,
  storage: publicStorage,
  storageKeys: STORAGE_KEYS,
  ensurePredictionEditingAllowed,
  updatePredictionSaveButton,
  clearMessage,
  getLineupValues,
  validateLineup: publicPredictionValidation.validateLineup,
  showMessage,
  markDuplicateSlots,
  getCurrentGameId,
  preserveDisplayedResult: publicResultsController.preserveDisplayedResult,
  renderSavedPrediction,
  renderPredictionCta,
  renderPredictionAccountStatus,
  renderPublicGameSelectionMeta,
  renderPicker,
  getPredictionAccountUser,
  getPredictionAccountStatus,
  waitForAuthInitialization: waitForPredictionAuthInitialization,
  showPredictionSaveMessage,
  savePredictionToAccount,
  setLineupValues,
  closeAllPositionMenus,
  renderScoreResult: publicResultsController.render,
  deletePredictionFromAccount
});

function schedulePublicNonCritical(callback) {
  if (typeof window?.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, { timeout: 1500 });
    return;
  }
  setTimeout(callback, 0);
}

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
    fetchPreviousResultGame: publicResultsController.fetchPrevious,
    startPredictionDeadlineTicker,
    initializeProbableStarter: publicProbableStarterController.initialize,
    initializeRosterCandidateSync,
    initializeAuthDependentFeatures,
    initializePredictionRemoteSync,
    initializeDailyBestNine: publicDailyBestNineController.initialize,
    refreshPredictionDeadlineState,
    refreshGameDayNoticeStatus,
    renderPredictionCta,
    renderDailyBestNine: publicDailyBestNineController.render,
    fetchDailyBestNine: publicDailyBestNineController.refresh,
    syncPredictionFromAccount,
    fetchUserAchievements,
    refreshResultHistory: publicResultsController.refresh,
    maybeLoadFastPreviousResult: publicResultsController.maybeLoadFastPrevious
  }
});
if (typeof window !== "undefined") {
  window.PublicAppCoordinator = publicFrontend.PublicAppCoordinator;
  window.publicAppState = appState;
  window.publicAppCoordinator = publicAppCoordinator;
}

document.addEventListener("DOMContentLoaded", () => {
  // The Asia Edition owns the public panel while it is selected. Do not let
  // the NPB coordinator hydrate hidden controls or overwrite shared auth UI.
  if (window.Starting9Edition?.active === window.Starting9Edition?.ASIA_CS
    || document.documentElement.dataset.starting9Edition === window.Starting9Edition?.ASIA_CS) return;
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
  schedulePublicNonCritical(() => {
    void Promise.allSettled([
      publicResultsController.fetchPrevious({ force: false }),
      publicResultsController.refresh({ force: false }),
      fetchUserAchievements({ force: false })
    ]).then((results) => {
      results.forEach((result, index) => {
        if (result.status === "rejected") {
          const labels = ["前回結果", "過去結果", "実績"];
          console.error(`${labels[index]}の初期化に失敗しました`, result.reason?.message || "unknown error");
        }
      });
    });
  });
}

function bindEvents() {
  document.getElementById("predictionForm").addEventListener("submit", handlePredictionSubmit);
  document.getElementById("resetPredictionButton").addEventListener("click", resetPredictionInput);
  document.getElementById("refreshAchievementsButton")?.addEventListener("click", () => fetchUserAchievements({ force: true }));
  document.getElementById("sharePredictionButton").addEventListener("click", sharePrediction);
  document.getElementById("saveSavedPredictionImageButton")?.addEventListener("click", saveSavedPredictionImage);
  document.getElementById("predictionCtaButton")?.addEventListener("click", handlePredictionCtaClick);
  document.getElementById("editSavedPredictionButton")?.addEventListener("click", scrollToPredictionForm);
  document.getElementById("publicGameSelectionMeta")?.addEventListener("click", handlePublicGameSelectionMetaClick);
  publicResultsController.bindEvents();
  document.addEventListener("pointermove", handlePointerInteractionMove, { passive: false });
  document.addEventListener("pointerup", handlePointerInteractionEnd);
  document.addEventListener("pointercancel", handlePointerInteractionCancel);
  document.addEventListener("touchstart", handleTouchInteractionStart, { passive: true });
  document.addEventListener("touchmove", handleTouchInteractionMove, { passive: false });
  document.addEventListener("touchend", handleTouchInteractionEnd, { passive: false });
  document.addEventListener("touchcancel", handleTouchInteractionCancel, { passive: false });
  window.addEventListener("resize", repositionOpenPositionMenu, { passive: true });
  window.visualViewport?.addEventListener("resize", repositionOpenPositionMenu, { passive: true });
  window.visualViewport?.addEventListener("scroll", repositionOpenPositionMenu, { passive: true });
  window.addEventListener("scroll", repositionOpenPositionMenu, { passive: true, capture: true });
  document.querySelectorAll("[data-roster-filter]").forEach((button) => {
    button.addEventListener("click", () => setCandidateRosterFilter(button.dataset.rosterFilter));
  });
  document.addEventListener("click", (event) => {
    const trigger = event?.target?.closest?.("[data-player-detail-only]");
    if (trigger) showPlayerDetails("prediction", trigger.dataset.playerDetailOnly, { allowSelect: false });
    closeAllPositionMenus();
  });
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
  return getPredictionCandidatePlayers()
    .filter((player) => window.Starting9LineupBuilder?.isLineupCandidate?.(player) ?? player.isBatterCandidate === true);
}

function isOfficialNpbPlayerId(value) {
  return /^npb:\d{8}$/i.test(String(value ?? "").trim());
}

function temporaryPublicPlayerCategory(position) {
  const normalized = String(position || "").normalize("NFKC").trim();
  if (normalized === "捕手") return "catcher";
  if (normalized === "内野手") return "infielder";
  if (normalized === "外野手") return "outfielder";
  return "";
}

function createTemporaryPublicPlayer(entry) {
  const category = temporaryPublicPlayerCategory(entry?.position);
  const playerId = String(entry?.playerId || "").trim().toLowerCase();
  const number = String(entry?.number || "").trim();
  const name = String(entry?.name || "").trim();
  if (!isOfficialNpbPlayerId(playerId) || !category || !/^\d{1,3}$/.test(number) || !name) return null;
  return {
    name,
    displayName: name,
    uniformNumber: number,
    playerId,
    teamCode: "fighters",
    teamId: "F",
    category,
    registeredPosition: entry.position,
    isBatterCandidate: true,
    predictionCandidateRole: "fielder",
    isTemporaryCandidate: true,
    identitySource: "npb-live"
  };
}

function getPredictionCandidatePlayers() {
  const candidatePlayers = [...players];
  const existingIds = new Set(candidatePlayers.map((player) => String(player?.playerId || "").trim()).filter(Boolean));
  // A live NPB roster may use a legacy initial prefix (for example Fレイエス)
  // while the canonical master keeps the short display name (レイエス). Only
  // an explicit alias with the same uniform number suppresses the temporary
  // candidate; name-only or number-only matching would risk merging players.
  const existingMasterKeys = new Set(candidatePlayers.flatMap((player) => {
    const number = String(player?.uniformNumber || "").trim();
    return [player?.name, ...(Array.isArray(player?.aliases) ? player.aliases : [])]
      .map((name) => `${normalizePlayerKey(name)}:${number}`);
  }));
  normalizeRosterEntries(state.publicRoster?.players).forEach((entry) => {
    const temporaryPlayer = createTemporaryPublicPlayer(entry);
    const masterKey = temporaryPlayer
      ? `${normalizePlayerKey(temporaryPlayer.name)}:${temporaryPlayer.uniformNumber}`
      : "";
    if (temporaryPlayer && !existingIds.has(temporaryPlayer.playerId) && !existingMasterKeys.has(masterKey)) {
      existingIds.add(temporaryPlayer.playerId);
      existingMasterKeys.add(masterKey);
      candidatePlayers.push(temporaryPlayer);
    }
  });
  return candidatePlayers;
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
    && roster.canUseForPrediction === true
    && ["official_live", "verified_snapshot", "stale_snapshot", "baseline_snapshot"].includes(String(roster.rosterUse || roster.sourceOfTruth || ""))
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
  (window.Starting9LineupBuilder?.positionValues || ["", ...positions]).forEach((position) => {
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
  menu._positionMenuHost = control;
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
    if (menu.classList.contains("is-portal-position-menu")) {
      openPositionMenuState = { menu, button };
    }
  }
}

function mountPositionMenuPortal(menu) {
  if (typeof document === "undefined" || !document.body) return;
  if (!menu._positionMenuHost) {
    menu._positionMenuHost = menu.parentElement;
  }
  if (menu.parentElement !== document.body) {
    document.body.appendChild(menu);
  }
  menu.classList.add("is-portal-position-menu");
}

function restorePositionMenuHost(menu) {
  const host = menu._positionMenuHost;
  if (host && menu.parentElement !== host) {
    host.appendChild(menu);
  }
  menu.classList.remove("is-portal-position-menu");
}

function getViewportClampedMenuLeft(preferredLeft, menuWidth, viewportWidth, viewportPadding = 8) {
  const padding = Math.max(0, Number(viewportPadding) || 0);
  const width = Math.max(0, Number(viewportWidth) || 0);
  const safeMenuWidth = Math.min(
    Math.max(0, Number(menuWidth) || 0),
    Math.max(0, width - padding * 2)
  );
  const maxLeft = Math.max(padding, width - safeMenuWidth - padding);
  return Math.min(Math.max(padding, Number(preferredLeft) || 0), maxLeft);
}

function getPositionMenuViewportSize() {
  const visualViewport = typeof window !== "undefined" ? window.visualViewport : null;
  const windowWidth = typeof window !== "undefined" ? Number(window.innerWidth) : 0;
  const windowHeight = typeof window !== "undefined" ? Number(window.innerHeight) : 0;
  const documentWidth = typeof document !== "undefined" ? Number(document.documentElement?.clientWidth) : 0;
  const documentHeight = typeof document !== "undefined" ? Number(document.documentElement?.clientHeight) : 0;
  return {
    width: Number(visualViewport?.width) || documentWidth || windowWidth || 0,
    height: Number(visualViewport?.height) || documentHeight || windowHeight || 0,
  };
}

function positionMobilePositionMenu(menu, button) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

  const isMobile = window.matchMedia("(max-width: 767px)").matches;
  mountPositionMenuPortal(menu);
  menu.classList.toggle("is-mobile-position-menu", isMobile);
  menu.classList.add("is-viewport-positioned");
  const viewportPadding = 8;
  const viewport = getPositionMenuViewportSize();
  const maxMenuWidth = Math.max(0, viewport.width - viewportPadding * 2);
  menu.style.right = "auto";
  menu.style.transform = "none";
  menu.style.maxWidth = `${maxMenuWidth}px`;
  menu.style.boxSizing = "border-box";
  const buttonRect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const left = getViewportClampedMenuLeft(buttonRect.left, menuRect.width, viewport.width, viewportPadding);
  const preferredTop = buttonRect.bottom + 6;
  const maxTop = viewport.height - menuRect.height - viewportPadding;
  const top = maxTop >= viewportPadding
    ? Math.min(preferredTop, maxTop)
    : viewportPadding;

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(Math.max(viewportPadding, top))}px`;
}

function repositionOpenPositionMenu() {
  const openMenu = openPositionMenuState;
  if (!openMenu || openMenu.menu.classList.contains("hidden")) return;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  if (!window.matchMedia("(max-width: 767px)").matches) {
    closeAllPositionMenus();
    return;
  }
  positionMobilePositionMenu(openMenu.menu, openMenu.button);
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
    menu.classList.remove("is-mobile-position-menu", "is-viewport-positioned");
    menu.style.removeProperty("left");
    menu.style.removeProperty("top");
    menu.style.removeProperty("right");
    menu.style.removeProperty("transform");
    menu.style.removeProperty("max-width");
    menu.style.removeProperty("box-sizing");
    restorePositionMenuHost(menu);
  });
  document.querySelectorAll(".position-button").forEach((button) => {
    button.setAttribute("aria-expanded", "false");
  });
  openPositionMenuState = null;
}

function createPlayerChip(pickerName, player) {
  const button = document.createElement("button");
  const playerName = typeof player === "object" && player !== null
    ? String(player.name || player.playerName || player.displayName || "")
    : String(player || "");
  button.className = "player-chip";
  button.type = "button";
  button.dataset.picker = pickerName;
  button.dataset.player = playerName;
  if (player && typeof player === "object" && player.playerId) button.dataset.playerId = String(player.playerId);
  button.title = formatPlayerNameForDisplay(player);
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
    detailButton.setAttribute("aria-label", `${formatPlayerNameForDisplay(player)}の詳細を開く`);
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
    assignPlayerToActiveSlot(pickerName, playerName);
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
  ghost.textContent = formatPlayerNameForDisplay(interaction.player);
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
  if (targetIndex < 0) return;
  const targetPosition = lineup[targetIndex]?.position || "";

  if (currentIndex !== -1 && currentIndex !== targetIndex) {
    lineup[currentIndex] = createLineupItem(currentIndex, "", "");
  }

  lineup[targetIndex] = createLineupItem(targetIndex, player, targetPosition);
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
  state.activeOrder[pickerName] = findNextEmptyIndex(movedLineup, targetIndex);
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
  state.activeOrder[pickerName] = findNextEmptyIndex(lineup, targetIndex);
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
  const activeIndex = Number.isInteger(state.activeOrder[pickerName])
    ? state.activeOrder[pickerName]
    : -1;

  if (activeIndex < 0) {
    return findFirstEmptyIndex(lineup);
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

  return -1;
}

function findFirstEmptyIndex(lineup) {
  for (let index = 0; index < LINEUP_SIZE; index += 1) {
    if (!lineup[index]?.player) {
      return index;
    }
  }

  return -1;
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
    sourceOfTruth: typeof snapshot?.sourceOfTruth === "string" ? snapshot.sourceOfTruth : "",
    rosterUse: typeof snapshot?.rosterUse === "string" ? snapshot.rosterUse : "",
    canUseForPrediction: snapshot?.canUseForPrediction === true,
    verified: snapshot?.verified === true,
    fingerprint: typeof snapshot?.fingerprint === "string" ? snapshot.fingerprint : "",
    verifiedAt: typeof snapshot?.verifiedAt === "string" ? snapshot.verifiedAt : "",
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
    const sourcePlayerId = String(source.playerId || "").trim().toLowerCase();
    const key = createRosterEntryKey({ playerId: sourcePlayerId, number: source.number, name: displayName });
    if (!displayName || !key || seen.has(key)) {
      return;
    }

    seen.add(key);
    const normalizedEntry = {
      position: String(source.position || "").trim(),
      number: String(source.number || "").trim(),
      name: displayName,
      ...(/^npb:\d{8}$/i.test(sourcePlayerId) ? { playerId: sourcePlayerId } : {})
    };
    const category = {
      "捕手": "catcher",
      "内野手": "infielder",
      "外野手": "outfielder"
    }[normalizedEntry.position] || "";
    if (category) {
      normalizedEntry.isBatterCandidate = true;
      normalizedEntry.predictionCandidateRole = "fielder";
    }
    const handSources = [source, source.handedness, source.metadata, source.meta, source.rawMetadata, source.raw];
    for (const handSource of handSources) {
      if (!handSource || typeof handSource !== "object") continue;
      ["bats", "battingSide", "batSide"].forEach((field) => {
        if (normalizedEntry[field] === undefined && handSource[field] !== undefined && handSource[field] !== null) {
          normalizedEntry[field] = String(handSource[field]).slice(0, 20);
        }
      });
    }
    if (typeof source.handedness === "string") normalizedEntry.handedness = source.handedness.slice(0, 40);
    normalizedEntries.push(normalizedEntry);
  });

  return normalizedEntries;
}

function createRosterEntryKey(player) {
  const playerId = String(player?.playerId || "").trim().toLowerCase();
  if (/^npb:\d{8}$/i.test(playerId)) return `id:${playerId}`;
  const number = String(player?.number || "").trim();
  return number ? `number:${number}` : `name:${normalizePlayerKey(player?.name)}`;
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

async function refreshPredictionTarget({ retryUnannounced = true, useServer = true } = {}) {
  const request = beginPublicRequest("target", { abort: true });
  const schedule = await getLoadedGameSchedule();
  const catalogGame = state.publicGameCatalog.games.length
    ? getPreferredPublicGameSelection()
    : null;
  const nextGame = catalogGame || await resolvePredictionTargetGame(schedule, useServer);
  if (!isCurrentPublicRequest("target", request.id)) return;
  const previousGame = state.predictionTargetGame;
  const previousGameId = state.predictionTargetGameId || previousGame?.internalGameId || "";
  if (!nextGame) {
    setPublicCurrentGame(null);
    renderAll();
    void initializeRosterCandidateSync();
    return;
  }
  if ((nextGame?.internalGameId || "") !== previousGameId) {
    setPublicCurrentGame(nextGame);
    state.predictionTargetNotice = nextGame ? "予想対象試合が次の試合へ切り替わりました。" : "";
    renderAll();
    void refreshGameDayNoticeStatus({ force: true });
    void initializeRosterCandidateSync();
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

function getFastPreviousResultGame() {
  const games = Array.isArray(state.publicGameCatalog.games) ? state.publicGameCatalog.games : [];
  const now = Date.now();
  return games
    .filter((game) => {
      if (!game?.internalGameId || !isPublicGamePublished(game)) return false;
      const startAt = game.startAt ? new Date(game.startAt) : parseJstScheduleDateTime(game);
      return startAt && !Number.isNaN(startAt.getTime()) && startAt.getTime() <= now;
    })
    .sort((left, right) => getScheduleSortValue(left).localeCompare(getScheduleSortValue(right)))
    .pop() || null;
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
  const unavailableToday = (Array.isArray(games) ? games : [])
    .filter((game) => getScheduleDate(game) === today && isScheduleGameUnavailable(game))
    .sort((left, right) => getScheduleSortValue(left).localeCompare(getScheduleSortValue(right)));
  const todayGames = selectable.filter((game) => getScheduleDate(game) === today);
  const todayUpcoming = todayGames.find((game) => {
    if (isPublicGamePublished(game)) return false;
    const startAt = game?.startAt ? new Date(game.startAt) : parseJstScheduleDateTime(game);
    return Number.isFinite(startAt?.getTime()) && startAt > now;
  });
  const todayOpen = todayGames.find((game) => !isPublicGamePublished(game)
    && resolvePredictionDeadline(game.internalGameId || game.gameId, now).status === "open");
  // 締切後・試合中の今日の試合も現在対象として維持します。
  // 締切を理由に次の受付中試合へ切り替えると、保存済み予想の表示対象まで変わります。
  const todayCurrent = todayGames.find((game) => !isPublicGamePublished(game));
  const nextOpen = selectable.find((game) => getScheduleDate(game) > today
    && !isPublicGamePublished(game)
    && resolvePredictionDeadline(game.internalGameId || game.gameId, now).status === "open");
  return todayCurrent || todayUpcoming || todayOpen || nextOpen || unavailableToday[0] || null;
}

function getPreferredPublicGameSelection(now = new Date()) {
  const games = Array.isArray(state.publicGameCatalog.games) ? state.publicGameCatalog.games : [];
  return selectInitialPublicGame(games, now);
}

function persistCurrentGameScopedState() {
  ["prediction", "actual", "result"].forEach((key) => {
    const value = state[key];
    if (value?.gameId || value?.internalGameId) saveGameScopedStorage(STORAGE_KEYS[key], value);
  });
}

function hydrateGameScopedState(gameId) {
  const normalizedGameId = String(gameId || "").trim();
  const prediction = normalizedGameId ? loadGameScopedStorage(STORAGE_KEYS.prediction) : null;
  const actual = normalizedGameId ? loadGameScopedStorage(STORAGE_KEYS.actual) : null;
  const result = normalizedGameId ? loadGameScopedStorage(STORAGE_KEYS.result) : null;
  state.prediction = prediction?.gameId === normalizedGameId ? prediction : null;
  state.actual = actual?.gameId === normalizedGameId ? actual : null;
  state.result = result?.gameId === normalizedGameId ? result : null;
}

function handlePublicGameSelectionMetaClick(event) {
  const retry = event.target instanceof Element ? event.target.closest("[data-public-games-retry]") : null;
  if (retry) {
    void initializePublicGameCatalog({ force: true });
  }
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

  if (changed) {
    persistCurrentGameScopedState();
    beginPublicRequest("account", { abort: true });
    state.predictionRemote = createEmptyPredictionRemoteState();
    state.prediction = null;
    state.actual = null;
    state.result = null;
    publicResultsController.preserveDisplayedResult();
  }

  state.predictionTargetGameId = nextId;
  state.predictionTargetGame = nextGame || null;
  state.predictionTargetNotice = changed && nextGame ? "予想対象試合が次の試合へ切り替わりました。" : "";
  if (changed) hydrateGameScopedState(nextId);
  discardStoredStateForGame(nextId);
  appState.currentGame = nextGame || null;
  appState.predictionForm.gameId = nextId;
  syncPublicAppState();
  return changed;
}

async function initializePublicGameCatalog({ force = false } = {}) {
  const catalog = state.publicGameCatalog;
  const previousGames = catalog.games;
  const request = beginPublicRequest("catalog", { abort: true });
  catalog.isLoading = true;
  catalog.message = "";
  try {
    let apiGames = [];
    const url = buildPublicGamesApiUrl();
    if (url) {
      const { response, payload } = await publicApiClient.getCached(url, {
        cacheKey: "public-games",
        ttlMs: PUBLIC_GAMES_SESSION_CACHE_TTL_MS,
        cache: force ? "no-store" : undefined,
        signal: request.signal
      });
      if (!response.ok || !payload?.ok || !Array.isArray(payload.games)) {
        throw new Error(payload?.error || `HTTP ${response.status}`);
      }
      apiGames = payload.games;
    } else {
      throw new Error("PUBLIC_GAMES_API_UNAVAILABLE");
    }
    if (!isCurrentPublicRequest("catalog", request.id)) return;
    catalog.games = mergePublicGameSchedules([], apiGames);
    catalog.message = "";
    const initialGame = getPreferredPublicGameSelection();
    setPublicCurrentGame(initialGame);
    refreshPredictionDeadlineState();
  } catch (error) {
    if (!isCurrentPublicRequest("catalog", request.id)) return;
    catalog.games = previousGames;
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

function normalizeScheduleTeamCode(value) {
  const key = String(value || "").trim().toLowerCase();
  return ["fighters", "buffaloes", "hawks", "lions", "eagles", "marines", "giants", "tigers", "baystars", "carp", "dragons", "swallows"].includes(key)
    ? key
    : "";
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
    publicProbableStarterController.refreshTarget();
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

function getPublicGameUnavailableKind(game) {
  const gameStatus = String(game?.gameStatus || "").toLowerCase();
  const status = String(game?.status || "").toLowerCase();
  const availability = String(game?.resultAvailability || "").toLowerCase();
  if (gameStatus === "service_unavailable" || status === "service_unavailable" || availability === "service_unavailable") return "service_unavailable";
  if (gameStatus === "no_game" || status === "no_game" || availability === "no_game") return "no_game";
  if (["cancelled", "canceled"].includes(gameStatus) || ["cancelled", "canceled"].includes(status)) return "cancelled";
  if (gameStatus === "postponed" || status === "postponed") return "postponed";
  if (game?.rankingExcluded === true || game?.rankingEligibilityStatus === "excluded" || status === "excluded" || availability === "excluded") return "excluded";
  return "";
}

function isScheduleGameUnavailable(game) {
  return Boolean(getPublicGameUnavailableKind(game));
}

function getPublicResultAvailability(result) {
  const kind = getPublicGameUnavailableKind(result);
  if (!kind) return null;
  if (kind === "service_unavailable") {
    return {
      key: kind,
      shortLabel: "対象外",
      title: "この試合はサービス対象外です",
      message: "この試合は予想・採点・ランキングの対象外です。"
    };
  }
  if (kind === "cancelled") {
    return {
      key: kind,
      shortLabel: "中止",
      title: "この試合は中止になりました",
      message: "この試合は予想・採点・ランキングの対象外です。"
    };
  }
  if (kind === "no_game") {
    return {
      key: kind,
      shortLabel: "ノーゲーム",
      title: "この試合はノーゲームになりました",
      message: "この試合は予想・採点・ランキングの対象外です。"
    };
  }
  return {
    key: "excluded",
    shortLabel: "対象外",
    title: "この試合は対象外です",
    message: "この試合は予想・採点・ランキングの対象外です。"
  };
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
      message: String(game?.status || game?.gameStatus || "").toLowerCase() === "service_unavailable"
        ? "この試合はサービス対象外です。予想・採点・ランキングの対象外です。"
        : String(game?.status || game?.gameStatus || "").toLowerCase() === "no_game"
          ? "この試合はノーゲームになりました。予想・採点・ランキングの対象外です。"
        : "この試合は中止になりました。予想・採点・ランキングの対象外です。",
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




async function initializePredictionRemoteSync() {
  await syncPredictionFromAccount({ force: true });
}

function getResultHistoryGameId(game) {
  return String(game?.resultId || game?.internalGameId || game?.gameId || "");
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

function getPredictionAccountStatus() {
  return window.starting9Auth?.getStatus?.() || {
    isInitialized: Boolean(window.starting9Auth?.isInitialized?.()),
    authenticated: Boolean(getPredictionAccountUser()),
    errorCode: "",
    errorStatus: 0
  };
}

function waitForPredictionAuthInitialization() {
  const auth = window.starting9Auth;
  const ready = typeof auth?.whenInitialized === "function"
    ? auth.whenInitialized()
    : window.starting9AuthReady;
  return ready && typeof ready.then === "function" ? ready : Promise.resolve();
}

function getPredictionAccountSaveErrorMessage(error) {
  const code = String(error?.code || "");
  const status = Number(error?.status || 0);
  if (code === "SESSION_EXPIRED" || code === "AUTH_SESSION_EXPIRED") {
    return "端末には保存しました。ログイン状態が切れているため、再ログインしてください。";
  }
  if (code === "AUTH_REQUIRED" || status === 401) {
    return "端末には保存しましたが、ログイン状態が切れています。再ログインしてください。";
  }
  if (status === 403) {
    return "端末には保存しましたが、アカウント保存の権限がありません。";
  }
  if (code === "PREDICTION_DEADLINE_PASSED" || code === "PREDICTION_CLOSED" || status === 409 && /受付|締切/.test(String(error?.message || ""))) {
    return "予想受付は終了しました。";
  }
  if (code === "INVALID_GAME_ID" || code === "INTERNAL_GAME_ID_REQUIRED" || code === "GAME_SCHEDULE_NOT_FOUND" || code === "GAME_ID_RESOLUTION_FAILED") {
    return "対象試合を確認できないため、アカウント保存できませんでした。";
  }
  if (code === "NETWORK_ERROR" || status === 0) {
    return "端末には保存しましたが、アカウント保存に失敗しました。通信状況を確認して再試行してください。";
  }
  if (code === "D1_READ_LIMIT_EXCEEDED" || status === 503) {
    return "端末には保存しましたが、データベースが一時的に混雑しています。時間をおいて再試行してください。";
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
    const payload = await publicPredictionPersistence.load(url, request.signal);
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
    const currentDeadline = getEffectivePredictionDeadline();
    const isPredictionClosed = remoteState.locked || currentDeadline.status === "closed";
    if (isPredictionClosed) {
      // 締切後はアカウント保存値を正本として表示し、端末側の古い下書きを採用しません。
      state.prediction = remoteState.prediction
        ? { ...remoteState.prediction, lineup: normalizeLineup(remoteState.prediction.lineup) }
        : null;
      if (state.prediction) {
        saveToStorage(STORAGE_KEYS.prediction, state.prediction);
      } else {
        removeFromStorage(STORAGE_KEYS.prediction);
      }
      publicResultsController.preserveDisplayedResult();
      renderSavedPrediction();
      renderPredictionCta();
      renderPublicGameSelectionMeta();
      renderPicker("prediction");
    } else if (remoteState.prediction && !state.prediction) {
      state.prediction = { ...remoteState.prediction, lineup: normalizeLineup(remoteState.prediction.lineup) };
      saveToStorage(STORAGE_KEYS.prediction, state.prediction);
      publicResultsController.preserveDisplayedResult();
      renderSavedPrediction();
      renderPredictionCta();
      renderPicker("prediction");
    }
    if (remoteState.prediction && Array.isArray(payload.actualLineup) && payload.status === "scored") {
      const actual = remotePredictionToLocal({ lineup: payload.actualLineup }, payload.scoredAt || "", gameId);
      state.result = { ...scoreLineup(remoteState.prediction.lineup, actual.lineup), gameId };
      saveToStorage(STORAGE_KEYS.result, state.result);
      publicResultsController.render();
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
  const matchedPlayers = getPredictionCandidatePlayers().filter((player) => normalizePlayerKey(player.name) === playerKey);
  return matchedPlayers.length === 1 ? matchedPlayers[0] : null;
}

function createPredictionPayload(prediction) {
  const lineup = normalizeLineup(prediction?.lineup || []);
  const serializedLineup = [];

  for (const item of lineup) {
    const player = getUniquePlayerData(item.player);
    const isTemporary = Boolean(player?.isTemporaryCandidate && isOfficialNpbPlayerId(player?.playerId));
    const teamCode = player?.teamCode || DEFAULT_PLAYER_TEAM_CODE;
    const uniformNumber = player?.uniformNumber;
    const teamId = TEAM_PLAYER_ID_PREFIXES[teamCode];
    const playerId = isTemporary ? String(player.playerId).trim().toLowerCase() : createPlayerId(teamCode, uniformNumber);

    // 古いlocalStorageの予想も、マスタ上で一意に一致する場合だけ補完します。
    if (!player || !teamId || !playerId || (isTemporary && teamCode !== "fighters")) {
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

async function savePredictionToAccount(prediction = state.prediction, { allowAuthProbe = false } = {}) {
  if (!ensurePredictionEditingAllowed()) {
    return false;
  }
  const user = getPredictionAccountUser();
  const gameId = getCurrentGameId();
  if (!user && !allowAuthProbe) {
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
    // Persistence owns only the API exchange; this function remains the sole app-state/UI coordinator.
    const payload = await publicPredictionPersistence.save(url, gameId, predictionPayload.prediction);

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
    if (Number(error?.status || 0) === 401 || error?.code === "AUTH_REQUIRED") {
      window.starting9Auth?.markSessionExpired?.();
    }
    state.predictionRemote.status = "error";
    state.predictionRemote.message = getPredictionAccountSaveErrorMessage(error)
      || "端末には保存しましたが、アカウント保存に失敗しました。";
    return false;
  } finally {
    state.predictionRemote.isSaving = false;
    updatePredictionSaveButton();
  }
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
    await publicPredictionPersistence.remove(url);
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

function scoreLineup(predictionLineup, actualLineup) {
  const normalizedPrediction = normalizeScoringLineup(predictionLineup);
  const normalizedActual = normalizeScoringLineup(actualLineup);
  const details = normalizedPrediction.map((predictionItem, index) => {
    const actualItem = findActualLineupItem(predictionItem, normalizedActual);
    const actualOrderItem = normalizedActual[index] || createLineupItem(index, "", "");
    const isInStartingLineup = Boolean(actualItem);
    const isExactOrder = Boolean(actualItem && actualItem.order === predictionItem.order);
    const isExactPosition = isInStartingLineup && actualItem.position === predictionItem.position;
    const isPerfect = isInStartingLineup && isExactOrder && isExactPosition;
    const point = (isInStartingLineup ? SCORE_RULES.player.perHit : 0) +
      (isExactOrder ? SCORE_RULES.order.perHit : 0) +
      (isExactPosition ? SCORE_RULES.position.perHit : 0) +
      (isPerfect ? SCORE_RULES.perfect.perHit : 0);

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
      isPerfect,
      point,
      mark: isPerfect ? "◎" : isInStartingLineup ? "◯" : "×",
      label: isPerfect ? "完全一致" : isInStartingLineup ? "スタメン入り" : "外れ"
    };
  });
  const counts = getHitCounts(details);
  const breakdown = createScoreBreakdown(counts);

  return {
    total: breakdown.player.total + breakdown.order.total + breakdown.position.total + breakdown.perfect.total,
    max: SCORE_MAX,
    counts,
    breakdown,
    details,
    predictionLineup: normalizedPrediction,
    actualLineup: normalizedActual,
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
    position: details.filter((detail) => detail.isPositionHit).length,
    perfect: details.filter((detail) => detail.isPlayerHit && detail.isOrderHit && detail.isPositionHit).length
  };
}

function createScoreBreakdown(counts) {
  const playerBase = counts.player * SCORE_RULES.player.perHit;
  const orderBase = counts.order * SCORE_RULES.order.perHit;
  const positionBase = counts.position * SCORE_RULES.position.perHit;
  const perfectHits = Number.isFinite(Number(counts.perfect)) ? Number(counts.perfect) : 0;
  const perfectBase = perfectHits * SCORE_RULES.perfect.perHit;

  return {
    player: {
      base: playerBase,
      total: playerBase,
      max: SCORE_RULES.player.max
    },
    order: {
      base: orderBase,
      total: orderBase,
      max: SCORE_RULES.order.max
    },
    position: {
      base: positionBase,
      total: positionBase,
      max: SCORE_RULES.position.max
    },
    perfect: {
      base: perfectBase,
      total: perfectBase,
      max: SCORE_RULES.perfect.max
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

  if (state.prediction?.lineup && state.actual?.lineup && publicPredictionValidation.hasCompletePositions(state.prediction.lineup) && publicPredictionValidation.hasCompletePositions(state.actual.lineup)) {
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
  publicProbableStarterController.render();
  renderSavedPrediction();
  renderPredictionCta();
  renderPredictionAccountStatus();
  renderPredictionDeadline();
  renderPredictionTargetNotice();
  renderAchievements();
  publicResultsController.renderHistory();
  publicResultsController.render();
  publicDailyBestNineController.render();
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
  const unavailableKind = getPublicGameUnavailableKind(game);
  if (unavailableKind) {
    return {
      key: "unavailable",
      label: unavailableKind === "service_unavailable" ? "サービス対象外" : unavailableKind === "excluded" ? "対象外" : "中止",
      status: unavailableKind === "service_unavailable"
        ? "この試合はサービス対象外です"
        : unavailableKind === "excluded" ? "この試合は対象外です" : "この試合は中止になりました",
      saved,
      nextAction: "この試合は予想・採点・ランキングの対象外です。"
    };
  }
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
    if (editor) editor.classList.toggle("hidden", !state.publicGameCatalog.isLoading);
    return;
  }
  const hasSavedPrediction = isSavedPredictionComplete(state.prediction)
    || isSavedPredictionComplete(state.predictionRemote?.prediction);
  const isClosedWithoutSavedPrediction = getEffectivePredictionDeadline().status === "closed" && !hasSavedPrediction;
  if (editor) editor.classList.toggle("hidden", isScheduleGameUnavailable(selectedGame) || isClosedWithoutSavedPrediction);
}

function renderPublicGameSelectionMeta() {
  const meta = document.getElementById("publicGameSelectionMeta");
  if (!meta) return;
  const game = state.predictionTargetGame || state.publicGameCatalog.games.find((item) => item.internalGameId === getCurrentGameId()) || null;
  const deadline = getEffectivePredictionDeadline();
  if (!game && !deadline.game) {
    if (state.publicGameCatalog.message) {
      meta.innerHTML = `<span role="alert">${escapeHtml(state.publicGameCatalog.message)}</span> <button type="button" class="secondary-button" data-public-games-retry>再試行</button>`;
      renderPublicPredictionSurface(null);
      return;
    }
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
    publicResultsController.render();
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
  const duplicatedPlayers = publicPredictionValidation.getDuplicatedPlayers(lineup);
  const duplicatedPositions = publicPredictionValidation.getDuplicatedPositions(lineup);
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
    slot.querySelectorAll(".position-menu-option").forEach((optionButton) => {
      optionButton.disabled = isLocked;
    });
  });

  document.querySelectorAll(`.player-chip[data-picker="${pickerName}"]`).forEach((chip) => {
    const isUsed = usedPlayers.has(chip.dataset.player);
    chip.classList.toggle("is-used", isUsed);
    chip.disabled = isLocked;
    chip.draggable = shouldUseNativeDrag(pickerName) && !isLocked;
  });

  if (pickerName === "prediction") {
    renderPredictionRosterFilter();
    document.querySelectorAll('[data-roster-filter]').forEach((button) => {
      button.disabled = isLocked;
    });
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
  const duplicatedPlayers = publicPredictionValidation.getDuplicatedPlayers(lineup);
  const duplicatedPositions = publicPredictionValidation.getDuplicatedPositions(lineup);
  document.querySelectorAll(`.lineup-slot[data-picker="${pickerName}"]`).forEach((slot) => {
    slot.classList.toggle("is-duplicate", duplicatedPlayers.has(slot.dataset.player) || duplicatedPositions.has(slot.dataset.position));
  });
}

function isSavedPredictionComplete(prediction) {
  if (!prediction || !Array.isArray(prediction.lineup)) {
    return false;
  }

  return normalizeLineup(prediction.lineup).every((item) => item.player && item.position);
}

function renderSavedPrediction() {
  const container = document.getElementById("savedPrediction");
  const editButton = document.getElementById("editSavedPredictionButton");
  const shareButton = document.getElementById("sharePredictionButton");
  const imageButton = document.getElementById("saveSavedPredictionImageButton");

  if (!isSavedPredictionComplete(state.prediction)) {
    setLineupValues("prediction", []);
    container.className = "empty-state";
    container.setAttribute("aria-readonly", "true");
    container.textContent = "まだ予想が保存されていません。";
    editButton?.classList.add("hidden");
    shareButton.classList.add("hidden");
    imageButton?.classList.add("hidden");
    return;
  }

  setLineupValues("prediction", state.prediction.lineup);
  const isReadOnly = isPredictionEditingLocked();
  container.className = `summary-box${isReadOnly ? " is-read-only" : ""}`;
  container.setAttribute("aria-readonly", isReadOnly ? "true" : "false");
  container.innerHTML = "";
  container.appendChild(createSavedPredictionPreview(state.prediction));
  editButton?.classList.toggle("hidden", isReadOnly);
  shareButton.classList.remove("hidden");
  imageButton?.classList.remove("hidden");
}

function renderPredictionCta() {
  const button = document.getElementById("predictionCtaButton");
  if (!button) return;
  const isLoggedIn = Boolean(getPredictionAccountUser());
  const hasPrediction = Boolean(state.prediction || state.predictionRemote?.prediction);
  const selectedGame = state.predictionTargetGame || null;
  button.classList.toggle("hidden", !isLoggedIn || !selectedGame || isPredictionEditingLocked());
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

function createPredictionSummary(prediction) {
  const wrapper = document.createElement("div");
  wrapper.className = "saved-lineup-summary";
  const title = document.createElement("strong");
  title.textContent = "保存済みのスタメン予想";

  const meta = document.createElement("div");
  meta.className = "summary-meta";
  meta.textContent = `最後に更新：${formatDateTime(prediction.savedAt)}`;

  const tableHeader = document.createElement("div");
  tableHeader.className = "saved-lineup-table-header";
  tableHeader.setAttribute("aria-hidden", "true");
  tableHeader.innerHTML = "<span>打順</span><span>守備</span><span>選手名</span>";

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
        <span class="saved-lineup-player-cell">
          ${createPlayerNameHtml(lineupItem.player, "saved-lineup-name")}
          ${createPlayerDetailTriggerHtml(lineupItem.player)}
        </span>
      </span>
    `;
    list.appendChild(listItem);
  });

  wrapper.append(title, meta, tableHeader, list);
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

function createSavedPredictionPreview(prediction) {
  const wrapper = document.createElement("div");
  wrapper.className = "saved-lineup-image";
  const title = document.createElement("strong");
  title.className = "saved-lineup-image-title";
  title.textContent = "保存済みのスタメン予想";
  const meta = document.createElement("div");
  meta.className = "saved-lineup-image-meta";
  meta.textContent = `最後に更新：${formatDateTime(prediction.savedAt)}`;
  const canvas = createSavedPredictionCanvas(prediction);
  if (!canvas) {
    wrapper.textContent = "保存済み予想を表示できませんでした。";
    return wrapper;
  }
  canvas.className = "saved-lineup-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "保存済みのスタメン予想。打順、守備位置、選手名を表示しています。");
  wrapper.append(title, meta, canvas);
  return wrapper;
}

function createSavedPredictionCanvas(prediction) {
  if (!prediction) return null;
  const displayWidth = Math.min(240, Math.max(208, (window.innerWidth || 240) - 32));
  const renderScale = 2;
  const canvasHeight = 476;
  const canvas = document.createElement("canvas");
  canvas.width = displayWidth * renderScale;
  canvas.height = canvasHeight * renderScale;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.scale(renderScale, renderScale);

  const colors = {
    navy: "#0b5ea8",
    gold: "#d5a11e",
    text: "#1c2d3f",
    muted: "#607284",
    row: "#f8fbff",
    border: "#b9cfe3",
    order: "#0b5ea8",
    name: "#ffffff",
    position: {
      "category-catcher": "#eaf5fc",
      "category-infielder": "#fff8df",
      "category-outfielder": "#eaf6ed",
      "category-dh": "#f9eaf2",
      empty: "#edf1f5"
    }
  };
  const drawRoundedRect = (x, y, width, height, radius, fill, stroke) => {
    const safeRadius = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + safeRadius, y);
    context.arcTo(x + width, y, x + width, y + height, safeRadius);
    context.arcTo(x + width, y + height, x, y + height, safeRadius);
    context.arcTo(x, y + height, x, y, safeRadius);
    context.arcTo(x, y, x + width, y, safeRadius);
    context.closePath();
    if (fill) {
      context.fillStyle = fill;
      context.fill();
    }
    if (stroke) {
      context.strokeStyle = stroke;
      context.stroke();
    }
  };
  const fitText = (value, maxWidth) => {
    const text = String(value || "");
    if (context.measureText(text).width <= maxWidth) return text;
    let fitted = text;
    while (fitted.length > 1 && context.measureText(`${fitted}…`).width > maxWidth) {
      fitted = fitted.slice(0, -1);
    }
    return `${fitted}…`;
  };
  const drawCenteredText = (value, x, y, width, font, color) => {
    context.font = font;
    context.fillStyle = color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(fitText(value, width), x + width / 2, y);
  };
  const drawLeftText = (value, x, y, width, font, color) => {
    context.font = font;
    context.fillStyle = color;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.fillText(fitText(value, width), x, y);
  };

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, displayWidth, canvasHeight);

  const tableX = 4;
  const tableY = 12;
  const tableWidth = displayWidth - 8;
  const headerHeight = 40;
  const rowHeight = 46;
  const orderWidth = 52;
  const positionWidth = 52;
  const nameWidth = tableWidth - orderWidth - positionWidth;
  context.lineWidth = 2;
  drawRoundedRect(tableX, tableY, tableWidth, headerHeight, 7, colors.navy, colors.navy);
  drawCenteredText("打順", tableX, tableY + headerHeight / 2, orderWidth, "900 14px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", "#ffffff");
  drawCenteredText("守備", tableX + orderWidth, tableY + headerHeight / 2, positionWidth, "900 14px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", "#ffffff");
  drawCenteredText("選手名", tableX + orderWidth + positionWidth, tableY + headerHeight / 2, nameWidth, "900 14px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", "#ffffff");

  normalizeLineup(prediction.lineup).forEach((lineupItem, index) => {
    const rowY = tableY + headerHeight + index * rowHeight;
    const normalizedPosition = normalizePosition(lineupItem.position);
    const category = normalizedPosition ? getPositionCategory(normalizedPosition) : "empty";
    context.fillStyle = index % 2 === 0 ? colors.row : "#f2f6fa";
    context.fillRect(tableX, rowY, tableWidth, rowHeight);
    context.strokeStyle = colors.border;
    context.strokeRect(tableX, rowY, tableWidth, rowHeight);
    drawRoundedRect(tableX + 5, rowY + 6, orderWidth - 10, rowHeight - 12, 4, colors.order, null);
    drawCenteredText(`${index + 1}`, tableX + 5, rowY + rowHeight / 2, orderWidth - 10, "800 17px \"Bahnschrift SemiBold\", \"Bahnschrift\", \"Arial Narrow Bold\", \"Arial Narrow\", Arial, sans-serif", "#ffffff");
    drawRoundedRect(tableX + orderWidth + 7, rowY + 6, positionWidth - 14, rowHeight - 12, 12, colors.position[category] || colors.position.empty, colors.border);
    drawCenteredText(normalizedPosition || "－", tableX + orderWidth + 7, rowY + rowHeight / 2, positionWidth - 14, "900 15px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", colors.text);
    drawRoundedRect(tableX + orderWidth + positionWidth + 3, rowY + 5, nameWidth - 6, rowHeight - 10, 5, colors.name, colors.border);
    drawCenteredText(formatPlayerNameForDisplay(lineupItem.player || "未選択"), tableX + orderWidth + positionWidth + 3, rowY + rowHeight / 2, nameWidth - 6, "800 17px \"Yu Gothic\", \"Noto Sans JP\", sans-serif", colors.text);
  });

  return canvas;
}

function getSavedPredictionImageFilename(prediction) {
  const dateToken = String(prediction?.savedAt || "")
    .slice(0, 10)
    .replace(/[^0-9]/g, "") || "saved-lineup";
  return `starting9-prediction-${dateToken}.png`;
}

function createPngBlob(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas?.toBlob !== "function") {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      resolve(blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" }));
    }, "image/png");
  });
}

function downloadPredictionImage(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();

  // iOS Safari may ignore download= for a generated blob. Opening the PNG keeps
  // the output usable as an image even when the browser cannot download it.
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent || "")
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIos) {
    const imageWindow = window.open(url, "_blank", "noopener,noreferrer");
    if (!imageWindow) showMessage("predictionError", "画像を開けませんでした。もう一度お試しください。");
  }
  window.setTimeout(() => URL.revokeObjectURL(url), isIos ? 60_000 : 1_000);
}

async function saveSavedPredictionImage() {
  const prediction = state.prediction;
  if (!prediction) {
    showMessage("predictionError", "保存する予想がありません。");
    return;
  }

  const canvas = document.querySelector("#savedPrediction canvas.saved-lineup-canvas") || createSavedPredictionCanvas(prediction);
  if (!canvas) {
    showMessage("predictionError", "画像を生成できませんでした。");
    return;
  }

  const filename = getSavedPredictionImageFilename(prediction);
  const blob = await createPngBlob(canvas);
  if (!blob) {
    showMessage("predictionError", "画像を生成できませんでした。");
    return;
  }

  const file = typeof File === "function"
    ? new File([blob], filename, { type: "image/png" })
    : null;
  let canShareFiles = false;
  try {
    canShareFiles = Boolean(file)
      && typeof navigator.share === "function"
      && (!navigator.canShare || navigator.canShare({ files: [file] }));
  } catch {
    canShareFiles = false;
  }
  if (canShareFiles) {
    try {
      await navigator.share({
        files: [file],
        title: "Starting9 保存済み予想"
      });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }

  downloadPredictionImage(blob, filename);
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
    ...lineup.map((item, index) => `${index + 1}番 ${item.position} ${formatPlayerNameForDisplay(item.player)}`),
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
  const source = playerName && typeof playerName === "object" ? playerName : null;
  const rawName = source?.name || source?.playerName || source?.displayName || playerName;
  const playerKey = normalizePlayerKey(rawName);
  const masterPlayer = players.find((player) => normalizePlayerKey(player.name) === playerKey) || null;
  const rosterPlayer = normalizeRosterEntries(state.publicRoster?.players).find((player) => normalizePlayerKey(player.name) === playerKey) || null;
  const sourcePlayer = source && playerKey ? source : null;
  const mergedPlayer = masterPlayer && rosterPlayer
    ? { ...masterPlayer, ...rosterPlayer, ...sourcePlayer }
    : masterPlayer || rosterPlayer || sourcePlayer;
  const playerDetails = publicFrontend.getPlayerDetails?.(mergedPlayer || rawName);
  return playerDetails ? { ...(mergedPlayer || {}), ...playerDetails } : mergedPlayer;
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
  return createPlayerNameHtml(playerName);
}

function createPlayerDetailTriggerHtml(playerName) {
  const player = getPlayerData(playerName);
  if (!player || !window.Starting9Public?.getPlayerDetails?.(player)) return "";
  return `<button type="button" class="player-detail-inline-button" data-player-detail-only="${escapeHtml(player.name || playerName)}">詳細</button>`;
}

function createPlayerNameHtml(playerName, baseClass = "player-name") {
  const player = getPlayerData(playerName);
  if (window.Starting9LineupBuilder?.renderPlayerName) {
    return window.Starting9LineupBuilder.renderPlayerName(player || playerName, escapeHtml, baseClass);
  }
  const battingClass = window.Starting9Public?.getPlayerBattingClass?.(player) || "";
  const uniformNumber = window.Starting9Public?.getPlayerUniformNumber?.(player) || "";
  const classes = [baseClass, battingClass].filter(Boolean).join(" ");
  const numberMarkup = uniformNumber ? `<span class="player-number" aria-hidden="true">[${escapeHtml(uniformNumber)}]</span> ` : "";
  return `<span class="${classes}">${numberMarkup}${escapeHtml(formatPlayerNameForDisplay(playerName, player))}</span>`;
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

function showPlayerDetails(pickerName, playerName, { allowSelect = true } = {}) {
  const player = getPlayerData(playerName);
  const panel = document.getElementById(`${pickerName}PlayerDetails`);

  if (!panel || !player) {
    return;
  }

  const npbasePlayerUrl = getNpbasePlayerUrl(player);
  const positions = createPlayerPositionBadgesHtml(player.name);
  const detailRows = [
    ["背番号", player.uniformNumber],
    ["登録区分", player.registrationType],
    ["カテゴリ", player.category],
    ["生年月日", player.birthDate],
    ["身長/体重", player.heightCm && player.weightKg ? `${player.heightCm}cm / ${player.weightKg}kg` : ""],
    ["投打", player.throwingHand && player.battingHand ? `${player.throwingHand}投${player.battingHand}打` : ""],
    ["備考", player.note]
  ].filter(([, value]) => String(value || "").trim());
  const detailMeta = detailRows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  panel.className = "player-detail-overlay";
  panel.setAttribute("aria-hidden", "false");
  panel.innerHTML = `
    <div class="player-detail-dialog" role="document">
      <div class="player-detail-header">
        <div>
          <p class="player-detail-kicker">選手詳細</p>
          <h2 id="playerDetailTitle">${escapeHtml(formatPlayerNameForDisplay(player))}</h2>
        </div>
        <button class="player-detail-close" type="button" aria-label="選手詳細を閉じる">×</button>
      </div>
      <dl class="player-detail-meta">
        ${detailMeta || `<div><dt>登録区分</dt><dd>${escapeHtml(player.registeredPosition || "未設定")}</dd></div>`}
      </dl>
      <div class="player-detail-positions">
        <strong>守備候補</strong>
        ${positions}
      </div>
      <div class="player-detail-links">
        <a href="${escapeHtml(npbasePlayerUrl)}" target="_blank" rel="noopener noreferrer">選手成績を見る（NPBase）</a>
      </div>
      ${allowSelect ? '<button class="primary-button player-detail-select" type="button">この選手を選択</button>' : ""}
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
