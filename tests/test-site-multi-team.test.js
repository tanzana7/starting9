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
  const scored = await fixture.request(key, "/api/test/scenario", { scenario: "scored", stageOnly: true });
  assert.equal(scored.game.state, "scored");
  const ranked = await fixture.request(key, "/api/test/scenario", { scenario: "ranked", stageOnly: true });
  assert.equal(ranked.game.state, "ranked");
  const published = await fixture.request(key, "/api/test/scenario", { scenario: "published", stageOnly: true });
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
  const jobs = await fixture.request(key, "/api/test/jobs");
  assert.equal(jobs.internalGameId, internalGameId);
  assert.equal(jobs.contestId, current.contestId);
  assert.ok(jobs.jobs.length > 0 && jobs.jobs.every((job) => job.status === "completed"));
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

test("Fighters rehearsal reset clears a published target while preserving the published same-game Hawks contest", async () => {
  const f = await createTestSiteMultiTeamFixture();
  const group = TEST_TEAM_GROUPS[3];
  const internalGameId = group.internalGameId;
  const query = (team) => `?internalGameId=${encodeURIComponent(internalGameId)}&testTeam=${team}&simuNpb=1`;
  try {
    await f.request(group.homeKey, "/api/test/reset", {});
    const now = new Date().toISOString();
    f.database.prepare(`UPDATE games SET game_date='2026-10-25', start_time='2026-10-25T15:00:00+09:00'
      WHERE internal_game_id=?`).run(internalGameId);
    f.database.prepare(`INSERT INTO game_identifiers
      (internal_game_id, provider, identifier_type, identifier_value, is_primary, created_at, updated_at)
      VALUES (?, 'npb', 'npb_game_code', 'g-t-4', 1, ?, ?)`).run(internalGameId, now, now);
    const rehearsalGame = f.database.prepare(`SELECT game_date, start_time, npb_game_code,
      (SELECT identifier_value FROM game_identifiers WHERE internal_game_id=?
        AND provider='npb' AND identifier_type='npb_game_code' ORDER BY updated_at DESC, id DESC LIMIT 1) AS provider_game_id
      FROM games WHERE internal_game_id=?`).get(internalGameId, internalGameId);
    assert.equal(rehearsalGame.game_date, "2026-10-25");
    assert.equal(Date.parse(rehearsalGame.start_time), Date.parse("2026-10-25T06:00:00.000Z"));
    assert.equal(rehearsalGame.provider_game_id, "g-t-4");

    // Submit both contests before advancing the shared physical-game clock.
    await prepareTeamPrediction(f, "hawks", group);
    await prepareTeamPrediction(f, "fighters", group);
    await exerciseTeam(f, "hawks", group);
    // The generic local scenario helper shifts game time to its post-game
    // boundary; restore only this isolated physical fixture's rehearsal slot.
    f.database.prepare(`UPDATE games SET game_date='2026-10-25', start_time='2026-10-25T15:00:00+09:00'
      WHERE internal_game_id=?`).run(internalGameId);
    const hawksBefore = await f.request("hawks", `/api/test/rehearsal/snapshot${query("hawks")}`);
    assert.equal(hawksBefore.snapshot.state, "published");
    assert.equal(hawksBefore.snapshot.publicationStatus, "published");
    assert.equal(hawksBefore.snapshot.publicationCount, 1);

    const fightersJobs = await f.request("fighters", `/api/test/jobs${query("fighters")}`);
    const hawksJobs = await f.request("hawks", `/api/test/jobs${query("hawks")}`);
    const reset = await f.request("fighters", `/api/test/rehearsal/reset-fighters${query("fighters")}`, {
      expectedContestId: fightersJobs.contestId,
      expectedSiblingContestId: hawksJobs.contestId
    });
    assert.equal(reset.ok, true, JSON.stringify(reset));
    assert.equal(reset.targetAfter.state, "scheduled");
    assert.equal(reset.targetAfter.predictionCount, 0);
    assert.equal(reset.targetAfter.lineupCount, 0);
    assert.equal(reset.targetAfter.scoringCount, 0);
    assert.equal(reset.targetAfter.rankingCount, 0);
    assert.equal(reset.targetAfter.publicationCount, 0);
    assert.equal(reset.targetAfter.formalJobCount, 0);
    assert.deepEqual(reset.siblingAfter, hawksBefore.snapshot);
    const resetFighters = await f.request("fighters", `/api/test/status${query("fighters")}`);
    assert.equal(resetFighters.game.state, "scheduled");
    const resetPrediction = await f.request("fighters", `/api/predictions/current${query("fighters")}`);
    assert.equal(Boolean(resetPrediction.prediction), false);
    const hawksAfterReset = await f.request("hawks", `/api/test/rehearsal/snapshot${query("hawks")}`);
    assert.deepEqual(hawksAfterReset.snapshot, hawksBefore.snapshot);

    await prepareTeamPrediction(f, "fighters", group);
    await exerciseTeam(f, "fighters", group);
    // Scenario helpers advance the shared local fixture clock; restore only
    // this in-memory test schedule so the reset endpoint rechecks the exact
    // rehearsal identity, not a production/game-wide schedule mutation.
    f.database.prepare(`UPDATE games SET game_date='2026-10-25', start_time='2026-10-25T15:00:00+09:00'
      WHERE internal_game_id=?`).run(internalGameId);
    const publishedFightersBefore = await f.request("fighters", `/api/test/rehearsal/snapshot${query("fighters")}`);
    assert.equal(publishedFightersBefore.snapshot.state, "published");
    assert.equal(publishedFightersBefore.snapshot.publicationStatus, "published");
    const resetPublished = await f.request("fighters", `/api/test/rehearsal/reset-fighters${query("fighters")}`, {
      expectedContestId: fightersJobs.contestId,
      expectedSiblingContestId: hawksJobs.contestId
    });
    assert.equal(resetPublished.targetAfter.state, "scheduled");
    assert.equal(resetPublished.targetAfter.predictionCount, 0);
    assert.equal(resetPublished.targetAfter.lineupCount, 0);
    assert.equal(resetPublished.targetAfter.scoringCount, 0);
    assert.equal(resetPublished.targetAfter.rankingCount, 0);
    assert.equal(resetPublished.targetAfter.publicationCount, 0);
    assert.equal(resetPublished.targetAfter.formalJobCount, 0);
    const publishedFightersAfter = await f.request("fighters", `/api/test/rehearsal/snapshot${query("fighters")}`);
    assert.notDeepEqual(publishedFightersAfter.snapshot, publishedFightersBefore.snapshot);
    assert.equal(publishedFightersAfter.snapshot.state, "scheduled");
    assert.equal(publishedFightersAfter.snapshot.publicationCount, 0);
    const finalHawks = await f.request("hawks", `/api/test/rehearsal/snapshot${query("hawks")}`);
    assert.deepEqual(finalHawks.snapshot, hawksBefore.snapshot);

    const productionAttempt = await f.request("fighters", `/api/test/rehearsal/reset-fighters${query("fighters")}`, {
      expectedContestId: fightersJobs.contestId,
      expectedSiblingContestId: hawksJobs.contestId
    }, "POST", { expectedStatus: 404, envOverrides: { ENVIRONMENT: "production" } });
    assert.equal(productionAttempt.code, "TEST_ENVIRONMENT_REQUIRED");
    const wrongAccountAttempt = await f.request("fighters", `/api/test/rehearsal/reset-fighters${query("fighters")}`, {
      expectedContestId: fightersJobs.contestId,
      expectedSiblingContestId: hawksJobs.contestId
    }, "POST", { expectedStatus: 404, envOverrides: { TEST_EXPECTED_ACCOUNT_ID: "wrong-account" } });
    assert.equal(wrongAccountAttempt.code, "REHEARSAL_TEST_ACCOUNT_REQUIRED");
    const finalTarget = await f.request("fighters", `/api/test/rehearsal/snapshot${query("fighters")}`);
    assert.deepEqual(finalTarget.snapshot, publishedFightersAfter.snapshot);
  } finally { f.close(); }
});

