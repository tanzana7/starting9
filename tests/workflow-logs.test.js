import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;

test("通常試合の進行ログmigrationは必要な項目・索引・90日cleanup状態を持つ", () => {
  const migration = read("migrations/0019_game_workflow_logs.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_workflow_logs/);
  for (const column of ["id", "event_type", "status", "game_id", "occurred_at", "message", "error_code", "metadata", "source"]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration, /status IN \('success', 'warning', 'error', 'info'\)/);
  assert.match(migration, /source IN \('cron', 'admin', 'system'\)/);
  assert.match(migration, /idx_game_workflow_logs_occurred_at/);
  assert.match(migration, /game_workflow_log_maintenance/);
  assert.match(read("auth-worker.js"), /WORKFLOW_LOG_RETENTION_DAYS = 90/);
});

test("ログAPIは管理者限定で、絞り込み・新しい順・最大200件を適用する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /path === "\/api\/admin\/workflow-logs" && request\.method === "GET"/);
  assert.match(worker, /async function handleAdminWorkflowLogs\(request, env, cors\)/);
  assert.match(worker, /const access = await requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /gameId = String\(url\.searchParams\.get\("gameId"\)/);
  assert.match(worker, /eventType = String\(url\.searchParams\.get\("eventType"\)/);
  assert.match(worker, /WORKFLOW_LOG_STATUSES\.has\(status\)/);
  assert.match(worker, /dateFrom/);
  assert.match(worker, /dateTo/);
  assert.match(worker, /WORKFLOW_LOG_MAX_LIMIT = 200/);
  assert.match(worker, /ORDER BY occurred_at DESC, id DESC LIMIT/);
  assert.match(worker, /Cache-Control/, "一覧APIはno-storeで返す");
});

test("各ログは共通関数を通り、保存失敗を本体処理へ伝播させず、テスト試合を除外する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /async function recordWorkflowLog\(db,/);
  assert.match(worker, /if \(normalizedGameId && await isTestRankingGame\(db, normalizedGameId\)\) return null/);
  assert.match(worker, /action=write status=failed/);
  assert.match(worker, /WORKFLOW_LOG_STATUSES/);
  assert.match(worker, /WORKFLOW_LOG_SOURCES/);
  assert.match(worker, /serializeWorkflowLogMetadata/);
  assert.match(worker, /cookie\|authorization\|token\|secret/);
  assert.match(worker, /await cleanupWorkflowLogs\(env\.AUTH_DB, now\)/);
});

test("要求された通常試合イベントをCron・管理操作から記録する", () => {
  const worker = read("auth-worker.js");
  for (const eventType of [
    "schedule_sync", "prediction_target_switched", "prediction_target_switch_skipped",
    "lineup_fetch", "lineup_fallback", "scoring_started",
    "scoring_succeeded", "scoring_failed", "scoring_skipped", "result_published",
    "ranking_reflected", "admin_manual_operation", "admin_lineup_revision", "admin_rescore_confirmed"
  ]) {
    assert.match(worker, new RegExp(eventType), `${eventType}の記録がない`);
  }
  assert.match(worker, /eventType: isFinalPhase \? "final_lineup_fetch" : "lineup_fetch"/);
  assert.match(worker, /source: "cron"/);
  assert.match(worker, /source: "admin"/);
});

test("管理画面は試合進行ログを管理者だけに表示し、フィルターと詳細展開を持つ", () => {
  const html = read("index.html");
  const script = read("script.js");
  const style = read("style.css");
  assert.match(html, /id="adminWorkflowLogsPanel"/);
  assert.match(html, /id="adminWorkflowLogGameId"/);
  assert.match(html, /id="adminWorkflowLogEventType"/);
  assert.match(html, /id="adminWorkflowLogStatus"/);
  assert.match(html, /id="refreshAdminWorkflowLogsButton"/);
  assert.match(html, /id="adminWorkflowLogsList"/);
  assert.match(html, /id="toggleAdminWorkflowLogsButton"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="adminWorkflowLogsContent"/);
  assert.match(script, /state\.appMode === "admin" && state\.adminAccess\.status === "authorized"/);
  assert.match(script, /\/api\/admin\/workflow-logs/);
  assert.match(script, /function renderAdminWorkflowLogs\(\)/);
  assert.match(script, /<details><summary>詳細<\/summary><pre>/);
  assert.match(script, /cache: "no-store"/);
  assert.match(style, /\.workflow-log-status-error/);
  assert.match(style, /@media \(max-width: 759px\)/);
});

test("予告先発の取得イベントはサーバー側のCron・管理者経路で記録する", () => {
  const worker = read("auth-worker.js");
  const script = read("script.js");
  for (const eventType of [
    "probable_starter_fetch_started",
    "probable_starter_unannounced",
    "probable_starter_announced",
    "probable_starter_fetch_failed",
    "probable_starter_manual_refresh"
  ]) {
    assert.match(worker, new RegExp(eventType), `${eventType}の記録がない`);
  }
  assert.match(worker, /async function runDueProbableStarterJob\(env, now\)/);
  assert.match(worker, /fetchNpbWorkerJson\(env, \{ mode: "starter" \}\)/);
  assert.match(worker, /path === "\/api\/probable-starter" && request\.method === "GET"/);
  assert.match(worker, /probable-starter/);
  assert.match(worker, /refresh\$\/\);/);
  assert.doesNotMatch(script, /workflow-logs\/events/);
});

test("cleanupは同じJST日付に1回だけ実行する", async () => {
  const worker = await import(authWorkerUrl);
  assert.equal(typeof worker.summarizeGameAutomationRun, "function");
  const source = read("auth-worker.js");
  assert.match(source, /getJstDateString\(new Date\(maintenance\.last_cleanup_at\)\) === today/);
  assert.match(source, /DELETE FROM game_workflow_logs WHERE occurred_at < \?1/);
  assert.match(source, /game_workflow_log_maintenance/);
});
