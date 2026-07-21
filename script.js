const STORAGE_KEYS = {
  prediction: "hamStarting9Prediction",
  actual: "hamStarting9Actual",
  result: "hamStarting9Result",
  gameInfo: "hamStarting9GameInfo",
  rosterSnapshot: "hamStarting9RosterSnapshot"
};
const RESET_STORAGE_KEYS = [
  STORAGE_KEYS.prediction,
  STORAGE_KEYS.actual,
  STORAGE_KEYS.result
];

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
const NPB_WORKER_API_URL = "https://starting9-npb-fetch.tanzana7.workers.dev/";
const NPB_STARTER_SOURCE_URL = "https://npb.jp/announcement/starter/";
const NPB_WORKER_FALLBACK_MESSAGE = "NPB公式ページ取得APIが未設定、または取得に失敗しました。NPB公式ページの「最新のオーダー」部分をコピーして、下の貼り付け欄に入力してください。";
const NPB_WORKER_EXTRACTION_FAILED_MESSAGE = "WorkerでNPB公式ページは取得できましたが、スタメン抽出に失敗しました。手動貼り付けを使うか、debug=1付きURLで抽出対象テキストを確認してください。";
// DBには全員を保存し、通常画面では先着3人だけ表示します。
const PERFECT_ACHIEVERS_DEFAULT_DISPLAY_LIMIT = 3;
const RANKING_DISPLAY_LIMIT = 50;
const MONTHLY_RANKING_MIN_YEAR = 2020;
const YEARLY_RANKING_MIN_YEAR = 2020;
const AUTO_FETCH_START_BEFORE_MS = 50 * 60 * 1000;
const AUTO_FETCH_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_FETCH_MAX_ATTEMPTS = 5;
const ROSTER_MONITOR_INTERVAL_MS = 10 * 60 * 1000;
const ROSTER_MONITOR_MAX_ATTEMPTS = 6;
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
let autoScoringCountdownTimerId = null;
let predictionSaveMessageTimerId = null;
const TEST_PREDICTION_LINEUP = [
  { order: 1, player: "大塚瑠晏", position: "遊" },
  { order: 2, player: "清宮幸太郎", position: "一" },
  { order: 3, player: "レイエス", position: "指" },
  { order: 4, player: "吉田賢吾", position: "中" },
  { order: 5, player: "水谷瞬", position: "左" },
  { order: 6, player: "野村佑希", position: "三" },
  { order: 7, player: "宮崎一樹", position: "右" },
  { order: 8, player: "田宮裕涼", position: "捕" },
  { order: 9, player: "細川凌平", position: "二" }
];
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
    matchup: ""
  },
  nextScheduleId: "",
  actualPreview: null,
  adminStatus: "idle",
  adminError: "",
  appMode: "normal",
  isAdminMode: false,
  adminAccess: {
    status: "inactive",
    requestId: 0
  },
  developmentAccess: {
    available: false,
    status: "inactive",
    info: null,
    message: ""
  },
  achievements: {
    isLoading: false,
    requestId: 0,
    items: [],
    message: ""
  },
  developmentAchievements: {
    isLoading: false,
    items: [],
    earned: [],
    message: ""
  },
  autoFetch: {
    isRunning: false,
    timerId: null,
    attempts: 0,
    startedAt: "",
    lastCheckedAt: "",
    lastError: "",
    sourceUrl: "",
    gameStartAt: "",
    nextRunAt: "",
    status: "stopped",
    logs: [],
    validationChecks: [],
    workerMeta: null
  },
  rosterMonitor: {
    isRunning: false,
    timerId: null,
    attempts: 0,
    maxAttempts: ROSTER_MONITOR_MAX_ATTEMPTS,
    startedAt: "",
    lastCheckedAt: "",
    lastFetchedAt: "",
    lastError: "",
    nextRunAt: "",
    status: "stopped",
    stopReason: "",
    lastStatus: "none",
    lastMessage: "",
    lastAddedPlayers: [],
    lastRemovedPlayers: [],
    lastPlayerCount: 0
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
    logs: [],
    fetchedGameId: ""
  },
  perfectAchievers: {
    isLoading: false,
    isSubmitting: false,
    status: "idle",
    message: "",
    gameId: "",
    displayLimit: PERFECT_ACHIEVERS_DEFAULT_DISPLAY_LIMIT,
    totalCount: 0,
    currentUserRegistered: false,
    achievers: []
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
  rankingView: "yearly",
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
  predictionRemote: {
    isLoading: false,
    isSaving: false,
    isDeleting: false,
    status: "idle",
    message: "",
    gameId: "",
    prediction: null,
    submittedAt: "",
    updatedAt: "",
    locked: false,
    conflict: false
  },
  adminScoring: {
    isLoadingSummary: false,
    isTesting: false,
    isScoring: false,
    gameId: "",
    predictionCount: null,
    scoredCount: null,
    summaryMessage: "",
    preview: null,
    previewFingerprint: ""
  },
  autoScoring: {
    isSaving: false,
    isLoading: false,
    isRunningNow: false,
    isUpdating: false,
    gameId: "",
    record: null,
    message: ""
  },
  activeOrder: {
    prediction: 0,
    actual: 0
  },
  flickStart: new Map()
};

document.addEventListener("DOMContentLoaded", () => {
  removeLegacyAdminQueryParameter();
  state.isAdminMode = false;
  // 後続の画面初期化とは独立して、認証復元完了後の初回管理者判定を予約します。
  void initializeAuthDependentFeatures();
  buildLineupPicker("prediction", "predictionLineup", "predictionPlayers");
  buildLineupPicker("actual", "actualLineup", "actualPlayers");
  loadState();
  bindEvents();
  startAutoScoringCountdown();
  window.addEventListener("ham-schedule-log-updated", renderScheduleLoadLog);
  renderScheduleLoadLog();
  restoreAdminGameInfoInputs();
  applyAdminMode();
  renderAll();

  const scheduleReady = window.HAM_GAME_SCHEDULE_READY;
  if (scheduleReady && typeof scheduleReady.then === "function") {
    scheduleReady.then(() => {
      if (window.HAM_GAME_SCHEDULE_ERROR) {
        setScheduleLoaderMessage(window.HAM_GAME_SCHEDULE_ERROR, "error");
      }
      initializeGameSchedule();
      renderAll();
    });
  } else {
    initializeGameSchedule();
    renderAll();
  }
  initializeProbableStarter().finally(() => {
    initializePerfectAchievers();
    initializePredictionRemoteSync();
    initializeYearlyRanking();
    void initializeRosterCandidateSync();
  });
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
  await fetchUserAchievements({ force: true });
  await refreshYearlyRanking({ force: true });
  await refreshAdminAccess();
}

function bindEvents() {
  document.getElementById("predictionForm").addEventListener("submit", handlePredictionSubmit);
  document.getElementById("resetPredictionButton").addEventListener("click", resetPredictionInput);
  bindAdminEvent("actualForm", "submit", handleActualSubmit);
  bindAdminEvent("fetchNpbButton", "click", handleNpbFetchCandidate);
  bindAdminEvent("checkRosterButton", "click", handleRosterCheck);
  bindAdminEvent("startRosterMonitorButton", "click", startRosterMonitor);
  bindAdminEvent("stopRosterMonitorButton", "click", () => stopRosterMonitor("ロースター自動取得を停止しました。", "warning"));
  bindAdminEvent("fetchProbableStarterButton", "click", () => fetchProbableStarter({ force: true }));
  bindAdminEvent("startAutoFetchButton", "click", startAutoFetch);
  bindAdminEvent("stopAutoFetchButton", "click", () => stopAutoFetch("自動取得を停止しました。", "warning"));
  bindAdminEvent("parseActualButton", "click", handleActualParsePreview);
  bindAdminEvent("applyParsedActualButton", "click", applyParsedActualPreview);
  bindAdminEvent("clearActualCandidateButton", "click", clearActualCandidate);
  bindAdminEvent("approveProvisionalButton", "click", approveProvisionalActual);
  bindAdminEvent("editProvisionalButton", "click", editProvisionalActual);
  bindAdminEvent("cancelProvisionalButton", "click", cancelProvisionalActual);
  bindAdminEvent("testServerScoringButton", "click", runServerScoringPreview);
  bindAdminEvent("runServerScoringButton", "click", runServerScoring);
  bindAdminEvent("runAutoScoringNowButton", "click", runAutoScoringNow);
  bindAdminEvent("retryAutoScoringButton", "click", retryAutoScoring);
  bindAdminEvent("cancelAutoScoringButton", "click", cancelAutoScoring);
  bindDevelopmentEvent("generateTestPredictionButton", "click", generateTestPrediction);
  bindDevelopmentEvent("createPerfectPredictionButton", "click", createDevelopmentPerfectPrediction);
  bindDevelopmentEvent("runDevelopmentCronButton", "click", runDevelopmentCron);
  bindDevelopmentEvent("resetButton", "click", resetAllData);
  document.getElementById("refreshAchievementsButton")?.addEventListener("click", () => fetchUserAchievements({ force: true }));
  bindDevelopmentEvent("refreshDevelopmentAchievementsButton", "click", refreshDevelopmentAchievements);
  document.getElementById("developmentAchievements")?.addEventListener("click", handleDevelopmentAchievementAction);
  document.getElementById("sharePredictionButton").addEventListener("click", sharePrediction);
  document.getElementById("shareResultButton").addEventListener("click", shareResult);
  document.getElementById("openAdminButton")?.addEventListener("click", openAdminPanel);
  document.getElementById("openDevelopmentButton")?.addEventListener("click", openDevelopmentPanel);
  document.getElementById("showYearlyRankingButton")?.addEventListener("click", () => selectRankingView("yearly"));
  document.getElementById("showMonthlyRankingButton")?.addEventListener("click", () => selectRankingView("monthly"));
  document.getElementById("rankingContent")?.addEventListener("click", handleRankingPeriodContentClick);
  document.getElementById("closeAdminButton")?.addEventListener("click", closeAdminPanel);
  document.getElementById("adminToDevelopmentButton")?.addEventListener("click", openDevelopmentPanel);
  document.getElementById("closeDevelopmentButton")?.addEventListener("click", closeDevelopmentPanel);
  document.getElementById("developmentToAdminButton")?.addEventListener("click", openAdminPanel);
  document.getElementById("adminDetails")?.addEventListener("toggle", handleAdminDetailsToggle);
  document.getElementById("developmentDetails")?.addEventListener("toggle", handleDevelopmentDetailsToggle);
  document.getElementById("registerPerfectAchieverButton")?.addEventListener("click", registerPerfectAchiever);
  bindAdminEvent("loadNextGameButton", "click", loadNextGameSchedule);
  bindAdminEvent("loadTodayGameButton", "click", loadTodayGameSchedule);
  bindAdminEvent("loadSelectedGameButton", "click", loadSelectedGameSchedule);
  bindAdminEvent("gameScheduleSelect", "change", handleScheduleSelectionChange);
  bindAdminEvent("copyScheduleLogButton", "click", copyScheduleLoadLog);
  bindAdminEvent("clearScheduleLogButton", "click", clearScheduleLoadLog);
  bindAdminGameInfoEvents();
  document.addEventListener("click", () => closeAllPositionMenus());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAllPositionMenus();
    }
  });
}

function removeLegacyAdminQueryParameter() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("admin")) {
    return;
  }

  url.searchParams.delete("admin");
  window.history.replaceState(window.history.state, "", url);
}

function bindAdminEvent(elementId, eventName, handler) {
  const element = document.getElementById(elementId);
  if (!element) {
    return;
  }

  element.addEventListener(eventName, (event) => {
    if (!state.isAdminMode) {
      event.preventDefault();
      return;
    }
    handler(event);
  });
}

function bindDevelopmentEvent(elementId, eventName, handler) {
  const element = document.getElementById(elementId);
  if (!element) return;
  element.addEventListener(eventName, (event) => {
    if (state.appMode !== "development" || !state.developmentAccess.available) {
      event.preventDefault();
      return;
    }
    handler(event);
  });
}

function applyAdminMode() {
  const adminDetails = document.getElementById("adminDetails");
  const developmentDetails = document.getElementById("developmentDetails");
  const adminModeBadge = document.getElementById("adminModeBadge");
  const openAdminButton = document.getElementById("openAdminButton");
  const openDevelopmentButton = document.getElementById("openDevelopmentButton");
  const adminToDevelopmentButton = document.getElementById("adminToDevelopmentButton");
  const appLayout = document.querySelector(".app-layout");
  const isAuthorized = state.adminAccess.status === "authorized";
  const isAdminScreenOpen = state.appMode === "admin";
  const isDevelopmentScreenOpen = state.appMode === "development";

  if (adminDetails) {
    adminDetails.classList.toggle("hidden", !isAdminScreenOpen);
    adminDetails.open = isAdminScreenOpen;
    adminDetails.setAttribute("aria-hidden", isAdminScreenOpen ? "false" : "true");
  }

  if (adminModeBadge) {
    adminModeBadge.classList.toggle("hidden", !isAdminScreenOpen && !isDevelopmentScreenOpen);
    adminModeBadge.classList.toggle("is-development", isDevelopmentScreenOpen);
    adminModeBadge.textContent = isDevelopmentScreenOpen ? "開発モード" : "管理者モード";
  }

  if (developmentDetails) {
    developmentDetails.classList.toggle("hidden", !isDevelopmentScreenOpen);
    developmentDetails.open = isDevelopmentScreenOpen;
    developmentDetails.setAttribute("aria-hidden", isDevelopmentScreenOpen ? "false" : "true");
  }

  if (openAdminButton) {
    const shouldShowButton = isAuthorized && state.appMode === "normal";
    openAdminButton.classList.toggle("hidden", !shouldShowButton);
    openAdminButton.setAttribute("aria-hidden", shouldShowButton ? "false" : "true");
  }
  if (openDevelopmentButton) {
    const shouldShowButton = isAuthorized && state.developmentAccess.available && state.appMode === "normal";
    openDevelopmentButton.classList.toggle("hidden", !shouldShowButton);
    openDevelopmentButton.setAttribute("aria-hidden", shouldShowButton ? "false" : "true");
  }
  if (adminToDevelopmentButton) {
    const shouldShowButton = isAuthorized && state.developmentAccess.available && isAdminScreenOpen;
    adminToDevelopmentButton.classList.toggle("hidden", !shouldShowButton);
    adminToDevelopmentButton.setAttribute("aria-hidden", shouldShowButton ? "false" : "true");
  }

  appLayout?.classList.toggle("is-admin-screen", isAdminScreenOpen);
  appLayout?.classList.toggle("is-development-screen", isDevelopmentScreenOpen);

  state.isAdminMode = isAdminScreenOpen;
  if (state.appMode === "normal") {
    stopAutoFetch("", "");
    stopRosterMonitor("", "", "inactive");
  }
}

function buildAdminMeApiUrl() {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/admin/me` : "";
}

function isAuthStateInitialized() {
  const auth = window.starting9Auth;
  return typeof auth?.isInitialized === "function" && auth.isInitialized();
}

function clearAdminAccess() {
  state.adminAccess.status = "inactive";
  state.developmentAccess = { available: false, status: "inactive", info: null, message: "" };
  state.developmentAchievements = { isLoading: false, items: [], earned: [], message: "" };
  state.appMode = "normal";
  state.isAdminMode = false;
  applyAdminMode();
}

async function refreshAdminAccess() {
  const requestId = state.adminAccess.requestId + 1;
  state.adminAccess.requestId = requestId;
  if (!isAuthStateInitialized()) {
    state.adminAccess.status = "checking";
    state.isAdminMode = false;
    applyAdminMode();
    return;
  }

  if (!getPredictionAccountUser()) {
    clearAdminAccess();
    return;
  }

  const url = buildAdminMeApiUrl();
  if (!url) {
    clearAdminAccess();
    return;
  }

  state.adminAccess.status = "checking";
  state.isAdminMode = false;
  applyAdminMode();

  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (requestId !== state.adminAccess.requestId) {
      return;
    }
    if (response.ok && payload?.ok && payload?.admin) {
      state.adminAccess.status = "authorized";
      await refreshDevelopmentCapabilities(requestId);
      applyAdminMode();
      return;
    }

    clearAdminAccess();
    return;
  } catch (error) {
    if (requestId !== state.adminAccess.requestId) {
      return;
    }
    console.error("管理者権限の確認に失敗しました", error.message);
    clearAdminAccess();
    return;
  }
}

async function refreshDevelopmentCapabilities(requestId) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) {
    state.developmentAccess = { available: false, status: "disabled", info: null, message: "" };
    if (state.appMode === "development") state.appMode = "normal";
    return;
  }
  try {
    const response = await fetch(`${baseUrl}/api/admin/mode-capabilities`, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (requestId !== state.adminAccess.requestId) return;
    if (!response.ok || !payload?.ok) {
      state.developmentAccess = { available: false, status: "disabled", info: null, message: "" };
      if (state.appMode === "development") state.appMode = "normal";
      return;
    }
    state.developmentAccess.available = payload.developmentModeAvailable === true;
    state.developmentAccess.status = state.developmentAccess.available ? "available" : "disabled";
    if (!state.developmentAccess.available && state.appMode === "development") {
      state.appMode = "normal";
    }
  } catch (error) {
    console.error("開発モードの利用可否確認に失敗しました", error.message);
    state.developmentAccess = { available: false, status: "disabled", info: null, message: "" };
    if (state.appMode === "development") state.appMode = "normal";
  }
}

function buildDevelopmentApiUrl(path) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/dev/${path.replace(/^\/+/, "")}` : "";
}

