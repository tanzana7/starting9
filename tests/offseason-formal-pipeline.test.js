import test from "node:test";
import assert from "node:assert/strict";
import {
  closeFormalPipelineFixture,
  createFormalPipelineFixture,
  FORMAL_RANKING_EXPECTATIONS,
  finalizeSyntheticLineups,
  readFormalRanking,
  readFormalPipelineResults,
  runFormalPipeline
} from "../tooling/offseason/formal-pipeline.js";
import { createContestId } from "../backend/contest-identity.js";

const GAME_COUNT = 6;
const EXPECTED_HISTORY_PER_GAME = Object.freeze({
  scoringRevisions: 1,
  activeScoringRevisions: 1,
  rankingReflections: 1,
  predictionScoreRevisions: FORMAL_RANKING_EXPECTATIONS.length,
  scoreAttempts: 1,
  publishedLineups: 1,
  publishedRankingGames: 1
});

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
    assert.equal(result.scores.length, FORMAL_RANKING_EXPECTATIONS.length, result.gameId);
    for (const score of result.scores) {
      assert.equal(score.scoring_status, "scored", `${result.gameId}:${score.user_id}`);
      assert.ok(score.scored_attempt_id, `${result.gameId}:${score.user_id}`);
    }
    assert.equal(result.lineupRow.publication_status, "published", result.gameId);
    assert.equal(result.scoringRow.status, "completed", result.gameId);
    assert.equal(result.reflectionRow.status, "reflected", result.gameId);
  }
}

function assertPerGameHistory(fixture) {
  assert.equal(fixture.games.length, GAME_COUNT);
  for (const game of fixture.games) {
    const id = game.internalGameId;
    const contestId = createContestId(id, "fighters");
    const counts = {
      scoringRevisions: fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM contest_scoring_revisions WHERE contest_id = ? AND internal_game_id = ?"
      ).get(contestId, id).count,
      activeScoringRevisions: fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM contest_scoring_revisions WHERE contest_id = ? AND internal_game_id = ? AND is_active = 1 AND status = 'completed'"
      ).get(contestId, id).count,
      rankingReflections: fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM contest_ranking_reflection_revisions WHERE contest_id = ? AND internal_game_id = ? AND status = 'reflected'"
      ).get(contestId, id).count,
      predictionScoreRevisions: fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM contest_prediction_score_revisions WHERE contest_id = ? AND internal_game_id = ?"
      ).get(contestId, id).count,
      scoreAttempts: fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM contest_score_attempts WHERE contest_id = ? AND internal_game_id = ? AND status = 'committed'"
      ).get(contestId, id).count,
      publishedLineups: fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM game_lineups WHERE contest_id = ? AND internal_game_id = ? AND publication_status = 'published'"
      ).get(contestId, id).count,
      publishedRankingGames: fixture.database.prepare(
        "SELECT COUNT(*) AS count FROM contest_ranking_games WHERE contest_id = ? AND internal_game_id = ? AND publication_status = 'published'"
      ).get(contestId, id).count
    };
    assert.deepEqual(counts, EXPECTED_HISTORY_PER_GAME, id);
  }
}

async function assertRankingContents(fixture) {
  const ranking = await readFormalRanking(fixture);
  assert.equal(ranking.rows.length, FORMAL_RANKING_EXPECTATIONS.length);
  assert.equal(ranking.summary.totalUsers, FORMAL_RANKING_EXPECTATIONS.length);
  const rows = new Map(ranking.rows.map((row) => [row.username, row]));
  for (const [index, expected] of FORMAL_RANKING_EXPECTATIONS.entries()) {
    const row = rows.get(expected.username);
    assert.ok(row, expected.username);
    const expectedTotal = expected.perGameScore * GAME_COUNT;
    assert.equal(row.totalScore, expectedTotal, expected.username);
    assert.equal(row.averageScore, expected.perGameScore, expected.username);
    assert.equal(row.gamesPlayed, GAME_COUNT, expected.username);
    assert.equal(row.isQualified, true, expected.username);
    assert.equal(row.rank, index === 0 ? 1 : 2, expected.username);
  }
}

test("off-season formal pipeline: six simultaneous games are closed, scored, ranked, and published by production code", async () => {
  const fixture = await createFormalPipelineFixture();
  try {
    const before = await runFormalPipeline(fixture, { now: fixture.beforeDeadline, maxPasses: 2 });
    assert.equal(before.executed.some(({ jobType }) => ["score", "ranking_rebuild", "publish"].includes(jobType)), false);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_scoring_revisions").get().count, 0);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_ranking_reflection_revisions").get().count, 0);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM game_lineups WHERE contest_id IS NOT NULL AND publication_status = 'published'").get().count, 0);

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
    assertPerGameHistory(fixture);
    await assertRankingContents(fixture);
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
      `SELECT id, internal_game_id, job_type, status, failure_code, attempt_count, next_retry_at
         FROM game_jobs_v3
        WHERE status = 'retry_wait' AND job_type = 'ranking_rebuild'`
    ).all();
    assert.equal(retryRow.length, 1);
    const failedJob = retryRow[0];
    assert.equal(failedJob.job_type, "ranking_rebuild");
    assert.equal(failedJob.status, "retry_wait");
    assert.equal(failedJob.failure_code, "UNEXPECTED_EXCEPTION");
    assert.equal(failedJob.attempt_count, 1);
    assert.ok(failedJob.internal_game_id);
    assert.ok(failedJob.next_retry_at);
    const retryAt = new Date(new Date(failedJob.next_retry_at).getTime() + 1_000);
    const recovered = await runFormalPipeline(fixture, { now: retryAt, maxPasses: 8 });
    assert.equal(recovered.fullyClosed, true);
    assertPublished(await readFormalPipelineResults(fixture));
    assert.ok(recovered.executed.some((entry) => entry.jobId === failedJob.id && entry.jobType === "ranking_rebuild"));
    const completedJob = fixture.database.prepare(
      "SELECT id, status, failure_code, attempt_count FROM game_jobs_v3 WHERE id = ?"
    ).get(failedJob.id);
    assert.equal(completedJob.id, failedJob.id);
    assert.equal(completedJob.status, "completed");
    assert.equal(completedJob.failure_code, null);
    assert.equal(completedJob.attempt_count, 2);
    assertPerGameHistory(fixture);
    await assertRankingContents(fixture);
  } finally {
    closeFormalPipelineFixture(fixture);
  }
});
