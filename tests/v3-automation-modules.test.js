import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")).href);

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async (...args) => ({ results: statement.all(...args) }),
        first: async (...args) => statement.get(...args),
        run: async (...args) => ({ meta: { changes: Number(statement.run(...args).changes || 0) } }),
        bind(...args) {
          return {
            all: async () => ({ results: statement.all(...args) }),
            first: async () => statement.get(...args),
            run: async () => ({ meta: { changes: Number(statement.run(...args).changes || 0) } })
          };
        }
      };
    }
  };
}

test("V3 facade keeps the public automation contracts while implementation is modular", () => {
  for (const name of [
    "runGameAutomationV3",
    "planAuxiliaryJobs",
    "planMainWorkflowJobs",
    "claimDueJobs",
    "executeClaimedJobs",
    "listV3Games",
    "createV3Job",
    "deriveV3DisplaySchedule"
  ]) {
    assert.equal(typeof v3[name], "function", `${name} must remain available from the compatibility facade`);
  }
  const modules = ["constants", "domain", "planner", "probable-starter-planner", "repository", "roster-repository", "orchestrator", "executor", "audit", "diagnostics"];
  for (const name of modules) {
    assert.ok(fs.existsSync(path.join(root, `backend/automation-v3/${name}.js`)), `${name} module must exist`);
  }
});

test("V3 audit builders preserve structured data without performing D1 writes", () => {
  const record = v3.buildV3CronJobAuditInsert({
    auditColumns: new Set(["event_type", "data_status"]),
    runId: "run-1",
    correlationId: "run-1",
    job: {
      id: 42,
      internal_game_id: "8cd8869c-6ae5-47a5-8792-5bc89d20ef18",
      job_type: "roster_fetch",
      scheduled_slot_at: "2026-08-11T03:00:00.000Z",
      status: "completed",
      attempt_count: 1
    },
    execution: { stage: "executor_completed", dataStatus: "fresh" },
    occurredAt: new Date("2026-08-11T03:00:01.000Z")
  });

  assert.deepEqual(record.columns.slice(0, 2), ["event_type", "internal_game_id"]);
  assert.equal(record.values[0], "job");
  assert.equal(record.values[1], "8cd8869c-6ae5-47a5-8792-5bc89d20ef18");
  assert.equal(record.structuredDetails.stage, "executor_completed");
  assert.match(String(record.values.find((value) => typeof value === "string" && value.includes("v3_details="))), /run-1/);
});

