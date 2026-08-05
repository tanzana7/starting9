const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("新規日程はinternal ID登録とidentifier登録を同じ同期経路で行う", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /resolveScheduleInternalGameId\(env\.AUTH_DB, registry/);
  assert.match(worker, /getOrCreateInternalGame\(db, \{/);
  assert.match(worker, /createScheduleGameIdentifiers\(/);
  assert.match(worker, /UPDATE detected_game_schedule SET internal_game_id/);
});

test("スケジュール同期完了後にだけ試合前処理が始まる", () => {
  const worker = read("auth-worker.js");
  const scheduledStart = worker.indexOf("export async function runScheduledGameAutomation");
  const workflowStart = worker.indexOf("async function runGameWorkflows", scheduledStart);
  const syncCall = worker.indexOf("scheduleSync = await syncTodayFightersSchedule(env, now)", scheduledStart);
  const workflowCall = worker.indexOf("await runGameWorkflows(env, now, scheduleSync.games)", scheduledStart);
  assert.ok(scheduledStart >= 0);
  assert.ok(workflowStart > syncCall);
  assert.ok(workflowCall > syncCall);
  assert.doesNotMatch(worker.slice(workflowStart, worker.indexOf("// Cron実行はブラウザ", workflowStart)), /Promise\.all/);
});

test("workflow job chainは各成功後に後続jobを生成し、reconciliationで欠落を補完する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /provisional_lineup_fetch: "final_lineup_fetch"/);
  assert.match(worker, /probable_starter_fetch: "provisional_lineup_fetch"/);
  assert.match(worker, /final_lineup_fetch: "scoring"/);
  assert.match(worker, /scoring: "ranking_update"/);
  assert.match(worker, /ranking_update: "publication"/);
  assert.match(worker, /ensureCompletionDownstreamJobs\(env, claimed, now\)/);
  assert.match(worker, /async function reconcileCompletionWorkflowJobs\(env, now, timelines\)/);
});

test("future slotのjobはdue runnerで実行せず、Cronだけが起動する", () => {
  const worker = read("auth-worker.js");
  const jobs = read("game-workflow-jobs.js");
  assert.match(worker, /ctx\.waitUntil\(runScheduledGameAutomation\(env, scheduledAt\)\)/);
  assert.match(jobs, /scheduled_slot_at <= \?\$\{types\.length \+ 1\}/);
  assert.match(jobs, /status = 'retry_wait'/);
  assert.doesNotMatch(read("script.js"), /runScheduledGameAutomation\(/);
});

test("service_unavailableへ遷移した試合の採点・ランキング・公開jobを停止する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /to: "service_unavailable", errorCode: SCORING_RETRY_EXPIRED_CODE/);
  assert.match(worker, /job_type IN \('scoring', 'ranking_update', 'publication'\)/);
  assert.match(worker, /status = 'cancelled'/);
  assert.match(worker, /isFinalLineupRetryExpired\(timeline, now\)/);
});

test("新runnerの処理失敗で同じCron内にlegacy runnerを二重実行しない", () => {
  const worker = read("auth-worker.js");
  const start = worker.indexOf("async function runGameWorkflows");
  const end = worker.indexOf("// Cron実行はブラウザ", start);
  const block = worker.slice(start, end);
  assert.match(block, /if \(completionJobsEnabled\)/);
  assert.match(block, /runDueCompletionWorkflowJobs\(executorEnv, executorNow, executorTimelines\)/);
  const enabledBranch = /if \(completionJobsEnabled\) \{([\s\S]*?)\} else/.exec(block)?.[1] || "";
  assert.doesNotMatch(enabledBranch, /runDuePregameAutomationJobs\(env, now, activeTimelines\)/);
});

test("修復APIは通常Cronの実行経路に含まれない", () => {
  const worker = read("auth-worker.js");
  const start = worker.indexOf("async function runGameWorkflows");
  const end = worker.indexOf("// Cron実行はブラウザ", start);
  assert.doesNotMatch(worker.slice(start, end), /handleAdminGameIdentityRepairs|applyGameIdentityRepairPlan/);
});