function formatDevelopmentValue(value, fallback = "-") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function renderDevelopmentPanel() {
  const info = document.getElementById("developmentInfo");
  const message = document.getElementById("developmentMessage");
  const createButton = document.getElementById("createPerfectPredictionButton");
  const cronButton = document.getElementById("runDevelopmentCronButton");
  if (!info || !message || !createButton || !cronButton) return;

  const details = state.developmentAccess.info;
  const autoScoring = details?.autoScoring;
  const user = getPredictionAccountUser();
  const gameId = getAdminScoringGameId();
  const canOperate = state.appMode === "development" && state.developmentAccess.available;
  createButton.disabled = !canOperate || !gameId;
  cronButton.disabled = !canOperate;
  message.textContent = state.developmentAccess.message || "";

  const rows = [
    ["API base URL", getAuthApiBaseUrl() || "未設定"],
    ["開発モード", details?.developmentModeEnabled ? "有効" : "確認中"],
    ["AUTO_SCORING_DELAY_SECONDS", formatDevelopmentValue(details?.autoScoringDelaySeconds)],
    ["appMode", state.appMode],
    ["ログイン中 userId", formatDevelopmentValue(user?.id)],
    ["role", state.adminAccess.status === "authorized" ? "admin" : "-"],
    ["選択中 gameId", gameId || "未選択"],
    ["実スタメン保存状態", autoScoring ? "保存済み" : "未保存"],
    ["scoring_status", formatDevelopmentValue(autoScoring?.status)],
    ["scoring_due_at", formatDevelopmentValue(autoScoring?.scoringDueAt)],
    ["scored_at", formatDevelopmentValue(autoScoring?.scoredAt)],
    ["scoring_attempts", formatDevelopmentValue(autoScoring?.attempts, "0")],
    ["last_error", formatDevelopmentValue(autoScoring?.lastError)],
    ["lineup fingerprint", formatDevelopmentValue(autoScoring?.lineupFingerprint)]
  ];
  info.innerHTML = `<dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

async function refreshDevelopmentStatus() {
  if (state.adminAccess.status !== "authorized" || !state.developmentAccess.available) return;
  const gameId = getAdminScoringGameId();
  const url = buildDevelopmentApiUrl(`status${gameId ? `?gameId=${encodeURIComponent(gameId)}` : ""}`);
  if (!url) return;
  state.developmentAccess.message = "開発情報を取得中...";
  renderDevelopmentPanel();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.developmentAccess.info = payload;
    state.developmentAccess.message = "開発情報を更新しました。";
  } catch (error) {
    console.error("開発情報の取得に失敗しました", error.message);
    state.developmentAccess.message = "開発情報を取得できませんでした。";
  }
  renderDevelopmentPanel();
}

async function createDevelopmentPerfectPrediction() {
  const gameId = getAdminScoringGameId();
  if (!gameId) {
    state.developmentAccess.message = "対象試合を選択してください。";
    renderDevelopmentPanel();
    return;
  }
  if (!window.confirm(`ログイン中の管理者ユーザーの ${gameId} の予想を、保存済み実スタメンと完全一致する内容で上書きします。よろしいですか？`)) return;
  const url = buildDevelopmentApiUrl(`games/${encodeURIComponent(gameId)}/create-perfect-prediction`);
  if (!url) return;
  state.developmentAccess.message = "完全一致予想を作成中...";
  renderDevelopmentPanel();
  try {
    const response = await fetch(url, { method: "POST", credentials: "include" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.developmentAccess.message = payload.created ? "完全一致予想を作成しました。" : "既存の予想を完全一致予想で更新しました。";
    await syncPredictionFromAccount({ force: true });
  } catch (error) {
    console.error("完全一致予想の作成に失敗しました", error.message);
    state.developmentAccess.message = "完全一致予想を作成できませんでした。";
  }
  await refreshDevelopmentStatus();
}

async function runDevelopmentCron() {
  if (!window.confirm("自動採点のCron処理を手動で実行します。よろしいですか？")) return;
  const url = buildDevelopmentApiUrl("cron/run-auto-scoring");
  if (!url) return;
  state.developmentAccess.message = "Cron処理を実行中...";
  renderDevelopmentPanel();
  try {
    const response = await fetch(url, { method: "POST", credentials: "include" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.developmentAccess.message = `Cron処理が完了しました。処理 ${payload.processed || 0}件 / 成功 ${payload.succeeded || 0}件 / 失敗 ${payload.failed || 0}件`;
  } catch (error) {
    console.error("開発用Cron実行に失敗しました", error.message);
    state.developmentAccess.message = "Cron処理を実行できませんでした。";
  }
  await refreshDevelopmentStatus();
}

const ACHIEVEMENT_RARITY_LABELS = Object.freeze({
  common: "通常",
  rare: "レア",
  epic: "エピック",
  limited: "限定"
});

const ACHIEVEMENT_ICONS = Object.freeze({
  beta: "B",
  first_prediction: "1",
  perfect: "P"
});

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

function createAchievementCardHtml(achievement, { includeDelete = false } = {}) {
  const rarity = ACHIEVEMENT_RARITY_LABELS[achievement.rarity] ? achievement.rarity : "common";
  const icon = ACHIEVEMENT_ICONS[achievement.iconKey] || "*";
  const earned = achievement.earnedAt ? `<p class="achievement-earned">獲得：${escapeHtml(formatDateTime(achievement.earnedAt))}</p>` : "";
  const remove = includeDelete && achievement.source === "development"
    ? `<button class="secondary-button compact-button" type="button" data-achievement-remove="${escapeHtml(achievement.code)}">テスト付与を削除</button>`
    : "";
  return `<article class="achievement-card is-${escapeHtml(rarity)}">
    <span class="achievement-icon" aria-hidden="true">${escapeHtml(icon)}</span>
    <div class="achievement-body">
      <p class="achievement-rarity">${escapeHtml(ACHIEVEMENT_RARITY_LABELS[rarity])}</p>
      <h3>${escapeHtml(achievement.name)}</h3>
      <p>${escapeHtml(achievement.description)}</p>
      ${earned}
      ${remove}
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

function renderDevelopmentAchievements() {
  const container = document.getElementById("developmentAchievements");
  if (!container) return;
  const developer = state.developmentAchievements;
  if (developer.isLoading) {
    container.innerHTML = '<p class="achievement-empty">実績情報を取得中...</p>';
    return;
  }
  if (developer.message) {
    container.innerHTML = `<p class="achievement-empty">${escapeHtml(developer.message)}</p>`;
    return;
  }
  const earnedByCode = new Map(developer.earned.map((achievement) => [achievement.code, achievement]));
  if (!developer.items.length) {
    container.innerHTML = '<p class="achievement-empty">実績マスタを取得できませんでした。</p>';
    return;
  }
  container.innerHTML = developer.items.map((achievement) => {
    const earned = earnedByCode.get(achievement.code);
    return createAchievementCardHtml(earned || achievement, { includeDelete: Boolean(earned) });
  }).join("");
}

async function refreshDevelopmentAchievements() {
  if (state.appMode !== "development" || !state.developmentAccess.available) return;
  const url = buildDevelopmentApiUrl("achievements");
  if (!url) return;
  state.developmentAchievements.isLoading = true;
  state.developmentAchievements.message = "";
  renderDevelopmentAchievements();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !Array.isArray(payload.achievements) || !Array.isArray(payload.earned)) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.developmentAchievements.items = payload.achievements;
    state.developmentAchievements.earned = payload.earned;
  } catch (error) {
    console.error("開発用実績情報の取得に失敗しました", error.message);
    state.developmentAchievements.items = [];
    state.developmentAchievements.earned = [];
    state.developmentAchievements.message = "実績情報を取得できませんでした。";
  } finally {
    state.developmentAchievements.isLoading = false;
    renderDevelopmentAchievements();
  }
}

async function grantDevelopmentAchievement(code) {
  if (!window.confirm("ログイン中の管理者自身へテスト実績を付与します。よろしいですか？")) return;
  const url = buildDevelopmentApiUrl("achievements/grant-test");
  if (!url) return;
  state.developmentAchievements.message = "テスト実績を付与中...";
  renderDevelopmentAchievements();
  let resultMessage = "";
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    resultMessage = payload.granted ? "テスト実績を付与しました。" : "この実績は既に取得済みです。";
  } catch (error) {
    console.error("テスト実績の付与に失敗しました", error.message);
    resultMessage = "テスト実績を付与できませんでした。";
  }
  await Promise.all([fetchUserAchievements({ force: true }), refreshDevelopmentAchievements()]);
  state.developmentAchievements.message = resultMessage;
  renderDevelopmentAchievements();
}

