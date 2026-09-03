// 本番ではPages Function経由の同一オリジンAPIを使い、Auth WorkerのCookieを再利用します。
const V3_AUTH_PRODUCTION_BASE = "";
const adminV3Modules = window.Starting9AdminV3;

if (!adminV3Modules?.createAdminV3State
  || !adminV3Modules?.createAdminV3ApiClient
  || !adminV3Modules?.createAdminV3Coordinator
  || !adminV3Modules?.createAdminV3Dom
  || !adminV3Modules?.createAdminV3GameProgressRenderer
  || !adminV3Modules?.createAdminV3JobDetailsRenderer
  || !adminV3Modules?.createAdminV3RosterRenderer
  || !adminV3Modules?.createAdminV3DiagnosticsRenderer
  || !adminV3Modules?.createAdminV3RankingResetRenderer
  || !adminV3Modules?.createAdminV3PerfectScoreRenderer
  || !adminV3Modules?.createAdminV3ManualGamePreviewRenderer
  || !adminV3Modules?.createAdminV3ManualLineupRenderer
  || !adminV3Modules?.createAdminV3ManualRosterRenderer) {
  throw new Error("ADMIN_V3_MODULES_NOT_LOADED");
}
const v3Dom = adminV3Modules.createAdminV3Dom();
const V3_JOB_TYPE = Object.freeze({
  NPB_IDENTITY_RESOLVE: "npb_identity_resolve",
  PREDICTION_CLOSE: "prediction_close",
  PROBABLE_STARTER_FETCH: "probable_starter_fetch",
  ROSTER_FETCH: "roster_fetch",
  LINEUP_FETCH: "lineup_fetch",
  LINEUP_FINALIZE: "lineup_finalize",
  SCORE: "score",
  RANKING_REBUILD: "ranking_rebuild",
  PUBLISH: "publish"
});
const V3_JOB_TYPES = Object.freeze([
  V3_JOB_TYPE.NPB_IDENTITY_RESOLVE,
  V3_JOB_TYPE.PREDICTION_CLOSE,
  V3_JOB_TYPE.LINEUP_FETCH,
  V3_JOB_TYPE.LINEUP_FINALIZE,
  V3_JOB_TYPE.SCORE,
  V3_JOB_TYPE.RANKING_REBUILD,
  V3_JOB_TYPE.PUBLISH,
  V3_JOB_TYPE.PROBABLE_STARTER_FETCH,
  V3_JOB_TYPE.ROSTER_FETCH
]);
const V3_VIEWS = ["dashboard", "games", "workflow", "lineup", "roster", "scoring", "ranking-reset", "schedule", "add-game-preview", "diagnostics"];
const V3_VIEW_LABELS = {
  dashboard: "ダッシュボード",
  games: "試合一覧",
  workflow: "試合進行",
  lineup: "スタメン",
  roster: "ロースター管理",
  scoring: "採点・ランキング",
  "ranking-reset": "ランキング対象外",
  schedule: "日程管理",
  diagnostics: "診断・監査",
  "add-game-preview": "追加試合プレビュー"
};
const V3_JOB_LABELS = {
  npb_identity_resolve: "NPB識別情報解決",
  prediction_close: "予想締切",
  lineup_fetch: "スタメン取得",
  lineup_finalize: "正式スタメン確定",
  score: "採点",
  ranking_rebuild: "ランキング反映",
  publish: "結果公開",
  probable_starter_fetch: "予告先発取得",
  roster_fetch: "ロースター取得"
};

// The entrypoint owns screen-specific rendering. State, authenticated requests, and
// event coordination live in focused classic-script modules loaded by admin-v3.html.
const v3State = adminV3Modules.createAdminV3State();
const v3Api = adminV3Modules.createAdminV3ApiClient({
  fetchImpl: window.fetch.bind(window),
  location: window.location,
  productionBase: V3_AUTH_PRODUCTION_BASE
});

function manualOperationKey(internalGameId, jobType) {
  return `${String(internalGameId || "")}:${String(jobType || "")}`;
}

function manualOperation(internalGameId, jobType) {
  return v3State.manualOperations.get(manualOperationKey(internalGameId, jobType)) || null;
}

function configureAdminLoginLink() {
  const link = document.getElementById("adminLoginLink");
  if (!link) return;
  const returnTo = `${window.location.pathname || "/admin-v3.html"}${window.location.search || ""}${window.location.hash || ""}`;
  const loginUrl = new URL("index.html", window.location.href);
  loginUrl.searchParams.set("auth", "login");
  loginUrl.searchParams.set("returnTo", returnTo);
  link.href = `${loginUrl.pathname}${loginUrl.search}`;
}

function adminAuthErrorMessage(error) {
  const status = Number(error?.status);
  if (status === 401 || error?.code === "AUTH_REQUIRED") {
    return "ログインが必要です。ログイン画面から認証すると、この管理画面へ戻れます。";
  }
  if (status === 403 || error?.code === "ADMIN_ROLE_REQUIRED") {
    return "ログイン中のアカウントに管理者権限がありません。";
  }
  if (status === 503 || error?.code === "D1_READ_LIMIT_EXCEEDED" || error?.code === "DB_UNAVAILABLE") {
    return "認証サービスが一時的に利用できません。時間をおいて再試行してください。";
  }
  if (error?.message && !String(error.message).includes("Failed to fetch")) {
    return "管理画面を読み込めませんでした。入力内容またはサーバー状態を確認してください。";
  }
  return "認証APIへ接続できません。通信状況を確認して再試行してください。";
}

function formatV3AdminError(error, fallbackCode) {
  const code = error?.code || fallbackCode;
  const status = Number(error?.status);
  if ([401, 403, 503].includes(status)
    || ["AUTH_REQUIRED", "ADMIN_ROLE_REQUIRED", "D1_READ_LIMIT_EXCEEDED", "DB_UNAVAILABLE"].includes(error?.code)
    || !status) {
    return `${code}: ${adminAuthErrorMessage(error)}`;
  }
  return `${code}: 管理操作に失敗しました。入力内容とサーバー状態を確認してください。`;
}

function setManualOperation(internalGameId, jobType, value) {
  v3State.manualOperations.set(manualOperationKey(internalGameId, jobType), value);
  renderCurrentV3View();
}

async function diagnoseV3Job(internalGameId, jobType) {
  const previous = manualOperation(internalGameId, jobType) || {};
  setManualOperation(internalGameId, jobType, { ...previous, status: "loading", error: false, message: "診断中…" });
  try {
    const diagnosis = await v3Api.diagnoseJob(internalGameId, jobType);
    const message = diagnosis.canRun
      ? `実行可能 / 現在state: ${diagnosis.currentWorkflowState || "-"}`
      : `実行不可 / ${diagnosis.cannotRunReason || "理由不明"}`;
    setManualOperation(internalGameId, jobType, { status: "ready", diagnosis, error: false, message });
  } catch (error) {
    setManualOperation(internalGameId, jobType, { status: "error", error: true, message: formatV3AdminError(error, "V3_JOB_DIAGNOSE_FAILED") });
  }
}

async function runV3Job(internalGameId, jobType) {
  const label = V3_JOB_LABELS[jobType] || jobType;
  const dangerous = new Set(["prediction_close", "lineup_finalize", "score", "ranking_rebuild", "publish"]);
  const confirmation = dangerous.has(jobType)
    ? `この操作は「${label}」として試合状態を進めます。採点・ランキング・公開に影響する可能性があります。本当に実行しますか？`
    : `V3正式job「${label}」を再実行キューへ投入します。実行しますか？`;
  if (!window.confirm(confirmation)) return;
  const reason = window.prompt("操作理由を入力してください（1〜240文字）", `admin-v3: ${label} の手動再実行`);
  if (!String(reason || "").trim()) return;
  const previous = manualOperation(internalGameId, jobType) || {};
  setManualOperation(internalGameId, jobType, { ...previous, status: "loading", error: false, message: "正式V3 jobを投入中…" });
  try {
    const result = await v3Api.runJob(internalGameId, { jobType, reason: String(reason).trim(), confirmed: true });
    setManualOperation(internalGameId, jobType, { status: "success", error: false, diagnosis: result.diagnosis, message: result.created ? `job #${result.job?.id || "-"} を投入しました。状態を再取得しました。` : `同じslotのjobが既に存在します（#${result.job?.id || "-"}）。` });
    await loadV3();
  } catch (error) {
    setManualOperation(internalGameId, jobType, { status: "error", error: true, message: formatV3AdminError(error, "V3_JOB_RUN_FAILED") });
  }
}

