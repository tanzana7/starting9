import test from "node:test";
import assert from "node:assert/strict";
import { TEST_TEAMS, TEST_TEAM_GROUPS, TEST_TEAM_KEYS } from "../tooling/test-site/teams.js";
import { handleSimulatedNpbRequest, simulatorGameDate } from "../tooling/test-site/simu-npb/source.js";
import { parseSimulatorResponse, resolveNpbSource } from "../backend/npb-source-adapter.js";
import { extractScheduleGames, extractTeamRoster } from "../cloudflare-worker.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function kv(initial = null) {
  let value = initial;
  return {
    async get() { return value; },
    async put(_key, next) { value = next; },
    state() { return value; }
  };
}

async function sourceRequest(path, { state = null, method = "GET", body } = {}) {
  const response = await handleSimulatedNpbRequest(new Request(`https://s9simu.example${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), { SIMU_NPB_STATE: kv(state) }, { TEST_TEAMS, TEST_TEAM_GROUPS });
  return response;
}

test("simulated NPB schedule passes the existing official schedule parser for six physical games", async () => {
  const date = simulatorGameDate();
  const [, year, month] = date.match(/^(\d{4})-(\d{2})-/);
  const page = await sourceRequest(`/simu-npb/games/${year}/schedule_${month}_detail.html?date=${date}&team=all`);
  assert.equal(page.status, 200);
  const html = await page.text();
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
    const response = await sourceRequest(`/simu-npb/announcement/roster/${teamKey}/`);
    assert.equal(response.status, 200);
    const parsed = extractTeamRoster(await response.text(), teamKey);
    assert.equal(parsed.players.length, 15, teamKey);
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

test("the actual NPB score-page lineup parser handles each selected team and fails closed before publication", async () => {
  const date = simulatorGameDate();
  const game = (await (await sourceRequest(`/simu-npb/api/public/games?date=${date}&team=all`)).json()).games[0];
  const [, year, month, day] = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const path = `/simu-npb/scores/${year}/${month}${day}/${game.npbGameCode}/?team=${game.homeKey}`;
  const preLineup = await sourceRequest(path);
  const notPublished = await parseSimulatorResponse(preLineup, { mode: "lineup", team: game.homeKey });
  assert.equal(notPublished.ok, false);
  assert.equal(notPublished.code, "LINEUP_NOT_PUBLISHED");

  const availablePage = await sourceRequest(path, { state: "available" });
  const available = await parseSimulatorResponse(availablePage, { mode: "lineup", team: game.homeKey });
  assert.equal(available.ok, true);
  assert.equal(available.payload.lineup.length, 9);
  assert.ok(available.payload.lineup.every((player) => player.playerName.includes(TEST_TEAMS[game.homeKey].shortName)));

  const awayResponse = await sourceRequest(path.replace(`team=${game.homeKey}`, `team=${game.awayKey}`), { state: "available" });
  const away = await parseSimulatorResponse(awayResponse, { mode: "lineup", team: game.awayKey });
  assert.equal(away.ok, true);
  assert.ok(away.payload.lineup.every((player) => player.playerName.includes(TEST_TEAMS[game.awayKey].shortName)));
  assert.notEqual(available.payload.lineup[0].playerName, away.payload.lineup[0].playerName);
});

test("starter parser, controls and unknown routes remain bounded and test-only", async () => {
  const date = simulatorGameDate();
  const starter = await parseSimulatorResponse(await sourceRequest("/simu-npb/announcement/starter/"), { mode: "starter" });
  assert.equal(starter.ok, true);
  assert.equal(starter.payload.games.length, 6);
  assert.equal(starter.payload.date, date);

  const change = await sourceRequest("/simu-npb/control", { method: "POST", body: { lineupState: "available" } });
  assert.equal(change.status, 200);
  const invalid = await sourceRequest("/simu-npb/control", { method: "POST", body: { lineupState: "anything" } });
  assert.equal(invalid.status, 400);
  assert.equal((await sourceRequest("/simu-npb/unknown")).status, 404);
  assert.equal(resolveNpbSource({ NPB_SOURCE: "simulator", ENVIRONMENT: "production", ENABLE_DEVELOPMENT_MODE: "false" }).kind, "official");
});

test("the generated Test Pages build includes the simulator routes but production Pages does not", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const builder = fs.readFileSync(path.join(root, "tooling/test-site/build-pages.mjs"), "utf8");
  const productionBuilder = fs.readFileSync(path.join(root, "tooling/production-pages/build.mjs"), "utf8");
  assert.match(builder, /simu-npb/);
  assert.match(builder, /s9simu\.pages\.dev/);
  assert.doesNotMatch(productionBuilder, /simu-npb|s9simu\.pages\.dev/);
});
