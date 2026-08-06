const V3_AUTH_PRODUCTION_BASE = "https://starting9-auth.tanzana7.workers.dev";
const V3_JOB_TYPES = ["npb_identity_resolve", "prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish", "probable_starter_fetch", "roster_fetch"];
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
  identityDiagnostics: new Map()
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

function renderGameSummary(game, buttonLabel = "試合進行を見る") {
  const next = nextV3Job(game);
  const identity = identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState);
  return `<article class="game-card"><div class="game-heading"><h3>${escapeV3(gameDateForFilter(game))} ${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}</h3>${gameHasAttention(game) ? "<span class=attention-badge>要対応</span>" : ""}</div><div class="game-meta"><span>開始 ${escapeV3(formatV3Jst(game.startAt, false))} JST</span><span>state: ${escapeV3(game.state?.state || "scheduled")}</span><span>NPB: ${escapeV3(identity)}</span><span>次: ${escapeV3(next ? `${V3_JOB_LABELS[next.job_type] || next.job_type} ${formatV3Jst(next.scheduled_at)}` : "なし")}</span></div><div class="game-card-actions"><button type="button" data-v3-select-game="${escapeV3(game.internalGameId)}">${escapeV3(buttonLabel)}</button></div></article>`;
}

function timelineStep(name, job, fallbackStatus, detail = "", scheduledAt = "") {
  const status = job ? String(job.status) : fallbackStatus;
  const klass = job ? statusClass(status) : statusClass(fallbackStatus);
  const label = job ? statusLabel(status) : ({ complete: "完了", scheduled: "予定", wait: "待機中", action: "要対応" }[fallbackStatus] || "待機中");
  const time = job ? (status === "retry_wait" ? job.next_retry_at : job.scheduled_at) : scheduledAt;
  const failure = job?.failure_code ? ` / ${job.failure_code}` : "";
  return `<article class="timeline-step ${klass}"><span class="status-badge ${klass === "complete" ? "ok" : klass === "retry" ? "retry" : klass === "failed" || klass === "action" ? "action" : klass === "excluded" ? "excluded" : "wait"}">${escapeV3(label)}</span><h4>${escapeV3(name)}</h4><p class="step-time">${escapeV3(time ? formatV3Jst(time) : "予定未定")}</p><p>${escapeV3(detail || failure || (job ? `試行 ${job.attempt_count || 0}/${job.max_attempts || 0}` : ""))}</p></article>`;
}

function renderTimeline(game) {
  const schedule = game.startAt;
  const state = String(game.state?.state || "scheduled");
  const identityStatus = String(game.npbIdentityStatus || "");
  const identityState = String(game.npbIdentityState || "");
  const identityJob = latestV3Job(game, "npb_identity_resolve");
  const identityFallback = identityStatus === "resolved" || identityStatus === "manually_overridden" ? "complete" : identityState === "manual_action_required" ? "action" : identityState === "retry_wait" ? "retry" : "scheduled";
  const predictionJob = latestV3Job(game, "prediction_close");
  const lineupJob = latestV3Job(game, "lineup_fetch");
  const finalizeJob = latestV3Job(game, "lineup_finalize");
  const rosterJob = latestV3Job(game, "roster_fetch");
  const scoreJob = latestV3Job(game, "score");
  const rankingJob = latestV3Job(game, "ranking_rebuild");
  const publishJob = latestV3Job(game, "publish");
  const steps = [
    timelineStep("日程登録", null, "complete", "games登録済み", schedule),
    timelineStep("予告先発取得", latestV3Job(game, "probable_starter_fetch"), "wait"),
    timelineStep("ロースター取得", rosterJob, "wait", rosterJob?.failure_code || "取得履歴を集約表示"),
    timelineStep("予想締切", predictionJob, state === "scheduled" ? "scheduled" : "complete", "締切は開始時刻から算出", schedule),
    timelineStep("NPB識別情報解決", identityJob, identityFallback, identityStatusLabel(game.npbIdentityStatus, identityState)),
    timelineStep("スタメン取得", lineupJob, identityStatus ? "scheduled" : "wait"),
    timelineStep("正式スタメン確定", finalizeJob, state === "lineup_ready" || state === "scored" || state === "ranked" || state === "published" ? "complete" : "scheduled"),
    timelineStep("採点", scoreJob, ["scored", "ranked", "published"].includes(state) ? "complete" : "scheduled"),
    timelineStep("ランキング反映", rankingJob, ["ranked", "published"].includes(state) ? "complete" : "scheduled"),
    timelineStep("結果公開", publishJob, state === "published" ? "complete" : "scheduled")
  ];
  return `<div class="timeline">${steps.join("")}</div>`;
}

