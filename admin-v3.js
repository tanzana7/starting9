const V3_AUTH_PRODUCTION_BASE = "https://starting9-auth.tanzana7.workers.dev";
const V3_JOB_TYPES = ["prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish", "probable_starter_fetch", "roster_fetch"];

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

function renderV3(payload) {
  const schema = document.getElementById("v3Schema");
  schema.textContent = `schema: ${payload.schema.ready ? "ready" : "unavailable"} / feature flag: ${payload.enabled ? "enabled" : "disabled"}`;
  const container = document.getElementById("v3Games");
  container.textContent = "";
  for (const game of payload.games || []) {
    const card = document.createElement("article");
    card.className = "game-card";
    const npbGameCode = String(game.npbGameCode || "");
    const jobs = (game.jobs || []).map((job) => {
      const select = V3_JOB_TYPES.map((type) => `<option value="${type}">${type}</option>`).join("");
      return `<div class="job"><code>${escapeV3(job.job_type)}</code><span class="job-status">${escapeV3(job.status)}</span><span>${escapeV3(job.failure_code || `attempt ${job.attempt_count}/${job.max_attempts}`)}</span><button type="button" data-v3-job="${escapeV3(game.internalGameId)}" data-v3-type="${escapeV3(job.job_type)}">再投入</button></div>`;
    }).join("");
    card.innerHTML = `<div class="game-heading"><h2>${escapeV3(game.gameDate)} ${escapeV3(game.awayTeam)} vs ${escapeV3(game.homeTeam)}</h2><code>${escapeV3(game.internalGameId)}</code></div><div class="game-meta"><span>開始 ${escapeV3(game.startAt)}</span><span>NPB ${escapeV3(npbGameCode || "未登録")}</span><span class="state">state: ${escapeV3(game.state.state)}</span></div><div class="npb-code-editor"><label>NPBゲームコード <input type="text" maxlength="32" value="${escapeV3(npbGameCode)}" data-v3-npb-code><button type="button" data-v3-code-save="${escapeV3(game.internalGameId)}">保存</button></label><span class="npb-code-status" data-v3-code-status></span></div><div class="job-list">${jobs || "<span class=muted>ジョブなし</span>"}</div>`;
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
