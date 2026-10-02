const state = { user: null, game: null, operationPending: false };
const $ = (id) => document.getElementById(id);
const API_PREFIX = "/api/asia-cs";
const message = (id, text, error = false) => { const node = $(id); node.textContent = text; node.classList.toggle("error", error); };
const operationButtons = ["confirmLineup", "scoreGame", "rankingGame", "publishGame", "rescoreGame"];
function setOperationPending(pending) {
  state.operationPending = pending;
  operationButtons.forEach((id) => { const button = $(id); if (button) button.disabled = pending; });
  const status = $("operationStatus");
  if (status) status.setAttribute("aria-busy", String(pending));
}
async function api(path, options = {}) { const apiPath = String(path).replace(/^\/api/, API_PREFIX); const response = await fetch(apiPath, { credentials: "include", cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } }); const payload = await response.json().catch(() => ({})); if (!response.ok || payload.ok === false) throw new Error(payload.error || "処理に失敗しました。"); return payload; }
function gameId() { return String($("gameId").value || "").trim(); }
function asIso(localValue) { const date = new Date(localValue); return Number.isNaN(date.getTime()) ? "" : date.toISOString(); }
function showAdmin() { document.querySelectorAll(".admin-only").forEach((node) => node.classList.remove("hidden")); }
function renderRoster(players) { $("rosterJson").value = JSON.stringify(players.map((player) => ({ id: player.id, name: player.name, uniformNumber: player.uniformNumber, team: player.team, teamId: player.teamId, active: player.active })), null, 2); }
function renderDetail(payload) { state.game = payload.game; renderRoster(payload.game.players); $("gameDetail").textContent = JSON.stringify(payload, null, 2); if (payload.currentLineup) { $("lineupJson").value = JSON.stringify(payload.currentLineup.lineup, null, 2); $("rescoreJson").value = JSON.stringify(payload.currentLineup.lineup, null, 2); } }
async function loadGame() { const id = gameId(); if (!id) return; try { renderDetail(await api(`/api/admin/games/${encodeURIComponent(id)}`)); message("gameStatus", "読み込みました。"); } catch (error) { message("gameStatus", error.message, true); } }

$("gameForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const data = Object.fromEntries(new FormData(event.currentTarget)); data.startAt = asIso(data.startAt); data.predictionDeadlineAt = asIso(data.predictionDeadlineAt); const payload = await api("/api/admin/games", { method: "POST", body: JSON.stringify(data) }); $("gameId").value = payload.game.id; message("gameStatus", "試合を登録しました。"); await loadGame(); } catch (error) { message("gameStatus", error.message, true); } });
$("teamForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const data = Object.fromEntries(new FormData(event.currentTarget)); await api("/api/admin/teams", { method: "POST", body: JSON.stringify(data) }); message("teamStatus", "チームを保存しました。"); } catch (error) { message("teamStatus", error.message, true); } });
$("loadGame").addEventListener("click", () => void loadGame());
$("rosterForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const players = JSON.parse($("rosterJson").value); await api(`/api/admin/games/${encodeURIComponent(gameId())}/players`, { method: "POST", body: JSON.stringify({ players }) }); message("operationStatus", "出場選手を保存しました。"); await loadGame(); } catch (error) { message("operationStatus", error.message, true); } });
async function operation(endpoint, body) {
  if (state.operationPending) return null;
  setOperationPending(true);
  try {
    const payload = await api(`/api/admin/games/${encodeURIComponent(gameId())}/${endpoint}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
    message("operationStatus", "完了しました。");
    await loadGame();
    return payload;
  } catch (error) {
    message("operationStatus", error.message, true);
    return null;
  } finally {
    setOperationPending(false);
  }
}
$("confirmLineup").addEventListener("click", () => { try { void operation("lineup", { lineup: JSON.parse($("lineupJson").value), teamId: $("lineupTeamId").value }); } catch (error) { message("operationStatus", "正式スタメンJSONを確認してください。", true); } });
$("scoreGame").addEventListener("click", () => void operation("score"));
$("rankingGame").addEventListener("click", () => void operation("ranking"));
$("publishGame").addEventListener("click", () => void operation("publish"));
$("rescoreGame").addEventListener("click", () => { try { void operation("rescore", { lineup: JSON.parse($("rescoreJson").value), teamId: $("lineupTeamId").value, reason: $("rescoreReason").value }); } catch (error) { message("operationStatus", "訂正版正式スタメンJSONを確認してください。", true); } });

async function refreshSession() {
  try {
    const payload = await api("/api/auth/me");
    state.user = payload.user;
    if (state.user?.role !== "admin") throw new Error("管理者権限が必要です。");
    showAdmin();
    message("adminAuthStatus", "管理画面を利用できます。");
  } catch (error) {
    message("adminAuthStatus", error.message, true);
  }
}

void refreshSession();
