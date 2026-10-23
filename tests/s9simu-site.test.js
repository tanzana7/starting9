import test from "node:test";
import assert from "node:assert/strict";
import { TEST_TEAMS, TEST_TEAM_GROUPS, TEST_TEAM_KEYS } from "../tooling/test-site/teams.js";
import { handleSimulatedNpbRequest, simulatorGameDate, simulatorRoster } from "../tooling/test-site/simu-npb/source.js";
import { parseSimulatorResponse, resolveNpbSource } from "../backend/npb-source-adapter.js";
import { fetchLatestPublicRoster } from "../auth-worker.js";
import { extractScheduleGames, extractTeamRoster } from "../cloudflare-worker.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function kv(initial = null) {
  const values = new Map();
  if (initial !== null) values.set("lineup-state", initial);
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, next) { values.set(key, next); },
    state(key = "lineup-state") { return values.get(key) ?? null; }
  };
}

async function sourceRequest(path, { state = null, method = "GET", body, store = kv(state), authorizeAdmin = async () => ({ ok: true }), headers: extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) {
    headers["Content-Type"] ||= "application/json";
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      headers.Origin ||= "https://s9simu.example";
      if (!Object.hasOwn(headers, "X-Simu-NPB-Write")) headers["X-Simu-NPB-Write"] = "1";
    }
  }
  const response = await handleSimulatedNpbRequest(new Request(`https://s9simu.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { SIMU_NPB_STATE: store }, { TEST_TEAMS, TEST_TEAM_GROUPS, authorizeAdmin });
  return response;
}

test("simulated NPB schedule passes the existing official schedule parser for six physical games", async () => {
  const date = simulatorGameDate();
  const [, year, month] = date.match(/^(\d{4})-(\d{2})-/);
  const page = await sourceRequest(`/simu-npb/games/${year}/schedule_${month}_detail.html?date=${date}&team=all`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /SIMULATED NPB · TEST DATA ONLY/);
  const parsed = extractScheduleGames(html, date);
  assert.equal(parsed.length, 6);
  assert.equal(new Set(parsed.flatMap((game) => [game.homeTeam, game.awayTeam])).size, 12);
  assert.ok(parsed.every((game) => game.gameCode && game.startTime === "18:00"));
  const otherDate = new Date(`${date}T00:00:00+09:00`);
  otherDate.setDate(otherDate.getDate() + 1);
  const nextDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(otherDate);
  const otherPath = `/simu-npb/games/${nextDate.slice(0, 4)}/schedule_${nextDate.slice(5, 7)}_detail.html?date=${nextDate}&team=all`;
  assert.equal(extractScheduleGames(await (await sourceRequest(otherPath)).text(), nextDate).length, 0);
  assert.equal((await sourceRequest(`/simu-npb/games/${year}/schedule_${month}_detail.html?date=not-a-date&team=all`)).status, 400);
});

test("all twelve simulated rosters pass the existing NPB roster parser without cross-team identities", async () => {
  const rosterSizes = new Map();
  const identities = new Set();
  for (const teamKey of TEST_TEAM_KEYS) {
    const fixtureRoster = simulatorRoster(teamKey, TEST_TEAMS);
    const response = await sourceRequest(`/simu-npb/announcement/roster/${teamKey}/`);
    assert.equal(response.status, 200);
    const parsed = extractTeamRoster(await response.text(), teamKey);
    assert.equal(parsed.players.length, 15, teamKey);
    assert.deepEqual(parsed.players.map((player) => ({
      playerId: player.playerId,
      name: player.name,
      number: player.number,
      position: player.position
    })), fixtureRoster.map((player) => ({
      playerId: player.playerId,
      name: player.name.replace(/[\s\u3000]/g, ""),
      number: player.number,
      position: player.position
    })), teamKey);
    assert.equal(new Set(fixtureRoster.map((player) => player.name)).size, 15, `${teamKey}: duplicate name`);
    assert.ok(fixtureRoster.every((player) => !/^(?:player|batter)\s*\d+$/i.test(player.name)
      && !/^選手\s*\d+$/.test(player.name)), `${teamKey}: placeholder name remains`);
    assert.deepEqual(fixtureRoster.reduce((counts, player) => {
      counts[player.position] = (counts[player.position] || 0) + 1;
      return counts;
    }, {}), { 捕手: 2, 内野手: 5, 外野手: 5, 投手: 3 }, `${teamKey}: roster composition`);
    assert.deepEqual(fixtureRoster.map((player) => player.playerId), Array.from({ length: 15 }, (_, index) =>
      `npb:${String(90000001 + TEST_TEAM_KEYS.indexOf(teamKey) * 100 + index)}`), `${teamKey}: stable simulator IDs`);
    for (const player of parsed.players) {
      assert.ok(player.playerId?.startsWith("npb:"));
      assert.ok(!identities.has(player.playerId), `duplicate simulator player identity ${player.playerId}`);
      identities.add(player.playerId);
    }
    rosterSizes.set(teamKey, parsed.players.length);
  }
  assert.equal(rosterSizes.size, 12);
  assert.equal(identities.size, 180);
  assert.equal(extractTeamRoster("<html>wrong team only</html>", "marines").players.length, 0);
});

test("isolated Test Site fetches its 15-player simulator roster without lowering the official-source minimum", async () => {
  const originalFetch = globalThis.fetch;
  const testTeam = TEST_TEAMS.giants;
  const game = { internal_game_id: TEST_TEAM_GROUPS[0].internalGameId, game_date: simulatorGameDate() };
  const env = {
    ENVIRONMENT: "test",
    TEST_SITE_ID: "starting9-isolated-v1",
    TEST_WORKER_NAME: "starting9-test-auth",
    TEST_AUTH_DB_ID: "7ea1fa14-ffc0-4404-8a65-5dbb8218f368",
    TEST_AUDIT_DB_ID: "a18c6cf9-a238-4059-a5ef-784f248e225e",
    ENABLE_DEVELOPMENT_MODE: "true",
    TARGET_TEAM_CONTEXT: testTeam,
    NPB_SOURCE: "simulator",
    S9SIMU_ENABLED: "true",
    S9SIMU_BASE_URL: "https://s9simu.example",
    NPB_FETCH_DISABLED: "false"
  };
  try {
    globalThis.fetch = async (input) => sourceRequest(new URL(input).pathname);
    const simulated = await fetchLatestPublicRoster(env, game);
    assert.equal(simulated?.status, "fresh");
    assert.equal(simulated?.playerCount, 15);
    assert.ok(simulated.players.every((player) => player.teamCode === "giants" && player.teamId === testTeam.playerTeamId));

    const officialEnv = {
      ENABLE_DEVELOPMENT_MODE: "false",
      NPB_FETCH_WORKER: { fetch: async () => Response.json({ ok: true, players: simulated.players }) }
    };
    assert.equal(resolveNpbSource(officialEnv).kind, "official");
    assert.equal(await fetchLatestPublicRoster(officialEnv, game), null, "official-source completeness still rejects a 15-player response");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the actual NPB score-page lineup parser handles each selected team and fails closed before publication", async () => {
  const date = simulatorGameDate();
  const game = (await (await sourceRequest(`/simu-npb/api/public/games?date=${date}&team=all`)).json()).games[0];
  const [, year, month, day] = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const path = `/simu-npb/scores/${year}/${month}${day}/${game.npbGameCode}/?team=${game.homeKey}`;
  const preLineup = await sourceRequest(path);
  assert.match(await preLineup.clone().text(), /SIMULATED NPB · TEST DATA ONLY/);
  const notPublished = await parseSimulatorResponse(preLineup, { mode: "lineup", team: game.homeKey });
  assert.equal(notPublished.ok, false);
  assert.equal(notPublished.code, "LINEUP_NOT_PUBLISHED");

  const availablePage = await sourceRequest(path, { state: "available" });
  assert.match(await availablePage.clone().text(), /SIMULATED NPB · TEST DATA ONLY/);
  const available = await parseSimulatorResponse(availablePage, { mode: "lineup", team: game.homeKey });
  assert.equal(available.ok, true);
  assert.equal(available.payload.lineup.length, 9);
  assert.deepEqual(available.payload.lineup.map((player) => player.playerName), simulatorRoster(game.homeKey, TEST_TEAMS)
    .slice(0, 9).map((player) => player.name.replace(/[\s\u3000]/g, "")));

  const awayResponse = await sourceRequest(path.replace(`team=${game.homeKey}`, `team=${game.awayKey}`), { state: "available" });
  const away = await parseSimulatorResponse(awayResponse, { mode: "lineup", team: game.awayKey });
  assert.equal(away.ok, true);
  assert.deepEqual(away.payload.lineup.map((player) => player.playerName), simulatorRoster(game.awayKey, TEST_TEAMS)
    .slice(0, 9).map((player) => player.name.replace(/[\s\u3000]/g, "")));
  assert.notEqual(available.payload.lineup[0].playerName, away.payload.lineup[0].playerName);
});

test("starter parser, controls and unknown routes remain bounded and test-only", async () => {
  const date = simulatorGameDate();
  const starterResponse = await sourceRequest("/simu-npb/announcement/starter/");
  assert.match(await starterResponse.clone().text(), /SIMULATED NPB · TEST DATA ONLY/);
  const starter = await parseSimulatorResponse(starterResponse, { mode: "starter" });
  assert.equal(starter.ok, true);
  assert.equal(starter.payload.games.length, 6);
  assert.equal(starter.payload.date, date);

  const change = await sourceRequest("/simu-npb/control", { method: "POST", body: { lineupState: "available" } });
  assert.equal(change.status, 200);
  const invalid = await sourceRequest("/simu-npb/control", { method: "POST", body: { lineupState: "anything" } });
  assert.equal(invalid.status, 400);
  const controlStore = kv();
  const unauthorizedControl = await sourceRequest("/simu-npb/control", {
    method: "POST",
    body: { lineupState: "available" },
    store: controlStore,
    authorizeAdmin: async () => ({ ok: false, code: "ADMIN_REQUIRED", status: 401 })
  });
  assert.equal(unauthorizedControl.status, 401);
  assert.equal(controlStore.state(), null, "legacy fixture control cannot be written anonymously");
  assert.equal((await sourceRequest("/simu-npb/unknown")).status, 404);
  assert.equal(resolveNpbSource({ NPB_SOURCE: "simulator", ENVIRONMENT: "production", ENABLE_DEVELOPMENT_MODE: "false" }).kind, "official");
});

test("the generated Simulated NPB build owns simulator routes without cloning the Starting9 app", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const builder = fs.readFileSync(path.join(root, "tooling/test-site/build-pages.mjs"), "utf8");
  const productionBuilder = fs.readFileSync(path.join(root, "tooling/production-pages/build.mjs"), "utf8");
  const productionRoutes = JSON.parse(fs.readFileSync(path.join(root, "_routes.json"), "utf8"));
  assert.match(builder, /simu-npb/);
  assert.match(builder, /routeManifest\.include/);
  assert.match(builder, /simulatorSourceDirectory, "rosters\.js"/);
  assert.doesNotMatch(builder, /TEST_SITE_PAGE_FILES|SHARED_PAGE_DIRECTORIES|starting9AppDirectory|test-environment\.css/);
  assert.equal(productionRoutes.include.includes("/simu-npb/*"), false);
  assert.doesNotMatch(productionBuilder, /simu-npb|s9simu\.pages\.dev/);
});

test("Simulated NPB portal exposes fixture navigation without Starting9 pipeline controls", async () => {
  const date = simulatorGameDate();
  const root = await sourceRequest("/");
  assert.equal(root.status, 200);
  const home = await root.text();
  assert.match(home, /SIMULATED NPB · TEST DATA ONLY/);
  assert.match(home, /<h1>Simulated NPB<\/h1>/);
  assert.match(home, new RegExp(date));
  assert.equal((home.match(/class="game-card"/g) || []).length, 6);
  assert.equal((home.match(/class="team-link"/g) || []).length, 12);
  assert.doesNotMatch(home, /lineup-control|ログイン|予想する|リセット/);
  assert.match(home, /href="\/simu-npb\/lineup-editor">Lineup Editor<\/a>/);
  const editor = await sourceRequest("/simu-npb/lineup-editor");
  assert.equal(editor.status, 200);
  assert.match(await editor.text(), /SIMULATED NPB · TEST DATA ONLY/);
  assert.equal((await sourceRequest("/starting9/")).status, 404);

  const schedule = await sourceRequest("/simu-npb/schedule");
  assert.equal(schedule.status, 200);
  const scheduleHtml = await schedule.text();
  const games = (await (await sourceRequest(`/simu-npb/api/public/games?date=${date}&team=all`)).json()).games;
  assert.equal((scheduleHtml.match(/class="game-card"/g) || []).length, 6);
  for (const game of games) {
    assert.match(scheduleHtml, new RegExp(`Fixture ID:[\\s\\S]{0,40}${game.npbGameCode}`));
    assert.match(scheduleHtml, new RegExp(game.venue));
  }
  assert.equal(new Set(games.flatMap((game) => [game.homeKey, game.awayKey])).size, 12);

  const teamsPage = await sourceRequest("/simu-npb/teams");
  assert.equal((await teamsPage.text()).match(/class="team-link"/g)?.length, 12);
  for (const teamKey of TEST_TEAM_KEYS) {
    const response = await sourceRequest(`/simu-npb/team/${teamKey}`);
    assert.equal(response.status, 200, teamKey);
    const html = await response.text();
    assert.match(html, /SIMULATED NPB · TEST DATA ONLY/);
    assert.match(html, new RegExp(`<h5>${TEST_TEAMS[teamKey].displayName}<\\/h5>`));
    assert.equal((html.match(/data-player-id="npb:/g) || []).length, 15, teamKey);
    assert.match(html, /背番号/);
    assert.match(html, /選手ID/);
  }
});

test("Simulated NPB game detail renders both fixture lineups and keeps the parser source contract", async () => {
  const date = simulatorGameDate();
  const games = (await (await sourceRequest(`/simu-npb/api/public/games?date=${date}&team=all`)).json()).games;
  assert.equal(games.length, 6);
  for (const game of games) {
    assert.ok(game.npbGameCode);
    const response = await sourceRequest(`/simu-npb/game/${game.npbGameCode}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`data-game-code="${game.npbGameCode}"`));
    assert.match(html, new RegExp(`data-away-team="${game.awayTeam}"`));
    assert.match(html, new RegExp(`data-home-team="${game.homeTeam}"`));
    assert.equal((html.match(/data-lineup-team=/g) || []).length, 0, "unannounced fixture must not expose lineup tables");
  }

  const available = await sourceRequest(`/simu-npb/game/${games[0].npbGameCode}`, { state: "available" });
  const html = await available.text();
  assert.equal((html.match(/data-lineup-team=/g) || []).length, 2);
  assert.equal((html.match(/<tbody>/g) || []).length, 2);
  assert.equal((html.match(/<tbody>[\s\S]*?<\/tbody>/g) || []).join("").match(/<tr>/g)?.length, 18);
  for (const teamKey of [games[0].homeKey, games[0].awayKey]) {
    const path = `/simu-npb/scores/${date.slice(0, 4)}/${date.slice(5, 7)}${date.slice(8, 10)}/${games[0].npbGameCode}/?team=${teamKey}`;
    const parsed = await parseSimulatorResponse(await sourceRequest(path, { state: "available" }), { mode: "lineup", team: teamKey });
    assert.equal(parsed.ok, true, teamKey);
    assert.equal(parsed.payload.lineup.length, 9, teamKey);
    assert.deepEqual(parsed.payload.lineup.map((player) => player.playerName), simulatorRoster(teamKey, TEST_TEAMS)
      .slice(0, 9).map((player) => player.name.replace(/[\s\u3000]/g, "")));
  }
});