async function reconcileV3State(internalGameId) {
  if (!window.confirm("成果物を確認できた場合だけworkflow stateを1段階再同期します。公開済み試合は読み取り専用です。実行しますか？")) return;
  const reason = window.prompt("状態再同期の理由を入力してください（1〜240文字）", "admin-v3: completed jobと成果物の整合性確認");
  if (!String(reason || "").trim()) return;
  const previous = manualOperation(internalGameId, "state_reconcile") || {};
  setManualOperation(internalGameId, "state_reconcile", { ...previous, status: "loading", error: false, message: "成果物を確認して状態を再同期中…" });
  try {
    const result = await v3Api.reconcileState(internalGameId, { reason: String(reason).trim(), confirmed: true });
    setManualOperation(internalGameId, "state_reconcile", { status: "success", error: false, message: `${result.stateBefore} → ${result.stateAfter} を再同期しました。` });
    await loadV3();
  } catch (error) {
    setManualOperation(internalGameId, "state_reconcile", { status: "error", error: true, message: formatV3AdminError(error, "V3_STATE_RECONCILE_FAILED") });
  }
}

async function saveV3Schedule(internalGameId) {
  const form = [...document.querySelectorAll("[data-v3-schedule-form]")]
    .find((element) => element.dataset.v3ScheduleForm === String(internalGameId || ""));
  if (!form) return;
  const startAt = form.querySelector("[data-v3-schedule-start]")?.value || "";
  const status = form.querySelector("[data-v3-schedule-status]")?.value || "scheduled";
  const reasonField = form.querySelector("[data-v3-schedule-reason]");
  const reason = reasonField?.value?.trim() || window.prompt("日程変更理由を入力してください（1〜240文字）", "admin-v3: 日程状態・開始時刻を更新");
  if (!String(reason || "").trim()) return;
  const confirmed = form.querySelector("[data-v3-schedule-confirm]")?.checked === true;
  const confirmationText = form.querySelector("[data-v3-schedule-confirmation-text]")?.value?.trim() || "";
  const rankingConfirmationText = form.querySelector("[data-v3-schedule-ranking-confirmation-text]")?.value?.trim() || "";
  const previous = manualOperation(internalGameId, "schedule") || {};
  setManualOperation(internalGameId, "schedule", { ...previous, status: "loading", error: false, message: "日程を更新中…" });
  try {
    const result = await v3Api.updateSchedule(internalGameId, { startAt, status, reason: String(reason).trim(), confirmed, confirmationText, rankingConfirmationText });
    setManualOperation(internalGameId, "schedule", { status: "success", error: false, message: `${result.stateBefore || "-"} → ${result.stateAfter || result.stateBefore || "-"} / 日程を更新しました。` });
    await loadV3();
  } catch (error) {
    setManualOperation(internalGameId, "schedule", { status: "error", error: true, message: formatV3AdminError(error, "V3_SCHEDULE_UPDATE_FAILED") });
  }
}

async function requestV3GameCancellation(internalGameId) {
  const form = [...document.querySelectorAll("[data-v3-schedule-form]")]
    .find((element) => element.dataset.v3ScheduleForm === String(internalGameId || ""));
  if (!form) return;
  if (!window.confirm("この試合を中止にします。予想・採点・ランキングの対象外となり、未実行のV3 jobを停止します。続行しますか？")) return;

  const reasonField = form.querySelector("[data-v3-schedule-reason]");
  if (!reasonField?.value?.trim()) {
    const reason = window.prompt("中止理由を入力してください（1〜240文字）", "NPB公式発表による試合中止");
    if (!String(reason || "").trim()) return;
    reasonField.value = String(reason).trim();
  }
  const confirmationField = form.querySelector("[data-v3-schedule-confirmation-text]");
  if (confirmationField && !confirmationField.value.trim()) {
    const confirmation = window.prompt("正式処理済み試合のため「中止」と入力してください。", "中止");
    if (String(confirmation || "").trim() !== "中止") return;
    confirmationField.value = String(confirmation).trim();
  }
  const rankingConfirmationField = form.querySelector("[data-v3-schedule-ranking-confirmation-text]");
  if (rankingConfirmationField && !rankingConfirmationField.value.trim()) {
    const confirmation = window.prompt("ランキング取消を確認するため「ランキング取消」と入力してください。", "ランキング取消");
    if (String(confirmation || "").trim() !== "ランキング取消") return;
    rankingConfirmationField.value = String(confirmation).trim();
  }
  const statusField = form.querySelector("[data-v3-schedule-status]");
  if (statusField) statusField.value = "cancelled";
  const confirmField = form.querySelector("[data-v3-schedule-confirm]");
  if (confirmField) confirmField.checked = true;
  await saveV3Schedule(internalGameId);
}

async function excludeV3GameFromRanking(internalGameId) {
  const form = [...document.querySelectorAll("[data-v3-ranking-exclusion-form]")]
    .find((element) => element.dataset.v3RankingExclusionForm === String(internalGameId || ""));
  if (!form) return;
  const reason = form.querySelector("[data-v3-ranking-exclusion-reason]")?.value?.trim() || "";
  const confirmed = form.querySelector("[data-v3-ranking-exclusion-confirm]")?.checked === true;
  const rankingConfirmationText = form.querySelector("[data-v3-ranking-exclusion-confirmation-text]")?.value?.trim() || "";
  const schedule = selectedDetails()?.schedule?.schedule?.operation || {};
  const rankingRevocationConfirmationRequired = form.dataset.v3RankingRevocationRequired === "true"
    || schedule.rankingRevocationConfirmationRequired === true;
  if (!reason || !confirmed || (rankingRevocationConfirmationRequired && rankingConfirmationText !== "ランキング取消")) {
    setV3Status("ランキング対象外の理由を入力し、確認にチェックしてください。", true);
    return;
  }
  if (!window.confirm("この試合をランキング対象外にします。保存済み予想と監査履歴は保持されます。続行しますか？")) return;
  try {
    await v3Api.updateRankingEligibility(internalGameId, { status: "excluded", reason, confirmed, rankingConfirmationText });
    await loadV3();
  } catch (error) {
    setV3Status(formatV3AdminError(error, "RANKING_ELIGIBILITY_UPDATE_FAILED"), true);
  }
}

// Compatibility alias for focused tests and future incremental extraction.
function v3Fetch(path, options = {}) {
  return v3Api.request(path, options);
}

function setV3Status(message, isError = false) {
  const element = document.getElementById("v3Status");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("error", isError);
}

const escapeV3 = v3Dom.escapeHtml;

function normalizeV3List(value, key = "items") {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return { items: [], unexpected: true };
    }
  }
  if (Array.isArray(candidate)) return { items: candidate, unexpected: false };
  if (candidate === undefined || candidate === null) return { items: [], unexpected: false };
  if (typeof candidate !== "object") return { items: [], unexpected: true };

  const wrapped = candidate[key] ?? candidate.items ?? candidate.results ?? candidate.data;
  if (wrapped === undefined || wrapped === null) return { items: [], unexpected: true };
  return normalizeV3List(wrapped, key);
}

function v3ListItems(value, key = "items") {
  return normalizeV3List(value, key).items;
}

function normalizeV3RevisionList(value) {
  return normalizeV3List(value, "revisions");
}

function v3StorageGet(key) {
  try { return window.sessionStorage.getItem(key) || ""; } catch { return ""; }
}

function v3StorageSet(key, value) {
  try { window.sessionStorage.setItem(key, value); } catch { /* storage is optional */ }
}

