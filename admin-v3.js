const V3_AUTH_PRODUCTION_BASE = "https://starting9-auth.tanzana7.workers.dev";
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
const V3_VIEWS = ["dashboard", "games", "workflow", "lineup", "scoring", "schedule", "emergency", "diagnostics"];
const V3_VIEW_LABELS = {
  dashboard: "ダッシュボード",
  games: "試合一覧",
  workflow: "試合進行",
  lineup: "スタメン",
  scoring: "採点・ランキング",
  schedule: "日程管理",
  emergency: "緊急操作",
  diagnostics: "診断・監査"
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

const v3State = {
  payload: null,
  view: "dashboard",
  filter: "all",
  selectedGameId: "",
  lastUpdatedAt: null,
  identityDiagnostics: new Map(),
  operationDetails: new Map(),
  jobDetails: new Map(),
  jobDetailsOpen: new Set(),
  jobDetailsLoading: new Set(),
  jobDetailsCopyStatus: new Map(),
  rescorePreview: null,
  busy: new Set()
};

function v3ApiBase() {
  return ["localhost", "127.0.0.1"].includes(window.location.hostname) ? "http://127.0.0.1:8787" : V3_AUTH_PRODUCTION_BASE;
}

async function v3Fetch(path, options = {}) {
  const response = await fetch(`${v3ApiBase()}${path}`, {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.code = body.code || "V3_ADMIN_REQUEST_FAILED";
    error.status = response.status;
    error.details = body.resolutionDiagnostics || body.diagnostics || null;
    error.identityState = body.identityState || null;
    throw error;
  }
  return body;
}

function setV3Status(message, isError = false) {
  const element = document.getElementById("v3Status");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function escapeV3(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
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

function formatV3Jst(value, includeDate = true) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "-";
  const options = { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false };
  if (includeDate) Object.assign(options, { year: "numeric", month: "2-digit", day: "2-digit" });
  return new Intl.DateTimeFormat("ja-JP", options).format(date).replace(/年|月/g, "/").replace("日", "");
}

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
  return [...(game?.jobs || [])].filter((job) => job.job_type === jobType).sort((left, right) => {
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
  return {
    job,
    jobStatus: job ? statusLabel(job.status) : identityState === "pending" ? "待機中" : "未作成",
    code: code || "掲載待ち"
  };
}

function gameHasAttention(game) {
  if (String(game?.state?.state || "") === "manual_action_required") return true;
  if (["unresolved", "manual_action_required"].includes(String(game?.npbIdentityState || ""))) return true;
  return (game?.jobs || []).some((job) => ["failed", "retry_wait"].includes(String(job.status)));
}

function gameDateForFilter(game) {
  return String(game?.gameDate || game?.game_date || v3JstDate(game?.startAt || game?.start_time)).slice(0, 10);
}

function filteredV3Games(games, filter) {
  const today = v3JstDate();
  const tomorrow = v3ShiftDate(today, 1);
  return (games || []).filter((game) => {
    const date = gameDateForFilter(game);
    if (filter === "today") return date === today;
    if (filter === "tomorrow") return date === tomorrow;
    if (filter === "future") return date > today;
    if (filter === "past") return date < today;
    return true;
  });
}

function selectedV3Game(games) {
  const found = (games || []).find((game) => game.internalGameId === v3State.selectedGameId);
  return found || (games || [])[0] || null;
}

function selectedV3Details() {
  return v3State.operationDetails.get(v3State.selectedGameId) || {};
}

function v3DetailPath(suffix) {
  return `/api/admin/v3/games/${encodeURIComponent(v3State.selectedGameId)}${suffix}`;
}

function v3ActionBusy(key) {
  return v3State.busy.has(key);
}

function v3ReasonInputMarkup(label = "理由") {
  return `<label class="v3-operation-reason">${escapeV3(label)} <input type="text" maxlength="240" data-v3-operation-reason placeholder="必須"></label>`;
}

function v3LineupEditorMarkup(lineup = []) {
  const rows = Array.from({ length: 9 }, (_, index) => lineup.find((row) => Number(row?.battingOrder || row?.order) === index + 1) || { battingOrder: index + 1 });
  return `<div class="v3-lineup-editor">${rows.map((row, index) => `<div class="v3-lineup-row"><strong>${index + 1}番</strong><input value="${escapeV3(row.playerId || "")}" placeholder="playerId" data-v3-player-id><input value="${escapeV3(row.playerName || row.name || "")}" placeholder="選手名" data-v3-player-name><input value="${escapeV3(row.position || "")}" placeholder="守備" data-v3-position><input value="${escapeV3(row.teamCode || "")}" placeholder="team" data-v3-team-code></div>`).join("")}</div>`;
}

function readV3LineupEditor(card) {
  return [...(card?.querySelectorAll(".v3-lineup-row") || [])].map((row, index) => ({
    battingOrder: index + 1,
    playerId: row.querySelector("[data-v3-player-id]")?.value.trim() || null,
    playerName: row.querySelector("[data-v3-player-name]")?.value.trim() || "",
    position: row.querySelector("[data-v3-position]")?.value.trim() || "",
    teamCode: row.querySelector("[data-v3-team-code]")?.value.trim() || ""
  }));
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

function renderV3IdentityDiagnostics(card, diagnostics, failureCode = "", identityState = "") {
  const panel = card?.querySelector("[data-v3-identity-diagnostics]");
  if (!panel) return;
  if (!diagnostics) { panel.textContent = ""; return; }
  const fields = [
    ["internalGameId", diagnostics.internalGameId], ["fetchEndpoint", diagnostics.fetchEndpoint],
    ["fetchHttpStatus", diagnostics.fetchHttpStatus], ["responseContentType", diagnostics.responseContentType],
    ["rawCandidateCount", diagnostics.rawCandidateCount], ["parsedCandidateCount", diagnostics.parsedCandidateCount],
    ["staticCandidateCount", diagnostics.staticCandidateCount], ["mergedCandidateCount", diagnostics.mergedCandidateCount],
    ["targetGameDateJst", diagnostics.targetGameDateJst], ["targetHomeTeam", diagnostics.targetHomeTeam],
    ["targetAwayTeam", diagnostics.targetAwayTeam], ["targetStartTimeJst", diagnostics.targetStartTimeJst],
    ["matchCount", diagnostics.matchCount], ["finalFailureCode", diagnostics.finalFailureCode || failureCode], ["identityState", identityState]
  ];
  const fieldMarkup = fields.map(([name, value]) => `<div><dt>${escapeV3(name)}</dt><dd>${escapeV3(value ?? "-")}</dd></div>`).join("");
  const candidates = Array.isArray(diagnostics.candidates) ? diagnostics.candidates.slice(0, 10) : [];
  const candidateMarkup = candidates.map((candidate, index) => `<article><strong>#${index + 1} ${escapeV3(candidate.source || "-")}</strong><dl><div><dt>date</dt><dd>${escapeV3(candidate.rawDate || "-")} → ${escapeV3(candidate.normalizedDate || "-")}</dd></div><div><dt>home</dt><dd>${escapeV3(candidate.rawHome || candidate.rawHomeTeam || "-")} → ${escapeV3(candidate.normalizedHome || candidate.normalizedHomeTeam || "-")}</dd></div><div><dt>away</dt><dd>${escapeV3(candidate.rawAway || candidate.rawAwayTeam || "-")} → ${escapeV3(candidate.normalizedAway || candidate.normalizedAwayTeam || "-")}</dd></div><div><dt>start</dt><dd>${escapeV3(candidate.rawStartTime || candidate.startTime || "-")} → ${escapeV3(candidate.normalizedStartTime || "-")}</dd></div><div><dt>identity</dt><dd>code:${candidate.gameCodePresent ? "あり" : "なし"} / URL:${candidate.urlPresent ? "あり" : "なし"}</dd></div><div><dt>rejection</dt><dd>${escapeV3((candidate.rejectionReasons || []).join(", ") || "-")}</dd></div></dl></article>`).join("");
  panel.innerHTML = `<details open><summary>NPB解決診断</summary><dl class="npb-diagnostic-grid">${fieldMarkup}</dl><div class="npb-diagnostic-candidates"><strong>候補（最大10件）</strong>${candidateMarkup || "<span class=muted>候補なし</span>"}</div></details>`;
}

function renderSummaryCard(label, count, tone = "ok") {
  return `<div class="summary-card ${tone}"><strong>${escapeV3(count)}</strong><span>${escapeV3(label)}</span></div>`;
}

function nextV3Job(game) {
  return [...(game?.jobs || [])].filter((job) => ["pending", "claimed", "retry_wait"].includes(job.status)).sort((left, right) => String(left.scheduled_at || "").localeCompare(String(right.scheduled_at || "")))[0] || null;
}

function nextV3ActionText(game) {
  const schedule = game?.schedule || {};
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

function rosterDisplayState(game) {
  const jobs = (game?.jobs || []).filter((job) => String(job.job_type || "") === "roster_fetch");
  const byRecent = (left, right) => String(right.updated_at || right.completed_at || right.scheduled_at || "")
    .localeCompare(String(left.updated_at || left.completed_at || left.scheduled_at || ""));
  const failedJob = [...jobs].filter((job) => String(job.status || "") === "failed").sort(byRecent)[0] || null;
  if (failedJob) return { status: "attention", fallbackStatus: "action", job: failedJob, detail: failedJob.failure_code || "ロースター取得に失敗しました。" };
  const retryJob = [...jobs].filter((job) => String(job.status || "") === "retry_wait").sort(byRecent)[0] || null;
  if (retryJob) return { status: "waiting", fallbackStatus: "wait", job: retryJob, detail: retryJob.failure_code || "次回取得を待っています。" };
  if (game?.rosterDiagnostics?.rosterSnapshotExists === true) {
    const completedJob = [...jobs].filter((job) => String(job.status || "") === "completed").sort(byRecent)[0] || null;
    return {
      status: "ok",
      fallbackStatus: "complete",
      job: completedJob,
      detail: completedJob ? "ロースターsnapshot取得済み" : "snapshot取得済みのため追加job不要"
    };
  }
  const openJob = [...jobs].filter((job) => ["pending", "claimed"].includes(String(job.status || ""))).sort(byRecent)[0] || null;
  if (openJob) return { status: "waiting", fallbackStatus: "wait", job: openJob, detail: "取得処理を待っています。" };
  return { status: "waiting", fallbackStatus: "wait", job: null, detail: "取得予定を待っています。" };
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
  const state = String(game?.state?.state || "scheduled");
  if (["lineup_ready", "scored", "ranked", "published"].includes(state)) {
    return { status: "ok", fallbackStatus: "complete", label: "完了", job: null, reasonCode: "", nextCheckAt: null, detail: "正式スタメン確定済み" };
  }
  const jobs = (game?.jobs || [])
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
  const nextCheckAt = slots.map((slot) => new Date(slot || ""))
    .filter((slot) => !Number.isNaN(slot.getTime()) && slot.getTime() > now.getTime())
    .sort((left, right) => left.getTime() - right.getTime())[0]?.toISOString() || null;
  const nextText = nextCheckAt ? formatV3Jst(nextCheckAt) : "なし";

  if (job?.status === "completed") {
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

function todayOpsLatestJob(game, statuses = []) {
  const jobs = (game?.jobs || []).filter((job) => !statuses.length || statuses.includes(String(job.status || "")));
  return [...jobs].sort((left, right) => String(right.completed_at || right.updated_at || right.scheduled_at || "").localeCompare(String(left.completed_at || left.updated_at || left.scheduled_at || "")))[0] || null;
}

function todayOpsStep(game, step, now = new Date()) {
  const state = String(game?.state?.state || "scheduled");
  const schedule = game?.schedule || {};
  const jobs = game?.jobs || [];
  const stepJobTypes = {
    probable: ["probable_starter_fetch"],
    roster: ["roster_fetch"],
    lineup: ["lineup_fetch", "lineup_finalize"],
    scoring: ["score", "scoring"],
    ranking: ["ranking_rebuild"],
    publication: ["publish", "publication"]
  };
  const hasFailed = jobs.some((job) => ["failed", "manual_action_required"].includes(String(job.status || ""))
    && (step === "all" || (stepJobTypes[step] || []).includes(String(job.job_type || ""))));
  if (hasFailed) return "attention";
  if (step === "probable") {
    const status = String(game?.probableStarter?.dataStatus || game?.probableStarter?.status || "unannounced");
    return status === "announced" ? "ok" : "waiting";
  }
  if (step === "roster") {
    return rosterDisplayState(game).status;
  }
  if (step === "lineup") {
    return lineupDisplayState(game, now).status;
  }
  if (step === "scoring") return ["scored", "ranked", "published"].includes(state) ? "ok" : "waiting";
  if (step === "ranking") return ["ranked", "published"].includes(state) ? "ok" : "waiting";
  if (step === "publication") {
    if (state === "published" || game?.publicationStatus === "published") return "ok";
    const publicationAt = new Date(schedule.publicationAt || "").getTime();
    return Number.isFinite(publicationAt) && publicationAt <= now.getTime() ? "attention" : "waiting";
  }
  return "waiting";
}

function buildTodayOpsModel(payload, games, now = new Date()) {
  const todayGames = filteredV3Games(games || [], "today");
  const todayJst = v3JstDate(now);
  const activeFutureGames = (games || []).filter((game) => gameDateForFilter(game) > todayJst && Number(game.isActive ?? 1) !== 0 && !game.deletedAt && (String(game.homeTeam || game.home_team || "").toLowerCase() === "fighters" || String(game.awayTeam || game.away_team || "").toLowerCase() === "fighters"));
  const reportedFutureGames = payload?.todayOps?.futureGamesCount;
  const hasReportedFutureGames = typeof reportedFutureGames === "number" && Number.isFinite(reportedFutureGames);
  const futureGames = hasReportedFutureGames ? reportedFutureGames : activeFutureGames.length;
  const futureGamesMinimum = Number(payload?.todayOps?.futureGamesMinimum) || 3;
  const futureScheduleSync = payload?.todayOps?.futureScheduleSync || null;
  const syncAfter = Number(futureScheduleSync?.futureGamesAfter);
  const syncTarget = Number(futureScheduleSync?.futureGamesTarget) || futureGamesMinimum;
  const futureScheduleSyncAttention = Boolean(
    futureScheduleSync?.errorCode
      || (Number.isFinite(syncAfter) && syncAfter < syncTarget)
      || (futureScheduleSync?.syncNeeded && Number.isFinite(syncAfter) && syncAfter < syncTarget
        && Number(futureScheduleSync?.gamesInserted || 0) === 0
        && Number(futureScheduleSync?.gamesUpdated || 0) === 0)
  );
  const allJobs = todayGames.flatMap((game) => game.jobs || []);
  const latestCompleted = todayOpsLatestJob({ jobs: allJobs }, ["completed"]);
  const latestFailed = todayOpsLatestJob({ jobs: allJobs }, ["failed"]);
  const cronLastRunAt = payload?.todayOps?.cronLastRunAt || null;
  const cronIntervalMinutes = Number(payload?.todayOps?.cronIntervalMinutes) || 1;
  const cronGraceMinutes = Number.isFinite(Number(payload?.todayOps?.cronGraceMinutes)) ? Number(payload.todayOps.cronGraceMinutes) : 2;
  const cronIntervalMs = Number.isFinite(cronIntervalMinutes) && cronIntervalMinutes > 0 ? cronIntervalMinutes * 60 * 1000 : 0;
  const cronGraceMs = Number.isFinite(cronGraceMinutes) && cronGraceMinutes >= 0 ? cronGraceMinutes * 60 * 1000 : 0;
  const cronLastRunMs = cronLastRunAt ? new Date(cronLastRunAt).getTime() : Number.NaN;
  const nextCronEstimateMs = Number.isFinite(cronLastRunMs) && cronIntervalMs ? cronLastRunMs + cronIntervalMs : Number.NaN;
  const nextCronEstimate = Number.isFinite(nextCronEstimateMs) ? new Date(nextCronEstimateMs).toISOString() : null;
  const cronStale = !Number.isFinite(cronLastRunMs) || !Number.isFinite(nextCronEstimateMs) || now.getTime() > nextCronEstimateMs + cronGraceMs;
  const futureShortage = futureGames < futureGamesMinimum;
  const gameModels = todayGames.map((game) => {
    const state = String(game?.state?.state || "scheduled");
    const publicationAt = new Date(game?.schedule?.publicationAt || "").getTime();
    const published = state === "published" || game?.publicationStatus === "published";
    const failedJob = (game.jobs || []).find((job) => job.status === "failed");
    const manualAction = state === "manual_action_required";
    const lineupOverdue = !["lineup_ready", "scored", "ranked", "published"].includes(state)
      && Number.isFinite(new Date(game?.startAt || "").getTime())
      && new Date(game.startAt).getTime() <= now.getTime();
    const publicationOverdue = !published && Number.isFinite(publicationAt) && publicationAt <= now.getTime();
    const attention = Boolean(failedJob || manualAction || lineupOverdue || publicationOverdue);
    const lineupStatus = lineupDisplayState(game, now);
    return {
      game,
      state,
      attention,
      status: attention ? "attention" : game?.jobs?.some((job) => ["pending", "claimed", "retry_wait"].includes(job.status)) ? "waiting" : "ok",
      nextAction: nextV3ActionText(game),
      steps: {
        probable: todayOpsStep(game, "probable", now),
        roster: todayOpsStep(game, "roster", now),
        lineup: lineupStatus.status,
        lineupDetail: lineupStatus.detail,
        scoring: todayOpsStep(game, "scoring", now),
        ranking: todayOpsStep(game, "ranking", now),
        publication: todayOpsStep(game, "publication", now)
      }
    };
  });
  const attention = gameModels.some((model) => model.attention) || futureShortage || cronStale || futureScheduleSyncAttention;
  return {
    todayGames,
    gameModels,
    futureGames,
    futureGamesMinimum,
    futureShortage,
    futureScheduleSync,
    futureScheduleSyncAttention,
    futureScheduleSyncStatus: futureScheduleSyncAttention ? "attention" : futureScheduleSync ? "ok" : "waiting",
    cronLastRunAt,
    cronStale,
    cronSchedule: payload?.todayOps?.cronSchedule || "* * * * *",
    cronDescription: payload?.todayOps?.cronDescription || "毎分",
    nextCronEstimate,
    cronStatus: cronStale ? "attention" : "ok",
    overallStatus: attention ? "attention" : gameModels.some((model) => model.status === "waiting") ? "waiting" : "ok",
    openJobs: allJobs.filter((job) => ["pending", "claimed", "retry_wait"].includes(job.status)).length,
    retryWaitJobs: allJobs.filter((job) => job.status === "retry_wait").length,
    failedJobs: allJobs.filter((job) => job.status === "failed").length,
    latestCompleted,
    latestFailed
  };
}

function renderTodayOpsJob(job) {
  if (!job) return "未実行";
  return `${escapeV3(V3_JOB_LABELS[job.job_type] || job.job_type)} / ${escapeV3(formatV3Jst(job.completed_at || job.updated_at || job.scheduled_at))}`;
}

function renderTodayOpsScheduleSync(model) {
  const sync = model.futureScheduleSync;
  if (!sync) return `<div class="today-ops-diagnostics"><div class="today-ops-diagnostics-heading"><strong>未来試合同期診断</strong>${todayOpsStatusBadge("waiting")}</div><p class="muted">まだ同期監査がありません。</p></div>`;
  const before = sync.futureGamesBefore ?? "-";
  const after = sync.futureGamesAfter ?? "-";
  const target = sync.futureGamesTarget ?? model.futureGamesMinimum;
  const range = sync.fetchRangeStart || sync.fetchRangeEnd ? `${sync.fetchRangeStart || "-"} 〜 ${sync.fetchRangeEnd || "-"}` : "-";
  const lastSync = sync.lastScheduleSyncAt ? formatV3Jst(sync.lastScheduleSyncAt) : "-";
  return `<div class="today-ops-diagnostics"><div class="today-ops-diagnostics-heading"><strong>未来試合同期診断</strong>${todayOpsStatusBadge(model.futureScheduleSyncStatus)}</div><div class="today-ops-diagnostic-grid"><span>未来試合</span><strong>${escapeV3(before)} → ${escapeV3(after)} / target ${escapeV3(target)}</strong><span>syncNeeded</span><strong>${escapeV3(sync.syncNeeded === true ? "true" : sync.syncNeeded === false ? "false" : "-")}</strong><span>fetchRange</span><strong>${escapeV3(range)}</strong><span>expandedTo30Days</span><strong>${escapeV3(sync.expandedTo30Days === true ? "true" : "false")}</strong><span>取得 / 追加 / 更新</span><strong>${escapeV3(`${sync.gamesFetched ?? 0} / ${sync.gamesInserted ?? 0} / ${sync.gamesUpdated ?? 0}`)}</strong><span>skipReason</span><strong>${escapeV3(sync.skipReason || "-")}</strong><span>errorCode</span><strong>${escapeV3(sync.errorCode || "-")}</strong><span>lastScheduleSyncAt</span><strong>${escapeV3(lastSync)}</strong></div></div>`;
}

function renderTodayOpsStep(label, status, detail = "") {
  return `<div class="today-ops-step"><span>${escapeV3(label)}</span>${todayOpsStatusBadge(status)}${detail ? `<small>${escapeV3(detail)}</small>` : ""}</div>`;
}

function renderTodayOps(payload, games) {
  const model = buildTodayOpsModel(payload, games);
  const cronLastDetail = model.cronLastRunAt ? formatV3Jst(model.cronLastRunAt) : "記録なし";
  const nextCronDetail = model.nextCronEstimate ? formatV3Jst(model.nextCronEstimate) : "不明";
  const gameCards = model.gameModels.length
    ? model.gameModels.map(({ game, state, status, nextAction, steps }) => `<article class="today-ops-game"><div class="today-ops-game-heading"><strong>${escapeV3(gameDateForFilter(game))} ${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}</strong>${todayOpsStatusBadge(status)}</div><div class="today-ops-game-meta"><span>state: ${escapeV3(state)}</span><span>次: ${escapeV3(nextAction)}</span></div><div class="today-ops-steps">${renderTodayOpsStep("予告先発", steps.probable)}${renderTodayOpsStep("ロースター", steps.roster)}${renderTodayOpsStep("スタメン", steps.lineup, steps.lineupDetail)}${renderTodayOpsStep("採点", steps.scoring)}${renderTodayOpsStep("ランキング", steps.ranking)}${renderTodayOpsStep("公開", steps.publication)}</div></article>`).join("")
    : "<p class=muted>本日の対象試合はありません。</p>";
  return `<section class="today-ops-panel" aria-labelledby="todayOpsHeading"><div class="today-ops-heading"><div><h3 id="todayOpsHeading">Today Ops / Automation Health</h3><p>本日のV3自動処理を試合単位で確認します。</p></div>${todayOpsStatusBadge(model.overallStatus)}</div><div class="today-ops-metrics"><div><strong>${escapeV3(model.todayGames.length)}</strong><span>今日の試合</span></div><div><strong>${escapeV3(model.openJobs)}</strong><span>open job</span></div><div><strong>${escapeV3(model.retryWaitJobs)}</strong><span>retry_wait</span></div><div><strong>${escapeV3(model.failedJobs)}</strong><span>failed</span></div><div><strong>${escapeV3(model.futureGames)}</strong><span>未来試合登録数</span></div><div><strong>${escapeV3(model.cronSchedule)}</strong><span>Cron設定${model.cronDescription ? `（${escapeV3(model.cronDescription)}）` : ""}</span></div><div><strong>${escapeV3(cronLastDetail)}</strong><span>Cron最終監査</span></div><div><strong>${escapeV3(nextCronDetail)}</strong><span>次Cron目安</span></div><div><strong>${escapeV3(model.cronStatus === "attention" ? "ATTENTION" : "直近")}</strong><span>Cron状態</span></div></div><div class="today-ops-notices"><span>最後に完了: ${renderTodayOpsJob(model.latestCompleted)}</span><span>最後に失敗: ${renderTodayOpsJob(model.latestFailed)}</span><span>${model.futureShortage ? "未来試合が3試合未満" : "未来試合数は充足"}</span><span>${model.cronStale ? "Cron監査が古い、または未記録" : "Cron監査は直近"}</span></div>${renderTodayOpsScheduleSync(model)}<div class="today-ops-games">${gameCards}</div></section>`;
}

function renderGameSummary(game, buttonLabel = "試合進行を見る") {
  const identity = identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState);
  const probable = game.probableStarter;
  const probableStatus = probable?.dataStatus || probable?.status || "unannounced";
  return `<article class="game-card"><div class="game-heading"><h3>${escapeV3(gameDateForFilter(game))} ${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}</h3>${gameHasAttention(game) ? "<span class=attention-badge>要対応</span>" : ""}</div><div class="game-meta"><span>開始 ${escapeV3(formatV3Jst(game.startAt, false))} JST</span><span>state: ${escapeV3(game.state?.state || "scheduled")}</span><span>NPB: ${escapeV3(identity)}</span><span>予告先発: ${escapeV3(probableStatus)}</span><span>次: ${escapeV3(nextV3ActionText(game))}</span></div><div class="game-card-actions"><button type="button" data-v3-select-game="${escapeV3(game.internalGameId)}">${escapeV3(buttonLabel)}</button></div></article>`;
}

function formatTimelineTime(value) {
  if (Array.isArray(value)) return value.map((item) => formatV3Jst(item)).filter(Boolean).join(" / ");
  return value ? formatV3Jst(value) : "";
}

function timelineStep(name, job, fallbackStatus, detail = "", scheduledAt = "", labelOverride = "", statusOverride = "") {
  const status = statusOverride || (job ? String(job.status) : fallbackStatus);
  const klass = status === "complete" ? "complete" : status === "action" ? "action" : status === "wait" ? "wait" : statusClass(status);
  const label = labelOverride || (job ? statusLabel(status) : ({ complete: "完了", scheduled: "予定", wait: "待機中", action: "要対応" }[fallbackStatus] || "待機中"));
  const time = scheduledAt || (job ? (status === "retry_wait" ? job.next_retry_at : job.scheduled_at) : "");
  const failure = job?.failure_code ? ` / ${job.failure_code}` : "";
  return `<article class="timeline-step ${klass}"><span class="status-badge ${klass === "complete" ? "ok" : klass === "retry" ? "retry" : klass === "failed" || klass === "action" ? "action" : klass === "excluded" ? "excluded" : "wait"}">${escapeV3(label)}</span><h4>${escapeV3(name)}</h4><p class="step-time">${escapeV3(formatTimelineTime(time) || (detail && !failure ? detail : "予定未定"))}</p><p>${escapeV3(detail || failure || (job ? `試行 ${job.attempt_count || 0}/${job.max_attempts || 0}` : ""))}</p></article>`;
}

function probableStarterTimelineDetails(game, job, now = new Date()) {
  const starter = game?.probableStarter;
  const diagnostics = game?.probableStarterDiagnostics;
  const details = [];
  const dataStatus = starter?.dataStatus || (starter?.status === "announced" ? "announced" : starter?.status);
  if (diagnostics?.currentDataStatus || dataStatus) details.push(`normalizedDataStatus: ${diagnostics?.currentDataStatus || dataStatus}`);
  if (diagnostics?.rawStatus || starter?.status) details.push(`raw status: ${diagnostics?.rawStatus || starter.status}`);
  if (diagnostics?.rawDataStatus || starter?.dataStatus) details.push(`raw dataStatus: ${diagnostics?.rawDataStatus || starter.dataStatus}`);
  if (diagnostics?.rawErrorCode || starter?.errorCode) details.push(`raw errorCode: ${diagnostics?.rawErrorCode || starter.errorCode}`);
  if (typeof diagnostics?.shouldStopScheduling === "boolean") details.push(`後続取得: ${diagnostics.shouldStopScheduling ? "停止" : "継続"}`);
  if (diagnostics?.reasonCode) details.push(`stopReason: ${diagnostics.reasonCode}`);
  if (diagnostics?.shouldStopScheduling && diagnostics?.reasonCode) details.push(`停止理由: ${diagnostics.reasonCode}`);
  const integrityFields = [
    ["integrityErrorReason", diagnostics?.integrityErrorReason],
    ["internalGameId", diagnostics?.internalGameId],
    ["probableStarterRowInternalGameId", diagnostics?.probableStarterRowInternalGameId],
    ["canonical row id", diagnostics?.canonicalRowId],
    ["conflicting row id", diagnostics?.conflictingRowId],
    ["legacy row detected", diagnostics?.legacyRowDetected],
    ["mismatched row id", diagnostics?.mismatchedRowId],
    ["mismatched internalGameId", diagnostics?.mismatchedInternalGameId],
    ["homeTeam", diagnostics?.homeTeam],
    ["awayTeam", diagnostics?.awayTeam],
    ["fetchedHomeTeam", diagnostics?.fetchedHomeTeam],
    ["fetchedAwayTeam", diagnostics?.fetchedAwayTeam],
    ["gameDate", diagnostics?.gameDate],
    ["fetchedGameDate", diagnostics?.fetchedGameDate],
    ["npbGameCode", diagnostics?.npbGameCode],
    ["fetchedNpbGameCode", diagnostics?.fetchedNpbGameCode],
    ["homePitcherPresent", diagnostics?.homePitcherPresent],
    ["awayPitcherPresent", diagnostics?.awayPitcherPresent]
  ];
  integrityFields.forEach(([label, value]) => {
    if (value !== undefined) details.push(`${label}: ${value === null || value === "" ? "null" : value}`);
  });
  if (dataStatus === "announced" || dataStatus === "partial") {
    details.push(`home: ${starter?.homePitcherName || "未発表"} / away: ${starter?.awayPitcherName || "未発表"}`);
    if (dataStatus === "partial") details.push("一部発表・自動確認継続中");
  } else if (starter?.status) {
    details.push({
      unannounced: "未発表",
      transient_error: "一時的に取得失敗",
      integrity_error: "データ整合性エラー"
    }[dataStatus] || dataStatus);
  }
  if (job?.scheduled_slot_at) details.push(`対象slot: ${formatV3Jst(job.scheduled_slot_at)}`);
  if (job?.claimed_at || job?.completed_at) details.push(`実行: ${formatV3Jst(job.completed_at || job.claimed_at)}`);
  if (dataStatus) details.push(`取得結果: ${dataStatus}`);
  if (starter?.sourceUrl) details.push(`取得元: ${starter.sourceUrl}`);
  if (starter?.fetchedAt) details.push(`最終取得: ${formatV3Jst(starter.fetchedAt)}`);
  const nextCheckAt = game?.probableStarterNextCheckAt || starter?.nextCheckAt || diagnostics?.nextCheckAt;
  if (nextCheckAt) details.push(`次回自動確認: ${formatV3Jst(nextCheckAt)}`);
  const nextJob = game?.probableStarterJob;
  if (nextCheckAt) {
    if (nextJob?.actualJobExists) {
      details.push(`${formatV3Jst(nextCheckAt)} job: ${statusLabel(nextJob.jobStatus)} / 試行 ${nextJob.attemptCount || 0}/${nextJob.maxAttempts || 0}`);
      if (nextJob.scheduledSlotAt) details.push(`実在scheduledSlotAt: ${formatV3Jst(nextJob.scheduledSlotAt)}`);
    } else {
      details.push(`${formatV3Jst(nextCheckAt)} job: 未生成`);
    }
  }
  if (diagnostics?.reasonCode && (!nextJob?.actualJobExists || diagnostics.reasonCode !== "PROBABLE_STARTER_JOB_CREATED")) {
    details.push(`未生成理由: ${diagnostics.reasonCode}`);
  }
  if (diagnostics?.conflictingJobId) details.push(`競合job: ${diagnostics.conflictingJobId}`);
  if (diagnostics?.conflictingScheduledSlotAt) details.push(`競合slot: ${formatV3Jst(diagnostics.conflictingScheduledSlotAt)}`);
  if (diagnostics?.conflictingStatus) details.push(`競合status: ${diagnostics.conflictingStatus}`);
  if (job?.failure_code || diagnostics?.errorCode) details.push(`errorCode: ${job?.failure_code || diagnostics?.errorCode}`);
  if (diagnostics?.httpStatus || diagnostics?.parserResult || diagnostics?.candidateCount !== null) {
    details.push(`診断: HTTP ${diagnostics.httpStatus ?? "-"} / ${diagnostics.parserResult || "-"} / 候補 ${diagnostics.candidateCount ?? "-"}`);
  }
  if (job && Number.isFinite(Number(job.attempt_count))) details.push(`試行 ${job.attempt_count || 0}/${job.max_attempts || 0}`);
  const scheduledAt = game?.schedule?.probableStarterNextAt ? new Date(game.schedule.probableStarterNextAt) : null;
  if (!job && scheduledAt && scheduledAt.getTime() <= now.getTime()) details.push("実行待ち / job未生成 / 要確認");
  return details.join(" / ") || (job ? "" : "前日18:00予定");
}

function rosterTimelineDetails(game) {
  const diagnostics = game?.rosterDiagnostics || {};
  const details = [];
  const generatedSlots = rosterDisplaySlots(game, diagnostics.generatedSlots);
  const dueSlots = rosterDisplaySlots(game, diagnostics.dueSlots);
  if (generatedSlots.length) {
    details.push(`生成slot: ${formatTimelineTime(generatedSlots)}`);
  }
  if (dueSlots.length) {
    details.push(`期限到達: ${formatTimelineTime(dueSlots)}`);
  }
  if (diagnostics.selectedDueSlot) details.push(`選択slot: ${formatV3Jst(diagnostics.selectedDueSlot)}`);
  const rosterState = rosterDisplayState(game);
  if (diagnostics.actualJobExists) {
    details.push(`job: ${statusLabel(diagnostics.jobStatus)}${diagnostics.existingJobId ? ` #${diagnostics.existingJobId}` : ""}`);
  } else {
    details.push(rosterState.status === "ok" ? "job未生成理由: snapshot取得済みのため追加job不要" : "job未生成");
  }
  if (diagnostics.planningSkipped) details.push(`planning: skip (${diagnostics.skipReason || "理由不明"})`);
  if (diagnostics.insertAttempted) details.push(`INSERT: ${diagnostics.insertedRowCount || 0}件`);
  if (diagnostics.claimResult && diagnostics.claimResult !== "not_attempted") details.push(`claim: ${diagnostics.claimResult}`);
  if (diagnostics.rosterSnapshotExists) details.push(`snapshot: ${diagnostics.rosterSnapshotStatus || "captured"}`);
  return details.join(" / ") || "本日の予定slot";
}

function renderTimeline(game) {
  const schedule = game.schedule || {};
  const state = String(game.state?.state || "scheduled");
  const identityStatus = String(game.npbIdentityStatus || "");
  const identityState = String(game.npbIdentityState || "");
  const identityJob = latestV3Job(game, "npb_identity_resolve");
  const identityDisplay = npbIdentityDisplay(game);
  const identityFallback = identityStatus === "resolved" || identityStatus === "manually_overridden" ? "complete" : identityState === "manual_action_required" ? "action" : identityState === "retry_wait" ? "retry" : "scheduled";
  const predictionJob = latestV3Job(game, "prediction_close");
  const lineupJob = latestV3Job(game, "lineup_fetch");
  const finalizeJob = latestV3Job(game, "lineup_finalize");
  const scoreJob = latestV3Job(game, "score");
  const rankingJob = latestV3Job(game, "ranking_rebuild");
  const publishJob = latestV3Job(game, "publish");
  const rosterState = rosterDisplayState(game);
  const lineupState = lineupDisplayState(game);
  const displayRosterSlots = rosterDisplaySlots(game, schedule.rosterFetchSlots);
  const probableJob = latestV3Job(game, "probable_starter_fetch");
  const probableSlot = schedule.probableStarterNextAt ? new Date(schedule.probableStarterNextAt) : null;
  const probableMissingPastSlot = !probableJob && probableSlot && probableSlot.getTime() <= Date.now();
  const probableDataStatus = game?.probableStarter?.dataStatus || game?.probableStarter?.status;
  const probableFallback = probableMissingPastSlot ? "action" : probableDataStatus === "announced" ? "complete" : "wait";
  const probableTime = probableJob || probableMissingPastSlot ? "" : schedule.probableStarterNextAt;
  const steps = [
    timelineStep("日程登録", null, "complete", "games登録済み", schedule.startAt),
    timelineStep("予告先発取得", probableJob, probableFallback, probableStarterTimelineDetails(game, probableJob), probableTime),
    timelineStep("ロースター取得", rosterState.job, rosterState.fallbackStatus, rosterState.job?.failure_code || rosterTimelineDetails(game), displayRosterSlots),
    timelineStep("予想締切", predictionJob, state === "scheduled" ? "scheduled" : "complete", "締切は開始時刻から60分前", schedule.predictionDeadline),
    timelineStep("NPB識別情報解決", identityJob, identityFallback, `job: ${identityDisplay.jobStatus} / game code: ${identityDisplay.code}`),
    timelineStep("スタメン取得", lineupState.job || lineupJob, lineupState.fallbackStatus, lineupState.detail, lineupState.nextCheckAt || schedule.lineupPollingStart, lineupState.label, lineupState.fallbackStatus),
    timelineStep("正式スタメン確定", finalizeJob, state === "lineup_ready" || state === "scored" || state === "ranked" || state === "published" ? "complete" : "scheduled", "最新候補を開始2分後に確定", schedule.finalLineupAt),
    timelineStep("採点", scoreJob, ["scored", "ranked", "published"].includes(state) ? "complete" : "scheduled", scoreJob ? "" : "正式スタメン確定後", schedule.scoringEarliestAt),
    timelineStep("ランキング反映", rankingJob, ["ranked", "published"].includes(state) ? "complete" : "scheduled", rankingJob ? "" : "採点完了後"),
    timelineStep("結果公開", publishJob, state === "published" ? "complete" : "scheduled", "開始10分後", schedule.publicationAt)
  ];
  return `<div class="timeline">${steps.join("")}</div>`;
}

function renderRosterSummary(game) {
  const rosterState = rosterDisplayState(game);
  const job = rosterState.job;
  const diagnostics = game?.rosterDiagnostics || {};
  const generatedSlots = rosterDisplaySlots(game, diagnostics.generatedSlots);
  const dueSlots = rosterDisplaySlots(game, diagnostics.dueSlots);
  const diagnosticRows = [
    ["生成slot", formatTimelineTime(generatedSlots)],
    ["期限到達slot", formatTimelineTime(dueSlots)],
    ["選択slot", formatV3Jst(diagnostics.selectedDueSlot)],
    ["job実在", diagnostics.actualJobExists ? `${statusLabel(diagnostics.jobStatus)}${diagnostics.existingJobId ? ` (#${diagnostics.existingJobId})` : ""}` : rosterState.status === "ok" ? "未生成（snapshot取得済み）" : "未生成"],
    ["planning", diagnostics.planningSkipped ? `skip: ${diagnostics.skipReason || "-"}` : "継続"],
    ["INSERT", diagnostics.insertAttempted ? `${diagnostics.insertedRowCount || 0}件` : "未実行"],
    ["claim", diagnostics.claimResult || "未実行"],
    ["snapshot", diagnostics.rosterSnapshotExists ? `${diagnostics.rosterSnapshotStatus || "captured"} / ${diagnostics.rosterSnapshotPlayerCount || 0}人` : "未取得"]
  ].filter(([, value]) => value && value !== "-");
  const successAt = job?.status === "completed" ? formatV3Jst(job.completed_at || job.updated_at) : diagnostics.rosterSnapshotExists ? "snapshot captured" : "-";
  const nextAt = job ? formatV3Jst(job.next_retry_at || job.scheduled_at) : rosterState.status === "ok" ? "追加取得不要" : "予定未定";
  const result = job ? `${job.failure_code || "V3 job"} / ${statusLabel(job.status)}` : rosterState.status === "ok" ? "snapshot captured / job未生成" : "履歴なし";
  const attempts = job ? `${job.attempt_count || 0}/${job.max_attempts || 0}` : rosterState.status === "ok" ? "不要" : "-";
  return `<div class="roster-summary"><div><strong>最終成功</strong><span>${escapeV3(successAt)}</span></div><div><strong>次回取得予定</strong><span>${escapeV3(nextAt)}</span></div><div><strong>取得元・結果</strong><span>${escapeV3(result)}</span></div><div><strong>試行</strong><span>${escapeV3(attempts)}</span></div>${diagnosticRows.map(([label, value]) => `<div><strong>${escapeV3(label)}</strong><span>${escapeV3(value)}</span></div>`).join("")}</div>`;
}

function renderDashboard(payload, games) {
  const todayGames = filteredV3Games(payload.games || [], "today");
  const allJobs = (payload.games || []).flatMap((game) => game.jobs || []);
  const attention = (payload.games || []).filter(gameHasAttention).length;
  const failed = allJobs.filter((job) => job.status === "failed").length;
  const retry = allJobs.filter((job) => job.status === "retry_wait").length;
  const pendingIdentity = (payload.games || []).filter((game) => ["pending", "retry_wait"].includes(game.npbIdentityState)).length;
  const completedToday = todayGames.reduce((count, game) => count + (game.jobs || []).filter((job) => job.status === "completed" && String(job.completed_at || "").slice(0, 10) === v3JstDate()).length, 0);
  const publicationWait = (payload.games || []).filter((game) => game.state?.state === "ranked").length;
  const cards = todayGames.length ? todayGames.map((game) => renderGameSummary(game)).join("") : `<div class="today-empty">本日の試合はありません</div>`;
  return `<div class="view-heading"><div><h2>ダッシュボード</h2><p>本日の試合と要対応項目を最初に確認できます。</p></div></div>${renderTodayOps(payload, games)}<section class="today-card"><h3>本日の試合</h3>${cards}</section><section class="summary-grid">${renderSummaryCard("要対応", attention, attention ? "attention" : "ok")}${renderSummaryCard("失敗job", failed, failed ? "error" : "ok")}${renderSummaryCard("retry_wait", retry, retry ? "attention" : "ok")}${renderSummaryCard("掲載待ち", pendingIdentity, pendingIdentity ? "attention" : "ok")}${renderSummaryCard("本日の完了job", completedToday)}${renderSummaryCard("公開待ち", publicationWait, publicationWait ? "attention" : "ok")}</section><section class="v3-panel"><div class="view-heading"><div><h3>今日の自動処理</h3><p>詳細は試合進行メニューから確認できます。</p></div></div>${todayGames.length ? todayGames.map((game) => `<div class="compact-meta"><strong>${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}</strong><span>次: ${escapeV3(nextV3ActionText(game))}</span><span>${escapeV3(gameHasAttention(game) ? "要対応" : "正常")}</span></div>`).join("") : "<span class=muted>今日の処理履歴はありません。</span>"}</section>`;
}

function renderGamesView(games) {
  const rows = games.map((game) => `<tr><td>${escapeV3(gameDateForFilter(game))}</td><td>${escapeV3(formatV3Jst(game.startAt, false))}</td><td>${escapeV3(game.homeTeam)}</td><td>${escapeV3(game.awayTeam)}</td><td>${escapeV3(game.state?.state || "scheduled")}</td><td>${escapeV3(identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState))}</td><td>${escapeV3(nextV3ActionText(game))}</td><td>${gameHasAttention(game) ? "<span class=attention-badge>要対応</span>" : "<span class=\"status-badge ok\">正常</span>"}</td><td><button type="button" data-v3-select-game="${escapeV3(game.internalGameId)}">詳細</button></td></tr>`).join("");
  return `<div class="view-heading"><div><h2>試合一覧</h2><p>日付、進行状態、次の処理を比較します。</p></div></div><div class="games-table-wrap"><table class="games-table"><thead><tr><th>日付</th><th>開始</th><th>home</th><th>away</th><th>state</th><th>NPB</th><th>次の処理</th><th>対応</th><th></th></tr></thead><tbody>${rows || "<tr><td colspan=9>対象試合はありません。</td></tr>"}</tbody></table></div>`;
}

function renderSelectedGameHeader(game, title, description = "") {
  if (!game) return `<div class="today-empty">対象試合を選択してください。</div>`;
  return `<div class="view-heading"><div><h2>${escapeV3(title)}</h2><p>${escapeV3(description)}</p></div><div class="compact-meta"><strong>${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}</strong><span>${escapeV3(formatV3Jst(game.startAt))} JST</span></div></div>`;
}

function renderWorkflowView(game) {
  if (!game) return renderSelectedGameHeader(null, "試合進行");
  const identity = npbIdentityDisplay(game);
  return `${renderSelectedGameHeader(game, "試合進行", "V3 jobの状態、失敗、再試行・取消を試合単位で確認します。")}<section class="v3-panel"><div class="compact-meta"><span>現在: <strong>${escapeV3(game.state?.state || "scheduled")}</strong></span><span>次の処理: <strong>${escapeV3(nextV3ActionText(game))}</strong></span><span>NPB識別job: <strong>${escapeV3(identity.jobStatus)}</strong></span><span>NPB game code: <strong>${escapeV3(identity.code)}</strong></span></div>${renderTimeline(game)}<details class="roster-details"><summary>ロースター取得の詳細</summary>${renderRosterSummary(game)}</details><h3>job操作</h3>${renderJobRows(game, V3_JOB_TYPES)}</section>`;
}

function jobDetailKey(internalGameId, jobId) {
  return `${String(internalGameId || "").trim()}:${String(jobId || "").trim()}`;
}

function jobDetailDomId(key) {
  return `v3-job-detail-${String(key || "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function jobField(job, snakeName, camelName, fallback = "") {
  const value = job?.[snakeName] ?? job?.[camelName];
  return value === null || value === undefined ? fallback : value;
}

const JOB_DETAIL_FIELDS = Object.freeze([
  ["job_type", "jobType"],
  ["status", "status"],
  ["scheduled_at", "scheduledAt"],
  ["scheduled_slot_at", "scheduledSlotAt"],
  ["attempt_count", "attemptCount"],
  ["max_attempts", "maxAttempts"],
  ["next_retry_at", "nextRetryAt"],
  ["claimed_at", "claimedAt"],
  ["lease_expires_at", "leaseExpiresAt"],
  ["completed_at", "completedAt"],
  ["failure_code", "failureCode"],
  ["job_id", "jobId"],
  ["internal_game_id", "internalGameId"],
  ["lineup_revision_id", "lineupRevisionId"],
  ["scoring_revision_id", "scoringRevisionId"],
  ["ranking_revision_id", "rankingRevisionId"],
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"]
]);

function jobDetailRawFields(internalGameId, detail) {
  const job = detail?.job || detail || {};
  return JOB_DETAIL_FIELDS.map(([snakeName, camelName]) => {
    const raw = snakeName === "job_id" ? jobField(job, snakeName, camelName, job.id) : snakeName === "internal_game_id" ? jobField(job, snakeName, camelName, internalGameId) : jobField(job, snakeName, camelName, "");
    return { snakeName, camelName, raw: raw === null || raw === undefined ? "" : String(raw) };
  }).filter((field) => field.raw !== "");
}

function jobDetailDisplayValue(field) {
  if (field.snakeName.endsWith("_at") || field.snakeName === "claimed_at" || field.snakeName === "completed_at") {
    const formatted = formatV3Jst(field.raw);
    return formatted === "-" ? field.raw : `${formatted} JST (${field.raw})`;
  }
  return field.raw;
}

function jobDetailCopyText(internalGameId, detail) {
  const job = detail?.job || detail || {};
  const fields = jobDetailRawFields(internalGameId, detail);
  const lines = fields.map((field) => `${field.camelName}: ${field.raw}`);
  if (job.failure_message || job.failureMessage) lines.push(`failureMessage:\n${job.failure_message || job.failureMessage}`);
  if (detail?.plannerDecision) lines.push(`plannerDecision:\n${JSON.stringify(detail.plannerDecision, null, 2)}`);
  if (detail?.pipelineDiagnostics) lines.push(`pipelineDiagnostics:\n${JSON.stringify(detail.pipelineDiagnostics, null, 2)}`);
  if (Array.isArray(detail?.pipelineEvents) && detail.pipelineEvents.length) lines.push(`pipelineEvents:\n${JSON.stringify(detail.pipelineEvents, null, 2)}`);
  if (Array.isArray(detail?.audits) && detail.audits.length) lines.push(`audits:\n${JSON.stringify(detail.audits, null, 2)}`);
  return lines.join("\n");
}

function renderJobCopyButton(copyType, label, value, internalGameId, jobId) {
  if (!value) return "";
  return `<button type="button" class="job-detail-copy" data-v3-job-copy="${escapeV3(copyType)}" data-v3-job-copy-game="${escapeV3(internalGameId)}" data-v3-job-copy-id="${escapeV3(jobId)}">${escapeV3(label)}</button>`;
}

function renderInlineJobDetail(game, job) {
  const key = jobDetailKey(game.internalGameId, job.id);
  if (!v3State.jobDetailsOpen.has(key)) return "";
  const domId = jobDetailDomId(key);
  const detail = v3State.jobDetails.get(key);
  if (v3State.jobDetailsLoading.has(key)) return `<div id="${escapeV3(domId)}" class="job-detail-inline" aria-busy="true"><p>job詳細を読み込んでいます。</p></div>`;
  if (detail?.error) return `<div id="${escapeV3(domId)}" class="job-detail-inline job-detail-error"><p>${escapeV3(detail.error)}</p><button type="button" data-v3-job-detail-refresh="${escapeV3(game.internalGameId)}" data-v3-job-detail-refresh-id="${escapeV3(job.id)}">再取得</button></div>`;
  if (!detail) return `<div id="${escapeV3(domId)}" class="job-detail-inline"><p>job詳細を取得できませんでした。</p></div>`;
  const detailedJob = detail.job || detail;
  const fields = jobDetailRawFields(game.internalGameId, detail);
  const failureMessage = jobField(detailedJob, "failure_message", "failureMessage", "");
  const plannerDecision = detail.plannerDecision || detail.pipelineDiagnostics?.plannerDecision || null;
  const fullText = jobDetailCopyText(game.internalGameId, detail);
  const copyStatus = v3State.jobDetailsCopyStatus?.get(key) || "";
  const fieldMarkup = fields.map((field) => `<div class="job-detail-field"><dt>${escapeV3(field.camelName)}</dt><dd class="job-detail-value">${escapeV3(jobDetailDisplayValue(field))}${renderJobCopyButton(field.camelName, "コピー", field.raw, game.internalGameId, job.id)}</dd></div>`).join("");
  const failureMarkup = failureMessage ? `<div class="job-detail-field job-detail-field-full"><dt>failureMessage ${renderJobCopyButton("failureMessage", "エラーをコピー", String(failureMessage), game.internalGameId, job.id)}</dt><dd><pre class="job-detail-pre">${escapeV3(String(failureMessage))}</pre></dd></div>` : "";
  const plannerMarkup = plannerDecision ? `<div class="job-detail-field job-detail-field-full"><dt>planner decision</dt><dd><pre class="job-detail-pre">${escapeV3(JSON.stringify(plannerDecision, null, 2))}</pre></dd></div>` : "";
  const pipelineMarkup = detail.pipelineDiagnostics ? `<div class="job-detail-field job-detail-field-full"><dt>pipeline diagnostics</dt><dd><pre class="job-detail-pre">${escapeV3(JSON.stringify(detail.pipelineDiagnostics, null, 2))}</pre></dd></div>` : "";
  const eventMarkup = Array.isArray(detail.pipelineEvents) && detail.pipelineEvents.length ? `<div class="job-detail-field job-detail-field-full"><dt>pipeline events</dt><dd><pre class="job-detail-pre">${escapeV3(JSON.stringify(detail.pipelineEvents, null, 2))}</pre></dd></div>` : "";
  const auditMarkup = Array.isArray(detail.audits) && detail.audits.length ? `<div class="job-detail-field job-detail-field-full"><dt>audits</dt><dd><pre class="job-detail-pre">${escapeV3(JSON.stringify(detail.audits, null, 2))}</pre></dd></div>` : "";
  return `<section id="${escapeV3(domId)}" class="job-detail-inline" aria-label="job詳細"><div class="job-detail-toolbar"><strong>job詳細</strong>${renderJobCopyButton("all", "詳細をすべてコピー", fullText, game.internalGameId, job.id)}<span class="job-copy-status" aria-live="polite">${escapeV3(copyStatus)}</span></div><dl class="job-detail-grid">${fieldMarkup}${failureMarkup}${plannerMarkup}${pipelineMarkup}${eventMarkup}${auditMarkup}</dl><button type="button" class="job-detail-refresh" data-v3-job-detail-refresh="${escapeV3(game.internalGameId)}" data-v3-job-detail-refresh-id="${escapeV3(job.id)}">再取得</button></section>`;
}

function renderJobRows(game, types) {
  const jobs = latestV3Jobs(game, types);
  return jobs.length ? `<div class="job-list">${jobs.map((job) => {
    const key = jobDetailKey(game.internalGameId, job.id);
    const open = v3State.jobDetailsOpen.has(key);
    return `<div class="job-entry"><div class="job"><code>${escapeV3(V3_JOB_LABELS[job.job_type] || job.job_type)}</code><span class="job-status">${escapeV3(statusLabel(job.status))}</span><span>${escapeV3(job.failure_code || `試行 ${job.attempt_count || 0}/${job.max_attempts || 0}`)}<br><small>予定 ${escapeV3(formatV3Jst(job.scheduled_at))}</small></span><button type="button" aria-expanded="${open ? "true" : "false"}" aria-controls="${escapeV3(jobDetailDomId(key))}" data-v3-job-detail="${escapeV3(game.internalGameId)}" data-v3-job-id="${escapeV3(job.id)}">詳細</button>${["failed", "retry_wait"].includes(job.status) ? `<button type="button" data-v3-job-retry="${escapeV3(job.id)}">再試行</button>` : ""}${["pending", "retry_wait"].includes(job.status) ? `<button type="button" data-v3-job-cancel="${escapeV3(job.id)}">取消</button>` : ""}</div>${renderInlineJobDetail(game, job)}</div>`;
  }).join("")}</div>` : "<span class=muted>該当jobの履歴はありません。</span>";
}

async function copyTextSafely(value) {
  const text = String(value ?? "");
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Clipboard permissions may be unavailable in an embedded admin page.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = typeof document.execCommand === "function" && document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("CLIPBOARD_UNAVAILABLE");
}

async function loadV3JobDetail(internalGameId, jobId, force = false) {
  const key = jobDetailKey(internalGameId, jobId);
  if (v3State.jobDetailsLoading.has(key)) return;
  if (!force && v3State.jobDetails.has(key)) return;
  const numericJobId = Number(jobId);
  const selected = (v3State.payload?.games || []).find((game) => game.internalGameId === internalGameId);
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
    const detail = await v3Fetch(`/api/admin/v3/games/${encodeURIComponent(internalGameId)}/jobs/${encodeURIComponent(numericJobId)}`);
    if (detail.internalGameId !== internalGameId || Number(detail.job?.id) !== numericJobId) throw new Error("V3_JOB_DETAIL_ID_MISMATCH");
    v3State.jobDetails.set(key, detail);
  } catch (error) {
    v3State.jobDetails.set(key, { error: `${error.code || "V3_JOB_DETAIL_FAILED"}: ${error.message}` });
  } finally {
    v3State.jobDetailsLoading.delete(key);
    renderCurrentV3View();
  }
}

function renderLineupView(game) {
  if (!game) return renderSelectedGameHeader(null, "スタメン");
  const details = selectedV3Details();
  const current = details.lineup?.currentRevision;
  return `${renderSelectedGameHeader(game, "スタメン", "revisionを作成してから正式確定します。既存revisionは保持されます。")}<section class="v3-panel"><div class="detail-grid"><div><dt>最新revision</dt><dd>${escapeV3(current?.revisionId || "未作成")}</dd></div><div><dt>正式確定</dt><dd>${escapeV3(details.lineup?.lineupStatus || "待機")}</dd></div><div><dt>source / finalizedAt</dt><dd>${escapeV3(`${current?.source || "-"} / ${formatV3Jst(details.lineup?.finalizedAt)}`)}</dd></div></div><h3>スタメン編集</h3>${v3LineupEditorMarkup(current?.lineup || [])}${v3ReasonInputMarkup("修正理由")}<div class="v3-operation-actions"><button type="button" data-v3-save-lineup>revisionを保存</button><button type="button" data-v3-finalize-lineup>正式確定</button></div><h3>revision履歴</h3><div class="revision-list">${(details.revisions || []).map((revision) => `<div class="revision-row"><span><strong>${escapeV3(revision.revisionId)}</strong> / ${escapeV3(revision.source)} / ${escapeV3(revision.reason || "-")}</span><span>${revision.isFinal ? "final" : "candidate"} ${escapeV3(formatV3Jst(revision.createdAt))}</span></div>`).join("") || "<span class=muted>revision履歴はありません。</span>"}</div><h3>取得・確定job</h3>${renderJobRows(game, ["lineup_fetch", "lineup_finalize"])}</section>`;
}

function renderScoringView(game) {
  if (!game) return renderSelectedGameHeader(null, "採点・ランキング");
  const details = selectedV3Details();
  const scoring = details.ranking?.scoring || {};
  const publication = details.publication?.publication || {};
  return `${renderSelectedGameHeader(game, "採点・ランキング", "採点プレビュー、ランキング再構築、結果公開を段階的に実行します。")}<section class="v3-panel"><div class="detail-grid"><div><dt>対象予想数</dt><dd>${escapeV3(scoring.eligiblePredictionCount ?? "-")}</dd></div><div><dt>採点済み / 失敗</dt><dd>${escapeV3(`${scoring.scoredPredictionCount ?? "-"} / ${scoring.failedPredictionCount ?? "-"}`)}</dd></div><div><dt>active scoring revision</dt><dd>${escapeV3(details.ranking?.activeScoringRevision?.id || "-")}</dd></div><div><dt>ranking</dt><dd>${escapeV3(details.ranking?.ranking?.gameStatus || "-")}</dd></div><div><dt>publication</dt><dd>${escapeV3(publication.status || "pending")}</dd></div><div><dt>publishedAt</dt><dd>${escapeV3(formatV3Jst(publication.publishedAt))}</dd></div><div><dt>公開lineup revision</dt><dd>${escapeV3(publication.publishedLineupRevision?.revision_id || publication.publishedLineupRevision?.id || "-")}</dd></div><div><dt>公開scoring revision</dt><dd>${escapeV3(publication.publishedScoringRevision?.id || "-")}</dd></div></div>${v3ReasonInputMarkup("操作理由")}<div class="v3-operation-actions"><button type="button" data-v3-scoring-preview>再採点プレビュー</button><button type="button" data-v3-scoring-confirm>再採点実行</button><button type="button" data-v3-ranking-rebuild>ランキング再構築</button><button type="button" data-v3-publish>公開</button><button type="button" data-v3-republish>再公開</button></div><div class="v3-operation-result" data-v3-operation-result>${v3State.rescorePreview?.internalGameId === game.internalGameId ? `previewId: ${escapeV3(v3State.rescorePreview.previewId || "-")}` : ""}</div><h3>処理job</h3>${renderJobRows(game, ["score", "ranking_rebuild", "publish"])}</section>`;
}

function renderScheduleView(games) {
  const game = selectedV3Game(games);
  const details = selectedV3Details();
  const schedule = details.schedule?.schedule;
  if (!game) return `<div class="view-heading"><div><h2>日程管理</h2><p>対象試合を選択してください。</p></div></div>`;
  const localStart = schedule?.startAt ? new Date(schedule.startAt).toISOString().slice(0, 16) : "";
  return `${renderSelectedGameHeader(game, "日程管理", "開始時刻変更は締切を再計算します。締切後の受付は自動再開しません。")}<section class="v3-panel"><div class="detail-grid"><div><dt>試合開始</dt><dd>${escapeV3(formatV3Jst(schedule?.startAt || game.startAt))}</dd></div><div><dt>予想締切</dt><dd>${escapeV3(formatV3Jst(schedule?.predictionDeadline))}</dd></div><div><dt>lineupPollingStart</dt><dd>${escapeV3(formatV3Jst(schedule?.lineupPollingStart))}</dd></div></div><label>開始時刻 <input type="datetime-local" value="${escapeV3(localStart)}" data-v3-schedule-start></label>${v3ReasonInputMarkup("変更理由")}<div class="v3-operation-actions"><button type="button" data-v3-schedule-save>日程を保存</button></div><h3>ランキング対象状態</h3><p>${escapeV3(details.eligibility?.rankingEligibility?.rankingEligibilityStatus || "未取得")}</p><select data-v3-eligibility-status><option value="eligible">対象</option><option value="excluded">対象外</option><option value="pending_admin_decision">確認待ち</option></select><button type="button" data-v3-eligibility-save>状態を保存</button></section>`;
}

function renderGameControls(game, includeDiagnostics = false) {
  if (!game) return "<div class=today-empty>対象試合を選択してください。</div>";
  const npbGameCode = String(game.npbGameCode || "");
  const identityJob = latestV3Job(game, "npb_identity_resolve");
  const jobs = renderJobRows(game, V3_JOB_TYPES);
  const identityDiagnostics = v3State.identityDiagnostics.get(game.internalGameId);
  return `<article class="game-card"><div class="game-heading"><h3>${escapeV3(gameDateForFilter(game))} ${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}</h3><code>${escapeV3(game.internalGameId)}</code></div><div class="game-meta"><span>開始 ${escapeV3(formatV3Jst(game.startAt))} JST</span><span>DB home: ${escapeV3(game.homeTeam)}</span><span>DB away: ${escapeV3(game.awayTeam)}</span><span class="npb-identity-status">NPB識別情報: ${escapeV3(identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState))}</span><span>コード ${escapeV3(npbGameCode || "未登録")}</span><span class="state">state: ${escapeV3(game.state?.state || "scheduled")}</span></div><div class="npb-identity-details"><span>解決元: ${escapeV3(game.npbIdentitySource || "-")}</span><span>解決時刻: ${escapeV3(formatV3Jst(game.npbIdentityResolvedAt))}</span><span>URL: ${game.npbGameUrl ? `<a href="${escapeV3(game.npbGameUrl)}" target="_blank" rel="noreferrer">${escapeV3(game.npbGameUrl)}</a>` : "-"}</span><button type="button" data-v3-identity-resolve="${escapeV3(game.internalGameId)}">手動再解決</button></div><div class="npb-identity-auto-job"><strong>NPB自動解決job</strong><span>次回予定: ${escapeV3(identityJob ? formatV3Jst(identityJob.status === "retry_wait" ? identityJob.next_retry_at : identityJob.scheduled_at) : "未作成")}</span><span>最終実行: ${escapeV3(formatV3Jst(identityJob?.completed_at || identityJob?.updated_at))}</span><span>次回retry: ${escapeV3(formatV3Jst(identityJob?.next_retry_at))}</span><span>結果: ${escapeV3(identityJob?.failure_code || identityJob?.status || "-")}</span><span>試行: ${escapeV3(identityJob ? `${identityJob.attempt_count || 0}/${identityJob.max_attempts || 0}` : "-")}</span></div><div class="v3-orientation-editor"><strong>home / away修正（DB値確認後のみ）</strong><label>home <input type="text" value="${escapeV3(game.homeTeam)}" data-v3-home-team></label><label>away <input type="text" value="${escapeV3(game.awayTeam)}" data-v3-away-team></label><input type="text" maxlength="240" placeholder="修正理由（必須）" data-v3-orientation-reason><button type="button" data-v3-orientation-save="${escapeV3(game.internalGameId)}">向きを保存</button><span class="v3-orientation-status" data-v3-orientation-status></span></div><div class="npb-code-editor"><strong>非常用手動上書き</strong><label>NPBゲームコード <input type="text" maxlength="32" value="${escapeV3(npbGameCode)}" data-v3-npb-code><button type="button" data-v3-code-save="${escapeV3(game.internalGameId)}">保存</button></label><span class="npb-code-status" data-v3-code-status></span></div>${includeDiagnostics ? `<div class="npb-identity-diagnostics" data-v3-identity-diagnostics></div>` : ""}<div class="job-list">${jobs}</div></article>`;
}

function renderEmergencyView(game) {
  return `${renderSelectedGameHeader(game, "緊急操作", "通常運用から分離した管理者向け操作です。実行前に影響を確認してください。")}<section class="v3-panel"><p class="muted">この操作はjobの再投入、NPB識別情報の再解決、日程の向きや非常用コードを変更します。採点・ランキング・公開に影響する場合があります。</p>${renderGameControls(game, false)}</section>`;
}

function renderDiagnosticsView(game) {
  return `${renderSelectedGameHeader(game, "診断・監査", "UUID、job、lease、failure codeなどの技術情報をこの画面へ集約しています。")}<section class="diagnostics-list">${renderGameControls(game, true)}</section>`;
}

function renderCurrentV3View() {
  const payload = v3State.payload;
  if (!payload) return;
  const allGames = payload.games || [];
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
  view.innerHTML = {
    dashboard: () => renderDashboard(payload, games),
    games: () => renderGamesView(games),
    workflow: () => renderWorkflowView(filteredGame || game),
    lineup: () => renderLineupView(filteredGame || game),
    scoring: () => renderScoringView(filteredGame || game),
    schedule: () => renderScheduleView(games),
    emergency: () => renderEmergencyView(filteredGame || game),
    diagnostics: () => renderDiagnosticsView(filteredGame || game)
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
  if (panel) panel.textContent = `schema: ${payload.schema?.ready ? "ready" : "unavailable"} / feature flag: ${payload.enabled ? "enabled" : "disabled"} / 最終更新: ${formatV3Jst(v3State.lastUpdatedAt)}`;
}

function renderV3(payload) {
  v3State.payload = payload;
  v3State.lastUpdatedAt = new Date();
  renderCurrentV3View();
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
    try { return [key, await v3Fetch(path)]; }
    catch (error) { return [key, { ok: false, errorCode: error.code, error: error.message }]; }
  }));
  v3State.operationDetails.set(id, Object.fromEntries(entries));
  renderCurrentV3View();
}

async function loadV3() {
  setV3Status("読み込み中…");
  try {
    const session = await v3Fetch("/api/admin/me");
    if (!session.admin) throw new Error("管理者権限がありません。");
    const payload = await v3Fetch("/api/admin/v3/overview");
    renderV3(payload);
    await loadV3OperationDetails();
    setV3Status(`${payload.games?.length || 0}試合を表示しました。`);
  } catch (error) {
    setV3Status(`${error.code || "V3_ADMIN_REQUEST_FAILED"}: ${error.message}`, true);
  }
}

async function executeV3UiAction(button, key, operation, successMessage = "操作を完了しました。") {
  if (v3ActionBusy(key)) return;
  v3State.busy.add(key);
  button.disabled = true;
  try {
    await operation();
    setV3Status(successMessage);
    await loadV3();
  } catch (error) {
    setV3Status(`${error.code || "V3_ADMIN_OPERATION_FAILED"}: ${error.message}`, true);
    button.disabled = false;
  } finally {
    v3State.busy.delete(key);
  }
}

function chooseV3View(view) {
  if (!V3_VIEWS.includes(view)) return;
  v3State.view = view;
  updateV3Hash(view, v3State.selectedGameId);
  renderCurrentV3View();
  document.getElementById("v3Navigation")?.classList.remove("open");
  document.getElementById("mobileNavToggle")?.setAttribute("aria-expanded", "false");
}

document.addEventListener("click", async (event) => {
  const navButton = event.target.closest("[data-v3-view]");
  if (navButton) { chooseV3View(navButton.dataset.v3View); return; }
  const selectButton = event.target.closest("[data-v3-select-game]");
  if (selectButton) {
    v3State.selectedGameId = selectButton.dataset.v3SelectGame;
    v3StorageSet("starting9.admin-v3.selected-game", v3State.selectedGameId);
    chooseV3View("workflow");
    await loadV3OperationDetails();
    return;
  }
  if (event.target.closest("#mobileNavToggle")) {
    const navigation = document.getElementById("v3Navigation");
    const open = navigation?.classList.toggle("open");
    event.target.closest("#mobileNavToggle")?.setAttribute("aria-expanded", String(Boolean(open)));
    return;
  }
  const resolveButton = event.target.closest("[data-v3-identity-resolve]");
  if (resolveButton) {
    resolveButton.disabled = true;
    setV3Status("NPB識別情報を自動解決中…");
    try {
      await v3Fetch(`/api/admin/v3/games/${encodeURIComponent(resolveButton.dataset.v3IdentityResolve)}/npb-identity/resolve`, { method: "POST" });
      setV3Status("NPB識別情報を更新しました。");
      await loadV3();
    } catch (error) {
      v3State.identityDiagnostics.set(resolveButton.dataset.v3IdentityResolve, error.details);
      renderV3IdentityDiagnostics(resolveButton.closest(".game-card"), error.details, error.code, error.identityState);
      setV3Status(`${error.code || "NPB_IDENTITY_RESOLUTION_FAILED"}: ${error.message}`, !["pending", "retry_wait"].includes(error.identityState));
      resolveButton.disabled = false;
    }
    return;
  }
  const orientationButton = event.target.closest("[data-v3-orientation-save]");
  if (orientationButton) {
    if (!window.confirm("この操作は試合のhome / away保存値を変更します。続行しますか？")) return;
    const card = orientationButton.closest(".game-card");
    const homeInput = card?.querySelector("[data-v3-home-team]");
    const awayInput = card?.querySelector("[data-v3-away-team]");
    const reasonInput = card?.querySelector("[data-v3-orientation-reason]");
    const status = card?.querySelector("[data-v3-orientation-status]");
    if (!homeInput || !awayInput || !reasonInput || !status) return;
    orientationButton.disabled = true;
    status.textContent = "確認・保存中…";
    try {
      const payload = await v3Fetch(`/api/admin/v3/games/${encodeURIComponent(orientationButton.dataset.v3OrientationSave)}/orientation`, { method: "PATCH", body: JSON.stringify({ homeTeam: homeInput.value, awayTeam: awayInput.value, reason: reasonInput.value }) });
      const impact = Object.entries(payload.impact || {}).filter(([, count]) => Number(count) > 0).map(([table, count]) => `${table}:${count}`).join(", ");
      status.textContent = payload.warning ? `更新しました。関連データあり${impact ? `（${impact}）` : ""}` : "更新しました。";
      await loadV3();
    } catch (error) {
      status.textContent = `${error.code || "V3_ORIENTATION_UPDATE_FAILED"}: ${error.message}`;
      orientationButton.disabled = false;
    }
    return;
  }
  const codeButton = event.target.closest("[data-v3-code-save]");
  if (codeButton) {
    if (!window.confirm("非常用NPBゲームコードを保存します。通常の自動解決値を上書きする可能性があります。続行しますか？")) return;
    const card = codeButton.closest(".game-card");
    const input = card?.querySelector("[data-v3-npb-code]");
    const status = card?.querySelector("[data-v3-code-status]");
    if (!input || !status) return;
    codeButton.disabled = true;
    status.textContent = "保存中…";
    try {
      const payload = await v3Fetch(`/api/admin/v3/games/${encodeURIComponent(codeButton.dataset.v3CodeSave)}/npb-game-code`, { method: "PATCH", body: JSON.stringify({ npbGameCode: input.value }) });
      input.value = payload.game?.npbGameCode || "";
      status.textContent = `更新しました: ${payload.game?.npbGameCode ? `NPB ${payload.game.npbGameCode}` : "未登録"}`;
      await loadV3();
    } catch (error) {
      status.textContent = `${error.code || "V3_NPB_GAME_CODE_UPDATE_FAILED"}: ${error.message}`;
      codeButton.disabled = false;
    }
    return;
  }
  const saveLineupButton = event.target.closest("[data-v3-save-lineup]");
  if (saveLineupButton) {
    const card = saveLineupButton.closest(".v3-panel");
    const reason = card?.querySelector("[data-v3-operation-reason]")?.value || "";
    await executeV3UiAction(saveLineupButton, "lineup-save", async () => {
      await v3Fetch(v3DetailPath("/lineup-revisions"), { method: "POST", body: JSON.stringify({ reason, lineup: readV3LineupEditor(card) }) });
    }, "スタメンrevisionを保存しました。");
    return;
  }
  const finalizeLineupButton = event.target.closest("[data-v3-finalize-lineup]");
  if (finalizeLineupButton) {
    const card = finalizeLineupButton.closest(".v3-panel");
    const reason = card?.querySelector("[data-v3-operation-reason]")?.value || "";
    const revisionId = selectedV3Details().lineup?.currentRevision?.revisionId || "";
    if (!revisionId || !window.confirm("このrevisionを正式スタメンとして確定しますか？")) return;
    await executeV3UiAction(finalizeLineupButton, "lineup-finalize", async () => {
      await v3Fetch(v3DetailPath("/lineup-finalize"), { method: "POST", body: JSON.stringify({ lineupRevisionId: revisionId, reason }) });
    }, "正式スタメンを確定しました。");
    return;
  }
  const scoringPreviewButton = event.target.closest("[data-v3-scoring-preview]");
  if (scoringPreviewButton) {
    const card = scoringPreviewButton.closest(".v3-panel");
    const reason = card?.querySelector("[data-v3-operation-reason]")?.value || "";
    const lineupVersion = selectedV3Details().lineup?.currentRevision?.version;
    await executeV3UiAction(scoringPreviewButton, "scoring-preview", async () => {
      const preview = await v3Fetch(v3DetailPath("/scoring/preview"), { method: "POST", body: JSON.stringify({ reason, lineupVersion }) });
      v3State.rescorePreview = { ...preview, internalGameId: v3State.selectedGameId };
    }, "再採点プレビューを作成しました。");
    return;
  }
  const scoringConfirmButton = event.target.closest("[data-v3-scoring-confirm]");
  if (scoringConfirmButton) {
    const card = scoringConfirmButton.closest(".v3-panel");
    const reason = card?.querySelector("[data-v3-operation-reason]")?.value || "";
    const preview = v3State.rescorePreview?.internalGameId === v3State.selectedGameId ? v3State.rescorePreview : null;
    if (!preview?.previewId || !window.confirm("プレビュー済みの再採点を実行しますか？")) return;
    await executeV3UiAction(scoringConfirmButton, "scoring-confirm", async () => {
      await v3Fetch(v3DetailPath("/scoring/confirm"), { method: "POST", body: JSON.stringify({ reason, lineupVersion: preview.lineupVersion, previewId: preview.previewId }) });
      v3State.rescorePreview = null;
    }, "再採点を実行しました。");
    return;
  }
  const rankingButton = event.target.closest("[data-v3-ranking-rebuild]");
  if (rankingButton) {
    const card = rankingButton.closest(".v3-panel");
    const reason = card?.querySelector("[data-v3-operation-reason]")?.value || "";
    if (!window.confirm("現在の採点revisionをランキングへ反映します。続行しますか？")) return;
    await executeV3UiAction(rankingButton, "ranking-rebuild", async () => {
      await v3Fetch(v3DetailPath("/ranking/rebuild"), { method: "POST", body: JSON.stringify({ reason }) });
    }, "ランキング再構築jobを投入しました。");
    return;
  }
  const publishButton = event.target.closest("[data-v3-publish], [data-v3-republish]");
  if (publishButton) {
    const card = publishButton.closest(".v3-panel");
    const reason = card?.querySelector("[data-v3-operation-reason]")?.value || "";
    const republish = Boolean(publishButton.matches("[data-v3-republish]"));
    if (!window.confirm(republish ? "結果を再公開しますか？" : "結果を公開しますか？")) return;
    await executeV3UiAction(publishButton, republish ? "republish" : "publish", async () => {
      await v3Fetch(v3DetailPath(republish ? "/publication/republish" : "/publication/publish"), { method: "POST", body: JSON.stringify({ reason }) });
    }, republish ? "再公開jobを投入しました。" : "公開jobを投入しました。");
    return;
  }
  const scheduleButton = event.target.closest("[data-v3-schedule-save]");
  if (scheduleButton) {
    const panel = scheduleButton.closest(".v3-panel");
    const startAt = panel?.querySelector("[data-v3-schedule-start]")?.value || "";
    const reason = panel?.querySelector("[data-v3-operation-reason]")?.value || "";
    if (!window.confirm("開始時刻と後続jobの予定を変更します。続行しますか？")) return;
    await executeV3UiAction(scheduleButton, "schedule-save", async () => {
      await v3Fetch(v3DetailPath("/schedule"), { method: "PUT", body: JSON.stringify({ startAt: startAt ? new Date(startAt).toISOString() : "", reason }) });
    }, "日程を保存しました。");
    return;
  }
  const eligibilityButton = event.target.closest("[data-v3-eligibility-save]");
  if (eligibilityButton) {
    const panel = eligibilityButton.closest(".v3-panel");
    const status = panel?.querySelector("[data-v3-eligibility-status]")?.value || "";
    const reason = panel?.querySelector("[data-v3-operation-reason]")?.value || "";
    if (!window.confirm("ランキング対象状態を変更します。続行しますか？")) return;
    await executeV3UiAction(eligibilityButton, "eligibility-save", async () => {
      await v3Fetch(v3DetailPath("/ranking-eligibility"), { method: "PUT", body: JSON.stringify({ status, reason }) });
    }, "ランキング対象状態を保存しました。");
    return;
  }
  const jobCopyButton = event.target.closest("[data-v3-job-copy]");
  if (jobCopyButton) {
    const internalGameId = jobCopyButton.dataset.v3JobCopyGame || "";
    const jobId = jobCopyButton.dataset.v3JobCopyId || "";
    const key = jobDetailKey(internalGameId, jobId);
    const detail = v3State.jobDetails.get(key);
    const job = detail?.job || detail;
    let value = "";
    if (jobCopyButton.dataset.v3JobCopy === "all") value = jobDetailCopyText(internalGameId, detail);
    else if (jobCopyButton.dataset.v3JobCopy === "failureMessage") value = String(jobField(job, "failure_message", "failureMessage", ""));
    else {
      const field = JOB_DETAIL_FIELDS.find((item) => item[1] === jobCopyButton.dataset.v3JobCopy);
      value = field ? jobField(job, field[0], field[1], field[0] === "job_id" ? job?.id : field[0] === "internal_game_id" ? internalGameId : "") : "";
    }
    try {
      await copyTextSafely(value);
      v3State.jobDetailsCopyStatus.set(key, "コピーしました");
      const status = jobCopyButton.closest(".job-detail-inline")?.querySelector(".job-copy-status");
      if (status) status.textContent = "コピーしました";
    } catch (error) {
      v3State.jobDetailsCopyStatus.set(key, "コピーできませんでした");
      const status = jobCopyButton.closest(".job-detail-inline")?.querySelector(".job-copy-status");
      if (status) status.textContent = "コピーできませんでした";
    }
    return;
  }
  const jobDetailRefreshButton = event.target.closest("[data-v3-job-detail-refresh]");
  if (jobDetailRefreshButton) {
    await loadV3JobDetail(jobDetailRefreshButton.dataset.v3JobDetailRefresh, jobDetailRefreshButton.dataset.v3JobDetailRefreshId, true);
    return;
  }
  const jobDetailButton = event.target.closest("[data-v3-job-detail]");
  if (jobDetailButton) {
    const internalGameId = jobDetailButton.dataset.v3JobDetail;
    const jobId = jobDetailButton.dataset.v3JobId;
    const key = jobDetailKey(internalGameId, jobId);
    if (v3State.jobDetailsOpen.has(key)) {
      v3State.jobDetailsOpen.delete(key);
      renderCurrentV3View();
      return;
    }
    v3State.jobDetailsOpen.add(key);
    renderCurrentV3View();
    await loadV3JobDetail(internalGameId, jobId);
    return;
  }
  const jobOperationButton = event.target.closest("[data-v3-job-retry], [data-v3-job-cancel]");
  if (jobOperationButton) {
    const reason = window.prompt("job操作理由を入力してください。", "管理者確認後の操作") || "";
    if (!reason) return;
    const action = jobOperationButton.matches("[data-v3-job-retry]") ? "retry" : "cancel";
    await executeV3UiAction(jobOperationButton, `job-${action}-${jobOperationButton.dataset.v3JobRetry || jobOperationButton.dataset.v3JobCancel}`, async () => {
      await v3Fetch(v3DetailPath(`/jobs/${encodeURIComponent(jobOperationButton.dataset.v3JobRetry || jobOperationButton.dataset.v3JobCancel)}/${action}`), { method: "POST", body: JSON.stringify({ reason }) });
    }, action === "retry" ? "jobを再試行可能状態へ戻しました。" : "jobを取消しました。");
    return;
  }
  const jobButton = event.target.closest("[data-v3-job]");
  if (!jobButton) return;
  if (!window.confirm("このjobを再投入します。実行状態を確認してから続行しますか？")) return;
  jobButton.disabled = true;
  try {
    await v3Fetch(`/api/admin/v3/games/${encodeURIComponent(jobButton.dataset.v3Job)}/jobs`, { method: "POST", body: JSON.stringify({ jobType: jobButton.dataset.v3Type, scheduledSlotAt: new Date().toISOString() }) });
    setV3Status("V3ジョブを投入しました。");
    await loadV3();
  } catch (error) {
    setV3Status(`${error.code || "V3_ADMIN_REQUEST_FAILED"}: ${error.message}`, true);
    jobButton.disabled = false;
  }
});

document.getElementById("refreshV3")?.addEventListener("click", loadV3);
document.getElementById("refreshV3View")?.addEventListener("click", loadV3);
document.getElementById("v3GameFilter")?.addEventListener("change", (event) => {
  v3State.filter = event.target.value;
  renderCurrentV3View();
});
document.getElementById("v3GameSelect")?.addEventListener("change", (event) => {
  v3State.selectedGameId = event.target.value;
  v3StorageSet("starting9.admin-v3.selected-game", v3State.selectedGameId);
  updateV3Hash(v3State.view, v3State.selectedGameId);
  renderCurrentV3View();
  loadV3OperationDetails();
});
window.addEventListener("hashchange", () => {
  const hash = readV3Hash();
  v3State.view = hash.view;
  if (hash.gameId) v3State.selectedGameId = hash.gameId;
  renderCurrentV3View();
  loadV3OperationDetails();
});

const initialV3Hash = readV3Hash();
v3State.view = initialV3Hash.view;
v3State.selectedGameId = initialV3Hash.gameId;
loadV3();