test("V3 Cron diagnostics aggregate planner, claim, executor, and schedule-sync outcomes", () => {
  const summary = v3.buildV3CronSummary({
    runId: "run-2",
    correlationId: "run-2",
    startedAt: "2026-08-11T03:00:00.000Z",
    completedAt: "2026-08-11T03:00:03.000Z",
    result: {
      gameCount: 1,
      created: 1,
      failed: 0,
      probablePlan: { planned: [{ plan: { jobType: "probable_starter_fetch" }, created: true }] },
      rosterPlan: { planned: [{ plan: { jobType: "roster_fetch" }, created: false }] },
      identityPlan: { planned: [] },
      mainPlan: { planned: [] },
      claimReport: { due: [{}], claimed: [{ claimResult: "claimed" }] },
      processed: 1,
      stateReconciliation: {
        recovered: 1,
        failed: 0,
        recoveredByJobType: { prediction_close: 1 },
        skipped: []
      }
    },
    scheduleSync: { status: "skipped", futureGamesBefore: 3, futureGamesAfter: 3, gamesFetched: 0, gamesInserted: 0, gamesUpdated: 0 }
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.counts.planned, 2);
  assert.equal(summary.counts.claimed, 1);
  assert.equal(summary.counts.hasMoreDue, false);
  assert.equal(summary.stateReconciliation.recovered, 1);
  assert.deepEqual(summary.stateReconciliation.recoveredByJobType, { prediction_close: 1 });
  assert.deepEqual(summary.createdByJobType, { probable_starter_fetch: 1 });
  assert.equal(summary.scheduleSync.futureGamesAfter, 3);
});

test("due-job query includes pending and ready retry jobs but excludes future retries", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        next_retry_at TEXT,
        lease_expires_at TEXT
      );
      INSERT INTO game_jobs_v3 VALUES
        (1, 'score', 'pending', '2026-08-25T07:56:00.000Z', NULL, NULL),
        (2, 'prediction_close', 'retry_wait', '2026-08-25T07:55:00.000Z', '2026-08-25T07:57:00.000Z', NULL),
        (3, 'publish', 'retry_wait', '2026-08-25T07:55:00.000Z', '2026-08-25T08:01:00.000Z', NULL);
    `);
    const db = {
      prepare(sql) {
        const statement = database.prepare(sql);
        return {
          bind(...params) {
            return { all: async () => ({ results: statement.all(...params) }) };
          }
        };
      }
    };
    const due = await v3.listDueV3Jobs(db, new Date("2026-08-25T08:00:00.000Z"));
    assert.deepEqual(due.map((job) => job.id), [2, 1]);
  } finally {
    database.close();
  }
});

test("共有planning engineは別gameまたはIDなしjobを対象gameの既存jobとして扱わない", () => {
  const game = {
    internalGameId: "8cd8869c-6ae5-47a5-8792-5bc89d20ef18",
    gameDate: "2026-08-30",
    startAt: "2026-08-30T09:00:00.000Z",
    homeTeam: "fighters",
    awayTeam: "marines",
    gameStatus: "scheduled",
    isActive: 1
  };
  const jobs = [
    { internal_game_id: "other-game", job_type: "roster_fetch", status: "completed" },
    { job_type: "roster_fetch", status: "completed" }
  ];
  const state = v3.buildV3PlanningState({
    game,
    persistedState: "probable_starter_ready",
    jobs,
    now: new Date("2026-08-30T07:01:00.000Z")
  });
  assert.equal(state.effectiveState, "probable_starter_ready");
  const plan = v3.buildStagePlan(state, "roster_fetch");
  assert.equal(plan.existingJob, null);
  assert.equal(plan.shouldCreateJob, true);
});

test("due-job claimは50/100件制限で後続gameをstarveさせず、複数batchをdrainする", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, job_type TEXT,
        scheduled_at TEXT NOT NULL, scheduled_slot_at TEXT NOT NULL, status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL, max_attempts INTEGER NOT NULL, next_retry_at TEXT,
        claimed_at TEXT, claim_token TEXT, lease_expires_at TEXT, completed_at TEXT,
        failure_code TEXT, failure_message TEXT, created_at TEXT, updated_at TEXT
      );
    `);
    const insert = database.prepare(`
      INSERT INTO game_jobs_v3
        (id, internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
         attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, ?, 'prediction_close', '2026-08-30T07:00:00.000Z', '2026-08-30T07:00:00.000Z', 'pending', 0, 12, '2026-08-30T06:00:00.000Z', '2026-08-30T06:00:00.000Z')
    `);
    for (let id = 1; id <= 101; id += 1) insert.run(id, `game-${id}`);
    const report = await v3.claimDueJobs(d1(database), new Date("2026-08-30T08:00:00.000Z"));
    assert.equal(report.due.length, 101);
    assert.equal(report.claimed.filter((entry) => entry.claimed).length, 101);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE status = 'claimed'").get().count, 101);
  } finally {
    database.close();
  }
});