async function removeDevelopmentAchievement(code) {
  if (!window.confirm("development由来のテスト実績を削除します。よろしいですか？")) return;
  const url = buildDevelopmentApiUrl(`achievements/${encodeURIComponent(code)}/test-grant`);
  if (!url) return;
  let resultMessage = "";
  try {
    const response = await fetch(url, { method: "DELETE", credentials: "include" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    resultMessage = payload.removed ? "テスト実績を削除しました。" : "削除できるテスト実績はありません。";
  } catch (error) {
    console.error("テスト実績の削除に失敗しました", error.message);
    resultMessage = "テスト実績を削除できませんでした。";
  }
  await Promise.all([fetchUserAchievements({ force: true }), refreshDevelopmentAchievements()]);
  state.developmentAchievements.message = resultMessage;
  renderDevelopmentAchievements();
}

function handleDevelopmentAchievementAction(event) {
  if (state.appMode !== "development" || !state.developmentAccess.available) return;
  const target = event.target instanceof Element ? event.target.closest("[data-achievement-grant], [data-achievement-remove]") : null;
  if (!target) return;
  const grantCode = target.dataset.achievementGrant;
  const removeCode = target.dataset.achievementRemove;
  if (grantCode) void grantDevelopmentAchievement(grantCode);
  if (removeCode) void removeDevelopmentAchievement(removeCode);
}

function openAdminPanel() {
  if (state.adminAccess.status !== "authorized") {
    return;
  }

  state.appMode = "admin";
  applyAdminMode();
  initializeGameSchedule();
  renderAll();
  refreshAdminScoringSummary({ force: true });
  refreshAutoScoringStatus({ force: true });
}

function closeAdminPanel() {
  if (state.appMode !== "admin") {
    return;
  }

  state.appMode = "normal";
  applyAdminMode();
}

function openDevelopmentPanel() {
  if (state.adminAccess.status !== "authorized" || !state.developmentAccess.available) return;
  state.appMode = "development";
  applyAdminMode();
  renderDevelopmentPanel();
  void refreshDevelopmentStatus();
  void refreshDevelopmentAchievements();
}

function closeDevelopmentPanel() {
  if (state.appMode !== "development") return;
  state.appMode = "normal";
  applyAdminMode();
}

function handleAdminDetailsToggle(event) {
  if (!event.currentTarget.open && state.appMode === "admin") {
    closeAdminPanel();
  }
}

function handleDevelopmentDetailsToggle(event) {
  if (!event.currentTarget.open && state.appMode === "development") {
    closeDevelopmentPanel();
  }
}

function bindAdminGameInfoEvents() {
  ["npbUrlInput", "gameStartInput", "matchupInput"].forEach((elementId) => {
    const input = document.getElementById(elementId);
    if (!input) {
      return;
    }

    input.addEventListener("input", saveAdminGameInfoFromInputs);
    input.addEventListener("change", saveAdminGameInfoFromInputs);
  });
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
    setActiveOrder(pickerName, index);
    showSlotPlayerDetails(pickerName, slot);
  });
  slot.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActiveOrder(pickerName, index);
      showSlotPlayerDetails(pickerName, slot);
    }
  });
  slot.addEventListener("dragover", handleSlotDragOver);
  slot.addEventListener("dragenter", () => slot.classList.add("is-drop-target"));
  slot.addEventListener("dragleave", () => slot.classList.remove("is-drop-target"));
  slot.addEventListener("drop", (event) => handleSlotDrop(event, slot));

  const order = document.createElement("span");
  order.className = "slot-order";
  order.textContent = `${index + 1}番`;

  const dragHandle = document.createElement("button");
  dragHandle.className = "slot-drag-handle";
  dragHandle.type = "button";
  dragHandle.draggable = false;
  dragHandle.textContent = "⠿";
  dragHandle.setAttribute("aria-label", `${index + 1}番をドラッグして並び替え`);
  dragHandle.addEventListener("click", (event) => event.stopPropagation());
  dragHandle.addEventListener("dragstart", (event) => handleSlotDragStart(event, slot));
  dragHandle.addEventListener("dragend", (event) => handleDragEnd(event, slot));

  const player = document.createElement("span");
  player.className = "slot-player slot-empty";
  player.textContent = "未選択";
  player.addEventListener("click", (event) => {
    event.stopPropagation();
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

  slot.append(dragHandle, order, player, positionControl, clearButton);
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
  button.textContent = "?";
  button.setAttribute("aria-label", `${index + 1}番の守備位置を選択`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", menuId);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (button.dataset.skipClick === "true") {
      button.dataset.skipClick = "false";
      return;
    }
    togglePositionMenu(menu, button, pickerName, index);
  });
  button.addEventListener("dragstart", (event) => handlePositionDragStart(event, button, slot));
  button.addEventListener("dragend", (event) => handlePositionDragEnd(event, button));

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
  const shouldOpen = menu.classList.contains("hidden");
  closeAllPositionMenus();

  if (shouldOpen) {
    updatePositionMenuState(menu, pickerName, index);
    menu.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
  }
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
  button.draggable = true;
  button.innerHTML = createPlayerLabelHtml(player);
  applyPlayerCategoryClass(button, player);

  button.addEventListener("click", () => {
    if (button.dataset.skipClick === "true") {
      button.dataset.skipClick = "false";
      return;
    }

    showPlayerDetails(pickerName, player);
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
    kind: "player",
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

  const position = slot.dataset.position;

  if (!position) {
    event.preventDefault();
    return;
  }

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
  autoFillPredictionPosition(pickerName, lineup, targetIndex);
  setLineupValues(pickerName, lineup);
  state.activeOrder[pickerName] = findNextEmptyIndex(lineup, targetIndex);
  renderPicker(pickerName);
}

function assignPlayerToSlot(pickerName, player, targetIndex, sourceIndex) {
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
  const movingPosition = hasSource ? movedLineup[sourceIndex]?.position || "" : replacedItem?.position || "";

  if (hasSource && sourceIndex !== targetIndex) {
    movedLineup[sourceIndex] = createLineupItem(sourceIndex, replacedItem?.player || "", replacedItem?.position || "");
  } else if (currentIndex !== -1 && currentIndex !== targetIndex) {
    movedLineup[currentIndex] = createLineupItem(currentIndex, "", movedLineup[currentIndex]?.position || "");
  }

  movedLineup[targetIndex] = createLineupItem(targetIndex, player, movingPosition);
  return movedLineup;
}

function movePositionBetweenSlots(pickerName, sourceIndex, targetIndex) {
  const lineup = getLineupValues(pickerName);
  const movedLineup = moveLineupPosition(lineup, sourceIndex, targetIndex);
  setLineupValues(pickerName, movedLineup);
  state.activeOrder[pickerName] = targetIndex;
  clearMessage(pickerName === "prediction" ? "predictionError" : "actualError");
  renderPicker(pickerName);
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
  let availablePosition = "";
  for (const position of player.positions) {
    const normalizedPosition = normalizePosition(position);

    if (AUTO_FILL_POSITIONS.has(normalizedPosition) && !usedPositions.has(normalizedPosition)) {
      availablePosition = normalizedPosition;
      break;
    }

    if (normalizeDisplayPosition(position) === "外") {
      const unusedOutfieldPositions = OUTFIELD_POSITIONS.filter((outfieldPosition) => !usedPositions.has(outfieldPosition));
      if (unusedOutfieldPositions.length === 1) {
        availablePosition = unusedOutfieldPositions[0];
        break;
      }
    }
  }

  if (availablePosition) {
    lineup[targetIndex] = createLineupItem(targetIndex, player.name, availablePosition);
  }
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
  setNpbFetchMessage("", "");

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
  setNpbFetchMessage("", "");

  if (!state.actualPreview) {
    showMessage("parserError", "先に貼り付け内容をプレビューしてください。");
    return;
  }
  if (state.actual?.lineup?.length === LINEUP_SIZE && !window.confirm("登録済みの実スタメンを上書きします。自動採点の対象にも影響します。よろしいですか？")) {
    return;
  }

  setLineupValues("actual", state.actualPreview);
  state.actual = {
    lineup: normalizeLineup(state.actualPreview),
    savedAt: new Date().toISOString(),
    approvalStatus: "approved",
    approvedAt: new Date().toISOString(),
    registeredBy: "manual"
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
  void saveApprovedActualLineupForAutoScoring();
}

function clearActualCandidate() {
  state.actualPreview = null;
  state.adminError = "";
  state.adminStatus = getAdminStatusFromActual();
  clearMessage("parserError");
  clearMessage("actualError");
  setNpbFetchMessage("", "");
  renderAdminFlow();
}

async function handleNpbFetchCandidate() {
  clearMessage("parserError");
  clearMessage("actualError");
  clearMessage("resetMessage");
  saveAdminGameInfoFromInputs();

  const input = document.getElementById("npbUrlInput");
  const validation = validateNpbUrl(input.value);

  if (!validation.ok) {
    setNpbFetchMessage(validation.message, "error");
    return;
  }

  if (validation.warning) {
    setNpbFetchMessage(validation.warning, "warning");
  } else {
    setNpbFetchMessage("NPB公式ページ取得APIへ問い合わせ中...", "info");
  }

  if (!NPB_WORKER_API_URL) {
    showNpbFetchFallback("NPB公式ページ取得APIが未設定です。手動で貼り付けてください。");
    return;
  }

  try {
    const candidate = await fetchNpbLineupCandidate(validation.url);
    if (!candidate.ok) {
      if (candidate.type === "extract") {
        showNpbExtractionFailedFallback(validation.url, candidate.message);
      } else {
        showNpbFetchFallback("取得できませんでした。手動で貼り付けてください。");
      }
      return;
    }

    const parseResult = parseActualLineupText(candidate.lineupText);
    if (!parseResult.ok) {
      throw new Error(parseResult.message);
    }

    document.getElementById("actualPasteInput").value = candidate.lineupText;
    state.actualPreview = parseResult.lineup;
    state.adminStatus = "preview";
    state.adminError = "";
    renderAdminFlow();
    setNpbFetchMessage("候補スタメンを取得しました。内容を確認して承認してください。", "success");
  } catch (error) {
    console.warn("NPB公式ページ取得APIから候補を取得できませんでした。", error);
    showNpbFetchFallback("取得できませんでした。手動で貼り付けてください。");
  }
}

async function fetchNpbLineupCandidate(sourceUrl) {
  if (!NPB_WORKER_API_URL) {
    return { ok: false, type: "config", message: "NPB公式ページ取得APIが未設定です。" };
  }

  try {
    const response = await fetch(buildNpbWorkerRequestUrl(sourceUrl), { cache: "no-store" });
    if (!response.ok) {
      return { ok: false, type: "network", message: `Worker APIの取得に失敗しました。HTTP ${response.status}` };
    }

    const result = await response.json();
    if (!result.ok || !result.lineupText) {
      return { ok: false, type: "extract", message: result.error || "最新のオーダーを抽出できませんでした。" };
    }

    return {
      ok: true,
      sourceUrl: result.sourceUrl || sourceUrl,
      fetchedAt: result.fetchedAt || "",
      method: result.method || "",
      team: result.team || result.targetTeam || "",
      lineupText: result.lineupText
    };
  } catch (error) {
    return { ok: false, type: "network", message: error.message };
  }
}

async function handleRosterCheck() {
  if (!state.isAdminMode) {
    console.warn("管理者モードではないため、1軍登録状況の確認を中止しました。");
    return;
  }

  const button = document.getElementById("checkRosterButton");
  clearMessage("resetMessage");
  setNpbFetchMessage("1軍登録状況を確認中です...", "info");
  addAutoFetchLog("1軍登録状況を確認しました。");

  if (button) {
    button.disabled = true;
  }

  try {
    await performRosterCheck({ setStatusMessage: true });
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function performRosterCheck(options = {}) {
  const rosterResult = await fetchNpbRosterSnapshot();
  if (!rosterResult.ok) {
    const previousSnapshot = normalizeRosterSnapshot(loadFromStorage(STORAGE_KEYS.rosterSnapshot));
    state.rosterMonitor.lastCheckedAt = new Date().toISOString();
    state.rosterMonitor.lastFetchedAt = previousSnapshot.fetchedAt;
    state.rosterMonitor.lastError = rosterResult.message;
    state.rosterMonitor.lastStatus = "error";
    state.rosterMonitor.lastMessage = `取得失敗：${rosterResult.message}`;
    state.rosterMonitor.lastAddedPlayers = [];
    state.rosterMonitor.lastRemovedPlayers = [];
    if (options.isAuto) {
      state.rosterMonitor.status = "errorStopped";
      state.rosterMonitor.stopReason = "error";
      state.rosterMonitor.isRunning = false;
      state.rosterMonitor.nextRunAt = "";
      addAutoFetchLog("ロースター自動取得をエラーで停止しました。");
    }
    addAutoFetchLog(`1軍登録状況の取得失敗：${rosterResult.message}`);
    if (previousSnapshot.players.length) {
      addAutoFetchLog(`前回成功したロースターを継続利用します：${formatDateTime(previousSnapshot.fetchedAt)}`);
    }
    if (options.setStatusMessage) {
      setNpbFetchMessage(`1軍登録状況を取得できませんでした：${rosterResult.message}`, "error");
    }
    updateRosterMonitorButtons();
    renderRosterMonitorSummary();
    return { ok: false, message: rosterResult.message };
  }

  const previousSnapshot = normalizeRosterSnapshot(loadFromStorage(STORAGE_KEYS.rosterSnapshot));
  if (rosterResult.warning && canUseRosterSnapshot(previousSnapshot)) {
    state.rosterMonitor.lastCheckedAt = new Date().toISOString();
    state.rosterMonitor.lastFetchedAt = previousSnapshot.fetchedAt;
    state.rosterMonitor.lastError = rosterResult.warning;
    state.rosterMonitor.lastStatus = "warning";
    state.rosterMonitor.lastMessage = `取得警告：${rosterResult.warning}`;
    state.rosterMonitor.lastAddedPlayers = [];
    state.rosterMonitor.lastRemovedPlayers = [];
    addAutoFetchLog(`1軍登録状況の解析警告：${rosterResult.warning}`);
    addAutoFetchLog(`前回成功したロースターを継続利用します：${formatDateTime(previousSnapshot.fetchedAt)}`);
    if (options.setStatusMessage) {
      setNpbFetchMessage("1軍登録状況の解析に警告があるため、前回成功データを使用しています。", "warning");
    }
    renderPicker("prediction");
    updateRosterMonitorButtons();
    renderRosterMonitorSummary();
    return { ok: false, message: rosterResult.warning };
  }

  const diff = applyRosterSnapshotDiff(rosterResult);
  state.rosterMonitor.lastCheckedAt = new Date().toISOString();
  state.rosterMonitor.lastFetchedAt = rosterResult.fetchedAt || state.rosterMonitor.lastCheckedAt;
  state.rosterMonitor.lastError = "";
  state.rosterMonitor.lastStatus = "success";
  state.rosterMonitor.lastAddedPlayers = diff.added;
  state.rosterMonitor.lastRemovedPlayers = diff.removed;
  state.rosterMonitor.lastPlayerCount = rosterResult.players.length;
  state.rosterMonitor.lastMessage = createRosterMonitorResultMessage(rosterResult, diff);
  if (options.setStatusMessage) {
    setNpbFetchMessage(`1軍登録状況を確認しました。登録選手数：${rosterResult.players.length}人`, "success");
  }
  renderPicker("prediction");
  renderRosterMonitorSummary();
  return { ok: true, rosterResult, diff };
}

async function fetchNpbRosterSnapshot() {
  if (!NPB_WORKER_API_URL) {
    return { ok: false, message: "NPB公式ページ取得APIが未設定です。" };
  }

  try {
    const response = await fetch(buildNpbRosterRequestUrl(), { cache: "no-store" });
    if (!response.ok) {
      return { ok: false, message: `Worker APIの取得に失敗しました。HTTP ${response.status}` };
    }

    const result = await response.json();
    if (!result.ok || !Array.isArray(result.players) || result.players.length === 0) {
      return { ok: false, message: result.error || "日本ハムの登録選手一覧を抽出できませんでした。" };
    }

    return {
      ok: true,
      sourceUrl: result.sourceUrl || "",
      fetchedAt: result.fetchedAt || new Date().toISOString(),
    method: result.method || "",
    team: result.team || "",
    warning: result.warning || "",
    httpStatus: Number(result.httpStatus) || 0,
    cacheStatus: String(result.cacheStatus || ""),
    stale: result.stale === true,
    parsedCount: Number(result.parsedCount) || result.players.length,
    announcedCount: Number(result.announcedCount) || 0,
    count: Number(result.count) || result.players.length,
      players: normalizeRosterEntries(result.players)
    };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

function buildNpbRosterRequestUrl() {
  const workerUrl = new URL(NPB_WORKER_API_URL);
  workerUrl.searchParams.set("mode", "roster");
  return workerUrl.href;
}

function startRosterMonitor() {
  if (!state.isAdminMode) {
    console.warn("管理者モードではないため、ロースター自動取得を開始しません。");
    return;
  }

  if (state.rosterMonitor.isRunning) {
    return;
  }

  clearMessage("resetMessage");
  state.rosterMonitor = {
    isRunning: true,
    timerId: null,
    attempts: 0,
    maxAttempts: ROSTER_MONITOR_MAX_ATTEMPTS,
    startedAt: new Date().toISOString(),
    lastCheckedAt: "",
    lastFetchedAt: "",
    lastError: "",
    nextRunAt: "",
    status: "waiting",
    stopReason: "",
    lastStatus: "none",
    lastMessage: "",
    lastAddedPlayers: [],
    lastRemovedPlayers: [],
    lastPlayerCount: 0
  };

  addAutoFetchLog("ロースター自動取得を開始しました。10分ごとに1軍登録状況を確認します。");
  setNpbFetchMessage("ロースター自動取得を開始しました。", "info");
  scheduleNextRosterCheck(0);
  updateRosterMonitorButtons();
  renderRosterMonitorSummary();
}

function stopRosterMonitor(message, type, reason = "manual") {
  if (state.rosterMonitor.timerId) {
    clearTimeout(state.rosterMonitor.timerId);
  }

  state.rosterMonitor.isRunning = false;
  state.rosterMonitor.timerId = null;
  state.rosterMonitor.nextRunAt = "";
  state.rosterMonitor.stopReason = reason;
  if (reason === "maxAttempts") {
    state.rosterMonitor.status = "maxAttempts";
  } else if (reason === "error") {
    state.rosterMonitor.status = "errorStopped";
  } else if (reason === "inactive" || reason === "reset") {
    state.rosterMonitor.status = "stopped";
  } else {
    state.rosterMonitor.status = "manualStopped";
  }

  updateRosterMonitorButtons();
  if (message) {
    addAutoFetchLog(message);
    setNpbFetchMessage(message, type || "info");
  }
  renderRosterMonitorSummary();
}

function scheduleNextRosterCheck(delay = ROSTER_MONITOR_INTERVAL_MS) {
  if (!state.rosterMonitor.isRunning) {
    return;
  }

  const nextRunAt = new Date(Date.now() + delay).toISOString();
  state.rosterMonitor.status = "waiting";
  state.rosterMonitor.nextRunAt = nextRunAt;
  state.rosterMonitor.timerId = setTimeout(runRosterMonitorCheck, delay);
  updateRosterMonitorButtons();
  renderRosterMonitorSummary();
}

async function runRosterMonitorCheck() {
  if (!state.rosterMonitor.isRunning) {
    return;
  }

  state.rosterMonitor.attempts += 1;
  state.rosterMonitor.lastCheckedAt = new Date().toISOString();
  state.rosterMonitor.nextRunAt = "";
  state.rosterMonitor.status = "fetching";
  addAutoFetchLog("ロースター取得開始");
  updateRosterMonitorButtons();
  renderRosterMonitorSummary();

  const result = await performRosterCheck({ isAuto: true });
  if (result.ok && state.rosterMonitor.isRunning) {
    state.rosterMonitor.status = "waiting";
    if (state.rosterMonitor.attempts >= state.rosterMonitor.maxAttempts) {
      stopRosterMonitor("ロースター自動取得を最大試行回数到達で停止しました。", "warning", "maxAttempts");
      return;
    }
    addAutoFetchLog(`次回ロースター確認予定：${formatDateTime(new Date(Date.now() + ROSTER_MONITOR_INTERVAL_MS).toISOString())}`);
  }

  if (state.rosterMonitor.isRunning) {
    scheduleNextRosterCheck();
  }
}

function createRosterMonitorResultMessage(rosterResult, diff) {
  const changeMessage = diff.added.length || diff.removed.length
    ? `追加 ${diff.added.length}人 / 削除 ${diff.removed.length}人`
    : "変更なし";

  return `登録選手数：${rosterResult.players.length}人 / ${changeMessage}`;
}

function applyRosterSnapshotDiff(rosterResult) {
  const previousSnapshot = normalizeRosterSnapshot(loadFromStorage(STORAGE_KEYS.rosterSnapshot));
  const currentSnapshot = {
    fetchedAt: rosterResult.fetchedAt,
    sourceUrl: rosterResult.sourceUrl,
    method: rosterResult.method,
    warning: rosterResult.warning,
    httpStatus: rosterResult.httpStatus,
    cacheStatus: rosterResult.cacheStatus,
    stale: rosterResult.stale,
    parsedCount: rosterResult.parsedCount,
    announcedCount: rosterResult.announcedCount,
    players: rosterResult.players
  };

  if (!previousSnapshot.players.length) {
    saveToStorage(STORAGE_KEYS.rosterSnapshot, currentSnapshot);
    addAutoFetchLog("1軍登録状況を初回保存しました。");
    addAutoFetchLog(`登録選手数：${currentSnapshot.players.length}人`);
    if (currentSnapshot.warning) {
      addAutoFetchLog(`警告：${currentSnapshot.warning}`);
    }
    renderRosterSnapshotSummary(currentSnapshot, { added: [], removed: [] });
    return { added: [], removed: [] };
  }

  const diff = diffRosterPlayers(previousSnapshot.players, currentSnapshot.players);
  saveToStorage(STORAGE_KEYS.rosterSnapshot, currentSnapshot);

  if (!diff.added.length && !diff.removed.length) {
    addAutoFetchLog("1軍登録状況に変更はありません。");
    if (currentSnapshot.warning) {
      addAutoFetchLog(`警告：${currentSnapshot.warning}`);
    }
    renderRosterSnapshotSummary(currentSnapshot, diff);
    return diff;
  }

  diff.added.forEach((player) => addAutoFetchLog(`追加：${player}`));
  diff.removed.forEach((player) => addAutoFetchLog(`削除：${player}`));
  if (currentSnapshot.warning) {
    addAutoFetchLog(`警告：${currentSnapshot.warning}`);
  }
  renderRosterSnapshotSummary(currentSnapshot, diff);
  return diff;
}

function normalizeRosterSnapshot(snapshot) {
  return {
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
  return Number.isFinite(fetchedAtMs) && now - fetchedAtMs >= 0 && now - fetchedAtMs < ROSTER_SNAPSHOT_CACHE_TTL_MS;
}

function canUseRosterSnapshot(snapshot) {
  return Boolean(snapshot?.players?.length) && !snapshot.warning;
}

function isPlayerInCurrentRoster(player) {
  const snapshot = normalizeRosterSnapshot(loadFromStorage(STORAGE_KEYS.rosterSnapshot));
  if (!canUseRosterSnapshot(snapshot)) {
    return player?.isActiveRoster === true;
  }

  return snapshot.players.some((entry) => rosterEntryMatchesPlayer(entry, player));
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
  const snapshot = normalizeRosterSnapshot(loadFromStorage(STORAGE_KEYS.rosterSnapshot));
  renderPicker("prediction");
  if (canUseRosterSnapshot(snapshot) && isRosterSnapshotFresh(snapshot)) {
    return;
  }

  const result = await performRosterCheck();
  if (!result.ok && snapshot.players.length) {
    addAutoFetchLog("ロースターの更新に失敗したため、前回成功したデータを候補表示に使用しています。");
  }
}

function buildNpbWorkerRequestUrl(sourceUrl) {
  const workerUrl = new URL(NPB_WORKER_API_URL);
  workerUrl.searchParams.set("url", sourceUrl);
  return workerUrl.href;
}

function buildNpbWorkerDebugUrl(sourceUrl) {
  const workerUrl = new URL(NPB_WORKER_API_URL);
  workerUrl.searchParams.set("url", sourceUrl);
  workerUrl.searchParams.set("debug", "1");
  return workerUrl.href;
}

async function initializeProbableStarter() {
  const schedule = await getLoadedGameSchedule();
  state.probableStarter.nextGame = findNextScheduledGameForStarter(schedule);
  renderProbableStarter();

  if (state.probableStarter.nextGame) {
    await fetchProbableStarter();
  } else {
    state.probableStarter.status = "noGame";
    state.probableStarter.message = "次の試合を検出できませんでした。";
    renderProbableStarter();
  }
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

function findNextScheduledGameForStarter(schedule) {
  if (typeof window.findNextHamGame === "function") {
    return window.findNextHamGame(schedule);
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date()).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  const currentDateTime = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;

  return schedule
    .filter((game) => typeof game?.date === "string" && `${game.date}T${game.startTime || "23:59"}` >= currentDateTime)
    .slice()
    .sort((left, right) => `${left.date}T${left.startTime || "00:00"}`.localeCompare(`${right.date}T${right.startTime || "00:00"}`))[0] || null;
}

async function fetchProbableStarter({ force = false } = {}) {
  if (state.probableStarter.isLoading) {
    return;
  }

  if (!state.probableStarter.nextGame) {
    state.probableStarter.status = "noGame";
    state.probableStarter.message = "次の試合を検出できませんでした。";
    renderProbableStarter();
    return;
  }

  if (!force && state.probableStarter.fetchedGameId === state.probableStarter.nextGame.gameId) {
    return;
  }

  const workerUrl = buildProbableStarterWorkerRequestUrl();
  state.probableStarter.isLoading = true;
  state.probableStarter.status = "loading";
  state.probableStarter.message = "予告先発を取得中...";
  addProbableStarterLog("予告先発の取得を開始");
  addProbableStarterLog(`取得URL：${NPB_STARTER_SOURCE_URL}`);
  renderProbableStarter();

  try {
    const response = await fetch(workerUrl, { cache: "no-store" });
    addProbableStarterLog(`HTTPステータス：${response.status}`);

    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (!response.ok || !result?.ok) {
      const errorMessage = result?.error || `Worker APIの取得に失敗しました。HTTP ${response.status}`;
      state.probableStarter.status = "error";
      state.probableStarter.message = "予告先発を取得できませんでした";
      addProbableStarterLog(`解析失敗：${errorMessage}`);
      return;
    }

    const games = Array.isArray(result.games) ? result.games : [];
    state.probableStarter.games = games;
    state.probableStarter.fetchedAt = result.fetchedAt || new Date().toISOString();
    state.probableStarter.sourceUrl = result.sourceUrl || NPB_STARTER_SOURCE_URL;
    state.probableStarter.fetchedGameCount = games.length;
    state.probableStarter.fetchedGameId = state.probableStarter.nextGame.gameId || "";
    addProbableStarterLog(`予告先発ページ取得成功：${games.length}試合`);

    const matchedGame = matchProbableStarterGame(state.probableStarter.nextGame, games);
    state.probableStarter.matchedGame = matchedGame;
    addProbableStarterLog(`次の試合と照合：${formatScheduledGameForLog(state.probableStarter.nextGame)}`);

    if (!matchedGame) {
      state.probableStarter.status = "unannounced";
      state.probableStarter.message = "予告先発はまだ発表されていません";
      addProbableStarterLog("未発表：次の試合に一致するカードがありません");
      return;
    }

    const fightersStarter = getFightersStarter(matchedGame);
    const hasBothStarters = Boolean(fightersStarter?.fighters?.name && fightersStarter?.opponent?.name);
    state.probableStarter.status = hasBothStarters ? "success" : "unannounced";
    state.probableStarter.message = hasBothStarters
      ? "予告先発を取得しました"
      : "予告先発はまだ発表されていません";

    if (hasBothStarters) {
      addProbableStarterLog(`予告先発を検出：${fightersStarter.opponent.name} / ${fightersStarter.fighters.name}`);
    } else {
      addProbableStarterLog("未発表：カードは見つかりましたが両チームの先発が未発表です");
    }
  } catch (error) {
    state.probableStarter.status = "error";
    state.probableStarter.message = "予告先発を取得できませんでした";
    addProbableStarterLog(`通信失敗：${error.message}`);
  } finally {
    state.probableStarter.isLoading = false;
    renderProbableStarter();
  }
}

function buildProbableStarterWorkerRequestUrl() {
  const workerUrl = new URL(NPB_WORKER_API_URL);
  workerUrl.searchParams.set("mode", "starter");
  workerUrl.searchParams.set("cacheBust", String(Date.now()));
  return workerUrl.href;
}

function matchProbableStarterGame(nextGame, games) {
  const expectedDate = nextGame?.date || "";
  const expectedHome = normalizeScheduleTeamCode(nextGame?.homeTeam);
  const expectedAway = normalizeScheduleTeamCode(nextGame?.awayTeam);

  const exactMatch = games.find((game) => {
    return game?.date === expectedDate &&
      normalizeScheduleTeamCode(game.homeTeam) === expectedHome &&
      normalizeScheduleTeamCode(game.awayTeam) === expectedAway;
  });
  if (exactMatch) {
    return exactMatch;
  }

  if (!expectedHome || !expectedAway) {
    return null;
  }

  return games.find((game) => {
    const teams = new Set([normalizeScheduleTeamCode(game.homeTeam), normalizeScheduleTeamCode(game.awayTeam)]);
    return game?.date === expectedDate && teams.has(expectedHome) && teams.has(expectedAway);
  }) || null;
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

  return `${game.date || "日付不明"} ${game.matchupLabel || `${game.awayTeam || ""} vs ${game.homeTeam || ""}`}`;
}

function addProbableStarterLog(message) {
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  state.probableStarter.logs.push(`[${time}] ${message}`);
  if (state.probableStarter.logs.length > 30) {
    state.probableStarter.logs = state.probableStarter.logs.slice(-30);
  }
  renderProbableStarterAdmin();
}

async function initializePerfectAchievers() {
  const schedule = await getLoadedGameSchedule();
  if (!state.probableStarter.nextGame) {
    state.probableStarter.nextGame = findNextScheduledGameForStarter(schedule);
  }
  await fetchPerfectAchievers({ force: true });
}

function handleAuthStateChanged() {
  renderPerfectAchievers();
  fetchPerfectAchievers({ force: true });
  syncPredictionFromAccount({ force: true });
  fetchUserAchievements({ force: true });
  refreshYearlyRanking({ force: true });
  if (state.rankingView === "monthly") {
    refreshMonthlyRanking({ force: true });
  }
  refreshAdminAccess();
}

function getCurrentGameId() {
  return state.result?.gameId || state.nextScheduleId || state.probableStarter.nextGame?.gameId || "";
}

function getAdminScoringGameId() {
  // 古いローカル採点結果ではなく、管理者が読み込んだ対象試合を優先します。
  return state.nextScheduleId || state.probableStarter.nextGame?.gameId || "";
}

function buildAdminScoringApiUrl(gameId, action) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl || !gameId) {
    return "";
  }

  return `${baseUrl}/api/admin/games/${encodeURIComponent(gameId)}/predictions/${action}`;
}

function buildAdminGameApiUrl(gameId, action) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl || !gameId) {
    return "";
  }

  return `${baseUrl}/api/admin/games/${encodeURIComponent(gameId)}/${action}`;
}

function getActualLineupDetectedAt() {
  return state.actual?.fetchedAt || state.actual?.savedAt || new Date().toISOString();
}

function isApprovedActualLineupForServerScoring() {
  return Boolean(state.actual?.lineup) && state.actual?.approvalStatus !== "provisional";
}

function createAdminActualLineupPayload() {
  if (!isApprovedActualLineupForServerScoring()) {
    return { ok: false, error: "本承認済みの実スタメンを登録してから採点してください。" };
  }

  const lineup = normalizeLineup(state.actual.lineup);
  const validationError = validateLineup(lineup, "承認済み実スタメン");
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const serializedLineup = [];
  for (const item of lineup) {
    const player = getUniquePlayerData(item.player);
    const teamCode = player?.teamCode || DEFAULT_PLAYER_TEAM_CODE;
    const teamId = TEAM_PLAYER_ID_PREFIXES[teamCode];
    const uniformNumber = player?.uniformNumber;
    const playerId = createPlayerId(teamCode, uniformNumber);
    if (!player || !teamId || !playerId) {
      return {
        ok: false,
        error: `実スタメンの「${item.player || "未選択"}」を選手マスタから識別できません。背番号を含む選手情報を確認してください。`
      };
    }

    serializedLineup.push({
      playerId,
      teamId,
      teamCode,
      uniformNumber,
      playerName: player.name,
      battingOrder: item.order,
      position: item.position
    });
  }

  return { ok: true, lineup: serializedLineup };
}

function getAdminScoringFingerprint(actualLineup) {
  return JSON.stringify(actualLineup.map((item) => [
    item.playerId,
    item.battingOrder,
    item.position
  ]));
}

function resetAdminScoringPreview() {
  state.adminScoring.preview = null;
  state.adminScoring.previewFingerprint = "";
}

async function refreshAdminScoringSummary({ force = false } = {}) {
  if (!state.isAdminMode) {
    return;
  }

  const gameId = getAdminScoringGameId();
  if (!gameId) {
    state.adminScoring.gameId = "";
    state.adminScoring.predictionCount = null;
    state.adminScoring.scoredCount = null;
    state.adminScoring.summaryMessage = "対象試合を日程から読み込むと、保存済み予想の件数を確認できます。";
    renderAdminScoringPanel();
    return;
  }
  if (state.adminScoring.isLoadingSummary || (!force && state.adminScoring.gameId === gameId && state.adminScoring.predictionCount !== null)) {
    return;
  }

  const url = buildAdminScoringApiUrl(gameId, "summary");
  if (!url) {
    state.adminScoring.summaryMessage = "認証APIの接続先を確認できません。";
    renderAdminScoringPanel();
    return;
  }

  state.adminScoring.isLoadingSummary = true;
  state.adminScoring.gameId = gameId;
  state.adminScoring.summaryMessage = "保存済み予想の件数を確認中...";
  renderAdminScoringPanel();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    if (state.adminScoring.gameId !== gameId) {
      return;
    }
    state.adminScoring.predictionCount = Number(payload.predictionCount || 0);
    state.adminScoring.scoredCount = Number(payload.scoredCount || 0);
    state.adminScoring.summaryMessage = "";
  } catch (error) {
    console.error("保存済み予想の件数取得に失敗しました", error.message);
    state.adminScoring.predictionCount = null;
    state.adminScoring.scoredCount = null;
    state.adminScoring.summaryMessage = "保存済み予想の件数を取得できませんでした。";
  } finally {
    state.adminScoring.isLoadingSummary = false;
    renderAdminScoringPanel();
  }
}

function resetAutoScoringState() {
  state.autoScoring = {
    isSaving: false,
    isLoading: false,
    isRunningNow: false,
    isUpdating: false,
    gameId: "",
    record: null,
    message: ""
  };
}

async function saveApprovedActualLineupForAutoScoring() {
  if (!state.isAdminMode || state.autoScoring.isSaving) {
    return;
  }

  const gameId = getAdminScoringGameId();
  const actualPayload = createAdminActualLineupPayload();
  const url = buildAdminGameApiUrl(gameId, "actual-lineup");
  if (!gameId || !actualPayload.ok || !url) {
    return;
  }

  state.autoScoring.isSaving = true;
  state.autoScoring.gameId = gameId;
  state.autoScoring.message = "実スタメンをサーバーへ保存しています...";
  renderAutoScoringPanel();
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actualLineup: actualPayload.lineup,
        lineupDetectedAt: getActualLineupDetectedAt()
      })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    if (state.autoScoring.gameId === gameId) {
      state.autoScoring.record = payload.autoScoring || null;
      state.autoScoring.message = "実スタメンを保存し、自動採点を予約しました。";
    }
  } catch (error) {
    console.error("自動採点用の実スタメン保存に失敗しました", error.message);
    state.autoScoring.message = "実スタメンをサーバーへ保存できませんでした。手動採点は引き続き利用できます。";
  } finally {
    state.autoScoring.isSaving = false;
    renderAutoScoringPanel();
  }
}

