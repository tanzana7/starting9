const POSITIONS = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
const API_PREFIX = "/api/asia-cs";
const state = { competition: null, games: [], game: null, user: null, prediction: null, selectedTeamId: "" };

// The same Asia UI is mounted in the standalone compatibility route and in
// the main Starting9 shell. A prefix keeps the embedded panel's controls
// isolated from the NPB auth and prediction controls without duplicating the
// Asia domain flow.
const asiaScript = Array.from(document.scripts).find((script) => script.dataset.asiaPrefix);
const ID_PREFIX = String(asiaScript?.dataset.asiaPrefix || "");
const configuredCompetitionId = String(asiaScript?.dataset.competitionId || "").trim();
const competitionId = new URLSearchParams(location.search).get("competition") || configuredCompetitionId || "asia-cs";
// Embedded Asia markup uses a camel-cased namespace prefix, while the
// standalone compatibility page keeps the original unprefixed IDs.
const $ = (id) => document.getElementById(ID_PREFIX ? `${ID_PREFIX}${id.charAt(0).toUpperCase()}${id.slice(1)}` : id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const message = (id, text, error = false) => { const node = $(id); node.textContent = text; node.classList.toggle("error", error); };

async function api(path, options = {}) {
  const apiPath = String(path).replace(/^\/api/, API_PREFIX);
  const response = await fetch(apiPath, { credentials: "include", cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || "処理に失敗しました。");
  return payload;
}

function formatDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tokyo" });
}

function gameLabel(game) {
  return `${game.gameDate} ${game.homeTeam?.name || "未定"} vs ${game.awayTeam?.name || "未定"}`;
}

function isJapanTeam(team = {}) {
  return [team.id, team.teamKey, team.name, team.displayName, team.shortName, team.countryCode]
    .map((value) => String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " "))
    .some((value) => ["jpn", "jp", "japan", "日本", "日本代表", "japan national team", "team jpn"].includes(value));
}

function isJapanPredictionGame(game) {
  if (game?.predictionEligible === false) return false;
  if (game?.predictionEligible === true) return true;
  return isJapanTeam(game?.homeTeam) || isJapanTeam(game?.awayTeam);
}

function renderCompetition(payload) {
  state.competition = payload.competition;
  state.games = payload.games || [];
  const competition = state.competition;
  $("competitionName").textContent = competition.displayName;
  const period = [competition.startDate, competition.endDate].filter(Boolean).join(" 〜 ");
  $("competitionMeta").textContent = `${period || "開催期間未設定"} ・ ${competition.status}`;
  $("competitionDescription").textContent = competition.description || "";
  $("acceptingCount").textContent = `${payload.acceptingGames?.length || 0}試合受付中`;
  const next = payload.nextGame;
  $("nextGame").innerHTML = next
    ? `<strong>${escapeHtml(gameLabel(next))}</strong><span>${escapeHtml(formatDate(next.startAt))}</span><button type="button" class="link-button" data-game="${escapeHtml(next.id)}">この試合を予想</button>`
    : competition.status === "draft" ? "予想受付開始前" : "次の試合は未定です。";
  $("scheduleStatus").textContent = `${state.games.length}試合`;
  $("scheduleList").innerHTML = state.games.length ? state.games.map((game) => {
    const predictionEligible = isJapanPredictionGame(game);
    const status = game.status === "published" ? "結果公開" : !predictionEligible ? "日程のみ" : game.canPredict ? "受付中" : state.competition?.status === "draft" ? "予想受付開始前" : game.archived ? "アーカイブ" : "受付終了";
    return `<article class="schedule-row"><div><strong>${escapeHtml(gameLabel(game))}</strong><span>${escapeHtml(formatDate(game.startAt))}${game.venue ? ` ・ ${escapeHtml(game.venue)}` : ""}</span></div><div class="schedule-actions"><span class="status-chip">${escapeHtml(status)}</span>${predictionEligible && game.canPredict ? `<button type="button" class="link-button" data-game="${escapeHtml(game.id)}">予想</button>` : ""}${game.status === "published" ? `<button type="button" class="link-button" data-result="${escapeHtml(game.id)}">結果</button>` : ""}</div></article>`;
  }).join("") : "日程はまだ登録されていません。";
}

