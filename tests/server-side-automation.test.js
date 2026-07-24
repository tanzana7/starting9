import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(root, "auth-worker.js");
const workerUrl = pathToFileURL(workerPath).href;
const worker = fs.readFileSync(workerPath, "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const config = fs.readFileSync(path.join(root, "wrangler.auth.production.jsonc"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0013_game_automation_health.sql"), "utf8");

test("scheduled entry point is the server-side automation trigger", () => {
  assert.match(worker, /async scheduled\(event, env, ctx\)/);
  assert.match(worker, /ctx\.waitUntil\(runScheduledGameAutomation\(env, scheduledAt\)\)/);
  assert.match(worker, /await syncTodayFightersSchedule\(env, now\)/);
  assert.match(worker, /await runGameWorkflows\(env, now\)/);
  assert.match(config, /"crons": \["\* \* \* \* \*"\]/);
});

test("server-side schedule synchronization covers today and the next JST day", async () => {
  const { getAutomationScheduleDates } = await import(workerUrl);
  assert.deepEqual(
    getAutomationScheduleDates(new Date("2026-07-24T14:59:00.000Z")),
    ["2026-07-24", "2026-07-25"]
  );
  assert.deepEqual(
    getAutomationScheduleDates(new Date("2026-07-24T15:00:00.000Z")),
    ["2026-07-25", "2026-07-26"]
  );
  assert.match(worker, /loadDetectedScheduleGames\(env\.AUTH_DB, dates\)/);
  assert.match(worker, /setDetectedScheduleGames\(rows\)/);
});

test("workflow isolates roster, lineup, scoring, and publication failures by game", () => {
  assert.match(worker, /for \(const timeline of timelines\) \{\s+if \(now < timeline\.predictionDeadlineAt/s);
  assert.match(worker, /step=close_predictions action=executed status=failed/);
  assert.match(worker, /step=notice action=distribution status=failed/);
  assert.match(worker, /step=lineup action=executed status=failed/);
  assert.match(worker, /let claimed = null/);
  assert.match(worker, /if \(claimed\) \{/);
  assert.match(worker, /recordGameWorkflowOutcome\(env\.AUTH_DB, row\.game_id, "score", "failed"/);
  assert.match(worker, /step=publish action=executed status=failed/);
});

test("automation health is persisted by Cron and exposed only through admin state", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_automation_health/);
  assert.match(migration, /cron_last_run_at/);
  assert.match(migration, /processed_game_count/);
  assert.match(worker, /async function recordAutomationHealth/);
  assert.match(worker, /await recordAutomationHealth\(env\.AUTH_DB, \{ now, summary \}\)/);
  assert.match(worker, /\/api\/admin\/automation\/health/);
  assert.match(worker, /async function handleAdminAutomationHealth/);
  assert.match(worker, /const health = await getAutomationHealth\(db\)/);
  assert.match(script, /最終Cron実行/);
  assert.match(script, /最終Cron成功/);
});

test("schedule sync failure is recorded as a failed Cron run even when no game is loaded", async () => {
  const { summarizeGameAutomationRun } = await import(workerUrl);
  const summary = summarizeGameAutomationRun({ date: "2026-07-25", scheduleSync: "failed" });
  assert.equal(summary.failed, 1);
  assert.equal(summary.status, "failed");
  assert.match(worker, /Number\(summary\?\.failed \|\| 0\) > 0/);
});

test("manual admin endpoints remain fallbacks while scoring and publication reuse server cores", () => {
  assert.match(worker, /publishScoredGameResults\(env, metadata\.gameId, new Date\(\)\)/);
  assert.match(worker, /scoreClaimedGameLineup\(env\.AUTH_DB, claimed, now\)/);
  assert.doesNotMatch(script, /runScheduledGameAutomation\(/);
});
