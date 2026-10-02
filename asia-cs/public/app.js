const POSITIONS = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
const gameId = new URLSearchParams(location.search).get("game") || "asia-cs-demo";
const state = { game: null, user: null, prediction: null, closed: false };

const $ = (id) => document.getElementById(id);
const message = (id, text, error = false) => { const node = $(id); node.textContent = text; node.classList.toggle("error", error); };

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "include", cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || "処理に失敗しました。");
  return payload;
}

function buildLineupRows(lineup = []) {
  const players = state.game?.players || [];
  const container = $("predictionLineup");
  container.replaceChildren();
  for (let index = 1; index <= 9; index += 1) {
    const value = lineup.find((item) => Number(item.battingOrder) === index) || {};
    const row = document.createElement("div");
    row.className = "lineup-row";
    const order = document.createElement("strong");
    order.textContent = `${index}番`;
    const player = document.createElement("select");
    player.dataset.field = "playerId";
    player.setAttribute("aria-label", `${index}番の選手`);
    player.innerHTML = `<option value="">選手</option>${players.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}`;
    player.value = value.playerId || "";
    const position = document.createElement("select");
    position.dataset.field = "position";
    position.setAttribute("aria-label", `${index}番の守備位置`);
    position.innerHTML = `<option value="">守備</option>${POSITIONS.map((item) => `<option value="${item}">${item}</option>`).join("")}`;
    position.value = value.position || "";
    row.append(order, player, position);
    container.appendChild(row);
  }
  updateControls();
}

function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }

function getFormLineup() {
  return Array.from($("predictionLineup").querySelectorAll(".lineup-row")).map((row, index) => {
    const playerId = row.querySelector('[data-field="playerId"]').value;
    const player = state.game.players.find((item) => item.id === playerId);
    return { battingOrder: index + 1, playerId, playerName: player?.name || "", position: row.querySelector('[data-field="position"]').value };
  });
}

function updateControls() {
  const loggedIn = Boolean(state.user);
  const closed = state.closed || !state.game || state.game.status !== "open";
  $("saveButton").disabled = !loggedIn || closed;
  $("deleteButton").disabled = !loggedIn || closed || !state.prediction;
  $("userStatus").textContent = loggedIn ? state.user.username : "ログインが必要です";
}

function renderGame() {
  if (!state.game) return;
  $("gameTitle").textContent = state.game.title;
  const home = state.game.homeTeam?.name || "チームA";
  const away = state.game.awayTeam?.name || "チームB";
  $("gameMeta").textContent = `${state.game.competitionType || "ASIA_CS"} ・ ${away} vs ${home}${state.game.venue ? ` ・ ${state.game.venue}` : ""}`;
  const deadline = new Date(state.game.predictionDeadlineAt);
  state.closed = Number.isNaN(deadline.getTime()) || Date.now() >= deadline.getTime() || state.game.status !== "open";
  $("deadlineStatus").textContent = state.closed ? `締切済み（${formatDate(deadline)}）` : `締切 ${formatDate(deadline)}`;
  const teams = [state.game.homeTeam, state.game.awayTeam].filter(Boolean);
  const teamLabel = $("predictionTeamLabel");
  const teamSelect = $("predictionTeamId");
  teamSelect.replaceChildren(...teams.map((team) => { const option = document.createElement("option"); option.value = team.id; option.textContent = team.name; return option; }));
  teamLabel.classList.toggle("hidden", teams.length === 0);
  buildLineupRows(state.prediction?.lineup || []);
  updateControls();
}

function formatDate(date) { return Number.isNaN(date?.getTime?.()) ? "-" : date.toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" }); }

async function refreshSession() {
  const payload = await api("/api/auth/me");
  state.user = payload.user;
  $("authStatus").textContent = state.user ? `${state.user.username}でログイン中` : "Starting9でログインしてください";
  if (state.user) {
    const prediction = await api(`/api/games/${encodeURIComponent(gameId)}/prediction`);
    state.prediction = prediction.prediction;
  }
  renderGame();
}

async function loadBestNine() {
  const payload = await api(`/api/games/${encodeURIComponent(gameId)}/best-nine`);
  const panel = $("bestNinePanel");
  panel.classList.toggle("hidden", !payload.published);
  if (!payload.published) return;
  $("bestNineStatus").textContent = `${payload.totalCount}人`;
  $("bestNineList").innerHTML = payload.bestNine.map((row) => `<li><span>${row.rank}位</span><strong>${escapeHtml(row.username)}</strong><span>${row.score}点${row.isPerfect ? "・満点" : ""}</span></li>`).join("");
}

async function load() {
  try {
    state.game = (await api(`/api/games/${encodeURIComponent(gameId)}`)).game;
    await refreshSession();
    await loadBestNine();
  } catch (error) {
    message("predictionMessage", error.message, true);
  }
}

$("predictionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { const payload = await api(`/api/games/${encodeURIComponent(gameId)}/prediction`, { method: "PUT", body: JSON.stringify({ lineup: getFormLineup(), teamId: $("predictionTeamId").value }) }); state.prediction = payload.prediction; message("predictionMessage", "予想を保存しました。"); updateControls(); }
  catch (error) { message("predictionMessage", error.message, true); }
});
$("deleteButton").addEventListener("click", async () => { try { await api(`/api/games/${encodeURIComponent(gameId)}/prediction`, { method: "DELETE" }); state.prediction = null; buildLineupRows(); message("predictionMessage", "予想を削除しました。"); } catch (error) { message("predictionMessage", error.message, true); } });

void load();
