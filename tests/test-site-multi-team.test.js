import test from "node:test";
import assert from "node:assert/strict";
import { createTestSiteMultiTeamFixture } from "./helpers/test-site-multi-team-fixture.js";
import { assertDistinctTestTeamIdentity, TEST_TEAMS, TEST_TEAM_GROUPS, TEST_TEAM_KEYS, testTeamFixture } from "../tooling/test-site/teams.js";
import teamContext from "../frontend/shared/team-context.js";
import { normalizeScheduleTeamCode } from "../game-schedule-detection.js";

const POSITIONS = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];

async function prepareTeamPrediction(fixture, key, group) {
  const team = TEST_TEAMS[key];
  const { internalGameId } = testTeamFixture(key);
  const games = await fixture.request(key, "/api/public/games");
  const selected = games.games.filter((entry) => entry.internalGameId === internalGameId);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].homeTeam, testTeamFixture(group.homeKey).team.key);
  assert.equal(selected[0].awayTeam, testTeamFixture(group.awayKey).team.key);
  assert.ok(selected[0].displayLabel.includes(TEST_TEAMS[group.homeKey].shortName));
  assert.ok(selected[0].displayLabel.includes(TEST_TEAMS[group.awayKey].shortName));

  const roster = await fixture.request(key, `/api/game-day-roster?internalGameId=${internalGameId}`);
  assert.equal(roster.players.length, 15);
  assert.ok(roster.players.every((player) => player.teamCode === team.key && player.teamId === team.playerTeamId));
  const lineup = roster.players.slice(0, 9).map((player, index) => ({
    playerId: player.playerId, playerName: player.name, uniformNumber: player.uniformNumber,
    teamCode: team.key, teamId: team.playerTeamId, battingOrder: index + 1, position: POSITIONS[index]
  }));
  const saved = await fixture.request(key, "/api/predictions/current", {
    internalGameId, prediction: { schemaVersion: 1, lineup }
  }, "PUT");
  assert.equal(saved.status, "submitted");
}

async function exerciseTeam(fixture, key, group) {
  const team = TEST_TEAMS[key];
  const { internalGameId } = testTeamFixture(key);
  const status = await fixture.request(key, "/api/test/status");
  assert.equal(status.game.internal_game_id, group.internalGameId);

  const closed = await fixture.request(key, "/api/test/scenario", { scenario: "closed" });
  assert.equal(closed.game.state, "prediction_closed", `${key} close did not advance: ${JSON.stringify({ closed,
    states: fixture.database.prepare("SELECT contest_id,state FROM contest_automation_v3_state WHERE internal_game_id=?").all(internalGameId),
    jobs: fixture.database.prepare("SELECT contest_id,job_type,status,attempt_count,failure_code FROM game_jobs_v3 WHERE internal_game_id=? ORDER BY contest_id,job_type").all(internalGameId)
  })}`);
  const published = await fixture.request(key, "/api/test/scenario", { scenario: "published" });
  assert.equal(published.game.state, "published");
  assert.equal(published.game.publication_status, "published");

  const current = await fixture.request(key, `/api/predictions/current?internalGameId=${internalGameId}`);
  assert.equal(current.score, 99, `${key} prediction was not scored: ${JSON.stringify({ current,
    predictions: fixture.database.prepare("SELECT contest_id, score FROM predictions WHERE internal_game_id = ?").all(internalGameId),
    states: fixture.database.prepare("SELECT contest_id, state FROM contest_automation_v3_state WHERE internal_game_id = ?").all(internalGameId),
    jobs: fixture.database.prepare("SELECT * FROM game_jobs_v3 WHERE internal_game_id = ? ORDER BY created_at").all(internalGameId),
    scoring: fixture.database.prepare("SELECT * FROM contest_scoring_revisions WHERE internal_game_id = ?").all(internalGameId)
  })}`);
  assert.ok(current.prediction.lineup.every((player) => player.teamCode === team.key));
  const history = await fixture.request(key, "/api/results/games");
  const row = history.games.find((entry) => entry.internalGameId === internalGameId);
  assert.ok(row);
  assert.ok(row.displayLabel.includes(team.shortName));
  const detail = await fixture.request(key, `/api/results/games/${internalGameId}`);
  assert.equal(detail.internalGameId, internalGameId);
  assert.equal(detail.totalScore, 99);
  assert.equal(detail.actualLineup.length, 9);
  assert.ok(detail.actualLineup.every((player) => player.teamCode === team.key));
}

