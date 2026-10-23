const POSITION_SEQUENCE = Object.freeze(["捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);

export function simulatorGameDate(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() + 1);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
}

function testOnlyNotice() {
  return `<p>SIMULATED NPB · TEST DATA ONLY</p>`;
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
  return `<section><h5>${escapeHtml(team.displayName)}</h5><p>登録選手 ${players.length}人</p><div class="table-scroll"><table><thead><tr><th colspan="2">守備・背番号</th><th colspan="2">選手・選手ID</th></tr></thead><tbody>${players.map((player) => {
    const identity = player.playerId.slice("npb:".length);
    return `<tr data-player-id="${escapeHtml(player.playerId)}"><td>${escapeHtml(player.position)}</td><td>${escapeHtml(player.number)}</td><td><a href="https://npb.jp/bis/players/${identity}.html">${escapeHtml(player.name)}</a></td><td><code>${escapeHtml(player.playerId)}</code></td></tr>`;
  }).join("")}</tbody></table></div></section>`;
}

function pageShell(title, content) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} | Simulated NPB</title><link rel="stylesheet" href="/assets/simu-npb.css"></head><body><div class="test-notice">SIMULATED NPB · TEST DATA ONLY</div><header class="site-header"><a class="brand" href="/">Simulated NPB</a><nav aria-label="メインナビゲーション"><a href="/">Home</a><a href="/simu-npb/schedule">Schedule</a><a href="/simu-npb/teams">Teams</a></nav></header><main>${content}</main><footer>Starting9 test source · Synthetic fixture data</footer></body></html>`;
}

function fixtureDateLabel(date) {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

function gamePath(game) {
  return `/simu-npb/game/${encodeURIComponent(game.npbGameCode)}`;
}

function teamPath(teamKey) {
  return `/simu-npb/team/${encodeURIComponent(teamKey)}`;
}

function scheduleTable(date, teams, groups) {
  const games = date === simulatorGameDate() ? simulatorGames(date, teams, groups) : [];
  const content = `<header class="page-heading"><p class="eyebrow">SCHEDULE</p><h1>試合日程</h1><p>${escapeHtml(date)} · ${games.length}試合</p></header>${games.length ? `<div class="game-list">${games.map((game) => `<article class="game-card"><div class="game-meta"><time datetime="${escapeHtml(game.startAt)}">${escapeHtml(fixtureDateLabel(game.gameDate))} · ${escapeHtml(game.startAt.slice(11, 16))}</time><span>${escapeHtml(game.status)}</span></div><a class="matchup" href="${gamePath(game)}"><span>${escapeHtml(game.awayTeam)}</span><span class="versus">vs</span><span>${escapeHtml(game.homeTeam)}</span></a><p class="venue">${escapeHtml(game.venue)}</p><p class="fixture-id">Fixture ID: <code>${escapeHtml(game.npbGameCode)}</code></p></article>`).join("")}</div>` : `<p class="empty">このfixture日付の試合はありません。</p>`}`;
  return pageShell("試合日程", content);
}

function npbSchedulePage(date, teams, groups) {
  const [, year, month, day] = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  // The parser keys off the schedule table; keep the test-only notice outside
  // that structure so humans can identify the synthetic source without changing
  // the existing Starting9 ingestion contract.
  const games = date === simulatorGameDate() ? simulatorGames(date, teams, groups) : [];
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>試合日程 | S9simu NPB</title><body>${testOnlyNotice()}<h1>試合日程</h1><p>${year}年 ${Number(month)}/${Number(day)} · 合成データ</p><table><thead><tr><th>日付</th><th>対戦</th><th>開始</th><th>球場</th></tr></thead><tbody>${games.map((game) => `<tr><td>${Number(month)}/${Number(day)}</td><td>${escapeHtml(game.homeTeam)} vs ${escapeHtml(game.awayTeam)}</td><td>18:00</td><td>${escapeHtml(game.venue)}<a href="/scores/${year}/${month}${day}/${game.npbGameCode}/">試合</a></td></tr>`).join("")}</tbody></table></body></html>`;
}

