import test from "node:test";
import assert from "node:assert/strict";
import { buildSyntheticPredictions } from "../tooling/test-site/auto-prediction-seeder.js";
import { simulatorRoster } from "../tooling/test-site/simu-npb/source.js";
import { TEST_TEAMS, testPredictionPlayerId } from "../tooling/test-site/teams.js";
import { scorePredictionLineup } from "../backend/domain/scoring.js";
import { getPredictionWriteNow } from "../backend/domain/prediction-write-clock.js";

const TARGET_TEAM = "fighters";
const ROSTER = simulatorRoster(TARGET_TEAM, TEST_TEAMS);
const CONTEST_ID = "contest-rehearsal-fighters";

test("Test auto prediction seeder emits deterministic, valid Fighters predictions with score variation", () => {
  const options = { contestId: CONTEST_ID, targetTeam: TARGET_TEAM, roster: ROSTER, userCount: 10, seed: 20261025 };
  const first = buildSyntheticPredictions(options);
  const repeated = buildSyntheticPredictions(options);
  const otherSeed = buildSyntheticPredictions({ ...options, seed: 20261026 });

  assert.equal(first.length, 10);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first, otherSeed);
  assert.deepEqual(first.map(({ label }) => label), Array.from({ length: 10 }, (_, index) => `test-user-${String(index + 1).padStart(2, "0")}`));
  for (const { prediction } of first) {
    assert.equal(prediction.schemaVersion, 1);
    assert.equal(prediction.lineup.length, 9);
    assert.ok(prediction.lineup.every((player) => ROSTER.some((rosterPlayer) =>
      testPredictionPlayerId(TARGET_TEAM, rosterPlayer.uniformNumber ?? rosterPlayer.number) === player.playerId)),
    "each canonical prediction identity must resolve to one captured roster row");
    assert.equal(new Set(prediction.lineup.map((player) => player.playerId)).size, 9);
    assert.deepEqual(prediction.lineup.map((player) => player.battingOrder).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(prediction.lineup.every((player) => player.teamCode === TARGET_TEAM
      && player.teamId === TEST_TEAMS[TARGET_TEAM].playerTeamId
      && ROSTER.some((rosterPlayer) => String(rosterPlayer.uniformNumber ?? rosterPlayer.number) === player.uniformNumber)));
  }

  const actual = first[0].prediction.lineup;
  assert.equal(scorePredictionLineup(actual, actual).total, 99, "the first prediction exactly mirrors the default synthetic official lineup");
  const scores = new Set(first.map(({ prediction }) => scorePredictionLineup(prediction.lineup, actual).total));
  assert.ok(scores.size > 1, "seeded variation must produce ranking-relevant score differences");
});

test("Test auto prediction seeder rejects cross-team or malformed rosters before any writer callback exists", () => {
  const foreignRoster = ROSTER.map((player, index) => index === 0 ? { ...player, teamCode: "hawks" } : player);
  assert.throws(() => buildSyntheticPredictions({ contestId: CONTEST_ID, targetTeam: TARGET_TEAM, roster: foreignRoster, userCount: 10, seed: 20261025 }), /cross-team/);
  assert.throws(() => buildSyntheticPredictions({ contestId: CONTEST_ID, targetTeam: TARGET_TEAM, roster: ROSTER, userCount: 0, seed: 20261025 }), /userCount/);
  assert.throws(() => buildSyntheticPredictions({ contestId: "", targetTeam: TARGET_TEAM, roster: ROSTER, userCount: 10, seed: 20261025 }), /contestId/);
});

test("logical prediction clock is available only to the isolated Test Worker environment", () => {
  const requestedTime = "2026-10-25T05:00:00.000Z";
  const testClock = getPredictionWriteNow({
    ENVIRONMENT: "test",
    TEST_SITE_ID: "starting9-isolated-v1",
    TEST_WORKER_NAME: "starting9-test-auth",
    TEST_CLOCK_NOW: requestedTime
  });
  assert.equal(testClock.toISOString(), requestedTime);

  const productionClock = getPredictionWriteNow({
    ENVIRONMENT: "production",
    TEST_SITE_ID: "starting9-isolated-v1",
    TEST_WORKER_NAME: "starting9-test-auth",
    TEST_CLOCK_NOW: requestedTime
  });
  assert.ok(Math.abs(productionClock.getTime() - Date.now()) < 1000);

  const incompleteTestIdentity = getPredictionWriteNow({
    ENVIRONMENT: "test",
    TEST_SITE_ID: "starting9-isolated-v1",
    TEST_CLOCK_NOW: requestedTime
  });
  assert.ok(Math.abs(incompleteTestIdentity.getTime() - Date.now()) < 1000);
});
