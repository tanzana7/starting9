const STORAGE_KEYS = {
  prediction: "hamStarting9Prediction",
  actual: "hamStarting9Actual",
  result: "hamStarting9Result",
  gameInfo: "hamStarting9GameInfo",
  rosterSnapshot: "hamStarting9RosterSnapshot",
  candidateRosterFilter: "hamStarting9CandidateRosterFilter"
};
const ADMIN_WORKFLOW_LOGS_EXPANDED_STORAGE_KEY = "starting9AdminWorkflowLogsExpanded";
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
const POINTER_LONG_PRESS_MS = 250;
const POINTER_DRAG_DISTANCE = 8;
const DRAG_DATA_TYPE = "application/x-ham-starting9-player";
const NPB_WORKER_PRODUCTION_URL = "https://starting9-npb-fetch.tanzana7.workers.dev/";
const NPB_WORKER_LOCAL_URL = "http://127.0.0.1:8788/";
const NPB_WORKER_API_URL = getNpbWorkerApiUrl();
const NPB_STARTER_SOURCE_URL = "https://npb.jp/announcement/starter/";
const NPB_SCORE_PATH_PATTERN = /^\/scores\/(\d{4})\/(\d{2})(\d{2})\/([a-z0-9]+-[a-z0-9]+-\d+)\/$/i;
const RANKING_DISPLAY_LIMIT = 50;
const MONTHLY_RANKING_MIN_YEAR = 2020;
const YEARLY_RANKING_MIN_YEAR = 2020;
const RANKING_SERVICE_START_YEAR = 2026;
const AUTO_FETCH_START_BEFORE_MS = 50 * 60 * 1000;
const AUTO_FETCH_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_FETCH_MAX_ATTEMPTS = 5;
const ROSTER_MONITOR_INTERVAL_MS = 10 * 60 * 1000;
const ROSTER_MONITOR_MAX_ATTEMPTS = 6;
const ROSTER_SNAPSHOT_CACHE_TTL_MS = 60 * 60 * 1000;
const PREDICTION_DEADLINE_REFRESH_MS = 30 * 1000;
const GAME_PROGRESS_STATUS_REFRESH_MS = 60 * 1000;
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
let predictionDeadlineTimerId = null;
let gameProgressStatusTimerId = null;
let publicRosterSyncRequestId = 0;
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
    matchup: "",
    selectedGameId: "",
    manualGameSelection: false,
    manualStartOverride: false
  },
  nextScheduleId: "",
  candidateRosterFilter: "active",
  actualPreview: null,
  adminStatus: "idle",
  adminError: "",
  appMode: "normal",
  isAdminMode: false,
  adminAccess: {
    status: "inactive",
    requestId: 0
  },
  autoApproval: {
    enabled: true,
    loaded: false,
    isLoading: false,
    isSaving: false
  },
  adminTest: {
    status: "inactive",
    info: null,
    message: ""
  },
  adminAutoScoringTests: {
    games: [],
    selectedGameId: "",
    detail: null,
    message: "",
    isBusy: false
  },
  adminTestGames: {
    isLoading: false,
    isBusy: false,
    games: [],
    selectedGameId: "",
    detail: null,
    rescorePreview: null,
    message: ""
  },
  achievements: {
    isLoading: false,
    requestId: 0,
    items: [],
    message: ""
  },
  adminTestAchievements: {
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
  todayPerfectAchievers: {
    isLoading: false,
    requestId: 0,
    achievers: [],
    totalCount: 0,
    message: "",
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
  manualRescore: {
    isLoading: false,
    isSaving: false,
    gameId: "",
    history: null,
    audits: [],
    preview: null,
    message: ""
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
  pregameAutomation: {
    isRunning: false,
    message: ""
  },
  gameWorkflow: {
    isLoading: false,
    isUpdating: false,
    requestId: 0,
    gameId: "",
    record: null,
    message: ""
  },
  gameProgressStatus: {
    isLoading: false,
    requestId: 0,
    record: null,
    message: ""
  },
  releaseReadiness: {
    isLoading: false,
    requestId: 0,
    record: null,
    message: ""
  },
  workflowLogs: {
    isLoading: false,
    requestId: 0,
    logs: [],
    message: "",
    expanded: false
  },
  gameIdentityRepairs: {
    isLoading: false,
    requestId: 0,
    preview: null,
    message: "",
    actions: {},
    activeRepairId: "",
    blockedRepairId: "",
    lastExecution: null
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

document.addEventListener("DOMContentLoaded", () => {
  restoreAdminWorkflowLogsExpanded();
  removeLegacyAdminQueryParameter();
  state.isAdminMode = false;
  // 後続の画面初期化とは独立して、認証復元完了後の初回管理者判定を予約します。
  void initializeAuthDependentFeatures();
  buildLineupPicker("prediction", "predictionLineup", "predictionPlayers");
  buildLineupPicker("actual", "actualLineup", "actualPlayers");
  loadState();
  bindEvents();
  startAutoScoringCountdown();
  startPredictionDeadlineTicker();
  window.addEventListener("ham-schedule-log-updated", renderScheduleLoadLog);
  renderScheduleLoadLog();
  restoreAdminGameInfoInputs();
  applyAdminMode();
  renderAll();
  void initializePublicGameCatalog();

  const scheduleReady = window.HAM_GAME_SCHEDULE_READY;
  if (scheduleReady && typeof scheduleReady.then === "function") {
    scheduleReady.then(() => {
      if (window.HAM_GAME_SCHEDULE_ERROR) {
        setScheduleLoaderMessage(window.HAM_GAME_SCHEDULE_ERROR, "error");
      }
      initializeGameSchedule();
      refreshPredictionDeadlineState();
      renderAll();
      void refreshGameDayNoticeStatus({ force: true });
    });
  } else {
    initializeGameSchedule();
    refreshPredictionDeadlineState();
    renderAll();
    void refreshGameDayNoticeStatus({ force: true });
  }
  initializeProbableStarter().finally(() => {
    initializeTodayPerfectAchievers();
    initializePredictionRemoteSync();
    initializeYearlyRanking();
    refreshPredictionDeadlineState();
    void initializeRosterCandidateSync();
    void refreshGameDayNoticeStatus({ force: true });
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
  // 認績・ランキングの取得失敗で管理者確認まで止めないよう、初期化単位を分離します。
  const results = await Promise.allSettled([
    fetchUserAchievements({ force: true }),
    refreshYearlyRanking({ force: true }),
    refreshAdminAccess(),
    refreshResultHistory({ force: true })
  ]);
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const labels = ["実績", "ランキング", "管理者権限", "過去結果"];
      console.error(`${labels[index]}の初期化に失敗しました`, result.reason?.message || "unknown error");
    }
  });
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
  bindAdminEvent("refreshAdminGameProgressButton", "click", () => refreshAdminGameProgressStatus({ force: true }));
  bindAdminEvent("adminGameProgressContent", "click", handleAdminRankingEligibilityAction);
  bindAdminEvent("refreshAdminReleaseReadinessButton", "click", () => refreshAdminReleaseReadiness({ force: true }));
  bindAdminEvent("toggleAdminWorkflowLogsButton", "click", toggleAdminWorkflowLogs);
  bindAdminEvent("refreshAdminWorkflowLogsButton", "click", () => refreshAdminWorkflowLogs({ force: true }));
  bindAdminEvent("adminWorkflowLogGameId", "change", () => refreshAdminWorkflowLogs({ force: true }));
  bindAdminEvent("adminWorkflowLogEventType", "change", () => refreshAdminWorkflowLogs({ force: true }));
  bindAdminEvent("adminWorkflowLogStatus", "change", () => refreshAdminWorkflowLogs({ force: true }));
  bindAdminEvent("refreshAdminGameIdentityRepairsButton", "click", () => refreshAdminGameIdentityRepairs({ force: true }));
  bindAdminEvent("adminGameIdentityRepairsList", "click", handleAdminGameIdentityRepairAction);
  bindAdminEvent("toggleGameWorkflowPauseButton", "click", toggleGameWorkflowPause);
  bindAdminEvent("editGameStartButton", "click", () => setGameStartManualOverride(true));
  bindAdminEvent("resetGameStartButton", "click", () => setGameStartManualOverride(false));
  bindAdminEvent("parseActualButton", "click", handleActualParsePreview);
  bindAdminEvent("applyParsedActualButton", "click", applyParsedActualPreview);
  bindAdminEvent("clearActualCandidateButton", "click", clearActualCandidate);
  bindAdminEvent("approveProvisionalButton", "click", approveProvisionalActual);
  bindAdminEvent("autoApproveCheckbox", "change", handleAutoApproveSettingChange);
  bindAdminEvent("editProvisionalButton", "click", editProvisionalActual);
  bindAdminEvent("cancelProvisionalButton", "click", cancelProvisionalActual);
  bindAdminEvent("testServerScoringButton", "click", runServerScoringPreview);
  bindAdminEvent("runServerScoringButton", "click", runServerScoring);
  bindAdminEvent("runAutoScoringNowButton", "click", runAutoScoringNow);
  bindAdminEvent("retryAutoScoringButton", "click", retryAutoScoring);
  bindAdminEvent("cancelAutoScoringButton", "click", cancelAutoScoring);
  bindAdminEvent("saveLineupRevisionButton", "click", saveManualLineupRevision);
  bindAdminEvent("previewManualRescoreButton", "click", previewManualRescore);
  bindAdminEvent("confirmManualRescoreButton", "click", confirmManualRescore);
  bindAdminEvent("restorePreviousLineupButton", "click", restorePreviousLineupRevision);
  bindAdminTestEvent("runPregameNoticeButton", "click", () => runPregameAutomationAction("run-notice"));
  bindAdminTestEvent("distributePregameNoticeButton", "click", () => runPregameAutomationAction("distribute-notice"));
  bindAdminTestEvent("runPregameRosterButton", "click", () => runPregameAutomationAction("run-roster"));
  bindAdminTestEvent("fixPregameRosterButton", "click", () => runPregameAutomationAction("fix-roster"));
  bindAdminTestEvent("runPregameLineupButton", "click", () => runPregameAutomationAction("run-lineup"));
  bindAdminTestEvent("runPregameScoringButton", "click", runPregameScoringAction);
  bindAdminTestEvent("publishPregameResultsButton", "click", () => runPregameAutomationAction("publish"));
  bindAdminTestEvent("generateTestPredictionButton", "click", generateTestPrediction);
  bindAdminTestEvent("createPerfectPredictionButton", "click", createAdminTestPerfectPrediction);
  bindAdminTestEvent("runAdminTestCronButton", "click", runAdminTestCron);
  bindAdminTestEvent("adminAutoScoringTestCreateForm", "submit", handleAutoScoringTestCreate);
  document.getElementById("autoScoringTestAnswerLineup")?.addEventListener("input", renderAutoScoringTestAnswerPreview);
  document.querySelectorAll("[data-auto-test-deadline-minutes]").forEach((button) => {
    button.addEventListener("click", () => setAutoScoringTestDeadline(Number(button.dataset.autoTestDeadlineMinutes)));
  });
  bindAdminTestEvent("adminAutoScoringTestList", "click", handleAutoScoringTestClick);
  bindAdminTestEvent("adminAutoScoringTestDetail", "click", handleAutoScoringTestClick);
  bindAdminTestEvent("adminAutoScoringTestDetail", "submit", handleAutoScoringTestSubmit);
  document.getElementById("adminPredictionDeadlineStatus")?.addEventListener("click", handlePredictionDeadlineOverrideClick);
  document.getElementById("adminTestPredictionDeadlineStatus")?.addEventListener("click", handlePredictionDeadlineOverrideClick);
  bindAdminTestEvent("resetButton", "click", resetAllData);
  document.getElementById("refreshAchievementsButton")?.addEventListener("click", () => fetchUserAchievements({ force: true }));
  bindAdminTestEvent("refreshAdminTestAchievementsButton", "click", refreshAdminTestAchievements);
  document.getElementById("adminTestAchievements")?.addEventListener("click", handleAdminTestAchievementAction);
  document.getElementById("adminTestGameCreateForm")?.addEventListener("submit", handleAdminTestGameCreate);
  document.getElementById("adminTestGameRoster")?.addEventListener("input", renderAdminTestRosterPreview);
  renderAdminTestRosterPreview();
  document.getElementById("adminTestGamesList")?.addEventListener("click", handleAdminTestGameAction);
  document.getElementById("adminTestGameDetail")?.addEventListener("click", handleAdminTestGameAction);
  document.getElementById("adminTestGameDetail")?.addEventListener("input", renderAdminTestDetailPreview);
  document.getElementById("sharePredictionButton").addEventListener("click", sharePrediction);
  document.getElementById("shareResultButton").addEventListener("click", shareResult);
  document.getElementById("predictionCtaButton")?.addEventListener("click", handlePredictionCtaClick);
  document.getElementById("editSavedPredictionButton")?.addEventListener("click", scrollToPredictionForm);
  document.getElementById("openAdminButton")?.addEventListener("click", openAdminPanel);
  document.getElementById("showYearlyRankingButton")?.addEventListener("click", () => selectRankingView("yearly"));
  document.getElementById("showMonthlyRankingButton")?.addEventListener("click", () => selectRankingView("monthly"));
  document.getElementById("rankingContent")?.addEventListener("click", handleRankingPeriodContentClick);
  document.getElementById("resultHistoryList")?.addEventListener("click", handleResultHistoryClick);
  document.getElementById("closeAdminButton")?.addEventListener("click", closeAdminPanel);
  document.getElementById("adminDetails")?.addEventListener("toggle", handleAdminDetailsToggle);
  bindAdminEvent("loadNextGameButton", "click", loadNextGameSchedule);
  bindAdminEvent("loadTodayGameButton", "click", loadTodayGameSchedule);
  document.addEventListener("pointermove", handlePointerInteractionMove, { passive: false });
  document.addEventListener("pointerup", handlePointerInteractionEnd);
  document.addEventListener("pointercancel", handlePointerInteractionCancel);
  document.addEventListener("touchstart", handleTouchInteractionStart, { passive: true });
  document.addEventListener("touchmove", handleTouchInteractionMove, { passive: false });
  document.addEventListener("touchend", handleTouchInteractionEnd, { passive: false });
  document.addEventListener("touchcancel", handleTouchInteractionCancel, { passive: false });
  bindAdminEvent("loadSelectedGameButton", "click", loadSelectedGameSchedule);
  bindAdminEvent("gameScheduleSelect", "change", handleScheduleSelectionChange);
  bindAdminEvent("copyScheduleLogButton", "click", copyScheduleLoadLog);
  bindAdminEvent("clearScheduleLogButton", "click", clearScheduleLoadLog);
  document.querySelectorAll("[data-roster-filter]").forEach((button) => {
    button.addEventListener("click", () => setCandidateRosterFilter(button.dataset.rosterFilter));
  });
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
    if (element.closest("#adminDetails") && !LEGACY_ADMIN_READ_ONLY_EVENT_IDS.has(element.id)) {
      event.preventDefault();
      return;
    }
    handler(event);
  });
}

function bindAdminTestEvent(elementId, eventName, handler) {
  const element = document.getElementById(elementId);
  if (!element) return;
  element.addEventListener(eventName, (event) => {
    if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") {
      event.preventDefault();
      return;
    }
    handler(event);
  });
}

function applyAdminMode() {
  const adminDetails = document.getElementById("adminDetails");
  const adminModeBadge = document.getElementById("adminModeBadge");
  const openAdminButton = document.getElementById("openAdminButton");
  const openAdminV3Button = document.getElementById("openAdminV3Button");
  const appLayout = document.querySelector(".app-layout");
  const isAuthorized = state.adminAccess.status === "authorized";
  const isAdminScreenOpen = state.appMode === "admin";

  applyLegacyAdminReadOnlyMode(adminDetails);

  if (adminDetails) {
    adminDetails.classList.toggle("hidden", !isAdminScreenOpen);
    adminDetails.hidden = !isAdminScreenOpen;
    adminDetails.open = isAdminScreenOpen;
    adminDetails.setAttribute("aria-hidden", isAdminScreenOpen ? "false" : "true");
  }

  if (adminModeBadge) {
    adminModeBadge.classList.toggle("hidden", !isAdminScreenOpen);
    adminModeBadge.textContent = "管理モード";
  }

  if (openAdminButton) {
    const shouldShowButton = isAuthorized && state.appMode === "normal";
    openAdminButton.classList.toggle("hidden", !shouldShowButton);
    openAdminButton.setAttribute("aria-hidden", shouldShowButton ? "false" : "true");
  }
  if (openAdminV3Button) {
    const shouldShowButton = isAuthorized && state.appMode === "normal";
    openAdminV3Button.classList.toggle("hidden", !shouldShowButton);
    openAdminV3Button.setAttribute("aria-hidden", shouldShowButton ? "false" : "true");
  }
  appLayout?.classList.toggle("is-admin-screen", isAdminScreenOpen);

  state.isAdminMode = isAdminScreenOpen;
  if (state.appMode === "normal") {
    stopAutoFetch("", "");
    stopRosterMonitor("", "", "inactive");
  }
}

function applyLegacyAdminReadOnlyMode(adminDetails) {
  if (!adminDetails) return;
  const readOnlyIds = new Set([
    "closeAdminButton",
    "refreshAdminReleaseReadinessButton",
    "refreshAdminGameProgressButton",
    "toggleAdminWorkflowLogsButton",
    "refreshAdminWorkflowLogsButton",
    "adminWorkflowLogGameId",
    "adminWorkflowLogEventType",
    "adminWorkflowLogStatus",
    "refreshAdminGameIdentityRepairsButton",
    "gameScheduleSelect",
    "loadNextGameButton",
    "loadTodayGameButton",
    "loadSelectedGameButton",
    "copyScheduleLogButton",
    "clearScheduleLogButton"
  ]);
  adminDetails.querySelectorAll("button, input, select, textarea").forEach((control) => {
    if (readOnlyIds.has(control.id)) return;
    control.disabled = true;
    control.setAttribute("aria-disabled", "true");
  });
  adminDetails.querySelectorAll("form").forEach((form) => {
    form.setAttribute("aria-disabled", "true");
  });
}

const LEGACY_ADMIN_READ_ONLY_EVENT_IDS = new Set([
  "closeAdminButton",
  "refreshAdminReleaseReadinessButton",
  "refreshAdminGameProgressButton",
  "toggleAdminWorkflowLogsButton",
  "refreshAdminWorkflowLogsButton",
  "adminWorkflowLogGameId",
  "adminWorkflowLogEventType",
  "adminWorkflowLogStatus",
  "refreshAdminGameIdentityRepairsButton",
  "gameScheduleSelect",
  "loadNextGameButton",
  "loadTodayGameButton",
  "loadSelectedGameButton",
  "copyScheduleLogButton",
  "clearScheduleLogButton"
]);

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
  state.adminTest = { status: "inactive", info: null, message: "" };
  state.adminAutoScoringTests = { games: [], selectedGameId: "", detail: null, message: "", isBusy: false };
  state.adminTestGames = { isLoading: false, isBusy: false, games: [], selectedGameId: "", detail: null, rescorePreview: null, message: "" };
  state.adminTestAchievements = { isLoading: false, items: [], earned: [], message: "" };
  state.gameWorkflow = { isLoading: false, isUpdating: false, requestId: state.gameWorkflow.requestId + 1, gameId: "", record: null, message: "" };
  stopGameProgressStatusRefresh();
  state.gameProgressStatus = { isLoading: false, requestId: state.gameProgressStatus.requestId + 1, record: null, message: "" };
  state.workflowLogs = { isLoading: false, requestId: state.workflowLogs.requestId + 1, logs: [], message: "" };
  state.gameIdentityRepairs = { isLoading: false, requestId: state.gameIdentityRepairs.requestId + 1, preview: null, message: "", actions: {}, activeRepairId: "", blockedRepairId: "", lastExecution: null };
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
    state.adminAccess.status = "unavailable";
    applyAdminMode();
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
      applyAdminMode();
      return;
    }

    if (response.status >= 500 || response.status === 0) {
      state.adminAccess.status = "unavailable";
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
    state.adminAccess.status = "unavailable";
    applyAdminMode();
    return;
  }
}

function buildAdminTestApiUrl(path) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/dev/${path.replace(/^\/+/, "")}` : "";
}

function buildAutoScoringTestApiUrl(path = "") {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/admin/auto-scoring-tests${path ? `/${path.replace(/^\/+/, "")}` : ""}` : "";
}

function localDateTimeInputValue(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const offset = value.getTimezoneOffset() * 60000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function setAutoScoringTestDeadline(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) return;
  const input = document.getElementById("autoScoringTestDeadlineAt");
  if (input) input.value = localDateTimeInputValue(new Date(Date.now() + minutes * 60 * 1000));
}

function renderAutoScoringTestAnswerPreview() {
  const input = document.getElementById("autoScoringTestAnswerLineup");
  const preview = document.getElementById("autoScoringTestAnswerPreview");
  if (!input || !preview) return;
  const lines = input.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  preview.textContent = lines.length ? `プレビュー（${lines.length}行）\n${lines.join("\n")}` : "入力内容のプレビューがここに表示されます。";
}

