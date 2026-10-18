import test from "node:test";
import assert from "node:assert/strict";
import { createTestSiteMultiTeamFixture } from "./helpers/test-site-multi-team-fixture.js";
import { assertDistinctTestTeamIdentity, TEST_TEAMS, testTeamFixture } from "../tooling/test-site/teams.js";
import teamContext from "../frontend/shared/team-context.js";

test("isolated teams keep distinct games/rosters/predictions and use the formal publish pipeline three times", async () => {
  const f = await createTestSiteMultiTeamFixture();
  try {
    const teams = ["fighters", "foxes", "marines"];
    for (let round = 0; round < 3; round++) {
      const seeds = await Promise.all(teams.map((key) => f.request(key, "/api/test/reset", {})));
      assert.equal(new Set(seeds.map((entry) => entry.game.internalGameId)).size, teams.length);
      for (const key of teams) {
        const { team, internalGameId } = testTeamFixture(key);
        const opponent = key === "marines" ? "fighters" : "marines";
        const publicGames = await f.request(key, "/api/public/games");
        const selected = publicGames.games.filter((entry) => entry.internalGameId === internalGameId);
        assert.equal(selected.length, 1);
        assert.equal(selected[0].homeTeam, team.key);
        assert.equal(selected[0].homeTeamName, team.shortName);
        assert.match(selected[0].displayLabel, new RegExp(team.shortName));
        assert.equal(selected[0].awayTeam, opponent);
        const roster = await f.request(key, `/api/game-day-roster?internalGameId=${internalGameId}`);
        assert.equal(roster.players.length, 15);
        assert.ok(roster.players.every((player) => player.teamCode === team.key && player.teamId === team.playerTeamId));
        const probable = await f.request(key, `/api/probable-starter?internalGameId=${internalGameId}`);
        assert.equal(probable.internalGameId, internalGameId);
        assert.equal(probable.homeTeam, team.key);
        assert.equal(probable.awayTeam, opponent);
        assert.equal(probable.dataStatus, "unannounced");
        const lineup = roster.players.slice(0, 9).map((player, index) => ({
          playerId: player.playerId, playerName: player.name, uniformNumber: player.uniformNumber,
          teamCode: team.key, teamId: team.playerTeamId, battingOrder: index + 1,
          position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index]
        }));
        await f.request(key, "/api/predictions/current", { internalGameId, prediction: { schemaVersion: 1, lineup } }, "PUT");
        const closed = await f.request(key, "/api/test/scenario", { scenario: "closed" });
        assert.equal(closed.game.state, "prediction_closed");
        const result = await f.request(key, "/api/test/scenario", { scenario: "published" });
        assert.equal(result.game.state, "published");
        assert.equal(result.game.publication_status, "published");
        const resultHistory = await f.request(key, "/api/results/games");
        const historyEntry = resultHistory.games.find((entry) => entry.internalGameId === internalGameId);
        assert.ok(historyEntry);
        assert.match(historyEntry.displayLabel, new RegExp(team.shortName));
        assert.equal(historyEntry.gameLabel, historyEntry.displayLabel);
        const resultDetail = await f.request(key, `/api/results/games/${internalGameId}`);
        assert.equal(resultDetail.internalGameId, internalGameId);
        assert.equal(resultDetail.totalScore, 99);
        const predictions = f.database.prepare("SELECT prediction_json, score FROM predictions WHERE internal_game_id = ?").all(internalGameId);
        assert.equal(predictions.length, 1);
        assert.equal(predictions[0].score, 99);
        assert.ok(JSON.parse(predictions[0].prediction_json).lineup.every((player) => player.teamCode === team.key));
      }
    }
    for (const key of ["fighters", "foxes", "marines"]) {
      const baseline = await f.request(key, "/api/test/reset", {});
      assert.equal(baseline.game.internalGameId, testTeamFixture(key).internalGameId);
      const status = await f.request(key, "/api/test/status");
      assert.equal(status.game.state, "scheduled");
      const history = await f.request(key, "/api/results/games");
      assert.equal(history.games.some((entry) => entry.internalGameId === testTeamFixture(key).internalGameId), false);
      assert.equal(f.audit.prepare("SELECT COUNT(*) AS count FROM game_automation_v3_audit WHERE internal_game_id = ?")
        .get(testTeamFixture(key).internalGameId).count, 0);
    }
  } finally { f.close(); }
});

test("synthetic Team B detects identity, selector, roster, and branding regressions", () => {
  assert.equal(assertDistinctTestTeamIdentity(), true);
  assert.throws(() => assertDistinctTestTeamIdentity({
    ...TEST_TEAMS, foxes: teamContext.defineTeamContext({ ...TEST_TEAMS.foxes, providerTeamCode: TEST_TEAMS.fighters.providerTeamCode })
  }), /distinct team identities/);

  const foxesGame = { homeTeam: TEST_TEAMS.foxes.key, awayTeam: "marines" };
  assert.equal(teamContext.gameSide(foxesGame, TEST_TEAMS.foxes), "home");
  assert.equal(teamContext.gameSide(foxesGame, TEST_TEAMS.fighters), null);

  const foxRoster = [{ teamCode: TEST_TEAMS.fighters.key, teamId: TEST_TEAMS.fighters.playerTeamId }];
  assert.equal(foxRoster.every((player) => player.teamCode === TEST_TEAMS.foxes.key
    && player.teamId === TEST_TEAMS.foxes.playerTeamId), false);

  const variables = new Map();
  const element = { style: { setProperty: (name, value) => variables.set(name, value) } };
  teamContext.applyBranding(element, TEST_TEAMS.foxes);
  const foxesPrimary = variables.get("--fighters-blue");
  teamContext.applyBranding(element, TEST_TEAMS.fighters);
  assert.notEqual(foxesPrimary, variables.get("--fighters-blue"));
});
