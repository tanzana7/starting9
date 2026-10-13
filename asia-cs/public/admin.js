const guardrails = window.Starting9AsiaAdminActionGuardrails;
const state = { user: null, game: null, gameSummary: null, overview: null, operationPending: false, competitionPending: false, placementPending: false };
const $ = (id) => document.getElementById(id);
const API_PREFIX = "/api/asia-cs";
const message = (id, text, error = false) => { const node = $(id); node.textContent = text; node.classList.toggle("error", error); };
const operationButtons = ["confirmLineup", "scoreGame", "rankingGame", "publishGame", "rescoreGame"];
function setOperationPending(pending) { state.operationPending = pending; operationButtons.forEach((id) => { const button = $(id); if (button) button.disabled = pending || button.dataset.guardDisabled === "true"; }); }
function setCompetitionPending(pending) { state.competitionPending = pending; ["activateCompetition", "completeCompetition", "competitionSave"].forEach((id) => { const button = $(id); if (button) button.disabled = pending || button.dataset.guardDisabled === "true"; }); }
function setPlacementPending(pending) { state.placementPending = pending; const button = $("placementCreate"); if (button) button.disabled = pending || button.dataset.guardDisabled === "true"; }
async function api(path, options = {}) { const apiPath = String(path).replace(/^\/api/, API_PREFIX); const response = await fetch(apiPath, { credentials: "include", cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } }); const payload = await response.json().catch(() => ({})); if (!response.ok || payload.ok === false) { const error = new Error(payload.error || "処理に失敗しました。"); error.code = payload.code; throw error; } return payload; }
function asIso(localValue) { const date = new Date(localValue); return Number.isNaN(date.getTime()) ? "" : date.toISOString(); }
function showAdmin() { document.querySelectorAll(".admin-only").forEach((node) => node.classList.remove("hidden")); }
function renderRoster(players) { $("rosterJson").value = JSON.stringify(players.map((player) => ({ id: player.id, name: player.name, club: player.club || player.team || "", registeredPosition: player.registeredPosition || "", uniformNumber: player.uniformNumber, bat: player.bat, throw: player.throw, teamId: player.teamId, active: player.active })), null, 2); }
function selectedGameSummary() { const id = String($("gameId")?.value || "").trim(); return state.overview?.games?.find((game) => game.id === id) || null; }
function gameLabel() { const game = state.game || selectedGameSummary(); if (!game) return "対象試合"; const home = game.homeTeam?.name || ""; const away = game.awayTeam?.name || ""; return [game.title || game.id, away && home ? `${away} vs ${home}` : ""].filter(Boolean).join("（") + (away && home ? "）" : ""); }
function updateCompetitionActions() { const competition = state.overview?.competition; for (const action of ["activate", "complete"]) { const button = $(`${action}Competition`); const reason = $(`${action}CompetitionReason`); if (!button || !reason) continue; const result = guardrails.competitionState(competition, action); button.disabled = state.competitionPending || !result.enabled; button.dataset.guardDisabled = String(!result.enabled); button.setAttribute("aria-describedby", `${action}CompetitionReason`); reason.textContent = result.reason; } }
function updateGameActions() { const detail = state.game; const summary = state.gameSummary || selectedGameSummary(); for (const action of guardrails.pipelineActions) { const button = $(`${action}Game`); const reason = $(`${action}GameReason`); if (!button || !reason) continue; const result = guardrails.actionState(detail, summary, action); button.disabled = state.operationPending || !result.enabled; button.dataset.guardDisabled = String(!result.enabled); button.setAttribute("aria-describedby", `${action}GameReason`); reason.textContent = result.reason; } }
function isJapanTeam(team = {}) { return [team.id, team.team_key, team.teamKey, team.display_name, team.displayName, team.short_name, team.shortName, team.country_code, team.countryCode].some((value) => ["jpn", "jp", "japan", "日本", "日本代表"].includes(String(value || "").trim().toLowerCase())); }
function placementSchedule(type) { return type === "third_place" ? "2026-11-15 11:00 JST（締切 10:00）" : "2026-11-15 19:00 JST（締切 18:00）"; }
function renderPlacementControls() {
  const type = $("placementType");
  const opponent = $("placementOpponentTeamId");
  const side = $("placementJapanSide");
  const button = $("placementCreate");
  const schedule = $("placementSchedule");
  const status = $("placementStatus");
  if (!type || !opponent || !side || !button || !schedule || !status) return;
  const teams = state.overview?.teams || [];
  const japan = teams.find(isJapanTeam);
  const opponents = teams.filter((team) => !isJapanTeam(team));
  const selectedOpponent = opponent.value;
  opponent.replaceChildren(new Option("対戦相手を選択", ""));
  opponents.forEach((team) => opponent.appendChild(new Option(team.display_name || team.team_key, team.id)));
  if (opponents.some((team) => String(team.id) === selectedOpponent)) opponent.value = selectedOpponent;
  schedule.textContent = placementSchedule(type.value);
  const placementExists = (state.overview?.games || []).some((game) =>
    game.gameDate === "2026-11-15" && (isJapanTeam(game.homeTeam || {}) || isJapanTeam(game.awayTeam || {}))
  );
  const ready = Boolean(japan && opponent.value && side.value && !placementExists);
  button.disabled = state.placementPending || !ready;
  button.dataset.guardDisabled = String(!ready);
  status.textContent = placementExists ? "順位決定戦は登録済みです。" : japan ? "" : "日本代表チームを登録してください。";
}
function renderDetail(payload) { state.game = payload; state.gameSummary = selectedGameSummary(); renderRoster(payload.game.players); $("gameDetail").textContent = JSON.stringify(payload, null, 2); if (payload.currentLineup) { $("lineupJson").value = JSON.stringify(payload.currentLineup.lineup, null, 2); $("rescoreJson").value = JSON.stringify(payload.currentLineup.lineup, null, 2); } updateGameActions(); }
async function loadGame() { const id = String($("gameId").value || "").trim(); if (!id) { state.game = null; state.gameSummary = null; updateGameActions(); return; } try { renderDetail(await api(`/api/admin/games/${encodeURIComponent(id)}`)); message("gameStatus", "読み込みました。"); } catch (error) { state.game = null; state.gameSummary = null; updateGameActions(); message("gameStatus", guardrails.errorMessage(error), true); } }
async function refreshOverview() { try { const payload = await api(`/api/admin/overview?competitionId=${encodeURIComponent($("competitionForm").elements.id.value || "asia-cs")}`); state.overview = payload; const competition = payload.competition; const form = $("competitionForm"); for (const [name, value] of [["displayName", competition.displayName], ["shortName", competition.shortName], ["startDate", competition.startDate || ""], ["endDate", competition.endDate || ""], ["status", competition.status], ["description", competition.description || ""]]) form.elements[name].value = value; $("overview").textContent = JSON.stringify({ competition, teams: payload.teams, games: payload.games, formalJobs: payload.formalJobs }, null, 2); updateCompetitionActions(); if (state.game) { state.gameSummary = selectedGameSummary(); updateGameActions(); } renderPlacementControls(); } catch (error) { message("competitionStatus", guardrails.errorMessage(error), true); } }