function renderAutoScoringTests() {
  const list = document.getElementById("adminAutoScoringTestList");
  const detail = document.getElementById("adminAutoScoringTestDetail");
  const message = document.getElementById("adminAutoScoringTestMessage");
  if (!list || !detail || !message) return;
  const model = state.adminAutoScoringTests;
  message.textContent = model.message || "";
  list.innerHTML = model.games.length
    ? model.games.map((game) => `<button type="button" class="admin-auto-scoring-test-row${game.gameId === model.selectedGameId ? " is-selected" : ""}" data-auto-test-game-id="${escapeHtml(game.gameId)}"><span><span class="test-badge">TEST</span> ${escapeHtml(game.title)}</span><strong>${escapeHtml(game.status)}</strong><small>締切 ${escapeHtml(game.predictionDeadlineAt || "-")}</small></button>`).join("")
    : "<p class=\"empty-state\">自動採点テストはまだありません。</p>";
  if (!model.detail) {
    detail.innerHTML = "<p class=\"empty-state\">テスト試合を選択すると、状態と結果を確認できます。</p>";
    return;
  }
  const game = model.detail;
  const results = Array.isArray(game.results) && game.results.length
    ? `<ul class="admin-auto-scoring-test-results">${game.results.map((row) => `<li><strong>${escapeHtml(row.username || "管理者")}</strong><span>${escapeHtml(row.score ?? "-")} / ${escapeHtml(row.maxScore ?? "-")}</span><small>${escapeHtml(row.status || "-")} ${escapeHtml(row.scoredAt || "")}</small></li>`).join("")}</ul>`
    : "<p>採点結果はまだありません。</p>";
  const answerText = Array.isArray(game.answerLineup) ? game.answerLineup.map((item) => `${item.battingOrder} ${item.position} ${item.playerName}`).join("\n") : "";
  const remainingSeconds = Number(game.deadlineRemainingSeconds || 0);
  const remainingLabel = remainingSeconds > 0
    ? `${Math.floor(remainingSeconds / 3600)}時間${Math.floor((remainingSeconds % 3600) / 60)}分${remainingSeconds % 60}秒`
    : "締切済み";
  detail.innerHTML = `<div class="admin-auto-scoring-test-detail-heading"><span class="test-badge">TEST</span><div><h4>自動採点テスト状況</h4><p>${escapeHtml(game.title)} / ${escapeHtml(game.gameId)}</p></div></div>
    <dl class="admin-auto-scoring-test-status"><div><dt>状態</dt><dd>${escapeHtml(game.currentStatus || game.status)}</dd></div><div><dt>現在時刻</dt><dd>${escapeHtml(game.now || "-")}</dd></div><div><dt>締切</dt><dd>${escapeHtml(game.predictionDeadlineAt || "-")}</dd></div><div><dt>締切まで</dt><dd>${escapeHtml(remainingLabel)}</dd></div><div><dt>正解スタメン</dt><dd>${game.answerLineupRegistered ? "登録済み" : "未登録"}</dd></div><div><dt>保存予想数</dt><dd>${escapeHtml(game.predictionCount ?? 0)}</dd></div><div><dt>最終自動処理</dt><dd>${escapeHtml(game.lastAutoRunAt || "-")}</dd></div><div><dt>直近エラー</dt><dd>${escapeHtml(game.lastErrorCode || game.lastErrorMessage || "なし")}</dd></div></dl>
    <div class="admin-auto-scoring-test-actions"><button type="button" class="primary-button" data-auto-test-action="run" data-auto-test-game-id="${escapeHtml(game.gameId)}">自動処理を今すぐ確認</button><button type="button" class="secondary-button" data-auto-test-action="retry" data-auto-test-game-id="${escapeHtml(game.gameId)}">自動採点を再試行</button><button type="button" class="secondary-button" data-auto-test-action="refresh" data-auto-test-game-id="${escapeHtml(game.gameId)}">状態を再取得</button></div>
    <form class="admin-auto-scoring-test-answer-form"><label>自動採点用正解スタメン<small>1 中 水谷瞬 の形式で9行</small><textarea id="autoTestAnswerLineupInput" rows="6" required>${escapeHtml(answerText)}</textarea></label><button type="submit" class="secondary-button">正解スタメンを保存</button></form>
    <button type="button" class="secondary-button" data-auto-test-action="save-test-prediction" data-auto-test-game-id="${escapeHtml(game.gameId)}">正解と同じテスト予想を保存</button>
    <div class="admin-auto-scoring-test-results-wrap"><h5>採点結果・公開状態</h5>${results}</div>`;
}

async function refreshAutoScoringTests(selectGameId = "") {
  if (state.adminAccess.status !== "authorized") return;
  const url = buildAutoScoringTestApiUrl();
  if (!url) return;
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.adminAutoScoringTests.games = payload.games || [];
    const nextId = selectGameId || state.adminAutoScoringTests.selectedGameId || state.adminAutoScoringTests.games[0]?.gameId || "";
    if (nextId) await loadAutoScoringTest(nextId);
    state.adminAutoScoringTests.message = "";
  } catch (error) {
    state.adminAutoScoringTests.message = error.message || "自動採点テストを取得できませんでした。";
  }
  renderAutoScoringTests();
}

async function loadAutoScoringTest(gameId) {
  const response = await fetch(buildAutoScoringTestApiUrl(encodeURIComponent(gameId)), { credentials: "include", cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
  state.adminAutoScoringTests.selectedGameId = gameId;
  state.adminAutoScoringTests.detail = payload.game;
}

async function handleAutoScoringTestCreate(event) {
  event.preventDefault();
  const value = (id) => document.getElementById(id)?.value || "";
  const startAt = new Date(value("autoScoringTestStartAt"));
  const deadlineAt = new Date(value("autoScoringTestDeadlineAt"));
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(deadlineAt.getTime())) {
    state.adminAutoScoringTests.message = "試合開始日時と締切日時を入力してください。";
    renderAutoScoringTests();
    return;
  }
  try {
    const response = await fetch(buildAutoScoringTestApiUrl(), { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: value("autoScoringTestTitle"), gameDate: value("autoScoringTestDate"), startAt: startAt.toISOString(), predictionDeadlineAt: deadlineAt.toISOString(), awayTeam: value("autoScoringTestOpponent"), venue: value("autoScoringTestVenue"), rosterText: value("autoScoringTestRoster"), answerLineupText: value("autoScoringTestAnswerLineup") }) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    event.currentTarget.reset();
    state.adminAutoScoringTests.message = "自動採点テストを作成しました。";
    await refreshAutoScoringTests(payload.game?.gameId || "");
    state.adminAutoScoringTests.message = "自動採点テストを作成しました。";
    renderAutoScoringTests();
  } catch (error) {
    state.adminAutoScoringTests.message = error.message || "自動採点テストを作成できませんでした。";
    renderAutoScoringTests();
  }
}

async function handleAutoScoringTestClick(event) {
  const target = event.target instanceof Element ? event.target.closest("[data-auto-test-game-id]") : null;
  if (!target) return;
  const gameId = target.dataset.autoTestGameId;
  if (target.dataset.autoTestAction === "save-test-prediction") {
    const answerLineup = state.adminAutoScoringTests.detail?.answerLineup;
    await autoScoringTestRequest(gameId, "prediction", { prediction: { schemaVersion: 1, lineup: answerLineup || [] } });
    return;
  }
  const action = target.dataset.autoTestAction || "detail";
  if (action === "detail") {
    try { await loadAutoScoringTest(gameId); } catch (error) { state.adminAutoScoringTests.message = error.message; }
    renderAutoScoringTests();
    return;
  }
  if (action === "refresh") {
    try {
      await loadAutoScoringTest(gameId);
      state.adminAutoScoringTests.message = "自動採点テストの状態を再取得しました。";
    } catch (error) {
      state.adminAutoScoringTests.message = error.message || "自動採点テストを取得できませんでした。";
    }
    renderAutoScoringTests();
    return;
  }
  await autoScoringTestRequest(gameId, action);
}

async function handleAutoScoringTestSubmit(event) {
  if (!(event.target instanceof HTMLFormElement) || !event.target.classList.contains("admin-auto-scoring-test-answer-form")) return;
  event.preventDefault();
  const gameId = state.adminAutoScoringTests.selectedGameId;
  await autoScoringTestRequest(gameId, "answer-lineup", { answerLineupText: document.getElementById("autoTestAnswerLineupInput")?.value || "" });
}

async function autoScoringTestRequest(gameId, action, body = null) {
  if (!gameId) return;
  try {
    const response = await fetch(buildAutoScoringTestApiUrl(`${encodeURIComponent(gameId)}/${action}`), { method: "POST", credentials: "include", cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.adminAutoScoringTests.message = action === "run" || action === "retry" ? `自動処理結果: ${payload.status || "完了"}` : "自動採点テストを更新しました。";
    await refreshAutoScoringTests(gameId);
    state.adminAutoScoringTests.message = action === "run" || action === "retry" ? `自動処理結果: ${payload.status || "完了"}` : "自動採点テストを更新しました。";
  } catch (error) {
    state.adminAutoScoringTests.message = error.message || "自動採点テストを操作できませんでした。";
  }
  renderAutoScoringTests();
}

function buildAdminTestGameApiUrl(gameId = "", action = "") {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  const path = gameId
    ? `/api/admin/test-games/${encodeURIComponent(gameId)}${action ? `/${action}` : ""}`
    : "/api/admin/test-games";
  return `${baseUrl}${path}`;
}

function testGameDateTimeInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTestGameStatus(game) {
  if (game.publicationStatus === "published") return "公開済み";
  if (game.scoringStatus === "scored") return "採点済み";
  if (game.lineupStatus === "registered") return "実スタメン登録済み";
  return new Date() >= new Date(game.predictionDeadlineAt) ? "締切済み" : "予想受付中";
}

function renderAdminTestRosterPreview() {
  const preview = document.getElementById("adminTestGameRosterPreview");
  const input = document.getElementById("adminTestGameRoster");
  if (!preview || !input) return;
  const lines = String(input.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    preview.textContent = "入力すると登録内容を確認できます。";
    return;
  }
  const seen = new Set();
  let duplicateCount = 0;
  let unknownCount = 0;
  for (const line of lines) {
    const name = normalizePlayerKey(line.split(/[，,]/, 1)[0]);
    if (!name) continue;
    if (seen.has(name)) duplicateCount += 1;
    seen.add(name);
    if (!playerNames.some((playerName) => normalizePlayerKey(playerName) === name)) unknownCount += 1;
  }
  const warnings = [duplicateCount ? `重複 ${duplicateCount}件` : "", unknownCount ? `選手マスタ未照合 ${unknownCount}件` : ""].filter(Boolean);
  preview.textContent = `登録予定 ${lines.length}人${warnings.length ? `（${warnings.join("、")}）` : "。守備位置は登録時に検証します。"}`;
}

function renderAdminTestDetailPreview(event) {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement)) return;
  const previewId = target.id === "adminTestDetailLineup" ? "adminTestDetailLineupPreview" : "";
  if (!previewId) return;
  const preview = document.getElementById(previewId);
  if (!preview) return;
  const lines = String(target.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  preview.textContent = lines.length ? `入力 ${lines.length}/9行。登録時に打順・選手・守備位置を検証します。` : "入力すると9人分の形式を確認できます。";
}

function renderAdminTestGamePanel() {
  const list = document.getElementById("adminTestGamesList");
  const detail = document.getElementById("adminTestGameDetail");
  const message = document.getElementById("adminTestGameMessage");
  if (!list || !detail || !message) return;
  const available = state.appMode === "admin" && state.adminAccess.status === "authorized";
  message.textContent = available ? state.adminTestGames.message || "" : "";
  if (!available) {
    list.innerHTML = "";
    detail.classList.add("hidden");
    detail.innerHTML = "";
    return;
  }
  if (state.adminTestGames.isLoading) {
    list.innerHTML = "<p class=\"admin-test-game-empty\">テスト試合を読み込み中...</p>";
  } else if (!state.adminTestGames.games.length) {
    list.innerHTML = "<p class=\"admin-test-game-empty\">作成済みテスト試合はありません。</p>";
  } else {
    list.innerHTML = `<div class="admin-test-game-list-heading"><strong>作成済みテスト試合</strong><button type="button" class="secondary-button compact-button" data-test-game-action="refresh">再取得</button></div>${state.adminTestGames.games.map((game) => `<button type="button" class="admin-test-game-row${game.gameId === state.adminTestGames.selectedGameId ? " is-selected" : ""}" data-test-game-id="${escapeHtml(game.gameId)}"><span class="test-badge">TEST</span><span class="admin-test-game-row-main"><strong>${escapeHtml(game.title)}</strong><small>${escapeHtml(game.gameDate)} / ${escapeHtml(game.awayTeam)} / ${escapeHtml(formatTestGameStatus(game))}</small></span><span class="admin-test-game-row-meta">予想 ${game.predictionCount || 0}件</span></button>`).join("")}`;
  }
  if (!state.adminTestGames.detail) {
    detail.classList.add("hidden");
    detail.innerHTML = "";
    return;
  }
  const game = state.adminTestGames.detail;
  const lineup = game.lineup;
  const revisionPreview = state.adminTestGames.rescorePreview;
  detail.classList.remove("hidden");
  detail.innerHTML = `<div class="admin-test-game-detail-heading"><div><span class="test-badge">TEST MODE</span><h4>${escapeHtml(game.title)}</h4><p>${escapeHtml(game.gameId)} / ${escapeHtml(game.gameDate)} / ${escapeHtml(game.awayTeam)}</p></div><button type="button" class="secondary-button compact-button" data-test-game-action="close-detail">閉じる</button></div>
    <dl class="admin-test-game-state"><div><dt>状態</dt><dd>${escapeHtml(formatTestGameStatus(game))}</dd></div><div><dt>開始</dt><dd>${escapeHtml(formatDateTime(game.startAt))}</dd></div><div><dt>締切</dt><dd>${escapeHtml(formatDateTime(game.predictionDeadlineAt))}</dd></div><div><dt>予想</dt><dd>${game.predictionCount || 0}件（採点済み ${game.scoredPredictionCount || 0}件）</dd></div><div><dt>実スタメン</dt><dd>${lineup ? "登録済み" : "未登録"}</dd></div><div><dt>採点</dt><dd>${escapeHtml(lineup?.status || "未実行")}</dd></div><div><dt>公開</dt><dd>${escapeHtml(lineup?.publicationStatus || "未実行")}</dd></div></dl>
    <label for="adminTestDetailDeadline">予想締切日時を変更</label><div class="admin-test-game-inline"><input id="adminTestDetailDeadline" type="datetime-local" value="${escapeHtml(testGameDateTimeInputValue(game.predictionDeadlineAt))}"><button type="button" class="secondary-button compact-button" data-test-game-action="save-deadline">締切を保存</button></div>
    <div class="admin-test-game-actions"><button type="button" class="secondary-button compact-button" data-test-game-action="close">今すぐ締切</button><button type="button" class="secondary-button compact-button" data-test-game-action="reopen">予想受付へ戻す</button><button type="button" class="secondary-button compact-button" data-test-game-action="score-preview">採点プレビュー</button><button type="button" class="danger-button compact-button" data-test-game-action="score">本採点</button><button type="button" class="secondary-button compact-button" data-test-game-action="publish">結果を公開</button><button type="button" class="danger-button compact-button" data-test-game-action="delete">テスト試合を削除</button></div>
    <label for="adminTestDetailRoster">ロースター編集</label><textarea id="adminTestDetailRoster" rows="5">${escapeHtml((game.roster || []).map((player) => `${player.playerName}${player.position ? `,${player.position}` : ""}`).join("\n"))}</textarea><button type="button" class="secondary-button compact-button" data-test-game-action="save-roster">ロースターを保存</button>
    <label for="adminTestDetailPrediction">テスト予想（1行：打順 守備 選手名）</label><textarea id="adminTestDetailPrediction" rows="5" placeholder="1 中 水谷瞬&#10;2 左 松本剛"></textarea><button type="button" class="secondary-button compact-button" data-test-game-action="save-prediction">テスト予想を保存</button>
    <label for="adminTestDetailLineup">実スタメン（1行：打順 守備 選手名）</label><textarea id="adminTestDetailLineup" rows="5" placeholder="1 中 水谷瞬&#10;2 左 松本剛"></textarea><p id="adminTestDetailLineupPreview" class="admin-test-game-preview">入力すると9人分の形式を確認できます。</p><button type="button" class="secondary-button compact-button" data-test-game-action="save-lineup">実スタメンを登録</button>
    <label for="adminTestDetailReason">訂正理由</label><input id="adminTestDetailReason" type="text" maxlength="240" value="テスト試合の訂正確認"><label for="adminTestDetailRevision">訂正版スタメン</label><textarea id="adminTestDetailRevision" rows="5" placeholder="訂正後の1〜9番を入力"></textarea><div class="admin-test-game-actions"><button type="button" class="secondary-button compact-button" data-test-game-action="rescore-preview">再採点プレビュー</button><button type="button" class="danger-button compact-button" data-test-game-action="rescore-confirm" ${revisionPreview ? "" : "disabled"}>再採点を確定</button></div>${revisionPreview ? `<div class="admin-test-game-preview"><strong>再採点プレビュー</strong><p>${revisionPreview.summary?.scoreChangedCount || 0}件の点数が変わる見込みです。version ${revisionPreview.lineupVersion}</p></div>` : ""}
    <section class="admin-test-game-results" aria-live="polite"><h5>テスト採点結果</h5>${(game.results || []).length ? `<ul>${game.results.map((result) => `<li><strong>${escapeHtml(result.username)}</strong><span>${result.score === null ? "未採点" : `${result.score}点`}</span><small>${escapeHtml(formatDateTime(result.scoredAt || result.updatedAt))}</small></li>`).join("")}</ul>` : "<p>採点済み結果はまだありません。</p>"}</section>`;
}

async function refreshAdminTestGames({ selectGameId = "" } = {}) {
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") return;
  const url = buildAdminTestGameApiUrl();
  if (!url) return;
  state.adminTestGames.isLoading = true;
  renderAdminTestGamePanel();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !Array.isArray(payload.games)) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.adminTestGames.games = payload.games;
    const selected = selectGameId || state.adminTestGames.selectedGameId;
    if (selected && payload.games.some((game) => game.gameId === selected)) await loadAdminTestGame(selected);
    else if (!selected) state.adminTestGames.detail = null;
    state.adminTestGames.message = "";
  } catch (error) {
    console.error("テスト試合一覧の取得に失敗しました", error.message);
    state.adminTestGames.message = "テスト試合一覧を取得できませんでした。";
  } finally {
    state.adminTestGames.isLoading = false;
    renderAdminTestGamePanel();
  }
}

async function loadAdminTestGame(gameId) {
  const url = buildAdminTestGameApiUrl(gameId);
  if (!url) return;
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok || !payload.game) throw new Error(payload?.error || `HTTP ${response.status}`);
  state.adminTestGames.selectedGameId = gameId;
  state.adminTestGames.detail = payload.game;
  renderAdminTestGamePanel();
}