function renderRanking(ranking) {
  $("rankingStatus").textContent = ranking.length ? `${ranking.length}人` : "大会開始前";
  $("rankingList").innerHTML = ranking.length ? ranking.map((row) => `<li><span>${row.rank}位</span><strong>${escapeHtml(row.username)}</strong><span>${row.score}点 ・ ${row.gamesCount}試合</span></li>`).join("") : "<li>大会開始後に表示されます。</li>";
}

function renderBestNine(payload) {
  $("bestNineStatus").textContent = payload.publishedGameCount ? `${payload.publishedGameCount}試合から` : "大会開始前";
  $("bestNineList").innerHTML = payload.bestNine?.length ? payload.bestNine.map((row) => `<li><span>${row.rank}位</span><strong>${escapeHtml(row.position)} ${escapeHtml(row.player)}</strong><span>${escapeHtml(row.team)} ・ ${row.selectionCount}回</span></li>`).join("") : "<li>大会終了後に公開予定です。</li>";
}

function updateControls() {
  const closed = !state.game || !state.game.canPredict;
  const validation = validateLineup(readLineup());
  $("saveButton").disabled = !state.user || closed || !validation.valid;
  $("deleteButton").disabled = !state.user || closed || !state.prediction;
  $("userStatus").textContent = state.user ? `${state.user.username}でログイン中` : "ログインが必要です";
  const validationNode = $("predictionValidation");
  if (validationNode) {
    validationNode.textContent = validation.message;
    validationNode.classList.toggle("error", Boolean(validation.message));
  }
}

function readLineup() {
  return Array.from($("predictionLineup")?.querySelectorAll(".lineup-row") || []).map((row, index) => ({
    battingOrder: index + 1,
    playerId: row.querySelector('[data-field="playerId"]')?.value || "",
    position: row.querySelector('[data-field="position"]')?.value || ""
  }));
}

function validateLineup(lineup) {
  const selectedPlayers = lineup.filter((item) => item.playerId);
  const duplicatePlayers = new Set(selectedPlayers.map((item) => item.playerId)).size !== selectedPlayers.length;
  if (duplicatePlayers) return { valid: false, message: "同じ選手は複数登録できません。" };
  if (selectedPlayers.length < 9) return { valid: false, message: "選手を9人選択してください。" };
  if (lineup.some((item) => !item.position)) return { valid: false, message: "守備位置を選択してください。" };
  return { valid: true, message: "" };
}

function playerMeta(player) {
  return [player.club || player.team, player.registeredPosition ? `登録: ${player.registeredPosition}` : ""]
    .filter(Boolean)
    .join(" / ");
}

