import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-game-progress.js"), "utf8");
const pageSource = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const cssSource = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
const { default: worker } = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);

test("job診断APIはadmin認証境界を維持する", async () => {
  const id = "00000000-0000-4000-8000-000000000000";
  const response = await worker.fetch(
    new Request(`https://starting9.test/api/admin/v3/games/${id}/jobs/diagnose?jobType=lineup_fetch`),
    { AUTH_DB: {} },
    {}
  );
  assert.equal(response.status, 401);
});

test("job診断はライフサイクル、復旧、state遷移、成果物、中止情報を返す", () => {
  for (const field of [
    "getV3AdminJobDiagnosticContext",
    "jobTimeline",
    "recoveryJobCreated",
    "workflowTransitions",
    "npbResponse",
    "cancellation",
    "stoppedJobsTotal",
    "diagnosticContext"
  ]) {
    assert.match(workerSource, new RegExp(field));
  }
  for (const field of ["candidateId", "candidateInternalGameId", "candidateCreatedAt", "canonicalExists", "finalizedRowCount", "finalizedCreatedAt"]) {
    assert.match(workerSource, new RegExp(field));
  }
  for (const field of ["scheduledSlotAt", "createdAt", "claimedAt", "completedAt", "failedAt", "attemptCount", "nextRetryAt"]) {
    assert.match(rendererSource, new RegExp(field));
  }
  assert.match(rendererSource, /artifact health/);
  assert.match(rendererSource, /workflow state transition/);
  assert.match(rendererSource, /cancelled \/ excluded/);
});

test("診断表示はATTENTIONを強調し、詳細を折りたためる", () => {
  assert.match(rendererSource, /data-v3-job-diagnostic/);
  assert.match(rendererSource, /ATTENTION/);
  assert.match(rendererSource, /nextSafeAction/);
  assert.match(cssSource, /\.v3-job-diagnostic\.attention/);
  assert.match(cssSource, /\.v3-job-diagnostic-grid/);
});

test("admin-v3のmanual lineup safety変更assetが専用cache busterを使う", () => {
  assert.match(pageSource, /admin-v3\.css\?v=manual-lineup-finalize-safety-1/);
  assert.match(pageSource, /admin-v3\.js\?v=manual-lineup-finalize-safety-1/);
  assert.match(pageSource, /render-manual-lineup\.js\?v=manual-lineup-finalize-safety-1/);
  assert.match(pageSource, /render-game-progress\.js\?v=manual-lineup-finalize-safety-1/);
  assert.doesNotMatch(pageSource, /admin-v3-fetch-safety-status-1/);
});
