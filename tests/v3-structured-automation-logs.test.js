import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const audit = fs.readFileSync(path.join(root, "backend/automation-v3/audit.js"), "utf8");
const diagnostics = fs.readFileSync(path.join(root, "backend/automation-v3/diagnostics.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const html = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const css = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");

test("V3 Cron監査はrunIdとcorrelationIdをjob単位へ付与する", () => {
  assert.match(worker, /const runId = globalThis\.crypto\?\.randomUUID\?\./);
  assert.match(worker, /const correlationId = runId/);
  assert.match(audit, /\[v3_details=\$\{JSON\.stringify\(structuredDetails\)\}\]/);
  assert.match(audit, /plannerDecision/);
  assert.match(audit, /executorStage/);
});

test("V3 Cron監査はsummaryとjobType別の集計を保存する", () => {
  assert.match(worker, /eventType: "cron_run_summary"/);
  assert.match(diagnostics, /plannedByJobType/);
  assert.match(diagnostics, /createdByJobType/);
  assert.match(diagnostics, /claimConflicts/);
  assert.match(diagnostics, /processed: Number\(result\?\.processed/);
});

test("admin-v3は構造化監査の読み取りAPIと6種類のフィルタを持つ", () => {
  assert.match(worker, /\/api\/admin\/v3\/automation-logs/);
  for (const field of ["runId", "internalGameId", "jobType", "status", "reasonCode", "failureCode"]) {
    assert.match(worker, new RegExp(`searchParams\\.get\\("${field}"\\)`));
    assert.match(admin, /data-v3-automation-log-filter/);
  }
  assert.match(admin, /game run summaries/);
  assert.match(admin, /job timeline/);
  assert.match(admin, /latestCronSummary/);
});

test("admin-v3の監査表示は既存V3の読み取り専用導線で、キャッシュバスターを更新する", () => {
  assert.match(admin, /data-v3-automation-log-refresh/);
  assert.match(admin, /payload\.automationLogs = await v3Api\.getAutomationLogs/);
  assert.match(css, /\.automation-logs-panel/);
  assert.match(html, /admin-and-repo-polish-1/);
  const scheduled = worker.slice(worker.indexOf("async scheduled(event, env, ctx)"), worker.indexOf("async function runScheduledGameAutomationV3"));
  assert.doesNotMatch(scheduled, /runGameWorkflows|runDueCompletionWorkflowJobs|INSERT INTO game_workflow_logs/);
});
