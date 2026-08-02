import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getWorkflowJobHealth,
  summarizeLineupWorkflowJobs
} from "../auth-worker.js";

const worker = await readFile(new URL("../auth-worker.js", import.meta.url), "utf8");
const workflowJobs = await readFile(new URL("../game-workflow-jobs.js", import.meta.url), "utf8");
const script = await readFile(new URL("../script.js", import.meta.url), "utf8");

const now = new Date("2026-08-02T05:05:00.000Z");

test("lineup retry_wait is a visible warning before next attempt and an error once overdue", () => {
  const future = getWorkflowJobHealth({
    jobType: "final_lineup_fetch",
    status: "retry_wait",
    nextAttemptAt: "2026-08-02T05:15:00.000Z",
    errorCode: "EXTERNAL_HTTP_ERROR",
    errorDetail: "取得に失敗しました。"
  }, now);
  assert.equal(future.level, "warning");
  assert.equal(future.reasonCode, "EXTERNAL_HTTP_ERROR");
  assert.equal(future.overdue, false);

  const overdue = getWorkflowJobHealth({
    jobType: "final_lineup_fetch",
    status: "retry_wait",
    nextAttemptAt: "2026-08-02T05:00:00.000Z",
    errorCode: "LINEUP_INVALID_PLAYER_COUNT"
  }, now);
  assert.equal(overdue.level, "error");
  assert.equal(overdue.overdue, true);
});

test("final lineup success resolves an older provisional retry and enables scoring", () => {
  const summary = summarizeLineupWorkflowJobs([
    {
      jobType: "provisional_lineup_fetch",
      status: "cancelled",
      updatedAt: "2026-08-02T05:05:00.000Z",
      errorCode: "DATA_NOT_ANNOUNCED"
    },
    {
      jobType: "final_lineup_fetch",
      status: "succeeded",
      attemptCount: 1,
      maxAttempts: 72,
      updatedAt: "2026-08-02T05:04:00.000Z"
    }
  ], now);
  assert.equal(summary.status, "completed");
  assert.deepEqual(summary.warnings, []);
  assert.deepEqual(summary.errors, []);
  assert.equal(summary.scoringEligibility.eligible, true);
  assert.equal(summary.lineupFetchStatus.provisional.status, "cancelled");
  assert.equal(summary.lineupFetchStatus.final.status, "succeeded");
  assert.equal(summary.lastFetchAttempt.jobType, "final_lineup_fetch");
});

test("retry diagnostics expose attempts, next time, validation counts, and do not expose lineup content", () => {
  const summary = summarizeLineupWorkflowJobs([{
    jobType: "final_lineup_fetch",
    status: "retry_wait",
    attemptCount: 2,
    maxAttempts: 72,
    nextAttemptAt: "2026-08-02T05:15:00.000Z",
    errorCode: "DATA_VALIDATION_FAILED",
    errorDetail: "NPBのスタメン人数が9人ではありません。",
    updatedAt: "2026-08-02T05:04:00.000Z",
    validation: { parsedCount: 8, expectedCount: 9, resolvedPlayerCount: 8, playerName: "不要な値" }
  }], now);
  assert.equal(summary.lastFetchAttempt.attemptCount, 2);
  assert.equal(summary.lastFetchAttempt.maxAttempts, 72);
  assert.equal(summary.lastFetchAttempt.nextAttemptAt, "2026-08-02T05:15:00.000Z");
  assert.equal(summary.validation.parsedCount, 8);
  assert.equal(summary.validation.expectedCount, 9);
  assert.equal(summary.validation.resolvedPlayerCount, 8);
  assert.equal(summary.validation.parsedHomeCount, null);
  assert.equal(summary.validation.parsedAwayCount, null);
  assert.equal("playerName" in summary.validation, false);
  assert.equal("lineup" in summary.lastFetchAttempt, false);
});

test("completion runner cancels provisional retry jobs before due-job execution", () => {
  assert.match(worker, /cancelSupersededLineupJobs\(env\.AUTH_DB, internalGameId, now\)/);
  assert.match(worker, /job_type = 'provisional_lineup_fetch'/);
  assert.match(worker, /status IN \('pending', 'retry_wait', 'claimed', 'running'\)/);
  assert.match(worker, /if \(job\.job_type === "final_lineup_fetch"\) await cancelSupersededLineupJobs/);
});

test("completion retry records a workflow event and safe validation metadata", () => {
  assert.match(worker, /errorMetadata,/);
  assert.match(worker, /workflow_job_retry/);
  assert.match(worker, /attemptCount: Number\(claimed\.attempt_count \|\| 0\)/);
  assert.match(worker, /actual\.validation/);
  assert.match(workflowJobs, /result_metadata = \?8/);
});

test("admin workflow status surfaces retry diagnostics without changing automation behavior", () => {
  assert.match(worker, /lineupFetchStatus: jobSummary\.lineupFetchStatus/);
  assert.match(worker, /lastFetchAttempt: jobSummary\.lastFetchAttempt/);
  assert.match(worker, /scoringEligibility: jobSummary\.scoringEligibility/);
  assert.match(worker, /const errors = \[\.\.\.new Set\(jobSummary\.errors \|\| \[\]\)\]/);
  assert.match(script, /finalLineupJob\?\.status === "retry_wait"/);
  assert.match(script, /スタメン検証詳細/);
  assert.match(script, /jobErrors\.length \? " error-message" : jobWarnings\.length \? " warning-message"/);
});