function buildLineupRows(lineup = []) {
  const players = state.game?.playersByTeam?.[state.selectedTeamId === state.game?.homeTeam?.id ? "home" : "away"] || [];
  const container = $("predictionLineup");
  container.replaceChildren();
  if (!players.length) {
    container.innerHTML = '<p class="muted">選手情報は準備中です。</p>';
    updateControls();
    return;
  }
  for (let index = 1; index <= 9; index += 1) {
    const value = lineup.find((item) => Number(item.battingOrder) === index) || {};
    const usedByOtherRows = new Set(lineup
      .filter((item) => Number(item.battingOrder) !== index && item.playerId)
      .map((item) => String(item.playerId)));
    const row = document.createElement("div");
    row.className = "lineup-row";
    const order = document.createElement("strong");
    order.textContent = `${index}番`;
    const player = document.createElement("select");
    player.dataset.field = "playerId";
    player.setAttribute("aria-label", `${index}番の選手`);
    player.innerHTML = `<option value="">選手を選択</option>${players.map((item) => `<option value="${escapeHtml(item.id)}"${usedByOtherRows.has(String(item.id)) ? " disabled" : ""}>${escapeHtml(item.name)}${item.club ? ` / ${escapeHtml(item.club)}` : item.team ? ` / ${escapeHtml(item.team)}` : ""}${item.registeredPosition ? ` / 登録: ${escapeHtml(item.registeredPosition)}` : ""}${item.uniformNumber ? ` #${escapeHtml(item.uniformNumber)}` : ""}</option>`).join("")}`;
    player.value = value.playerId || "";
    const playerMetaNode = document.createElement("span");
    playerMetaNode.className = "lineup-player-meta";
    playerMetaNode.textContent = value.playerId ? playerMeta(players.find((item) => item.id === value.playerId) || {}) : "選手を選択";
    const playerField = document.createElement("div");
    playerField.className = "lineup-player-field";
    playerField.append(player, playerMetaNode);
    const position = document.createElement("select");
    position.dataset.field = "position";
    position.setAttribute("aria-label", `${index}番の守備位置`);
    position.innerHTML = `<option value="">守備位置を選択</option>${POSITIONS.map((item) => `<option value="${item}">${item}</option>`).join("")}`;
    position.value = value.position || "";
    row.append(order, playerField, position);
    container.appendChild(row);
  }
  updateControls();
}

function renderGame() {
  if (!state.game) return;
  $("predictionPanel").classList.remove("hidden");
  $("gameMeta").textContent = `${gameLabel(state.game)} ・ ${formatDate(state.game.startAt)}`;
  $("deadlineStatus").textContent = state.game.canPredict ? `予想締切 ${formatDate(state.game.predictionDeadlineAt)} JST` : state.game.status === "published" ? "結果公開済み" : state.competition?.status === "draft" ? "予想受付開始前" : "予想受付終了";
  const teams = [state.game.homeTeam, state.game.awayTeam].filter(Boolean);
  const predictionTeams = teams.filter(isJapanTeam);
  const selectableTeams = predictionTeams.length ? predictionTeams : teams;
  const select = $("predictionTeamId");
  select.replaceChildren(...selectableTeams.map((team) => { const option = document.createElement("option"); option.value = team.id; option.textContent = team.name; return option; }));
  state.selectedTeamId = predictionTeams[0]?.id || teams[0]?.id || "";
  select.value = state.selectedTeamId;
  buildLineupRows(state.prediction?.lineup || []);
}

async function loadGame(gameId) {
  try {
    const payload = await api(`/api/games/${encodeURIComponent(gameId)}`);
    state.game = { ...payload.game, ...(state.games.find((game) => game.id === gameId) || {}) };
    if (!isJapanPredictionGame(state.game)) {
      state.game = null;
      state.prediction = null;
      $("predictionPanel").classList.add("hidden");
      return;
    }
    state.selectedTeamId = [state.game.homeTeam, state.game.awayTeam].find(isJapanTeam)?.id || state.game.homeTeam?.id || "";
    state.prediction = null;
    if (state.user) state.prediction = (await api(`/api/games/${encodeURIComponent(gameId)}/prediction`)).prediction;
    renderGame();
    if (state.game.status === "published") await loadResult(gameId);
    window.scrollTo({ top: $("predictionPanel").offsetTop - 12, behavior: "smooth" });
  } catch (error) { message("predictionMessage", error.message, true); }
}