async function saveCompetition(statusOverride = null, action = null) { if (state.competitionPending) return; const data = Object.fromEntries(new FormData($("competitionForm"))); const currentStatus = state.overview?.competition?.status || data.status; const targetStatus = statusOverride || data.status; if (action && !guardrails.competitionState(state.overview?.competition, action).enabled) return; if (["active", "completed"].includes(targetStatus) && targetStatus !== currentStatus && !window.confirm(guardrails.confirmationText(targetStatus === "active" ? "activate" : "complete", { name: data.displayName || data.id }))) return; data.status = targetStatus; setCompetitionPending(true); try { await api("/api/admin/competition", { method: "POST", body: JSON.stringify(data) }); message("competitionStatus", targetStatus === "active" ? "大会をactiveにしました。" : targetStatus === "completed" ? "大会を完了しました。" : "大会設定を保存しました。"); await refreshOverview(); } catch (error) { message("competitionStatus", guardrails.errorMessage(error), true); } finally { setCompetitionPending(false); updateCompetitionActions(); } }
$("competitionForm").addEventListener("submit", async (event) => { event.preventDefault(); await saveCompetition(); });
$("refreshOverview").addEventListener("click", () => void refreshOverview().then(renderPlacementControls));
$("gameForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const data = Object.fromEntries(new FormData(event.currentTarget)); data.startAt = asIso(data.startAt); data.predictionDeadlineAt = asIso(data.predictionDeadlineAt); const payload = await api("/api/admin/games", { method: "POST", body: JSON.stringify(data) }); $("gameId").value = payload.game.id; message("gameStatus", "試合を登録しました。"); await loadGame(); await refreshOverview(); } catch (error) { message("gameStatus", error.message, true); } });
$("teamForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const data = Object.fromEntries(new FormData(event.currentTarget)); await api("/api/admin/teams", { method: "POST", body: JSON.stringify(data) }); message("teamStatus", "チームを保存しました。"); await refreshOverview(); } catch (error) { message("teamStatus", error.message, true); } });
if ($("loadGame")) $("loadGame").addEventListener("click", () => void loadGame());
$("gameImportForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const raw = $("gameImportData").value.trim(); const body = raw.startsWith("[") ? { competitionId: $("competitionForm").elements.id.value, games: JSON.parse(raw) } : { competitionId: $("competitionForm").elements.id.value, csv: raw }; const payload = await api("/api/admin/games/import", { method: "POST", body: JSON.stringify(body) }); message("importStatus", `${payload.imported}試合を登録しました。`); await refreshOverview(); } catch (error) { message("importStatus", error.message, true); } });
$("playerImportForm").addEventListener("submit", async (event) => { event.preventDefault(); try { const raw = $("playerImportData").value.trim(); const body = raw.startsWith("[") ? { gameId: $("playerImportGameId").value, players: JSON.parse(raw) } : { gameId: $("playerImportGameId").value, csv: raw }; const payload = await api("/api/admin/players/import", { method: "POST", body: JSON.stringify(body) }); message("importStatus", `${payload.imported}選手を登録しました。`); await loadGame(); } catch (error) { message("importStatus", error.message, true); } });
$("rosterForm").addEventListener("submit", async (event) => { event.preventDefault(); try { await api(`/api/admin/games/${encodeURIComponent($("gameId").value)}/players`, { method: "POST", body: JSON.stringify({ players: JSON.parse($("rosterJson").value) }) }); message("operationStatus", "出場選手を保存しました。"); await loadGame(); } catch (error) { message("operationStatus", error.message, true); } });
async function operation(endpoint, body) { if (state.operationPending) return; const action = endpoint === "rescore" ? "rescore" : endpoint; const guarded = guardrails.pipelineActions.includes(action); if (guarded) { const result = guardrails.actionState(state.game, state.gameSummary || selectedGameSummary(), action); if (!result.enabled) { message("operationStatus", result.reason, true); updateGameActions(); return; } if (!window.confirm(guardrails.confirmationText(action, { name: gameLabel() }))) return; } setOperationPending(true); const success = { lineup: "正式スタメン確定完了", score: "採点完了", rescore: "再採点完了", ranking: "ランキング更新完了", publish: "公開完了" }; try { await api(`/api/admin/games/${encodeURIComponent($("gameId").value)}/${endpoint}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }); message("operationStatus", success[action] || "完了しました。"); await loadGame(); await refreshOverview(); } catch (error) { message("operationStatus", guardrails.errorMessage(error), true); } finally { setOperationPending(false); updateGameActions(); } }
$("confirmLineup").addEventListener("click", () => { try { void operation("lineup", { lineup: JSON.parse($("lineupJson").value), teamId: $("lineupTeamId").value }); } catch { message("operationStatus", "正式スタメンJSONを確認してください。", true); } });
$("scoreGame").addEventListener("click", () => void operation("score"));
$("rankingGame").addEventListener("click", () => void operation("ranking"));
$("publishGame").addEventListener("click", () => void operation("publish"));
$("rescoreGame").addEventListener("click", () => { try { void operation("rescore", { lineup: JSON.parse($("rescoreJson").value), teamId: $("lineupTeamId").value, reason: $("rescoreReason").value }); } catch { message("operationStatus", "訂正版正式スタメンJSONを確認してください。", true); } });

if ($("placementType")) $("placementType").addEventListener("change", renderPlacementControls);
if ($("placementOpponentTeamId")) $("placementOpponentTeamId").addEventListener("change", renderPlacementControls);
if ($("placementJapanSide")) $("placementJapanSide").addEventListener("change", renderPlacementControls);
if ($("placementGameForm")) $("placementGameForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.placementPending) return;
  const data = Object.fromEntries(new FormData(event.currentTarget));
  if (!data.opponentTeamId || !data.japanSide) {
    message("placementStatus", "対戦相手とホーム／ビジターを選択してください。", true);
    return;
  }
  if (!window.confirm("順位決定戦を登録します。")) return;
  setPlacementPending(true);
  try {
    const payload = await api("/api/admin/placement-games", {
      method: "POST",
      body: JSON.stringify({
        competitionId: $("competitionForm").elements.id.value,
        placementType: data.placementType,
        opponentTeamId: data.opponentTeamId,
        japanSide: data.japanSide
      })
    });
    message("placementStatus", payload.game.title + "を登録しました。");
    await refreshOverview();
  } catch (error) {
    message("placementStatus", error.message, true);
  } finally {
    setPlacementPending(false);
    renderPlacementControls();
  }
});
$("activateCompetition").addEventListener("click", () => void saveCompetition("active", "activate"));
$("completeCompetition").addEventListener("click", () => void saveCompetition("completed", "complete"));

async function refreshSession() { try { const payload = await api("/api/auth/me"); state.user = payload.user; if (payload.isAdmin !== true) throw new Error("管理者権限が必要です。"); showAdmin(); message("adminAuthStatus", "管理画面を利用できます。"); await refreshOverview(); renderPlacementControls(); } catch (error) { message("adminAuthStatus", guardrails.errorMessage(error), true); } }
window.Starting9AsiaCsAdmin = Object.freeze({ refreshSession });
void refreshSession();
