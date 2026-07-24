import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;

test("Cronは日程同期後に明示的な試合workflow runnerへ委譲する", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(worker, /const GAME_WORKFLOW_STEPS = Object\.freeze/);
  assert.match(worker, /const workflowResult = await runGameWorkflows\(env, now\)/);
  assert.match(worker, /summarizeGameAutomationRun/);
  assert.match(worker, /\[GAME_AUTOMATION\]/);
  assert.match(worker, /getScheduledGames\(\)/);
  assert.match(worker, /async function runGameWorkflows\(env, now\)/);
  assert.match(worker, /function runGameWorkflow\(timeline, now, paused = false\)/);
  assert.match(worker, /id: "notice", offsetMinutes: -120/);
  assert.match(worker, /id: "close_predictions", offsetMinutes: -60/);
  assert.match(worker, /id: "lineup", offsetMinutes: -60, retryMinutes: 10/);
  assert.match(worker, /id: "score", trigger: "lineup_confirmed"/);
  assert.match(worker, /id: "publish", offsetMinutes: 0/);
});

test("workflowは中止試合を全step cancelledとして扱い、時刻未到達stepを実行しない", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(worker, /if \(cancelled\) return \{ id: step\.id, status: "cancelled", action: "skipped" \}/);
  assert.match(worker, /step\.trigger === "lineup_confirmed"/);
  assert.match(worker, /status: now < dueAt \? "not_due" : "ready"/);
  assert.match(worker, /runDueGameDayScheduleJobs\(env, now, activeTimelines\)/);
  assert.match(worker, /runDuePregameAutomationJobs\(env, now, activeTimelines\)/);
  assert.match(worker, /runDueAutoScoringJobs\(env, now, pausedGameIds\)/);
  assert.match(worker, /runDueGameDayPublicationJobs\(env, now, activeTimelines\)/);
});

test("workflow観測要約は試合・実行・失敗・中止を安全に分類する", async () => {
  const { summarizeGameAutomationRun } = await import(authWorkerUrl);

  assert.equal(summarizeGameAutomationRun({ date: "2026-07-23" }).status, "no_games");
  assert.equal(summarizeGameAutomationRun({
    date: "2026-07-23",
    workflows: [{ gameStatus: "scheduled" }]
  }).status, "idle");
  assert.equal(summarizeGameAutomationRun({
    date: "2026-07-23",
    workflows: [{ gameStatus: "scheduled" }],
    shared: { lineup: { lineupCaptured: 1 } }
  }).status, "success");
  assert.equal(summarizeGameAutomationRun({
    date: "2026-07-23",
    workflows: [{ gameStatus: "scheduled" }],
    shared: { lineup: { lineupRetryWait: 1 } }
  }).retryWait, 1);
  assert.equal(summarizeGameAutomationRun({
    date: "2026-07-23",
    workflows: [{ gameStatus: "scheduled" }],
    shared: { lineup: { lineupCaptured: 1, lineupFailed: 1 } }
  }).status, "partial_failure");
  assert.equal(summarizeGameAutomationRun({
    date: "2026-07-23",
    workflows: [{ gameStatus: "scheduled" }],
    shared: { scoring: { failed: 1 } }
  }).status, "failed");
  assert.equal(summarizeGameAutomationRun({
    date: "2026-07-23",
    workflows: [{ gameStatus: "cancelled" }]
  }).status, "cancelled");
});

test("観測ログは実行ステップだけを対象にし、時刻前・処理済みを毎分出力しない", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(worker, /if \(!shouldLogGameAutomationSummary\(summary\)\) return/);
  assert.match(worker, /now\.getTime\(\) === dueAt\.getTime\(\)/);
  assert.match(worker, /step=lineup action=executed status=success/);
  assert.match(worker, /step=score action=executed status=success/);
  assert.match(worker, /step=publish action=executed status=success/);
  assert.doesNotMatch(worker, /status=not_due/);
  assert.doesNotMatch(worker, /status=already_completed/);
});