function renderRosterSummary(game) {
  const job = latestV3Job(game, "roster_fetch");
  return `<div class="roster-summary"><div><strong>最終成功</strong><span>${escapeV3(job?.status === "completed" ? formatV3Jst(job.completed_at || job.updated_at) : "-")}</span></div><div><strong>次回取得予定</strong><span>${escapeV3(job ? formatV3Jst(job.next_retry_at || job.scheduled_at) : "予定未定")}</span></div><div><strong>取得元・結果</strong><span>${escapeV3(job ? `${job.failure_code || "V3 job"} / ${statusLabel(job.status)}` : "履歴なし")}</span></div><div><strong>試行</strong><span>${escapeV3(job ? `${job.attempt_count || 0}/${job.max_attempts || 0}` : "-")}</span></div></div>`;
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
  return `<div class="view-heading"><div><h2>ダッシュボード</h2><p>本日の試合と要対応項目を最初に確認できます。</p></div></div><section class="today-card"><h3>本日の試合</h3>${cards}</section><section class="summary-grid">${renderSummaryCard("要対応", attention, attention ? "attention" : "ok")}${renderSummaryCard("失敗job", failed, failed ? "error" : "ok")}${renderSummaryCard("retry_wait", retry, retry ? "attention" : "ok")}${renderSummaryCard("掲載待ち", pendingIdentity, pendingIdentity ? "attention" : "ok")}${renderSummaryCard("本日の完了job", completedToday)}${renderSummaryCard("公開待ち", publicationWait, publicationWait ? "attention" : "ok")}</section><section class="v3-panel"><div class="view-heading"><div><h3>今日の自動処理</h3><p>詳細は試合進行メニューから確認できます。</p></div></div>${todayGames.length ? todayGames.map((game) => `<div class="compact-meta"><strong>${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}</strong><span>次: ${escapeV3(nextV3Job(game)?.job_type ? V3_JOB_LABELS[nextV3Job(game).job_type] : "なし")}</span><span>${escapeV3(gameHasAttention(game) ? "要対応" : "正常")}</span></div>`).join("") : "<span class=muted>今日の処理履歴はありません。</span>"}</section>`;
}

function renderGamesView(games) {
  const rows = games.map((game) => `<tr><td>${escapeV3(gameDateForFilter(game))}</td><td>${escapeV3(formatV3Jst(game.startAt, false))}</td><td>${escapeV3(game.homeTeam)}</td><td>${escapeV3(game.awayTeam)}</td><td>${escapeV3(game.state?.state || "scheduled")}</td><td>${escapeV3(identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState))}</td><td>${escapeV3(nextV3Job(game)?.job_type ? V3_JOB_LABELS[nextV3Job(game).job_type] : "-")}</td><td>${gameHasAttention(game) ? "<span class=attention-badge>要対応</span>" : "<span class=\"status-badge ok\">正常</span>"}</td><td><button type="button" data-v3-select-game="${escapeV3(game.internalGameId)}">詳細</button></td></tr>`).join("");
  return `<div class="view-heading"><div><h2>試合一覧</h2><p>日付、進行状態、次の処理を比較します。</p></div></div><div class="games-table-wrap"><table class="games-table"><thead><tr><th>日付</th><th>開始</th><th>home</th><th>away</th><th>state</th><th>NPB</th><th>次の処理</th><th>対応</th><th></th></tr></thead><tbody>${rows || "<tr><td colspan=9>対象試合はありません。</td></tr>"}</tbody></table></div>`;
}

function renderSelectedGameHeader(game, title, description = "") {
  if (!game) return `<div class="today-empty">対象試合を選択してください。</div>`;
  return `<div class="view-heading"><div><h2>${escapeV3(title)}</h2><p>${escapeV3(description)}</p></div><div class="compact-meta"><strong>${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}</strong><span>${escapeV3(formatV3Jst(game.startAt))} JST</span></div></div>`;
}

function renderWorkflowView(game) {
  if (!game) return renderSelectedGameHeader(null, "試合進行");
  const next = nextV3Job(game);
  return `${renderSelectedGameHeader(game, "試合進行", "10段階のコンパクトなタイムラインで、試合単位の自動処理を追跡します。")}<section class="v3-panel"><div class="compact-meta"><span>現在: <strong>${escapeV3(game.state?.state || "scheduled")}</strong></span><span>次の処理: <strong>${escapeV3(next ? V3_JOB_LABELS[next.job_type] || next.job_type : "なし")}</strong></span><span>NPB識別: <strong>${escapeV3(identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState))}</strong></span></div>${renderTimeline(game)}<details class="roster-details"><summary>ロースター取得の詳細</summary>${renderRosterSummary(game)}</details></section>`;
}

