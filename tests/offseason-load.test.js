import test from "node:test";
import assert from "node:assert/strict";
import {
  createSyntheticScenario
} from "../tooling/offseason/synthetic-scenario.js";
import {
  closeLocalScenarioDatabase,
  createLocalScenarioDatabase,
  processAllDueJobs,
  runRepresentativeQueries,
  seedLocalScenario
} from "../tooling/offseason/local-sqlite.js";

test("isolated twelve-team workload covers six simultaneous games and 200+ jobs", async () => {
  const scenario = createSyntheticScenario({ usersPerGame: 200, jobCount: 240 });
  const db = createLocalScenarioDatabase();
  try {
    seedLocalScenario(db, scenario);
    const metrics = await runRepresentativeQueries(db, { now: "2026-10-01T13:00:00.000Z" });
    assert.equal(scenario.games.length, 6);
    assert.equal(scenario.teams.length, 12);
    assert.equal(scenario.predictions.length, 1_200);
    assert.equal(scenario.jobs.length, 240);
    // The current production repository clamps a requested page to 100. The
    // requested 200-item page therefore cannot be claimed without changing
    // Auth Worker code, which is intentionally out of scope during v337.
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

test("production-shaped claim pagination processes all 240 due jobs without duplicates", async () => {
  const scenario = createSyntheticScenario({ usersPerGame: 1, jobCount: 240 });
  const db = createLocalScenarioDatabase();
  try {
    seedLocalScenario(db, scenario);
    const result = await processAllDueJobs(db, { now: "2026-10-01T13:00:00.000Z" });
    assert.deepEqual(result.rounds.map((round) => round.dueCount), [200, 40]);
    assert.deepEqual(result.rounds.map((round) => round.processed.length), [200, 40]);
    assert.equal(result.processed.length, 240);
    assert.equal(new Set(result.processed.map((job) => job.id)).size, 240);
    assert.equal(result.remaining, 0);
    const processedTypes = result.processed.map((job) => job.jobType);
    assert.ok(processedTypes.slice(0, 60).every((type) => type === "prediction_close"));
    assert.ok(processedTypes.slice(60, 120).every((type) => type === "score"));
    assert.ok(processedTypes.slice(120, 180).every((type) => type === "ranking_rebuild"));
    assert.ok(processedTypes.slice(180, 240).every((type) => type === "publish"));
  } finally {
    closeLocalScenarioDatabase(db);
  }
});
