import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const executor = fs.readFileSync(path.join(root, "backend", "automation-v3", "executor.js"), "utf8");
const audit = fs.readFileSync(path.join(root, "backend/automation-v3/audit.js"), "utf8");
const diagnostics = fs.readFileSync(path.join(root, "backend/automation-v3/diagnostics.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const adminDiagnostics = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-diagnostics.js"), "utf8");
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
  assert.match(diagnostics, /legacy_or_unclassified/);
  assert.match(diagnostics, /createdByJobType/);
  assert.match(diagnostics, /claimConflicts/);
  assert.match(diagnostics, /processed: Number\(result\?\.processed/);
  assert.match(worker, /roster_plan: "roster_fetch"/);
});

test("V3 Cron監査はruntime開始・game・claim・summaryを既存auditへ記録する", () => {
  for (const eventType of [
    "CRON_HANDLER_STARTED",
    "CRON_HANDLER_FLAGS",
    "V3_RUN_STARTED",
    "V3_ELIGIBLE_GAMES",
    "V3_RECONCILIATION_STARTED",
    "V3_RECONCILIATION_FINISHED",
    "V3_FORMAL_PLAN_STARTED",
    "V3_FORMAL_PLAN_FINISHED",
    "V3_FORMAL_PLAN_ERROR",
    "CRON_CRITICAL_PATH_FINISHED",
    "V3_AUXILIARY_PLAN_STARTED",
    "V3_AUXILIARY_PLAN_FINISHED",
    "V3_AUXILIARY_PLAN_SUMMARY",
    "V3_FORMAL_DUE_PLAN_SUMMARY",
    "V3_CLAIM_PHASE_STARTED",
    "V3_CLAIM_EXECUTION_SUMMARY",
    "V3_EXECUTION_SUMMARY",
    "V3_RUN_FINISHED",
    "V3_RUN_ERROR",
    "CRON_HANDLER_FINISHED",
    "V3_SCHEDULE_SYNC_ERROR"
  ]) {
    assert.match(worker, new RegExp(`"${eventType}"`));
  }
  assert.match(worker, /writeV3RuntimeAudit/);
  assert.match(executor, /gameIds: games\.map/);
  assert.match(worker, /createdJobCount/);
  assert.match(worker, /executedJobCount/);
});

test("V3 Cron監査はaudit失敗を本体処理へ伝播させない", () => {
  assert.match(worker, /runtime_audit_failed/);
  assert.match(worker, /return false;/);
  assert.match(worker, /onPhase: async \(phase\)/);
});

test("既存Cronサマリーのunknown/planは監査画面で未分類として表示する", () => {
  assert.match(adminDiagnostics, /normalizeDiagnosticJobType/);
  assert.match(adminDiagnostics, /legacy_or_unclassified/);
  assert.match(adminDiagnostics, /plannedByJobType: normalizeDiagnosticCounts/);
});

test("admin-v3は構造化監査の読み取りAPIと6種類のフィルタを持つ", () => {
  assert.match(worker, /\/api\/admin\/v3\/automation-logs/);
  for (const field of ["runId", "internalGameId", "jobType", "status", "reasonCode", "failureCode"]) {
    assert.match(worker, new RegExp(`searchParams\\.get\\("${field}"\\)`));
    assert.match(adminDiagnostics, /data-v3-automation-log-filter/);
  }
  assert.match(adminDiagnostics, /game run summaries/);
  assert.match(adminDiagnostics, /job timeline/);
  assert.match(adminDiagnostics, /latestCronSummary/);
});

test("admin-v3の監査表示は既存V3の読み取り専用導線で、キャッシュバスターを更新する", () => {
  assert.match(adminDiagnostics, /data-v3-automation-log-refresh/);
  assert.match(admin, /payload\.automationLogs = await v3Api\.getAutomationLogs/);
  assert.match(css, /\.automation-logs-panel/);
  assert.match(html, /v4-canonical-status-1/);
  const scheduled = worker.slice(worker.indexOf("async scheduled(event, env, ctx)"), worker.indexOf("async function runScheduledGameAutomationV3"));
  assert.doesNotMatch(scheduled, /runGameWorkflows|runDueCompletionWorkflowJobs|INSERT INTO game_workflow_logs/);
});
