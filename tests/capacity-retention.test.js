import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker, { shouldPersistV3Audit } from "../auth-worker.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "auth-worker.js"), "utf8");

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

test("storage maintenance is scheduled outside the critical path at a JST hourly boundary", () => {
  assert.match(SOURCE, /isV3StorageMaintenanceWindow\(now\)/);
  assert.match(SOURCE, /scheduleOptional\(maintenancePromise\)/);
  assert.match(SOURCE, /V3_STORAGE_MAINTENANCE_MINUTE_JST = 0/);
});