function homePage(date, teams, groups) {
  const games = simulatorGames(date, teams, groups);
  const teamLinks = Object.values(teams).map((team) => `<a class="team-link" href="${teamPath(team.key)}"><span>${escapeHtml(team.shortName)}</span><strong>${escapeHtml(team.displayName)}</strong><small>${escapeHtml(team.providerTeamCode)}</small></a>`).join("");
  const content = `<section class="hero"><p class="eyebrow">NPB SOURCE FIXTURE</p><h1>Simulated NPB</h1><p>Starting9の取得経路を検証するための合成試合・選手データです。</p><a class="primary-link" href="/simu-npb/schedule">本日の試合を見る <span aria-hidden="true">→</span></a></section><section aria-labelledby="today-games"><div class="section-heading"><div><p class="eyebrow">${escapeHtml(date)}</p><h2 id="today-games">本日の6試合</h2></div><a href="/simu-npb/schedule">日程一覧 →</a></div><div class="game-list">${games.map((game) => `<article class="game-card"><div class="game-meta"><time datetime="${escapeHtml(game.startAt)}">${escapeHtml(game.startAt.slice(11, 16))}</time><span>${escapeHtml(game.status)}</span></div><a class="matchup" href="${gamePath(game)}"><span>${escapeHtml(game.awayTeam)}</span><span class="versus">vs</span><span>${escapeHtml(game.homeTeam)}</span></a><p class="venue">${escapeHtml(game.venue)}</p><p class="fixture-id">Fixture ID: <code>${escapeHtml(game.npbGameCode)}</code></p></article>`).join("")}</div></section><section aria-labelledby="teams-heading"><div class="section-heading"><div><p class="eyebrow">12 TEAMS</p><h2 id="teams-heading">球団</h2></div><a href="/simu-npb/teams">球団一覧 →</a></div><div class="team-grid">${teamLinks}</div></section>`;
  return pageShell("ホーム", content);
}

function teamsPage(teams) {
  const teamLinks = Object.values(teams).map((team) => `<a class="team-link" href="${teamPath(team.key)}"><span>${escapeHtml(team.shortName)}</span><strong>${escapeHtml(team.displayName)}</strong><small>${escapeHtml(team.providerTeamCode)}</small></a>`).join("");
  return pageShell("球団一覧", `<header class="page-heading"><p class="eyebrow">TEAMS</p><h1>12球団</h1></header><div class="team-grid">${teamLinks}</div>`);
}

function teamPage(teamKey, date, teams, groups) {
  const team = teams[teamKey];
  if (!team) return null;
  const game = simulatorGames(date, teams, groups).find((entry) => entry.homeKey === teamKey || entry.awayKey === teamKey);
  const opponentKey = game ? game.homeKey === teamKey ? game.awayKey : game.homeKey : "";
  const schedule = game ? `<section class="panel"><p class="eyebrow">TODAY</p><h2><a href="${gamePath(game)}">${escapeHtml(game.awayTeam)} vs ${escapeHtml(game.homeTeam)}</a></h2><p>${escapeHtml(game.gameDate)} · ${escapeHtml(game.startAt.slice(11, 16))} · ${escapeHtml(game.venue)}</p><p>対戦相手: ${escapeHtml(teams[opponentKey].displayName)}</p><p class="fixture-id">Fixture ID: <code>${escapeHtml(game.npbGameCode)}</code></p></section>` : `<p class="empty">本日の試合はありません。</p>`;
  const content = `<header class="page-heading"><p class="eyebrow">TEAM · ${escapeHtml(team.providerTeamCode)}</p><h1>${escapeHtml(team.displayName)}</h1></header>${schedule}<section class="panel roster-panel">${rosterTable(teamKey, teams)}</section>`;
  return pageShell(team.displayName, content);
}

function lineupRows(teamKey, teams, available) {
  const players = simulatorRoster(teamKey, teams);
  return available ? players.slice(0, 9).map((player, index) => `<tr><td>${index + 1}</td><td>${POSITION_SEQUENCE[index]}</td><td>${escapeHtml(player.name)}</td></tr>`).join("") : "";
}

function gamePage(game, teams, available) {
  const teamPanel = (teamKey, side) => `<section class="panel lineup-panel"><div class="section-heading"><div><p class="eyebrow">${side}</p><h2><a href="${teamPath(teamKey)}">${escapeHtml(teams[teamKey].displayName)}</a></h2></div><span class="status">${available ? "ラインナップ発表済み" : "ラインナップ未発表"}</span></div>${available ? `<div class="table-scroll"><table data-lineup-team="${escapeHtml(teamKey)}"><thead><tr><th>打順</th><th>守備</th><th>選手</th></tr></thead><tbody>${lineupRows(teamKey, teams, true)}</tbody></table></div>` : `<p class="empty">スタメン未発表</p>`}</section>`;
  const content = `<header class="page-heading"><p class="eyebrow">GAME DETAIL</p><h1 class="game-title"><span>${escapeHtml(game.awayTeam)}</span><span class="versus">vs</span><span>${escapeHtml(game.homeTeam)}</span></h1><p><time datetime="${escapeHtml(game.startAt)}">${escapeHtml(game.gameDate)} · ${escapeHtml(game.startAt.slice(11, 16))}</time> · ${escapeHtml(game.venue)} · ${escapeHtml(game.status)}</p><p class="fixture-id">Fixture ID: <code>${escapeHtml(game.npbGameCode)}</code></p></header><div class="lineup-grid">${teamPanel(game.awayKey, "AWAY")}${teamPanel(game.homeKey, "HOME")}</div><section class="panel"><p class="eyebrow">RESULT</p><h2>試合結果</h2><p class="empty">fixtureに結果データはありません。</p></section>`;
  return pageShell("試合詳細", `<div data-game-code="${escapeHtml(game.npbGameCode)}" data-game-date="${escapeHtml(game.gameDate)}" data-home-team="${escapeHtml(game.homeTeam)}" data-away-team="${escapeHtml(game.awayTeam)}" data-game-status="${escapeHtml(game.status)}" data-start-at="${escapeHtml(game.startAt)}">${content}</div>`);
}

