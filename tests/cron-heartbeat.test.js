import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildCronHeartbeatReadModel,
  deriveCronHeartbeatStatus,
  getCronHeartbeat,
  recordCronCompleted,
  recordCronFailed,
  recordCronInvocation
} from "../backend/repositories/cron-heartbeat-repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(path.join(root, "migrations", "0045_cron_heartbeat.sql"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...params) {
          return {
            first() {
              return statement.get(...params);
            },
            run() {
              return statement.run(...params);
            }
          };
        }
      };
    }
  };
}

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  return { database, db: d1(database) };
}

test("0045 creates an additive singleton heartbeat table", () => {
  const { database } = createDatabase();
  database.exec(migration);
  assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cron_heartbeat'").get());
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM cron_heartbeat").get().count, 0);
  assert.throws(() => database.prepare("INSERT INTO cron_heartbeat (id, updated_at) VALUES (2, '2026-09-30T00:00:00.000Z')").run(), /CHECK constraint failed/);
});

test("invocation and completion use one row and an idle Cron is healthy", async () => {
  const { database, db } = createDatabase();
  await recordCronInvocation(db, new Date("2026-09-30T00:00:00.000Z"));
  await recordCronCompleted(db, new Date("2026-09-30T00:00:01.000Z"));
  await recordCronInvocation(db, new Date("2026-09-30T00:01:00.000Z"));
  await recordCronCompleted(db, new Date("2026-09-30T00:01:01.000Z"));
  const heartbeat = await getCronHeartbeat(db);
  const readModel = buildCronHeartbeatReadModel(heartbeat, { now: new Date("2026-09-30T00:01:30.000Z") });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM cron_heartbeat").get().count, 1);
  assert.equal(readModel.lastInvocationAt, "2026-09-30T00:01:00.000Z");
  assert.equal(readModel.lastCompletedAt, "2026-09-30T00:01:01.000Z");
  assert.equal(readModel.lastOutcome, "completed");
  assert.equal(readModel.status, "healthy");
  assert.equal(readModel.nextInvocationAt, "2026-09-30T00:02:00.000Z");
});

test("failure is visible until a later successful completion", async () => {
  const { db } = createDatabase();
  await recordCronInvocation(db, new Date("2026-09-30T00:00:00.000Z"));
  await recordCronFailed(db, new Date("2026-09-30T00:00:02.000Z"));
  let heartbeat = await getCronHeartbeat(db);
  assert.equal(deriveCronHeartbeatStatus(heartbeat, { now: new Date("2026-09-30T00:01:00.000Z") }), "failed_recently");
  await recordCronInvocation(db, new Date("2026-09-30T00:02:00.000Z"));
  await recordCronCompleted(db, new Date("2026-09-30T00:02:02.000Z"));
  heartbeat = await getCronHeartbeat(db);
  assert.equal(heartbeat.lastOutcome, "completed");
  assert.equal(deriveCronHeartbeatStatus(heartbeat, { now: new Date("2026-09-30T00:03:00.000Z") }), "healthy");
});

test("fresh invocation is healthy even when the meaningful audit is old or absent", () => {
  const readModel = buildCronHeartbeatReadModel({
    lastInvocationAt: "2026-09-30T00:00:00.000Z",
    lastCompletedAt: "2026-09-30T00:00:01.000Z",
    lastFailedAt: null,
    lastOutcome: "completed"
  }, { now: new Date("2026-09-30T00:04:00.000Z"), graceMinutes: 5 });
  assert.equal(readModel.status, "healthy");
});

test("heartbeat absence is never_seen and stale threshold is bounded", () => {
  assert.equal(deriveCronHeartbeatStatus(null, { now: new Date("2026-09-30T00:00:00.000Z") }), "never_seen");
  assert.equal(deriveCronHeartbeatStatus({ lastInvocationAt: "2026-09-30T00:00:00.000Z" }, { now: new Date("2026-09-30T00:05:00.000Z"), graceMinutes: 5 }), "healthy");
  assert.equal(deriveCronHeartbeatStatus({ lastInvocationAt: "2026-09-30T00:00:00.000Z" }, { now: new Date("2026-09-30T00:05:01.000Z"), graceMinutes: 5 }), "stale");
});

test("heartbeat writes are fail-open and formal execution remains separately scheduled", () => {
  assert.match(worker, /ctx\.waitUntil\(writeCronHeartbeatSafely\(env, recordCronInvocation/);
  assert.match(worker, /recordCronCompleted/);
  assert.match(worker, /recordCronFailed/);
  assert.match(worker, /formalRun\.then\(/);
  assert.match(worker, /cron_heartbeat status=skipped/);
  assert.match(worker, /const V3_CRON_GRACE_MINUTES = 5/);
});

test("normal completion remains excluded from the audit history", () => {
  assert.match(worker, /shouldPersistV3Audit\(/);
  assert.match(worker, /CRON_HANDLER_FINISHED/);
  assert.match(worker, /return !ROUTINE_V3_AUDIT_EVENT_TYPES\.has/);
  assert.doesNotMatch(worker, /INSERT INTO game_automation_v3_audit[\s\S]{0,200}CRON_HANDLER_FINISHED/);
});
