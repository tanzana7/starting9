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
  assert.match(worker, /const timelines = await getCronPregameTimelines\(env\.AUTH_DB, now, syncedGames\)/);
  assert.match(worker, /const detected = await loadDetectedScheduleGames\(db, dates\)/);
  assert.match(worker, /setDetectedScheduleGames\(detected\)/);
  assert.match(worker, /await runGameWorkflows\(env, now, scheduleSync\.games\)/);
  assert.match(config, /"crons": \["\* \* \* \* \*"\]/);
});

test("server-side schedule synchronization covers the near-term JST window", async () => {
  const { getAutomationScheduleDates } = await import(workerUrl);
  assert.deepEqual(
    getAutomationScheduleDates(new Date("2026-07-24T14:59:00.000Z")),
    ["2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27"]
  );
  assert.deepEqual(
    getAutomationScheduleDates(new Date("2026-07-24T15:00:00.000Z")),
    ["2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28"]
  );
  assert.deepEqual(
    getAutomationScheduleDates(new Date("2026-08-01T00:00:00.000Z")),
    ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]
  );
  assert.match(worker, /loadDetectedScheduleGames\(env\.AUTH_DB, dates\)/);
  assert.match(worker, /setDetectedScheduleGames\(rows\)/);
  assert.match(worker, /const AUTOMATION_SCHEDULE_SYNC_INTERVAL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(worker, /now\.getTime\(\) \+ AUTOMATION_SCHEDULE_SYNC_INTERVAL_MS/);
});

test("schedule sync distinguishes changed, unchanged, skipped, and failed outcomes", async () => {
  const { classifyScheduleSyncResults, summarizeGameAutomationRun } = await import(workerUrl);
  assert.equal(classifyScheduleSyncResults([{ status: "success_changed" }, { status: "skipped" }]), "success_changed");
  assert.equal(classifyScheduleSyncResults([{ status: "success_no_change" }, { status: "skipped" }]), "success_no_change");
  assert.equal(classifyScheduleSyncResults([{ status: "skipped" }]), "skipped");
  assert.equal(classifyScheduleSyncResults([{ status: "success_no_change" }, { status: "failed" }]), "failed");
  assert.equal(summarizeGameAutomationRun({ date: "2026-07-30", scheduleSync: "success_no_change" }).failed, 0);
  assert.match(worker, /if \(status === "success_no_change" \|\| status === "skipped"\) return;/);
  assert.match(worker, /error_code = \?1 AND occurred_at >= \?2/);
  assert.match(worker, /new Date\(now\)\.getTime\(\) - 30 \* 60 \* 1000/);
});

test("workflow isolates roster, lineup, scoring, and publication failures by game", () => {
  assert.match(worker, /for \(const timeline of timelines\) \{\s+if \(now < timeline\.predictionDeadlineAt/s);
  assert.match(worker, /step=close_predictions action=executed status=failed/);
  assert.match(worker, /step=notice action=distribution status=failed/);
  assert.match(worker, /step=\$\{isFinalPhase \? "final_lineup" : "lineup"\} action=executed status=failed/);
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

test("Cronのタイムライン復元はページアクセスを必要とせず、最終取得・採点・公開へ接続する", () => {
  const workflowBlock = worker.slice(worker.indexOf("async function runGameWorkflows"), worker.indexOf("function normalizeProbableStarterTeam"));
  assert.match(workflowBlock, /await runDuePregameAutomationJobs\(env, now, activeTimelines\)/);
  assert.match(workflowBlock, /await runDueAutoScoringJobs\(env, now, pausedGameIds\)/);
  assert.match(workflowBlock, /await runDueGameDayPublicationJobs\(env, now, activeTimelines\)/);
  assert.doesNotMatch(script, /runDuePregameAutomationJobs|runDueAutoScoringJobs|runDueGameDayPublicationJobs/);
});