async function loadResult(gameId) {
  try {
    const payload = await api(`/api/games/${encodeURIComponent(gameId)}/result`);
    $("resultPanel").classList.remove("hidden");
    $("resultStatus").textContent = gameLabel(state.games.find((game) => game.id === gameId) || state.game);
    const breakdown = payload.prediction?.breakdown;
    $("resultDetail").innerHTML = `<h3>${escapeHtml(payload.game.title)}</h3><ol class="ranking-list">${payload.officialLineup.map((item) => `<li><span>${item.battingOrder}番</span><strong>${escapeHtml(item.playerName)}</strong><span>${escapeHtml(item.position)}</span></li>`).join("")}</ol>${payload.prediction ? `<p>あなたの得点: <strong>${payload.prediction.score} / ${payload.prediction.maxScore}</strong></p><p class="muted">選手 ${breakdown.player.points}点 ・ 打順 ${breakdown.order.points}点 ・ 守備 ${breakdown.position.points}点 ・ 完全一致 ${breakdown.perfect.points}点</p>` : "<p class=\"muted\">ログインすると自分の得点を確認できます。</p>"}`;
  } catch (error) { message("predictionMessage", error.message, true); }
}

async function refreshSession() {
  try {
    const payload = await api("/api/auth/me");
    state.user = payload.user;
    $("authStatus").textContent = state.user ? `${state.user.username}でログイン中` : "Starting9でログインしてください";
  } catch { state.user = null; $("authStatus").textContent = "ログイン状態を確認できません。"; }
}

$("predictionTeamId").addEventListener("change", (event) => { state.selectedTeamId = event.target.value; buildLineupRows(state.prediction?.lineup || []); });
$("predictionLineup").addEventListener("change", () => { buildLineupRows(readLineup()); });
$("scheduleList").addEventListener("click", (event) => { const gameId = event.target.closest("[data-game]")?.dataset.game; const resultId = event.target.closest("[data-result]")?.dataset.result; if (gameId) void loadGame(gameId); if (resultId) void loadResult(resultId); });
$("nextGame").addEventListener("click", (event) => { const gameId = event.target.closest("[data-game]")?.dataset.game; if (gameId) void loadGame(gameId); });
$("predictionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const lineup = readLineup();
    const validation = validateLineup(lineup);
    if (!validation.valid) {
      message("predictionValidation", validation.message, true);
      return;
    }
    if (!state.user) {
      message("predictionMessage", "ログインして予想してください。", true);
      return;
    }
    const payload = await api(`/api/games/${encodeURIComponent(state.game.id)}/prediction`, { method: "PUT", body: JSON.stringify({ lineup, teamId: state.selectedTeamId }) });
    state.prediction = payload.prediction;
    message("predictionMessage", "予想を保存しました。");
    updateControls();
  } catch (error) { message("predictionMessage", error.message, true); }
});
$("deleteButton").addEventListener("click", async () => { try { await api(`/api/games/${encodeURIComponent(state.game.id)}/prediction`, { method: "DELETE" }); state.prediction = null; buildLineupRows(); message("predictionMessage", "予想を削除しました。"); } catch (error) { message("predictionMessage", error.message, true); } });

async function load() {
  try {
    await refreshSession();
    const [competition, ranking, bestNine] = await Promise.all([api(`/api/competition?competitionId=${encodeURIComponent(competitionId)}`), api(`/api/rankings?competitionId=${encodeURIComponent(competitionId)}`), api(`/api/best-nine?competitionId=${encodeURIComponent(competitionId)}`)]);
    renderCompetition(competition);
    renderRanking(ranking.ranking || []);
    renderBestNine(bestNine);
    if (competition.nextGame) await loadGame(competition.nextGame.id);
  } catch (error) {
    message("authStatus", "大会情報を読み込めませんでした。", true);
    message("nextGame", "次の試合は確認できません。", true);
    message("scheduleStatus", "日程を読み込めませんでした。", true);
    $("scheduleList").innerHTML = '<p class="muted">日程を読み込めませんでした。</p>';
    message("rankingStatus", "ランキングを確認できません。", true);
    $("rankingList").innerHTML = '<li>ランキングを読み込めませんでした。</li>';
    message("bestNineStatus", "ベストナインを確認できません。", true);
    $("bestNineList").innerHTML = '<li>ベストナインを読み込めません。</li>';
  }
}

window.Starting9AsiaCsApp = Object.freeze({ load });
void load();