function renderJobRows(game, types) {
  const jobs = latestV3Jobs(game, types);
  return jobs.length ? `<div class="job-list">${jobs.map((job) => `<div class="job"><code>${escapeV3(V3_JOB_LABELS[job.job_type] || job.job_type)}</code><span class="job-status">${escapeV3(statusLabel(job.status))}</span><span>${escapeV3(job.failure_code || `試行 ${job.attempt_count || 0}/${job.max_attempts || 0}`)}<br><small>予定 ${escapeV3(formatV3Jst(job.scheduled_at))}</small></span><button type="button" data-v3-job="${escapeV3(game.internalGameId)}" data-v3-type="${escapeV3(job.job_type)}">再投入</button></div>`).join("")}</div>` : "<span class=muted>該当jobの履歴はありません。</span>";
}

function renderLineupView(game) {
  if (!game) return renderSelectedGameHeader(null, "スタメン");
  return `${renderSelectedGameHeader(game, "スタメン", "取得・確定jobと利用可能な状態を確認します。詳細なrevision履歴は診断・監査から開けます。")}<section class="v3-panel"><div class="detail-grid"><div><dt>最新lineup revision</dt><dd>overview APIでは未提供</dd></div><div><dt>正式確定revision</dt><dd>${escapeV3(["scored", "ranked", "published"].includes(game.state?.state) ? "確定済み" : "未確定")}</dd></div><div><dt>source / fetchedAt</dt><dd>${escapeV3(latestV3Job(game, "lineup_fetch")?.completed_at ? `V3 / ${formatV3Jst(latestV3Job(game, "lineup_fetch").completed_at)}` : "-")}</dd></div><div><dt>NPB識別</dt><dd>${escapeV3(identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState))}</dd></div><div><dt>finalizedAt</dt><dd>${escapeV3(formatV3Jst(latestV3Job(game, "lineup_finalize")?.completed_at))}</dd></div><div><dt>1〜9番</dt><dd>既存lineup APIの表示領域</dd></div></div><h3>取得・確定job</h3>${renderJobRows(game, ["lineup_fetch", "lineup_finalize"])}</section>`;
}

function renderScoringView(game) {
  if (!game) return renderSelectedGameHeader(null, "採点・ランキング");
  const state = String(game.state?.state || "scheduled");
  return `${renderSelectedGameHeader(game, "採点・ランキング", "採点、ランキング反映、結果公開の状態を分けて確認します。")}<section class="v3-panel"><div class="detail-grid"><div><dt>scoring revision</dt><dd>${escapeV3(["scored", "ranked", "published"].includes(state) ? "完了" : "待機")}</dd></div><div><dt>active revision</dt><dd>${escapeV3(state === "published" ? "公開中" : "-")}</dd></div><div><dt>lineup revision</dt><dd>${escapeV3(state === "scheduled" || state === "prediction_closed" ? "未確定" : "確定済み")}</dd></div><div><dt>対象予想数</dt><dd>overview APIでは未提供</dd></div><div><dt>採点済み / 対象外</dt><dd>${escapeV3(state === "scored" || state === "ranked" || state === "published" ? "採点済み" : "-")}</dd></div><div><dt>publication</dt><dd>${escapeV3(state === "published" ? "公開済み" : "待機")}</dd></div></div><h3>処理job</h3>${renderJobRows(game, ["score", "ranking_rebuild", "publish"])}<div class="muted">危険操作は緊急操作メニューへ分離しています。</div></section>`;
}

function renderScheduleView(games) {
  return `<div class="view-heading"><div><h2>日程管理</h2><p>既存overview APIの読み取り情報だけを表示します。</p></div></div><div class="games-table-wrap"><table class="games-table"><thead><tr><th>日付</th><th>開始</th><th>home</th><th>away</th><th>NPB識別</th><th>game status</th><th>ranking eligibility</th></tr></thead><tbody>${games.map((game) => `<tr><td>${escapeV3(gameDateForFilter(game))}</td><td>${escapeV3(formatV3Jst(game.startAt, false))} JST</td><td>${escapeV3(game.homeTeam)}</td><td>${escapeV3(game.awayTeam)}</td><td>${escapeV3(identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState))}</td><td>${escapeV3(game.gameStatus || "scheduled")}</td><td>${escapeV3(game.isActive === 0 ? "対象外" : "有効")}</td></tr>`).join("") || "<tr><td colspan=7>対象試合はありません。</td></tr>"}</tbody></table></div>`;
}

