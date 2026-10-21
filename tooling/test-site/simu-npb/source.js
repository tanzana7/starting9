const POSITION_SEQUENCE = Object.freeze(["捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);

export function simulatorGameDate(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + 1);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
}

export function simulatorGames(date, teams, groups) {
  return groups.map((group, index) => ({
    gameDate: date,
    startAt: `${date}T18:00:00+09:00`,
    homeTeam: teams[group.homeKey].displayName,
    awayTeam: teams[group.awayKey].displayName,
    homeKey: group.homeKey,
    awayKey: group.awayKey,
    npbGameCode: `g-t-${index + 1}`,
    status: "scheduled",
    venue: `S9simu球場 ${index + 1}`
  }));
}

export function simulatorRoster(teamKey, teams) {
  const team = teams[teamKey];
  if (!team) return null;
  return Array.from({ length: 15 }, (_, index) => ({
    playerId: `npb:${String(90000001 + Object.keys(teams).indexOf(teamKey) * 100 + index)}`,
    name: `テスト ${team.shortName} 選手 ${String(index + 1).padStart(2, "0")}`,
    number: String(index + 1),
    position: index < 2 ? "捕手" : index < 7 ? "内野手" : "外野手",
    teamCode: teamKey,
    teamId: team.playerTeamId
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function rosterTable(teamKey, teams) {
  const team = teams[teamKey];
  const players = simulatorRoster(teamKey, teams);
  return `<section><h5>${escapeHtml(team.displayName)}</h5><p>登録選手数（仮） ${players.length}人</p><table><thead><tr><th>登録選手</th><th>背番号</th></tr></thead><tbody>${players.map((player) => {
    const identity = player.playerId.slice("npb:".length);
    return `<tr><td>${escapeHtml(player.position)}</td><td>${escapeHtml(player.number)}</td><td><a href="https://npb.jp/bis/players/${identity}.html">${escapeHtml(player.name)}</a></td></tr>`;
  }).join("")}</tbody></table></section>`;
}

function scheduleTable(date, teams, groups) {
  const [, year, month, day] = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  // Cron may request many dates, but the simulator publishes only its one
  // fixture date; returning rows for every queried day would duplicate six
  // synthetic games into unrelated schedule dates.
  const games = date === simulatorGameDate() ? simulatorGames(date, teams, groups) : [];
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>試合日程 | S9simu NPB</title><h1>試合日程</h1><p>${year}年 ${Number(month)}/${Number(day)} · 合成データ</p><table><thead><tr><th>日付</th><th>対戦</th><th>開始</th><th>球場</th></tr></thead><tbody>${games.map((game) => `<tr><td>${Number(month)}/${Number(day)}</td><td>${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)}</td><td>18:00</td><td>${escapeHtml(game.venue)}<a href="/scores/${year}/${month}${day}/${game.npbGameCode}/">試合</a></td></tr>`).join("")}</tbody></table></html>`;
}

function starterPage(date, teams, groups) {
  const games = simulatorGames(date, teams, groups);
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>予告先発 | S9simu NPB</title><h1>予告先発</h1><h4>${Number(date.slice(5, 7))}月 ${Number(date.slice(8, 10))}日 ${date.slice(0, 4)}</h4><section>${games.map((game, index) => `<div class="unit cl_${index + 1}"><div class="team_left"><img alt="${escapeHtml(game.homeTeam)}"><span>${escapeHtml(`テスト ${teams[game.homeKey].shortName} 先発`)}</span></div><div class="team_right"><img alt="${escapeHtml(game.awayTeam)}"><span>${escapeHtml(`テスト ${teams[game.awayKey].shortName} 先発`)}</span></div><div class="info">18:00 （S9simu球場）</div></div>`).join("")}</section></html>`;
}

function lineupPage(game, teamKey, available, teams) {
  const team = teams[teamKey];
  const players = simulatorRoster(teamKey, teams);
  const rows = available ? players.slice(0, 9).map((player, index) => `<tr><td>${index + 1}</td><td>${POSITION_SEQUENCE[index]}</td><td>${escapeHtml(player.name)}</td></tr>`).join("") : "";
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>試合速報・オーダー | S9simu NPB</title><h1>最新のオーダー</h1><div data-game-code="${game.npbGameCode}" data-game-date="${game.gameDate}" data-home-team="${game.homeTeam}" data-away-team="${game.awayTeam}" data-game-status="scheduled" data-start-at="${game.startAt}"><h5>${escapeHtml(team.displayName)}</h5><table data-lineup-team="${teamKey}"><thead><tr><th>打順</th><th>守備</th><th>選手名</th></tr></thead><tbody>${rows}</tbody></table>${available ? "" : "<p>スタメン未発表</p>"}</div></html>`;
}

export async function handleSimulatedNpbRequest(request, env = {}, { TEST_TEAMS, TEST_TEAM_GROUPS } = {}) {
  if (!TEST_TEAMS || !TEST_TEAM_GROUPS) throw new Error("S9simu team catalogue is required");
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/simu-npb";
  const date = simulatorGameDate();
  const games = simulatorGames(date, TEST_TEAMS, TEST_TEAM_GROUPS);
  const lineupState = await env.SIMU_NPB_STATE?.get("lineup-state").catch(() => null) || "pre-lineup";

  if (path === "/simu-npb/control" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || !["pre-lineup", "available"].includes(body.lineupState)) {
      return Response.json({ ok: false, code: "INVALID_SIMULATOR_STATE" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (!env.SIMU_NPB_STATE) return Response.json({ ok: false, code: "SIMULATOR_STATE_UNAVAILABLE" }, { status: 503 });
    await env.SIMU_NPB_STATE.put("lineup-state", body.lineupState);
    return Response.json({ ok: true, lineupState: body.lineupState }, { headers: { "Cache-Control": "no-store" } });
  }

  if (path === "/simu-npb" || path === "/simu-npb/index.html") {
    const links = games.map((game) => `<li>${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)} — <a href="/simu-npb/scores/${date.slice(0, 4)}/${date.slice(5, 7)}${date.slice(8, 10)}/${game.npbGameCode}/">試合・ラインナップ</a></li>`).join("");
    const rosterLinks = Object.values(TEST_TEAMS).map((team) => `<li><a href="/simu-npb/announcement/roster/${team.key}/">${escapeHtml(team.displayName)} ロースター</a></li>`).join("");
    return htmlResponse(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>S9simu — 擬似NPB</title><h1>S9simu — 擬似NPB</h1><p>Starting9 Test専用の合成データです。実在のNPB情報ではありません。</p><p>対象日: ${date} · ラインナップ: ${lineupState === "available" ? "発表済み" : "未発表"}</p><h2>日程</h2><p><a href="/simu-npb/games/${date.slice(0, 4)}/schedule_${date.slice(5, 7)}_detail.html?date=${date}&team=all">NPB形式の日程ページ</a></p><ul>${links}</ul><h2>12球団ロースター</h2><ul>${rosterLinks}</ul><form id="lineup-control"><button name="lineupState" value="pre-lineup">未発表</button><button name="lineupState" value="available">スタメン公開</button><output></output></form><script>document.querySelector('#lineup-control').addEventListener('click',async event=>{if(!event.target.name)return;event.preventDefault();const response=await fetch('/simu-npb/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lineupState:event.target.value})});const result=await response.json();if(result.ok)location.reload();else document.querySelector('output').textContent='状態を更新できませんでした';});</script></html>`);
  }
  if (path === "/simu-npb/api/public/games" && request.method === "GET") {
    const requestedDate = url.searchParams.get("date");
    const requestedTeam = url.searchParams.get("team") || "fighters";
    if (requestedDate !== date || !["all", ...Object.keys(TEST_TEAMS)].includes(requestedTeam)) {
      return Response.json({ ok: true, games: [], date: requestedDate || "", source: "simulated-npb" }, { headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ok: true, games: games.filter((game) => requestedTeam === "all" || game.homeKey === requestedTeam || game.awayKey === requestedTeam), date, source: "simulated-npb" }, { headers: { "Cache-Control": "no-store" } });
  }
  const scheduleMatch = path.match(/^\/simu-npb\/games\/(\d{4})\/schedule_(\d{2})_detail\.html$/);
  if (scheduleMatch && request.method === "GET") {
    const requestedDate = url.searchParams.get("date") || date;
    const parsedDate = new Date(`${requestedDate}T00:00:00Z`);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
      && !Number.isNaN(parsedDate.getTime())
      && parsedDate.toISOString().slice(0, 10) === requestedDate
      && scheduleMatch[1] === requestedDate.slice(0, 4)
      && scheduleMatch[2] === requestedDate.slice(5, 7);
    if (!validDate) return Response.json({ ok: false, code: "INVALID_SIMULATOR_DATE" }, { status: 400 });
    return htmlResponse(scheduleTable(requestedDate, TEST_TEAMS, TEST_TEAM_GROUPS));
  }
  if (path === "/simu-npb/announcement/starter" && request.method === "GET") return htmlResponse(starterPage(date, TEST_TEAMS, TEST_TEAM_GROUPS));

  const rosterMatch = path.match(/^\/simu-npb\/announcement\/roster\/([a-z]+)$/);
  if (rosterMatch && request.method === "GET") {
    const teamKey = rosterMatch[1];
    if (!TEST_TEAMS[teamKey]) return notFound();
    return htmlResponse(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>登録選手 | S9simu NPB</title><h1>登録選手</h1><p>合成データ</p>${rosterTable(teamKey, TEST_TEAMS)}</html>`);
  }
  const scoreMatch = path.match(/^\/simu-npb\/scores\/(\d{4})\/(\d{4})\/([a-z0-9]+-[a-z0-9]+-\d+)$/i);
  if (scoreMatch && request.method === "GET") {
    const game = games.find((entry) => entry.npbGameCode === scoreMatch[3]);
    const teamKey = url.searchParams.get("team") || game?.homeKey;
    if (!game || !TEST_TEAMS[teamKey] || ![game.homeKey, game.awayKey].includes(teamKey)) return notFound();
    return htmlResponse(lineupPage(game, teamKey, lineupState === "available", TEST_TEAMS));
  }
  return notFound();
}

function htmlResponse(body) {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function notFound() {
  return Response.json({ ok: false, code: "SIMULATED_SOURCE_NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
