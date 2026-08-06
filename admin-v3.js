const V3_AUTH_PRODUCTION_BASE = "https://starting9-auth.tanzana7.workers.dev";
const V3_JOB_TYPES = ["npb_identity_resolve", "prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish", "probable_starter_fetch", "roster_fetch"];

function v3ApiBase() {
  return ["localhost", "127.0.0.1"].includes(window.location.hostname) ? "http://127.0.0.1:8787" : V3_AUTH_PRODUCTION_BASE;
}

async function v3Fetch(path, options = {}) {
  const response = await fetch(`${v3ApiBase()}${path}`, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
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
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function escapeV3(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function identityStatusLabel(status, state) {
  if (state === "pending") return "掲載待ち";
  if (state === "retry_wait") return "取得待ち";
  if (state === "manual_action_required") return "確認が必要";
  return {
    resolved: "自動解決済み",
    unresolved: "確認が必要",
    manually_overridden: "管理者上書き"
  }[String(status || "unresolved")] || "未解決";
}

function renderV3IdentityDiagnostics(card, diagnostics, failureCode = "", identityState = "") {
  const panel = card?.querySelector("[data-v3-identity-diagnostics]");
  if (!panel) return;
  if (!diagnostics) {
    panel.textContent = "";
    return;
  }
  const fields = [
    ["internalGameId", diagnostics.internalGameId],
    ["fetchEndpoint", diagnostics.fetchEndpoint],
    ["fetchHttpStatus", diagnostics.fetchHttpStatus],
    ["responseContentType", diagnostics.responseContentType],
    ["rawCandidateCount", diagnostics.rawCandidateCount],
    ["parsedCandidateCount", diagnostics.parsedCandidateCount],
    ["staticCandidateCount", diagnostics.staticCandidateCount],
    ["mergedCandidateCount", diagnostics.mergedCandidateCount],
    ["targetGameDateJst", diagnostics.targetGameDateJst],
    ["targetHomeTeam", diagnostics.targetHomeTeam],
    ["targetAwayTeam", diagnostics.targetAwayTeam],
    ["targetStartTimeJst", diagnostics.targetStartTimeJst],
    ["matchCount", diagnostics.matchCount],
    ["finalFailureCode", diagnostics.finalFailureCode || failureCode],
    ["identityState", identityState]
  ];
  const fieldMarkup = fields.map(([name, value]) => `<div><dt>${escapeV3(name)}</dt><dd>${escapeV3(value ?? "-")}</dd></div>`).join("");
  const candidates = Array.isArray(diagnostics.candidates) ? diagnostics.candidates.slice(0, 10) : [];
  const candidateMarkup = candidates.map((candidate, index) => `<article><strong>#${index + 1} ${escapeV3(candidate.source || "-")}</strong><dl><div><dt>date</dt><dd>${escapeV3(candidate.rawDate || "-")} → ${escapeV3(candidate.normalizedDate || "-")}</dd></div><div><dt>home</dt><dd>${escapeV3(candidate.rawHome || candidate.rawHomeTeam || "-")} → ${escapeV3(candidate.normalizedHome || candidate.normalizedHomeTeam || "-")}</dd></div><div><dt>away</dt><dd>${escapeV3(candidate.rawAway || candidate.rawAwayTeam || "-")} → ${escapeV3(candidate.normalizedAway || candidate.normalizedAwayTeam || "-")}</dd></div><div><dt>start</dt><dd>${escapeV3(candidate.rawStartTime || candidate.startTime || "-")} → ${escapeV3(candidate.normalizedStartTime || "-")}</dd></div><div><dt>identity</dt><dd>code:${candidate.gameCodePresent ? "あり" : "なし"} / URL:${candidate.urlPresent ? "あり" : "なし"}</dd></div><div><dt>rejection</dt><dd>${escapeV3((candidate.rejectionReasons || []).join(", ") || "-")}</dd></div></dl></article>`).join("");
  panel.innerHTML = `<details open><summary>NPB解決診断</summary><dl class="npb-diagnostic-grid">${fieldMarkup}</dl><div class="npb-diagnostic-candidates"><strong>候補（最大10件）</strong>${candidateMarkup || "<span class=muted>候補なし</span>"}</div></details>`;
}

function renderV3(payload) {
  const schema = document.getElementById("v3Schema");
  schema.textContent = `schema: ${payload.schema.ready ? "ready" : "unavailable"} / feature flag: ${payload.enabled ? "enabled" : "disabled"}`;
  const container = document.getElementById("v3Games");
  container.textContent = "";
  for (const game of payload.games || []) {
    const card = document.createElement("article");
    card.className = "game-card";
    const npbGameCode = String(game.npbGameCode || "");
    const identityStatus = identityStatusLabel(game.npbIdentityStatus, game.npbIdentityState);
    const identityJob = [...(game.jobs || [])].reverse().find((job) => job.job_type === "npb_identity_resolve");
    const identityJobMarkup = identityJob
      ? `<div class="npb-identity-auto-job"><strong>NPB自動解決ジョブ</strong><span>次回予定: ${escapeV3(identityJob.status === "retry_wait" ? identityJob.next_retry_at : identityJob.scheduled_at)}</span><span>最終実行: ${escapeV3(identityJob.completed_at || identityJob.updated_at || "-")}</span><span>結果: ${escapeV3(identityJob.failure_code || identityJob.status)}</span><span>試行: ${escapeV3(identityJob.attempt_count)}/${escapeV3(identityJob.max_attempts)}</span><span>次回retry: ${escapeV3(identityJob.next_retry_at || "-")}</span></div>`
      : `<div class="npb-identity-auto-job muted">NPB自動解決ジョブ: 未作成</div>`;
    const jobs = (game.jobs || []).map((job) => {
      const select = V3_JOB_TYPES.map((type) => `<option value="${type}">${type}</option>`).join("");
      return `<div class="job"><code>${escapeV3(job.job_type)}</code><span class="job-status">${escapeV3(job.status)}</span><span>${escapeV3(job.failure_code || `attempt ${job.attempt_count}/${job.max_attempts}`)}</span><button type="button" data-v3-job="${escapeV3(game.internalGameId)}" data-v3-type="${escapeV3(job.job_type)}">再投入</button></div>`;
    }).join("");
    card.innerHTML = `<div class="game-heading"><h2>${escapeV3(game.gameDate)} ${escapeV3(game.homeTeam)} vs ${escapeV3(game.awayTeam)}</h2><code>${escapeV3(game.internalGameId)}</code></div><div class="game-meta"><span>開始 ${escapeV3(game.startAt)}</span><span>DB home: ${escapeV3(game.homeTeam)}</span><span>DB away: ${escapeV3(game.awayTeam)}</span><span class="npb-identity-status">NPB識別情報: ${escapeV3(identityStatus)}</span><span>コード ${escapeV3(npbGameCode || "未登録")}</span><span class="state">state: ${escapeV3(game.state.state)}</span></div><div class="npb-identity-details"><span>解決元: ${escapeV3(game.npbIdentitySource || "-")}</span><span>解決時刻: ${escapeV3(game.npbIdentityResolvedAt || "-")}</span><span>URL: ${game.npbGameUrl ? `<a href="${escapeV3(game.npbGameUrl)}" target="_blank" rel="noreferrer">${escapeV3(game.npbGameUrl)}</a>` : "-"}</span><button type="button" data-v3-identity-resolve="${escapeV3(game.internalGameId)}">手動再解決</button></div>${identityJobMarkup}<div class="v3-orientation-editor"><strong>home / away修正（DB値確認後のみ）</strong><label>home <input type="text" value="${escapeV3(game.homeTeam)}" data-v3-home-team></label><label>away <input type="text" value="${escapeV3(game.awayTeam)}" data-v3-away-team></label><input type="text" maxlength="240" placeholder="修正理由（必須）" data-v3-orientation-reason><button type="button" data-v3-orientation-save="${escapeV3(game.internalGameId)}">向きを保存</button><span class="v3-orientation-status" data-v3-orientation-status></span></div><div class="npb-identity-diagnostics" data-v3-identity-diagnostics></div><div class="npb-code-editor"><strong>非常用手動上書き</strong><label>NPBゲームコード <input type="text" maxlength="32" value="${escapeV3(npbGameCode)}" data-v3-npb-code><button type="button" data-v3-code-save="${escapeV3(game.internalGameId)}">保存</button></label><span class="npb-code-status" data-v3-code-status></span></div><div class="job-list">${jobs || "<span class=muted>ジョブなし</span>"}</div>`;
    container.append(card);
  }
}

async function loadV3() {
  setV3Status("読み込み中…");
  try {
    const session = await v3Fetch("/api/admin/me");
    if (!session.admin) throw new Error("管理者権限がありません。");
    const payload = await v3Fetch("/api/admin/v3/overview");
    renderV3(payload);
    setV3Status(`${payload.games.length}試合を表示しました。`);
  } catch (error) {
    setV3Status(`${error.code || "V3_ADMIN_REQUEST_FAILED"}: ${error.message}`, true);
  }
}

document.addEventListener("click", async (event) => {
  const resolveButton = event.target.closest("[data-v3-identity-resolve]");
  if (resolveButton) {
    resolveButton.disabled = true;
    setV3Status("NPB識別情報を自動解決中…");
    try {
      await v3Fetch(`/api/admin/v3/games/${encodeURIComponent(resolveButton.dataset.v3IdentityResolve)}/npb-identity/resolve`, { method: "POST" });
      setV3Status("NPB識別情報を更新しました。");
      await loadV3();
    } catch (error) {
      renderV3IdentityDiagnostics(resolveButton.closest(".game-card"), error.details, error.code, error.identityState);
      setV3Status(`${error.code || "NPB_IDENTITY_RESOLUTION_FAILED"}: ${error.message}`, !["pending", "retry_wait"].includes(error.identityState));
      resolveButton.disabled = false;
    }
    return;
  }
  const orientationButton = event.target.closest("[data-v3-orientation-save]");
  if (orientationButton) {
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
  const button = event.target.closest("[data-v3-job]");
  if (!button) return;
  button.disabled = true;
  try {
    await v3Fetch(`/api/admin/v3/games/${encodeURIComponent(button.dataset.v3Job)}/jobs`, { method: "POST", body: JSON.stringify({ jobType: button.dataset.v3Type, scheduledSlotAt: new Date().toISOString() }) });
    setV3Status("V3ジョブを投入しました。");
    await loadV3();
  } catch (error) {
    setV3Status(`${error.code || "V3_ADMIN_REQUEST_FAILED"}: ${error.message}`, true);
    button.disabled = false;
  }
});
document.getElementById("refreshV3").addEventListener("click", loadV3);
loadV3();