test("ranking failure enters retry_wait without blocking the same-game sibling contest", async () => {
  const f = await createTestSiteMultiTeamFixture();
  const group = TEST_TEAM_GROUPS[0];
  const home = group.homeKey;
  const away = group.awayKey;
  try {
    await f.request(home, "/api/test/reset", {});
    await prepareTeamPrediction(f, home, group);
    await prepareTeamPrediction(f, away, group);
    await f.request(home, "/api/test/scenario", { scenario: "closed" });

    const failed = await f.request(home, "/api/test/scenario", { scenario: "retry" });
    assert.equal(failed.failureInjected, true, JSON.stringify(failed));
    const homeContest = f.database.prepare("SELECT contest_id FROM game_contests WHERE internal_game_id=? AND target_team_key=?")
      .get(group.internalGameId, TEST_TEAMS[home].key).contest_id;
    const retryJob = f.database.prepare(`SELECT status,attempt_count,next_retry_at,failure_code,failure_message FROM game_jobs_v3
      WHERE contest_id=? AND job_type='ranking_rebuild'`).get(homeContest);
    assert.equal(retryJob.status, "retry_wait", JSON.stringify({ failed, retryJob,
      jobs: f.database.prepare("SELECT contest_id,job_type,status,attempt_count,next_retry_at,failure_code FROM game_jobs_v3 WHERE internal_game_id=?")
        .all(group.internalGameId) }));
    assert.equal(failed.game.state, "scored");
    assert.ok(retryJob.attempt_count >= 1);
    assert.ok(Date.parse(retryJob.next_retry_at) > Date.now());
    assert.equal(retryJob.failure_code, "UNEXPECTED_EXCEPTION");
    assert.match(retryJob.failure_message, /TEST_SCENARIO_INJECTED_FAILURE/);

    await exerciseTeam(f, away, group);
    const homeStatus = await f.request(home, "/api/test/status");
    assert.equal(homeStatus.game.state, "scored");
    const homeRetry = f.database.prepare("SELECT status,next_retry_at FROM game_jobs_v3 WHERE contest_id=? AND job_type='ranking_rebuild'")
      .get(homeContest);
    assert.equal(homeRetry.status, "retry_wait");
    assert.equal(homeRetry.next_retry_at, retryJob.next_retry_at);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_games WHERE contest_id=? AND publication_status='published'")
      .get(homeContest).count, 0);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_games WHERE internal_game_id=? AND publication_status='published'")
      .get(group.internalGameId).count, 1);
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
