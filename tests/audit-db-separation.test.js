import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { shouldPersistV3Audit } from "../auth-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const plannerSource = fs.readFileSync(path.join(root, "backend", "automation-v3", "planner.js"), "utf8");
const migrationSource = fs.readFileSync(path.join(root, "migrations-audit", "0001_initial_audit.sql"), "utf8");
const configSource = fs.readFileSync(path.join(root, "wrangler.auth.production.jsonc"), "utf8");
const previewSource = fs.readFileSync(path.join(root, "backend", "admin", "manual-game-preview.js"), "utf8");
const identitySource = fs.readFileSync(path.join(root, "game-identity-registry.js"), "utf8");

test("AUDIT_DB binding is separate and uses the audit migration directory", () => {
  const config = JSON.parse(configSource);
  const bindings = config.d1_databases || [];
  const core = bindings.find((binding) => binding.binding === "AUTH_DB");
  const audit = bindings.find((binding) => binding.binding === "AUDIT_DB");
  assert.equal(core?.database_name, "starting9-auth");
  assert.equal(audit?.database_name, "starting9-audit");
  assert.ok(audit?.database_id);
  assert.equal(audit?.migrations_dir, "migrations-audit");
  assert.notEqual(core?.database_id, audit?.database_id);
});

test("audit migration is standalone and has no core-D1 foreign key", () => {
  const ddl = migrationSource.replace(/^--.*$/gm, "");
  assert.doesNotMatch(ddl, /FOREIGN\s+KEY/i);
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS game_automation_v3_audit/);
  assert.match(migrationSource, /idx_game_automation_v3_audit_game/);
  assert.match(migrationSource, /idx_game_automation_v3_audit_event/);

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(ddl);
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_automation_v3_audit'").get();
    assert.equal(table?.name, "game_automation_v3_audit");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_list(game_automation_v3_audit)").all(), []);
    const columns = database.prepare("PRAGMA table_info(game_automation_v3_audit)").all().map((row) => row.name);
    assert.ok(columns.includes("event_type"));
    assert.ok(columns.includes("data_status"));
    assert.ok(columns.includes("next_npb_identity_source"));
  } finally {
    database.close();
  }
});

test("formal planner no longer reads the diagnostic audit table", () => {
  assert.doesNotMatch(plannerSource, /game_automation_v3_audit/);
  assert.match(plannerSource, /getV3RosterStatusDecision\(\{ game, now: current, snapshot, jobs: rosterJobs \}\)/);
  assert.match(plannerSource, /sourceSnapshotComparison: null/);
});

test("manual game preview does not require the diagnostic audit table in core D1", () => {
  assert.doesNotMatch(previewSource, /"game_automation_v3_audit"/);
  assert.match(previewSource, /"game_automation_v3_state"/);
  assert.match(previewSource, /"game_jobs_v3"/);
});

test("schedule identity metadata writes audit records only through the separate database", () => {
  assert.match(identitySource, /auditDb = null/);
  assert.match(identitySource, /auditDb\.prepare\("PRAGMA table_info\(game_automation_v3_audit\)"/);
  assert.match(identitySource, /await updateStatement\.run\(\);/);
  assert.doesNotMatch(identitySource, /await db\.batch\(\[updateStatement, auditStatement\]\)/);
});

test("audit writes and diagnostic reads are routed through AUDIT_DB", () => {
  assert.match(workerSource, /function getV3AuditDb\(env\)/);
  assert.match(workerSource, /const auditDb = getV3AuditDb\(env\)/);
  assert.match(workerSource, /runtime_audit_skipped code=AUDIT_DB_UNAVAILABLE/);
  assert.match(workerSource, /stage=schedule_sync_audit status=skipped/);
  assert.match(workerSource, /const auditDb = getV3AuditDb\(env\);\s*if \(!auditDb\) return jsonResponse\(\{ ok: true/);
  assert.doesNotMatch(workerSource, /env\.AUTH_DB\.prepare\([\s\S]{0,220}game_automation_v3_audit/);
  assert.doesNotMatch(workerSource, /env\.AUTH_DB\.batch\([\s\S]{0,220}game_automation_v3_audit/);
});

test("audit failure is explicitly best effort and does not alter formal storage code paths", () => {
  const runtimeAudit = workerSource.slice(workerSource.indexOf("async function writeV3RuntimeAudit"), workerSource.indexOf("async function runScheduledGameAutomationV3"));
  const scheduleAudit = workerSource.slice(workerSource.indexOf("async function writeScheduleSyncAuditRecord"), workerSource.indexOf("async function runScheduledGameAutomationV3"));
  const adminAudit = workerSource.slice(workerSource.indexOf("async function recordV3AdminAudit"), workerSource.indexOf("function parseV3AuditDetails"));
  assert.match(runtimeAudit, /catch \(error\)/);
  assert.match(runtimeAudit, /return false;/);
  assert.match(scheduleAudit, /status=skipped/);
  assert.match(adminAudit, /if \(!db\) return false/);
  assert.match(adminAudit, /status=skipped/);
  assert.match(workerSource, /const maintenancePromise = runV3StorageMaintenance\(env\.AUTH_DB, getV3AuditDb\(env\), now\)/);
});

test("routine audit is suppressed while operational anomalies remain recordable", () => {
  assert.equal(shouldPersistV3Audit({ eventType: "V3_RUN_STARTED" }), false);
  assert.equal(shouldPersistV3Audit({ eventType: "job", job: { status: "completed" }, execution: { status: "completed" } }), false);
  assert.equal(shouldPersistV3Audit({ eventType: "schedule_sync", execution: { status: "success_no_change" } }), false);
  assert.equal(shouldPersistV3Audit({ eventType: "v3_job_created", job: { status: "pending" } }), true);
  assert.equal(shouldPersistV3Audit({ eventType: "job", job: { status: "retry_wait" } }), true);
  assert.equal(shouldPersistV3Audit({ eventType: "stale_executor", execution: { status: "completed" } }), true);
  assert.equal(shouldPersistV3Audit({ eventType: "V3_EXECUTION_SUMMARY", execution: { status: "completed", errorCode: "CANONICAL_MISMATCH" } }), true);
  assert.equal(shouldPersistV3Audit({ eventType: "job", failure: new Error("failed") }), true);
});
