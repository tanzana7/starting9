import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { createV3PhaseCheckpointTracker, shouldPersistV3Audit, shouldRunV3ScheduleSync } from "../auth-worker.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "auth-worker.js"), "utf8");
const AUTH_CONFIG = fs.readFileSync(path.join(ROOT, "wrangler.auth.production.jsonc"), "utf8");

test("routine V3 audit events are not persisted, while failures and meaningful jobs are retained", () => {
  assert.equal(shouldPersistV3Audit({ eventType: "V3_RUN_STARTED" }), false);
  assert.equal(shouldPersistV3Audit({ eventType: "V3_EXECUTION_SUMMARY" }), false);
  assert.equal(shouldPersistV3Audit({ eventType: "v3_job_plan_observed" }), false);
  assert.equal(shouldPersistV3Audit({ eventType: "schedule_sync", execution: { status: "completed" } }), false);
  assert.equal(shouldPersistV3Audit({ eventType: "V3_RUN_ERROR", failure: new Error("failed") }), true);
  assert.equal(shouldPersistV3Audit({ eventType: "v3_job_created", job: { status: "pending" } }), true);
  assert.equal(shouldPersistV3Audit({ eventType: "job", job: { status: "failed" } }), true);
  assert.equal(shouldPersistV3Audit({ eventType: "CRON_CRITICAL_PATH_FINISHED", execution: { status: "failed" } }), true);
  assert.equal(shouldPersistV3Audit({ eventType: "V3_EXECUTION_SUMMARY", execution: { failedJobCount: 1 } }), true);
});

test("capacity retention is bounded, source-scoped, and excludes formal tables", () => {
  assert.match(SOURCE, /V3_AUDIT_ROUTINE_RETENTION_DAYS = 7/);
  assert.match(SOURCE, /V3_AUDIT_FAILURE_RETENTION_DAYS = 30/);
  assert.match(SOURCE, /LIMIT \?2/);
  assert.match(SOURCE, /source IN \('cron', 'system'\)/);
  assert.match(SOURCE, /game_workflow_log_maintenance/);
  const cleanupStart = SOURCE.indexOf("async function cleanupExpiredV3Audits");
  const cleanupEnd = SOURCE.indexOf("function updatePredictionTargetState", cleanupStart);
  const cleanupSource = SOURCE.slice(cleanupStart, cleanupEnd);
  assert.doesNotMatch(cleanupSource, /DELETE FROM (games|predictions|game_lineups|game_lineup_revisions|prediction_score_revisions|game_scoring_revisions)/);
  assert.equal(typeof worker.fetch, "function");
});

test("phase checkpointはversion、runId、start/end、経過時間、due情報を構造化して出力する", () => {
  const output = [];
  const tracker = createV3PhaseCheckpointTracker(
    { CF_VERSION_METADATA: { id: "version-test", tag: "test", timestamp: "2026-09-25T00:00:00.000Z" } },
    "run-test",
    new Date("2026-09-25T00:00:00.000Z"),
    { logger: (line) => output.push(JSON.parse(line)) }
  );
  tracker.start("due_claim", { status: "started" });
  tracker.end("due_claim", { status: "completed", dueCount: 4, hasMoreDue: true });
  assert.equal(output.length, 2);
  assert.deepEqual(output.map((row) => [row.runId, row.phase, row.state]), [
    ["run-test", "due_claim", "start"],
    ["run-test", "due_claim", "end"]
  ]);
  assert.equal(output[0].workerVersionId, "version-test");
  assert.equal(output[1].dueCount, 4);
  assert.equal(output[1].hasMoreDue, true);
  assert.equal(typeof output[1].elapsedWallMs, "number");
  assert.ok(output[1].phaseStartedAt);
  assert.ok(output[1].observedAt);
  const failingLoggerTracker = createV3PhaseCheckpointTracker({}, "run-failing-log", new Date(), { logger: () => { throw new Error("log unavailable"); } });
  assert.doesNotThrow(() => failingLoggerTracker.start("planner"));
});

test("storage maintenance is scheduled outside the critical path at a JST hourly boundary", () => {
  assert.match(SOURCE, /isV3StorageMaintenanceWindow\(now\)/);
  assert.match(SOURCE, /scheduleOptional\(maintenancePromise\)/);
  assert.match(SOURCE, /V3_STORAGE_MAINTENANCE_MINUTE_JST = 0/);
});

test("schedule sync is five-minute bounded while the due-job dispatcher remains independent", () => {
  assert.equal(shouldRunV3ScheduleSync(new Date("2026-09-23T15:00:00.000Z")), true);
  assert.equal(shouldRunV3ScheduleSync(new Date("2026-09-23T15:01:00.000Z")), false);
  assert.equal(shouldRunV3ScheduleSync(new Date("2026-09-23T15:05:00.000Z")), true);
  assert.match(SOURCE, /event: "phase_checkpoint"/);
  for (const phase of ["cron_start", "planner", "due_claim", "executor", "cancellation", "schedule_sync", "probable_starter", "maintenance", "cron_finish"]) {
    assert.match(SOURCE, new RegExp(`phase: \\\"${phase}\\\"|\\\"${phase}\\\"`));
  }
  assert.match(AUTH_CONFIG, /version_metadata/);
  assert.match(SOURCE, /elapsedWallMs/);
  assert.match(SOURCE, /reasonCode: "SCHEDULE_SYNC_CADENCE"/);
});