test("due-job claimは200件でbounded化し、残件を次回Cronへ継続する", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, job_type TEXT,
        scheduled_at TEXT NOT NULL, scheduled_slot_at TEXT NOT NULL, status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL, max_attempts INTEGER NOT NULL, next_retry_at TEXT,
        claimed_at TEXT, claim_token TEXT, lease_expires_at TEXT, completed_at TEXT,
        failure_code TEXT, failure_message TEXT, created_at TEXT, updated_at TEXT
      );
    `);
    const insert = database.prepare(`
      INSERT INTO game_jobs_v3
        (id, internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
         attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, ?, 'score', '2026-08-30T07:00:00.000Z', '2026-08-30T07:00:00.000Z', 'pending', 0, 12,
              '2026-08-30T06:00:00.000Z', '2026-08-30T06:00:00.000Z')
    `);
    for (let id = 1; id <= 250; id += 1) insert.run(id, `game-${id}`);

    const report = await v3.claimDueJobs(d1(database), new Date("2026-08-30T08:00:00.000Z"));
    assert.equal(report.due.length, 200);
    assert.equal(report.claimed.filter((entry) => entry.claimed).length, 200);
    assert.equal(report.hasMoreDue, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE status = 'pending'").get().count, 50);
  } finally {
    database.close();
  }
});

test("V3 Cron diagnostics classify every known job type and preserve unclassified history", () => {
  for (const jobType of [
    ...v3.V3_JOB_TYPES,
    "schedule_sync",
    "expired_scoring_recovery",
    "service_unavailable",
    "terminal_recovery"
  ]) {
    assert.equal(v3.normalizeV3DiagnosticJobType({ plan: { jobType } }), jobType);
  }

  assert.equal(
    v3.normalizeV3DiagnosticJobType({ plan: { jobType: "unknown" } }),
    "legacy_or_unclassified"
  );
  assert.equal(
    v3.normalizeV3DiagnosticJobType({ job: { job_type: "plan" } }),
    "legacy_or_unclassified"
  );
  assert.equal(
    v3.normalizeV3DiagnosticJobType({ job: { job_type: "cron_run" } }),
    "cron_run"
  );

  const summary = v3.buildV3CronSummary({
    startedAt: "2026-08-12T01:00:00.000Z",
    result: {
      probablePlan: { planned: [] },
      rosterPlan: { planned: [{ plan: null, created: false }] },
      identityPlan: { planned: [] },
      mainPlan: { planned: [{ plan: { jobType: "score" }, created: false }] }
    }
  });

  assert.deepEqual(summary.plannedByJobType, { roster_fetch: 1, score: 1 });
  assert.equal(summary.plannedByJobType.unknown, undefined);
});

test("V3 audit fallback uses an explicit unclassified label without inventing a job type", () => {
  const record = v3.buildV3CronJobAuditInsert({
    auditColumns: new Set(["event_type"]),
    execution: { plannerDecision: { jobType: "roster_fetch" } }
  });
  assert.equal(record.structuredDetails.jobType, "roster_fetch");
  assert.equal(record.values[3], "roster_fetch");

  const legacyRecord = v3.buildV3CronJobAuditInsert({ auditColumns: new Set(["event_type"]) });
  assert.equal(legacyRecord.structuredDetails.jobType, "legacy_or_unclassified");
  assert.equal(legacyRecord.values[3], "legacy_or_unclassified");
});

test("V3 roster audit keeps a compact comparison summary before the truncated details", () => {
  const record = v3.buildV3CronJobAuditInsert({
    job: { internal_game_id: "8cd8869c-6ae5-47a5-8792-5bc89d20ef18", job_type: "roster_fetch", status: "completed" },
    execution: {
      status: "captured",
      reasonCode: "ROSTER_NO_CHANGES",
      sourceSnapshotComparison: { status: "OK", mismatch: false, remainingMismatch: false, stale: false },
      largeDetail: "x".repeat(12000)
    }
  });
  const failureMessage = record.values[record.columns.indexOf("failure_message")];

  assert.equal(failureMessage.length, 8000);
  assert.match(failureMessage, /\[v3_summary=\{"schemaVersion":1,"jobType":"roster_fetch"/);
  assert.match(failureMessage, /"sourceSnapshotComparison":\{"status":"OK","mismatch":false,"remainingMismatch":false,"stale":false/);
});

test("V3 automation modules have no V1/V2 runtime import", () => {
  const sources = fs.readdirSync(path.join(root, "backend/automation-v3"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => fs.readFileSync(path.join(root, "backend/automation-v3", file), "utf8"))
    .join("\n");
  assert.doesNotMatch(sources, /game-automation-v2|game-workflow-jobs|pregame-automation/);
});
