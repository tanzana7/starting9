import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;

test("ページを開かなくてもscheduledから通常Cronワークフローとログ保持処理が始まる", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /async scheduled\(event, env, ctx\)/);
  assert.match(worker, /ctx\.waitUntil\(runScheduledGameAutomation\(env, scheduledAt\)\)/);
  assert.match(worker, /const workflowResult = await runGameWorkflows\(env, now, scheduleSync\.games\)/);
  assert.match(worker, /await cleanupWorkflowLogs\(env\.AUTH_DB, now\)/);
});

test("通常Cronの各段階の予期しない失敗は共通の観測ログへ記録し、テストCronとは分離される", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /async function recordCronStepFailure\(db, processName, now, error\)/);
  for (const processName of ["prediction_target", "game_day_schedule", "roster", "probable_starter", "lineup", "scoring", "publication"]) {
    assert.match(worker, new RegExp(`recordCronStepFailure\\(env\\.AUTH_DB, "${processName}"`));
  }
  const testCronBlock = worker.match(/try \{ shared\.autoScoringTests[\s\S]*?catch \(error\) \{([^}]*)\}/)?.[1] || "";
  assert.doesNotMatch(testCronBlock, /recordCronStepFailure/);
  assert.match(worker, /eventType: "cron_step_failed"/);
  assert.match(worker, /source: "cron"/);
});

test("同じイベントの同一状態は直近30分だけ抑止し、状態回復後の再発は記録できる", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /WORKFLOW_LOG_DEDUPE_WINDOW_MS = 30 \* 60 \* 1000/);
  assert.match(worker, /async function hasRecentEquivalentWorkflowLog\(db,/);
  assert.match(worker, /const recent = \(rows\.results \|\| \[\]\)\.find/);
  assert.match(worker, /recent\.status === status/);
  assert.match(worker, /String\(recent\.error_code \|\| ""\) === normalizedErrorCode/);
  assert.match(worker, /if \(await hasRecentEquivalentWorkflowLog\(db, \{/);
  assert.match(worker, /occurred_at > \?3/);
});

test("ログのメタデータは観測用の標準項目に整えられ、秘密情報をシリアライズしない", () => {
  const worker = read("auth-worker.js");
  for (const field of ["processName", "gameId", "gameDate", "attemptedAt", "completedAt", "durationMs", "source"]) {
    assert.match(worker, new RegExp(`${field}:`));
  }
  assert.match(worker, /cookie\|authorization\|token\|secret\|password\|webhook/);
  assert.match(worker, /return \"\[redacted\]\"/);
});

test("ログは48時間より古いものを、既存のJST日次メンテナンスゲートで削除する", async () => {
  const worker = await import(authWorkerUrl);
  assert.equal(worker.getWorkflowLogCutoff("2026-07-30T12:00:00.000Z"), "2026-07-28T12:00:00.000Z");
  const source = read("auth-worker.js");
  assert.match(source, /WORKFLOW_LOG_CLEANUP_KEY = "workflow_logs_48h"/);
  assert.match(source, /DELETE FROM game_workflow_logs WHERE occurred_at < \?1/);
  assert.match(source, /getJstDateString\(new Date\(maintenance\.last_cleanup_at\)\) === today/);
});

test("管理画面のログAPIは読み取り専用で、開いたことによるCron処理を持たない", () => {
  const worker = read("auth-worker.js");
  const script = read("script.js");
  assert.match(worker, /path === "\/api\/admin\/workflow-logs" && request\.method === "GET"/);
  assert.match(worker, /const access = await requireAdminUser\(request, env, cors\)/);
  assert.match(script, /\/api\/admin\/workflow-logs/);
  assert.doesNotMatch(script, /runScheduledGameAutomation/);
});

test("ログ保存・削除の失敗はCron停止用のthrowにならずconsoleへ残る", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /async function recordWorkflowLog\(db,/);
  assert.match(worker, /action=write status=failed/);
  assert.match(worker, /return false;/);
  assert.match(worker, /async function cleanupWorkflowLogs\(db, now\)[\s\S]*action=cleanup status=failed/);
});
