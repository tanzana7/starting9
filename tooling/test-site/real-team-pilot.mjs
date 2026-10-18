import assert from "node:assert/strict";
import npbWorker from "../../cloudflare-worker.js";
import { createTestSiteMultiTeamFixture } from "../../tests/helpers/test-site-multi-team-fixture.js";
import { testTeamFixture, TEST_TEAMS } from "./teams.js";

const CACHE = { async match() { return undefined; }, async put() {} };
const priorCaches = globalThis.caches;
globalThis.caches = { default: CACHE };

async function fetchOfficialMarinesRoster() {
  const response = await npbWorker.fetch(new Request(
    "https://npb-provider.local/?mode=roster&team=marines&force=1"
  ), {});
  const payload = await response.json();
  assert.equal(response.status, 200, `NPB roster provider returned ${payload.code || response.status}`);
  assert.equal(payload.team, "marines", "provider must not substitute the Fighters roster");
  assert.ok(Array.isArray(payload.players) && payload.players.length >= 20, "official roster must meet the existing minimum");
  assert.ok(payload.players.every((player) => /^npb:\d{8}$/.test(player.playerId)), "official NPB player IDs must be retained");
  assert.equal(new Set(payload.players.map((player) => player.playerId)).size, payload.players.length);
  assert.equal(new Set(payload.players.map((player) => player.number)).size, payload.players.length);
  return payload.players;
}

async function runPilotRound(fixture, rosterPlayers, round) {
  const { internalGameId, team } = testTeamFixture("marines");
  const request = (pathname, body, method) => fixture.request("marines", pathname, body, method);
  await request("/api/test/reset", {}, "POST");

  const games = await request("/api/public/games");
  const game = games.games.find((entry) => entry.internalGameId === internalGameId);
  assert.ok(game, "canonical Marines Test Site game must be selected");
  assert.equal(game.homeTeam, "marines");
  assert.equal(game.awayTeam, "fighters");
  assert.match(game.displayLabel, new RegExp(team.shortName));

  const roster = await request(`/api/game-day-roster?internalGameId=${internalGameId}`);
  assert.equal(roster.players.length, rosterPlayers.length);
  assert.ok(roster.players.every((player) => player.teamCode === "marines" && player.teamId === "M"));
  assert.deepEqual(roster.players.map((player) => player.playerId), rosterPlayers.map((player) => player.playerId));

  const positions = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
  const lineup = roster.players.slice(0, 9).map((player, index) => ({
    playerId: player.playerId, playerName: player.name, uniformNumber: player.uniformNumber,
    teamCode: "marines", teamId: "M", battingOrder: index + 1, position: positions[index]
  }));
  const saved = await request("/api/predictions/current", {
    internalGameId, prediction: { schemaVersion: 1, lineup }
  }, "PUT");
  assert.equal(saved.status, "submitted");
  const closed = await request("/api/test/scenario", { scenario: "closed" }, "POST");
  assert.equal(closed.game.state, "prediction_closed");
  const published = await request("/api/test/scenario", { scenario: "published" }, "POST");
  assert.equal(published.game.state, "published");
  assert.equal(published.game.publication_status, "published");

  const history = await request("/api/results/games");
  const result = history.games.find((entry) => entry.internalGameId === internalGameId);
  assert.ok(result);
  assert.match(result.displayLabel, new RegExp(team.shortName));
  const detail = await request(`/api/results/games/${internalGameId}`);
  assert.equal(detail.internalGameId, internalGameId);
  assert.equal(detail.totalScore, 99);
  assert.ok(detail.actualLineup.every((player) => player.teamCode === "marines" && player.teamId === "M"));
  console.log(`Marines live-roster local Test Site round ${round}: prediction → close → lineup → score → ranking → publish → result OK`);
}

let fixture;
try {
  const rosterPlayers = await fetchOfficialMarinesRoster();
  fixture = await createTestSiteMultiTeamFixture({ rosterPlayersByTeam: { marines: rosterPlayers } });
  for (let round = 1; round <= 3; round += 1) {
    await runPilotRound(fixture, rosterPlayers, round);
  }
  await fixture.request("marines", "/api/test/reset", {}, "POST");
  const baseline = await fixture.request("marines", "/api/test/status");
  assert.equal(baseline.game.state, "scheduled");
  const history = await fixture.request("marines", "/api/results/games");
  assert.equal(history.games.some((entry) => entry.internalGameId === testTeamFixture("marines").internalGameId), false);
  console.log(`Marines baseline restored; fetched ${rosterPlayers.length} official registered players (${TEST_TEAMS.marines.displayName}).`);
} finally {
  fixture?.close();
  globalThis.caches = priorCaches;
}