async function adminTestGameRequest(action, { method = "POST", body = null, confirm = "" } = {}) {
  const gameId = state.adminTestGames.selectedGameId;
  if (!gameId) return;
  if (confirm && !window.confirm(confirm)) return;
  const url = buildAdminTestGameApiUrl(gameId, action);
  state.adminTestGames.isBusy = true;
  state.adminTestGames.message = "テスト試合を操作中...";
  renderAdminTestGamePanel();
  try {
    const response = await fetch(url, { method, credentials: "include", cache: "no-store", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    if (payload.previewId) state.adminTestGames.rescorePreview = payload;
    if (action === "rescore/confirm") state.adminTestGames.rescorePreview = null;
    const actionMessage = payload.warnings?.length ? payload.warnings.join(" ") : "テスト試合を更新しました。";
    state.adminTestGames.message = actionMessage;
    if (action === "delete" || method === "DELETE") {
      state.adminTestGames.selectedGameId = "";
      state.adminTestGames.detail = null;
      state.adminTestGames.rescorePreview = null;
    } else {
      await loadAdminTestGame(gameId);
    }
    await refreshAdminTestGames();
    state.adminTestGames.message = actionMessage;
  } catch (error) {
    console.error("テスト試合の操作に失敗しました", error.message);
    state.adminTestGames.message = error.message || "テスト試合の操作に失敗しました。";
  } finally {
    state.adminTestGames.isBusy = false;
    renderAdminTestGamePanel();
  }
}

async function handleAdminTestGameCreate(event) {
  event.preventDefault();
  if (state.adminAccess.status !== "authorized") return;
  const value = (id) => document.getElementById(id)?.value || "";
  const url = buildAdminTestGameApiUrl();
  const startAt = new Date(value("adminTestGameStartAt"));
  const predictionDeadlineAt = new Date(value("adminTestGameDeadlineAt"));
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(predictionDeadlineAt.getTime())) {
    state.adminTestGames.message = "試合開始日時と締切日時を入力してください。";
    renderAdminTestGamePanel();
    return;
  }
  const body = { title: value("adminTestGameTitle"), gameDate: value("adminTestGameDate"), startAt: startAt.toISOString(), predictionDeadlineAt: predictionDeadlineAt.toISOString(), awayTeam: value("adminTestGameOpponent"), venue: value("adminTestGameVenue"), rosterText: value("adminTestGameRoster"), memo: value("adminTestGameMemo") };
  try {
    const response = await fetch(url, { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    event.currentTarget.reset();
    const createMessage = payload.warnings?.length ? payload.warnings.join(" ") : "テスト試合を作成しました。";
    state.adminTestGames.message = createMessage;
    await refreshAdminTestGames({ selectGameId: payload.game?.gameId });
    state.adminTestGames.message = createMessage;
  } catch (error) {
    state.adminTestGames.message = error.message || "テスト試合を作成できませんでした。";
    renderAdminTestGamePanel();
  }
}

async function handleAdminTestGameAction(event) {
  const target = event.target instanceof Element ? event.target.closest("[data-test-game-action], [data-test-game-id]") : null;
  if (!target) return;
  const gameId = target.dataset.testGameId;
  if (gameId) {
    try { await loadAdminTestGame(gameId); } catch (error) { state.adminTestGames.message = error.message; renderAdminTestGamePanel(); }
    return;
  }
  const action = target.dataset.testGameAction;
  if (action === "refresh") return refreshAdminTestGames();
  if (action === "close-detail") { state.adminTestGames.selectedGameId = ""; state.adminTestGames.detail = null; renderAdminTestGamePanel(); return; }
  const value = (id) => document.getElementById(id)?.value || "";
  if (action === "save-deadline") {
    const deadline = new Date(value("adminTestDetailDeadline"));
    if (Number.isNaN(deadline.getTime())) {
      state.adminTestGames.message = "予想締切日時を入力してください。";
      renderAdminTestGamePanel();
      return;
    }
    return adminTestGameRequest("", { method: "PATCH", body: { predictionDeadlineAt: deadline.toISOString() } });
  }
  if (action === "save-roster") return adminTestGameRequest("roster", { body: { rosterText: value("adminTestDetailRoster") } });
  if (action === "save-prediction") return adminTestGameRequest("prediction", { body: { prediction: { schemaVersion: 1, lineup: parseAdminTestLineupText(value("adminTestDetailPrediction")) } } });
  if (action === "save-lineup") return adminTestGameRequest("lineup", { body: { lineupText: value("adminTestDetailLineup") } });
  if (action === "score-preview") return adminTestGameRequest("score/preview");
  if (action === "score") return adminTestGameRequest("score", { confirm: "テスト試合を本採点します。よろしいですか？" });
  if (action === "publish") return adminTestGameRequest("publish", { confirm: "テスト試合の結果を公開状態にします。よろしいですか？" });
  if (action === "close") return adminTestGameRequest("close", { confirm: "テスト試合を締切状態にします。よろしいですか？" });
  if (action === "reopen") return adminTestGameRequest("reopen", { confirm: "テスト試合を予想受付へ戻します。よろしいですか？" });
  if (action === "delete") return adminTestGameRequest("", { method: "DELETE", confirm: "テスト試合と関連データを削除します。よろしいですか？" });
  if (action === "rescore-preview") return adminTestGameRequest("rescore/preview", { body: { lineupText: value("adminTestDetailRevision"), reason: value("adminTestDetailReason") } });
  if (action === "rescore-confirm") return adminTestGameRequest("rescore/confirm", { body: { previewId: state.adminTestGames.rescorePreview?.previewId, lineupVersion: state.adminTestGames.rescorePreview?.lineupVersion, reason: value("adminTestDetailReason") }, confirm: "テスト試合だけを再採点します。よろしいですか？" });
}

function parseAdminTestLineupText(text) {
  return String(text || "").split(/\r?\n/).map((line) => {
    const parts = line.replace(/\u3000/g, " ").replace(/\s+/g, " ").trim().split(" ");
    const battingOrder = Number(parts.shift());
    const position = normalizePosition(parts.shift());
    const playerName = normalizePlayerName(parts.join(" "));
    const player = playerNames.find((name) => normalizePlayerKey(name) === normalizePlayerKey(playerName));
    const uniformNumber = player ? players.find((item) => item.name === player)?.uniformNumber : "";
    return { battingOrder, playerId: uniformNumber ? `F-${uniformNumber}` : "", teamId: "F", teamCode: "fighters", uniformNumber, playerName, position };
  }).filter((item) => item.battingOrder && item.playerName);
}

function formatAdminTestValue(value, fallback = "-") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function renderAdminTestPanel() {
  const info = document.getElementById("adminTestInfo");
  const message = document.getElementById("adminTestMessage");
  const createButton = document.getElementById("createPerfectPredictionButton");
  const cronButton = document.getElementById("runAdminTestCronButton");
  if (!info || !message || !createButton || !cronButton) return;

  const details = state.adminTest.info;
  const autoScoring = details?.autoScoring;
  const user = getPredictionAccountUser();
  const gameId = getAdminScoringGameId();
  const canOperate = state.appMode === "admin" && state.adminAccess.status === "authorized";
  createButton.disabled = !canOperate || !gameId;
  cronButton.disabled = !canOperate;
  message.textContent = state.adminTest.message || "";

  const rows = [
    ["API base URL", getAuthApiBaseUrl() || "未設定"],
    ["管理モード", canOperate ? "有効" : "確認中"],
    ["AUTO_SCORING_DELAY_SECONDS", formatAdminTestValue(details?.autoScoringDelaySeconds)],
    ["appMode", state.appMode],
    ["ログイン中 userId", formatAdminTestValue(user?.id)],
    ["role", state.adminAccess.status === "authorized" ? "admin" : "-"],
    ["選択中 gameId", gameId || "未選択"],
    ["実スタメン保存状態", autoScoring ? "保存済み" : "未保存"],
    ["scoring_status", formatAdminTestValue(autoScoring?.status)],
    ["scoring_due_at", formatAdminTestValue(autoScoring?.scoringDueAt)],
    ["scored_at", formatAdminTestValue(autoScoring?.scoredAt)],
    ["scoring_attempts", formatAdminTestValue(autoScoring?.attempts, "0")],
    ["last_error", formatAdminTestValue(autoScoring?.lastError)],
    ["lineup fingerprint", formatAdminTestValue(autoScoring?.lineupFingerprint)]
  ];
  info.innerHTML = `<dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
}

async function refreshAdminTestStatus() {
  if (state.adminAccess.status !== "authorized") return;
  const gameId = getAdminScoringGameId();
  const url = buildAdminTestApiUrl(`status${gameId ? `?gameId=${encodeURIComponent(gameId)}` : ""}`);
  if (!url) return;
  state.adminTest.message = "テスト情報を取得中...";
  renderAdminTestPanel();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.adminTest.info = payload;
    state.adminTest.message = "テスト情報を更新しました。";
  } catch (error) {
    console.error("管理者テスト情報の取得に失敗しました", error.message);
    state.adminTest.message = "テスト情報を取得できませんでした。";
  }
  renderAdminTestPanel();
}

async function createAdminTestPerfectPrediction() {
  const gameId = getAdminScoringGameId();
  if (!gameId) {
    state.adminTest.message = "対象試合を選択してください。";
    renderAdminTestPanel();
    return;
  }
  if (!window.confirm(`ログイン中の管理者ユーザーの ${gameId} の予想を、保存済み実スタメンと完全一致する内容で上書きします。よろしいですか？`)) return;
  const url = buildAdminTestApiUrl(`games/${encodeURIComponent(gameId)}/create-perfect-prediction`);
  if (!url) return;
  state.adminTest.message = "完全一致予想を作成中...";
  renderAdminTestPanel();
  try {
    const response = await fetch(url, { method: "POST", credentials: "include" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.adminTest.message = payload.created ? "完全一致予想を作成しました。" : "既存の予想を完全一致予想で更新しました。";
    await syncPredictionFromAccount({ force: true });
  } catch (error) {
    console.error("完全一致予想の作成に失敗しました", error.message);
    state.adminTest.message = "完全一致予想を作成できませんでした。";
  }
  await refreshAdminTestStatus();
}

async function runAdminTestCron() {
  if (!window.confirm("自動採点のCron処理を手動で実行します。よろしいですか？")) return;
  const url = buildAdminTestApiUrl("cron/run-auto-scoring");
  if (!url) return;
  state.adminTest.message = "Cron処理を実行中...";
  renderAdminTestPanel();
  try {
    const response = await fetch(url, { method: "POST", credentials: "include" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.adminTest.message = `Cron処理が完了しました。処理 ${payload.processed || 0}件 / 成功 ${payload.succeeded || 0}件 / 失敗 ${payload.failed || 0}件`;
  } catch (error) {
    console.error("開発用Cron実行に失敗しました", error.message);
    state.adminTest.message = "Cron処理を実行できませんでした。";
  }
  await refreshAdminTestStatus();
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

function renderAdminTestAchievements() {
  const container = document.getElementById("adminTestAchievements");
  if (!container) return;
  const developer = state.adminTestAchievements;
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

async function refreshAdminTestAchievements() {
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") return;
  const url = buildAdminTestApiUrl("achievements");
  if (!url) return;
  state.adminTestAchievements.isLoading = true;
  state.adminTestAchievements.message = "";
  renderAdminTestAchievements();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !Array.isArray(payload.achievements) || !Array.isArray(payload.earned)) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.adminTestAchievements.items = payload.achievements;
    state.adminTestAchievements.earned = payload.earned;
  } catch (error) {
    console.error("開発用実績情報の取得に失敗しました", error.message);
    state.adminTestAchievements.items = [];
    state.adminTestAchievements.earned = [];
    state.adminTestAchievements.message = "実績情報を取得できませんでした。";
  } finally {
    state.adminTestAchievements.isLoading = false;
    renderAdminTestAchievements();
  }
}

async function grantAdminTestAchievement(code) {
  if (!window.confirm("ログイン中の管理者自身へテスト実績を付与します。よろしいですか？")) return;
  const url = buildAdminTestApiUrl("achievements/grant-test");
  if (!url) return;
  state.adminTestAchievements.message = "テスト実績を付与中...";
  renderAdminTestAchievements();
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
  await Promise.all([fetchUserAchievements({ force: true }), refreshAdminTestAchievements()]);
  state.adminTestAchievements.message = resultMessage;
  renderAdminTestAchievements();
}

async function removeAdminTestAchievement(code) {
  if (!window.confirm("テスト付与した実績を削除します。よろしいですか？")) return;
  const url = buildAdminTestApiUrl(`achievements/${encodeURIComponent(code)}/test-grant`);
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
  await Promise.all([fetchUserAchievements({ force: true }), refreshAdminTestAchievements()]);
  state.adminTestAchievements.message = resultMessage;
  renderAdminTestAchievements();
}

function handleAdminTestAchievementAction(event) {
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") return;
  const target = event.target instanceof Element ? event.target.closest("[data-achievement-grant], [data-achievement-remove]") : null;
  if (!target) return;
  const grantCode = target.dataset.achievementGrant;
  const removeCode = target.dataset.achievementRemove;
  if (grantCode) void grantAdminTestAchievement(grantCode);
  if (removeCode) void removeAdminTestAchievement(removeCode);
}

function openAdminPanel() {
  if (state.adminAccess.status !== "authorized") {
    return;
  }

  state.appMode = "admin";
  try {
    applyAdminMode();
  } catch (error) {
    console.error("[PREGAME] admin mode apply failed", error?.message || "unknown error");
  }
  try {
    initializeGameSchedule();
  } catch (error) {
    console.error("[PREGAME] game schedule initialization failed", error?.message || "unknown error");
  }
  try {
    renderAll();
  } catch (error) {
    console.error("[PREGAME] admin render failed", error?.message || "unknown error");
  }
  refreshAdminScoringSummary({ force: true });
  void refreshManualRescorePanel({ force: true });
  refreshAutoScoringStatus({ force: true });
  void refreshAutoApprovalSettings();
  void refreshAdminGameWorkflowStatus({ force: true });
  void refreshAdminGameProgressStatus({ force: true });
  void refreshAdminReleaseReadiness({ force: true });
  void refreshAdminGameIdentityRepairs({ force: true });
  startGameProgressStatusRefresh();
  if (state.workflowLogs.expanded) {
    void refreshAdminWorkflowLogs({ force: true });
  }
  renderAdminTestPanel();
  void refreshAdminTestStatus();
  void refreshAutoScoringTests();
  void refreshAdminTestGames();
  void refreshAdminTestAchievements();
}

function closeAdminPanel() {
  if (state.appMode !== "admin") {
    return;
  }

  state.appMode = "normal";
  state.workflowLogs.requestId += 1;
  state.workflowLogs.isLoading = false;
  state.workflowLogs.logs = [];
  state.workflowLogs.message = "";
  state.gameIdentityRepairs.requestId += 1;
  state.gameIdentityRepairs.isLoading = false;
  state.releaseReadiness.requestId += 1;
  state.releaseReadiness.isLoading = false;
  stopGameProgressStatusRefresh();
  state.gameProgressStatus.requestId += 1;
  state.gameProgressStatus.isLoading = false;
  state.gameProgressStatus.record = null;
  state.gameProgressStatus.message = "";
  applyAdminMode();
  renderAdminWorkflowLogs();
  renderAdminGameProgressStatus();
  renderPredictionDeadlineAdmin();
}

function restoreAdminWorkflowLogsExpanded() {
  try {
    state.workflowLogs.expanded = window.localStorage.getItem(ADMIN_WORKFLOW_LOGS_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    state.workflowLogs.expanded = false;
  }
}

function persistAdminWorkflowLogsExpanded() {
  try {
    window.localStorage.setItem(ADMIN_WORKFLOW_LOGS_EXPANDED_STORAGE_KEY, String(state.workflowLogs.expanded));
  } catch {
    // localStorageが使えない環境でもログ表示自体は継続します。
  }
}

function toggleAdminWorkflowLogs() {
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") return;
  state.workflowLogs.expanded = !state.workflowLogs.expanded;
  persistAdminWorkflowLogsExpanded();
  if (!state.workflowLogs.expanded) {
    state.workflowLogs.requestId += 1;
    state.workflowLogs.isLoading = false;
  }
  renderAdminWorkflowLogs();
  if (state.workflowLogs.expanded) {
    void refreshAdminWorkflowLogs({ force: true });
  }
}

function handleAdminDetailsToggle(event) {
  if (!event.currentTarget.open && state.appMode === "admin") {
    closeAdminPanel();
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

function hasUsablePublicRosterForCurrentGame() {
  const internalGameId = getGameDayRosterTargetInternalGameId();
  const gameDate = String(state.predictionTargetGame?.date || "").slice(0, 10);
  const roster = state.publicRoster;
  const baselineUsableUntil = roster?.status === "baseline"
    ? Date.parse(String(roster.usableUntil || ""))
    : Number.POSITIVE_INFINITY;
  return Boolean(
    roster
    && ["fresh", "baseline"].includes(roster.status)
    && roster.internalGameId === internalGameId
    && (!gameDate || roster.gameDate === gameDate)
    && baselineUsableUntil > Date.now()
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
  button.textContent = "?";
  button.setAttribute("aria-label", `${index + 1}番の守備位置を選択`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", menuId);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (pickerName === "prediction" && !ensurePredictionEditingAllowed()) return;
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

  button.addEventListener("click", () => {
    if (Date.now() < state.pointerSuppressClickUntil) return;
    if (button.dataset.skipClick === "true") {
      button.dataset.skipClick = "false";
      return;
    }

    showPlayerDetails(pickerName, player);
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

function beginPointerInteraction(event, element, kind) {
  if (element.dataset.picker !== "prediction" || event.pointerType === "mouse" || isPredictionEditingLocked()) return;
  if (kind === "lineup" && event.target instanceof Element && event.target.closest("button, .position-menu")) return;

  clearPointerInteraction();
  const interaction = {
    pointerId: event.pointerId,
    element,
    kind,
    pickerName: element.dataset.picker,
    sourceIndex: kind === "lineup" ? Number(element.dataset.order) : null,
    player: element.dataset.player,
    startX: event.clientX,
    startY: event.clientY,
    targetIndex: null,
    active: false,
    inputSource: event.inputSource || "pointer",
    pointerType: event.pointerType || "",
    activeTouchIdentifier: event.inputSource === "touch" ? event.pointerId : null,
    timerId: setTimeout(() => activatePointerInteraction(interaction), POINTER_LONG_PRESS_MS)
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
  interaction.active = true;
  interaction.element.classList.remove("is-pressing");
  interaction.element.classList.add("is-dragging");
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
      clearPointerInteraction();
    }
    return;
  }

  event.preventDefault();
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
    showNpbFetchFailure({ ok: false, code: "API_URL_MISSING", message: "NPB公式ページ取得APIが未設定です。" });
    return;
  }

  try {
    const candidate = await fetchNpbLineupCandidate(validation.url);
    if (!candidate.ok) {
      showNpbFetchFailure(candidate);
      return;
    }

    const parseResult = parseActualLineupText(candidate.lineupText);
    if (!parseResult.ok) {
      showNpbFetchFailure({ ok: false, code: "INVALID_LINEUP", message: parseResult.message });
      return;
    }

    document.getElementById("actualPasteInput").value = candidate.lineupText;
    state.actualPreview = parseResult.lineup;
    state.adminStatus = "preview";
    state.adminError = "";
    renderAdminFlow();
    setNpbFetchMessage("候補スタメンを取得しました。内容を確認して承認してください。", "success");
  } catch (error) {
    console.warn("NPB公式ページ取得APIから候補を取得できませんでした。", error);
    showNpbFetchFailure({ ok: false, code: "WORKER_FETCH_FAILED", message: "取得サービスへ接続できませんでした。" });
  }
}

async function fetchNpbLineupCandidate(sourceUrl) {
  if (!NPB_WORKER_API_URL) {
    return { ok: false, type: "config", message: "NPB公式ページ取得APIが未設定です。" };
  }

  try {
    const response = await fetch(buildNpbWorkerRequestUrl(sourceUrl), { cache: "no-store" });
    const result = await readNpbWorkerResponse(response);
    if (!response.ok) {
      return {
        ok: false,
        code: result?.code || "WORKER_FETCH_FAILED",
        message: result?.error || `Worker APIの取得に失敗しました。HTTP ${response.status}`,
        httpStatus: response.status
      };
    }

    if (!result?.ok || !result.lineupText) {
      return {
        ok: false,
        code: result?.code || "PARSE_FAILED",
        message: result?.error || "最新のオーダーを抽出できませんでした。"
      };
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
    const errorText = String(error?.message || "");
    return {
      ok: false,
      code: /cors/i.test(errorText) ? "CORS_ERROR" : "WORKER_FETCH_FAILED",
      message: errorText || "取得サービスへ接続できませんでした。"
    };
  }
}

async function readNpbWorkerResponse(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
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
  return Number.isFinite(fetchedAtMs) && now - fetchedAtMs >= 0 && now - fetchedAtMs < ROSTER_SNAPSHOT_CACHE_TTL_MS;
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
  if (!state.isAdminMode) {
    if (!hasUsablePublicRosterForCurrentGame()) return false;
    return state.publicRoster.players.some((entry) => rosterEntryMatchesPlayer(entry, player));
  }

  const snapshot = getRosterSnapshotForCurrentGame();
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
  const internalGameId = getGameDayRosterTargetInternalGameId();
  const gameDate = String(state.predictionTargetGame?.date || "").slice(0, 10);
  if (state.publicRoster.isLoading && state.publicRoster.internalGameId === internalGameId) {
    return;
  }
  const requestId = ++publicRosterSyncRequestId;
  state.publicRoster = {
    internalGameId,
    gameDate,
    status: "pending",
    players: [],
    isLoading: true,
    usableUntil: ""
  };
  renderPicker("prediction");
  renderPredictionDeadline();
  const gameSnapshot = await fetchGameDayRosterSnapshot(internalGameId);
  if (requestId !== publicRosterSyncRequestId || internalGameId !== getGameDayRosterTargetInternalGameId()) return;
  state.publicRoster.isLoading = false;
  if (gameSnapshot.ok && gameSnapshot.internalGameId === internalGameId && gameSnapshot.players.length) {
    state.publicRoster = {
      internalGameId,
      gameDate: gameSnapshot.gameDate || gameDate,
      status: gameSnapshot.status === "baseline" ? "baseline" : "fresh",
      players: normalizeRosterEntries(gameSnapshot.players),
      isLoading: false,
      usableUntil: gameSnapshot.usableUntil || ""
    };
    saveToStorage(STORAGE_KEYS.rosterSnapshot, {
      internalGameId,
      gameDate: gameSnapshot.gameDate || state.predictionTargetGame?.date || "",
      fetchedAt: gameSnapshot.capturedAt || new Date().toISOString(),
      sourceUrl: "auth-worker://game-day-roster",
      method: "game-day-roster-snapshot",
      warning: "",
      httpStatus: 200,
      cacheStatus: gameSnapshot.status === "baseline" ? "game-snapshot-baseline" : "game-snapshot",
      stale: false,
      parsedCount: gameSnapshot.players.length,
      announcedCount: gameSnapshot.players.length,
      players: gameSnapshot.players
    });
    renderPicker("prediction");
    renderPredictionDeadline();
    return;
  }
  renderPicker("prediction");
  renderPredictionDeadline();
}

function buildNpbWorkerRequestUrl(sourceUrl) {
  const identity = getNpbScoreRequestIdentity(sourceUrl);
  if (!identity) {
    throw new Error("対象試合のNPB公式URLを特定できませんでした。");
  }

  const workerUrl = new URL(NPB_WORKER_API_URL);
  workerUrl.searchParams.set("mode", "lineup");
  workerUrl.searchParams.set("date", identity.date);
  workerUrl.searchParams.set("gameCode", identity.gameCode);
  return workerUrl.href;
}

function buildNpbWorkerDebugUrl(sourceUrl) {
  const identity = getNpbScoreRequestIdentity(sourceUrl);
  if (!identity) {
    return "";
  }

  const workerUrl = new URL(NPB_WORKER_API_URL);
  workerUrl.searchParams.set("mode", "lineup");
  workerUrl.searchParams.set("date", identity.date);
  workerUrl.searchParams.set("gameCode", identity.gameCode);
  workerUrl.searchParams.set("debug", "1");
  return workerUrl.href;
}

function getNpbWorkerApiUrl() {
  if (typeof window === "undefined") {
    return NPB_WORKER_PRODUCTION_URL;
  }

  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1"
    ? NPB_WORKER_LOCAL_URL
    : NPB_WORKER_PRODUCTION_URL;
}

function getNpbScoreRequestIdentity(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "npb.jp") {
      return null;
    }

    const match = url.pathname.match(NPB_SCORE_PATH_PATTERN);
    if (!match) {
      return null;
    }

    return {
      date: `${match[1]}-${match[2]}-${match[3]}`,
      gameCode: match[4].toLowerCase()
    };
  } catch (error) {
    return null;
  }
}

async function initializeProbableStarter() {
  const schedule = await getLoadedGameSchedule();
  const previousGame = state.predictionTargetGame || state.probableStarter.nextGame;
  const previousGameId = previousGame?.gameId || state.predictionTargetGameId || "";
  const catalogGame = state.publicGameCatalog.games.length
    ? selectInitialPublicGame(state.publicGameCatalog.games)
    : null;
  const nextGame = catalogGame || await resolvePredictionTargetGame(schedule, true);
  const preservedGame = catalogGame || nextGame || (state.isAdminMode
    ? schedule.find((game) => game?.gameId === previousGameId) || state.probableStarter.nextGame
    : null);
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
  const schedule = await getLoadedGameSchedule();
  const catalogGame = state.publicGameCatalog.games.length
    ? selectInitialPublicGame(state.publicGameCatalog.games)
    : null;
  const nextGame = catalogGame || await resolvePredictionTargetGame(schedule, useServer);
  const previousGame = state.predictionTargetGame || state.probableStarter.nextGame;
  const previousGameId = state.predictionTargetGameId || previousGame?.gameId || "";
  if (!nextGame) {
    state.predictionTargetGameId = "";
    state.predictionTargetGame = null;
    state.probableStarter.nextGame = null;
    state.prediction = null;
    state.predictionRemote = createEmptyPredictionRemoteState();
    renderAll();
    void initializeRosterCandidateSync();
    return;
  }
  if ((nextGame?.gameId || "") !== previousGameId || (nextGame?.internalGameId || "") !== (previousGame?.internalGameId || "")) {
    state.predictionTargetGameId = nextGame?.gameId || "";
    state.predictionTargetGame = nextGame;
    state.probableStarter.nextGame = nextGame;
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
    void syncPredictionFromAccount({ force: true });
    void refreshGameDayNoticeStatus({ force: true });
    void initializeRosterCandidateSync();
    if (nextGame) await fetchStoredProbableStarter();
    return;
  }
  // 未発表の再取得はAuth Worker Cronがnext_check_atを基準に行います。
  // ブラウザ側は試合進行を起動せず、保存済み状態の表示だけを担当します。
}

async function resolvePredictionTargetGame(schedule, useServer) {
  if (!state.isAdminMode) return null;
  const fallback = findNextScheduledGameForStarter(schedule);
  if (!useServer) return fallback;
  const url = buildPredictionTargetApiUrl();
  if (!url) return fallback;
  try {
    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) return fallback;
    return payload.target ? normalizeServerPredictionTarget(payload.target) : fallback;
  } catch (error) {
    console.warn("サーバー側の予想対象取得に失敗しました", error.message);
    return fallback;
  }
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
  const todayOpen = todayGames.find((game) => !isPublicGamePublished(game)
    && resolvePredictionDeadline(game.internalGameId || game.gameId, now).status === "open");
  const nextOpen = selectable.find((game) => getScheduleDate(game) > today
    && !isPublicGamePublished(game)
    && resolvePredictionDeadline(game.internalGameId || game.gameId, now).status === "open");
  return todayOpen || nextOpen || null;
}

function formatPublicPredictionGameLabel(game) {
  const date = getScheduleDate(game);
  const time = getScheduleStartTime(game);
  const matchup = game?.displayLabel || game?.matchupLabel || `${game?.homeTeamName || game?.homeTeam || ""} vs ${game?.awayTeamName || game?.awayTeam || ""}`;
  return `${date.replace(/^(\d{4})-/, "$1/").replace(/-/, "/")} ${time} ${matchup}`.trim();
}

async function initializePublicGameCatalog() {
  const catalog = state.publicGameCatalog;
  if (catalog.isLoading) return;
  catalog.isLoading = true;
  try {
    let apiGames = [];
    const url = buildPublicGamesApiUrl();
    if (url) {
      const response = await fetch(url, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.ok && Array.isArray(payload.games)) {
        apiGames = payload.games;
      }
    }
    catalog.games = mergePublicGameSchedules([], apiGames);
    catalog.message = "";
    const initialGame = selectInitialPublicGame(catalog.games);
    const currentGameId = getCurrentGameId();
    const initialGameId = initialGame?.internalGameId || initialGame?.gameId || "";
    if (initialGame && currentGameId !== initialGameId) {
      state.predictionTargetGameId = initialGameId;
      state.predictionTargetGame = initialGame;
      state.probableStarter.nextGame = initialGame;
      if (state.predictionRemote.gameId !== initialGameId || (state.prediction && state.prediction.gameId !== initialGameId)) {
        state.prediction = null;
        state.actual = null;
        state.result = null;
        state.predictionRemote = createEmptyPredictionRemoteState();
        removeFromStorage(STORAGE_KEYS.prediction);
        removeFromStorage(STORAGE_KEYS.actual);
        removeFromStorage(STORAGE_KEYS.result);
      }
      refreshPredictionDeadlineState();
      void syncPredictionFromAccount({ force: true });
    } else if (!initialGame) {
      state.predictionTargetGameId = "";
      state.predictionTargetGame = null;
      state.probableStarter.nextGame = null;
      state.prediction = null;
      state.predictionRemote = createEmptyPredictionRemoteState();
      refreshPredictionDeadlineState();
    }
    // The public catalog can resolve after probable-starter initialization.
    // Re-run the roster fetch so an earlier empty-target attempt cannot leave
    // the prediction picker stuck in its loading state.
    void initializeRosterCandidateSync();
  } catch (error) {
    catalog.games = [];
    catalog.message = "試合情報を取得できませんでした。";
    console.warn("公開試合一覧の取得に失敗しました", error.message);
  } finally {
    catalog.isLoading = false;
    renderPublicGameSelectionMeta();
  }
}

function isPublicGamePublished(game, remoteState = state.predictionRemote) {
  const gameIds = [game?.internalGameId, game?.gameId].filter(Boolean);
  const remoteMatchesGame = Boolean(remoteState?.gameId && gameIds.includes(remoteState.gameId));
  return Boolean(game?.isPublished || game?.publicationStatus === "published" || (remoteMatchesGame && remoteState?.resultsPublished));
}

function findNextScheduledGameForStarter(schedule) {
  const now = new Date();
  return schedule
    .filter((game) => Boolean(game?.internalGameId) && !isScheduleGameUnavailable(game) && parseJstScheduleDateTime(game) > now)
    .slice()
    .sort((left, right) => parseJstScheduleDateTime(left) - parseJstScheduleDateTime(right))[0] || null;
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
  if (state.probableStarter.isLoading) {
    return;
  }

  if (!state.probableStarter.nextGame) {
    state.probableStarter.status = "noGame";
    state.probableStarter.message = "次の試合を検出できませんでした。";
    renderProbableStarter();
    return;
  }

  const game = state.probableStarter.nextGame;
  const url = buildProbableStarterApiUrl(game);
  if (!url) {
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
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const result = await response.json().catch(() => null);
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
    state.probableStarter.status = "error";
    state.probableStarter.message = "予告先発を取得できませんでした";
  } finally {
    state.probableStarter.isLoading = false;
    renderProbableStarter();
  }
}

async function fetchProbableStarter({ force = false } = {}) {
  if (!force || !state.isAdminMode || state.adminAccess.status !== "authorized") {
    return fetchStoredProbableStarter();
  }
  const gameId = state.probableStarter.nextGame?.gameId || "";
  const url = buildAdminGameApiUrl(gameId, "probable-starter/refresh");
  if (!url) return fetchStoredProbableStarter();
  state.probableStarter.isLoading = true;
  state.probableStarter.status = "loading";
  state.probableStarter.message = "予告先発を再取得中...";
  addProbableStarterLog("保存済みデータをサーバーで再取得");
  renderProbableStarter();
  try {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      cache: "no-store"
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      throw new Error(result?.error || "予告先発を再取得できませんでした。");
    }
    applyStoredProbableStarter(result.probableStarter, result);
    addProbableStarterLog("サーバー再取得が完了");
  } catch (error) {
    state.probableStarter.status = "error";
    state.probableStarter.message = "予告先発を取得できませんでした";
    addProbableStarterLog(`再取得失敗：${error.message}`);
  } finally {
    state.probableStarter.isLoading = false;
    renderProbableStarter();
  }
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

  return null;
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

function handleAuthStateChanged() {
  renderPredictionCta();
  renderTodayPerfectAchievers();
  fetchTodayPerfectAchievers({ force: true });
  syncPredictionFromAccount({ force: true });
  fetchUserAchievements({ force: true });
  refreshYearlyRanking({ force: true });
  if (state.rankingView === "monthly") {
    refreshMonthlyRanking({ force: true });
  }
  refreshAdminAccess();
  refreshResultHistory({ force: true });
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
  // Retired compatibility form (not used for V3): : getCurrentLegacyGameId()
  return state.isAdminMode
    ? state.nextScheduleId || state.probableStarter.nextGame?.gameId || state.prediction?.gameId || getCurrentGameId()
    : getCurrentGameId();
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
  const game = getHamGameSchedule().find((item) => item?.gameId === gameId || item?.internalGameId === gameId)
    || state.publicGameCatalog.games.find((item) => item?.gameId === gameId || item?.internalGameId === gameId)
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

function canUsePredictionDeadlineOverride() {
  return state.appMode === "admin" && state.adminAccess.status === "authorized";
}

function getEffectivePredictionDeadline(deadline = state.predictionDeadline) {
  if (!canUsePredictionDeadlineOverride() || deadline.override === "auto") {
    return deadline;
  }
  if (deadline.override === "before") {
    return { ...deadline, status: "open", isClosed: false, message: "管理者テストで締切前を再現中です。" };
  }
  return { ...deadline, status: "closed", isClosed: true, message: "管理者テストで締切後を再現中です。" };
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
  renderAdminTestPanel();
  renderPredictionDeadlineAdmin();
}

function setPredictionDeadlineOverride(value) {
  if (!canUsePredictionDeadlineOverride()) return;
  state.predictionDeadline.override = ["before", "after"].includes(value) ? value : "auto";
  refreshPredictionDeadlineState();
}

function handlePredictionDeadlineOverrideClick(event) {
  const button = event.target instanceof Element
    ? event.target.closest("[data-prediction-deadline-override]")
    : null;
  if (!button || !canUsePredictionDeadlineOverride()) return;
  setPredictionDeadlineOverride(button.dataset.predictionDeadlineOverride);
}

function clearPredictionDeadlineOverride() {
  if (state.predictionDeadline.override === "auto") return;
  state.predictionDeadline.override = "auto";
  refreshPredictionDeadlineState();
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
          <span>試合開始まで <strong>${escapeHtml(formatRemainingTime(deadline.startAt))}</strong></span>
          <span>締切まで <strong>${escapeHtml(formatRemainingTime(deadline.deadlineAt))}</strong></span>
        </div>
      `;
    } else {
      container.textContent = deadline.message || "予想の受付状況を確認しています。";
    }
  }
  if (saveButton) saveButton.disabled = Boolean(deadline.isClosed) || (!state.isAdminMode && !hasUsablePublicRosterForCurrentGame()) || state.predictionRemote.isSaving || state.predictionRemote.isSubmitting;
  if (resetButton) resetButton.disabled = Boolean(deadline.isClosed) || state.predictionRemote.isDeleting;
  renderPublicGameSelectionMeta();
}

function renderPredictionDeadlineAdmin() {
  const deadline = getEffectivePredictionDeadline();
  renderPredictionDeadlinePanel(
    document.getElementById("adminPredictionDeadlineStatus"),
    deadline,
    state.appMode === "admin"
  );
  renderPredictionDeadlinePanel(
    document.getElementById("adminTestPredictionDeadlineStatus"),
    deadline,
    state.appMode === "admin" && state.adminAccess.status === "authorized"
  );
}

function renderPredictionDeadlinePanel(container, deadline, shouldShow) {
  if (!container) return;
  if (!shouldShow) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }

  const rows = [
    ["対象試合", deadline.gameId || "未選択"],
    ["試合開始", formatPredictionDeadlineDateTime(deadline.startAt)],
    ["予想締切", formatPredictionDeadlineDateTime(deadline.deadlineAt)],
    ["受付状態", deadline.isClosed ? "締切後" : "締切前"],
    ["開発上書き", state.predictionDeadline.override === "auto" ? "自動" : state.predictionDeadline.override === "before" ? "締切前" : "締切後"]
  ];
  const overrideControls = canUsePredictionDeadlineOverride() ? `
    <div class="deadline-override-panel">
      <p>開発上書き</p>
      <div class="deadline-override-controls" role="group" aria-label="予想締切テストの時刻設定">
        ${[
          ["auto", "自動"],
          ["before", "締切前"],
          ["after", "締切後"]
        ].map(([value, label]) => `<button class="secondary-button compact-button${state.predictionDeadline.override === value ? " is-selected" : ""}" type="button" data-prediction-deadline-override="${value}" aria-pressed="${state.predictionDeadline.override === value ? "true" : "false"}">${label}</button>`).join("")}
      </div>
    </div>` : "";
  container.classList.remove("hidden");
  container.innerHTML = `<strong>予想締切</strong><dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>${overrideControls}`;
}

