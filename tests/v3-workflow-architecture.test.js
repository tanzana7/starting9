import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));

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

test("V3 architecture has one state, lifecycle, type, and transition contract", () => {
  assert.deepEqual(v3.V3_STATES, [
    "scheduled", "prediction_closed", "lineup_ready", "scored", "ranked", "published",
    "excluded", "failed", "manual_action_required"
  ]);
  assert.deepEqual(v3.V3_OPEN_JOB_STATUSES, ["pending", "claimed", "retry_wait"]);
  assert.deepEqual(v3.V3_TERMINAL_JOB_STATUSES, ["completed", "failed", "cancelled"]);
  assert.equal(v3.isV3OpenJobStatus("completed"), false);
  assert.equal(v3.isV3TerminalJobStatus("cancelled"), true);
  assert.equal(v3.getV3TransitionDefinition("scheduled", "prediction_closed").triggeringJob, "prediction_close");
  assert.equal(v3.getV3TransitionDefinition("ranked", "published").prerequisite, "reflected ranking and publication time");
  assert.equal(v3.getV3TransitionDefinition("scheduled", "ranked"), null);
});

test("全job typeが補助/主系レジストリへ登録されている", () => {
  assert.equal(new Set(v3.V3_JOB_TYPES).size, v3.V3_JOB_TYPES.length);
  for (const jobType of v3.V3_JOB_TYPES) {
    const definition = v3.getV3JobDefinition(jobType);
    assert.ok(definition, jobType);
    assert.ok(definition.label, jobType);
    assert.ok(["auxiliary", "main", "main_polling"].includes(definition.kind), jobType);
    assert.equal(typeof v3.V3_JOB_PLANNERS[jobType], "function", `planner: ${jobType}`);
  }
  assert.deepEqual(v3.V3_AUXILIARY_JOB_TYPES, ["probable_starter_fetch", "roster_fetch", "npb_identity_resolve"]);
  assert.deepEqual(v3.V3_MAIN_JOB_TYPES, ["prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]);
});

test("planner decisionは表示予定と実在jobを分離した契約を返す", () => {
  const decision = v3.normalizeV3PlannerDecision({
    plan: { jobType: "roster_fetch", scheduledSlotAt: new Date("2026-08-08T07:00:00.000Z") },
    created: true,
    job: { id: 7, status: "pending", scheduled_slot_at: "2026-08-08T07:00:00.000Z" },
    diagnostic: { insertAttempted: true }
  }, new Date("2026-08-08T07:01:00.000Z"));
  assert.deepEqual(Object.keys(decision).sort(), [
    "canonicalDataReady", "due", "existingOpenJob", "existingTerminalJob", "insertAttempted",
    "insertedJobId", "jobType", "reasonCode", "scheduledSlotAt", "shouldRun"
  ].sort());
  assert.equal(decision.jobType, "roster_fetch");
  assert.equal(decision.due, true);
  assert.equal(decision.existingOpenJob.status, "pending");
  assert.equal(decision.insertedJobId, 7);
});

test("V3 runnerの補助job失敗はmain plannerを停止せず、仮想試合をpublishedまで進める", async () => {
  const database = new DatabaseSync(":memory:");
  const id = "11111111-1111-4111-8111-111111111111";
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO games VALUES ('${id}', '2026-08-08', '2026-08-08T09:00:00.000Z',
        'hawks', 'fighters', 'h-f-18', 'resolved', 'scheduled', 1, NULL);
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const executed = [];
    const stateAfter = {
      prediction_close: ["scheduled", "prediction_closed"],
      lineup_finalize: ["prediction_closed", "lineup_ready"],
      score: ["lineup_ready", "scored"],
      ranking_rebuild: ["scored", "ranked"],
      publish: ["ranked", "published"]
    };
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
      if (job.job_type === "roster_fetch") return { status: "retry_wait", failureCode: "HTTP_FETCH_FAILED" };
      const transition = stateAfter[job.job_type];
      return transition
        ? { status: "completed", stateBefore: transition[0], stateAfter: transition[1] }
        : { status: "completed", stateBefore: "scheduled", stateAfter: "scheduled" };
    };
    const runAt = async (value) => v3.runGameAutomationV3(env, new Date(value), { executeJob });
    await runAt("2026-08-07T09:00:00.000Z");
    await runAt("2026-08-08T07:00:00.000Z");
    await runAt("2026-08-08T08:00:00.000Z");
    await runAt("2026-08-08T08:10:00.000Z");
    await runAt("2026-08-08T09:02:00.000Z");
    await runAt("2026-08-08T09:03:00.000Z");
    await runAt("2026-08-08T09:10:00.000Z");
    await runAt("2026-08-08T09:11:00.000Z");
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(id).state, "published");
    assert.ok(executed.includes("roster_fetch"));
    assert.ok(executed.includes("prediction_close"));
    assert.ok(executed.includes("publish"));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'publish'").get(id).count, 1);
  } finally {
    database.close();
  }
});

test("V3 runtime source has explicit phases and no V2 module dependency", () => {
  const runtime = fs.readFileSync(path.join(root, "game-automation-v3.js"), "utf8");
  const orchestrator = fs.readFileSync(path.join(root, "backend/automation-v3/orchestrator.js"), "utf8");
  const executor = fs.readFileSync(path.join(root, "backend/automation-v3/executor.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
  for (const name of ["planAuxiliaryJobs", "planMainWorkflowJobs", "claimDueJobs"]) {
    assert.match(orchestrator, new RegExp(`export async function ${name}`));
  }
  assert.match(executor, /export async function executeClaimedJobs/);
  assert.match(runtime, /export \* from "\.\/backend\/automation-v3\/orchestrator\.js"/);
  assert.match(runtime, /export \* from "\.\/backend\/automation-v3\/executor\.js"/);
  assert.match(worker, /V3_JOB_EXECUTORS/);
  assert.match(worker, /MISSING_EXECUTOR/);
  for (const jobType of v3.V3_JOB_TYPES) {
    assert.match(worker, new RegExp(jobType));
    assert.match(admin, new RegExp(jobType));
  }
  assert.doesNotMatch(runtime, /game-automation-v2/);
});