function starterPage(date, teams, groups) {
  const games = simulatorGames(date, teams, groups);
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>予告先発 | S9simu NPB</title><body>${testOnlyNotice()}<h1>予告先発</h1><h4>${Number(date.slice(5, 7))}月 ${Number(date.slice(8, 10))}日 ${date.slice(0, 4)}</h4><section>${games.map((game, index) => `<div class="unit cl_${index + 1}"><div class="team_left"><img alt="${escapeHtml(game.homeTeam)}"><span>${escapeHtml(`テスト ${teams[game.homeKey].shortName} 先発`)}</span></div><div class="team_right"><img alt="${escapeHtml(game.awayTeam)}"><span>${escapeHtml(`テスト ${teams[game.awayKey].shortName} 先発`)}</div><div class="info">18:00 （S9simu球場）</div></div>`).join("")}</section></body></html>`;
}

function lineupPage(game, teamKey, available, teams) {
  const team = teams[teamKey];
  const players = simulatorRoster(teamKey, teams);
  const rows = available ? players.slice(0, 9).map((player, index) => `<tr><td>${index + 1}</td><td>${POSITION_SEQUENCE[index]}</td><td>${escapeHtml(player.name)}</td></tr>`).join("") : "";
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>試合速報・オーダー | S9simu NPB</title><body>${testOnlyNotice()}<h1>最新のオーダー</h1><div data-game-code="${game.npbGameCode}" data-game-date="${game.gameDate}" data-home-team="${game.homeTeam}" data-away-team="${game.awayTeam}" data-game-status="scheduled" data-start-at="${game.startAt}"><h5>${escapeHtml(team.displayName)}</h5><table data-lineup-team="${teamKey}"><thead><tr><th>打順</th><th>守備</th><th>選手名</th></tr></thead><tbody>${rows}</tbody></table>${available ? "" : "<p>スタメン未発表</p>"}</div></body></html>`;
}

export async function handleSimulatedNpbRequest(request, env = {}, { TEST_TEAMS, TEST_TEAM_GROUPS } = {}) {
  if (!TEST_TEAMS || !TEST_TEAM_GROUPS) throw new Error("S9simu team catalogue is required");
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
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

  if (["/", "/simu-npb", "/simu-npb/index.html"].includes(path) && request.method === "GET") return htmlResponse(homePage(date, TEST_TEAMS, TEST_TEAM_GROUPS));
  if (path === "/simu-npb/schedule" && request.method === "GET") return htmlResponse(scheduleTable(date, TEST_TEAMS, TEST_TEAM_GROUPS));
  if (path === "/simu-npb/teams" && request.method === "GET") return htmlResponse(teamsPage(TEST_TEAMS));
  const teamPageMatch = path.match(/^\/simu-npb\/team\/([a-z-]+)$/);
  if (teamPageMatch && request.method === "GET") {
    const page = teamPage(teamPageMatch[1], date, TEST_TEAMS, TEST_TEAM_GROUPS);
    return page ? htmlResponse(page) : notFound();
  }
  const gamePageMatch = path.match(/^\/simu-npb\/game\/([a-z0-9-]+)$/i);
  if (gamePageMatch && request.method === "GET") {
    const game = games.find((entry) => entry.npbGameCode.toLowerCase() === decodeURIComponent(gamePageMatch[1]).toLowerCase());
    return game ? htmlResponse(gamePage(game, TEST_TEAMS, lineupState === "available")) : notFound();
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
    return htmlResponse(npbSchedulePage(requestedDate, TEST_TEAMS, TEST_TEAM_GROUPS));
  }
  if (path === "/simu-npb/announcement/starter" && request.method === "GET") return htmlResponse(starterPage(date, TEST_TEAMS, TEST_TEAM_GROUPS));

  const rosterMatch = path.match(/^\/simu-npb\/announcement\/roster\/([a-z]+)$/);
  if (rosterMatch && request.method === "GET") {
    const teamKey = rosterMatch[1];
    if (!TEST_TEAMS[teamKey]) return notFound();
    return htmlResponse(pageShell("登録選手", `<header class="page-heading"><p class="eyebrow">ROSTER</p><h1>登録選手</h1><p>${escapeHtml(teamKey)}</p></header>${rosterTable(teamKey, TEST_TEAMS)}`));
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