test("lineup editor exposes six games with each side's own roster and nine persisted slots", async () => {
  const editor = await sourceRequest("/simu-npb/lineup-editor");
  assert.equal(editor.status, 200);
  const html = await editor.text();
  assert.equal((html.match(/<option value="g-t-/g) || []).length, 6);
  assert.match(html, /data-editor-side="away"/);
  assert.match(html, /data-editor-side="home"/);
  assert.match(html, /simu-npb-lineup-editor\.js/);

  const date = simulatorGameDate();
  const games = (await (await sourceRequest(`/simu-npb/api/public/games?date=${date}&team=all`)).json()).games;
  assert.equal(games.length, 6);
  for (const game of games) {
    const response = await sourceRequest(`/simu-npb/api/lineups/${game.npbGameCode}`);
    assert.equal(response.status, 200);
    const { away, home, providerGameId } = (await response.json()).game;
    assert.equal(providerGameId, game.npbGameCode);
    assert.equal(away.roster.length, 15);
    assert.equal(home.roster.length, 15);
    assert.deepEqual(away.roster.map((player) => player.playerId), simulatorRoster(game.awayKey, TEST_TEAMS).map((player) => player.playerId));
    assert.deepEqual(home.roster.map((player) => player.playerId), simulatorRoster(game.homeKey, TEST_TEAMS).map((player) => player.playerId));
    assert.deepEqual(away.roster.map(({ playerId, name, number }) => ({ playerId, name, number })), simulatorRoster(game.awayKey, TEST_TEAMS).map(({ playerId, name, number }) => ({ playerId, name, number })));
    assert.deepEqual(home.roster.map(({ playerId, name, number }) => ({ playerId, name, number })), simulatorRoster(game.homeKey, TEST_TEAMS).map(({ playerId, name, number }) => ({ playerId, name, number })));
    assert.deepEqual(away.lineup.map((row) => row.order), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(home.lineup.map((row) => row.order), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(away.lineup.every((row) => away.roster.some((player) => player.playerId === row.playerId)));
    assert.ok(home.lineup.every((row) => home.roster.some((player) => player.playerId === row.playerId)));
  }
});

test("admin lineup save persists by game and team and reaches the unchanged Starting9 parser source", async () => {
  const store = kv();
  const date = simulatorGameDate();
  const games = (await (await sourceRequest(`/simu-npb/api/public/games?date=${date}&team=all`)).json()).games;
  const game = games[0];
  const rosterFor = (teamKey) => Array.from({ length: 15 }, (_, index) => `npb:${String(90000001 + TEST_TEAM_KEYS.indexOf(teamKey) * 100 + index)}`);
  const awayIds = rosterFor(game.awayKey).slice(3, 12).reverse();
  const homeIds = rosterFor(game.homeKey).slice(2, 11).reverse();
  const payload = {
    providerGameId: game.npbGameCode,
    awayLineup: awayIds.map((playerId, index) => ({ order: index + 1, playerId })),
    homeLineup: homeIds.map((playerId, index) => ({ order: index + 1, playerId }))
  };
  const save = await sourceRequest(`/simu-npb/api/lineups/${game.npbGameCode}`, { method: "PUT", body: payload, store });
  assert.equal(save.status, 200);
  assert.equal((await save.json()).ok, true);

  // A new request using the same persistent store models refresh/another browser.
  const readBack = await sourceRequest(`/simu-npb/api/lineups/${game.npbGameCode}`, { store });
  const savedGame = (await readBack.json()).game;
  assert.deepEqual(savedGame.away.lineup.map((row) => row.playerId), awayIds);
  assert.deepEqual(savedGame.home.lineup.map((row) => row.playerId), homeIds);
  assert.equal(savedGame.announced, true);

  const gamePage = await sourceRequest(`/simu-npb/game/${game.npbGameCode}`, { store });
  const gameHtml = await gamePage.text();
  assert.ok(gameHtml.indexOf(`data-lineup-team="${game.awayKey}"`) < gameHtml.indexOf(`data-lineup-team="${game.homeKey}"`));
  for (const [teamKey, ids] of [[game.awayKey, awayIds], [game.homeKey, homeIds]]) {
    const path = `/simu-npb/scores/${date.slice(0, 4)}/${date.slice(5, 7)}${date.slice(8, 10)}/${game.npbGameCode}/?team=${teamKey}`;
    const parsed = await parseSimulatorResponse(await sourceRequest(path, { store }), { mode: "lineup", team: teamKey });
    assert.equal(parsed.ok, true, teamKey);
    assert.deepEqual(parsed.payload.lineup.map((row) => row.order), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const playerNames = new Map(simulatorRoster(teamKey, TEST_TEAMS).map(({ playerId, name }) => [playerId, name]));
    assert.deepEqual(parsed.payload.lineup.map((row) => row.playerName), ids.map((id) => playerNames.get(id).replace(/\s+/g, "")));
  }

  const untouched = await sourceRequest(`/simu-npb/api/lineups/${games[1].npbGameCode}`, { store });
  const otherGame = (await untouched.json()).game;
  assert.equal(otherGame.announced, false);
  assert.notDeepEqual(otherGame.away.lineup.map((row) => row.playerId), awayIds);
  assert.notDeepEqual(savedGame.away.lineup.map((row) => row.playerId), savedGame.home.lineup.map((row) => row.playerId));
});

test("lineup writes reject missing admin/CSRF and invalid, duplicate, or cross-team players without storage changes", async () => {
  const store = kv();
  const date = simulatorGameDate();
  const game = (await (await sourceRequest(`/simu-npb/api/public/games?date=${date}&team=all`)).json()).games[0];
  const ids = (teamKey) => Array.from({ length: 9 }, (_, index) => `npb:${String(90000001 + TEST_TEAM_KEYS.indexOf(teamKey) * 100 + index)}`);
  const good = {
    providerGameId: game.npbGameCode,
    awayLineup: ids(game.awayKey).map((playerId, index) => ({ order: index + 1, playerId })),
    homeLineup: ids(game.homeKey).map((playerId, index) => ({ order: index + 1, playerId }))
  };
  const key = `lineup:v1:${date}:${game.npbGameCode}`;
  const deny = async (status, options) => {
    const response = await sourceRequest(`/simu-npb/api/lineups/${game.npbGameCode}`, { method: "PUT", body: good, store, ...options });
    assert.equal(response.status, status);
    assert.equal(store.state(key), null);
  };
  const unknownGame = await sourceRequest("/simu-npb/api/lineups/not-a-game", {
    method: "PUT", body: { ...good, providerGameId: "not-a-game" }, store
  });
  assert.equal(unknownGame.status, 404);
  assert.equal(store.state(key), null);
  await deny(401, { authorizeAdmin: async () => ({ ok: false, code: "ADMIN_REQUIRED", status: 401 }) });
  await deny(403, { headers: { "X-Simu-NPB-Write": "" } });

  for (const [mutation, expectedCode] of [
    [(body) => { body.awayLineup[1].playerId = body.awayLineup[0].playerId; }, "DUPLICATE_PLAYER"],
    [(body) => { body.awayLineup.pop(); }, "LINEUP_INCOMPLETE"],
    [(body) => { body.homeLineup[0].playerId = body.awayLineup[0].playerId; }, "PLAYER_NOT_ON_TEAM"]
  ]) {
    const invalid = structuredClone(good);
    mutation(invalid);
    const response = await sourceRequest(`/simu-npb/api/lineups/${game.npbGameCode}`, { method: "PUT", body: invalid, store });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, expectedCode);
    assert.equal(store.state(key), null);
  }
});