async function refreshAutoScoringStatus({ force = false } = {}) {
  if (!state.isAdminMode) {
    return;
  }
  const gameId = getAdminScoringGameId();
  if (!gameId) {
    resetAutoScoringState();
    renderAutoScoringPanel();
    return;
  }
  if (state.autoScoring.isLoading || (!force && state.autoScoring.gameId === gameId && state.autoScoring.record)) {
    return;
  }
  const url = buildAdminGameApiUrl(gameId, "auto-scoring/status");
  if (!url) {
    return;
  }
  state.autoScoring.isLoading = true;
  state.autoScoring.gameId = gameId;
  renderAutoScoringPanel();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    if (state.autoScoring.gameId === gameId) {
      const previousStatus = state.autoScoring.record?.status || "";
      state.autoScoring.record = payload.autoScoring || null;
      state.autoScoring.message = "";
      if (previousStatus !== "scored" && state.autoScoring.record?.status === "scored") {
        void refreshYearlyRanking({ force: true });
        if (state.rankingView === "monthly") {
          void refreshMonthlyRanking({ force: true });
        }
      }
    }
  } catch (error) {
    console.error("自動採点状態の取得に失敗しました", error.message);
    state.autoScoring.message = "自動採点の状態を取得できませんでした。";
  } finally {
    state.autoScoring.isLoading = false;
    renderAutoScoringPanel();
  }
}

