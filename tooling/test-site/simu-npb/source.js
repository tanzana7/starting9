const POSITION_SEQUENCE = Object.freeze(["捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);
const LINEUP_KEY_PREFIX = "lineup:v1:";
const LINEUP_MAX_BODY_BYTES = 16 * 1024;

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
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} | Simulated NPB</title><link rel="stylesheet" href="/assets/simu-npb.css"></head><body><div class="test-notice">SIMULATED NPB · TEST DATA ONLY</div><header class="site-header"><a class="brand" href="/">Simulated NPB</a><nav aria-label="メインナビゲーション"><a href="/">Home</a><a href="/simu-npb/schedule">Schedule</a><a href="/simu-npb/teams">Teams</a><a href="/simu-npb/lineup-editor">Lineup Editor</a></nav></header><main>${content}</main><footer>Starting9 test source · Synthetic fixture data</footer></body></html>`;
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

function lineupKey(game) {
  return `${LINEUP_KEY_PREFIX}${game.gameDate}:${game.npbGameCode}`;
}

function defaultLineup(teamKey, teams) {
  return simulatorRoster(teamKey, teams).slice(0, 9).map((player, index) => ({
    order: index + 1,
    playerId: player.playerId,
    position: POSITION_SEQUENCE[index]
  }));
}

function validateLineup(input, teamKey, teams) {
  if (!Array.isArray(input) || input.length !== 9) return { ok: false, code: "LINEUP_INCOMPLETE" };
  const roster = simulatorRoster(teamKey, teams);
  const rosterById = new Map(roster.map((player) => [player.playerId, player]));
  const seenPlayers = new Set();
  const seenOrders = new Set();
  const normalized = [];
  for (const row of input) {
    const order = Number(row?.order);
    const playerId = typeof row?.playerId === "string" ? row.playerId.trim() : "";
    if (!Number.isInteger(order) || order < 1 || order > 9 || seenOrders.has(order) || !playerId) {
      return { ok: false, code: "LINEUP_INCOMPLETE", order: Number.isInteger(order) ? order : null };
    }
    if (!rosterById.has(playerId)) return { ok: false, code: "PLAYER_NOT_ON_TEAM", order };
    if (seenPlayers.has(playerId)) return { ok: false, code: "DUPLICATE_PLAYER", order };
    seenOrders.add(order);
    seenPlayers.add(playerId);
    normalized.push({ order, playerId, position: POSITION_SEQUENCE[order - 1] });
  }
  if (seenOrders.size !== 9) return { ok: false, code: "LINEUP_INCOMPLETE" };
  normalized.sort((left, right) => left.order - right.order);
  return { ok: true, lineup: normalized };
}

async function readStoredLineups(env, game, teams) {
  if (!env.SIMU_NPB_STATE) throw Object.assign(new Error("simulator storage unavailable"), { code: "SIMULATOR_STATE_UNAVAILABLE" });
  const raw = await env.SIMU_NPB_STATE.get(lineupKey(game));
  if (raw == null) return null;
  let stored;
  try { stored = JSON.parse(raw); } catch {
    throw Object.assign(new Error("stored lineup is invalid"), { code: "SIMULATOR_LINEUP_DATA_INVALID" });
  }
  if (stored?.version !== 1 || stored.providerGameId !== game.npbGameCode || stored.gameDate !== game.gameDate
    || stored.awayKey !== game.awayKey || stored.homeKey !== game.homeKey) {
    throw Object.assign(new Error("stored lineup identity mismatch"), { code: "SIMULATOR_LINEUP_DATA_INVALID" });
  }
  const away = validateLineup(stored.awayLineup, game.awayKey, teams);
  const home = validateLineup(stored.homeLineup, game.homeKey, teams);
  if (!away.ok || !home.ok) throw Object.assign(new Error("stored lineup validation failed"), { code: "SIMULATOR_LINEUP_DATA_INVALID" });
  return { ...stored, awayLineup: away.lineup, homeLineup: home.lineup };
}

function editorGameData(game, stored, teams) {
  const teamData = (teamKey, side) => {
    const lineup = stored?.[`${side}Lineup`] || defaultLineup(teamKey, teams);
    return {
      key: teamKey,
      name: teams[teamKey].displayName,
      roster: simulatorRoster(teamKey, teams).map(({ playerId, name, number }) => ({ playerId, name, number })),
      lineup: lineup.map(({ order, playerId }) => ({ order, playerId }))
    };
  };
  return {
    providerGameId: game.npbGameCode,
    gameDate: game.gameDate,
    startAt: game.startAt,
    away: teamData(game.awayKey, "away"),
    home: teamData(game.homeKey, "home"),
    announced: Boolean(stored)
  };
}

async function readJsonLimited(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LINEUP_MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function isSameOriginSimulatorWrite(request, url) {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  return origin === url.origin
    && request.headers.get("X-Simu-NPB-Write") === "1"
    && /^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "")
    && (!fetchSite || fetchSite === "same-origin");
}

async function authorizeSameOriginWrite(request, authorizeAdmin) {
  if (!isSameOriginSimulatorWrite(request, new URL(request.url))) {
    return Response.json({ ok: false, code: "SAME_ORIGIN_REQUIRED" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (typeof authorizeAdmin !== "function") {
    return Response.json({ ok: false, code: "EDITOR_AUTH_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  let authorization;
  try { authorization = await authorizeAdmin(request); } catch {
    authorization = { ok: false, code: "EDITOR_AUTH_UNAVAILABLE", status: 503 };
  }
  if (authorization?.ok !== true) {
    const status = [401, 403].includes(authorization?.status) ? authorization.status : 503;
    return Response.json({ ok: false, code: authorization?.code || (status === 401 ? "ADMIN_REQUIRED" : "EDITOR_AUTH_UNAVAILABLE") }, {
      status, headers: { "Cache-Control": "no-store" }
    });
  }
  return null;
}

async function saveLineups(request, env, game, teams, authorizeAdmin) {
  const denied = await authorizeSameOriginWrite(request, authorizeAdmin);
  if (denied) return denied;
  if (!env.SIMU_NPB_STATE) {
    return Response.json({ ok: false, code: "SIMULATOR_STATE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const body = await readJsonLimited(request);
  if (!body || body.providerGameId !== game.npbGameCode) {
    return Response.json({ ok: false, code: "INVALID_LINEUP_REQUEST" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const away = validateLineup(body.awayLineup, game.awayKey, teams);
  if (!away.ok) return Response.json({ ok: false, code: away.code, side: "away", order: away.order || null }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const home = validateLineup(body.homeLineup, game.homeKey, teams);
  if (!home.ok) return Response.json({ ok: false, code: home.code, side: "home", order: home.order || null }, { status: 400, headers: { "Cache-Control": "no-store" } });
  const stored = {
    version: 1,
    providerGameId: game.npbGameCode,
    gameDate: game.gameDate,
    awayKey: game.awayKey,
    homeKey: game.homeKey,
    awayLineup: away.lineup,
    homeLineup: home.lineup,
    updatedAt: new Date().toISOString()
  };
  try {
    // One game-scoped KV value keeps both sides atomic and avoids game/team
    // selections racing into a shared mutable lineup slot.
    await env.SIMU_NPB_STATE.put(lineupKey(game), JSON.stringify(stored), { expirationTtl: 90 * 24 * 60 * 60 });
  } catch {
    return Response.json({ ok: false, code: "SIMULATOR_STATE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ ok: true, game: editorGameData(game, stored, teams) }, { headers: { "Cache-Control": "no-store" } });
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

function lineupRows(teamKey, teams, available, lineup) {
  if (!available) return "";
  const roster = new Map(simulatorRoster(teamKey, teams).map((player) => [player.playerId, player]));
  return lineup.map((row) => {
    const player = roster.get(row.playerId);
    return `<tr><td>${row.order}</td><td>${escapeHtml(row.position)}</td><td>${escapeHtml(player.name)}</td></tr>`;
  }).join("");
}

function gamePage(game, teams, available, stored) {
  const teamPanel = (teamKey, side, lineup, lineupAvailable) => `<section class="panel lineup-panel"><div class="section-heading"><div><p class="eyebrow">${side}</p><h2><a href="${teamPath(teamKey)}">${escapeHtml(teams[teamKey].displayName)}</a></h2></div><span class="status">${lineupAvailable ? "ラインナップ発表済み" : "ラインナップ未発表"}</span></div>${lineupAvailable ? `<div class="table-scroll"><table data-lineup-team="${escapeHtml(teamKey)}"><thead><tr><th>打順</th><th>守備</th><th>選手</th></tr></thead><tbody>${lineupRows(teamKey, teams, true, lineup)}</tbody></table></div>` : `<p class="empty">スタメン未発表</p>`}</section>`;
  const lineupAvailable = Boolean(stored) || available;
  const awayLineup = stored?.awayLineup || defaultLineup(game.awayKey, teams);
  const homeLineup = stored?.homeLineup || defaultLineup(game.homeKey, teams);
  const lineupContent = `<header class="page-heading"><p class="eyebrow">GAME DETAIL</p><h1 class="game-title"><span>${escapeHtml(game.awayTeam)}</span><span class="versus">vs</span><span>${escapeHtml(game.homeTeam)}</span></h1><p><time datetime="${escapeHtml(game.startAt)}">${escapeHtml(game.gameDate)} · ${escapeHtml(game.startAt.slice(11, 16))}</time> · ${escapeHtml(game.venue)} · ${escapeHtml(game.status)}</p><p class="fixture-id">Fixture ID: <code>${escapeHtml(game.npbGameCode)}</code></p></header><div class="lineup-grid">${teamPanel(game.awayKey, "AWAY", awayLineup, lineupAvailable)}${teamPanel(game.homeKey, "HOME", homeLineup, lineupAvailable)}</div><section class="panel"><p class="eyebrow">RESULT</p><h2>試合結果</h2><p class="empty">fixtureに結果データはありません。</p></section>`;
  return pageShell("試合詳細", `<div data-game-code="${escapeHtml(game.npbGameCode)}" data-game-date="${escapeHtml(game.gameDate)}" data-home-team="${escapeHtml(game.homeTeam)}" data-away-team="${escapeHtml(game.awayTeam)}" data-game-status="${escapeHtml(game.status)}" data-start-at="${escapeHtml(game.startAt)}">${lineupContent}</div>`);
}

function starterPage(date, teams, groups) {
  const games = simulatorGames(date, teams, groups);
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>予告先発 | S9simu NPB</title><body>${testOnlyNotice()}<h1>予告先発</h1><h4>${Number(date.slice(5, 7))}月 ${Number(date.slice(8, 10))}日 ${date.slice(0, 4)}</h4><section>${games.map((game, index) => `<div class="unit cl_${index + 1}"><div class="team_left"><img alt="${escapeHtml(game.homeTeam)}"><span>${escapeHtml(`テスト ${teams[game.homeKey].shortName} 先発`)}</span></div><div class="team_right"><img alt="${escapeHtml(game.awayTeam)}"><span>${escapeHtml(`テスト ${teams[game.awayKey].shortName} 先発`)}</div><div class="info">18:00 （S9simu球場）</div></div>`).join("")}</section></body></html>`;
}