function getCurrentGameId() {
  // Retired compatibility expression (read-only history only): state.predictionTargetGame?.internalGameId || state.probableStarter.nextGame?.internalGameId || getCurrentLegacyGameId()
  return state.isAdminMode
    ? state.result?.gameId || state.nextScheduleId || state.probableStarter.nextGame?.gameId || ""
    : state.predictionTargetGame?.internalGameId || state.probableStarter.nextGame?.internalGameId || "";
}

function getCurrentLegacyGameId() {
  return state.predictionTargetGame?.gameId || state.predictionTargetGameId || state.probableStarter.nextGame?.gameId || "";
}

function getAdminScoringGameId() {
  // サーバーselectorが返した現在対象を最優先し、古い画面状態へ戻らないようにします。
  return state.gameWorkflow.record?.currentGame?.legacyGameId
    || state.gameWorkflow.record?.currentGame?.gameId
    || state.gameWorkflow.record?.gameId
    || state.nextScheduleId
    || state.probableStarter.nextGame?.gameId
    || findNextGameSchedule()?.gameId
    || "";
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

function buildAdminWorkflowLogsApiUrl() {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/admin/workflow-logs` : "";
}

function buildAdminGameIdentityRepairPreviewApiUrl() {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/admin/audit/game-identity-repairs` : "";
}

function buildAdminGameIdentityRepairsApiUrl(repairId = "") {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  return repairId
    ? `${baseUrl}/api/admin/game-identities/repairs/${encodeURIComponent(repairId)}/rollback`
    : `${baseUrl}/api/admin/game-identities/repairs`;
}

function buildAdminGameIdentityRepairAuditApiUrl(repairId) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl && repairId ? `${baseUrl}/api/admin/audit/game-identity-repairs/${encodeURIComponent(repairId)}` : "";
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

function formatRemainingTime(targetIso, now = new Date()) {
  const target = new Date(targetIso);
  const milliseconds = target.getTime() - now.getTime();
  if (!Number.isFinite(milliseconds)) return "-";
  if (milliseconds <= 0) return "まもなく";
  const totalMinutes = Math.ceil(milliseconds / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return days > 0 ? `${days}日${hours}時間` : hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`;
}

function getManualRescoreMetadata() {
  const gameId = getAdminScoringGameId();
  const match = /^(\d{4}-\d{2}-\d{2})-([a-z]{1,2})-([a-z]{1,2})-\d+$/i.exec(gameId);
  if (!match) return null;
  return { gameId, gameDate: match[1], homeTeam: match[2].toLowerCase(), awayTeam: match[3].toLowerCase() };
}

function getManualRescoreReason() {
  return String(document.getElementById("manualRescoreReason")?.value || "").trim();
}

function renderManualRescorePanel() {
  const summary = document.getElementById("adminManualRescoreSummary");
  const message = document.getElementById("adminManualRescoreMessage");
  const preview = document.getElementById("adminManualRescorePreview");
  const history = document.getElementById("adminManualRescoreHistory");
  const saveButton = document.getElementById("saveLineupRevisionButton");
  const previewButton = document.getElementById("previewManualRescoreButton");
  const confirmButton = document.getElementById("confirmManualRescoreButton");
  const restoreButton = document.getElementById("restorePreviousLineupButton");
  if (!summary || !message || !preview || !history || !saveButton || !previewButton || !confirmButton || !restoreButton) return;

  const metadata = getManualRescoreMetadata();
  const record = state.manualRescore.history;
  const current = record?.revisions?.find((revision) => revision.isCurrent);
  const previous = record?.revisions?.find((revision) => !revision.isCurrent);
  const actual = createAdminActualLineupPayload();
  const busy = state.manualRescore.isLoading || state.manualRescore.isSaving;
  const expiresAt = record?.rescoreExpiresAt ? formatDateTime(record.rescoreExpiresAt) : "-";
  const rows = [
    ["対象試合", state.gameInfo.matchup || metadata?.gameId || "未選択"],
    ["gameId", metadata?.gameId || "未選択"],
    ["試合日", metadata?.gameDate || "-"],
    ["現在の正式スタメンversion", current ? `v${current.version}` : "確認中"],
    ["再採点可能期限", expiresAt],
    ["編集する実スタメン", actual.ok ? "9人・打順・守備位置を確認済み" : actual.error]
  ];
  summary.innerHTML = `<dl>${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
  saveButton.disabled = !metadata || !actual.ok || busy;
  previewButton.disabled = !metadata || !current || busy;
  confirmButton.disabled = !metadata || !state.manualRescore.preview || busy;
  restoreButton.disabled = !metadata || !previous || busy;
  message.textContent = state.manualRescore.message;
  message.className = `message${state.manualRescore.message.includes("できません") || state.manualRescore.message.includes("失敗") || state.manualRescore.message.includes("不一致") ? " error-message" : ""}`;

  if (!state.manualRescore.preview) {
    preview.classList.add("hidden");
    preview.innerHTML = "";
  } else {
    const item = state.manualRescore.preview;
    preview.classList.remove("hidden");
    preview.innerHTML = `<strong>再採点プレビュー（DBは変更していません）</strong><dl>
      <dt>使用するversion</dt><dd>v${escapeHtml(item.lineupVersion)}</dd>
      <dt>対象予想</dt><dd>${escapeHtml(item.summary.processed)}件</dd>
      <dt>点数変更</dt><dd>${escapeHtml(item.summary.scoreChangedCount)}人</dd>
      <dt>上昇 / 下降</dt><dd>${escapeHtml(item.summary.scoreIncreasedCount)}人 / ${escapeHtml(item.summary.scoreDecreasedCount)}人</dd>
      <dt>満点者増減</dt><dd>${escapeHtml(item.summary.perfectCountDelta > 0 ? `+${item.summary.perfectCountDelta}` : item.summary.perfectCountDelta)}件</dd>
      <dt>ランキング再集計対象</dt><dd>${escapeHtml(item.summary.rankingAffectedUserCount)}人</dd>
      <dt>有効期限</dt><dd>${escapeHtml(formatDateTime(item.previewExpiresAt))}</dd>
    </dl>`;
  }
  const revisions = record?.revisions || [];
  const audits = state.manualRescore.audits || [];
  if (!revisions.length && !audits.length) {
    history.classList.add("hidden");
    history.innerHTML = "";
  } else {
    history.classList.remove("hidden");
    history.innerHTML = `<strong>正式スタメン修正履歴</strong><ul>${revisions.map((revision) => `<li>v${escapeHtml(revision.version)} ${revision.isCurrent ? "（現在）" : ""} - ${escapeHtml(revision.source)} - ${escapeHtml(revision.reason)}</li>`).join("")}</ul>
      ${audits.length ? `<strong>再採点実行履歴</strong><ul>${audits.map((audit) => `<li>v${escapeHtml(audit.lineup_version)} - ${escapeHtml(audit.status)} - ${escapeHtml(audit.changed_score_count)}件変更${audit.error_code ? ` - ${escapeHtml(audit.error_code)}` : ""}</li>`).join("")}</ul>` : ""}`;
  }
}

async function refreshManualRescorePanel({ force = false } = {}) {
  const metadata = getManualRescoreMetadata();
  if (!state.isAdminMode || !metadata || (state.manualRescore.isLoading && !force)) return;
  const requestGameId = metadata.gameId;
  state.manualRescore.isLoading = true;
  state.manualRescore.gameId = requestGameId;
  state.manualRescore.message = "";
  renderManualRescorePanel();
  try {
    const [lineupResponse, auditResponse] = await Promise.all([
      fetch(buildAdminGameApiUrl(requestGameId, "lineup-history"), { credentials: "include", cache: "no-store" }),
      fetch(buildAdminGameApiUrl(requestGameId, "rescore-history"), { credentials: "include", cache: "no-store" })
    ]);
    const lineupPayload = await lineupResponse.json().catch(() => null);
    const auditPayload = await auditResponse.json().catch(() => null);
    if (!lineupResponse.ok || !lineupPayload?.ok) throw new Error(lineupPayload?.error || lineupPayload?.code || `HTTP ${lineupResponse.status}`);
    if (!auditResponse.ok || !auditPayload?.ok) throw new Error(auditPayload?.error || auditPayload?.code || `HTTP ${auditResponse.status}`);
    if (state.manualRescore.gameId !== requestGameId) return;
    state.manualRescore.history = lineupPayload;
    state.manualRescore.audits = auditPayload.history || [];
  } catch (error) {
    if (state.manualRescore.gameId === requestGameId) {
      state.manualRescore.history = null;
      state.manualRescore.audits = [];
      state.manualRescore.message = error?.message || "再採点履歴を取得できませんでした。";
    }
  } finally {
    if (state.manualRescore.gameId === requestGameId) {
      state.manualRescore.isLoading = false;
      renderManualRescorePanel();
    }
  }
}

async function runManualRescoreRequest(action, body) {
  const metadata = getManualRescoreMetadata();
  if (!metadata || state.manualRescore.isSaving) return null;
  state.manualRescore.isSaving = true;
  renderManualRescorePanel();
  try {
    const response = await fetch(buildAdminGameApiUrl(metadata.gameId, action), {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...metadata, ...body })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || payload?.code || `HTTP ${response.status}`);
    return payload;
  } finally {
    state.manualRescore.isSaving = false;
  }
}

async function saveManualLineupRevision() {
  const actual = createAdminActualLineupPayload();
  if (!actual.ok) { state.manualRescore.message = actual.error; renderManualRescorePanel(); return; }
  const reason = getManualRescoreReason();
  try {
    const payload = await runManualRescoreRequest("lineup-revisions", { actualLineup: actual.lineup, reason });
    if (!payload) return;
    state.manualRescore.preview = null;
    state.manualRescore.message = `正式スタメンv${payload.revision.version}を保存しました。再採点プレビューを確認してください。`;
    await refreshManualRescorePanel({ force: true });
  } catch (error) {
    state.manualRescore.message = error?.message || "修正版を保存できませんでした。";
    renderManualRescorePanel();
  }
}

async function previewManualRescore() {
  const current = state.manualRescore.history?.revisions?.find((revision) => revision.isCurrent);
  const reason = getManualRescoreReason();
  if (!current) { state.manualRescore.message = "正式スタメンversionを取得してください。"; renderManualRescorePanel(); return; }
  try {
    const payload = await runManualRescoreRequest("rescore-preview", { lineupVersion: current.version, reason });
    if (!payload) return;
    state.manualRescore.preview = payload;
    state.manualRescore.message = "再採点プレビューが完了しました。DBは変更していません。";
  } catch (error) {
    state.manualRescore.message = error?.message || "再採点プレビューを実行できませんでした。";
  }
  renderManualRescorePanel();
}

async function confirmManualRescore() {
  const metadata = getManualRescoreMetadata();
  const preview = state.manualRescore.preview;
  const reason = getManualRescoreReason();
  if (!metadata || !preview) return;
  if (!window.confirm(`${metadata.gameDate} ${state.gameInfo.matchup || metadata.gameId}（${metadata.gameId}）のみを再採点します。他の日の試合は変更されません。`)) return;
  try {
    const payload = await runManualRescoreRequest("rescore-confirm", { lineupVersion: preview.lineupVersion, previewId: preview.previewId, reason });
    if (!payload) return;
    state.manualRescore.preview = null;
    state.manualRescore.message = `${payload.changedScoreCount}件の点数を対象試合だけ再採点しました。`;
    await Promise.all([refreshManualRescorePanel({ force: true }), refreshAdminScoringSummary({ force: true }), refreshYearlyRanking({ force: true }), fetchTodayPerfectAchievers({ force: true })]);
  } catch (error) {
    state.manualRescore.message = error?.message || "再採点を確定できませんでした。";
    renderManualRescorePanel();
  }
}

async function restorePreviousLineupRevision() {
  const previous = state.manualRescore.history?.revisions?.find((revision) => !revision.isCurrent);
  const reason = getManualRescoreReason();
  if (!previous) return;
  try {
    const payload = await runManualRescoreRequest("restore-lineup-version", { version: previous.version, reason });
    if (!payload) return;
    state.manualRescore.preview = null;
    state.manualRescore.message = `v${previous.version}を新しいv${payload.revision.version}として復元しました。再採点プレビューを確認してください。`;
    await refreshManualRescorePanel({ force: true });
  } catch (error) {
    state.manualRescore.message = error?.message || "正式スタメンを復元できませんでした。";
    renderManualRescorePanel();
  }
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
        void fetchTodayPerfectAchievers({ force: true });
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
      await fetchTodayPerfectAchievers({ force: true });
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

function formatAutoScoringStatus(status, publicationStatus = "") {
  if (status === "scored" && publicationStatus === "scored_private") return "採点済み・公開待ち";
  if (status === "scored" && publicationStatus === "published") return "採点済み・公開済み";
  return ({ pending: "採点待ち", processing: "採点処理中", scored: "採点済み", failed: "採点失敗", cancelled: "取り消し済み" })[status] || "未予約";
}

function formatAdminScoringRemainingTime(dueAt) {
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
    ["状態", formatAutoScoringStatus(status, record.publicationStatus)],
    ["対象gameId", record.gameId || state.autoScoring.gameId || "-"],
    ["実スタメン取得", formatDateTime(record.lineupDetectedAt)],
    ["採点予定", formatDateTime(record.scoringDueAt)],
    ["残り時間", status === "pending" ? formatAdminScoringRemainingTime(record.scoringDueAt) : "-"],
    ["試行回数", `${record.attempts || 0} / ${record.maxAttempts || 3}`],
    ["処理件数", record.processedPredictions === null ? "-" : `${record.processedPredictions}件`],
    ["満点", record.perfectCount === null ? "-" : `${record.perfectCount}件`],
    ["採点完了", record.scoredAt ? formatDateTime(record.scoredAt) : "-"],
    ["公開状態", formatPregameAutomationStatus(record.publicationStatus)],
    ["公開時刻", record.publishedAt ? formatDateTime(record.publishedAt) : "-"]
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

function formatPregameAutomationStatus(status) {
  return ({ pending: "待機中", provisional: "仮保存（採点前）", captured: "保存済み", failed: "取得失敗", skipped: "停止", scored: "採点済み", scored_private: "採点済み（非公開）", published: "公開済み", blocked: "要手動対応" })[status] || "未確認";
}

function getPregameActionLabel(action) {
  return ({
    "run-notice": "公示取得",
    "distribute-notice": "公示結果の当日試合への配布",
    "run-roster": "ロースター取得",
    "fix-roster": "ロースター固定",
    "run-lineup": "正式スタメン取得",
    scoring: "採点",
    publish: "公開処理"
  })[action] || "試合前処理";
}

function getSafePregameActionError(response, payload, action = "") {
  const candidate = String(payload?.code || payload?.error || "");
  const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(candidate) ? candidate : "";
  const rawMessage = typeof payload?.error === "string" ? payload.error.trim() : "";
  const message = rawMessage && rawMessage.length <= 180 ? rawMessage : "安全なエラー情報を取得できませんでした。";
  const safeCode = code || "PREGAME_TOOL_FAILED";
  const upstreamStatus = Number(payload?.upstreamStatus) > 0 ? ` 上流HTTP：${Number(payload.upstreamStatus)}` : "";
  return `${getPregameActionLabel(action)}を実行できませんでした。${message} コード：${safeCode} HTTP：${response.status}${upstreamStatus}`;
}

async function runPregameAutomationAction(action) {
  const gameId = getAdminScoringGameId();
  const url = buildAdminGameApiUrl(gameId, `pregame-automation/${action}`);
  if (!gameId || !url || state.pregameAutomation.isRunning) {
    state.pregameAutomation.message = "対象試合を日程から読み込んでください。";
    renderPregameAutomationTools();
    return;
  }

  state.pregameAutomation.isRunning = true;
  const actionMessages = {
    "run-notice": "本日の公示を取得中...",
    "distribute-notice": "保存済みの公示結果を当日試合へ配布中...",
    "run-roster": "ロースターを取得中...",
    "fix-roster": "締切時点のロースターを固定中...",
    "run-lineup": "正式スタメンを取得中...",
    publish: "公開処理を実行中..."
  };
  state.pregameAutomation.message = actionMessages[action] || "試合前処理を実行中...";
  renderPregameAutomationTools();
  try {
    const response = await fetch(url, { method: "POST", credentials: "include" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(getSafePregameActionError(response, payload, action));
    }
    const completedMessages = {
      "run-notice": "公示取得と当日試合への配布を実行しました。",
      "distribute-notice": "公示結果を当日試合へ配布しました。",
      "run-roster": "ロースター取得を実行しました。",
      "fix-roster": "ロースターの固定を実行しました。",
      "run-lineup": "正式スタメン取得を実行しました。",
      publish: "結果の公開判定を実行しました。"
    };
    state.pregameAutomation.message = action === "run-notice" && payload?.result?.isEmpty
      ? "公示取得が完了しました。指定日の登録・抹消は0件です。"
      : (completedMessages[action] || "試合前処理を実行しました。");
    if (action === "run-notice" || action === "distribute-notice" || action === "run-roster" || action === "fix-roster") {
      await initializeRosterCandidateSync();
    }
    await refreshAutoScoringStatus({ force: true });
    await refreshAdminGameWorkflowStatus({ force: true });
  } catch (error) {
    console.error("試合前処理の手動実行に失敗しました", error.message);
    state.pregameAutomation.message = error.message || `${getPregameActionLabel(action)}を実行できませんでした。`;
  } finally {
    state.pregameAutomation.isRunning = false;
    renderPregameAutomationTools();
  }
}

async function runPregameScoringAction() {
  const gameId = getAdminScoringGameId();
  const url = buildAdminGameApiUrl(gameId, "auto-scoring/run-now");
  if (!gameId || !url || state.pregameAutomation.isRunning) {
    state.pregameAutomation.message = "対象試合を日程から読み込んでください。";
    renderPregameAutomationTools();
    return;
  }
  if (!window.confirm("この試合の保存済み予想を採点します。よろしいですか？")) return;
  state.pregameAutomation.isRunning = true;
  state.pregameAutomation.message = "採点を実行中...";
  renderPregameAutomationTools();
  try {
    const response = await fetch(url, { method: "POST", credentials: "include" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(getSafePregameActionError(response, payload, "scoring"));
    state.pregameAutomation.message = `採点を実行しました。${Number(payload.scored || 0)}件を更新しました。`;
    await refreshAdminScoringSummary({ force: true });
    await refreshAutoScoringStatus({ force: true });
    await refreshAdminGameWorkflowStatus({ force: true });
  } catch (error) {
    console.error("試合前処理の採点に失敗しました", error.message);
    state.pregameAutomation.message = error.message || "採点を実行できませんでした。";
  } finally {
    state.pregameAutomation.isRunning = false;
    renderPregameAutomationTools();
  }
}

function renderPregameAutomationTools() {
  const container = document.getElementById("adminPregameTools");
  const message = document.getElementById("adminPregameAutomationToolsMessage");
  if (!container || !message) return;
  container.querySelectorAll("button").forEach((button) => {
    button.disabled = state.pregameAutomation.isRunning;
  });
  message.textContent = state.pregameAutomation.message;
  message.className = `message${state.pregameAutomation.message.includes("できません") || state.pregameAutomation.message.includes("失敗") ? " error-message" : ""}`;
}

function getGameWorkflowStepLabel(value) {
  return ({
    notice: "公示確認待ち",
    close_predictions: "予想締切",
    lineup: "正式スタメン取得",
    final_lineup: "最終スタメン再取得",
    score: "採点",
    publish: "公開処理",
    completed: "公開済み",
    error: "エラー確認待ち"
  })[value] || "確認中";
}

function getGameWorkflowResultLabel(value) {
  return ({
    waiting: "待機中",
    retry_wait: "再試行待ち",
    lineup_captured: "正式スタメン取得済み",
    scoring_pending: "採点待ち",
    scoring: "採点処理中",
    scored_private: "採点済み・公開待ち",
    scoring_failed: "採点失敗",
    publish_failed: "公開失敗",
    published: "公開済み",
    failed: "要確認"
  })[value] || "未実行";
}

function getManagedGameSelectionLabel(value) {
  return ({
    TODAY_UNCOMPLETED_GAME: "本日の未完了試合",
    NEXT_UPCOMING_GAME: "次回開催試合",
    TODAY_INCOMPLETE_GAME: "本日の採点・公開未完了試合",
    RECENT_UNCOMPLETED_GAME: "直近48時間の未完了試合",
    RECENT_HISTORICAL_FAILURE: "直近の過去失敗試合",
    LATEST_HISTORICAL_FALLBACK: "最新の過去試合",
    NO_MANAGED_GAME: "対象試合なし"
  })[value] || value || "-";
}

function renderAdminGameWorkflowStatus() {
  const panel = document.getElementById("adminGameWorkflowStatus");
  const summary = document.getElementById("adminGameWorkflowSummary");
  const message = document.getElementById("adminGameWorkflowMessage");
  const pauseButton = document.getElementById("toggleGameWorkflowPauseButton");
  if (!panel || !summary || !message || !pauseButton) return;

  const available = state.appMode === "admin" && state.adminAccess.status === "authorized";
  panel.classList.toggle("hidden", !available);
  if (!available) return;

  const record = state.gameWorkflow.record;
  const paused = record?.automation?.paused === true;
  pauseButton.disabled = state.gameWorkflow.isLoading || state.gameWorkflow.isUpdating || !getAdminScoringGameId();
  pauseButton.textContent = paused ? "自動運転を再開" : "緊急停止";
  pauseButton.classList.toggle("danger-button", !paused);
  pauseButton.classList.toggle("secondary-button", paused);

  if (state.gameWorkflow.isLoading && !record) {
    summary.textContent = "自動運転の状態を確認しています。";
    message.textContent = "";
    return;
  }
  if (!record) {
    summary.textContent = "対象試合を取得できませんでした。";
    message.textContent = state.gameWorkflow.message || "次回Cronで再試行します。";
    message.className = "message error-message";
    return;
  }

  const schedule = record.schedule || {};
  const workflow = record.workflow || {};
  const scoring = record.scoring || {};
  const publishing = record.publishing || {};
  const publicationWorkflow = record.publicationWorkflow || {};
  const lineup = record.lineup || {};
  const automationHealth = record.automation?.health || {};
  const currentGame = record.currentGame || {};
  const jobSummary = record.jobSummary || {};
  const lineupJobStatus = record.lineupFetchState || jobSummary.lineupFetchState || "not_started";
  const finalLineupJob = record.lineupFetchStatus?.final || jobSummary.lineupFetchStatus?.final || null;
  const lastFetchAttempt = record.lastFetchAttempt || jobSummary.lastFetchAttempt || null;
  const jobWarnings = Array.isArray(record.warnings) ? record.warnings : [];
  const jobErrors = Array.isArray(record.errors) ? record.errors : [];
  const lineupJobReason = lastFetchAttempt
    ? `${lastFetchAttempt.errorCode || lastFetchAttempt.health?.reasonCode || lineupJobStatus}${lastFetchAttempt.errorDetail ? `: ${lastFetchAttempt.errorDetail}` : ""}`
    : lineupJobStatus === "not_started" ? "未作成" : lineupJobStatus;
  const lineupAttemptCount = lastFetchAttempt
    ? `${Number(lastFetchAttempt.attemptCount || 0)} / ${Number(lastFetchAttempt.maxAttempts || 0) || "-"}`
    : "-";
  const finalLineupDisplay = lineup.finalLineupFallbackUsed
    ? "最終取得失敗・直前取得データを使用"
    : finalLineupJob?.status === "retry_wait"
      ? `${finalLineupJob.health?.level === "error" ? "エラー" : "再試行待ち"}（${finalLineupJob.errorCode || "理由未記録"}）`
      : finalLineupJob?.status === "permanently_failed"
        ? `恒久失敗（${finalLineupJob.errorCode || "理由未記録"}）`
        : finalLineupJob?.status === "pending" || finalLineupJob?.status === "claimed" || finalLineupJob?.status === "running"
          ? "実行待ち"
          : (lineup.finalLineupErrorCode ? `取得失敗（${lineup.finalLineupErrorCode}）` : lineup.status === "captured" ? "取得済み" : "未実行");
  const validation = record.validation || lastFetchAttempt?.validation || null;
  const validationDetail = validation
    ? [
      validation.validationReason,
      validation.parseStage,
      validation.parsedCount !== null && validation.expectedCount !== null ? `行数 ${validation.parsedCount}/${validation.expectedCount}` : "",
      validation.duplicatePlayerCount ? `重複 ${validation.duplicatePlayerCount}` : "",
      validation.missingPositionCount ? `守備位置欠損 ${validation.missingPositionCount}` : "",
      validation.sourceUrlHost ? `取得元 ${validation.sourceUrlHost}` : "",
      validation.httpStatus ? `HTTP ${validation.httpStatus}` : ""
    ].filter(Boolean).join(" / ")
    : "なし";
  const historicalFailures = Array.isArray(record.historicalFailures) ? record.historicalFailures : [];
  const provisionalLineup = Array.isArray(lineup.provisionalLineup)
    ? lineup.provisionalLineup.map((item) => `${item.battingOrder}番 ${item.position || ""} ${item.playerName || ""}`.trim()).join(" / ")
    : "";
  const rows = [
    ["対象試合", record.game?.matchupLabel || record.gameId || "-"],
    ["試合開始", formatPredictionDeadlineDateTime(schedule.startAt)],
    ["予想締切", formatPredictionDeadlineDateTime(schedule.predictionDeadlineAt)],
    ["受付状態", getEffectivePredictionDeadline().isClosed ? "締切後" : "締切前"],
    ["現在のワークフロー", getGameWorkflowStepLabel(workflow.currentStep)],
    ["正式スタメン", formatPregameAutomationStatus(lineup.status)],
    ["最終スタメン取得", finalLineupDisplay],
    ["スタメンjob状態", lineupJobStatus],
    ["スタメン取得理由", lineupJobReason],
    ["スタメン試行回数", lineupAttemptCount],
    ["スタメン次回試行", lastFetchAttempt?.nextAttemptAt ? formatDateTime(lastFetchAttempt.nextAttemptAt) : "-"],
    ["スタメン検証詳細", validationDetail],
    ["仮スタメン", provisionalLineup || "未取得"],
    ["採点状態", formatAutoScoringStatus(scoring.status, scoring.publicationStatus)],
    ["採点時刻", scoring.scoredAt ? formatDateTime(scoring.scoredAt) : "-"],
    ["公開予定", formatPredictionDeadlineDateTime(schedule.resultReleaseAt)],
    ["公開状態", formatPregameAutomationStatus(publishing.status)],
    ["公開時刻", publishing.publishedAt ? formatDateTime(publishing.publishedAt) : "-"],
    ["公開job", publicationWorkflow.jobStatus || "未作成"],
    ["公開job次回実行", publicationWorkflow.nextAttemptAt ? formatDateTime(publicationWorkflow.nextAttemptAt) : (publicationWorkflow.scheduledAt ? formatDateTime(publicationWorkflow.scheduledAt) : "-")],
    ["最後に成功した遷移", publicationWorkflow.lastSuccessfulTransition?.completedAt ? `${publicationWorkflow.lastSuccessfulTransition.jobType} / ${formatDateTime(publicationWorkflow.lastSuccessfulTransition.completedAt)}` : "-"],
    ["現在のblocker", record.currentBlocker || "なし"],
    ["最終実行", workflow.lastRunAt ? formatDateTime(workflow.lastRunAt) : "未実行"],
    ["最終結果", getGameWorkflowResultLabel(workflow.lastResult)],
    ["最終Cron実行", automationHealth.available ? (automationHealth.cronLastRunAt ? formatDateTime(automationHealth.cronLastRunAt) : "未実行") : "状態テーブル未適用"],
    ["最終Cron成功", automationHealth.available ? (automationHealth.cronLastSuccessAt ? formatDateTime(automationHealth.cronLastSuccessAt) : "-" ) : "-"],
    ["最終Cronエラー", automationHealth.available ? (automationHealth.cronLastError || "なし") : "-"],
    ["現在の対象区分", getManagedGameSelectionLabel(currentGame.selectionReason)],
    ["保留job", `${Number(jobSummary.pendingCount || 0)}件`],
    ["再試行待ちjob", `${Number(jobSummary.retryCount || 0)}件`],
    ["次回実行", jobSummary.nextExecutionAt ? formatDateTime(jobSummary.nextExecutionAt) : "-"],
    ["Cron処理確認件数", automationHealth.available ? `${Number(automationHealth.processedGameCount || 0)}件` : "-"]
  ];
  const historicalMarkup = historicalFailures.length
    ? `<section class="admin-workflow-history" aria-label="直近の要確認"><strong>直近の要確認</strong><ul>${historicalFailures.map((failure) => {
      const label = formatGameProgressLabel({ date: failure.gameDate, awayTeam: failure.awayTeam, homeTeam: failure.homeTeam }) || failure.gameId || "過去試合";
      const status = failure.classification || failure.workflowStatus || "historical";
      const detail = failure.lastErrorCode ? `: ${failure.lastErrorCode}` : "";
      return `<li><span>${escapeHtml(label)}</span><b>${escapeHtml(`${status}${detail}`)}</b></li>`;
    }).join("")}</ul></section>`
    : "";
  summary.innerHTML = `<strong>${paused ? "緊急停止中" : "自動運転中"}</strong><span>${paused ? "この試合のCron自動処理は停止しています。" : "毎分、試合状態を確認しています。次回確認: 1分以内"}</span><dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>${historicalMarkup}`;
  const workflowError = workflow.errorCode ? `${workflow.errorCode}${workflow.errorMessage ? `: ${workflow.errorMessage}` : ""}` : "";
  const jobIssue = jobErrors[0] || jobWarnings[0] || "";
  message.textContent = state.gameWorkflow.message || workflowError || jobIssue || (paused ? "再開するまで公示・締切・取得・採点・公開の自動処理は実行されません。" : "管理者操作なしでCronが処理を進めます。");
  message.className = `message${workflowError || jobErrors.length ? " error-message" : jobWarnings.length ? " warning-message" : ""}`;
}

async function refreshAdminGameWorkflowStatus({ force = false } = {}) {
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") return;
  const url = buildAdminCurrentGameWorkflowApiUrl();
  if (!url || (state.gameWorkflow.isLoading && !force)) return;
  const requestId = ++state.gameWorkflow.requestId;
  state.gameWorkflow.isLoading = true;
  state.gameWorkflow.gameId = "";
  state.gameWorkflow.message = "";
  renderAdminGameWorkflowStatus();
  renderAdminWorkflowLogs();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || payload?.code || `HTTP ${response.status}`);
    if (requestId !== state.gameWorkflow.requestId) return;
    state.gameWorkflow.record = payload;
    state.gameWorkflow.gameId = payload.currentGame?.legacyGameId || payload.currentGame?.gameId || payload.gameId || "";
  } catch (error) {
    if (requestId !== state.gameWorkflow.requestId) return;
    state.gameWorkflow.record = null;
    state.gameWorkflow.message = `${error?.message || "状態を取得できませんでした。"} 次回Cronで再試行します。`;
  } finally {
    if (requestId === state.gameWorkflow.requestId) {
      state.gameWorkflow.isLoading = false;
      renderAdminGameWorkflowStatus();
    }
  }
}

function buildAdminGameProgressStatusApiUrl() {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/admin/game-progress-status` : "";
}

function buildAdminCurrentGameWorkflowApiUrl() {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/admin/audit/current-game-workflow` : "";
}

function getGameProgressStatusLabel(status) {
  return ({
    completed: "✅ 完了",
    waiting: "🟡 待機中",
    not_started: "⚪ 未実行",
    error: "🔴 エラー",
    out_of_scope: "◻ 対象外"
  })[status] || "⚪ 未実行";
}

function renderAdminGameProgressStatus() {
  const panel = document.getElementById("adminGameProgressBoard");
  const content = document.getElementById("adminGameProgressContent");
  const refresh = document.getElementById("refreshAdminGameProgressButton");
  if (!panel || !content || !refresh) return;

  const available = state.appMode === "admin" && state.adminAccess.status === "authorized";
  panel.classList.toggle("hidden", !available);
  if (!available) return;

  const progress = state.gameProgressStatus;
  refresh.disabled = progress.isLoading;
  if (progress.isLoading && !progress.record) {
    content.innerHTML = '<p class="message">試合進行ステータスを読み込み中です。</p>';
    return;
  }
  if (progress.message) {
    content.innerHTML = `<p class="message error-message">${escapeHtml(progress.message)}</p>`;
    return;
  }
  if (!progress.record?.gameId || !progress.record.statuses) {
    content.innerHTML = '<p class="empty-state">現在の管理対象試合はありません</p>';
    return;
  }

  const record = progress.record;
  const game = record.game || {};
  const eligibility = record.rankingEligibility || {};
  const rows = [
    ["targetSelected", "管理対象試合決定"],
    ["probableStarter", "予告先発取得"],
    ["predictionOpen", "予想受付中"],
    ["predictionClosed", "予想受付終了"],
    ["lineupFetched", "スタメン取得"],
    ["scoringCompleted", "採点完了"],
    ["rankingUpdated", "ランキング更新"],
    ["resultPublished", "結果公開"],
    ["errorState", "エラー状態"]
  ];
  const formatStatusTime = (value, prefix) => value ? `${prefix} ${formatDateTime(value)}` : "";
  content.innerHTML = `
    <p class="admin-game-progress-game">${escapeHtml(record.gameLabel || game.matchupLabel || record.gameId)}</p>
    <p class="admin-game-progress-updated">最終更新: ${escapeHtml(record.updatedAt ? formatDateTime(record.updatedAt) : "未更新")}</p>
    <dl class="admin-game-progress-list">${rows.map(([key, label]) => {
      const item = record.statuses[key] || { status: "not_started", detail: "" };
      const time = item.completedAt ? formatStatusTime(item.completedAt, "完了") : item.scheduledAt ? formatStatusTime(item.scheduledAt, "予定") : "";
      return `<div class="admin-game-progress-item"><dt>${escapeHtml(label)}</dt><dd><span class="admin-game-progress-status is-${escapeHtml(item.status)}">${escapeHtml(getGameProgressStatusLabel(item.status))}</span><small class="admin-game-progress-detail">${escapeHtml([item.detail, item.errorCode, time].filter(Boolean).join(" / "))}</small></dd></div>`;
    }).join("")}</dl>
    <section class="admin-ranking-eligibility" aria-labelledby="admin-ranking-eligibility-title">
      <div class="admin-ranking-eligibility-heading"><strong id="admin-ranking-eligibility-title">ランキング対象設定</strong><span>${escapeHtml(eligibility.rankingEligibilityStatus || "未確認")}</span></div>
      <p>${escapeHtml(eligibility.rankingEligibilityReason || eligibility.rankingEligibilityNote || "通常試合として集計")}</p>
      <div class="admin-ranking-eligibility-actions">
        <button type="button" class="secondary-button compact-button" data-ranking-eligibility-action="eligible">対象にする</button>
        <button type="button" class="danger-button compact-button" data-ranking-eligibility-action="excluded">対象外にする</button>
        <button type="button" class="secondary-button compact-button" data-ranking-eligibility-action="pending_admin_decision">判断待ちに戻す</button>
      </div>
    </section>
    ${record.errors?.length ? `<p class="admin-game-progress-errors">直近エラー: ${escapeHtml(record.errors[0].errorCode || record.errors[0].message || "確認が必要です")}</p>` : ""}`;
}

async function handleAdminRankingEligibilityAction(event) {
  if (document.getElementById("legacyAdminReadOnlyNotice") && state.appMode === "admin") return;
  const button = event.target instanceof Element ? event.target.closest("[data-ranking-eligibility-action]") : null;
  if (!button) return;
  const record = state.gameProgressStatus.record;
  const gameId = record?.gameId;
  const action = button.dataset.rankingEligibilityAction;
  if (!gameId || !action || button.disabled) return;
  let reason = "";
  if (action === "excluded") {
    reason = window.prompt("対象外理由コードを入力してください（例: no_game, postponed, admin_decision）", "admin_decision") || "";
    if (!reason.trim()) return;
  }
  const note = action === "excluded" ? (window.prompt("対象外メモ（任意）", "") || "") : "";
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return;
  button.disabled = true;
  try {
    const response = await fetch(`${baseUrl}/api/admin/games/${encodeURIComponent(gameId)}/ranking-eligibility`, {
      method: "PUT",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: action, reason, note })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || payload?.code || `HTTP ${response.status}`);
    await refreshAdminGameProgressStatus({ force: true });
  } catch (error) {
    state.gameProgressStatus.message = error?.message || "ランキング対象状態を更新できませんでした。";
    renderAdminGameProgressStatus();
  } finally {
    button.disabled = false;
  }
}

function getReleaseReadinessStatusLabel(record) {
  if (!record) return "確認中";
  if (record.ready === true) return "正常";
  if (Array.isArray(record.blockers) && record.blockers.length) return "異常";
  return "警告";
}

function renderAdminReleaseReadiness() {
  const panel = document.getElementById("adminReleaseReadiness");
  const content = document.getElementById("adminReleaseReadinessContent");
  const refresh = document.getElementById("refreshAdminReleaseReadinessButton");
  if (!panel || !content || !refresh) return;
  const available = state.appMode === "admin" && state.adminAccess.status === "authorized";
  panel.classList.toggle("hidden", !available);
  if (!available) return;
  const readiness = state.releaseReadiness;
  refresh.disabled = readiness.isLoading;
  if (readiness.isLoading && !readiness.record) {
    content.innerHTML = '<p class="message">リリース準備状況を確認しています。</p>';
    return;
  }
  if (readiness.message) {
    content.innerHTML = `<p class="message error-message">${escapeHtml(readiness.message)}</p>`;
    return;
  }
  if (!readiness.record) {
    content.innerHTML = '<p class="empty-state">リリース準備状況は未確認です。</p>';
    return;
  }
  const checks = readiness.record.checks || {};
  const blockers = Array.isArray(readiness.record.blockers) ? readiness.record.blockers : [];
  const warnings = Array.isArray(readiness.record.warnings) ? readiness.record.warnings : [];
  const status = getReleaseReadinessStatusLabel(readiness.record);
  const rows = [
    ["自動処理", status],
    ["pending jobs", checks.pendingJobCount],
    ["retry jobs", checks.retryWaitCount],
    ["stale leases", checks.staleLeaseCount],
    ["permanently failed", checks.permanentlyFailedCount],
    ["internal ID未割当の新規試合", checks.gamesWithoutInternalGameId],
    ["後続job欠落", checks.missingDownstreamJobCount],
    ["最終Cron実行", readiness.cronLastRunAt ? formatDateTime(readiness.cronLastRunAt) : "確認済み"]
  ];
  content.innerHTML = `<dl class="admin-release-readiness-list">${rows.map(([label, value]) => `<div><dt>${escapeHtml(String(label))}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}</dl>${blockers.length ? `<p class="admin-release-readiness-errors">blocker: ${escapeHtml(blockers.join(", "))}</p>` : ""}${warnings.length ? `<p class="admin-release-readiness-warnings">warning: ${escapeHtml(warnings.join(", "))}</p>` : ""}`;
}

async function refreshAdminReleaseReadiness({ force = false } = {}) {
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") return;
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl || (state.releaseReadiness.isLoading && !force)) return;
  const requestId = ++state.releaseReadiness.requestId;
  state.releaseReadiness.isLoading = true;
  state.releaseReadiness.message = "";
  renderAdminReleaseReadiness();
  try {
    const response = await fetch(`${baseUrl}/api/admin/audit/release-readiness`, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || payload?.code || `HTTP ${response.status}`);
    if (requestId !== state.releaseReadiness.requestId) return;
    state.releaseReadiness.record = payload;
  } catch (error) {
    if (requestId !== state.releaseReadiness.requestId) return;
    state.releaseReadiness.record = null;
    state.releaseReadiness.message = error?.message || "リリース準備状況を取得できませんでした。";
  } finally {
    if (requestId === state.releaseReadiness.requestId) {
      state.releaseReadiness.isLoading = false;
      renderAdminReleaseReadiness();
    }
  }
}

async function refreshAdminGameProgressStatus({ force = false } = {}) {
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") return;
  const url = buildAdminGameProgressStatusApiUrl();
  if (!url || (state.gameProgressStatus.isLoading && !force)) return;
  const requestId = ++state.gameProgressStatus.requestId;
  state.gameProgressStatus.isLoading = true;
  state.gameProgressStatus.message = "";
  renderAdminGameProgressStatus();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || payload?.code || `HTTP ${response.status}`);
    if (requestId !== state.gameProgressStatus.requestId) return;
    state.gameProgressStatus.record = payload;
  } catch (error) {
    if (requestId !== state.gameProgressStatus.requestId) return;
    state.gameProgressStatus.record = null;
    state.gameProgressStatus.message = error?.message || "試合進行ステータスを取得できませんでした。";
  } finally {
    if (requestId === state.gameProgressStatus.requestId) {
      state.gameProgressStatus.isLoading = false;
      renderAdminGameProgressStatus();
    }
  }
}

function startGameProgressStatusRefresh() {
  stopGameProgressStatusRefresh();
  gameProgressStatusTimerId = setInterval(() => {
    void refreshAdminGameProgressStatus();
    void refreshAdminReleaseReadiness();
  }, GAME_PROGRESS_STATUS_REFRESH_MS);
}

function stopGameProgressStatusRefresh() {
  if (gameProgressStatusTimerId) {
    clearInterval(gameProgressStatusTimerId);
    gameProgressStatusTimerId = null;
  }
}

function getWorkflowLogStatusLabel(status) {
  return ({ success: "成功", warning: "注意", error: "エラー", info: "情報" })[status] || "情報";
}

function getWorkflowLogEventLabel(eventType) {
  return ({
    schedule_sync: "試合予定取得",
    notice_fetch: "公示取得",
    roster_fixed: "ロースター固定",
    prediction_target_switched: "対象試合切り替え",
    prediction_target_switch_skipped: "次戦なし",
    probable_starter_fetch_started: "予告先発取得開始",
    probable_starter_unannounced: "予告先発未発表",
    probable_starter_announced: "予告先発取得",
    probable_starter_fetch_failed: "予告先発取得失敗",
    probable_starter_manual_refresh: "予告先発手動再取得",
    lineup_fetch: "実スタメン取得",
    final_lineup_fetch: "最終スタメン取得",
    lineup_fallback: "仮スタメンへフォールバック",
    lineup_retry_wait: "取得再試行待ち",
    scoring_started: "採点開始",
    scoring_succeeded: "採点成功",
    scoring_failed: "採点失敗",
    scoring_skipped: "採点見送り",
    result_published: "結果正式公開",
    result_publish_failed: "結果公開失敗",
    ranking_reflected: "ランキング反映",
    admin_manual_operation: "管理者手動操作",
    admin_lineup_approved: "管理者スタメン登録",
    admin_lineup_revision: "管理者スタメン修正",
    admin_lineup_restore: "管理者スタメン復元",
    admin_rescore_preview: "再採点プレビュー",
    admin_rescore_confirmed: "管理者再採点"
  })[eventType] || eventType || "ワークフロー";
}

function renderAdminWorkflowLogs() {
  const panel = document.getElementById("adminWorkflowLogsPanel");
  const content = document.getElementById("adminWorkflowLogsContent");
  const toggle = document.getElementById("toggleAdminWorkflowLogsButton");
  const refresh = document.getElementById("refreshAdminWorkflowLogsButton");
  const list = document.getElementById("adminWorkflowLogsList");
  const message = document.getElementById("adminWorkflowLogsMessage");
  if (!panel || !content || !toggle || !refresh || !list || !message) return;

  const available = state.appMode === "admin" && state.adminAccess.status === "authorized";
  panel.classList.toggle("hidden", !available);
  if (!available) return;

  const expanded = state.workflowLogs.expanded === true;
  content.classList.toggle("hidden", !expanded);
  refresh.classList.toggle("hidden", !expanded);
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.textContent = expanded ? "ログを閉じる" : "ログを表示";
  if (!expanded) return;

  if (state.workflowLogs.isLoading && !state.workflowLogs.logs.length) {
    message.className = "message";
    message.textContent = "試合進行ログを読み込み中です。";
  } else {
    message.className = `message${state.workflowLogs.message ? " error-message" : ""}`;
    message.textContent = state.workflowLogs.message || (state.workflowLogs.logs.length ? `${state.workflowLogs.logs.length}件` : "管理ログは特にありません。");
  }

  list.innerHTML = state.workflowLogs.logs.map((log) => {
    const metadata = log.metadata && typeof log.metadata === "object"
      ? JSON.stringify(log.metadata, null, 2)
      : "{}";
    const status = String(log.status || "info");
    return `<article class="workflow-log-entry workflow-log-status-${escapeHtml(status)}">
      <div class="workflow-log-entry-main">
        <time datetime="${escapeHtml(log.occurredAt || "")}">${escapeHtml(formatDateTime(log.occurredAt))}</time>
        <span class="workflow-log-event">${escapeHtml(getWorkflowLogEventLabel(log.eventType))}</span>
        <span class="workflow-log-status">${escapeHtml(getWorkflowLogStatusLabel(status))}</span>
        <span class="workflow-log-game">${escapeHtml(log.gameId || "全体")}</span>
      </div>
      <p class="workflow-log-message">${escapeHtml(log.message || "")}${log.errorCode ? ` <code>${escapeHtml(log.errorCode)}</code>` : ""}</p>
      <details><summary>詳細</summary><pre>${escapeHtml(metadata)}</pre></details>
    </article>`;
  }).join("");
}

async function refreshAdminWorkflowLogs({ force = false } = {}) {
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") return;
  if (!state.workflowLogs.expanded) return;
  if (state.workflowLogs.isLoading && !force) return;
  const url = buildAdminWorkflowLogsApiUrl();
  if (!url) return;
  const requestId = ++state.workflowLogs.requestId;
  const query = new URLSearchParams({ limit: "50" });
  const gameId = document.getElementById("adminWorkflowLogGameId")?.value.trim();
  const eventType = document.getElementById("adminWorkflowLogEventType")?.value || "";
  const status = document.getElementById("adminWorkflowLogStatus")?.value || "";
  if (gameId) query.set("gameId", gameId);
  if (eventType) query.set("eventType", eventType);
  if (status) query.set("status", status);
  state.workflowLogs.isLoading = true;
  state.workflowLogs.message = "";
  renderAdminWorkflowLogs();
  try {
    const response = await fetch(`${url}?${query.toString()}`, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || payload?.code || `HTTP ${response.status}`);
    if (requestId !== state.workflowLogs.requestId) return;
    state.workflowLogs.logs = Array.isArray(payload.logs) ? payload.logs : [];
  } catch (error) {
    if (requestId !== state.workflowLogs.requestId) return;
    state.workflowLogs.logs = [];
    state.workflowLogs.message = "試合進行ログを取得できませんでした。";
    console.error("試合進行ログの取得に失敗しました", error?.message || "unknown error");
  } finally {
    if (requestId === state.workflowLogs.requestId) {
      state.workflowLogs.isLoading = false;
      renderAdminWorkflowLogs();
    }
  }
}

function getGameIdentityRepairPlans(preview = state.gameIdentityRepairs.preview) {
  const plans = Array.isArray(preview?.repairPlans) ? preview.repairPlans.slice() : [];
  return plans.sort((left, right) => {
    const leftSafety = isSafeGameIdentityRepairPlan(left) ? 0 : 1;
    const rightSafety = isSafeGameIdentityRepairPlan(right) ? 0 : 1;
    if (leftSafety !== rightSafety) return leftSafety - rightSafety;
    const rowCount = (plan) => (plan.tableRowsToUpdate || []).reduce((total, row) => total + Number(row.expectedCount || 0), 0);
    const rowDifference = rowCount(left) - rowCount(right);
    if (rowDifference) return rowDifference;
    const leftDate = String(left.scheduleIdentity?.gameDate || left.scheduleGameId || "");
    const rightDate = String(right.scheduleIdentity?.gameDate || right.scheduleGameId || "");
    return leftDate.localeCompare(rightDate) || String(left.repairId || "").localeCompare(String(right.repairId || ""));
  });
}

function isSafeGameIdentityRepairPlan(plan) {
  return plan?.classification === "SAFE_CREATE_INTERNAL_GAME" || plan?.classification === "SAFE_AUTO_LINK";
}

function getGameIdentityRepairAction(repairId) {
  return state.gameIdentityRepairs.actions[repairId] || {};
}

function setGameIdentityRepairAction(repairId, update) {
  state.gameIdentityRepairs.actions[repairId] = { ...getGameIdentityRepairAction(repairId), ...update };
}

function getGameIdentityRepairExecutionBlock(plan, action = getGameIdentityRepairAction(plan?.repairId)) {
  const repairs = state.gameIdentityRepairs;
  if (repairs.preview?.classificationIntegrity?.valid === false) return "修復候補の分類整合性に問題があるため、自動実行できません。";
  if (repairs.activeRepairId && repairs.activeRepairId !== plan.repairId) return "別の修復を実行中です。";
  if (repairs.blockedRepairId && repairs.blockedRepairId !== plan.repairId) return "前の修復を確認または再実行するまで、次の修復は実行できません。";
  if (action.requiresManualReview) return "部分書き込みを検出したため、自動再実行できません。";
  return "";
}

function createGameIdentityRepairRequestError(response, payload) {
  const error = new Error(payload?.error || payload?.code || `HTTP ${response.status}`);
  error.code = payload?.code || "GAME_IDENTITY_REPAIR_REQUEST_FAILED";
  error.httpStatus = response.status;
  error.processingStage = payload?.stage || "";
  error.expectedPlanHash = payload?.expectedPlanHash || "";
  error.currentPlanHash = payload?.currentPlanHash || "";
  error.storedPlanHash = payload?.storedPlanHash || "";
  error.mismatchReason = payload?.mismatchReason || "";
  return error;
}

function getGameIdentityRepairActionErrorDetails(action) {
  return [
    action.httpStatus ? `HTTP ${action.httpStatus}` : "",
    action.errorCode || "",
    action.processingStage ? `stage: ${action.processingStage}` : "",
    action.mismatchReason ? `reason: ${action.mismatchReason}` : "",
    action.expectedPlanHash ? `expected: ${action.expectedPlanHash}` : "",
    action.currentPlanHash ? `current: ${action.currentPlanHash}` : "",
    action.storedPlanHash ? `stored: ${action.storedPlanHash}` : ""
  ].filter(Boolean);
}

function formatGameIdentityRepairTableRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return "更新対象なし";
  return rows.map((row) => `${row.table}: ${row.legacyGameId} (${Number(row.expectedCount || 0)}件)`).join(" / ");
}

function renderGameIdentityRepairCard(plan) {
  const action = getGameIdentityRepairAction(plan.repairId);
  const safe = isSafeGameIdentityRepairPlan(plan);
  const isBusy = action.isBusy === true;
  const status = action.status || "";
  const errorCode = action.errorCode || "";
  const partial = action.partialWriteDetected;
  const resultMessage = action.message || "";
  const target = plan.createInternalGame
    ? "新しい内部試合IDを作成"
    : (plan.targetInternalGameId ? `既存の内部試合IDへ紐づけ: ${plan.targetInternalGameId}` : "修復先IDなし");
  const rollbackAllowed = action.auditStatus === "completed" && action.rollbackAvailable === true;
  const executionBlock = getGameIdentityRepairExecutionBlock(plan, action);
  const actionDisabled = isBusy || Boolean(executionBlock);
  const actionLabel = isBusy ? "処理中..." : action.auditStatus === "failed" ? "この1件を再実行" : "この1件を修復";
  const errorDetails = getGameIdentityRepairActionErrorDetails(action);
  return `<article class="game-identity-repair-card is-${escapeHtml(plan.classification || "unknown")}">
    <div class="game-identity-repair-card-heading">
      <strong>${escapeHtml(plan.classification || "未分類")}</strong>
      <code>${escapeHtml(plan.repairId || "-")}</code>
    </div>
    <dl class="game-identity-repair-details">
      <div><dt>対象試合</dt><dd>${escapeHtml(plan.scheduleGameId || "-")}</dd></div>
      <div><dt>修復先</dt><dd>${escapeHtml(target)}</dd></div>
      <div><dt>旧ID</dt><dd>${escapeHtml((plan.legacyGameIds || []).join(" / ") || "-")}</dd></div>
      <div><dt>更新対象</dt><dd>${escapeHtml(formatGameIdentityRepairTableRows(plan.tableRowsToUpdate))}</dd></div>
      <div><dt>plan hash</dt><dd><code>${escapeHtml(plan.planHash || "-")}</code></dd></div>
      <div><dt>理由</dt><dd>${escapeHtml((plan.reasonCodes || []).join(" / ") || "-")}</dd></div>
    </dl>
    ${safe ? `<div class="game-identity-repair-actions">
      <button class="primary-button compact-button" type="button" data-game-identity-repair-action="execute" data-repair-id="${escapeHtml(plan.repairId)}" ${actionDisabled ? "disabled" : ""}>${escapeHtml(actionLabel)}</button>
      ${rollbackAllowed ? `<button class="secondary-button compact-button" type="button" data-game-identity-repair-action="rollback" data-repair-id="${escapeHtml(plan.repairId)}" ${isBusy || Boolean(state.gameIdentityRepairs.activeRepairId) ? "disabled" : ""}>ロールバック</button>` : ""}
    </div>${executionBlock ? `<p class="game-identity-repair-notice">${escapeHtml(executionBlock)}</p>` : ""}` : `<p class="game-identity-repair-notice">この分類は自動実行できません。理由を確認して手動で対応してください。</p>`}
    ${status || resultMessage || errorCode || partial !== undefined ? `<p class="game-identity-repair-result${errorCode ? " error-message" : ""}">状態: ${escapeHtml(status || "未実行")}${resultMessage ? ` / ${escapeHtml(resultMessage)}` : ""}${partial !== undefined ? ` / 部分書き込み: ${partial ? "あり" : "なし"}` : ""}</p>` : ""}
    ${errorDetails.length ? `<p class="game-identity-repair-error-details">${escapeHtml(errorDetails.join(" / "))}</p>` : ""}
  </article>`;
}

function renderGameIdentityRepairCoverage(preview) {
  const summary = preview?.summary;
  if (!summary) return "";
  const integrity = preview?.classificationIntegrity?.valid === true ? "分類整合性: 正常" : "分類整合性: 要確認";
  return `<dl class="game-identity-repair-coverage-list">
    <div><dt>日程連携</dt><dd>${Number(summary.linkedScheduleGames || 0)} / ${Number(summary.scheduleGames || 0)}</dd></div>
    <div><dt>未連携</dt><dd>${Number(summary.unlinkedScheduleGames || 0)}件</dd></div>
    <div><dt>SAFE作成</dt><dd>${Number(summary.safeCreateCount || 0)}件</dd></div>
    <div><dt>SAFE連携</dt><dd>${Number(summary.safeAutoLinkCount || 0)}件</dd></div>
    <div><dt>手動確認</dt><dd>${Number(summary.manualReviewCount || 0)}件</dd></div>
    <div><dt>予測coverage</dt><dd>${Math.round(Number(summary.projectedCoverage || 0) * 100)}%</dd></div>
    <div><dt>分類</dt><dd>${escapeHtml(integrity)}</dd></div>
  </dl>`;
}

function renderGameIdentityRepairLastExecution(lastExecution) {
  if (!lastExecution) return "";
  const audit = lastExecution.audit || {};
  const observed = audit.observed || {};
  const details = [
    `repairId: ${lastExecution.repairId}`,
    `状態: ${lastExecution.status || "unknown"}`,
    audit.targetInternalGameId ? `target: ${audit.targetInternalGameId}` : "",
    observed.targetGameExists !== undefined ? `games: ${observed.targetGameExists ? "あり" : "なし"}` : "",
    observed.scheduleInternalGameId ? `schedule: ${observed.scheduleInternalGameId}` : "",
    observed.partialWriteDetected !== undefined ? `部分書き込み: ${observed.partialWriteDetected ? "あり" : "なし"}` : "",
    lastExecution.errorCode ? `errorCode: ${lastExecution.errorCode}` : ""
  ].filter(Boolean);
  return `<p class="game-identity-repair-last-result${lastExecution.errorCode ? " error-message" : ""}">${escapeHtml(details.join(" / "))}</p>`;
}

function renderAdminGameIdentityRepairs() {
  const panel = document.getElementById("adminGameIdentityRepairsPanel");
  const message = document.getElementById("adminGameIdentityRepairsMessage");
  const coverage = document.getElementById("adminGameIdentityRepairCoverage");
  const lastResult = document.getElementById("adminGameIdentityRepairLastResult");
  const list = document.getElementById("adminGameIdentityRepairsList");
  const refresh = document.getElementById("refreshAdminGameIdentityRepairsButton");
  if (!panel || !message || !coverage || !lastResult || !list || !refresh) return;
  const available = state.appMode === "admin" && state.adminAccess.status === "authorized";
  panel.classList.toggle("hidden", !available);
  if (!available) return;
  const repairs = state.gameIdentityRepairs;
  refresh.disabled = repairs.isLoading || Boolean(repairs.activeRepairId);
  refresh.textContent = repairs.message ? "再読み込み" : "修復候補を確認";
  coverage.innerHTML = renderGameIdentityRepairCoverage(repairs.preview);
  lastResult.innerHTML = renderGameIdentityRepairLastExecution(repairs.lastExecution);
  if (repairs.isLoading && !repairs.preview) {
    message.className = "message";
    message.textContent = "試合ID修復のdry-runを読み込み中です。";
    list.innerHTML = "";
    return;
  }
  if (repairs.message) {
    message.className = "message error-message";
    message.textContent = repairs.message;
  } else {
    const plans = getGameIdentityRepairPlans();
    message.className = "message";
    message.textContent = repairs.preview ? `dry-run: ${plans.length}件の修復計画。SAFE計画は更新件数が少ない順に表示しています。` : "";
  }
  const plans = getGameIdentityRepairPlans();
  const otherItems = [
    ...(Array.isArray(repairs.preview?.manualReviewItems) ? repairs.preview.manualReviewItems.filter((item) => !item.repairId) : []),
    ...(Array.isArray(repairs.preview?.obsoleteOrphans) ? repairs.preview.obsoleteOrphans : [])
  ];
  if (!plans.length && !otherItems.length) {
    list.innerHTML = repairs.preview ? '<p class="empty-state">確認が必要な試合IDはありません。</p>' : "";
    return;
  }
  const repairCards = plans.map(renderGameIdentityRepairCard).join("");
  const reviewCards = otherItems.map((item) => `<article class="game-identity-repair-card is-${escapeHtml(item.classification || "review")}">
    <div class="game-identity-repair-card-heading"><strong>${escapeHtml(item.classification || "MANUAL_REVIEW")}</strong><code>${escapeHtml(item.gameId || "-")}</code></div>
    <p class="game-identity-repair-notice">${escapeHtml((item.reasonCodes || []).join(" / ") || "自動修復の対象外です。")}</p>
  </article>`).join("");
  list.innerHTML = repairCards + reviewCards;
}

async function refreshAdminGameIdentityRepairs({ force = false } = {}) {
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") return;
  const repairs = state.gameIdentityRepairs;
  if (repairs.isLoading && !force) return;
  const url = buildAdminGameIdentityRepairPreviewApiUrl();
  if (!url) return;
  const requestId = ++repairs.requestId;
  repairs.isLoading = true;
  repairs.message = "";
  renderAdminGameIdentityRepairs();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || payload?.dryRun !== true) throw createGameIdentityRepairRequestError(response, payload);
    if (requestId !== repairs.requestId) return;
    repairs.preview = payload;
    await refreshAdminGameIdentityRepairAudits(payload.repairPlans, requestId);
  } catch (error) {
    if (requestId !== repairs.requestId) return;
    repairs.preview = null;
    repairs.message = [
      error?.httpStatus ? `HTTP ${error.httpStatus}` : "",
      error?.code || "",
      error?.message || "試合ID修復のdry-runを取得できませんでした。"
    ].filter(Boolean).join(" / ");
  } finally {
    if (requestId === repairs.requestId) {
      repairs.isLoading = false;
      renderAdminGameIdentityRepairs();
    }
  }
}

async function loadAdminGameIdentityRepairAudit(repairId) {
  const url = buildAdminGameIdentityRepairAuditApiUrl(repairId);
  if (!url) return null;
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok || !payload?.repair) throw createGameIdentityRepairRequestError(response, payload);
  return payload.repair;
}

async function refreshAdminGameIdentityRepairAudits(plans, requestId) {
  const auditEntries = await Promise.all((plans || []).filter(isSafeGameIdentityRepairPlan).map(async (plan) => {
    try {
      return [plan.repairId, await loadAdminGameIdentityRepairAudit(plan.repairId)];
    } catch {
      // 修復履歴がまだないdry-run計画は、未実行として表示します。
      return [plan.repairId, null];
    }
  }));
  if (requestId !== state.gameIdentityRepairs.requestId) return;
  auditEntries.forEach(([repairId, audit]) => {
    if (!audit || getGameIdentityRepairAction(repairId).isBusy) return;
    setGameIdentityRepairAction(repairId, {
      auditStatus: audit.status,
      rollbackAvailable: audit.status === "completed",
      partialWriteDetected: Boolean(audit.observed?.partialWriteDetected),
      errorCode: audit.errorCode || "",
      status: audit.status === "failed" ? "失敗（再実行可否を確認）" : (audit.status || ""),
      requiresManualReview: audit.status !== "completed" && Boolean(audit.observed?.partialWriteDetected)
    });
    if (audit.status === "failed" && !state.gameIdentityRepairs.blockedRepairId) {
      state.gameIdentityRepairs.blockedRepairId = repairId;
    }
  });
}

async function executeAdminGameIdentityRepair(plan) {
  const repairId = plan.repairId;
  const existingAction = getGameIdentityRepairAction(repairId);
  if (!repairId || !plan.planHash || existingAction.isBusy || getGameIdentityRepairExecutionBlock(plan, existingAction)) return;
  if (!window.confirm(`${plan.scheduleGameId} の修復を実行します。更新対象を確認しましたか？`)) return;
  state.gameIdentityRepairs.activeRepairId = repairId;
  setGameIdentityRepairAction(repairId, { isBusy: true, status: "実行中", message: "", errorCode: "", httpStatus: 0, processingStage: "", mismatchReason: "", expectedPlanHash: "", currentPlanHash: "", storedPlanHash: "" });
  renderAdminGameIdentityRepairs();
  try {
    const response = await fetch(buildAdminGameIdentityRepairsApiUrl(), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repairIds: [repairId], expectedPlanHashes: { [repairId]: plan.planHash } })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw createGameIdentityRepairRequestError(response, payload);
    const result = Array.isArray(payload.results) ? payload.results.find((item) => item.repairId === repairId) : null;
    if (!result || result.status !== "completed") {
      const error = new Error("修復APIが完了結果を返しませんでした。");
      error.code = "GAME_IDENTITY_REPAIR_RESULT_INVALID";
      error.httpStatus = response.status;
      throw error;
    }
    setGameIdentityRepairAction(repairId, { status: result?.status || "completed", message: "修復が完了しました。", errorCode: "" });
  } catch (error) {
    state.gameIdentityRepairs.blockedRepairId = repairId;
    setGameIdentityRepairAction(repairId, {
      status: "失敗",
      message: error?.message || "修復を完了できませんでした。",
      errorCode: error?.code || "GAME_IDENTITY_REPAIR_FAILED",
      httpStatus: error?.httpStatus || 0,
      processingStage: error?.processingStage || "",
      mismatchReason: error?.mismatchReason || "",
      expectedPlanHash: error?.expectedPlanHash || "",
      currentPlanHash: error?.currentPlanHash || "",
      storedPlanHash: error?.storedPlanHash || ""
    });
  } finally {
    let audit = null;
    try {
      audit = await loadAdminGameIdentityRepairAudit(repairId);
      setGameIdentityRepairAction(repairId, {
        auditStatus: audit.status,
        rollbackAvailable: audit.status === "completed",
        partialWriteDetected: Boolean(audit.observed?.partialWriteDetected),
        errorCode: audit.errorCode || getGameIdentityRepairAction(repairId).errorCode,
        requiresManualReview: audit.status !== "completed" && Boolean(audit.observed?.partialWriteDetected)
      });
      if (audit.status === "completed") state.gameIdentityRepairs.blockedRepairId = "";
    } catch (error) {
      setGameIdentityRepairAction(repairId, { message: `${getGameIdentityRepairAction(repairId).message || ""} 状態監査を取得できませんでした。`.trim() });
    }
    const action = getGameIdentityRepairAction(repairId);
    state.gameIdentityRepairs.lastExecution = {
      repairId,
      status: action.auditStatus || action.status,
      errorCode: action.errorCode || "",
      audit
    };
    setGameIdentityRepairAction(repairId, { isBusy: false });
    state.gameIdentityRepairs.activeRepairId = "";
    await refreshAdminGameIdentityRepairs({ force: true });
  }
}

async function rollbackAdminGameIdentityRepair(plan) {
  const repairId = plan.repairId;
  const action = getGameIdentityRepairAction(repairId);
  if (!repairId || !plan.planHash || action.isBusy || state.gameIdentityRepairs.activeRepairId || action.auditStatus !== "completed" || action.rollbackAvailable !== true) return;
  if (!window.confirm(`${plan.scheduleGameId} の修復をロールバックします。`)) return;
  setGameIdentityRepairAction(repairId, { isBusy: true, status: "ロールバック中", message: "", errorCode: "" });
  renderAdminGameIdentityRepairs();
  try {
    const response = await fetch(buildAdminGameIdentityRepairsApiUrl(repairId), {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedPlanHash: plan.planHash })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const error = new Error(payload?.error || payload?.code || `HTTP ${response.status}`);
      error.code = payload?.code || "GAME_IDENTITY_REPAIR_ROLLBACK_FAILED";
      throw error;
    }
    setGameIdentityRepairAction(repairId, { status: payload.status || "rolled_back", message: "ロールバックが完了しました。", errorCode: "", rollbackAvailable: false, partialWriteDetected: false });
  } catch (error) {
    setGameIdentityRepairAction(repairId, { status: "失敗", message: "ロールバックを完了できませんでした。", errorCode: error?.code || error?.message || "GAME_IDENTITY_REPAIR_ROLLBACK_FAILED" });
  } finally {
    setGameIdentityRepairAction(repairId, { isBusy: false });
    renderAdminGameIdentityRepairs();
  }
}

function handleAdminGameIdentityRepairAction(event) {
  if (document.getElementById("legacyAdminReadOnlyNotice") && state.appMode === "admin") return;
  const button = event.target.closest("button[data-game-identity-repair-action]");
  if (!button || state.appMode !== "admin" || state.adminAccess.status !== "authorized") return;
  const repairId = String(button.dataset.repairId || "");
  const plan = getGameIdentityRepairPlans().find((item) => item.repairId === repairId);
  if (!plan || !isSafeGameIdentityRepairPlan(plan)) return;
  if (button.dataset.gameIdentityRepairAction === "execute") {
    void executeAdminGameIdentityRepair(plan);
  } else if (button.dataset.gameIdentityRepairAction === "rollback") {
    void rollbackAdminGameIdentityRepair(plan);
  }
}

async function toggleGameWorkflowPause() {
  const gameId = getAdminScoringGameId();
  const paused = state.gameWorkflow.record?.automation?.paused === true;
  const action = paused ? "resume-workflow" : "pause-workflow";
  const url = buildAdminGameApiUrl(gameId, `pregame-automation/${action}`);
  if (!gameId || !url || state.gameWorkflow.isUpdating) return;
  const confirmation = paused
    ? "この試合の自動運転を再開します。よろしいですか？"
    : "この試合のCron自動処理を緊急停止します。手動実行は引き続き利用できます。よろしいですか？";
  if (!window.confirm(confirmation)) return;
  state.gameWorkflow.isUpdating = true;
  state.gameWorkflow.message = paused ? "自動運転を再開しています..." : "自動運転を緊急停止しています...";
  renderAdminGameWorkflowStatus();
  try {
    const response = await fetch(url, { method: "POST", credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || payload?.code || `HTTP ${response.status}`);
    state.gameWorkflow.message = paused ? "自動運転を再開しました。" : "緊急停止中です。";
    await refreshAdminGameWorkflowStatus({ force: true });
  } catch (error) {
    state.gameWorkflow.message = error?.message || "自動運転の状態を変更できませんでした。";
  } finally {
    state.gameWorkflow.isUpdating = false;
    renderAdminGameWorkflowStatus();
  }
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
      body: JSON.stringify({})
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.adminScoring.preview = payload;
    state.adminScoring.previewFingerprint = payload.lineupFingerprint || getAdminScoringFingerprint(actualPayload.lineup);
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
      body: JSON.stringify({})
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
    await fetchTodayPerfectAchievers({ force: true });
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

function getAuthApiBaseUrl() {
  if (typeof window !== "undefined" && window.starting9Auth?.getApiBaseUrl) {
    return window.starting9Auth.getApiBaseUrl();
  }
  // auth.js が環境ごとのURLを一元管理します。
  return "";
}

function getAutomationSettingsApiUrl() {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl ? `${baseUrl}/api/admin/automation/settings` : "";
}

function renderAutoApprovalSetting() {
  const checkbox = document.getElementById("autoApproveCheckbox");
  if (!checkbox) return;
  checkbox.checked = state.autoApproval.enabled;
  checkbox.disabled = state.autoApproval.isLoading || state.autoApproval.isSaving;
}

async function refreshAutoApprovalSettings() {
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized" || state.autoApproval.isLoading) {
    return;
  }
  const url = getAutomationSettingsApiUrl();
  if (!url) return;

  state.autoApproval.isLoading = true;
  renderAutoApprovalSetting();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || typeof payload?.settings?.autoApproveEnabled !== "boolean") {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.autoApproval.enabled = payload.settings.autoApproveEnabled;
    state.autoApproval.loaded = true;
  } catch (error) {
    console.warn("自動承認設定を取得できませんでした", error?.message || "unknown error");
    // 取得できない間はブラウザ側の自動本承認をしません。Cron側はD1の既定値で判断します。
    state.autoApproval.loaded = false;
  } finally {
    state.autoApproval.isLoading = false;
    renderAutoApprovalSetting();
  }
}

async function handleAutoApproveSettingChange(event) {
  const checkbox = event.currentTarget;
  if (!(checkbox instanceof HTMLInputElement) || state.autoApproval.isSaving) return;
  const nextEnabled = checkbox.checked;
  const previousEnabled = state.autoApproval.enabled;
  const url = getAutomationSettingsApiUrl();
  if (!url) {
    checkbox.checked = previousEnabled;
    return;
  }

  state.autoApproval.enabled = nextEnabled;
  state.autoApproval.isSaving = true;
  renderAutoApprovalSetting();
  try {
    const response = await fetch(url, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoApproveEnabled: nextEnabled })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || typeof payload?.settings?.autoApproveEnabled !== "boolean") {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.autoApproval.enabled = payload.settings.autoApproveEnabled;
    state.autoApproval.loaded = true;
  } catch (error) {
    console.warn("自動承認設定を保存できませんでした", error?.message || "unknown error");
    state.autoApproval.enabled = previousEnabled;
    state.autoApproval.loaded = false;
  } finally {
    state.autoApproval.isSaving = false;
    renderAutoApprovalSetting();
  }
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

function buildTodayPerfectAchieversApiUrl() {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!baseUrl) return "";
  const url = new URL(`${baseUrl}/api/rankings/perfect`, window.location.href);
  url.searchParams.set("date", getJapanDateString());
  return url.href;
}

async function initializeTodayPerfectAchievers() {
  await fetchTodayPerfectAchievers({ force: true });
}

async function fetchTodayPerfectAchievers({ force = false } = {}) {
  const perfectState = state.todayPerfectAchievers;
  if (perfectState.isLoading && !force) return;

  const url = buildTodayPerfectAchieversApiUrl();
  if (!url) {
    perfectState.message = "本日の満点者を取得できませんでした。";
    renderTodayPerfectAchievers();
    return;
  }

  const requestId = perfectState.requestId + 1;
  perfectState.requestId = requestId;
  perfectState.isLoading = true;
  perfectState.message = "";
  renderTodayPerfectAchievers();

  try {
    const response = await fetch(url, {
      credentials: "include",
      cache: force ? "no-store" : "default"
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !Array.isArray(payload.achievers)) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    if (requestId !== perfectState.requestId) return;
    perfectState.achievers = payload.achievers;
    perfectState.totalCount = Math.max(0, Number(payload.totalCount || payload.achievers.length));
  } catch (error) {
    if (requestId !== perfectState.requestId) return;
    console.error("本日の満点者の取得に失敗しました", error.message);
    perfectState.achievers = [];
    perfectState.totalCount = 0;
    perfectState.message = "本日の満点者を取得できませんでした。";
  } finally {
    if (requestId === perfectState.requestId) {
      perfectState.isLoading = false;
      renderTodayPerfectAchievers();
    }
  }
}

function renderTodayPerfectAchievers() {
  const container = document.getElementById("todayPerfectAchieversContent");
  const count = document.getElementById("todayPerfectAchieversCount");
  if (!container || !count) return;

  const perfectState = state.todayPerfectAchievers;
  count.textContent = perfectState.totalCount > 0 ? `${perfectState.totalCount}人` : "";
  if (perfectState.isLoading) {
    container.innerHTML = '<p class="perfect-achievers-message">本日の満点者を確認中です。</p>';
    return;
  }
  if (perfectState.message) {
    container.innerHTML = `<p class="perfect-achievers-message is-error">${escapeHtml(perfectState.message)}</p>`;
    return;
  }
  if (!perfectState.achievers.length) {
    container.innerHTML = '<p class="perfect-achievers-message">本日の満点者はいません。</p>';
    return;
  }

  container.innerHTML = `<ol class="perfect-achievers-list">${perfectState.achievers.map((achiever) => `
    <li>
      <span>${escapeHtml(achiever.score)}点</span>
      <strong>${escapeHtml(achiever.username)}</strong>
      <time datetime="${escapeHtml(achiever.submittedAt || "")}">${escapeHtml(achiever.gameDate)} ${escapeHtml(formatPerfectAchieverOpponent(achiever.opponent))}</time>
    </li>
  `).join("")}</ol>`;
}

function formatPerfectAchieverOpponent(opponent) {
  const value = String(opponent || "").trim();
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
  return labels[value] || value || "対戦相手";
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
      if (nextYear >= RANKING_SERVICE_START_YEAR && nextYear <= currentYear) {
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

function renderRankingHeading(view) {
  const title = document.getElementById("rankingTitle");
  const description = document.getElementById("rankingDescription");
  const yearlyButton = document.getElementById("showYearlyRankingButton");
  const monthlyButton = document.getElementById("showMonthlyRankingButton");
  const isMonthly = view === "monthly";
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
    : `${formatRankingQualification(row)}（規定未到達）`;
  return `<section class="ranking-self">
    <h3>${escapeHtml(title)}</h3>
    <p><strong>平均${escapeHtml(formatRankingScore(row.averageScore))}点</strong> ${escapeHtml(qualification)}</p>
    <p>${escapeHtml(row.gamesPlayed)} / ${escapeHtml(row.eligibleGames)}試合参加・参加率${escapeHtml(formatParticipationRate(row.participationRate))}</p>
  </section>`;
}

function createRankingCardHtml(row, { reference = false } = {}) {
  const user = getPredictionAccountUser();
  const isSelf = Boolean(user && ((row.username && row.username === user.username) || (row.userId && String(row.userId) === String(user.id))));
  const medal = { 1: "🥇", 2: "🥈", 3: "🥉" }[Number(row.rank)] || "";
  const rankLabel = reference ? "参考記録" : `${medal}${row.rank}位`;
  const qualification = formatRankingQualification(row, { reference });
  return `<li class="ranking-entry${reference ? " is-reference" : ""}${isSelf ? " is-self" : ""}">
    <p class="ranking-rank">${escapeHtml(rankLabel)}</p>
    <div class="ranking-entry-main">
      <div class="ranking-user-line"><strong>${escapeHtml(row.username)}${isSelf ? "（あなた）" : ""}</strong>${createRankingAchievementBadgesHtml(row)}</div>
      <p>平均 ${escapeHtml(formatRankingScore(row.averageScore))}点${reference ? "（参考）" : ""}</p>
      <p>${escapeHtml(row.gamesPlayed)} / ${escapeHtml(row.eligibleGames)}試合・参加率 ${escapeHtml(formatParticipationRate(row.participationRate))}・${escapeHtml(qualification)}</p>
      <p>合計 ${escapeHtml(row.totalScore)}点・満点 ${escapeHtml(row.perfectCount)}回</p>
    </div>
  </li>`;
}

function formatRankingQualification(row, { reference = false } = {}) {
  if (row?.isQualified && !reference) return "規定到達";
  return `あと${Math.max(0, Number(row?.gamesNeeded || 0))}試合連続参加で規定到達`;
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

function showNpbFetchFailure(candidate) {
  const code = candidate?.code || "WORKER_FETCH_FAILED";
  const display = getNpbFetchFailureDisplay(code, candidate?.message);
  state.actualPreview = null;
  state.adminStatus = "error";
  state.adminError = `[${code}] ${display.message}`;
  renderAdminFlow();
  showMessage("parserError", display.message);
  setNpbFetchMessage(display.message, "error");
  addAutoFetchLog(`スタメン取得失敗 [${code}]：${candidate?.message || display.message}`);
  console.warn("NPBスタメン取得に失敗しました。", { code, httpStatus: candidate?.httpStatus || 0 });
}

function getNpbFetchFailureDisplay(code, workerMessage) {
  const manualPasteHint = "必要に応じて、NPB公式ページの「最新のオーダー」を手動で貼り付けて入力できます。";
  const messages = {
    API_URL_MISSING: `取得サービスの設定を確認してください。${manualPasteHint}`,
    LINEUP_NOT_PUBLISHED: "スタメンはまだ発表されていません。発表後にもう一度取得してください。",
    GAME_NOT_FOUND: `対象試合を特定できませんでした。試合情報を確認してください。${manualPasteHint}`,
    NPB_HTTP_ERROR: `NPB公式ページを取得できませんでした。時間をおいて再試行してください。${manualPasteHint}`,
    WORKER_FETCH_FAILED: `取得サービスへ接続できませんでした。時間をおいて再試行してください。${manualPasteHint}`,
    CORS_ERROR: `取得サービスへ接続できませんでした。管理者はWorkerのCORS設定を確認してください。${manualPasteHint}`,
    TIMEOUT: `NPB公式ページの取得がタイムアウトしました。時間をおいて再試行してください。${manualPasteHint}`,
    INVALID_LINEUP: `取得したスタメンを確認できませんでした。${manualPasteHint}`,
    PARSE_FAILED: `NPB公式ページのスタメン解析に失敗しました。${manualPasteHint}`
  };

  return { message: messages[code] || workerMessage || `スタメン取得に失敗しました。${manualPasteHint}` };
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
  return formatPerfectAchieverOpponent(value);
}

function formatResultHistoryMatchup(game) {
  const home = formatResultHistoryTeamName(game?.homeTeam);
  const away = formatResultHistoryTeamName(game?.awayTeam);
  return home && away ? `${home} vs ${away}` : "対戦情報を確認中";
}

async function refreshResultHistory({ force = false } = {}) {
  const user = getPredictionAccountUser();
  if (!user) {
    state.resultHistory = { isLoading: false, isDetailLoading: false, games: [], selectedGameId: "", result: null, message: "ログインすると過去の試合結果を確認できます。", detailError: "" };
    renderResultHistory();
    return;
  }
  if (state.resultHistory.isLoading || (!force && state.resultHistory.games.length > 0)) return;
  const url = buildResultGamesApiUrl();
  if (!url) return;
  state.resultHistory.isLoading = true;
  state.resultHistory.detailError = "";
  state.resultHistory.message = "過去の試合結果を確認中...";
  renderResultHistory();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !Array.isArray(payload.games)) {
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    state.resultHistory.games = payload.games;
    state.resultHistory.message = payload.games.length ? "" : "採点済みの過去試合はありません。";
    const latestPublishedGame = payload.games.find((game) => game?.resultsPublished && getResultHistoryGameId(game));
    if (!state.resultHistory.selectedGameId && latestPublishedGame) {
      await loadResultHistoryGame(getResultHistoryGameId(latestPublishedGame));
    } else if (!latestPublishedGame && !state.resultHistory.selectedGameId) {
      state.resultHistory.result = null;
    }
  } catch (error) {
    state.resultHistory.games = [];
    state.resultHistory.message = "過去の試合結果を取得できませんでした。";
    console.error("過去の試合結果の取得に失敗しました", error.message);
  } finally {
    state.resultHistory.isLoading = false;
    renderResultHistory();
  }
}

async function handleResultHistoryClick(event) {
  const target = event.target instanceof Element ? event.target.closest("[data-result-game-id]") : null;
  if (!target) return;
  const gameId = target.dataset.resultGameId;
  if (!gameId) return;
  await loadResultHistoryGame(gameId);
}

async function loadResultHistoryGame(gameId) {
  state.resultHistory.selectedGameId = gameId;
  state.resultHistory.result = null;
  state.resultHistory.isDetailLoading = true;
  state.resultHistory.detailError = "";
  state.resultHistory.message = "試合結果を読み込み中...";
  renderScoreResult();
  renderResultHistory();
  try {
    const response = await fetch(buildResultGamesApiUrl(gameId), { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    if (payload.serviceUnavailable) {
      state.resultHistory.result = {
        gameId,
        serviceUnavailable: true,
        serviceUnavailableMessage: payload.serviceUnavailableMessage || "この試合はサービス未稼働のため集計対象外です。",
        prediction: payload.prediction || null,
        savedAt: payload.updatedAt || payload.submittedAt || ""
      };
      state.result = state.resultHistory.result;
      state.resultHistory.message = "";
      renderScoreResult();
      renderResultHistory();
      return;
    }
    if (!payload.resultsPublished) {
      state.result = null;
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
      publishedAt: payload.publishedAt || "",
      totalScore: payload.totalScore ?? payload.score ?? null
    };
    state.result = state.resultHistory.result;
    state.resultHistory.message = "";
    renderScoreResult();
  } catch (error) {
    state.result = null;
    state.resultHistory.result = null;
    state.resultHistory.detailError = "結果を読み込めませんでした。時間をおいて再度お試しください。";
    state.resultHistory.message = "この試合の結果を取得できませんでした。";
    console.error("過去の試合結果の読み込みに失敗しました", error.message);
  } finally {
    state.resultHistory.isDetailLoading = false;
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
  container.innerHTML = history.games.map((game) => {
    const gameId = getResultHistoryGameId(game);
    const matchup = formatResultHistoryMatchup(game);
    const score = game.serviceUnavailable
      ? "集計対象外"
      : game.resultsPublished && game.score !== null ? `${game.score}点` : "結果公開前";
    return `<button type="button" class="result-history-item${gameId === history.selectedGameId ? " is-selected" : ""}" data-result-game-id="${escapeHtml(gameId)}"><span><strong>${escapeHtml(game.gameDate || game.date || "日付不明")}</strong><span>${escapeHtml(matchup)}</span><small>${escapeHtml(game.startTime || "")}</small></span><b>${escapeHtml(score)}</b></button>`;
  }).join("") + (history.message ? `<p class="result-history-message" role="status">${escapeHtml(history.message)}</p>` : "");
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
  if (remoteState.isLoading || remoteState.isSaving || remoteState.isSubmitting || (!force && remoteState.gameId === gameId)) {
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
    remoteState.score = null;
    remoteState.maxScore = null;
    remoteState.scoredAt = "";
    remoteState.resultsPublished = false;
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
    remoteState.score = Number.isFinite(payload.score) ? Number(payload.score) : null;
    remoteState.maxScore = Number.isFinite(payload.maxScore) ? Number(payload.maxScore) : null;
    remoteState.scoredAt = payload.scoredAt || "";
    remoteState.resultsPublished = Boolean(payload.resultsPublished);
    remoteState.conflict = Boolean(remoteState.prediction && state.prediction && !predictionsMatch(remoteState.prediction, state.prediction));
    if (remoteState.prediction && !state.prediction) {
      state.prediction = { ...remoteState.prediction, lineup: normalizeLineup(remoteState.prediction.lineup) };
      state.result = null;
      saveToStorage(STORAGE_KEYS.prediction, state.prediction);
      removeFromStorage(STORAGE_KEYS.result);
      renderAll();
    }
    if (remoteState.prediction && Array.isArray(payload.actualLineup) && payload.status === "scored") {
      const actual = remotePredictionToLocal({ lineup: payload.actualLineup }, payload.scoredAt || "", gameId);
      state.result = { ...scoreLineup(remoteState.prediction.lineup, actual.lineup), gameId };
      saveToStorage(STORAGE_KEYS.result, state.result);
      renderScoreResult();
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
    const response = await fetch(url, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      // Retired request shape: body: JSON.stringify({ gameId, prediction: predictionPayload.prediction })
      body: JSON.stringify({ internalGameId: gameId, prediction: predictionPayload.prediction })
    });
    const payload = await response.json().catch(() => null);
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
  state.result = null;
  removeFromStorage(STORAGE_KEYS.result);
  state.predictionRemote.conflict = false;
  state.predictionRemote.message = "アカウントの予想を読み込みました。";
  renderAll();
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
  renderPublicGameSelectionMeta();
}

function updatePredictionSaveButton() {
  const button = document.getElementById("savePredictionButton");
  if (!button) {
    return;
  }

  const isSaving = state.predictionRemote.isSaving;
  const isSubmitting = state.predictionRemote.isSubmitting;
  button.disabled = isSaving || isSubmitting || isPredictionEditingLocked() || (!state.isAdminMode && !hasUsablePublicRosterForCurrentGame());
  button.textContent = isSaving || isSubmitting ? "保存中..." : "予想を保存する";
  button.setAttribute("aria-busy", isSaving || isSubmitting ? "true" : "false");
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
  return state.isAdminMode
    && state.autoApproval.loaded
    && state.autoApproval.enabled
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
  return Boolean(getNpbScoreRequestIdentity(value));
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

  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "npb.jp") {
    return { ok: false, message: "https://npb.jp/ の公式試合ページURLを入力してください。" };
  }

  if (!getNpbScoreRequestIdentity(parsedUrl.href)) {
    return { ok: false, message: "https://npb.jp/scores/ 配下の公式試合ページURLを入力してください。" };
  }

  return { ok: true, url: parsedUrl.href, warning: "" };
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
  if (state.predictionRemote.isSaving || state.predictionRemote.isSubmitting) {
    return;
  }
  if (!ensurePredictionEditingAllowed()) {
    return;
  }

  state.predictionRemote.isSubmitting = true;
  updatePredictionSaveButton();
  try {
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
  } finally {
    state.predictionRemote.isSubmitting = false;
    updatePredictionSaveButton();
  }
}

function resetPredictionInput() {
  if (!ensurePredictionEditingAllowed()) {
    return;
  }
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
  const normalizedPlayer = player ? normalizePlayerName(player) : "";
  const normalizedPosition = normalizedPlayer && position ? normalizePosition(position) : "";

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
    matchup: typeof gameInfo?.matchup === "string" ? gameInfo.matchup : "",
    selectedGameId: typeof gameInfo?.selectedGameId === "string" ? gameInfo.selectedGameId : "",
    manualGameSelection: gameInfo?.manualGameSelection === true,
    manualStartOverride: gameInfo?.manualStartOverride === true
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
  updateGameStartInputMode();
}

function saveAdminGameInfoFromInputs() {
  if (!state.isAdminMode || document.getElementById("legacyAdminReadOnlyNotice")) {
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
    matchup: document.getElementById("matchupInput")?.value.trim() || "",
    selectedGameId: state.nextScheduleId || state.gameInfo.selectedGameId || "",
    manualGameSelection: state.gameInfo.manualGameSelection === true,
    manualStartOverride: state.gameInfo.manualStartOverride === true
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
      return generatedUrl;
    } catch (error) {
      const message = `URL生成に必要な情報が不足しています：${error.message}`;
      console.error(message, schedule, error);
    }
  }

  const fallbackUrl = typeof schedule?.npbScoreUrl === "string" ? schedule.npbScoreUrl : "";
  return fallbackUrl;
}

function renderGameSchedulePicker() {
  const select = document.getElementById("gameScheduleSelect");
  if (!select || !state.isAdminMode) {
    return;
  }

  const currentValue = select.value;
  select.innerHTML = "";
  const schedules = getHamGameSchedule().filter(isNormalManagedSchedule);

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

  const preferredValue = state.nextScheduleId || currentValue;
  if (schedules.some((schedule) => schedule.gameId === preferredValue)) {
    select.value = preferredValue;
  } else if (schedules.some((schedule) => schedule.gameId === currentValue)) {
    select.value = currentValue;
  }

  renderNextGameScheduleSummary(findNextGameSchedule());
}

function initializeGameSchedule() {
  if (!state.isAdminMode) {
    return;
  }

  const savedGameId = state.gameInfo.selectedGameId || state.nextScheduleId;
  if (savedGameId) {
    state.nextScheduleId = savedGameId;
    renderGameSchedulePicker();
    const savedSchedule = getHamGameSchedule().find((schedule) => schedule.gameId === savedGameId);
    if (savedSchedule && isNormalManagedSchedule(savedSchedule)) {
      restoreManagedGameSchedule(savedSchedule);
      refreshAdminScoringSummary({ force: true });
      return;
    }

    updateGameStartInputMode();
    renderGameInfoDisplay();
    setScheduleLoaderMessage("保存済みの管理対象試合を表示しています。日程を再同期するまで自動変更しません。", "warning");
    return;
  }

  const nextSchedule = selectAdminTargetGame();
  renderGameSchedulePicker();
  refreshAdminScoringSummary({ force: true });

  if (nextSchedule) {
    addScheduleLoadLog(`管理対象試合を自動選択：${formatScheduleForLog(nextSchedule)}`);
  } else {
    setScheduleLoaderMessage("対象試合を取得できませんでした。次回Cronで再試行します。", "error");
    addScheduleLoadLog("管理対象試合を検出できませんでした");
    updateGameStartInputMode();
    return;
  }

  applyGameSchedule(nextSchedule, "auto");
  setScheduleLoaderMessage("日程データから対象試合と試合開始日時を自動反映しました。", "success");
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

function restoreManagedGameSchedule(schedule) {
  const scoreUrl = state.gameInfo.scoreUrl || schedule.npbScoreUrl || "";
  const matchup = state.gameInfo.matchup || schedule.matchupLabel || "";
  const gameStartAt = state.gameInfo.manualStartOverride
    ? state.gameInfo.gameStartAt
    : `${getScheduleDate(schedule)}T${getScheduleStartTime(schedule)}`;

  const matchupInput = document.getElementById("matchupInput");
  const scoreUrlInput = document.getElementById("npbUrlInput");
  const gameStartInput = document.getElementById("gameStartInput");
  if (matchupInput) matchupInput.value = matchup;
  if (scoreUrlInput) scoreUrlInput.value = scoreUrl;
  if (gameStartInput) gameStartInput.value = gameStartAt;

  state.gameInfo.selectedGameId = schedule.gameId;
  updateGameStartInputMode();
  refreshPredictionDeadlineState();
  renderLoadedScheduleInfo(schedule, scoreUrl);
  renderGameInfoDisplay();
}

function findNextGameSchedule() {
  const today = getJapanDateString();
  return getHamGameSchedule()
    .filter((schedule) => isNormalManagedSchedule(schedule) && getScheduleDate(schedule) >= today)
    .sort((left, right) => getScheduleSortValue(left).localeCompare(getScheduleSortValue(right)))[0] || null;
}

function selectAdminTargetGame() {
  const schedules = getHamGameSchedule().filter((schedule) => isNormalManagedSchedule(schedule) && !isScheduleGameUnavailable(schedule) && !isAdminScheduleCompleted(schedule));
  const manualGame = state.gameInfo.manualGameSelection
    ? schedules.find((schedule) => schedule.gameId === state.gameInfo.selectedGameId)
    : null;
  if (manualGame) return manualGame;

  const today = getJapanDateString();
  const todayGame = schedules
    .filter((schedule) => getScheduleDate(schedule) === today)
    .sort((left, right) => getScheduleSortValue(left).localeCompare(getScheduleSortValue(right)))[0];
  if (todayGame) return todayGame;

  return schedules
    .filter((schedule) => getScheduleDate(schedule) > today)
    .sort((left, right) => getScheduleSortValue(left).localeCompare(getScheduleSortValue(right)))[0] || null;
}

function isAdminScheduleCompleted(schedule) {
  return ["completed", "finished", "final"].includes(String(schedule?.status || "").toLowerCase());
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

function updateGameStartInputMode() {
  const input = document.getElementById("gameStartInput");
  const editButton = document.getElementById("editGameStartButton");
  const resetButton = document.getElementById("resetGameStartButton");
  const manual = state.gameInfo.manualStartOverride === true;
  if (input) input.readOnly = !manual;
  if (editButton) {
    editButton.disabled = manual || !state.nextScheduleId;
    editButton.classList.toggle("hidden", manual);
  }
  if (resetButton) {
    resetButton.disabled = !manual || !state.nextScheduleId;
    resetButton.classList.toggle("hidden", !manual);
  }
}

function setGameStartManualOverride(enabled) {
  if (!state.isAdminMode) return;
  const schedule = getHamGameSchedule().find((item) => item.gameId === state.nextScheduleId) || null;
  if (enabled) {
    state.gameInfo.manualStartOverride = true;
    updateGameStartInputMode();
    setScheduleLoaderMessage("試合開始日時を手動上書き中です。自動値に戻すまで日程同期では変更しません。", "warning");
    return;
  }
  state.gameInfo.manualStartOverride = false;
  if (schedule) {
    const input = document.getElementById("gameStartInput");
    if (input) input.value = `${getScheduleDate(schedule)}T${getScheduleStartTime(schedule)}`;
  }
  updateGameStartInputMode();
  saveAdminGameInfoFromInputs();
  refreshPredictionDeadlineState();
  setScheduleLoaderMessage("試合開始日時を日程データの自動値へ戻しました。", "success");
}

function loadNextGameSchedule() {
  const schedule = findNextGameSchedule();
  if (!schedule) {
    setScheduleLoaderMessage("今日以降の登録済み試合はありません。", "warning");
    return;
  }

  renderGameSchedulePicker();
  const changed = applyGameSchedule(schedule, "manual-selection");
  setScheduleLoaderMessage(changed ? `次の試合「${schedule.matchupLabel}」を読み込みました。` : "この試合は既に管理対象として選択されています。", changed ? "success" : "info");
}

function loadTodayGameSchedule() {
  const today = getLocalDateString();
  const schedule = getHamGameSchedule().find((item) => isNormalManagedSchedule(item) && getScheduleDate(item) === today);

  if (!schedule) {
    setScheduleLoaderMessage(`本日（${today}）の登録済み試合はありません。`, "warning");
    return;
  }

  const changed = applyGameSchedule(schedule, "manual-selection");
  setScheduleLoaderMessage(changed ? `今日の試合「${schedule.matchupLabel}」を読み込みました。` : "この試合は既に管理対象として選択されています。", changed ? "success" : "info");
}

function loadSelectedGameSchedule() {
  const gameId = document.getElementById("gameScheduleSelect")?.value || "";
  const schedule = getHamGameSchedule().find((item) => isNormalManagedSchedule(item) && item.gameId === gameId);

  if (!schedule) {
    setScheduleLoaderMessage("読み込む試合を選択してください。", "warning");
    return;
  }

  const changed = applyGameSchedule(schedule, "manual-selection");
  setScheduleLoaderMessage(changed ? `試合「${schedule.matchupLabel}」を読み込みました。` : "この試合は既に管理対象として選択されています。", changed ? "success" : "info");
}

function applyGameSchedule(schedule, source = "button") {
  const matchupInput = document.getElementById("matchupInput");
  const scoreUrlInput = document.getElementById("npbUrlInput");
  const gameStartInput = document.getElementById("gameStartInput");
  const scheduleSelect = document.getElementById("gameScheduleSelect");

  if (!matchupInput && !scoreUrlInput && !gameStartInput) {
    addScheduleLoadLog("試合入力欄が見つからないため反映できませんでした");
    return false;
  }

  if (!isNormalManagedSchedule(schedule)) {
    setScheduleLoaderMessage("テスト試合は通常の管理対象試合へ設定できません。", "warning");
    return false;
  }

  const previousGameId = state.gameInfo.selectedGameId || state.nextScheduleId || "";
  const targetChanged = previousGameId !== (schedule.gameId || "");
  if (!targetChanged) {
    state.nextScheduleId = schedule.gameId || previousGameId;
    renderGameSchedulePicker();
    restoreManagedGameSchedule(schedule);
    return false;
  }

  state.nextScheduleId = schedule.gameId || "";
  if (source === "manual-selection") {
    state.gameInfo.manualGameSelection = true;
  } else if (source === "auto") {
    state.gameInfo.manualGameSelection = false;
  }
  state.gameInfo.selectedGameId = state.nextScheduleId;
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
    if (!state.gameInfo.manualStartOverride) {
      gameStartInput.value = `${getScheduleDate(schedule)}T${getScheduleStartTime(schedule)}`;
    }
  } else {
    addScheduleLoadLog("試合開始日時入力欄が見つかりませんでした");
  }
  if (scheduleSelect) {
    scheduleSelect.value = schedule.gameId;
  }
  updateGameStartInputMode();
  saveAdminGameInfoFromInputs();
  refreshPredictionDeadlineState();
  renderLoadedScheduleInfo(schedule, scoreUrl);
  syncPredictionFromAccount({ force: true });
  refreshAdminScoringSummary({ force: true });
  state.manualRescore.preview = null;
  void refreshManualRescorePanel({ force: true });
  if (source === "auto") {
    addScheduleLoadLog(`自動反映した試合：${formatScheduleForLog(schedule)}`);
  } else {
    addScheduleLoadLog(`読み込み完了：${formatScheduleForLog(schedule)}`);
  }
  return true;
}

function renderLoadedScheduleInfo(schedule, scoreUrl = "") {
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
  renderPublicGameSelectionMeta();
  renderProbableStarter();
  renderSavedPrediction();
  renderPredictionCta();
  renderPredictionAccountStatus();
  renderPredictionDeadline();
  renderPredictionTargetNotice();
  renderAchievements();
  renderActualLineup();
  renderResultHistory();
  renderScoreResult();
  renderTodayPerfectAchievers();
  renderRankingPanel();
  renderAdminFlow();
  renderAdminGameProgressStatus();
  renderAdminReleaseReadiness();
  renderAdminGameIdentityRepairs();
  renderPredictionDeadlineAdmin();
  renderPicker("prediction");
  renderPicker("actual");
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
  const gameLabel = formatPublicPredictionGameLabel(selectedGame);
  meta.textContent = deadline.status === "open"
    ? `${gameLabel} ・ 予想締切: ${formatPublicJstDateTime(deadline.deadlineAt)} ・ ${savedText}`
    : `${view.status} ・ ${savedText}`;
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
  const sourceUrl = probableStarter.sourceUrl || NPB_STARTER_SOURCE_URL;
  container.className = "probable-starter-card is-success";
  container.innerHTML = `
    <div class="probable-starter-heading">
      <p class="probable-starter-label">予告先発</p>
      <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">NPB公式</a>
    </div>
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
    <p class="probable-starter-label">予告先発</p>
    <p class="probable-starter-message">${isReferenceMismatch ? "予告先発の試合参照を確認できませんでした。" : isError ? "予告先発を取得できませんでした。" : "現在、次の試合の予告先発はまだ発表されていません。"}</p>
    <p class="probable-starter-meta">${isReferenceMismatch ? "試合情報を更新して再確認します。" : isError ? "次回の自動更新で再試行します。" : "発表され次第、自動で表示されます。"}</p>
    ${isError || isReferenceMismatch ? "" : `<p class="probable-starter-meta">${escapeHtml(formatScheduledGameForLog(nextGame))}</p>`}
    ${!isError && !isReferenceMismatch && state.probableStarter.nextCheckAt ? `<p class="probable-starter-meta">次回自動確認：${escapeHtml(formatDateTime(state.probableStarter.nextCheckAt))}</p>` : ""}
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
      game_reference_mismatch: "error-message",
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

  // gameInfo is a persisted legacy admin selection. It must never label a
  // public prediction card after the canonical catalog has selected a game.
  if (!state.isAdminMode) {
    display.classList.add("hidden");
    display.textContent = "";
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

function getGameDayNoticeTargetGameId() {
  if (!state.isAdminMode) {
    return state.predictionTargetGame?.internalGameId || state.probableStarter.nextGame?.internalGameId || "";
  }
  return state.nextScheduleId || findNextGameSchedule()?.gameId || state.probableStarter.nextGame?.gameId || "";
}

function buildGameDayNoticeApiUrl(gameId) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  return baseUrl && gameId ? `${baseUrl}/api/game-day-status?gameId=${encodeURIComponent(gameId)}` : "";
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
  const gameId = getGameDayNoticeTargetGameId();
  const url = buildGameDayNoticeApiUrl(gameId);
  if (!url) return;
  if (state.gameDayNotice.isLoading && !force) return;
  state.gameDayNotice.isLoading = true;
  state.gameDayNotice.gameId = gameId;
  state.gameDayNotice.message = "";
  renderGameDayNoticeStatus();
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
    state.gameDayNotice.record = payload;
  } catch (error) {
    console.error("本日の公示状態取得に失敗しました", error.message);
    state.gameDayNotice.record = null;
    state.gameDayNotice.message = "公示情報を確認できていません。候補選手が最新でない可能性があります。";
  } finally {
    state.gameDayNotice.isLoading = false;
    renderGameDayNoticeStatus();
    renderScoreResult();
  }
}

async function fetchGameDayRosterSnapshot(internalGameId = getGameDayRosterTargetInternalGameId()) {
  const baseUrl = getAuthApiBaseUrl().replace(/\/+$/, "");
  if (!internalGameId || !baseUrl) return { ok: false, players: [] };
  try {
    const response = await fetch(`${baseUrl}/api/game-day-roster?internalGameId=${encodeURIComponent(internalGameId)}`, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !Array.isArray(payload.players)) return { ok: false, players: [] };
    return payload;
  } catch (error) {
    console.error("試合別ロースターの取得に失敗しました", error.message);
    return { ok: false, players: [] };
  }
}

function renderAdminFlow() {
  if (!state.adminStatus || state.adminStatus === "idle") {
    state.adminStatus = getAdminStatusFromActual();
  }

  renderAdminStatus();
  renderAutoApprovalSetting();
  renderActualPreview(state.actualPreview);
  updateAdminButtons();
  updateAutoFetchButtons();
  renderAdminScoringPanel();
  renderAutoScoringPanel();
  renderPregameAutomationTools();
  renderAdminGameWorkflowStatus();
  renderAdminWorkflowLogs();
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
    positionButton.draggable = shouldUseNativeDrag(pickerName) && Boolean(position) && !isLocked;
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
  const filter = state.candidateRosterFilter === "inactive" ? "inactive" : "active";
  const publicRosterReady = state.isAdminMode || hasUsablePublicRosterForCurrentGame();
  document.querySelectorAll("[data-roster-filter]").forEach((button) => {
    const isSelected = button.dataset.rosterFilter === filter;
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", isSelected ? "true" : "false");
    button.setAttribute("aria-selected", isSelected ? "true" : "false");
  });

  document.querySelectorAll('.player-chip[data-picker="prediction"]').forEach((chip) => {
    const player = getPlayerData(chip.dataset.player);
    const shouldShow = publicRosterReady && (filter === "active"
      ? isPlayerInCurrentRoster(player) && player?.isBatterCandidate === true
      : !isPlayerInCurrentRoster(player) && player?.isBatterCandidate === true);
    chip.classList.toggle("hidden", !shouldShow);
  });

  const status = document.getElementById("predictionRosterStatus");
  if (status) {
    status.textContent = publicRosterReady ? "" : "選手一覧を更新中です。しばらくしてから再度ご確認ください。";
    status.classList.toggle("hidden", publicRosterReady);
  }
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

function renderActualLineup() {
  if (state.actual) {
    setLineupValues("actual", state.actual.lineup);
  }
}

function renderScoreResult() {
  const container = document.getElementById("scoreResult");
  const shareButton = document.getElementById("shareResultButton");
  const displayedResult = state.resultHistory.result || state.result;
  renderScoreInsights(displayedResult?.comparison || null);

  if (!displayedResult) {
    container.className = "empty-state";
    if (state.resultHistory.isLoading || state.resultHistory.isDetailLoading) {
      container.textContent = "結果を読み込み中です。";
      shareButton.classList.add("hidden");
      return;
    }
    if (state.resultHistory.detailError) {
      container.textContent = state.resultHistory.detailError;
      shareButton.classList.add("hidden");
      return;
    }
    const resultStatus = state.gameDayNotice.record?.resultStatus;
    container.textContent = resultStatus === "prestart"
      ? "結果は試合開始後に公開されます。"
      : resultStatus === "preparing"
        ? "結果を準備中です。"
        : "採点すると結果が表示されます。";
    shareButton.classList.add("hidden");
    return;
  }

  if (displayedResult.serviceUnavailable) {
    container.className = "empty-state service-unavailable-result";
    container.innerHTML = `<p>${escapeHtml(displayedResult.serviceUnavailableMessage || "この試合はサービス未稼働のため集計対象外です。")}</p>`;
    if (displayedResult.prediction?.lineup) {
      container.appendChild(createPredictionSummary({
        lineup: displayedResult.prediction.lineup,
        savedAt: displayedResult.savedAt || ""
      }));
    }
    shareButton.classList.add("hidden");
    return;
  }

  container.className = "summary-box";
  container.innerHTML = "";
  const selectedGame = state.resultHistory.games.find((game) => getResultHistoryGameId(game) === displayedResult.gameId);
  const resultHeading = document.createElement("p");
  resultHeading.className = "result-selected-game";
  resultHeading.textContent = selectedGame
    ? `表示中：${selectedGame.displayLabel || `${selectedGame.gameDate || selectedGame.date || ""} ${formatResultHistoryMatchup(selectedGame)}`}`
    : "表示中の試合結果";
  container.appendChild(resultHeading);
  if (displayedResult.publishedAt) {
    const publishedAt = document.createElement("p");
    publishedAt.className = "result-selected-game";
    publishedAt.textContent = `公開：${formatPublicJstDateTime(displayedResult.publishedAt)}`;
    container.appendChild(publishedAt);
  }
  container.appendChild(createResultView(createResultViewModel(displayedResult)));
  shareButton.classList.remove("hidden");
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
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") {
    console.warn("管理者モードではないため、テスト用予想の生成を中止しました。");
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
  if (state.appMode !== "admin" || state.adminAccess.status !== "authorized") {
    console.warn("管理者モードではないため、テストデータのリセットを中止しました。");
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
    nextCheckAt: "",
    errorCode: "",
    logs: [],
    fetchedGameId: ""
  };
  state.activeOrder.prediction = 0;
  state.activeOrder.actual = 0;
  clearPointerInteraction();

  document.getElementById("predictionForm").reset();
  document.getElementById("actualPasteInput").value = "";
  renderAutoApprovalSetting();
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