function renderGameControls(game, includeDiagnostics = false) {
  if (!game) return "<div class=today-empty>対象試合を選択してください。</div>";
  const npbGameCode = String(game.npbGameCode || "");
  const identityJob = latestV3Job(game, "npb_identity_resolve");
  const jobs = (game.jobs || []).map((job) => `<div class="job"><code>${escapeV3(job.job_type)}</code><span class="job-status">${escapeV3(statusLabel(job.status))}</span><span>${escapeV3(job.failure_code || `試行 ${job.attempt_count || 0}/${job.max_attempts || 0}`)}</span><button type="button" data-v3-job="${escapeV3(game.internalGameId)}" data-v3-type="${escapeV3(job.job_type)}">再投入</button></div>`).join("");
  const identityDiagnostics = v3State.identityDiagnostics.get(game.internalGameId);
  return `<article class="game-card"><div class="game-heading"><h3>${escapeV3(gameDateForFilter(game))} ${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}</h3><code>${escapeV3(game.internalGameId)}</code></div><div class="game-meta"><span>開始 ${escapeV3(formatV3Jst(game.startAt))} JST</span><span>DB home: ${escapeV3(game.homeTeam)}</span><span>DB away: ${escapeV3(game.awayTeam)}</span><span class="npb-identity-status">NPB識別情報: ${escapeV3(identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState))}</span><span>コード ${escapeV3(npbGameCode || "未登録")}</span><span class="state">state: ${escapeV3(game.state?.state || "scheduled")}</span></div><div class="npb-identity-details"><span>解決元: ${escapeV3(game.npbIdentitySource || "-")}</span><span>解決時刻: ${escapeV3(formatV3Jst(game.npbIdentityResolvedAt))}</span><span>URL: ${game.npbGameUrl ? `<a href="${escapeV3(game.npbGameUrl)}" target="_blank" rel="noreferrer">${escapeV3(game.npbGameUrl)}</a>` : "-"}</span><button type="button" data-v3-identity-resolve="${escapeV3(game.internalGameId)}">手動再解決</button></div><div class="npb-identity-auto-job"><strong>NPB自動解決job</strong><span>次回予定: ${escapeV3(identityJob ? formatV3Jst(identityJob.status === "retry_wait" ? identityJob.next_retry_at : identityJob.scheduled_at) : "未作成")}</span><span>最終実行: ${escapeV3(formatV3Jst(identityJob?.completed_at || identityJob?.updated_at))}</span><span>次回retry: ${escapeV3(formatV3Jst(identityJob?.next_retry_at))}</span><span>結果: ${escapeV3(identityJob?.failure_code || identityJob?.status || "-")}</span><span>試行: ${escapeV3(identityJob ? `${identityJob.attempt_count || 0}/${identityJob.max_attempts || 0}` : "-")}</span></div><div class="v3-orientation-editor"><strong>home / away修正（DB値確認後のみ）</strong><label>home <input type="text" value="${escapeV3(game.homeTeam)}" data-v3-home-team></label><label>away <input type="text" value="${escapeV3(game.awayTeam)}" data-v3-away-team></label><input type="text" maxlength="240" placeholder="修正理由（必須）" data-v3-orientation-reason><button type="button" data-v3-orientation-save="${escapeV3(game.internalGameId)}">向きを保存</button><span class="v3-orientation-status" data-v3-orientation-status></span></div><div class="npb-code-editor"><strong>非常用手動上書き</strong><label>NPBゲームコード <input type="text" maxlength="32" value="${escapeV3(npbGameCode)}" data-v3-npb-code><button type="button" data-v3-code-save="${escapeV3(game.internalGameId)}">保存</button></label><span class="npb-code-status" data-v3-code-status></span></div>${includeDiagnostics ? `<div class="npb-identity-diagnostics" data-v3-identity-diagnostics></div>` : ""}<div class="job-list">${jobs || "<span class=muted>ジョブなし</span>"}</div></article>`;
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

async function loadV3() {
  setV3Status("読み込み中…");
  try {
    const session = await v3Fetch("/api/admin/me");
    if (!session.admin) throw new Error("管理者権限がありません。");
    const payload = await v3Fetch("/api/admin/v3/overview");
    renderV3(payload);
    setV3Status(`${payload.games?.length || 0}試合を表示しました。`);
  } catch (error) {
    setV3Status(`${error.code || "V3_ADMIN_REQUEST_FAILED"}: ${error.message}`, true);
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
});
window.addEventListener("hashchange", () => {
  const hash = readV3Hash();
  v3State.view = hash.view;
  if (hash.gameId) v3State.selectedGameId = hash.gameId;
  renderCurrentV3View();
});

const initialV3Hash = readV3Hash();
v3State.view = initialV3Hash.view;
v3State.selectedGameId = initialV3Hash.gameId;
loadV3();
