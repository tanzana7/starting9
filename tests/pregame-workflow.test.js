import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Cronは日程同期後に明示的な試合workflow runnerへ委譲する", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(worker, /const GAME_WORKFLOW_STEPS = Object\.freeze/);
  assert.match(worker, /return runGameWorkflows\(env, now\)/);
  assert.match(worker, /async function runGameWorkflows\(env, now\)/);
  assert.match(worker, /function runGameWorkflow\(timeline, now\)/);
  assert.match(worker, /id: "notice", offsetMinutes: -120/);
  assert.match(worker, /id: "close_predictions", offsetMinutes: -60/);
  assert.match(worker, /id: "lineup", offsetMinutes: -60, retryMinutes: 10/);
  assert.match(worker, /id: "score", offsetMinutes: 5/);
  assert.match(worker, /id: "publish", offsetMinutes: 6/);
});

test("workflowは中止試合を全step cancelledとして扱い、時刻未到達stepを実行しない", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(worker, /if \(cancelled\) return \{ id: step\.id, status: "cancelled", action: "skipped" \}/);
  assert.match(worker, /status: now < dueAt \? "not_due" : "ready"/);
  assert.match(worker, /runDueGameDayScheduleJobs\(env, now\)/);
  assert.match(worker, /runDuePregameAutomationJobs\(env, now\)/);
  assert.match(worker, /runDueAutoScoringJobs\(env, now\)/);
  assert.match(worker, /runDueGameDayPublicationJobs\(env, now\)/);
});
