import test from "node:test";
import assert from "node:assert/strict";
import {
  closeFormalPipelineFixture,
  createFormalPipelineFixture,
  finalizeSyntheticLineups,
  readFormalPipelineResults,
  runFormalPipeline
} from "../tooling/offseason/formal-pipeline.js";

function assertPublished(results) {
  assert.equal(results.length, 6);
  for (const result of results) {
    assert.equal(result.canonical.aggregate.fullyPublished, true, result.gameId);
    assert.equal(result.canonical.aggregate.artifactMismatch, false, result.gameId);
    assert.equal(result.canonical.aggregate.lineupReady, true, result.gameId);
    assert.equal(result.canonical.aggregate.scoringReady, true, result.gameId);
    assert.equal(result.canonical.aggregate.rankingReady, true, result.gameId);
    assert.equal(result.canonical.aggregate.publicationReady, true, result.gameId);
    assert.equal(result.canonical.scoring.lineupRevisionMatch, true, result.gameId);
    assert.equal(result.canonical.ranking.scoringRevisionMatch, true, result.gameId);
    assert.equal(result.canonical.publication.rankingRevisionMatch, true, result.gameId);
    assert.equal(result.score.scoring_status, "scored", result.gameId);
    assert.equal(result.lineupRow.publication_status, "published", result.gameId);
    assert.equal(result.scoringRow.status, "completed", result.gameId);
    assert.equal(result.reflectionRow.status, "reflected", result.gameId);
  }
}

test("off-season formal pipeline: six simultaneous games are closed, scored, ranked, and published by production code", async () => {
  const fixture = await createFormalPipelineFixture();
  try {
    const before = await runFormalPipeline(fixture, { now: fixture.beforeDeadline, maxPasses: 2 });
    assert.equal(before.executed.some(({ jobType }) => ["score", "ranking_rebuild", "publish"].includes(jobType)), false);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_scoring_revisions").get().count, 0);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM ranking_reflection_revisions").get().count, 0);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_lineups WHERE publication_status = 'published'").get().count, 0);

    const finalized = await finalizeSyntheticLineups(fixture);
    assert.equal(finalized.length, 6);
    assert.equal(finalized.every((row) => row.finalized), true);
    const run = await runFormalPipeline(fixture);
    assert.equal(run.fullyClosed, true);
    assert.deepEqual(new Set(run.executed.map(({ gameId }) => gameId)).size, 6);
    assert.ok(run.executed.some(({ jobType }) => jobType === "prediction_close"));
    assert.ok(run.executed.some(({ jobType }) => jobType === "score"));
    assert.ok(run.executed.some(({ jobType }) => jobType === "ranking_rebuild"));
    assert.ok(run.executed.some(({ jobType }) => jobType === "publish"));
    assertPublished(await readFormalPipelineResults(fixture));
  } finally {
    closeFormalPipelineFixture(fixture);
  }
});

test("off-season formal pipeline interruption retries without duplicate scoring or publication", async () => {
  const fixture = await createFormalPipelineFixture();
  try {
    await finalizeSyntheticLineups(fixture);
    const first = await runFormalPipeline(fixture, {
      failOnceAt: "ranking_rebuild",
      now: fixture.afterDeadline,
      maxPasses: 8
    });
    assert.equal(first.injected, true);
    assert.equal(first.fullyClosed, false, "injected failure must leave a retryable job");

    // The production retry path stamps retry_wait from the actual Worker clock.
    // Resume from that persisted timestamp instead of assuming the synthetic
    // game clock is also the host clock.
    const retryRow = fixture.database.prepare(
      "SELECT next_retry_at FROM game_jobs_v3 WHERE status = 'retry_wait' LIMIT 1"
    ).get();
    assert.ok(retryRow?.next_retry_at);
    const retryAt = new Date(new Date(retryRow.next_retry_at).getTime() + 1_000);
    const recovered = await runFormalPipeline(fixture, { now: retryAt, maxPasses: 8 });
    assert.equal(recovered.fullyClosed, true);
    assertPublished(await readFormalPipelineResults(fixture));
    assert.equal(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM game_scoring_revisions WHERE is_active = 1"
    ).get().count, 6);
    assert.equal(fixture.database.prepare(
      "SELECT COUNT(*) AS count FROM game_lineups WHERE publication_status = 'published'"
    ).get().count, 6);
  } finally {
    closeFormalPipelineFixture(fixture);
  }
});
