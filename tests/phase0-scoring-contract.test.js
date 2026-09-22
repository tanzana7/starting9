import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { V3_JOB_EXECUTORS } from "../auth-worker.js";
import { V3_JOB_TYPE } from "../backend/automation-v3/constants.js";
import {
  closeFormalPipelineFixture,
  createFormalPipelineFixture,
  finalizeSyntheticLineups,
  readFormalPipelineResults,
  runFormalPipeline
} from "../tooling/offseason/formal-pipeline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_SOURCE = fs.readFileSync(path.join(ROOT, "auth-worker.js"), "utf8");
const EXECUTOR_SOURCE = fs.readFileSync(path.join(ROOT, "backend/automation-v3/executor.js"), "utf8");

function handlerSource(name, nextName) {
  const start = WORKER_SOURCE.indexOf(`async function ${name}`);
  const end = WORKER_SOURCE.indexOf(`async function ${nextName}`, start + 1);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${nextName} must follow ${name}`);
  return WORKER_SOURCE.slice(start, end);
}

function countRows(database, sql, ...params) {
  return Number(database.prepare(sql).get(...params)?.count || 0);
}

test("Phase 0: admin scoring confirm and V3 score executor contract difference is explicit", () => {
  const adminConfirm = handlerSource("handleAdminV3ScoringConfirm", "assertV3RescoreLineage");
  const scoreExecutor = WORKER_SOURCE.slice(
    WORKER_SOURCE.indexOf("async function executeV3ScoreExecutor"),
    WORKER_SOURCE.indexOf("async function executeV3RankingExecutor")
  );

  // This is the migration guard: Phase 0 must not silently route admin
  // confirmation through a different implementation. The current admin
  // route still uses the legacy preview/confirm contract and defers the
  // downstream publication, while the V3 executor owns score-attempt commit.
  assert.match(adminConfirm, /invokeV3RescoreCore\(body, env, cors, context\.metadata, user, "confirm"/);
  assert.match(adminConfirm, /deferPublication: true/);
  assert.doesNotMatch(adminConfirm, /createV3AdminActionJob\([^\n]+, "score"/);

  assert.match(scoreExecutor, /hasCurrentV3ScoreJobLease/);
  assert.match(scoreExecutor, /V3_FINAL_LINEUP_REQUIRED/);
  assert.match(scoreExecutor, /createScoreAttempt/);
  assert.match(scoreExecutor, /markScoreAttemptReady/);
  assert.match(scoreExecutor, /commitScoreAttempt/);
  assert.equal(typeof V3_JOB_EXECUTORS[V3_JOB_TYPE.SCORE], "function");
});

test("Phase 0: V3 scoring requires the deadline and canonical lineup, then commits one fenced attempt", async () => {
  const fixture = await createFormalPipelineFixture();
  try {
    const before = await runFormalPipeline(fixture, {
      now: fixture.beforeDeadline,
      maxPasses: 2
    });
    assert.equal(before.executed.some((entry) => entry.jobType === "score"), false);
    assert.equal(countRows(fixture.database, "SELECT COUNT(*) AS count FROM score_attempts"), 0);

    await finalizeSyntheticLineups(fixture);
    const run = await runFormalPipeline(fixture, { maxPasses: 8 });
    assert.equal(run.fullyClosed, true);

    for (const game of fixture.games) {
      const lineup = fixture.database.prepare(
        "SELECT final_lineup_revision_id, scoring_status FROM game_lineups WHERE internal_game_id = ?"
      ).get(game.internalGameId);
      const attempt = fixture.database.prepare(
        `SELECT attempt_id, canonical_lineup_revision_id, scoring_lineup_revision_id,
                job_id, status
           FROM score_attempts
          WHERE internal_game_id = ? AND status = 'committed'`
      ).get(game.internalGameId);
      assert.equal(lineup.scoring_status, "scored", game.internalGameId);
      assert.equal(attempt.canonical_lineup_revision_id, lineup.final_lineup_revision_id, game.internalGameId);
      assert.equal(attempt.scoring_lineup_revision_id, lineup.final_lineup_revision_id, game.internalGameId);
      assert.equal(attempt.status, "committed", game.internalGameId);
      assert.ok(attempt.job_id, game.internalGameId);
    }
  } finally {
    closeFormalPipelineFixture(fixture);
  }
});

test("Phase 0: repeated automation is idempotent for score, ranking, and publication history", async () => {
  const fixture = await createFormalPipelineFixture();
  try {
    await finalizeSyntheticLineups(fixture);
    await runFormalPipeline(fixture, { maxPasses: 8 });
    const before = await readFormalPipelineResults(fixture);
    const countsBefore = fixture.games.map((game) => ({
      gameId: game.internalGameId,
      attempts: countRows(fixture.database, "SELECT COUNT(*) AS count FROM score_attempts WHERE internal_game_id = ?", game.internalGameId),
      scoringRevisions: countRows(fixture.database, "SELECT COUNT(*) AS count FROM game_scoring_revisions WHERE internal_game_id = ?", game.internalGameId),
      scoreHistory: countRows(fixture.database, "SELECT COUNT(*) AS count FROM prediction_score_revisions WHERE internal_game_id = ?", game.internalGameId),
      reflections: countRows(fixture.database, "SELECT COUNT(*) AS count FROM ranking_reflection_revisions WHERE internal_game_id = ?", game.internalGameId),
      publishedLineups: countRows(fixture.database, "SELECT COUNT(*) AS count FROM game_lineups WHERE internal_game_id = ? AND publication_status = 'published'", game.internalGameId),
      publishedRankingGames: countRows(fixture.database, "SELECT COUNT(*) AS count FROM ranking_games WHERE internal_game_id = ? AND publication_status = 'published'", game.internalGameId)
    }));

    const repeated = await runFormalPipeline(fixture, {
      now: new Date(fixture.afterDeadline.getTime() + 60_000),
      maxPasses: 3
    });
    assert.equal(repeated.executed.length, 0);
    assert.deepEqual(await readFormalPipelineResults(fixture), before);
    assert.deepEqual(fixture.games.map((game) => ({
      gameId: game.internalGameId,
      attempts: countRows(fixture.database, "SELECT COUNT(*) AS count FROM score_attempts WHERE internal_game_id = ?", game.internalGameId),
      scoringRevisions: countRows(fixture.database, "SELECT COUNT(*) AS count FROM game_scoring_revisions WHERE internal_game_id = ?", game.internalGameId),
      scoreHistory: countRows(fixture.database, "SELECT COUNT(*) AS count FROM prediction_score_revisions WHERE internal_game_id = ?", game.internalGameId),
      reflections: countRows(fixture.database, "SELECT COUNT(*) AS count FROM ranking_reflection_revisions WHERE internal_game_id = ?", game.internalGameId),
      publishedLineups: countRows(fixture.database, "SELECT COUNT(*) AS count FROM game_lineups WHERE internal_game_id = ? AND publication_status = 'published'", game.internalGameId),
      publishedRankingGames: countRows(fixture.database, "SELECT COUNT(*) AS count FROM ranking_games WHERE internal_game_id = ? AND publication_status = 'published'", game.internalGameId)
    })), countsBefore);
  } finally {
    closeFormalPipelineFixture(fixture);
  }
});

test("Phase 0: planner generation is evaluated before due-job claiming", () => {
  const runnerStart = EXECUTOR_SOURCE.indexOf("export async function runGameAutomationV3");
  const runner = EXECUTOR_SOURCE.slice(runnerStart);
  const plannerIndex = runner.indexOf("formalPlanner");
  const claimIndex = runner.indexOf("claimDueJobs");
  assert.ok(plannerIndex >= 0);
  assert.ok(claimIndex > plannerIndex);
  assert.match(runner, /formalPlanner/);
  assert.match(runner, /claimDueJobs/);
});
