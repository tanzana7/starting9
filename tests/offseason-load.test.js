import test from "node:test";
import assert from "node:assert/strict";
import {
  createSyntheticScenario
} from "../tooling/offseason/synthetic-scenario.js";
import {
  closeLocalScenarioDatabase,
  createLocalScenarioDatabase,
  runRepresentativeQueries,
  seedLocalScenario
} from "../tooling/offseason/local-sqlite.js";

test("isolated twelve-team workload covers six simultaneous games and 200+ jobs", () => {
  const scenario = createSyntheticScenario({ usersPerGame: 200, jobCount: 240 });
  const db = createLocalScenarioDatabase();
  try {
    seedLocalScenario(db, scenario);
    const metrics = runRepresentativeQueries(db, { now: "2026-10-01T13:00:00.000Z" });
    assert.equal(scenario.games.length, 6);
    assert.equal(scenario.teams.length, 12);
    assert.equal(scenario.predictions.length, 1_200);
    assert.equal(scenario.jobs.length, 240);
    assert.equal(metrics.dueJobs.count, 100);
    assert.equal(metrics.scoredPredictions.count, 100);
    assert.equal(metrics.perGame.count, 6);
    // This is a local regression guard, not a production SLO. A generous
    // ceiling keeps CI stable while still catching accidental full scans.
    assert.ok(metrics.dueJobs.ms < 5_000);
    assert.ok(metrics.scoredPredictions.ms < 5_000);
    assert.ok(metrics.perGame.ms < 5_000);
    console.log("offseason-load", JSON.stringify({
      rows: { predictions: scenario.predictions.length, jobs: scenario.jobs.length },
      queriesMs: {
        dueJobs: Number(metrics.dueJobs.ms.toFixed(2)),
        scoredPredictions: Number(metrics.scoredPredictions.ms.toFixed(2)),
        perGame: Number(metrics.perGame.ms.toFixed(2))
      }
    }));
  } finally {
    closeLocalScenarioDatabase(db);
  }
});