test("all twelve isolated teams complete contest E2E across six dual-contest physical games", async () => {
  const f = await createTestSiteMultiTeamFixture();
  try {
    assert.equal(assertDistinctTestTeamIdentity(), true);
    assert.equal(TEST_TEAM_KEYS.length, 12);
    for (const group of TEST_TEAM_GROUPS) {
      const reset = await f.request(group.homeKey, "/api/test/reset", {});
      assert.equal(reset.game.internalGameId, group.internalGameId);
      // Both sides must submit before the first side advances the shared physical
      // game's clock to its deadline; contests share schedule but not predictions.
      await prepareTeamPrediction(f, group.homeKey, group);
      await prepareTeamPrediction(f, group.awayKey, group);
      await exerciseTeam(f, group.homeKey, group);
      await exerciseTeam(f, group.awayKey, group);

      const contests = f.database.prepare(`SELECT contest_id, target_team_key FROM game_contests
        WHERE internal_game_id = ? ORDER BY target_team_key`).all(group.internalGameId);
      assert.equal(contests.length, 2, "both participating teams own a contest on the same physical game");
      assert.deepEqual(new Set(contests.map((row) => row.target_team_key)),
        new Set([TEST_TEAMS[group.homeKey].key, TEST_TEAMS[group.awayKey].key]));
      assert.equal(new Set(contests.map((row) => row.contest_id)).size, 2);

      const predictions = f.database.prepare(`SELECT contest_id, prediction_json, score FROM predictions
        WHERE internal_game_id = ? ORDER BY contest_id`).all(group.internalGameId);
      assert.equal(predictions.length, 2);
      for (const row of predictions) {
        const target = contests.find((contest) => contest.contest_id === row.contest_id)?.target_team_key;
        assert.ok(target);
        assert.equal(row.score, 99);
        assert.ok(JSON.parse(row.prediction_json).lineup.every((player) => player.teamCode === target));
      }
      const publications = f.database.prepare(`SELECT contest_id, publication_status FROM contest_ranking_games
        WHERE internal_game_id = ? ORDER BY contest_id`).all(group.internalGameId);
      assert.equal(publications.length, 2);
      assert.ok(publications.every((row) => row.publication_status === "published"));
    }

    // Prove a same-game reset/replay remains deterministic without multiplying
    // the full twelve-team suite or leaving one side's old contest behind.
    const repeat = TEST_TEAM_GROUPS[0];
    await f.request(repeat.homeKey, "/api/test/reset", {});
    await prepareTeamPrediction(f, repeat.homeKey, repeat);
    await prepareTeamPrediction(f, repeat.awayKey, repeat);
    await exerciseTeam(f, repeat.homeKey, repeat);
    await exerciseTeam(f, repeat.awayKey, repeat);
    const repeated = f.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_games WHERE internal_game_id = ? AND publication_status = 'published'")
      .get(repeat.internalGameId).count;
    assert.equal(repeated, 2);

    for (const group of TEST_TEAM_GROUPS) {
      const baseline = await f.request(group.homeKey, "/api/test/reset", {});
      assert.equal(baseline.game.internalGameId, group.internalGameId);
      for (const key of [group.homeKey, group.awayKey]) {
        const status = await f.request(key, "/api/test/status");
        assert.equal(status.game.state, "scheduled");
        const history = await f.request(key, "/api/results/games");
        assert.equal(history.games.some((entry) => entry.internalGameId === group.internalGameId), false);
      }
      assert.equal(f.audit.prepare("SELECT COUNT(*) AS count FROM game_automation_v3_audit WHERE internal_game_id = ?")
        .get(group.internalGameId).count, 0);
    }
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games").get().count, 6);
  } finally { f.close(); }
});

test("twelve NPB provider identities normalize and resolve both sides without cross-team fallback", () => {
  assert.equal(assertDistinctTestTeamIdentity(), true);
  for (const [key, team] of Object.entries(TEST_TEAMS)) {
    const opponentKey = TEST_TEAM_KEYS.find((candidate) => candidate !== key);
    assert.equal(normalizeScheduleTeamCode(team.key), key);
    assert.equal(normalizeScheduleTeamCode(team.providerTeamCode), key);
    assert.equal(normalizeScheduleTeamCode(team.officialRosterCode), key);
    for (const alias of team.aliases) assert.equal(normalizeScheduleTeamCode(alias), key, `${key} alias ${alias}`);
    for (const side of ["home", "away"]) {
      const game = side === "home"
        ? { homeTeam: team.key, awayTeam: TEST_TEAMS[opponentKey].key }
        : { homeTeam: TEST_TEAMS[opponentKey].key, awayTeam: team.key };
      assert.equal(teamContext.gameSide(game, team), side);
      assert.equal(teamContext.gameTeams(game, team).opponent, TEST_TEAMS[opponentKey].key);
    }
  }
  assert.equal(normalizeScheduleTeamCode("unknown-club"), "");
  assert.equal(teamContext.gameSide({ homeTeam: "giants", awayTeam: "tigers" }, TEST_TEAMS.marines), null);
});
