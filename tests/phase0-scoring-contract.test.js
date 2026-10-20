import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { V3_JOB_EXECUTORS } from "../auth-worker.js";
import { V3_JOB_TYPE } from "../backend/automation-v3/constants.js";
import { createContestId } from "../backend/contest-identity.js";
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
const SESSION_TOKEN = "offseason-formal-pipeline-session";

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

async function adminRequest(fixture, pathname, body) {
  return worker.fetch(new Request(`https://starting9.offseason.test${pathname}`, {
    method: "POST",
    headers: {
      Cookie: `s9_session=${encodeURIComponent(SESSION_TOKEN)}`,
      Origin: "https://starting9.offseason.test",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }), fixture.env, {});
}

test("Phase 1: admin scoring confirm queues the same V3 score executor contract", () => {
  const adminConfirm = handlerSource("handleAdminV3ScoringConfirm", "assertV3ContestRescoreLineage");
  const scoreExecutor = WORKER_SOURCE.slice(
    WORKER_SOURCE.indexOf("async function executeV3ScoreExecutor"),
    WORKER_SOURCE.indexOf("async function executeV3RankingExecutor")
  );

  assert.doesNotMatch(adminConfirm, /invokeV3RescoreCore\(body, env, cors, context\.metadata, user, "confirm"/);
  assert.match(adminConfirm, /assertV3ContestRescoreLineage\(env\.AUTH_DB, context, body, user\?\.id\)/);
  assert.match(adminConfirm, /assertV3AdminScoringReady\(env, context, body\)/);
  assert.match(adminConfirm, /input\?\.confirmed !== true/);
  assert.match(adminConfirm, /createV3AdminActionJob\(env\.AUTH_DB, context\.id, "score"/);
  assert.match(adminConfirm, /accepted: true/);
  assert.match(adminConfirm, /async: true/);

  assert.match(scoreExecutor, /hasCurrentV3ScoreJobLease/);
  assert.match(scoreExecutor, /V3_FINAL_LINEUP_REQUIRED/);
  assert.match(scoreExecutor, /createScoreAttempt/);
  assert.match(scoreExecutor, /markScoreAttemptReady/);
  assert.match(scoreExecutor, /commitScoreAttempt/);
  assert.equal(typeof V3_JOB_EXECUTORS[V3_JOB_TYPE.SCORE], "function");
});

test("Phase 1: admin confirm and exact job run are idempotent on an isolated V3 fixture", async () => {
  const fixture = await createFormalPipelineFixture();
  try {
    // Close predictions through the existing planner/executor first. This is
    // intentionally not a direct state update: the scoring recovery test must
    // retain the same deadline gate as Cron.
    await runFormalPipeline(fixture, { maxPasses: 1 });
    await finalizeSyntheticLineups(fixture);
    const game = fixture.games[0];
    const base = {
      gameId: game.internalGameId,
      gameDate: game.gameDate,
      homeTeam: "fighters",
      awayTeam: "hawks",
      lineupVersion: 1,
      reason: "Phase 1 isolated scoring recovery"
    };
    const previewResponse = await adminRequest(fixture, `/api/admin/v3/games/${game.internalGameId}/scoring/preview`, base);
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 200, JSON.stringify(preview));
    assert.ok(preview.previewId);

    const confirmBody = { ...base, previewId: preview.previewId, confirmed: true };
    const firstConfirmResponse = await adminRequest(fixture, `/api/admin/v3/games/${game.internalGameId}/scoring/confirm`, confirmBody);
    const firstConfirm = await firstConfirmResponse.json();
    assert.equal(firstConfirmResponse.status, 202, JSON.stringify(firstConfirm));
    assert.equal(firstConfirm.accepted, true);
    assert.equal(firstConfirm.async, true);
    assert.equal(firstConfirm.job.job_type, "score");

    const secondConfirmResponse = await adminRequest(fixture, `/api/admin/v3/games/${game.internalGameId}/scoring/confirm`, confirmBody);
    const secondConfirm = await secondConfirmResponse.json();
    assert.equal(secondConfirmResponse.status, 202, JSON.stringify(secondConfirm));
    assert.equal(secondConfirm.job.id, firstConfirm.job.id);

    const runPath = `/api/admin/v3/games/${game.internalGameId}/jobs/${firstConfirm.job.id}/run`;
    const [firstRunResponse, concurrentRunResponse] = await Promise.all([
      adminRequest(fixture, runPath, { reason: "Phase 1 manual executor recovery", confirmed: true }),
      adminRequest(fixture, runPath, { reason: "Phase 1 concurrent retry guard", confirmed: true })
    ]);
    const firstRun = await firstRunResponse.json();
    const concurrentRun = await concurrentRunResponse.json();
    assert.ok([200, 409].includes(firstRunResponse.status), JSON.stringify(firstRun));
    assert.ok([200, 409].includes(concurrentRunResponse.status), JSON.stringify(concurrentRun));
    assert.ok([firstRun, concurrentRun].some((result) => result.status === "completed"), JSON.stringify({ firstRun, concurrentRun }));

    const completed = fixture.database.prepare(
      "SELECT id, status, attempt_count FROM game_jobs_v3 WHERE id = ?"
    ).get(firstConfirm.job.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.attempt_count, 1);
    const contestId = createContestId(game.internalGameId, "fighters");
    assert.equal(countRows(fixture.database, "SELECT COUNT(*) AS count FROM contest_game_rescore_jobs WHERE internal_game_id = ? AND status = 'completed'", game.internalGameId), 1);
    assert.equal(countRows(fixture.database, "SELECT COUNT(*) AS count FROM contest_score_attempts WHERE contest_id = ? AND internal_game_id = ? AND status = 'committed'", contestId, game.internalGameId), 1);
    assert.equal(countRows(fixture.database, "SELECT COUNT(*) AS count FROM contest_scoring_revisions WHERE contest_id = ? AND internal_game_id = ?", contestId, game.internalGameId), 1);
    assert.equal(countRows(fixture.database, "SELECT COUNT(*) AS count FROM contest_prediction_score_revisions WHERE contest_id = ? AND internal_game_id = ?", contestId, game.internalGameId), 3);
  } finally {
    closeFormalPipelineFixture(fixture);
  }
});

test("Phase 0: V3 scoring requires the deadline and canonical lineup, then commits one fenced attempt", async () => {
  const fixture = await createFormalPipelineFixture();
  try {
    const before = await runFormalPipeline(fixture, {
      now: fixture.beforeDeadline,
      maxPasses: 2
    });
    assert.equal(before.executed.some((entry) => entry.jobType === "score"), false);
    assert.equal(countRows(fixture.database, "SELECT COUNT(*) AS count FROM contest_score_attempts"), 0);

    await finalizeSyntheticLineups(fixture);
    const run = await runFormalPipeline(fixture, { maxPasses: 8 });
    assert.equal(run.fullyClosed, true);

    for (const game of fixture.games) {
      const lineup = fixture.database.prepare(
        "SELECT final_lineup_revision_id, scoring_status FROM game_lineups WHERE internal_game_id = ?"
      ).get(game.internalGameId);
      const contestId = createContestId(game.internalGameId, "fighters");
      const attempt = fixture.database.prepare(
        `SELECT attempt_id, canonical_lineup_revision_id, scoring_lineup_revision_id,
                job_id, status
           FROM contest_score_attempts
          WHERE contest_id = ? AND internal_game_id = ? AND status = 'committed'`
      ).get(contestId, game.internalGameId);
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
