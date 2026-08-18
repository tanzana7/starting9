import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const clientSource = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const apiClientSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "api-client.js"), "utf8");
const progressSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
const coordinatorSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "app-coordinator.js"), "utf8");
const { default: worker } = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);

function unauthenticated(pathname, method = "GET") {
  return worker.fetch(new Request(`https://starting9.test${pathname}`, { method }), { AUTH_DB: {} }, {});
}

test("全工程のdiagnose/run APIはadmin認証境界を持つ", async () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const diagnose = await unauthenticated(`/api/admin/v3/games/${id}/jobs/diagnose?jobType=lineup_fetch`);
  const run = await unauthenticated(`/api/admin/v3/games/${id}/jobs/run`, "POST");
  assert.equal(diagnose.status, 401);
  assert.equal(run.status, 401);
  assert.match(workerSource, /parseAdminV3JobControlRoute/);
  assert.match(workerSource, /async function handleAdminV3JobDiagnose/);
  assert.match(workerSource, /V3_CONFIRMATION_REQUIRED/);
});

test("手動再実行は既存V3 jobを投入し、Cron executorへ委譲する", () => {
  assert.match(workerSource, /createV3Job\(env\.AUTH_DB/);
  assert.match(workerSource, /source: "admin"/);
  assert.match(workerSource, /v3_admin_manual_job_run/);
  assert.match(workerSource, /recordV3AdminAudit\(env\.AUTH_DB/);
  assert.match(workerSource, /V3_MANUAL_JOB_STATE_GATES/);
  assert.match(workerSource, /V3_MANUAL_JOB_PREREQUISITE/);
  assert.doesNotMatch(workerSource, /handleAdminV3JobCreate[\s\S]{0,500}runScheduledGameAutomation\(/);
});

test("診断レスポンスはstate・最新job・実行可否・関連データ要約を返す契約を持つ", () => {
  for (const field of ["currentWorkflowState", "latestJobStatus", "latestJobId", "latestJobScheduledAt", "latestJobClaimedAt", "latestJobCompletedAt", "latestJobError", "canRun", "cannotRunReason", "nextExpectedState", "relatedDataSummary"]) {
    assert.match(workerSource, new RegExp(field));
  }
  assert.match(workerSource, /formalRunner: false/);
  assert.match(workerSource, /schedule_register手動runnerはありません/);
});

test("admin-v3は各工程の診断・再実行ボタンを持ち、公開UIには含めない", () => {
  for (const jobType of ["probable_starter_fetch", "roster_fetch", "prediction_close", "npb_identity_resolve", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]) {
    assert.match(progressSource, new RegExp(jobType));
  }
  assert.match(progressSource, /data-v3-job-diagnose/);
  assert.match(progressSource, /data-v3-job-run/);
  assert.match(coordinatorSource, /actions\.diagnoseJob/);
  assert.match(coordinatorSource, /actions\.runJob/);
  assert.match(apiClientSource, /diagnoseJob/);
  assert.match(apiClientSource, /runJob/);
  assert.match(clientSource, /window\.confirm/);
  assert.match(clientSource, /window\.prompt/);
});