async function updateAutoScoring(action, confirmationMessage = "") {
  const gameId = getAdminScoringGameId();
  const url = buildAdminGameApiUrl(gameId, `auto-scoring/${action}`);
  if (!gameId || !url || state.autoScoring.isRunningNow || state.autoScoring.isUpdating) {
    return;
  }
  if (confirmationMessage && !window.confirm(confirmationMessage)) {
    return;
  }

  const isRunNow = action === "run-now";
  state.autoScoring[isRunNow ? "isRunningNow" : "isUpdating"] = true;
  state.autoScoring.message = isRunNow ? "今すぐ採点を実行しています..." : "自動採点の状態を更新しています...";
  renderAutoScoringPanel();
  try {
    const response = await fetch(url, { method: "POST", credentials: "include" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.autoScoring.record = payload.autoScoring || state.autoScoring.record;
    state.autoScoring.message = isRunNow
      ? `今すぐ採点を完了しました。${Number(payload.scored || 0)}件を更新しました。`
      : action === "cancel" ? "自動採点を取り消しました。" : "自動採点を再試行待ちに戻しました。";
    await refreshAdminScoringSummary({ force: true });
    if (isRunNow) {
      await refreshYearlyRanking({ force: true });
      if (state.rankingView === "monthly") {
        await refreshMonthlyRanking({ force: true });
      }
    }
  } catch (error) {
    console.error("自動採点操作に失敗しました", error.message);
    state.autoScoring.message = "自動採点の操作に失敗しました。";
  } finally {
    state.autoScoring[isRunNow ? "isRunningNow" : "isUpdating"] = false;
    renderAutoScoringPanel();
  }
}

function runAutoScoringNow() {
  void updateAutoScoring("run-now", "この試合の保存済み予想を今すぐサーバー側で採点します。よろしいですか？");
}

function retryAutoScoring() {
  void updateAutoScoring("retry", "自動採点を再試行待ちに戻します。よろしいですか？");
}

function cancelAutoScoring() {
  void updateAutoScoring("cancel", "予約済みの自動採点を取り消します。よろしいですか？");
}

function formatAutoScoringStatus(status) {
  return ({ pending: "採点待ち", processing: "採点処理中", scored: "採点済み", failed: "採点失敗", cancelled: "取り消し済み" })[status] || "未予約";
}

function formatRemainingTime(dueAt) {
  const due = new Date(dueAt || "");
  if (Number.isNaN(due.getTime())) {
    return "-";
  }
  const seconds = Math.max(0, Math.ceil((due.getTime() - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

function startAutoScoringCountdown() {
  if (autoScoringCountdownTimerId !== null) {
    return;
  }
  autoScoringCountdownTimerId = window.setInterval(() => {
    if (state.isAdminMode && state.autoScoring.record?.status === "pending") {
      renderAutoScoringPanel();
    }
  }, 1000);
}

function renderAutoScoringPanel() {
  const summary = document.getElementById("adminAutoScoringSummary");
  const message = document.getElementById("adminAutoScoringMessage");
  const runNowButton = document.getElementById("runAutoScoringNowButton");
  const retryButton = document.getElementById("retryAutoScoringButton");
  const cancelButton = document.getElementById("cancelAutoScoringButton");
  if (!summary || !message || !runNowButton || !retryButton || !cancelButton) {
    return;
  }

  const record = state.autoScoring.record;
  const status = record?.status || "";
  const isBusy = state.autoScoring.isSaving || state.autoScoring.isLoading || state.autoScoring.isRunningNow || state.autoScoring.isUpdating;
  const rows = record ? [
    ["状態", formatAutoScoringStatus(status)],
    ["対象gameId", record.gameId || state.autoScoring.gameId || "-"],
    ["実スタメン取得", formatDateTime(record.lineupDetectedAt)],
    ["採点予定", formatDateTime(record.scoringDueAt)],
    ["残り時間", status === "pending" ? formatRemainingTime(record.scoringDueAt) : "-"],
    ["試行回数", `${record.attempts || 0} / ${record.maxAttempts || 3}`],
    ["処理件数", record.processedPredictions === null ? "-" : `${record.processedPredictions}件`],
    ["満点", record.perfectCount === null ? "-" : `${record.perfectCount}件`],
    ["採点完了", record.scoredAt ? formatDateTime(record.scoredAt) : "-"]
  ] : [["状態", state.autoScoring.isLoading ? "状態を確認中" : "実スタメン未保存"]];
  summary.innerHTML = `<dl>${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
  if (record?.lastError) {
    summary.insertAdjacentHTML("beforeend", `<p class="admin-auto-scoring-error">最終エラー：${escapeHtml(record.lastError)}</p>`);
  }
  message.textContent = state.autoScoring.message;
  message.className = `message${state.autoScoring.message.includes("失敗") || state.autoScoring.message.includes("できません") ? " error-message" : ""}`;
  runNowButton.disabled = !record || isBusy || status === "processing";
  retryButton.disabled = !record || isBusy || status !== "failed";
  cancelButton.disabled = !record || isBusy || !["pending", "failed"].includes(status);
}

async function runServerScoringPreview() {
  const gameId = getAdminScoringGameId();
  const actualPayload = createAdminActualLineupPayload();
  if (!gameId || !actualPayload.ok) {
    state.adminScoring.summaryMessage = actualPayload.error || "対象試合を日程から読み込んでください。";
    resetAdminScoringPreview();
    renderAdminScoringPanel();
    return;
  }

  const url = buildAdminScoringApiUrl(gameId, "score-predictions/preview");
  if (!url) {
    state.adminScoring.summaryMessage = "認証APIの接続先を確認できません。";
    renderAdminScoringPanel();
    return;
  }

  state.adminScoring.isTesting = true;
  state.adminScoring.summaryMessage = "採点テストを実行中...";
  resetAdminScoringPreview();
  renderAdminScoringPanel();
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actualLineup: actualPayload.lineup })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.adminScoring.preview = payload;
    state.adminScoring.previewFingerprint = getAdminScoringFingerprint(actualPayload.lineup);
    state.adminScoring.summaryMessage = "採点テストが完了しました。DBは変更していません。";
    state.adminScoring.predictionCount = Number(payload.processed || 0);
  } catch (error) {
    console.error("採点テストに失敗しました", error.message);
    state.adminScoring.summaryMessage = "採点テストに失敗しました。実スタメンと認証APIを確認してください。";
  } finally {
    state.adminScoring.isTesting = false;
    renderAdminScoringPanel();
  }
}

async function runServerScoring() {
  const gameId = getAdminScoringGameId();
  const actualPayload = createAdminActualLineupPayload();
  const fingerprint = actualPayload.ok ? getAdminScoringFingerprint(actualPayload.lineup) : "";
  if (!gameId || !actualPayload.ok || !state.adminScoring.preview || state.adminScoring.previewFingerprint !== fingerprint) {
    state.adminScoring.summaryMessage = "実スタメンを変更したため、先に採点テストを実行してください。";
    renderAdminScoringPanel();
    return;
  }

  const processed = Number(state.adminScoring.preview.processed || 0);
  if (!window.confirm(`この試合の保存済み予想${processed}件を採点します。よろしいですか？`)) {
    return;
  }

  const url = buildAdminScoringApiUrl(gameId, "score-predictions");
  if (!url) {
    state.adminScoring.summaryMessage = "認証APIの接続先を確認できません。";
    renderAdminScoringPanel();
    return;
  }

  state.adminScoring.isScoring = true;
  state.adminScoring.summaryMessage = "本番採点を実行中...";
  renderAdminScoringPanel();
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actualLineup: actualPayload.lineup })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.adminScoring.summaryMessage = payload.message || `本番採点が完了しました。${payload.scored}件を更新しました。`;
    if (payload.autoScoring) {
      state.autoScoring.record = payload.autoScoring;
      state.autoScoring.gameId = gameId;
    }
    resetAdminScoringPreview();
    await refreshAdminScoringSummary({ force: true });
    await refreshYearlyRanking({ force: true });
    if (state.rankingView === "monthly") {
      await refreshMonthlyRanking({ force: true });
    }
    renderAutoScoringPanel();
  } catch (error) {
    console.error("本番採点に失敗しました", error.message);
    state.adminScoring.summaryMessage = "本番採点に失敗しました。DBは更新されていない可能性があります。";
  } finally {
    state.adminScoring.isScoring = false;
    renderAdminScoringPanel();
  }
}

function renderAdminScoringPanel() {
  const summary = document.getElementById("adminServerScoringSummary");
  const testButton = document.getElementById("testServerScoringButton");
  const scoreButton = document.getElementById("runServerScoringButton");
  const message = document.getElementById("adminServerScoringMessage");
  const previewContainer = document.getElementById("adminServerScoringPreview");
  if (!summary || !testButton || !scoreButton || !message || !previewContainer) {
    return;
  }

  const gameId = getAdminScoringGameId();
  const actualPayload = createAdminActualLineupPayload();
  const fingerprint = actualPayload.ok ? getAdminScoringFingerprint(actualPayload.lineup) : "";
  if (state.adminScoring.preview && state.adminScoring.previewFingerprint !== fingerprint) {
    resetAdminScoringPreview();
    if (!state.adminScoring.isTesting && !state.adminScoring.isScoring) {
      state.adminScoring.summaryMessage = "実スタメンが変更されました。採点テストをもう一度実行してください。";
    }
  }

  const summaryRows = [
    ["対象gameId", gameId || "未選択"],
    ["実スタメン", actualPayload.ok ? "本承認済み・9人確認済み" : "未確定または選手情報を確認できません"],
    ["保存済み予想", state.adminScoring.predictionCount === null ? "-" : `${state.adminScoring.predictionCount}件`],
    ["採点済み", state.adminScoring.scoredCount === null ? "-" : `${state.adminScoring.scoredCount}件`]
  ];
  summary.innerHTML = `<dl>${summaryRows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;

  const canTest = Boolean(gameId && actualPayload.ok && !state.adminScoring.isTesting && !state.adminScoring.isScoring);
  const canScore = Boolean(
    canTest && state.adminScoring.preview && state.adminScoring.previewFingerprint === fingerprint
  );
  testButton.disabled = !canTest;
  scoreButton.disabled = !canScore;
  message.textContent = state.adminScoring.summaryMessage || (actualPayload.ok ? "" : actualPayload.error);
  message.className = `message${state.adminScoring.summaryMessage.includes("失敗") ? " error-message" : ""}`;

  if (!state.adminScoring.preview) {
    previewContainer.classList.add("hidden");
    previewContainer.innerHTML = "";
    return;
  }

  const preview = state.adminScoring.preview;
  const distribution = Object.entries(preview.scoreDistribution || {})
    .map(([score, count]) => `${escapeHtml(score)}点: ${escapeHtml(count)}件`)
    .join(" / ") || "-";
  const errors = Array.isArray(preview.validationErrors) && preview.validationErrors.length
    ? `<p class="admin-server-scoring-errors">検証エラー：${escapeHtml(preview.validationErrors.join(" / "))}</p>`
    : "";
  previewContainer.classList.remove("hidden");
  previewContainer.innerHTML = `
    <strong>採点テスト結果（DBは変更していません）</strong>
    <dl>
      <dt>処理予定</dt><dd>${escapeHtml(preview.processed)}件</dd>
      <dt>採点可能</dt><dd>${escapeHtml(preview.scored)}件</dd>
      <dt>失敗</dt><dd>${escapeHtml(preview.failed)}件</dd>
      <dt>平均点</dt><dd>${escapeHtml(preview.averageScore)} / ${SCORE_MAX}</dd>
      <dt>満点件数</dt><dd>${escapeHtml(preview.perfectCount)}件</dd>
      <dt>点数分布</dt><dd>${distribution}</dd>
    </dl>
    ${errors}
  `;
}

function getPerfectAchieversApiBaseUrl() {
  return getAuthApiBaseUrl();
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

async function initializeYearlyRanking() {
  await refreshYearlyRanking({ force: true });
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
    const publicRequest = fetch(publicUrl, { credentials: "include", cache: force ? "no-store" : "default" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(payload?.ranking)) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        return payload;
      });
    const selfRequest = user ? fetch(buildMyYearlyRankingApiUrl(period), { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
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
    const publicRequest = fetch(publicUrl, { credentials: "include", cache: force ? "no-store" : "default" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(payload?.ranking)) {
          throw new Error(payload?.error || `HTTP ${response.status}`);
        }
        return payload;
      });
    const selfRequest = user ? fetch(buildMyMonthlyRankingApiUrl(period), { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
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

function selectRankingView(view) {
  if (view !== "yearly" && view !== "monthly") return;
  state.rankingView = view;
  renderRankingPanel();
  if (view === "yearly") {
    void refreshYearlyRanking({ force: true });
  } else {
    void refreshMonthlyRanking({ force: true });
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
      if (nextYear >= YEARLY_RANKING_MIN_YEAR && nextYear <= currentYear) {
        ranking.year = nextYear;
        ranking.self = null;
        void refreshYearlyRanking({ force: true });
      }
    }
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

  renderRankingHeading("yearly");
  const ranking = state.yearlyRanking;
  const currentYear = getJapanYearMonth().year;
  const periodControls = `<div class="ranking-month-controls" aria-label="年間ランキングの対象年">
    <button class="compact-button" type="button" data-yearly-ranking-move="-1"${ranking.year <= YEARLY_RANKING_MIN_YEAR ? " disabled" : ""}>前年</button>
    <strong>${escapeHtml(ranking.year)}年</strong>
    <button class="compact-button" type="button" data-yearly-ranking-move="1"${ranking.year === currentYear ? " disabled" : ""}>翌年</button>
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

function renderRankingHeading(view) {
  const areaLabel = document.getElementById("rankingAreaLabel");
  const title = document.getElementById("rankingTitle");
  const description = document.getElementById("rankingDescription");
  const yearlyButton = document.getElementById("showYearlyRankingButton");
  const monthlyButton = document.getElementById("showMonthlyRankingButton");
  const isMonthly = view === "monthly";
  if (areaLabel) areaLabel.textContent = isMonthly ? "MONTHLY RANKING" : "YEARLY RANKING";
  if (title) title.textContent = isMonthly ? "月間ランキング" : "年間ランキング";
  if (description) description.textContent = isMonthly
    ? "この月に正式採点された対象試合の3分の2以上に参加すると順位対象になります。"
    : "この年に正式採点された対象試合の3分の2以上に参加すると順位対象になります。";
  yearlyButton?.classList.toggle("is-active", !isMonthly);
  monthlyButton?.classList.toggle("is-active", isMonthly);
  yearlyButton?.setAttribute("aria-selected", String(!isMonthly));
  monthlyButton?.setAttribute("aria-selected", String(isMonthly));
}

function renderRankingContent(ranking, { selfTitle, emptyMessage, prefixHtml = "" }) {
  const container = document.getElementById("rankingContent");
  if (!container) return;

  if (ranking.isLoading && !ranking.summary) {
    container.innerHTML = `${prefixHtml}<p class="empty-state">ランキングを読み込んでいます。</p>`;
    return;
  }
  if (ranking.message) {
    container.innerHTML = `${prefixHtml}<p class="empty-state">${escapeHtml(ranking.message)}</p>`;
    return;
  }

  const summary = ranking.summary;
  if (!summary || Number(summary.eligibleGames || 0) === 0) {
    container.innerHTML = `${prefixHtml}<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
    return;
  }

  const qualified = ranking.rows.filter((row) => row.isQualified);
  const unqualified = ranking.rows.filter((row) => !row.isQualified);
  const selfSection = renderMyRanking(ranking, ranking.self, selfTitle);
  const qualifiedContent = qualified.length
    ? `<ol class="ranking-list">${qualified.map((row) => createRankingCardHtml(row)).join("")}</ol>`
    : '<p class="ranking-empty">まだ規定到達者はいません。</p>';
  const unqualifiedContent = unqualified.length
    ? `<details class="ranking-unqualified"><summary>規定未到達者を見る（${unqualified.length}人）</summary><ol class="ranking-list is-reference">${unqualified.map((row) => createRankingCardHtml(row, { reference: true })).join("")}</ol></details>`
    : "";
  const summaryText = `対象 ${summary.eligibleGames}試合 / 規定 ${summary.requiredGames}試合以上`;
  container.innerHTML = `
    ${prefixHtml}
    <p class="ranking-summary">${escapeHtml(summaryText)}</p>
    ${selfSection}
    <section class="ranking-qualified-section" aria-labelledby="rankingQualifiedTitle">
      <h3 id="rankingQualifiedTitle">規定到達ランキング</h3>
      ${qualifiedContent}
    </section>
    ${unqualifiedContent}
  `;
}

function renderMyRanking(ranking, row, title) {
  const user = getPredictionAccountUser();
  if (!user) return "";
  if (ranking.isLoadingSelf) {
    return `<section class="ranking-self"><h3>${escapeHtml(title)}</h3><p>成績を読み込んでいます。</p></section>`;
  }
  if (!row) {
    return `<section class="ranking-self"><h3>${escapeHtml(title)}</h3><p>まだランキング対象試合への参加記録がありません。</p></section>`;
  }
  const qualification = row.isQualified
    ? `規定到達・現在 ${row.rank}位`
    : `規定まであと${row.gamesNeeded}試合（規定未到達）`;
  return `<section class="ranking-self">
    <h3>${escapeHtml(title)}</h3>
    <p><strong>平均${escapeHtml(formatRankingScore(row.averageScore))}点</strong> ${escapeHtml(qualification)}</p>
    <p>${escapeHtml(row.gamesPlayed)} / ${escapeHtml(row.eligibleGames)}試合参加・参加率${escapeHtml(formatParticipationRate(row.participationRate))}</p>
  </section>`;
}

function createRankingCardHtml(row, { reference = false } = {}) {
  const rankLabel = reference ? "参考記録" : `${row.rank}位`;
  const qualification = reference ? `規定まであと${row.gamesNeeded}試合` : "規定到達";
  return `<li class="ranking-entry${reference ? " is-reference" : ""}">
    <p class="ranking-rank">${escapeHtml(rankLabel)}</p>
    <div class="ranking-entry-main">
      <div class="ranking-user-line"><strong>${escapeHtml(row.username)}</strong>${createRankingAchievementBadgesHtml(row)}</div>
      <p>平均 ${escapeHtml(formatRankingScore(row.averageScore))}点${reference ? "（参考）" : ""}</p>
      <p>${escapeHtml(row.gamesPlayed)} / ${escapeHtml(row.eligibleGames)}試合・参加率 ${escapeHtml(formatParticipationRate(row.participationRate))}・${escapeHtml(qualification)}</p>
      <p>合計 ${escapeHtml(row.totalScore)}点・満点 ${escapeHtml(row.perfectCount)}回</p>
    </div>
  </li>`;
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

function buildPerfectAchieversApiUrl(gameId) {
  const baseUrl = getPerfectAchieversApiBaseUrl().replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/api/perfect-achievers`, window.location.href);
  url.searchParams.set("gameId", gameId);
  return url.href;
}

async function fetchPerfectAchievers({ force = false } = {}) {
  const gameId = getCurrentGameId();
  if (!gameId) {
    state.perfectAchievers.status = "noGame";
    state.perfectAchievers.message = "対象試合がありません。";
    renderPerfectAchievers();
    return;
  }
  if (state.perfectAchievers.isLoading || (!force && state.perfectAchievers.gameId === gameId)) {
    return;
  }

  state.perfectAchievers.isLoading = true;
  state.perfectAchievers.status = "loading";
  state.perfectAchievers.message = "満点達成者を読み込み中...";
  state.perfectAchievers.gameId = gameId;
  renderPerfectAchievers();

  try {
    const response = await fetch(buildPerfectAchieversApiUrl(gameId), {
      credentials: "include",
      cache: "no-store"
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }

    state.perfectAchievers.status = "success";
    state.perfectAchievers.message = "";
    state.perfectAchievers.displayLimit = Math.max(1, Number(payload.displayLimit || PERFECT_ACHIEVERS_DEFAULT_DISPLAY_LIMIT));
    state.perfectAchievers.totalCount = Number(payload.totalCount || 0);
    state.perfectAchievers.currentUserRegistered = Boolean(payload.currentUserRegistered);
    state.perfectAchievers.achievers = Array.isArray(payload.achievers) ? payload.achievers : [];
  } catch (error) {
    console.error("満点達成者の取得に失敗しました", error.message);
    state.perfectAchievers.status = "error";
    state.perfectAchievers.message = "満点達成者を取得できませんでした。";
    state.perfectAchievers.achievers = [];
  } finally {
    state.perfectAchievers.isLoading = false;
    renderPerfectAchievers();
  }
}

async function registerPerfectAchiever() {
  if (state.perfectAchievers.isSubmitting) {
    return;
  }

  const gameId = getCurrentGameId();
  const result = state.result;
  const currentUser = window.starting9Auth?.getUser?.() || null;
  const score = Number(result?.total);
  const maxScore = Number(result?.max);

  if (!gameId || !Number.isFinite(score) || !Number.isFinite(maxScore) || score !== maxScore) {
    state.perfectAchievers.message = "満点を達成した場合のみ登録できます。";
    renderPerfectAchievers();
    return;
  }
  if (!currentUser) {
    state.perfectAchievers.message = "達成者として登録するにはログインしてください。";
    renderPerfectAchievers();
    return;
  }

  state.perfectAchievers.isSubmitting = true;
  state.perfectAchievers.message = "満点達成者として登録中...";
  renderPerfectAchievers();

  try {
    const baseUrl = getPerfectAchieversApiBaseUrl().replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/api/perfect-achievers`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId, score, maxScore })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }

    state.perfectAchievers.status = "success";
    state.perfectAchievers.message = "満点達成者として登録しました。";
    state.perfectAchievers.gameId = payload.gameId || gameId;
    state.perfectAchievers.displayLimit = Math.max(1, Number(payload.displayLimit || state.perfectAchievers.displayLimit));
    state.perfectAchievers.totalCount = Number(payload.totalCount || state.perfectAchievers.totalCount);
    state.perfectAchievers.currentUserRegistered = true;
    state.perfectAchievers.achievers = Array.isArray(payload.achievers) ? payload.achievers : state.perfectAchievers.achievers;
  } catch (error) {
    console.error("満点達成者の登録に失敗しました", error.message);
    state.perfectAchievers.message = error.message || "満点達成者の登録に失敗しました。";
  } finally {
    state.perfectAchievers.isSubmitting = false;
    renderPerfectAchievers();
  }
}

function renderPerfectAchievers() {
  const container = document.getElementById("perfectAchieversContent");
  const count = document.getElementById("perfectAchieversCount");
  if (!container || !count) {
    return;
  }

  const perfectState = state.perfectAchievers;
  count.textContent = perfectState.totalCount > 0 ? `現在 ${perfectState.totalCount}人` : "";

  if (perfectState.status === "loading") {
    container.innerHTML = `<p class="perfect-achievers-message">満点達成者を読み込み中...</p>`;
    return;
  }
  if (perfectState.status === "error") {
    container.innerHTML = `<p class="perfect-achievers-message is-error">${escapeHtml(perfectState.message)}</p>`;
    return;
  }
  if (perfectState.status === "noGame" || !perfectState.gameId) {
    container.innerHTML = `<p class="perfect-achievers-message">対象試合を確認できません。</p>`;
    return;
  }

  const list = perfectState.achievers.length > 0
    ? `<ol class="perfect-achievers-list">${perfectState.achievers.slice(0, perfectState.displayLimit).map((achiever) => `
        <li><span>${achiever.rank}.</span><strong>${escapeHtml(achiever.username)}</strong><time datetime="${escapeHtml(achiever.achievedAt || "")}">${escapeHtml(formatDateTime(achiever.achievedAt))}</time></li>
      `).join("")}</ol>`
    : `<p class="perfect-achievers-message">まだ満点達成者はいません。</p>`;

  const result = state.result;
  const isPerfect = Boolean(result && Number(result.total) === Number(result.max));
  const currentUser = window.starting9Auth?.getUser?.() || null;
  let action = "";
  if (isPerfect && perfectState.currentUserRegistered) {
    action = `<p class="perfect-achievers-message is-success">満点達成者として登録済みです。</p>`;
  } else if (isPerfect && !currentUser) {
    action = `<p class="perfect-achievers-message">満点を達成しました。達成者として登録するにはログインしてください。</p><button id="openPerfectAchieverLoginButton" class="secondary-button compact-button" type="button">ログイン</button>`;
  } else if (isPerfect) {
    action = `<button id="registerPerfectAchieverButton" class="primary-button compact-button" type="button" ${perfectState.isSubmitting ? "disabled" : ""}>満点達成者として登録</button>`;
  }

  container.innerHTML = `${list}
    <p class="perfect-achievers-total">表示：先着${perfectState.displayLimit}人 / 総達成人数 ${perfectState.totalCount}人</p>
    ${action}`;
  container.querySelector("#registerPerfectAchieverButton")?.addEventListener("click", registerPerfectAchiever);
  container.querySelector("#openPerfectAchieverLoginButton")?.addEventListener("click", () => window.starting9Auth?.openLogin?.());
}

function showNpbFetchFallback(message) {
  state.actualPreview = null;
  state.adminStatus = "error";
  state.adminError = NPB_WORKER_FALLBACK_MESSAGE;
  renderAdminFlow();
  showMessage("parserError", NPB_WORKER_FALLBACK_MESSAGE);
  setNpbFetchMessage(message, "error");
}

async function initializePredictionRemoteSync() {
  await syncPredictionFromAccount({ force: true });
}

function buildCurrentPredictionApiUrl(gameId) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl || !gameId) {
    return "";
  }
  const url = new URL(`${baseUrl}/api/predictions/current`, window.location.href);
  url.searchParams.set("gameId", gameId);
  return url.href;
}

function getPredictionAccountUser() {
  return window.starting9Auth?.getUser?.() || null;
}

async function syncPredictionFromAccount({ force = false } = {}) {
  const user = getPredictionAccountUser();
  if (!user) {
    state.predictionRemote = createEmptyPredictionRemoteState();
    renderPredictionAccountStatus();
    return;
  }

  const gameId = getCurrentGameId();
  const remoteState = state.predictionRemote;
  if (!gameId) {
    remoteState.status = "noGame";
    remoteState.message = "対象試合が決まるとアカウントの予想を確認できます。";
    renderPredictionAccountStatus();
    return;
  }
  if (remoteState.isLoading || (!force && remoteState.gameId === gameId)) {
    return;
  }

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
  }
  remoteState.gameId = gameId;
  remoteState.message = "アカウントの予想を確認中...";
  renderPredictionAccountStatus();

  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }

    remoteState.status = "success";
    remoteState.message = "";
    remoteState.prediction = payload.prediction ? remotePredictionToLocal(payload.prediction, payload.updatedAt || payload.submittedAt, gameId) : null;
    remoteState.submittedAt = payload.submittedAt || "";
    remoteState.updatedAt = payload.updatedAt || "";
    remoteState.locked = Boolean(payload.locked);
    remoteState.conflict = Boolean(remoteState.prediction && state.prediction && !predictionsMatch(remoteState.prediction, state.prediction));
    if (remoteState.prediction && !state.prediction) {
      state.prediction = { ...remoteState.prediction, lineup: normalizeLineup(remoteState.prediction.lineup) };
      state.result = null;
      saveToStorage(STORAGE_KEYS.prediction, state.prediction);
      removeFromStorage(STORAGE_KEYS.result);
      renderAll();
    }
  } catch (error) {
    console.error("アカウント予想の取得に失敗しました", error.message);
    remoteState.status = "error";
    remoteState.message = "アカウントの予想を取得できませんでした。端末の予想はそのまま利用できます。";
    remoteState.prediction = null;
    remoteState.conflict = false;
  } finally {
    remoteState.isLoading = false;
    renderPredictionAccountStatus();
  }
}

function createEmptyPredictionRemoteState() {
  return {
    isLoading: false,
    isSaving: false,
    isDeleting: false,
    status: "idle",
    message: "",
    gameId: "",
    prediction: null,
    submittedAt: "",
    updatedAt: "",
    locked: false,
    conflict: false
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
    const response = await fetch(url, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId, prediction: predictionPayload.prediction })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
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
    state.predictionRemote.message = `端末には保存しましたが、アカウント保存に失敗しました。${error.message ? ` ${error.message}` : ""}`;
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
  state.result = null;
  removeFromStorage(STORAGE_KEYS.result);
  state.predictionRemote.conflict = false;
  state.predictionRemote.message = "アカウントの予想を読み込みました。";
  renderAll();
}

async function deletePredictionFromAccount(gameId) {
  const user = getPredictionAccountUser();
  const url = buildCurrentPredictionApiUrl(gameId);
  if (!user || !url) {
    return;
  }

  state.predictionRemote.isDeleting = true;
  state.predictionRemote.message = "アカウントの予想を削除中...";
  renderPredictionAccountStatus();
  try {
    const response = await fetch(url, { method: "DELETE", credentials: "include" });
    const payload = await response.json().catch(() => null);
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
}

function updatePredictionSaveButton() {
  const button = document.getElementById("savePredictionButton");
  if (!button) {
    return;
  }

  const isSaving = state.predictionRemote.isSaving;
  button.disabled = isSaving;
  button.textContent = isSaving ? "保存中..." : "予想を保存する";
  button.setAttribute("aria-busy", isSaving ? "true" : "false");
}

function showNpbExtractionFailedFallback(sourceUrl, workerError) {
  const debugUrl = buildNpbWorkerDebugUrl(sourceUrl);
  const message = `${NPB_WORKER_EXTRACTION_FAILED_MESSAGE}\n${debugUrl}`;
  state.actualPreview = null;
  state.adminStatus = "error";
  state.adminError = workerError ? `${NPB_WORKER_EXTRACTION_FAILED_MESSAGE}\nWorkerエラー：${workerError}` : NPB_WORKER_EXTRACTION_FAILED_MESSAGE;
  renderAdminFlow();
  showMessage("parserError", message);
  setNpbFetchMessage("スタメン抽出に失敗しました。手動貼り付け、またはdebug=1付きURLを確認してください。", "error");
}

function startAutoFetch() {
  clearMessage("parserError");
  clearMessage("actualError");
  clearMessage("resetMessage");
  saveAdminGameInfoFromInputs();

  const urlValidation = validateNpbUrl(document.getElementById("npbUrlInput").value);
  if (!urlValidation.ok) {
    setAutoFetchStatus(urlValidation.message, "error");
    return;
  }

  if (!isNpbScoresUrl(urlValidation.url)) {
    setAutoFetchStatus("自動取得には npb.jp/scores 配下のURLを入力してください。", "error");
    return;
  }

  const gameStartAt = getGameStartDate();
  if (!gameStartAt) {
    setAutoFetchStatus("試合開始日時を入力してください。", "error");
    return;
  }

  if (Date.now() >= gameStartAt.getTime()) {
    setAutoFetchStatus("試合開始時刻を過ぎているため、自動取得を開始できません。", "error");
    return;
  }

  stopAutoFetch("", "");
  state.autoFetch = {
    isRunning: true,
    timerId: null,
    attempts: 0,
    startedAt: new Date().toISOString(),
    lastCheckedAt: "",
    lastError: "",
    sourceUrl: urlValidation.url,
    gameStartAt: gameStartAt.toISOString(),
    nextRunAt: "",
    status: "waiting",
    logs: [],
    validationChecks: [],
    workerMeta: null
  };

  addAutoFetchLog("自動取得を開始しました。");
  setAutoFetchStatus("自動取得を開始しました。試合開始50分前から10分ごとに取得します。", "info");
  scheduleNextAutoFetch();
  updateAutoFetchButtons();
  renderAutoFetchPanel();
}

function stopAutoFetch(message, type) {
  if (state.autoFetch.timerId) {
    clearTimeout(state.autoFetch.timerId);
  }

  state.autoFetch.isRunning = false;
  state.autoFetch.timerId = null;
  state.autoFetch.nextRunAt = "";
  if (state.autoFetch.status === "fetching" || state.autoFetch.status === "waiting") {
    state.autoFetch.status = "stopped";
  }
  updateAutoFetchButtons();

  if (message) {
    addAutoFetchLog(message);
    setAutoFetchStatus(message, type || "info");
  }
  renderAutoFetchPanel();
}

function scheduleNextAutoFetch() {
  if (!state.autoFetch.isRunning) {
    return;
  }

  const now = Date.now();
  const gameStartTime = new Date(state.autoFetch.gameStartAt).getTime();
  const firstFetchTime = gameStartTime - AUTO_FETCH_START_BEFORE_MS;

  if (now >= gameStartTime) {
    state.autoFetch.status = "stopped";
    stopAutoFetch("試合開始時刻を過ぎたため、自動取得を停止しました。", "warning");
    return;
  }

  if (state.autoFetch.attempts >= AUTO_FETCH_MAX_ATTEMPTS) {
    state.autoFetch.status = "failed";
    stopAutoFetch("最大5回まで取得しました。候補を取得できなかったため停止しました。", "error");
    state.adminStatus = "autoFailed";
    state.adminError = "自動取得で9人分のスタメン候補を取得できませんでした。手動取得または貼り付けを使ってください。";
    renderAdminFlow();
    return;
  }

  const delay = Math.max(0, now < firstFetchTime ? firstFetchTime - now : state.autoFetch.attempts === 0 ? 0 : AUTO_FETCH_INTERVAL_MS);
  state.autoFetch.status = "waiting";
  state.autoFetch.nextRunAt = new Date(now + delay).toISOString();
  const nextText = delay === 0 ? "まもなく取得します。" : `次回取得予定：${formatDateTime(new Date(now + delay).toISOString())}`;
  setAutoFetchStatus(`自動取得中です。${state.autoFetch.attempts} / ${AUTO_FETCH_MAX_ATTEMPTS}回実行済み。${nextText}`, "info");

  state.autoFetch.timerId = setTimeout(runAutoFetchAttempt, delay);
  updateAutoFetchButtons();
  renderAutoFetchPanel();
}

async function runAutoFetchAttempt() {
  if (!state.autoFetch.isRunning) {
    return;
  }

  const gameStartAt = new Date(state.autoFetch.gameStartAt);
  const fetchedAt = new Date();

  if (fetchedAt.getTime() >= gameStartAt.getTime()) {
    state.autoFetch.status = "stopped";
    stopAutoFetch("試合開始時刻を過ぎたため、自動取得を停止しました。", "warning");
    return;
  }

  state.autoFetch.attempts += 1;
  state.autoFetch.lastCheckedAt = fetchedAt.toISOString();
  state.autoFetch.status = "fetching";
  state.autoFetch.nextRunAt = "";
  addAutoFetchLog("取得開始");
  setAutoFetchStatus(`自動取得を実行中です。${state.autoFetch.attempts} / ${AUTO_FETCH_MAX_ATTEMPTS}回目`, "info");
  renderAutoFetchPanel();

  const candidate = await fetchNpbLineupCandidate(state.autoFetch.sourceUrl);
  if (!candidate.ok) {
    state.autoFetch.lastError = candidate.message;
    state.autoFetch.status = "failed";
    addAutoFetchLog(`取得失敗：${candidate.message}`);
    state.adminStatus = "autoFailed";
    state.adminError = `自動取得に失敗しました：${candidate.message}`;
    renderAdminFlow();
    scheduleNextAutoFetch();
    return;
  }

  const validation = validateAutoFetchedLineup(candidate.lineupText, candidate.sourceUrl, fetchedAt, gameStartAt);
  state.autoFetch.validationChecks = validation.checks;
  state.autoFetch.workerMeta = {
    fetchedAt: candidate.fetchedAt || fetchedAt.toISOString(),
    method: candidate.method || "",
    team: candidate.team || "",
    sourceUrl: candidate.sourceUrl
  };
  if (!validation.ok) {
    state.autoFetch.lastError = validation.message;
    state.autoFetch.status = "failed";
    addAutoFetchLog(`要確認：${validation.message}`);
    state.adminStatus = "needsReview";
    state.adminError = `要確認：${validation.message}`;
    renderAdminFlow();
    scheduleNextAutoFetch();
    return;
  }

  addAutoFetchLog("9人取得成功");
  const autoApprove = shouldAutoApproveFetchedLineup(validation.checks);
  registerProvisionalActual(
    validation.lineup,
    candidate.sourceUrl,
    fetchedAt,
    state.autoFetch.workerMeta,
    validation.checks,
    autoApprove ? "approved" : "provisional"
  );

  if (autoApprove) {
    state.autoFetch.status = "approved";
    addAutoFetchLog("チェック全OKのため、自動で本承認しました。");
    stopAutoFetch("9人分の候補を取得し、自動で本承認しました。", "success");
    return;
  }

  state.autoFetch.status = "provisional";
  addAutoFetchLog("仮承認済みにしました。");
  stopAutoFetch("9人分の候補を取得し、仮承認済みにしました。", "success");
}

function shouldAutoApproveFetchedLineup(validationChecks) {
  const checkbox = document.getElementById("autoApproveCheckbox");
  return state.isAdminMode
    && Boolean(checkbox?.checked)
    && validationChecks.length === 8
    && validationChecks.every((check) => check.ok);
}

function validateAutoFetchedLineup(lineupText, sourceUrl, fetchedAt, gameStartAt) {
  const lines = String(lineupText || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsedLines = lines.map((line) => parseActualLine(line));
  const parseResult = parseActualLineupText(lineupText);
  const parsedItems = parsedLines.filter((result) => result.ok).map((result) => result.item);
  const orders = parsedItems.map((item) => item.order);
  const orderSet = new Set(orders);
  const playerKeys = parsedItems.map((item) => normalizePlayerKey(item.player)).filter(Boolean);
  const playerSet = new Set(playerKeys);
  const missingPlayer = parsedItems.find((item) => !playerNames.some((player) => normalizePlayerKey(player) === normalizePlayerKey(item.player)));
  const checks = [
    { label: "1〜9番が揃っている", ok: orderSet.size === LINEUP_SIZE && Array.from({ length: LINEUP_SIZE }, (_, index) => orderSet.has(index + 1)).every(Boolean) },
    { label: "打順重複なし", ok: orders.length === orderSet.size && orders.length === LINEUP_SIZE },
    { label: "選手重複なし", ok: playerKeys.length === playerSet.size && playerKeys.length === LINEUP_SIZE },
    { label: "守備位置正常", ok: parsedLines.length === LINEUP_SIZE && parsedLines.every((result) => result.ok && Boolean(result.item.position)) },
    { label: "選手名が players.js に存在する", ok: parsedItems.length === LINEUP_SIZE && !missingPlayer },
    { label: "取得元URLが npb.jp/scores 配下", ok: isNpbScoresUrl(sourceUrl) },
    { label: "取得時刻が試合開始前", ok: fetchedAt.getTime() < gameStartAt.getTime() },
    { label: "lineupText が9行ある", ok: lines.length === LINEUP_SIZE }
  ];
  const failedCheck = checks.find((check) => !check.ok);

  if (!parseResult.ok) {
    return { ok: false, message: parseResult.message, checks };
  }

  if (missingPlayer) {
    return { ok: false, message: `対象選手に存在しない選手が含まれています：${missingPlayer.player}`, checks };
  }

  if (failedCheck) {
    return { ok: false, message: failedCheck.label, checks };
  }

  return { ok: true, lineup: parseResult.lineup, checks };
}

function registerProvisionalActual(lineup, sourceUrl, fetchedAt, workerMeta, validationChecks, approvalStatus = "provisional") {
  const normalizedLineup = normalizeLineup(lineup);
  const isApproved = approvalStatus === "approved";
  setLineupValues("actual", normalizedLineup);
  state.actual = {
    lineup: normalizedLineup,
    savedAt: fetchedAt.toISOString(),
    approvalStatus: isApproved ? "approved" : "provisional",
    sourceUrl,
    fetchedAt: fetchedAt.toISOString(),
    registeredBy: "auto-fetch",
    workerMeta: workerMeta || null,
    validationChecks: validationChecks || [],
    ...(isApproved ? { approvedAt: new Date().toISOString() } : {})
  };
  state.actualPreview = null;
  state.adminStatus = isApproved ? "approved" : "provisional";
  state.adminError = "";
  state.result = null;
  saveToStorage(STORAGE_KEYS.actual, state.actual);
  removeFromStorage(STORAGE_KEYS.result);
  renderActualLineup();
  renderAdminFlow();
  renderScoreResult();
  if (isApproved) {
    void saveApprovedActualLineupForAutoScoring();
  }
}

function approveProvisionalActual() {
  if (!state.actual || state.actual.approvalStatus !== "provisional") {
    showMessage("parserError", "仮承認済みの実スタメンがありません。");
    return;
  }

  state.actual.approvalStatus = "approved";
  state.actual.approvedAt = new Date().toISOString();
  state.adminStatus = "approved";
  saveToStorage(STORAGE_KEYS.actual, state.actual);
  renderAdminFlow();
  showMessage("parserError", "");
  void saveApprovedActualLineupForAutoScoring();
}

function editProvisionalActual() {
  if (!state.actual || state.actual.approvalStatus !== "provisional") {
    showMessage("parserError", "修正できる仮承認済み実スタメンがありません。");
    return;
  }

  state.actualPreview = normalizeLineup(state.actual.lineup);
  state.actual = null;
  state.adminStatus = "preview";
  state.adminError = "";
  removeFromStorage(STORAGE_KEYS.actual);
  renderAdminFlow();
  showMessage("parserError", "仮承認済みの内容を候補プレビューに戻しました。必要に応じて修正して承認してください。");
}

function cancelProvisionalActual() {
  if (!state.actual || state.actual.approvalStatus !== "provisional") {
    showMessage("parserError", "取り消せる仮承認済み実スタメンがありません。");
    return;
  }

  state.actual = null;
  state.actualPreview = null;
  state.adminStatus = "idle";
  state.adminError = "";
  state.result = null;
  removeFromStorage(STORAGE_KEYS.actual);
  removeFromStorage(STORAGE_KEYS.result);
  setLineupValues("actual", normalizeLineup([]));
  renderAll();
  showMessage("parserError", "仮承認を取り消しました。");
}

function getGameStartDate() {
  const value = document.getElementById("gameStartInput")?.value;
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isNpbScoresUrl(value) {
  try {
    const url = new URL(value);
    return (url.hostname === "npb.jp" || url.hostname.endsWith(".npb.jp")) && url.pathname.startsWith("/scores/");
  } catch (error) {
    return false;
  }
}

function validateNpbUrl(value) {
  const trimmedUrl = String(value || "").trim();

  if (!trimmedUrl) {
    return { ok: false, message: "NPB公式ページURLを入力してください。" };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch (error) {
    return { ok: false, message: "URL形式が不正です。https://npb.jp/ から始まる公式ページURLを入力してください。" };
  }

  if (!/^https?:$/.test(parsedUrl.protocol)) {
    return { ok: false, message: "httpまたはhttpsのURLを入力してください。" };
  }

  const isNpbUrl = parsedUrl.hostname.toLowerCase().includes("npb.jp");
  return {
    ok: true,
    url: parsedUrl.href,
    warning: isNpbUrl ? "" : "npb.jpを含まないURLです。公式ページURLか確認してください。"
  };
}

function extractNpbOrderText(html) {
  const plainText = htmlToPlainText(html);
  return extractNpbOrderTextFromPlainText(plainText);
}

function htmlToPlainText(html) {
  if (typeof DOMParser !== "undefined") {
    const documentObject = new DOMParser().parseFromString(html, "text/html");
    return documentObject.body ? documentObject.body.innerText || documentObject.body.textContent || "" : "";
  }

  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|th|td|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function extractNpbOrderTextFromPlainText(text) {
  const lines = normalizeNpbTextLines(text);
  const orderStartIndex = lines.findIndex((line) => line.includes("最新のオーダー"));
  const searchStartIndex = orderStartIndex >= 0 ? orderStartIndex + 1 : 0;
  const fightersIndex = findFightersOrderStartIndex(lines, searchStartIndex);
  const candidateStartIndex = fightersIndex >= 0 ? fightersIndex + 1 : searchStartIndex;
  const fightersRows = collectNpbOrderRows(lines.slice(candidateStartIndex));

  if (fightersRows.length === LINEUP_SIZE) {
    return formatNpbRowsForParser(fightersRows);
  }

  const fallbackRows = collectNpbOrderRows(lines.slice(searchStartIndex));
  if (fallbackRows.length === LINEUP_SIZE) {
    return formatNpbRowsForParser(fallbackRows);
  }

  return "";
}

function normalizeNpbTextLines(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\u3000/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function findFightersOrderStartIndex(lines, startIndex) {
  return lines.findIndex((line, index) => {
    return index >= startIndex && FIGHTERS_TEAM_KEYWORDS.some((keyword) => line.includes(keyword));
  });
}

function collectNpbOrderRows(lines) {
  const rows = [];
  const seenOrders = new Set();

  for (const line of lines) {
    const row = parseNpbOrderRow(line);
    if (!row) {
      if (rows.length > 0 && rows.length < LINEUP_SIZE && isLikelyOtherTeamHeading(line)) {
        break;
      }
      continue;
    }

    if (seenOrders.has(row.order)) {
      break;
    }

    rows.push(row);
    seenOrders.add(row.order);

    if (rows.length === LINEUP_SIZE) {
      return rows;
    }
  }

  return rows;
}

function parseNpbOrderRow(line) {
  const normalizedLine = line.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
  const match = normalizedLine.match(/^([1-9])\s+([^\s]+)\s+(.+)$/);

  if (!match) {
    return null;
  }

  const position = normalizePosition(match[2]);
  if (!position) {
    return null;
  }

  const player = normalizePlayerName(match[3].replace(/\s+/g, " ").trim());
  if (!player) {
    return null;
  }

  return {
    order: Number(match[1]),
    position,
    player
  };
}

function isLikelyOtherTeamHeading(line) {
  return /ファイターズ|ホークス|マリーンズ|イーグルス|ライオンズ|バファローズ|ジャイアンツ|タイガース|ベイスターズ|カープ|スワローズ|ドラゴンズ/.test(line);
}

function formatNpbRowsForParser(rows) {
  return rows
    .sort((first, second) => first.order - second.order)
    .map((row) => `${row.order} ${row.position} ${row.player}`)
    .join("\n");
}

function setNpbFetchMessage(message, type) {
  const element = document.getElementById("npbFetchMessage");
  if (!element) {
    return;
  }

  element.textContent = message;
  element.className = `message npb-message${type ? ` is-${type}` : ""}`;
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
  event.preventDefault();
  if (state.predictionRemote.isSaving) {
    return;
  }

  clearMessage("predictionError");
  clearMessage("predictionSaveMessage");
  clearMessage("predictionResetMessage");
  clearMessage("resetMessage");

  const lineup = getLineupValues("prediction");
  const validationError = validateLineup(lineup, "予想");

  if (validationError) {
    showMessage("predictionError", validationError);
    markDuplicateSlots("prediction", lineup);
    return;
  }

  state.prediction = {
    gameId: getCurrentGameId(),
    lineup,
    savedAt: new Date().toISOString()
  };

  saveToStorage(STORAGE_KEYS.prediction, state.prediction);
  state.result = null;
  removeFromStorage(STORAGE_KEYS.result);
  renderAll();
  if (!getPredictionAccountUser()) {
    showPredictionSaveMessage("この端末に予想を保存しました。");
    return;
  }

  const savedToAccount = await savePredictionToAccount(state.prediction);
  if (savedToAccount) {
    showPredictionSaveMessage("予想を保存しました。");
    return;
  }

  showMessage("predictionError", state.predictionRemote.message || "端末には保存しましたが、アカウントへの保存に失敗しました。");
}

function resetPredictionInput() {
  const confirmed = window.confirm("入力中の予想をリセットします。よろしいですか？");
  if (!confirmed) {
    return;
  }

  const remoteGameId = getCurrentGameId();
  state.prediction = null;
  state.result = null;
  state.activeOrder.prediction = 0;
  removeFromStorage(STORAGE_KEYS.prediction);
  removeFromStorage(STORAGE_KEYS.result);

  document.getElementById("predictionForm").reset();
  setLineupValues("prediction", []);
  closeAllPositionMenus();
  ["predictionPlayerDetails", "predictionResetMessage"].forEach((elementId) => {
    const element = document.getElementById(elementId);
    if (elementId === "predictionPlayerDetails") {
      element.classList.add("hidden");
      element.innerHTML = "";
    } else {
      element.textContent = "予想をリセットしました。";
    }
  });
  clearMessage("predictionError");
  clearMessage("testPredictionMessage");
  renderSavedPrediction();
  renderScoreResult();
  renderPredictionAccountStatus();
  renderPicker("prediction");
  if (remoteGameId && getPredictionAccountUser()) {
    deletePredictionFromAccount(remoteGameId);
  }
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

  state.result = {
    ...scoreLineup(state.prediction.lineup, state.actual.lineup),
    gameId: getCurrentGameId()
  };

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
  const normalizedPlayer = player ? normalizePlayerName(player) : "";

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
  state.gameInfo = normalizeGameInfo(loadFromStorage(STORAGE_KEYS.gameInfo));
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
    state.adminStatus = getAdminStatusFromActual();
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
    matchup: typeof gameInfo?.matchup === "string" ? gameInfo.matchup : ""
  };
}

function restoreAdminGameInfoInputs() {
  const inputMap = {
    npbUrlInput: state.gameInfo.scoreUrl,
    gameStartInput: state.gameInfo.gameStartAt,
    matchupInput: state.gameInfo.matchup
  };

  Object.entries(inputMap).forEach(([elementId, value]) => {
    const input = document.getElementById(elementId);
    if (input) {
      input.value = value || "";
    }
  });
}

function saveAdminGameInfoFromInputs() {
  if (!state.isAdminMode) {
    return;
  }

  state.gameInfo = readAdminGameInfoFromInputs();
  saveToStorage(STORAGE_KEYS.gameInfo, state.gameInfo);
  renderGameInfoDisplay();
}

function readAdminGameInfoFromInputs() {
  return {
    scoreUrl: document.getElementById("npbUrlInput")?.value.trim() || "",
    gameStartAt: document.getElementById("gameStartInput")?.value || "",
    matchup: document.getElementById("matchupInput")?.value.trim() || ""
  };
}

function getHamGameSchedule() {
  return typeof window !== "undefined" && Array.isArray(window.HAM_GAME_SCHEDULE)
    ? window.HAM_GAME_SCHEDULE
    : [];
}

function addScheduleLoadLog(message) {
  if (typeof window !== "undefined" && typeof window.addHamScheduleLog === "function") {
    window.addHamScheduleLog(message);
    return;
  }

  if (typeof window !== "undefined") {
    window.HAM_GAME_SCHEDULE_LOG = Array.isArray(window.HAM_GAME_SCHEDULE_LOG)
      ? window.HAM_GAME_SCHEDULE_LOG
      : [];
    const now = new Date();
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
    window.HAM_GAME_SCHEDULE_LOG.push(`[${time}] ${message}`);
  }
  renderScheduleLoadLog();
}

function renderScheduleLoadLog() {
  const container = document.getElementById("scheduleLoadLog");
  if (!container) {
    return;
  }

  const entries = typeof window !== "undefined" && Array.isArray(window.HAM_GAME_SCHEDULE_LOG)
    ? window.HAM_GAME_SCHEDULE_LOG
    : [];
  container.textContent = entries.join("\n");
  container.scrollTop = container.scrollHeight;
}

function clearScheduleLoadLog() {
  if (typeof window !== "undefined") {
    window.HAM_GAME_SCHEDULE_LOG = [];
  }
  renderScheduleLoadLog();
}

async function copyScheduleLoadLog() {
  const text = document.getElementById("scheduleLoadLog")?.textContent || "";
  if (!text) {
    setScheduleLoaderMessage("コピーするログがありません。", "warning");
    return;
  }

  try {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard APIが利用できません");
    }
    await navigator.clipboard.writeText(text);
    setScheduleLoaderMessage("試合日程読み込みログをコピーしました。", "success");
  } catch (error) {
    console.error("試合日程読み込みログのコピーに失敗しました", error);
    addScheduleLoadLog(`ログのコピーに失敗：${error.message}`);
    setScheduleLoaderMessage("ログのコピーに失敗しました。", "warning");
  }
}

function handleScheduleSelectionChange(event) {
  const gameId = event.target.value;
  const schedule = getHamGameSchedule().find((item) => item.gameId === gameId);
  if (schedule) {
    addScheduleLoadLog(`セレクトボックスで選択：${formatScheduleForLog(schedule)}`);
  }
}

function formatScheduleForLog(schedule) {
  const round = Number(schedule?.round);
  const roundLabel = Number.isInteger(round) && round > 0 ? ` ${round}回戦` : "";
  return `${getScheduleDate(schedule)} ${schedule?.matchupLabel || "対戦カード不明"}${roundLabel}`;
}

function formatScheduleLongDate(date, time) {
  const [year, month, day] = String(date || "").split("-").map(Number);
  if (![year, month, day].every(Number.isInteger)) {
    return `${date || "日付不明"} ${time || ""}`.trim();
  }
  return `${year}年${month}月${day}日 ${time || ""}`.trim();
}

function resolveNpbScoreUrl(schedule) {
  const generator = typeof window !== "undefined" ? window.generateNpbScoreUrl : null;
  if (typeof generator === "function") {
    try {
      const generatedUrl = generator(schedule);
      addScheduleLoadLog(`NPB URL生成：${generatedUrl}`);
      return generatedUrl;
    } catch (error) {
      const message = `URL生成に必要な情報が不足しています：${error.message}`;
      addScheduleLoadLog(message);
      console.error(message, schedule, error);
    }
  }

  const fallbackUrl = typeof schedule?.npbScoreUrl === "string" ? schedule.npbScoreUrl : "";
  if (fallbackUrl) {
    addScheduleLoadLog(`NPB URLフォールバックを使用：${fallbackUrl}`);
  }
  return fallbackUrl;
}

function renderGameSchedulePicker() {
  const select = document.getElementById("gameScheduleSelect");
  if (!select || !state.isAdminMode) {
    return;
  }

  const currentValue = select.value;
  select.innerHTML = "";
  const schedules = getHamGameSchedule();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "登録済み試合を選択";
  select.appendChild(placeholder);

  schedules.forEach((schedule) => {
    const option = document.createElement("option");
    option.value = schedule.gameId;
    option.textContent = `${getScheduleDate(schedule)} ${getScheduleStartTime(schedule)} ${schedule.matchupLabel}`;
    select.appendChild(option);
  });

  if (schedules.some((schedule) => schedule.gameId === currentValue)) {
    select.value = currentValue;
  } else if (schedules.some((schedule) => schedule.gameId === state.nextScheduleId)) {
    select.value = state.nextScheduleId;
  }

  renderNextGameScheduleSummary(findNextGameSchedule());
}

function initializeGameSchedule() {
  if (!state.isAdminMode) {
    return;
  }

  const nextSchedule = findNextGameSchedule();
  state.nextScheduleId = nextSchedule?.gameId || "";
  renderGameSchedulePicker();
  refreshAdminScoringSummary({ force: true });

  if (nextSchedule) {
    addScheduleLoadLog(`次の試合を検出：${formatScheduleForLog(nextSchedule)}`);
  } else {
    addScheduleLoadLog("次の試合を検出できませんでした");
  }

  if (!nextSchedule || !areAdminGameInfoInputsEmpty()) {
    if (nextSchedule && !areAdminGameInfoInputsEmpty()) {
      addScheduleLoadLog("localStorageに既存試合情報があるため自動反映をスキップ");
    }
    return;
  }

  applyGameSchedule(nextSchedule, "auto");
  setScheduleLoaderMessage("次の試合情報を自動入力しました。必要に応じて手動で変更できます。", "success");
}

function findNextGameSchedule() {
  const today = getJapanDateString();
  return getHamGameSchedule()
    .filter((schedule) => getScheduleDate(schedule) >= today)
    .sort((left, right) => getScheduleSortValue(left).localeCompare(getScheduleSortValue(right)))[0] || null;
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

function renderNextGameScheduleSummary(schedule) {
  const container = document.getElementById("nextGameScheduleSummary");
  if (!container) {
    return;
  }

  if (!state.isAdminMode || !schedule) {
    container.classList.add("hidden");
    container.textContent = "";
    return;
  }

  const date = getScheduleDate(schedule);
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const venue = schedule.venue ? ` ${schedule.venue}` : "";
  container.textContent = `次の登録済み試合：${month}/${day} ${schedule.matchupLabel} ${getScheduleStartTime(schedule)}${venue}`;
  container.classList.remove("hidden");
}

function areAdminGameInfoInputsEmpty() {
  return ["matchupInput", "npbUrlInput", "gameStartInput"].every((elementId) => {
    return !(document.getElementById(elementId)?.value || "").trim();
  });
}

function loadNextGameSchedule() {
  addScheduleLoadLog("「次の試合を読み込む」を実行");
  const schedule = findNextGameSchedule();
  if (!schedule) {
    setScheduleLoaderMessage("今日以降の登録済み試合はありません。", "warning");
    addScheduleLoadLog("読み込む次の試合が見つかりませんでした");
    return;
  }

  state.nextScheduleId = schedule.gameId;
  renderGameSchedulePicker();
  applyGameSchedule(schedule);
  setScheduleLoaderMessage(`次の試合「${schedule.matchupLabel}」を読み込みました。`, "success");
}

function loadTodayGameSchedule() {
  addScheduleLoadLog("「今日の試合を読み込む」を実行");
  const today = getLocalDateString();
  const schedule = getHamGameSchedule().find((item) => getScheduleDate(item) === today);

  if (!schedule) {
    setScheduleLoaderMessage(`本日（${today}）の登録済み試合はありません。`, "warning");
    addScheduleLoadLog(`本日（${today}）の試合が見つかりませんでした`);
    return;
  }

  applyGameSchedule(schedule);
  setScheduleLoaderMessage(`今日の試合「${schedule.matchupLabel}」を読み込みました。`, "success");
}

function loadSelectedGameSchedule() {
  addScheduleLoadLog("「選択した試合を読み込む」を実行");
  const gameId = document.getElementById("gameScheduleSelect")?.value || "";
  const schedule = getHamGameSchedule().find((item) => item.gameId === gameId);

  if (!schedule) {
    setScheduleLoaderMessage("読み込む試合を選択してください。", "warning");
    addScheduleLoadLog("選択された試合が見つかりませんでした");
    return;
  }

  applyGameSchedule(schedule);
  setScheduleLoaderMessage(`試合「${schedule.matchupLabel}」を読み込みました。`, "success");
}

function applyGameSchedule(schedule, source = "button") {
  const matchupInput = document.getElementById("matchupInput");
  const scoreUrlInput = document.getElementById("npbUrlInput");
  const gameStartInput = document.getElementById("gameStartInput");
  const scheduleSelect = document.getElementById("gameScheduleSelect");

  if (!matchupInput && !scoreUrlInput && !gameStartInput) {
    addScheduleLoadLog("試合入力欄が見つからないため反映できませんでした");
    return;
  }

  state.nextScheduleId = schedule.gameId || "";
  const scoreUrl = resolveNpbScoreUrl(schedule);
  if (matchupInput) {
    matchupInput.value = schedule.matchupLabel || "";
  } else {
    addScheduleLoadLog("対戦カード入力欄が見つかりませんでした");
  }
  if (scoreUrlInput) {
    scoreUrlInput.value = scoreUrl;
  } else {
    addScheduleLoadLog("NPB URL入力欄が見つかりませんでした");
  }
  if (gameStartInput) {
    gameStartInput.value = `${getScheduleDate(schedule)}T${getScheduleStartTime(schedule)}`;
  } else {
    addScheduleLoadLog("試合開始日時入力欄が見つかりませんでした");
  }
  if (scheduleSelect) {
    scheduleSelect.value = schedule.gameId;
  }
  saveAdminGameInfoFromInputs();
  renderLoadedScheduleInfo(schedule, scoreUrl);
  syncPredictionFromAccount({ force: true });
  refreshAdminScoringSummary({ force: true });
  if (source === "auto") {
    addScheduleLoadLog(`自動反映した試合：${formatScheduleForLog(schedule)}`);
  } else {
    addScheduleLoadLog(`読み込み完了：${formatScheduleForLog(schedule)}`);
  }
}

function renderLoadedScheduleInfo(schedule, scoreUrl = resolveNpbScoreUrl(schedule)) {
  const container = document.getElementById("loadedScheduleInfo");
  if (!container) {
    return;
  }

  const scheduleDate = getScheduleDate(schedule);
  const scheduleStartTime = getScheduleStartTime(schedule);
  const lineupStart = getScheduleLineupStart(schedule);
  const rosterStart = schedule.rosterAutoFetchStartTime
    ? `${scheduleDate}T${schedule.rosterAutoFetchStartTime}`
    : "";
  const interval = Number(schedule.lineupAutoFetchIntervalMinutes);
  const round = Number(schedule.round);
  const role = schedule.homeTeam === "fighters" ? "ホーム" : schedule.awayTeam === "fighters" ? "ビジター" : "-";
  const rows = [
    ["現在の対象試合", formatScheduleLongDate(scheduleDate, scheduleStartTime)],
    ["対戦", schedule.matchupLabel || "-"],
    ["回戦", Number.isInteger(round) && round > 0 ? `${round}回戦` : "-"],
    ["区分", role],
    ["会場", schedule.venue || "-"],
    ["スタメン自動取得開始予定", lineupStart ? formatScheduleDateTime(lineupStart) : "-"],
    ["ロースター自動取得開始予定", rosterStart ? formatScheduleDateTime(rosterStart) : "-"],
    ["スタメン取得間隔", Number.isFinite(interval) && interval > 0 ? `${interval}分` : "-"],
    ["NPB URL", scoreUrl || "-"]
  ];

  container.classList.remove("hidden");
  container.innerHTML = `<dl>${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}

function getScheduleLineupStart(schedule) {
  const date = getScheduleDate(schedule);
  const time = getScheduleStartTime(schedule);
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const offsetMinutes = Number(schedule.lineupAutoFetchStartOffsetMinutes);
  const start = new Date(Date.UTC(year, month - 1, day, hour, minute));

  if (!date || !time || Number.isNaN(start.getTime())) {
    return "";
  }

  if (Number.isFinite(offsetMinutes)) {
    start.setUTCMinutes(start.getUTCMinutes() + offsetMinutes);
  }

  const nextYear = start.getUTCFullYear();
  const nextMonth = String(start.getUTCMonth() + 1).padStart(2, "0");
  const nextDay = String(start.getUTCDate()).padStart(2, "0");
  const nextHour = String(start.getUTCHours()).padStart(2, "0");
  const nextMinute = String(start.getUTCMinutes()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}T${nextHour}:${nextMinute}`;
}

function getLocalDateString() {
  return getJapanDateString();
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

function formatScheduleDateTime(value) {
  const [date, time] = String(value || "").split("T");
  if (!date || !time) {
    return "-";
  }

  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return `${month}/${day} ${time.slice(0, 5)}`;
}

function setScheduleLoaderMessage(message, type) {
  const element = document.getElementById("scheduleLoaderMessage");
  if (!element) {
    return;
  }

  element.textContent = message;
  element.className = `message schedule-loader-message${type ? ` is-${type}` : ""}`;
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
  renderGameInfoDisplay();
  renderGameSchedulePicker();
  renderProbableStarter();
  renderSavedPrediction();
  renderPredictionAccountStatus();
  renderAchievements();
  renderActualLineup();
  renderScoreResult();
  renderPerfectAchievers();
  renderRankingPanel();
  renderAdminFlow();
  renderPicker("prediction");
  renderPicker("actual");
}

function renderProbableStarter() {
  renderProbableStarterDisplay();
  renderProbableStarterAdmin();
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
      <p class="probable-starter-label">予告先発</p>
      <p class="probable-starter-message">予告先発を取得中...</p>
    `;
    return;
  }

  if (probableStarter.status === "error") {
    container.className = "probable-starter-card is-error";
    container.innerHTML = `
      <p class="probable-starter-label">予告先発</p>
      <p class="probable-starter-message">予告先発を取得できませんでした</p>
    `;
    return;
  }

  const matchedGame = probableStarter.matchedGame;
  const fightersStarter = getFightersStarter(matchedGame);
  if (!matchedGame || !fightersStarter) {
    container.className = "probable-starter-card is-pending";
    container.innerHTML = `
      <p class="probable-starter-label">予告先発</p>
      <p class="probable-starter-message">予告先発はまだ発表されていません</p>
      <p class="probable-starter-meta">${escapeHtml(formatScheduledGameForLog(probableStarter.nextGame))}</p>
    `;
    return;
  }

  const dateText = formatProbableStarterDate(matchedGame.date || probableStarter.nextGame.date);
  const gameInfo = `${dateText} ${matchedGame.startTime || probableStarter.nextGame.startTime || ""}`.trim();
  const sourceUrl = probableStarter.sourceUrl || NPB_STARTER_SOURCE_URL;
  const isPending = probableStarter.status === "unannounced";
  container.className = `probable-starter-card ${isPending ? "is-pending" : "is-success"}`;
  container.innerHTML = `
    <div class="probable-starter-heading">
      <p class="probable-starter-label">予告先発</p>
      <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">NPB公式</a>
    </div>
    ${isPending ? `<p class="probable-starter-message">予告先発はまだ発表されていません</p>` : `
      <div class="probable-starter-grid">
        ${createProbableStarterTeamHtml("日本ハム", fightersStarter.fighters?.name)}
        ${createProbableStarterTeamHtml(fightersStarter.opponentName || "相手チーム", fightersStarter.opponent?.name)}
      </div>
    `}
    <p class="probable-starter-meta">${escapeHtml(gameInfo)}${matchedGame.venue ? ` ・ ${escapeHtml(matchedGame.venue)}` : ""}</p>
    <p class="probable-starter-fetched">取得：${escapeHtml(formatDateTime(probableStarter.fetchedAt))}</p>
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

function renderProbableStarterAdmin() {
  const statusContainer = document.getElementById("probableStarterAdminStatus");
  const logContainer = document.getElementById("probableStarterAdminLog");
  const button = document.getElementById("fetchProbableStarterButton");

  if (button) {
    button.disabled = state.probableStarter.isLoading;
  }

  if (statusContainer) {
    const statusClassMap = {
      success: "success-message",
      unannounced: "npb-message is-warning",
      error: "error-message",
      loading: "npb-message is-info"
    };
    statusContainer.className = `message ${statusClassMap[state.probableStarter.status] || ""}`.trim();
    statusContainer.textContent = state.probableStarter.message || "次の試合を検出して取得します。";
  }

  if (!logContainer) {
    return;
  }

  if (!state.probableStarter.logs.length) {
    logContainer.classList.add("hidden");
    logContainer.innerHTML = "";
    return;
  }

  logContainer.classList.remove("hidden");
  logContainer.innerHTML = `
    <p class="preview-title">予告先発取得ログ</p>
    <ol>${state.probableStarter.logs.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ol>
  `;
}

function renderGameInfoDisplay() {
  const display = document.getElementById("gameInfoDisplay");
  if (!display) {
    return;
  }

  const matchup = state.gameInfo?.matchup?.trim();
  if (!matchup) {
    display.classList.add("hidden");
    display.textContent = "";
    return;
  }

  display.textContent = `今日の試合：${matchup}`;
  display.classList.remove("hidden");
}

function renderAdminFlow() {
  if (!state.adminStatus || state.adminStatus === "idle") {
    state.adminStatus = getAdminStatusFromActual();
  }

  renderAdminStatus();
  renderActualPreview(state.actualPreview);
  updateAdminButtons();
  updateAutoFetchButtons();
  renderAdminScoringPanel();
  renderAutoScoringPanel();
  updateRosterMonitorButtons();
  renderAutoFetchPanel();
  renderRosterSnapshotSummary();
  renderRosterMonitorSummary();
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
      body: state.actual?.approvedAt ? `本承認済み：${formatDateTime(state.actual.approvedAt)}` : state.actual?.savedAt ? `承認済み：${formatDateTime(state.actual.savedAt)}` : "承認済みです。"
    },
    provisional: {
      className: "is-provisional",
      title: "状態：仮承認済み",
      body: createProvisionalStatusText()
    },
    autoFailed: {
      className: "is-error",
      title: "取得失敗",
      body: state.adminError || "自動取得で候補を取得できませんでした。手動取得または貼り付けを使ってください。"
    },
    needsReview: {
      className: "is-error",
      title: "要確認",
      body: state.adminError || "自動取得した候補に確認が必要です。手動取得または貼り付けを使ってください。"
    },
    error: {
      className: "is-error",
      title: "エラーあり",
      body: state.adminError || "入力内容を修正して、もう一度候補を読み取ってください。"
    }
  };
  const current = statusMap[state.adminStatus] || statusMap.idle;
  const approvedList = (state.adminStatus === "approved" || state.adminStatus === "provisional") && state.actual ? createLineupPreviewHtml(state.actual.lineup) : "";

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
  const approveProvisionalButton = document.getElementById("approveProvisionalButton");
  const editProvisionalButton = document.getElementById("editProvisionalButton");
  const cancelProvisionalButton = document.getElementById("cancelProvisionalButton");

  if (!applyButton || !clearButton || !approveProvisionalButton || !editProvisionalButton || !cancelProvisionalButton) {
    return;
  }

  const hasPreview = state.adminStatus === "preview" && Boolean(state.actualPreview);
  const hasCandidateState = Boolean(state.actualPreview) || ["error", "autoFailed", "needsReview"].includes(state.adminStatus);
  const hasProvisional = state.adminStatus === "provisional" && state.actual?.approvalStatus === "provisional";
  applyButton.classList.toggle("hidden", !hasPreview);
  applyButton.disabled = !hasPreview;
  clearButton.classList.toggle("hidden", !hasCandidateState);
  approveProvisionalButton.classList.toggle("hidden", !hasProvisional);
  editProvisionalButton.classList.toggle("hidden", !hasProvisional);
  cancelProvisionalButton.classList.toggle("hidden", !hasProvisional);
  approveProvisionalButton.disabled = !hasProvisional;
  editProvisionalButton.disabled = !hasProvisional;
  cancelProvisionalButton.disabled = !hasProvisional;
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
    const categoryClass = getPlayerCategoryClassNames(item.player);
    return `
      <li class="${categoryClass}">
        <strong>${item.order}番</strong>
        <span>${escapeHtml(item.position)}</span>
        <span>${escapeHtml(item.player)}</span>
      </li>
    `;
  }).join("");

  return `<ul class="preview-list">${items}</ul>`;
}

function getAdminStatusFromActual() {
  if (!state.actual) {
    return "idle";
  }

  return state.actual.approvalStatus === "provisional" ? "provisional" : "approved";
}

function createProvisionalStatusText() {
  if (!state.actual) {
    return "仮承認済みの実スタメンはありません。";
  }

  const lines = [
    "自動取得で登録された実スタメンです。",
    state.actual.sourceUrl ? `取得元URL：${state.actual.sourceUrl}` : "",
    state.actual.fetchedAt ? `取得時刻：${formatDateTime(state.actual.fetchedAt)}` : "",
    "採点には利用できます。本承認・修正・取り消しを選択してください。"
  ].filter(Boolean);

  return lines.join("\n");
}

function updateAutoFetchButtons() {
  const startButton = document.getElementById("startAutoFetchButton");
  const stopButton = document.getElementById("stopAutoFetchButton");

  if (!startButton || !stopButton) {
    return;
  }

  startButton.disabled = state.autoFetch.isRunning;
  stopButton.disabled = !state.autoFetch.isRunning;
}

function updateRosterMonitorButtons() {
  const startButton = document.getElementById("startRosterMonitorButton");
  const stopButton = document.getElementById("stopRosterMonitorButton");
  const checkButton = document.getElementById("checkRosterButton");

  if (!startButton || !stopButton || !checkButton) {
    return;
  }

  startButton.disabled = state.rosterMonitor.isRunning;
  stopButton.disabled = !state.rosterMonitor.isRunning;
  checkButton.disabled = state.rosterMonitor.status === "fetching";
}

function setAutoFetchStatus(message, type) {
  const element = document.getElementById("autoFetchStatus");
  if (!element) {
    return;
  }

  element.textContent = message;
  element.className = `message auto-fetch-message${type ? ` is-${type}` : ""}`;
}

function addAutoFetchLog(message) {
  const time = new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());

  state.autoFetch.logs.push(`${time} ${message}`);
  if (state.autoFetch.logs.length > 30) {
    state.autoFetch.logs = state.autoFetch.logs.slice(-30);
  }
  renderAutoFetchPanel();
}

function renderAutoFetchPanel() {
  renderAutoFetchSummary();
  renderAutoFetchValidation();
  renderAutoFetchLog();
  renderRosterMonitorSummary();
}

function renderAutoFetchSummary() {
  const container = document.getElementById("autoFetchSummary");
  if (!container) {
    return;
  }

  const meta = state.autoFetch.workerMeta || state.actual?.workerMeta || null;
  const displaySourceUrl = state.autoFetch.sourceUrl || state.actual?.sourceUrl || state.gameInfo?.scoreUrl || "-";
  const displayGameStartAt = state.autoFetch.gameStartAt || state.gameInfo?.gameStartAt || "";
  const rows = [
    ["自動取得状態", getAutoFetchStatusLabel()],
    ["試行回数", `${state.autoFetch.attempts} / ${AUTO_FETCH_MAX_ATTEMPTS}`],
    ["次回取得予定時刻", state.autoFetch.nextRunAt ? formatDateTime(state.autoFetch.nextRunAt) : "-"],
    ["試合開始時刻", displayGameStartAt ? formatDateTime(displayGameStartAt) : "-"],
    ["最終取得時刻", state.autoFetch.lastCheckedAt ? formatDateTime(state.autoFetch.lastCheckedAt) : "-"],
    ["取得元URL", displaySourceUrl],
    ["Worker取得時刻", meta?.fetchedAt ? formatDateTime(meta.fetchedAt) : "-"],
    ["抽出方式", meta?.method || "-"],
    ["対象チーム", meta?.team || "-"]
  ];

  container.innerHTML = `<dl>${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}

function renderAutoFetchValidation() {
  const container = document.getElementById("autoFetchValidation");
  if (!container) {
    return;
  }

  const checks = state.autoFetch.validationChecks.length > 0 ? state.autoFetch.validationChecks : state.actual?.validationChecks || [];
  if (!checks.length) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  container.classList.remove("hidden");
  container.innerHTML = `
    <p class="preview-title">仮承認チェック結果</p>
    <ul>
      ${checks.map((check) => `<li><span class="${check.ok ? "is-ok" : "is-ng"}">${check.ok ? "✅" : "❌"}</span> ${escapeHtml(check.label)}</li>`).join("")}
    </ul>
  `;
}

function renderAutoFetchLog() {
  const container = document.getElementById("autoFetchLog");
  if (!container) {
    return;
  }

  if (!state.autoFetch.logs.length) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  container.classList.remove("hidden");
  container.innerHTML = `
    <p class="preview-title">管理ログ</p>
    <ol>
      ${state.autoFetch.logs.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}
    </ol>
  `;
}

function renderRosterSnapshotSummary(snapshot = null, diff = null) {
  const container = document.getElementById("rosterSnapshotSummary");
  if (!container) {
    return;
  }

  const rosterSnapshot = snapshot || normalizeRosterSnapshot(loadFromStorage(STORAGE_KEYS.rosterSnapshot));
  if (!state.isAdminMode) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const added = diff ? diff.added : state.rosterMonitor.lastAddedPlayers;
  const removed = diff ? diff.removed : state.rosterMonitor.lastRemovedPlayers;
  const hasLastResult = state.rosterMonitor.lastStatus !== "none" || Boolean(rosterSnapshot.fetchedAt);
  const playerCount = state.rosterMonitor.lastPlayerCount || rosterSnapshot.players.length;
  const lastFetchedAt = state.rosterMonitor.lastFetchedAt || rosterSnapshot.fetchedAt;
  const lastMessage = state.rosterMonitor.lastMessage || (hasLastResult ? `登録選手数：${playerCount}人` : "未取得");
  const snapshotIsUsable = canUseRosterSnapshot(rosterSnapshot);
  const snapshotIsFresh = isRosterSnapshotFresh(rosterSnapshot);
  const dataStatus = !snapshotIsUsable
    ? "未取得（選手マスタの初期状態を表示中）"
    : rosterSnapshot.stale || !snapshotIsFresh
      ? "前回成功データを継続利用中"
      : "最新取得データを使用中";
  const statusLabel = getRosterMonitorStatusLabel();
  const statusClass = getRosterMonitorStatusClass();
  const rows = [
    ["試行回数", `${state.rosterMonitor.attempts} / ${state.rosterMonitor.maxAttempts} 回`],
    ["次回取得予定", state.rosterMonitor.nextRunAt ? formatDateTime(state.rosterMonitor.nextRunAt) : "-"],
    ["最終取得", lastFetchedAt ? formatDateTime(lastFetchedAt) : "-"],
    ["最終結果", lastMessage],
    ["データ状態", dataStatus],
    ["取得元", rosterSnapshot.sourceUrl || "-"],
    ["HTTPステータス", rosterSnapshot.httpStatus ? String(rosterSnapshot.httpStatus) : "-"],
    ["解析件数", rosterSnapshot.parsedCount ? `${rosterSnapshot.parsedCount}人` : "-"],
    ["キャッシュ", rosterSnapshot.cacheStatus || "-"],
    ["最終差分", hasLastResult ? (added.length || removed.length ? "差分あり" : "変更なし") : "未取得"],
    ["追加", added.length ? added.join("、") : "なし"],
    ["削除", removed.length ? removed.join("、") : "なし"]
  ];

  if (state.rosterMonitor.lastError) {
    rows.push(["取得エラー", state.rosterMonitor.lastError]);
  }

  if (rosterSnapshot.warning) {
    rows.push(["警告", rosterSnapshot.warning]);
  }

  container.classList.remove("hidden");
  container.innerHTML = `
    <p class="roster-monitor-title">ロースター自動取得：<strong class="is-${statusClass}">${escapeHtml(statusLabel)}</strong></p>
    <dl>${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>
  `;
}

function renderRosterMonitorSummary() {
  renderRosterSnapshotSummary();
}

function getRosterMonitorStatusLabel() {
  const labels = {
    stopped: "停止中",
    waiting: "監視中",
    fetching: "取得中",
    maxAttempts: "最大試行回数到達で停止",
    errorStopped: "エラーで停止",
    manualStopped: "手動停止"
  };

  return labels[state.rosterMonitor.status] || "停止中";
}

function getRosterMonitorStatusClass() {
  const statusClasses = {
    waiting: "monitoring",
    fetching: "fetching",
    maxAttempts: "max-attempts",
    errorStopped: "error",
    manualStopped: "manual"
  };

  return statusClasses[state.rosterMonitor.status] || "stopped";
}

function getAutoFetchStatusLabel() {
  if (state.actual?.approvalStatus === "approved" && state.autoFetch.status === "approved") {
    return "本承認済み";
  }

  if (state.actual?.approvalStatus === "provisional" || state.autoFetch.status === "provisional") {
    return "仮承認済み";
  }

  const labels = {
    stopped: "停止中",
    waiting: "待機中",
    fetching: "取得中",
    failed: "取得失敗"
  };

  return labels[state.autoFetch.status] || "停止中";
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
    const positionButton = slot.querySelector(".position-button");
    const dragHandle = slot.querySelector(".slot-drag-handle");
    const clearButton = slot.querySelector(".slot-clear");

    slot.classList.toggle("is-active", state.activeOrder[pickerName] === index);
    slot.classList.toggle("has-player", Boolean(player));
    slot.classList.toggle("is-duplicate", duplicatedPlayers.has(player) || duplicatedPositions.has(position));
    slot.draggable = false;
    slot.setAttribute("aria-label", `${index + 1}番 ${position || "守備未選択"} ${player || "未選択"}`);
    playerElement.innerHTML = player ? createPlayerLabelHtml(player) : "未選択";
    playerElement.classList.toggle("slot-empty", !player);
    applyPlayerCategoryClass(slot, player);
    renderPositionButton(positionButton, position, index);
    positionButton.draggable = Boolean(position);
    dragHandle.draggable = Boolean(player);
    dragHandle.classList.toggle("is-disabled", !player);
    clearButton.classList.toggle("hidden", !player);
  });

  document.querySelectorAll(`.player-chip[data-picker="${pickerName}"]`).forEach((chip) => {
    const isUsed = usedPlayers.has(chip.dataset.player);
    chip.classList.toggle("is-used", isUsed);
  });

  if (pickerName === "prediction") {
    renderPredictionRosterFilter();
  }
}

function renderPredictionRosterFilter() {
  document.querySelectorAll('.player-chip[data-picker="prediction"]').forEach((chip) => {
    const player = getPlayerData(chip.dataset.player);
    const shouldShow = isPlayerInCurrentRoster(player) && player?.isBatterCandidate === true;
    chip.classList.toggle("hidden", !shouldShow);
  });
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
  const shareButton = document.getElementById("sharePredictionButton");

  if (!state.prediction) {
    container.className = "empty-state";
    container.textContent = "まだ予想が保存されていません。";
    shareButton.classList.add("hidden");
    return;
  }

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
      <td class="${getPlayerCategoryClassNames(detail.player)}">${escapeHtml(detail.player)}</td>
      <td class="${getPlayerCategoryClassNames(detail.actualPlayer)}">${escapeHtml(detail.actualPlayer || "-")}</td>
      <td>${createResultPositionTileHtml(detail.position)}</td>
      <td>${createResultPositionTileHtml(detail.actualPosition)}</td>
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
  meta.textContent = `保存日時：${formatDateTime(prediction.savedAt)}`;

  const list = document.createElement("ul");
  list.className = "lineup-list";
  normalizeLineup(prediction.lineup).forEach((lineupItem, index) => {
    const listItem = document.createElement("li");
    applyPlayerCategoryClass(listItem, lineupItem.player);
    listItem.innerHTML = `
      <strong>${index + 1}番</strong>
      <span>${escapeHtml(lineupItem.position)} ${escapeHtml(lineupItem.player)}</span>
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
  const gameLabel = state.gameInfo.matchup || "";
  const serviceUrl = getPredictionShareUrl();
  const lines = [
    "ハムスタメンチャレンジ予想",
    ...(gameLabel ? ["", gameLabel] : []),
    "",
    ...lineup.map((item, index) => `${index + 1}番 ${item.position} ${item.player}`),
    ...(serviceUrl ? ["", serviceUrl] : []),
    "",
    "#日ハム #lovefighters #スタメン予想"
  ];

  return lines.join("\n");
}

function getPredictionShareUrl() {
  if (!window.location?.origin || window.location.origin === "null") {
    return "";
  }
  return `${window.location.origin}${window.location.pathname}`;
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

function generateTestPrediction() {
  if (state.appMode !== "development" || !state.developmentAccess.available) {
    console.warn("開発モードではないため、テスト用予想の生成を中止しました。");
    return;
  }

  const currentLineup = getLineupValues("prediction");
  const hasExistingInput = currentLineup.some((item) => item.player || item.position);

  if (hasExistingInput && !window.confirm("現在の予想入力をテスト用データで上書きしますか？")) {
    return;
  }

  setLineupValues("prediction", TEST_PREDICTION_LINEUP);
  clearMessage("predictionError");
  clearMessage("resetMessage");
  showMessage("testPredictionMessage", "テスト用予想を入力しました。「予想を保存する」で保存できます。");
}

function resetAllData() {
  if (state.appMode !== "development" || !state.developmentAccess.available) {
    console.warn("開発モードではないため、テストデータのリセットを中止しました。");
    return;
  }

  const confirmed = window.confirm(
    "Starting9の予想、実スタメン、承認状態、採点結果、自動取得ログをすべて削除します。よろしいですか？"
  );
  if (!confirmed) {
    return;
  }

  stopAutoFetch("", "");
  stopRosterMonitor("", "", "reset");
  RESET_STORAGE_KEYS.forEach(removeFromStorage);
  state.prediction = null;
  state.actual = null;
  state.result = null;
  state.predictionRemote = createEmptyPredictionRemoteState();
  state.adminScoring = {
    isLoadingSummary: false,
    isTesting: false,
    isScoring: false,
    gameId: "",
    predictionCount: null,
    scoredCount: null,
    summaryMessage: "",
    preview: null,
    previewFingerprint: ""
  };
  resetAutoScoringState();
  state.actualPreview = null;
  state.adminStatus = "idle";
  state.adminError = "";
  state.autoFetch.isRunning = false;
  state.autoFetch.timerId = null;
  state.autoFetch.startedAt = "";
  state.autoFetch.lastCheckedAt = "";
  state.autoFetch.lastError = "";
  state.autoFetch.attempts = 0;
  state.autoFetch.sourceUrl = "";
  state.autoFetch.gameStartAt = "";
  state.autoFetch.nextRunAt = "";
  state.autoFetch.status = "stopped";
  state.autoFetch.logs = [];
  state.autoFetch.validationChecks = [];
  state.autoFetch.workerMeta = null;
  state.rosterMonitor = {
    isRunning: false,
    timerId: null,
    attempts: 0,
    maxAttempts: ROSTER_MONITOR_MAX_ATTEMPTS,
    startedAt: "",
    lastCheckedAt: "",
    lastFetchedAt: "",
    lastError: "",
    nextRunAt: "",
    status: "stopped",
    stopReason: "",
    lastStatus: "none",
    lastMessage: "",
    lastAddedPlayers: [],
    lastRemovedPlayers: [],
    lastPlayerCount: 0
  };
  state.probableStarter = {
    isLoading: false,
    status: "idle",
    message: "",
    nextGame: state.probableStarter.nextGame,
    matchedGame: null,
    games: [],
    fetchedAt: "",
    sourceUrl: NPB_STARTER_SOURCE_URL,
    fetchedGameCount: 0,
    logs: [],
    fetchedGameId: ""
  };
  state.activeOrder.prediction = 0;
  state.activeOrder.actual = 0;
  state.flickStart.clear();

  document.getElementById("predictionForm").reset();
  document.getElementById("actualPasteInput").value = "";
  document.getElementById("autoApproveCheckbox").checked = false;
  ["predictionPlayerDetails", "actualPlayerDetails"].forEach((elementId) => {
    const panel = document.getElementById(elementId);
    panel.classList.add("hidden");
    panel.innerHTML = "";
  });
  setLineupValues("prediction", []);
  setLineupValues("actual", []);
  clearMessage("predictionError");
  clearMessage("actualError");
  clearMessage("parserError");
  clearMessage("testPredictionMessage");
  setNpbFetchMessage("", "");
  setAutoFetchStatus("", "");
  showMessage("resetMessage", "テストデータをリセットしました。初期状態から再テストできます。");
  renderAll();
}

function showMessage(elementId, message) {
  document.getElementById(elementId).textContent = message;
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
  document.getElementById(elementId).textContent = "";
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

  panel.classList.remove("hidden");
  const mainCategory = player.mainCategory || player.category;
  panel.innerHTML = `
    <strong>${escapeHtml(player.name)}</strong>
    <span>カテゴリ：${escapeHtml(playerCategoryNames[mainCategory] || "未設定")}</span>
    <div class="player-detail-positions">
      <span>守備候補：</span>
      ${createPlayerPositionBadgesHtml(player.name)}
    </div>
  `;
}