function v3DateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function v3JstDate(date = new Date()) {
  const parts = v3DateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function v3ShiftDate(dateValue, days) {
  const date = new Date(`${String(dateValue || "").slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const formatV3Jst = v3Dom.formatJst;

function identityStatusLabel(status, state) {
  if (state === "pending") return "掲載待ち";
  if (state === "retry_wait") return "取得待ち";
  if (state === "manual_action_required") return "確認が必要";
  return { resolved: "自動解決済み", unresolved: "確認が必要", manually_overridden: "管理者上書き" }[String(status || "unresolved")] || "未解決";
}

function statusLabel(status) {
  return ({ completed: "完了", pending: "予定", claimed: "実行中", retry_wait: "retry_wait", failed: "失敗", cancelled: "対象外" }[String(status || "")] || "待機中");
}

function statusClass(status) {
  return ({ completed: "complete", pending: "scheduled", claimed: "running", retry_wait: "retry", failed: "failed", cancelled: "excluded" }[String(status || "")] || "wait");
}

function latestV3Job(game, jobType) {
  return v3ListItems(game?.jobs, "jobs").filter((job) => job.job_type === jobType).sort((left, right) => {
    return String(right.updated_at || right.scheduled_at || "").localeCompare(String(left.updated_at || left.scheduled_at || ""));
  })[0] || null;
}

function latestV3Jobs(game, types) {
  return types.map((type) => latestV3Job(game, type)).filter(Boolean);
}

function npbIdentityDisplay(game) {
  const job = latestV3Job(game, "npb_identity_resolve");
  const code = String(game?.npbGameCode || game?.npb_game_code || "").trim();
  const identityState = String(game?.npbIdentityState || "");
  const diagnostics = game?.workflowDiagnostics?.identity;
  return {
    job,
    jobStatus: diagnostics?.completedWithoutCode || (job?.status === "completed" && !code)
      ? "完了扱い / code未解決"
      : diagnostics?.blocking && !code
        ? "未解決 / code未解決"
        : job ? statusLabel(job.status) : identityState === "pending" ? "待機中" : "未作成",
    code: code || "掲載待ち"
  };
}

function gameHasAttention(game) {
  if (String(game?.state?.state || "") === "manual_action_required") return true;
  if (["unresolved", "manual_action_required"].includes(String(game?.npbIdentityState || ""))) return true;
  const diagnostics = game?.workflowDiagnostics || {};
  if (diagnostics.predictionClose?.overdue || diagnostics.predictionClose?.stateMismatch) return true;
  if (diagnostics.completedStateMismatches?.length) return true;
  if (diagnostics.artifactBlockingReasons?.length) return true;
  if (diagnostics.identity?.blocking || diagnostics.lineupFetch?.blockingReasons?.length) return true;
  return currentFailedV3Jobs(game).length > 0
    || currentRetryWaitV3Jobs(game).length > 0;
}

function gameDateForFilter(game) {
  return String(game?.gameDate || game?.game_date || v3JstDate(game?.startAt || game?.start_time)).slice(0, 10);
}

function filteredV3Games(games, filter) {
  const today = v3JstDate();
  const tomorrow = v3ShiftDate(today, 1);
  return v3ListItems(games, "games").filter((game) => {
    const date = gameDateForFilter(game);
    if (filter === "today") return date === today;
    if (filter === "tomorrow") return date === tomorrow;
    if (filter === "future") return date > today;
    if (filter === "past") return date < today;
    return true;
  });
}

function selectedV3Game(games) {
  const items = v3ListItems(games, "games");
  const found = items.find((game) => game.internalGameId === v3State.selectedGameId);
  return found || items[0] || null;
}

function selectedV3Details() {
  return v3State.operationDetails.get(v3State.selectedGameId) || {};
}

function manualLineupRowsFromRevision(revision) {
  const lineup = Array.isArray(revision?.lineup) ? revision.lineup : [];
  return Array.from({ length: 9 }, (_, index) => {
    const expectedOrder = index + 1;
    const entry = lineup.find((row) => Number(row?.battingOrder ?? row?.order) === expectedOrder) || lineup[index] || {};
    return {
      battingOrder: Number(entry.battingOrder ?? entry.order) || expectedOrder,
      position: String(entry.position || ""),
      playerId: String(entry.playerId || ""),
      playerName: String(entry.playerName || entry.displayName || ""),
      uniformNumber: entry.uniformNumber === null || entry.uniformNumber === undefined ? "" : String(entry.uniformNumber),
      search: ""
    };
  });
}

function manualLineupHasInput(state) {
  return Boolean(state?.reason)
    || (state?.rows || []).some((row) => row?.playerId || row?.playerName || row?.position || row?.search);
}

function ensureV3ManualLineupState(internalGameId, details = null) {
  const id = String(internalGameId || "");
  const sameGame = v3State.manualLineup.gameId === id && v3State.manualLineup.rows.length === 9;
  if (sameGame && details?.lineup && !v3State.manualLineup.detailsHydrated && !manualLineupHasInput(v3State.manualLineup)) {
    const revision = details.lineup.currentRevision || details.lineup.finalRevision || null;
    v3State.manualLineup = {
      ...v3State.manualLineup,
      rows: revision ? manualLineupRowsFromRevision(revision) : v3State.manualLineup.rows,
      reason: revision?.reason || v3State.manualLineup.reason,
      latestRevision: revision || v3State.manualLineup.latestRevision,
      detailsHydrated: true
    };
  }
  if (sameGame) return v3State.manualLineup;
  v3State.manualLineup = {
    ...v3State.manualLineup,
    gameId: id,
    rows: v3ManualLineupRenderer.createBlankRows(),
    reason: "",
    confirmed: false,
    latestRevision: null,
    detailsHydrated: Boolean(details?.lineup),
    loading: false,
    error: "",
    message: ""
  };
  if (details?.lineup) {
    const revision = details.lineup.currentRevision || details.lineup.finalRevision || null;
    v3State.manualLineup = {
      ...v3State.manualLineup,
      rows: revision ? manualLineupRowsFromRevision(revision) : v3State.manualLineup.rows,
      reason: revision?.reason || "",
      latestRevision: revision,
      detailsHydrated: true
    };
  }
  return v3State.manualLineup;
}

function v3DetailPath(suffix) {
  return `/api/admin/v3/games/${encodeURIComponent(v3State.selectedGameId)}${suffix}`;
}


function updateV3Hash(view = v3State.view, gameId = v3State.selectedGameId) {
  const query = gameId ? `?game=${encodeURIComponent(gameId)}` : "";
  const nextHash = `#${view}${query}`;
  if (window.location.hash !== nextHash) window.history.replaceState(null, "", nextHash);
}

function readV3Hash() {
  const raw = window.location.hash.replace(/^#/, "");
  const [viewPart, queryPart = ""] = raw.split("?");
  const view = V3_VIEWS.includes(viewPart) ? viewPart : "dashboard";
  const params = new URLSearchParams(queryPart);
  const gameId = params.get("game") || v3StorageGet("starting9.admin-v3.selected-game");
  return { view, gameId };
}


const renderSummaryCard = v3Dom.renderSummaryCard;

function nextV3Job(game) {
  return v3ListItems(game?.jobs, "jobs").filter((job) => ["pending", "claimed", "retry_wait"].includes(job.status)).sort((left, right) => String(left.scheduled_at || "").localeCompare(String(right.scheduled_at || "")))[0] || null;
}

function nextV3ActionText(game) {
  const schedule = game?.schedule || {};
  const diagnostics = game?.workflowDiagnostics || {};
  const workflowState = String(game?.state?.state || game?.workflowState || game?.workflow_state || "").trim().toLowerCase();
  if (workflowState === "published") return "公開済み";
  if (diagnostics.completedStateMismatches?.length) return "completed後の状態再同期 / 要確認";
  if (diagnostics.artifactBlockingReasons?.length) return "成果物未反映 / 正式V3操作が必要";
  if (schedule.isBlocked && schedule.nextActionLabel) return `${schedule.nextActionLabel} / 要確認`;
  if (diagnostics.lineupFetch?.blockingReason && diagnostics.predictionClose?.deadlineElapsed) {
    return `${schedule.nextActionLabel || "スタメン取得"} / 要確認`;
  }
  if (schedule.nextActionLabel) return `${schedule.nextActionLabel}${schedule.nextActionAt ? ` ${formatV3Jst(schedule.nextActionAt)}` : ""}`;
  const next = nextV3Job(game);
  return next ? `${V3_JOB_LABELS[next.job_type] || next.job_type} ${formatV3Jst(next.scheduled_at)}` : "なし";
}

const TODAY_OPS_STATUS_LABELS = Object.freeze({ ok: "OK", waiting: "WAITING", attention: "ATTENTION" });

function todayOpsStatusClass(status) {
  return status === "attention" ? "attention" : status === "ok" ? "ok" : "waiting";
}

function todayOpsStatusBadge(status) {
  const normalized = todayOpsStatusClass(status);
  return `<span class="today-ops-status ${normalized}">${TODAY_OPS_STATUS_LABELS[normalized]}</span>`;
}

function rosterDisplaySlots(game, slots) {
  const values = Array.isArray(slots) ? slots : [];
  const startAt = new Date(game?.startAt || game?.start_at || game?.startTime || game?.start_time || "");
  if (Number.isNaN(startAt.getTime())) return values;
  return values.filter((slot) => {
    const slotAt = new Date(slot || "");
    return Number.isNaN(slotAt.getTime()) || slotAt.getTime() < startAt.getTime();
  });
}

function v3JobTimestamp(job) {
  const value = job?.updated_at || job?.completed_at || job?.scheduled_at || "";
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function hasNewerV3Job(game, candidateJob, statuses = null) {
  const candidateTimestamp = v3JobTimestamp(candidateJob);
  return v3ListItems(game?.jobs, "jobs").some((job) => job !== candidateJob
    && job.job_type === candidateJob?.job_type
    && (!statuses || statuses.includes(String(job.status || "")))
    && v3JobTimestamp(job) >= candidateTimestamp);
}

function isNoOpRankingRevisionJob(game, job) {
  return String(job?.job_type || "") === "ranking_rebuild"
    && String(job?.failure_code || "") === "V3_SCORING_REVISION_REQUIRED"
    && Boolean(game?.scoringSummary?.noOpReason || game?.rankingSummary?.noOpReason);
}

function currentFailedV3Jobs(game, types = []) {
  return v3ListItems(game?.jobs, "jobs").filter((job) => String(job.status || "") === "failed"
    && (!types.length || types.includes(String(job.job_type || "")))
    && !isNoOpRankingRevisionJob(game, job)
    && !hasNewerV3Job(game, job));
}

function currentRetryWaitV3Jobs(game, types = []) {
  return v3ListItems(game?.jobs, "jobs").filter((job) => String(job.status || "") === "retry_wait"
    && (!types.length || types.includes(String(job.job_type || "")))
    && !isNoOpRankingRevisionJob(game, job)
    && !hasNewerV3Job(game, job));
}

function rosterDecisionDetail(diagnostics, nextSlot) {
  const reasonCode = String(diagnostics?.reasonCode || "");
  const next = diagnostics?.nextCheckAt || nextSlot;
  const nextText = next ? `次回確認: ${formatV3Jst(next)}` : "";
  if (reasonCode === "ROSTER_SNAPSHOT_MISSING_BEFORE_DUE") return ["取得予定", reasonCode, nextText, "現時点では当日公示未確認"].filter(Boolean).join(" / ");
  if (reasonCode === "ROSTER_SNAPSHOT_STALE_REFETCH_SCHEDULED") return ["再取得予定", reasonCode, nextText].filter(Boolean).join(" / ");
  if (reasonCode === "ROSTER_FETCH_PENDING") return ["取得中", reasonCode, nextText].filter(Boolean).join(" / ");
  if (reasonCode === "ROSTER_FETCH_RETRY_WAIT") return ["再試行待ち", reasonCode, nextText].filter(Boolean).join(" / ");
  if (reasonCode === "ROSTER_SNAPSHOT_MISSING_AFTER_DUE") return ["要確認", reasonCode, "期限到達後に取得jobとsnapshotがありません"].join(" / ");
  if (reasonCode === "ROSTER_SNAPSHOT_STALE_AFTER_DUE") return ["要確認", reasonCode, "期限到達後も当日snapshotがありません"].join(" / ");
  if (["ROSTER_NO_CHANGES", "ROSTER_CHANGES_CAPTURED"].includes(reasonCode)) return diagnostics?.label || (reasonCode === "ROSTER_CHANGES_CAPTURED" ? "公示確認済み（変更あり）" : "公示確認済み");
  return [diagnostics?.label, reasonCode, nextText].filter(Boolean).join(" / ");
}

function normalizedV3PhaseState(game, phase) {
  const status = game?.phaseStatuses?.[phase];
  if (!status || !["OK", "WAITING", "ATTENTION"].includes(String(status.severity || "").toUpperCase())) return null;
  const severity = String(status.severity).toUpperCase();
  const state = severity === "OK" ? "ok" : severity === "ATTENTION" ? "attention" : "waiting";
  const detail = status.message || [status.label, status.reasonCode, status.nextCheckAt ? `次回確認: ${formatV3Jst(status.nextCheckAt)}` : ""].filter(Boolean).join(" / ");
  return {
    status: state,
    fallbackStatus: state === "ok" ? "complete" : state === "attention" ? "action" : "wait",
    label: status.label || "待機",
    reasonCode: status.reasonCode || "",
    nextCheckAt: status.nextCheckAt || null,
    nextSlot: status.nextCheckAt || null,
    detail,
    normalizedStatus: status
  };
}

function rosterDisplayState(game) {
  const normalized = normalizedV3PhaseState(game, "roster");
  if (normalized) return normalized;
  const diagnostics = game?.rosterDiagnostics || {};
  const now = new Date();
  const nextSlot = rosterDisplaySlots(game, game?.schedule?.rosterFetchSlots)
    .map((slot) => new Date(slot || ""))
    .filter((slot) => !Number.isNaN(slot.getTime()) && slot.getTime() > now.getTime())
    .sort((left, right) => left.getTime() - right.getTime())[0]?.toISOString() || null;
  const jobs = v3ListItems(game?.jobs, "jobs").filter((job) => String(job.job_type || "") === "roster_fetch");
  const byRecent = (left, right) => String(right.updated_at || right.completed_at || right.scheduled_at || "")
    .localeCompare(String(left.updated_at || left.completed_at || left.scheduled_at || ""));
  const decisionSeverity = String(diagnostics.severity || "").toUpperCase();
  if (["OK", "WAITING", "ATTENTION"].includes(decisionSeverity)) {
    const status = decisionSeverity === "OK" ? "ok" : decisionSeverity === "ATTENTION" ? "attention" : "waiting";
    const currentJob = [...jobs].filter((job) => ["pending", "claimed", "retry_wait", "failed"].includes(String(job.status || ""))).sort(byRecent)[0] || null;
    return {
      status,
      fallbackStatus: status === "ok" ? "complete" : status === "attention" ? "action" : "wait",
      job: currentJob,
      nextSlot: diagnostics.nextCheckAt || nextSlot,
      detail: rosterDecisionDetail(diagnostics, nextSlot)
    };
  }
  const failedJob = [...jobs].filter((job) => String(job.status || "") === "failed").sort(byRecent)[0] || null;
  if (failedJob) return { status: "attention", fallbackStatus: "action", job: failedJob, nextSlot, detail: failedJob.failure_code || "ロースター取得に失敗しました。" };
  const retryJob = [...jobs].filter((job) => String(job.status || "") === "retry_wait").sort(byRecent)[0] || null;
  if (retryJob) return { status: "waiting", fallbackStatus: "wait", job: retryJob, nextSlot, detail: retryJob.failure_code || "次回の公式公示確認を待っています。" };
  const openJob = [...jobs].filter((job) => ["pending", "claimed"].includes(String(job.status || ""))).sort(byRecent)[0] || null;
  if (openJob) return { status: "waiting", fallbackStatus: "wait", job: openJob, nextSlot, detail: "公式公示の取得処理を待っています。" };
  if (diagnostics.isSnapshotStale === true) {
    return { status: "attention", fallbackStatus: "action", job: null, nextSlot, detail: diagnostics.staleReason || "ROSTER_SNAPSHOT_STALE" };
  }
  if (diagnostics.rosterSnapshotExists === true && diagnostics.isSnapshotFresh !== false) {
    const completedJob = [...jobs].filter((job) => String(job.status || "") === "completed").sort(byRecent)[0] || null;
    return {
      status: "ok",
      fallbackStatus: "complete",
      job: completedJob,
      nextSlot: null,
      detail: diagnostics.noticeState === "ROSTER_CHANGES_CAPTURED"
        ? "公式公示の変更を記録しました。"
        : "公式公示を確認しました。変更はありません。"
    };
  }
  return {
    status: "waiting",
    fallbackStatus: "wait",
    job: null,
    nextSlot,
    detail: nextSlot ? `公式公示の取得予定: ${formatV3Jst(nextSlot)}` : "公式公示の取得予定を確認しています。"
  };
}

function lineupReasonCode(job, game) {
  const raw = String(job?.failure_code || job?.error_code || job?.reason_code || game?.lineupSummary?.errorCode || "").trim().toUpperCase();
  if (["LINEUP_NOT_ANNOUNCED", "LINEUP_NOT_PUBLISHED", "LINEUP_DATA_NOT_ANNOUNCED", "DATA_NOT_ANNOUNCED", "UNANNOUNCED"].includes(raw)) return "LINEUP_NOT_ANNOUNCED";
  return raw;
}

function lineupFailureDiagnostics(job) {
  if (job?.diagnostics && typeof job.diagnostics === "object") return job.diagnostics;
  const message = String(job?.failure_message || job?.failureMessage || "");
  const marker = message.indexOf("[diagnostics=");
  if (marker < 0) return {};
  const json = message.slice(marker + "[diagnostics=".length).replace(/\]\s*$/, "");
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function lineupDiagnosticText(diagnostics) {
  const fields = [
    ["exceptionName", diagnostics?.exceptionName],
    ["exceptionMessage", diagnostics?.exceptionMessage],
    ["stage", diagnostics?.executorStage],
    ["sourceUrl", diagnostics?.sourceUrl],
    ["HTTP", diagnostics?.httpStatus],
    ["slot", diagnostics?.selectedSlot]
  ];
  return fields
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    .map(([label, value]) => `${label}: ${value}`)
    .join(" / ");
}

function classifyLineupReason(reasonCode) {
  const code = String(reasonCode || "").toUpperCase();
  if (code === "LINEUP_NOT_ANNOUNCED") return "unannounced";
  if (["NPB_GAME_CODE_NOT_AVAILABLE", "NPB_IDENTITY_UNRESOLVED"].includes(code)) return "identity_pending";
  if (/HTTP|NETWORK|TEMPORARY|TIMEOUT|FETCH_FAILED/.test(code)) return "temporary_error";
  if (/PARSE|INVALID|INCOMPLETE|TEAM_MISMATCH|PLAYER_ID|INTEGRITY|CONFLICT/.test(code)) return "data_error";
  if (/MISSING_EXECUTOR|MISSING_HELPER|UNEXPECTED|V3_JOB_FAILED/.test(code)) return "system_error";
  return code ? "system_error" : "unknown";
}

function lineupDisplayState(game, now = new Date()) {
  const normalized = normalizedV3PhaseState(game, "lineup_fetch");
  if (normalized) return normalized;
  const state = String(game?.state?.state || "scheduled");
  if (["lineup_ready", "scored", "ranked", "published"].includes(state)) {
    return { status: "ok", fallbackStatus: "complete", label: "完了", job: null, reasonCode: "", nextCheckAt: null, detail: "正式スタメン確定済み" };
  }
  const jobs = v3ListItems(game?.jobs, "jobs")
    .filter((job) => ["lineup_fetch", "provisional_lineup_fetch", "final_lineup_fetch"].includes(String(job.job_type || "")))
    .sort((left, right) => String(right.updated_at || right.completed_at || right.scheduled_at || "")
      .localeCompare(String(left.updated_at || left.completed_at || left.scheduled_at || "")));
  const job = jobs[0] || null;
  const reasonCode = lineupReasonCode(job, game);
  const classification = classifyLineupReason(reasonCode);
  const diagnostics = lineupFailureDiagnostics(job);
  const diagnosticText = lineupDiagnosticText(diagnostics);
  const jobStatusLabel = ({ pending: "予定", claimed: "実行中", retry_wait: "retry_wait", completed: "完了", failed: "失敗" })[String(job?.status || "")] || "待機中";
  const slots = Array.isArray(game?.schedule?.lineupPollingSlots) ? game.schedule.lineupPollingSlots : [];
  let nextCheckAt = slots.map((slot) => new Date(slot || ""))
    .filter((slot) => !Number.isNaN(slot.getTime()) && slot.getTime() > now.getTime())
    .sort((left, right) => left.getTime() - right.getTime())[0]?.toISOString() || null;
  if (!nextCheckAt && job?.status === "retry_wait" && classification !== "data_error") {
    nextCheckAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  }
  const nextText = nextCheckAt ? formatV3Jst(nextCheckAt) : "なし";

  if (job?.status === "completed") {
    const artifactStatus = game?.workflowDiagnostics?.lineupFetch?.artifactStatus;
    const artifactUnavailable = artifactStatus && artifactStatus.available === false;
    const artifactUnverified = artifactStatus && artifactStatus.available === true && artifactStatus.artifactVerified !== true;
    if (game?.workflowDiagnostics?.lineupFetch?.completedWithoutCandidate || artifactUnavailable || artifactUnverified) {
      return {
        status: "attention",
        fallbackStatus: "action",
        label: artifactUnavailable ? "成果物未検証" : "候補なしの完了扱い",
        job,
        reasonCode: artifactUnavailable ? "V3_LINEUP_DATA_HEALTH_UNAVAILABLE" : "LINEUP_FETCH_COMPLETED_WITHOUT_CANDIDATE",
        nextCheckAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        detail: artifactUnavailable
          ? "lineup_fetchはcompletedですが成果物ヘルスを確認できません。再診断が必要です。"
          : "lineup_fetchはcompletedですが有効なcandidate/canonical lineupがありません。再取得が必要です。"
      };
    }
    return { status: "ok", fallbackStatus: "complete", label: "完了", job, reasonCode, nextCheckAt: null, detail: "スタメン候補取得済み" };
  }
  if (job?.status === "retry_wait") {
    if (classification === "unannounced") {
      return { status: "waiting", fallbackStatus: "wait", label: "スタメン未発表", job, reasonCode, nextCheckAt, detail: `状態: 次回確認待ち / 次回確認: ${nextText} / reason: ${reasonCode}` };
    }
    if (classification === "temporary_error") {
      return { status: "waiting", fallbackStatus: "wait", label: "一時取得失敗", job, reasonCode, nextCheckAt, detail: `状態: 次回再試行 / 次回確認: ${nextText} / reason: ${reasonCode}` };
    }
    if (classification === "identity_pending") {
      return { status: "waiting", fallbackStatus: "wait", label: "NPB識別情報待ち", job, reasonCode, nextCheckAt, diagnostics, detail: `状態: 次回確認待ち / 次回確認: ${nextText} / reason: ${reasonCode}` };
    }
    return { status: "attention", fallbackStatus: "action", label: classification === "data_error" ? "スタメン取得異常" : "システム異常", job, reasonCode: reasonCode || "V3_JOB_FAILED", nextCheckAt, diagnostics, detail: `状態: 要確認 / reason: ${reasonCode || "V3_JOB_FAILED"}${diagnosticText ? ` / ${diagnosticText}` : ""}` };
  }
  if (["failed", "permanently_failed"].includes(String(job?.status || ""))) {
    return { status: "attention", fallbackStatus: "action", label: classification === "data_error" ? "スタメン取得異常" : "システム異常", job, reasonCode: reasonCode || "V3_JOB_FAILED", nextCheckAt: null, diagnostics, detail: `状態: 要確認 / reason: ${reasonCode || "V3_JOB_FAILED"}${diagnosticText ? ` / ${diagnosticText}` : ""}` };
  }
  if (job) {
    return { status: "waiting", fallbackStatus: "wait", label: "取得待ち", job, reasonCode, nextCheckAt, detail: `状態: ${jobStatusLabel}${nextCheckAt ? ` / 次回確認: ${nextText}` : ""}${reasonCode ? ` / reason: ${reasonCode}` : ""}` };
  }
  if (nextCheckAt) {
    return { status: "waiting", fallbackStatus: "wait", label: "次回確認待ち", job: null, reasonCode: "LINEUP_NOT_YET_AVAILABLE", nextCheckAt, detail: `状態: 次回確認待ち / 次回確認: ${nextText} / reason: LINEUP_NOT_YET_AVAILABLE` };
  }
  return { status: "attention", fallbackStatus: "action", label: "要確認", job: null, reasonCode: "LINEUP_NOT_ANNOUNCED", nextCheckAt: null, detail: "全polling slot経過後もスタメン未取得 / reason: LINEUP_NOT_ANNOUNCED" };
}

async function loadV3JobDetail(internalGameId, jobId, force = false) {
  const key = v3JobDetailsRenderer.key(internalGameId, jobId);
  if (v3State.jobDetailsLoading.has(key)) return;
  if (!force && v3State.jobDetails.has(key)) return;
  const numericJobId = Number(jobId);
  const selected = v3ListItems(v3State.payload?.games, "games").find((game) => game.internalGameId === internalGameId);
  const listedJob = selected?.jobs?.find((job) => Number(job.id) === numericJobId);
  if (!selected || !Number.isInteger(numericJobId) || numericJobId <= 0 || !listedJob) {
    v3State.jobDetails.set(key, { error: "V3_JOB_DETAIL_INVALID_TARGET" });
    renderCurrentV3View();
    return;
  }
  v3State.jobDetailsLoading.add(key);
  v3State.jobDetails.delete(key);
  renderCurrentV3View();
  try {
    const detail = await v3Api.getJobDetail(internalGameId, numericJobId);
    if (detail.internalGameId !== internalGameId || Number(detail.job?.id) !== numericJobId) throw new Error("V3_JOB_DETAIL_ID_MISMATCH");
    v3State.jobDetails.set(key, detail);
  } catch (error) {
    v3State.jobDetails.set(key, { error: formatV3AdminError(error, "V3_JOB_DETAIL_FAILED") });
  } finally {
    v3State.jobDetailsLoading.delete(key);
    renderCurrentV3View();
  }
}

function rankingResetLocalToIso(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withSeconds = raw.length === 16 ? `${raw}:00` : raw;
  const date = new Date(`${withSeconds}+09:00`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

const v3JobDetailsRenderer = adminV3Modules.createAdminV3JobDetailsRenderer({
  state: v3State,
  document,
  navigator: window.navigator || {},
  escapeHtml: escapeV3,
  formatJst: formatV3Jst,
  statusLabel,
  jobLabels: V3_JOB_LABELS,
  latestJobs: latestV3Jobs
});
const v3RosterRenderer = adminV3Modules.createAdminV3RosterRenderer({
  escapeHtml: escapeV3,
  formatJst: formatV3Jst,
  formatTimelineTime: v3Dom.formatTimelineTime,
  rosterDisplaySlots,
  rosterDisplayState,
  statusLabel
});
const v3PerfectScoreRenderer = adminV3Modules.createAdminV3PerfectScoreRenderer({ state: v3State, escapeHtml: escapeV3 });
const v3RankingResetRenderer = adminV3Modules.createAdminV3RankingResetRenderer({ state: v3State, escapeHtml: escapeV3, formatJst: formatV3Jst });
const v3ManualGamePreviewRenderer = adminV3Modules.createAdminV3ManualGamePreviewRenderer({ escapeHtml: escapeV3 });
const v3ManualLineupRenderer = adminV3Modules.createAdminV3ManualLineupRenderer({ escapeHtml: escapeV3 });
const v3ManualRosterRenderer = adminV3Modules.createAdminV3ManualRosterRenderer({ escapeHtml: escapeV3 });
const v3DiagnosticsRenderer = adminV3Modules.createAdminV3DiagnosticsRenderer({
  state: v3State,
  escapeHtml: escapeV3,
  formatJst: formatV3Jst,
  listItems: v3ListItems,
  filterGames: filteredV3Games,
  jstDate: v3JstDate,
  gameDateForFilter,
  currentFailedJobs: currentFailedV3Jobs,
  currentRetryWaitJobs: currentRetryWaitV3Jobs,
  normalizedPhaseState: normalizedV3PhaseState,
  rosterDisplayState,
  lineupDisplayState,
  nextActionText: nextV3ActionText,
  renderSelectedGameHeader: v3Dom.renderSelectedGameHeader,
  renderJobRows: (...args) => v3JobDetailsRenderer.renderRows(...args),
  latestJob: latestV3Job,
  jobTypes: V3_JOB_TYPES,
  statusLabel,
  identityStatusLabel
});
const v3GameProgressRenderer = adminV3Modules.createAdminV3GameProgressRenderer({
  escapeHtml: escapeV3,
  formatJst: formatV3Jst,
  formatTimelineTime: v3Dom.formatTimelineTime,
  renderSummaryCard,
  renderSelectedGameHeader: v3Dom.renderSelectedGameHeader,
  statusLabel,
  statusClass,
  identityStatusLabel,
  npbIdentityDisplay,
  gameHasAttention,
  gameDateForFilter,
  nextActionText: nextV3ActionText,
  latestJob: latestV3Job,
  normalizedPhaseState: normalizedV3PhaseState,
  rosterDisplaySlots,
  rosterDisplayState,
  lineupDisplayState,
  rosterTimelineDetails: v3RosterRenderer.timelineDetails,
  renderRosterSummary: v3RosterRenderer.renderSummary,
  renderJobRows: (...args) => v3JobDetailsRenderer.renderRows(...args),
  renderTodayOps: v3DiagnosticsRenderer.renderTodayOps,
  renderPerfectScorePreview: v3PerfectScoreRenderer.render,
  listItems: v3ListItems,
  filterGames: filteredV3Games,
  normalizeRevisionList: normalizeV3RevisionList,
  selectedDetails: selectedV3Details,
  selectedGame: (games) => selectedV3Game(games),
  jstDate: v3JstDate,
  jobTypes: V3_JOB_TYPES,
  jobLabels: V3_JOB_LABELS,
  manualOperation,
  renderManualLineup: (game, details) => v3ManualLineupRenderer.render(game, details, ensureV3ManualLineupState(game?.internalGameId, details))
});

function updateV3ManualLineupRow(index, patch) {
  const state = ensureV3ManualLineupState(v3State.selectedGameId);
  if (!state.rows[index]) return;
  state.rows[index] = { ...state.rows[index], ...patch };
  state.error = "";
  state.message = "";
  renderCurrentV3View();
  if (Object.prototype.hasOwnProperty.call(patch, "search")) {
    const field = document.querySelector(`[data-v3-manual-lineup-search="${Number(index)}"]`);
    if (field) {
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }
}

function updateV3ManualLineupSearch(index, value) {
  const state = ensureV3ManualLineupState(v3State.selectedGameId);
  const row = state.rows[Number(index)];
  if (!row) return;
  row.search = String(value ?? "");
  state.error = "";
  state.message = "";
  const details = v3State.operationDetails.get(v3State.selectedGameId) || {};
  const catalog = details.lineup?.playerCatalog || [];
  const candidates = document.querySelector(`[data-v3-manual-lineup-candidates="${Number(index)}"]`);
  if (candidates) candidates.innerHTML = v3ManualLineupRenderer.renderCandidates(catalog, row, Number(index));
}

function selectV3ManualLineupPlayer(index, playerId) {
  const catalog = v3State.operationDetails.get(v3State.selectedGameId)?.lineup?.playerCatalog || [];
  const player = catalog.find((candidate) => candidate.playerId === playerId);
  if (!player) return;
  updateV3ManualLineupRow(index, {
    playerId: player.playerId,
    playerName: player.playerName,
    uniformNumber: player.uniformNumber,
    search: ""
  });
}

function manualLineupPayload(state) {
  return {
    confirmed: state.confirmed === true,
    reason: String(state.reason || "").trim(),
    lineup: state.rows.map((row) => ({
      battingOrder: Number(row.battingOrder),
      position: row.position,
      playerName: row.playerName,
      uniformNumber: row.uniformNumber,
      playerId: row.playerId
    }))
  };
}

async function saveV3ManualLineup() {
  const state = ensureV3ManualLineupState(v3State.selectedGameId);
  if (!state.reason || !state.confirmed) {
    state.error = "入力理由を入力し、内容確認にチェックしてください。";
    renderCurrentV3View();
    return;
  }
  state.loading = true;
  state.error = "";
  state.message = "手動スタメンを保存中…";
  renderCurrentV3View();
  try {
    const result = await v3Api.saveManualLineup(v3State.selectedGameId, manualLineupPayload(state));
    state.latestRevision = result.revision || null;
    state.message = state.latestRevision ? `revision ${state.latestRevision.revisionId || state.latestRevision.version || "-"} を保存しました。` : "手動スタメンを保存しました。";
  } catch (error) {
    state.error = formatV3AdminError(error, "V3_MANUAL_LINEUP_SAVE_FAILED");
  } finally {
    state.loading = false;
    renderCurrentV3View();
  }
}

async function finalizeV3ManualLineup() {
  const state = ensureV3ManualLineupState(v3State.selectedGameId);
  if (!state.latestRevision || !state.confirmed) {
    state.error = "先に下書きを保存し、入力内容を確認してください。";
    renderCurrentV3View();
    return;
  }
  if (!window.confirm("この9人を正式スタメンとして確定します。確定後は採点対象となり、次回の正式V3 Cronが後続処理を行います。続行しますか？")) return;
  state.loading = true;
  state.error = "";
  state.message = "正式スタメンを確定中…";
  renderCurrentV3View();
  try {
    await v3Api.finalizeManualLineup(v3State.selectedGameId, {
      lineupRevisionId: state.latestRevision.revisionId,
      version: state.latestRevision.version,
      reason: state.reason,
      confirmed: true
    });
    state.message = "正式スタメンを確定しました。採点は正式V3 Cronへ引き継ぎます。";
    await loadV3OperationDetails();
  } catch (error) {
    state.error = formatV3AdminError(error, "V3_MANUAL_LINEUP_FINALIZE_FAILED");
  } finally {
    state.loading = false;
    renderCurrentV3View();
  }
}

function updateManualRosterSearch(value) {
  v3State.manualRoster.search = String(value ?? "");
  v3State.manualRoster.error = "";
  const candidates = document.querySelector("[data-v3-manual-roster-candidates]");
  if (candidates) candidates.innerHTML = v3ManualRosterRenderer.renderCandidates(v3State.manualRoster);
}

function updateManualRosterEntry(playerId, patch) {
  const entry = v3State.manualRoster.entries.find((item) => item.playerId === playerId);
  if (!entry) return;
  Object.assign(entry, patch);
  v3State.manualRoster.error = "";
  v3State.manualRoster.message = "";
  renderCurrentV3View();
}

function addManualRosterPlayer(playerId) {
  const catalogPlayer = v3State.manualRoster.catalog.find((player) => player.playerId === playerId);
  if (!catalogPlayer) return;
  const existing = v3State.manualRoster.entries.find((entry) => entry.playerId === playerId);
  if (existing) existing.status = "active";
  else v3State.manualRoster.entries.push({ playerId, status: "active", note: "" });
  v3State.manualRoster.error = "";
  v3State.manualRoster.message = "";
  renderCurrentV3View();
}

async function loadManualRoster(force = false) {
  const roster = v3State.manualRoster;
  if (roster.loading || (roster.loaded && !force)) return;
  roster.loading = true;
  roster.error = "";
  renderCurrentV3View();
  try {
    const result = await v3Api.getManualRoster(roster.teamCode);
    const serverRoster = result.roster || {};
    roster.entries = Array.isArray(serverRoster.entries) ? serverRoster.entries.map((entry) => ({ playerId: entry.playerId, status: entry.status, note: entry.note || "" })) : [];
    roster.catalog = Array.isArray(result.playerCatalog) ? result.playerCatalog : [];
    roster.schemaAvailable = serverRoster.schemaAvailable !== false;
    roster.updatedAt = serverRoster.updatedAt || null;
    roster.updatedBy = serverRoster.updatedBy || null;
    roster.loaded = true;
  } catch (error) {
    roster.error = formatV3AdminError(error, "MANUAL_ROSTER_READ_FAILED");
    roster.schemaAvailable = error.status !== 503;
  } finally {
    roster.loading = false;
    renderCurrentV3View();
  }
}

async function saveManualRoster() {
  const roster = v3State.manualRoster;
  if (!roster.confirmed) { roster.error = "内容を確認してから保存してください。"; renderCurrentV3View(); return; }
  roster.loading = true;
  roster.error = "";
  roster.message = "ロースターを保存中…";
  renderCurrentV3View();
  try {
    const result = await v3Api.saveManualRoster({ teamCode: roster.teamCode, entries: roster.entries, confirmed: true });
    const saved = result.roster || {};
    roster.entries = Array.isArray(saved.entries) ? saved.entries.map((entry) => ({ playerId: entry.playerId, status: entry.status, note: entry.note || "" })) : roster.entries;
    roster.updatedAt = saved.updatedAt || roster.updatedAt;
    roster.updatedBy = saved.updatedBy || roster.updatedBy;
    roster.message = "manual rosterを保存しました。スタメンは別画面で入力・確定します。";
  } catch (error) {
    roster.error = formatV3AdminError(error, "MANUAL_ROSTER_SAVE_FAILED");
  } finally {
    roster.loading = false;
    renderCurrentV3View();
  }
}

function renderCurrentV3View() {
  const payload = v3State.payload;
  if (!payload) return;
  const allGames = v3ListItems(payload.games, "games");
  const games = filteredV3Games(allGames, v3State.filter);
  const game = selectedV3Game(allGames);
  const filteredGame = selectedV3Game(games);
  if (game && v3State.selectedGameId !== game.internalGameId) {
    v3State.selectedGameId = game.internalGameId;
    v3StorageSet("starting9.admin-v3.selected-game", game.internalGameId);
    updateV3Hash(v3State.view, game.internalGameId);
  }
  const view = document.getElementById("v3View");
  if (!view) return;
  const v4Notice = payload.automationMode?.isV4SemiAuto
    ? '<div class="v3-operation-result attention" data-v3-v4-mode><strong>V4半自動運営</strong><span>予告先発: 自動取得 / ロースター: Fightersロースターを手動管理 / スタメン: 自動取得OFF / 正式スタメン: 手動</span><span>ロースター更新はスタメンを変更しません。ロースター管理とスタメン確定をそれぞれ確認後、予想締切・採点・ランキング・公開を正式Cronへ引き継ぎます。</span></div>'
    : "";
  const externalFetchNotice = payload.npbFetchDisabled
    ? '<div class="v3-operation-result attention" data-v3-external-fetch-disabled><strong>NPB公式情報の取得を一時停止しています。</strong><span>新規の予告先発・ロースター・スタメン取得は停止中です。既存の保存済みデータと履歴は保持されます。</span></div>'
    : "";
  view.innerHTML = v4Notice + externalFetchNotice + {
    dashboard: () => v3GameProgressRenderer.renderDashboard(payload, games),
    games: () => v3GameProgressRenderer.renderGamesView(games),
    workflow: () => v3GameProgressRenderer.renderWorkflowView(filteredGame || game),
    lineup: () => v3GameProgressRenderer.renderLineupView(filteredGame || game),
    roster: () => v3ManualRosterRenderer.render(v3State.manualRoster),
    scoring: () => v3GameProgressRenderer.renderScoringView(filteredGame || game),
    "ranking-reset": () => v3RankingResetRenderer.render(),
    schedule: () => v3GameProgressRenderer.renderScheduleView(games),
    "add-game-preview": () => v3ManualGamePreviewRenderer.render(v3State.manualGamePreview),
    diagnostics: () => v3DiagnosticsRenderer.renderView(filteredGame || game)
  }[v3State.view]();
  document.querySelectorAll("[data-v3-view]").forEach((button) => {
    const active = button.dataset.v3View === v3State.view;
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  const select = document.getElementById("v3GameSelect");
  if (select) {
    select.innerHTML = games.map((item) => `<option value="${escapeV3(item.internalGameId)}">${escapeV3(gameDateForFilter(item))} ${escapeV3(item.homeTeam)} vs ${escapeV3(item.awayTeam)}</option>`).join("") || "<option value=\"\">対象試合なし</option>";
    select.value = games.some((item) => item.internalGameId === v3State.selectedGameId) ? v3State.selectedGameId : "";
  }
  const filter = document.getElementById("v3GameFilter");
  if (filter) filter.value = v3State.filter;
  const panel = document.getElementById("v3Schema");
  if (panel) panel.textContent = `schema: ${payload.schema?.ready ? "ready" : "unavailable"} / mode: ${payload.automationMode?.mode || "v3_auto"} / 予告先発: ${payload.automationMode?.autoProbableStarter ? "自動" : "停止"} / roster自動: ${payload.automationMode?.autoRosterFetch ? "自動" : "停止"} / lineup自動: ${payload.automationMode?.autoLineupFetch ? "自動" : "停止"} / 手動スタメン: ${payload.automationMode?.isV4SemiAuto ? "利用可" : "-"} / NPB取得: ${payload.npbFetchDisabled ? "停止中" : "有効"} / 最終更新: ${formatV3Jst(v3State.lastUpdatedAt)}`;
}

async function loadRankingResetMarkers(force = false) {
  const reset = v3State.rankingReset;
  if (reset.loading || (reset.loaded && !force)) return;
  reset.loading = true;
  reset.error = "";
  renderCurrentV3View();
  try {
    const result = await v3Api.listRankingResets();
    reset.markers = Array.isArray(result.markers) ? result.markers : [];
    reset.loaded = true;
  } catch (error) {
    reset.error = formatV3AdminError(error, "RANKING_RESET_READ_FAILED");
  } finally {
    reset.loading = false;
    renderCurrentV3View();
  }
}

async function loadRankingExclusionGames(force = false) {
  const reset = v3State.rankingReset;
  if (reset.gamesLoading || (reset.gamesLoaded && !force)) return;
  reset.gamesLoading = true;
  reset.gamesError = "";
  renderCurrentV3View();
  try {
    const result = await v3Api.listRankingExclusionGames({ scope: "past", search: "", limit: 30 });
    reset.games = Array.isArray(result.games) ? result.games : [];
    reset.gamesLoaded = true;
  } catch (error) {
    reset.games = [];
    reset.gamesError = formatV3AdminError(error, "RANKING_EXCLUSION_GAMES_READ_FAILED");
  } finally {
    reset.gamesLoading = false;
    renderCurrentV3View();
  }
}

function renderRankingExclusionGames() {
  if (v3State.view === "ranking-reset") renderCurrentV3View();
}

function rankingResetRequestBody(includeConfirmation = false) {
  const reset = v3State.rankingReset;
  const body = {
    periodType: reset.periodType,
    periodKey: reset.periodKey,
    resetAt: rankingResetLocalToIso(reset.resetAtLocal),
    reason: reset.reason
  };
  if (includeConfirmation) body.confirmation = reset.confirmation;
  return body;
}

async function previewRankingReset() {
  const reset = v3State.rankingReset;
  if (reset.loading) return;
  reset.loading = true;
  reset.error = "";
  renderCurrentV3View();
  try {
    const result = await v3Api.previewRankingReset(rankingResetRequestBody());
    reset.preview = result.preview || null;
    reset.activeMarker = result.activeMarker || null;
  } catch (error) {
    reset.preview = null;
    reset.error = formatV3AdminError(error, "RANKING_RESET_PREVIEW_FAILED");
  } finally {
    reset.loading = false;
    renderCurrentV3View();
  }
}

async function executeRankingReset() {
  const reset = v3State.rankingReset;
  if (reset.loading || !reset.preview) return;
  reset.loading = true;
  reset.error = "";
  renderCurrentV3View();
  try {
    const result = await v3Api.executeRankingReset(rankingResetRequestBody(true));
    reset.preview = result.preview || reset.preview;
    reset.activeMarker = result.marker || null;
    reset.markers = [result.marker, ...reset.markers.filter((marker) => marker.id !== result.marker?.id)].filter(Boolean);
    reset.confirmation = "";
  } catch (error) {
    reset.error = formatV3AdminError(error, "RANKING_RESET_EXECUTE_FAILED");
  } finally {
    reset.loading = false;
    renderCurrentV3View();
  }
}

async function previewPerfectScore() {
  const game = selectedV3Game(v3ListItems(v3State.payload?.games, "games"));
  if (!game || v3State.perfectScorePreview.loading) return;
  const reason = v3State.perfectScorePreview.reason.trim();
  if (!reason) {
    v3State.perfectScorePreview = { ...v3State.perfectScorePreview, internalGameId: game.internalGameId, error: "確認理由を入力してください。" };
    renderCurrentV3View();
    return;
  }
  v3State.perfectScorePreview = { internalGameId: game.internalGameId, reason, loading: true, result: null, error: "" };
  renderCurrentV3View();
  try {
    v3State.perfectScorePreview.result = await v3Api.previewPerfectScore({
      internalGameId: game.internalGameId,
      reason
    });
  } catch (error) {
    v3State.perfectScorePreview.error = formatV3AdminError(error, "PERFECT_SCORE_PREVIEW_FAILED");
  } finally {
    v3State.perfectScorePreview.loading = false;
    renderCurrentV3View();
  }
}

function manualGamePreviewInput() {
  const form = document.querySelector("[data-v3-manual-game-preview-form]");
  const value = (field) => form?.querySelector(`[data-v3-manual-game-field="${field}"]`)?.value || "";
  return {
    gameDate: value("gameDate"),
    startAt: value("startAt"),
    homeTeam: value("homeTeam"),
    awayTeam: value("awayTeam"),
    venue: value("venue"),
    npbGameCode: value("npbGameCode") || null,
    rankingEligible: Boolean(form?.querySelector('[data-v3-manual-game-field="rankingEligible"]')?.checked),
    reason: value("reason"),
    confirmPreview: Boolean(form?.querySelector('[data-v3-manual-game-field="confirmPreview"]')?.checked)
  };
}

async function previewManualGame() {
  const input = manualGamePreviewInput();
  const preview = v3State.manualGamePreview;
  if (preview.loading) return;
  v3State.manualGamePreview = { loading: true, result: null, error: "", input };
  renderCurrentV3View();
  try {
    v3State.manualGamePreview.result = await v3Api.previewManualGame(input);
  } catch (error) {
    v3State.manualGamePreview.error = formatV3AdminError(error, "MANUAL_GAME_PREVIEW_FAILED");
  } finally {
    v3State.manualGamePreview.loading = false;
    renderCurrentV3View();
  }
}

function renderV3(payload) {
  const games = normalizeV3List(payload?.games, "games");
  v3State.payload = { ...(payload || {}), games: games.items, gamesShapeUnexpected: games.unexpected };
  v3State.lastUpdatedAt = new Date();
  renderCurrentV3View();
  if (v3State.view === "ranking-reset") {
    loadRankingResetMarkers();
    loadRankingExclusionGames();
  }
}

async function loadV3OperationDetails() {
  const id = v3State.selectedGameId;
  if (!id) return;
  const paths = {
    lineup: v3DetailPath("/lineup"),
    revisions: v3DetailPath("/lineup-revisions"),
    ranking: v3DetailPath("/ranking"),
    publication: v3DetailPath("/publication"),
    eligibility: v3DetailPath("/ranking-eligibility"),
    schedule: v3DetailPath("/schedule")
  };
  const entries = await Promise.all(Object.entries(paths).map(async ([key, path]) => {
    try { return [key, await v3Api.getGameOperationDetail(id, path.replace(`/api/admin/v3/games/${encodeURIComponent(id)}`, ""))]; }
    catch (error) { return [key, { ok: false, errorCode: error.code, error: formatV3AdminError(error, "V3_OPERATION_DETAIL_FAILED") }]; }
  }));
  v3State.operationDetails.set(id, Object.fromEntries(entries));
  renderCurrentV3View();
}

async function loadV3() {
  setV3Status("読み込み中…");
  try {
    const session = await v3Api.getSession();
    if (!session.admin) throw new Error("管理者権限がありません。");
    const payload = await v3Api.getOverview();
    payload.automationLogs = await v3Api.getAutomationLogs().catch((error) => ({ error: formatV3AdminError(error, "V3_AUTOMATION_LOG_FAILED") }));
    v3State.automationLogs = payload.automationLogs;
    renderV3(payload);
    await loadV3OperationDetails();
    if (v3State.view === "roster") await loadManualRoster();
    setV3Status(`${v3State.payload.games.length}試合を表示しました。`);
  } catch (error) {
    setV3Status(adminAuthErrorMessage(error), true);
  }
}

function chooseV3View(view) {
  if (!V3_VIEWS.includes(view)) return;
  v3State.view = view;
  updateV3Hash(view, v3State.selectedGameId);
  renderCurrentV3View();
  if (view === "ranking-reset") {
    loadRankingResetMarkers();
    loadRankingExclusionGames();
  }
  if (view === "roster") loadManualRoster();
  document.getElementById("v3Navigation")?.classList.remove("open");
  document.getElementById("mobileNavToggle")?.setAttribute("aria-expanded", "false");
}

async function refreshAutomationLogs() {
  document.querySelectorAll("[data-v3-automation-log-filter]").forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(v3State.automationLogFilters, field.dataset.v3AutomationLogFilter)) {
      v3State.automationLogFilters[field.dataset.v3AutomationLogFilter] = field.value.trim();
    }
  });
  v3State.automationLogs = await v3Api.getAutomationLogs(v3State.automationLogFilters)
    .catch((error) => ({ error: formatV3AdminError(error, "V3_AUTOMATION_LOG_FAILED") }));
  renderCurrentV3View();
}

async function selectV3Game(internalGameId, view = "workflow") {
  v3State.selectedGameId = internalGameId || "";
  v3StorageSet("starting9.admin-v3.selected-game", v3State.selectedGameId);
  chooseV3View(view);
  await loadV3OperationDetails();
}

async function copyV3JobDetail(jobCopyButton) {
  const internalGameId = jobCopyButton.dataset.v3JobCopyGame || "";
  const jobId = jobCopyButton.dataset.v3JobCopyId || "";
  const key = v3JobDetailsRenderer.key(internalGameId, jobId);
  const detail = v3State.jobDetails.get(key);
  const value = v3JobDetailsRenderer.copyValue(jobCopyButton.dataset.v3JobCopy, internalGameId, detail);
  const status = jobCopyButton.closest(".job-detail-inline")?.querySelector(".job-copy-status");
  try {
    await v3JobDetailsRenderer.copyTextSafely(value);
    v3State.jobDetailsCopyStatus.set(key, "コピーしました");
    if (status) status.textContent = "コピーしました";
  } catch {
    v3State.jobDetailsCopyStatus.set(key, "コピーできませんでした");
    if (status) status.textContent = "コピーできませんでした";
  }
}

async function toggleV3JobDetail(internalGameId, jobId) {
  const key = v3JobDetailsRenderer.key(internalGameId, jobId);
  if (v3State.jobDetailsOpen.has(key)) {
    v3State.jobDetailsOpen.delete(key);
    renderCurrentV3View();
    return;
  }
  v3State.jobDetailsOpen.add(key);
  renderCurrentV3View();
  await loadV3JobDetail(internalGameId, jobId);
}

function handleV3HashChange() {
  const hash = readV3Hash();
  v3State.view = hash.view;
  if (hash.gameId) v3State.selectedGameId = hash.gameId;
  renderCurrentV3View();
  loadV3OperationDetails();
  if (v3State.view === "roster") loadManualRoster();
}

function restoreInitialV3Route() {
  const initialV3Hash = readV3Hash();
  v3State.view = initialV3Hash.view;
  v3State.selectedGameId = initialV3Hash.gameId;
}

configureAdminLoginLink();

adminV3Modules.createAdminV3Coordinator({
  document,
  window,
  state: v3State,
  actions: {
    load: loadV3,
    chooseView: chooseV3View,
    previewRankingReset,
    executeRankingReset,
    refreshRankingExclusionGames: loadRankingExclusionGames,
    renderRankingExclusionGames,
    previewPerfectScore,
    previewManualGame,
    updateManualLineupRow: updateV3ManualLineupRow,
    updateManualLineupSearch: updateV3ManualLineupSearch,
    selectManualLineupPlayer: selectV3ManualLineupPlayer,
    saveManualLineup: saveV3ManualLineup,
    finalizeManualLineup: finalizeV3ManualLineup,
    updateManualRosterSearch,
    updateManualRosterEntry,
    addManualRosterPlayer,
    saveManualRoster,
    refreshAutomationLogs,
    selectGame: (internalGameId) => selectV3Game(internalGameId),
    diagnoseJob: diagnoseV3Job,
    runJob: runV3Job,
    reconcileState: reconcileV3State,
    saveSchedule: saveV3Schedule,
    cancelGame: requestV3GameCancellation,
    excludeFromRanking: excludeV3GameFromRanking,
    copyJobDetail: copyV3JobDetail,
    refreshJobDetail: (internalGameId, jobId) => loadV3JobDetail(internalGameId, jobId, true),
    toggleJobDetail: toggleV3JobDetail,
    changeFilter: (filter) => { v3State.filter = filter; renderCurrentV3View(); },
    selectGameFromToolbar: (internalGameId) => selectV3Game(internalGameId, v3State.view),
    handleHashChange: handleV3HashChange,
    restoreInitialRoute: restoreInitialV3Route
  }
}).start();