function lineupPage(game, teamKey, available, teams, lineup) {
  const team = teams[teamKey];
  const rows = lineupRows(teamKey, teams, available, lineup);
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>試合速報・オーダー | S9simu NPB</title><body>${testOnlyNotice()}<h1>最新のオーダー</h1><div data-game-code="${game.npbGameCode}" data-game-date="${game.gameDate}" data-home-team="${game.homeTeam}" data-away-team="${game.awayTeam}" data-game-status="scheduled" data-start-at="${game.startAt}"><h5>${escapeHtml(team.displayName)}</h5><table data-lineup-team="${teamKey}"><thead><tr><th>打順</th><th>守備</th><th>選手名</th></tr></thead><tbody>${rows}</tbody></table>${available ? "" : "<p>スタメン未発表</p>"}</div></body></html>`;
}

function lineupEditorPage(games) {
  const options = games.map((game) => `<option value="${escapeHtml(game.npbGameCode)}">${escapeHtml(game.awayTeam)} vs ${escapeHtml(game.homeTeam)}</option>`).join("");
  const teamEditor = (side, heading) => `<section class="panel editor-team" data-editor-side="${side}"><h2>${heading}</h2><div class="lineup-slots"></div></section>`;
  const content = `<header class="page-heading"><p class="eyebrow">STARTING LINEUP</p><h1>Lineup Editor</h1><label class="editor-game-label" for="editor-game">試合</label><select id="editor-game">${options}</select><p id="editor-game-meta" class="editor-game-meta"></p></header><p id="editor-message" class="editor-message" role="status" aria-live="polite"></p><form id="lineup-editor-form"><div class="lineup-grid">${teamEditor("away", "ビジター")}${teamEditor("home", "ホーム")}</div><button id="save-lineup" class="save-lineup" type="submit">スタメンを保存</button></form><script defer src="/assets/simu-npb-lineup-editor.js"></script>`;
  return pageShell("Lineup Editor", content);
}

export async function handleSimulatedNpbRequest(request, env = {}, { TEST_TEAMS, TEST_TEAM_GROUPS, authorizeAdmin } = {}) {
  if (!TEST_TEAMS || !TEST_TEAM_GROUPS) throw new Error("S9simu team catalogue is required");
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const date = simulatorGameDate();
  const games = simulatorGames(date, TEST_TEAMS, TEST_TEAM_GROUPS);
  const lineupState = await env.SIMU_NPB_STATE?.get("lineup-state").catch(() => null) || "pre-lineup";

  if (path === "/simu-npb/lineup-editor" && request.method === "GET") {
    return htmlResponse(lineupEditorPage(games));
  }

  const lineupApiMatch = path.match(/^\/simu-npb\/api\/lineups\/([a-z0-9-]+)$/i);
  if (lineupApiMatch && ["GET", "PUT"].includes(request.method)) {
    const game = games.find((entry) => entry.npbGameCode.toLowerCase() === lineupApiMatch[1].toLowerCase());
    if (!game) return notFound();
    if (request.method === "PUT") return saveLineups(request, env, game, TEST_TEAMS, authorizeAdmin);
    try {
      const stored = await readStoredLineups(env, game, TEST_TEAMS);
      return Response.json({ ok: true, game: editorGameData(game, stored, TEST_TEAMS) }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return Response.json({ ok: false, code: error?.code || "SIMULATOR_STATE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }

  if (path === "/simu-npb/control" && request.method === "POST") {
    const denied = await authorizeSameOriginWrite(request, authorizeAdmin);
    if (denied) return denied;
    const body = await readJsonLimited(request);
    if (!body || !["pre-lineup", "available"].includes(body.lineupState)) {
      return Response.json({ ok: false, code: "INVALID_SIMULATOR_STATE" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    if (!env.SIMU_NPB_STATE) return Response.json({ ok: false, code: "SIMULATOR_STATE_UNAVAILABLE" }, { status: 503 });
    try { await env.SIMU_NPB_STATE.put("lineup-state", body.lineupState); } catch {
      return Response.json({ ok: false, code: "SIMULATOR_STATE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
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
    if (!game) return notFound();
    try {
      const stored = await readStoredLineups(env, game, TEST_TEAMS);
      return htmlResponse(gamePage(game, TEST_TEAMS, lineupState === "available", stored));
    } catch (error) {
      return Response.json({ ok: false, code: error?.code || "SIMULATOR_STATE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
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
    try {
      const stored = await readStoredLineups(env, game, TEST_TEAMS);
      const lineup = stored?.[`${teamKey === game.awayKey ? "away" : "home"}Lineup`] || defaultLineup(teamKey, TEST_TEAMS);
      return htmlResponse(lineupPage(game, teamKey, Boolean(stored) || lineupState === "available", TEST_TEAMS, lineup));
    } catch (error) {
      return Response.json({ ok: false, code: error?.code || "SIMULATOR_STATE_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }
  return notFound();
}

function htmlResponse(body) {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function notFound() {
  return Response.json({ ok: false, code: "SIMULATED_SOURCE_NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}
