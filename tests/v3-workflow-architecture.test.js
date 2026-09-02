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
  assert.deepEqual(v3.V3_COMPLETED_STATE_TRANSITIONS.map(({ jobType, from, to }) => [jobType, from, to]), [
    ["prediction_close", "scheduled", "prediction_closed"],
    ["lineup_finalize", "prediction_closed", "lineup_ready"],
    ["score", "lineup_ready", "scored"],
    ["ranking_rebuild", "scored", "ranked"],
    ["publish", "ranked", "published"]
  ]);
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
    "candidateExists", "canonicalDataReady", "due", "existingOpenJob", "existingTerminalJob",
    "finalizedLineupExists", "insertAttempted", "insertedJobId", "jobType", "lineupDataReady",
    "reasonCode", "scheduledSlotAt", "shouldRun"
  ].sort());
  assert.equal(decision.jobType, "roster_fetch");
  assert.equal(decision.due, true);
  assert.equal(decision.existingOpenJob.status, "pending");
  assert.equal(decision.insertedJobId, 7);
});

test("lineup_fetchのcompleted後にcandidateがなければ回復slotを再計画する", async () => {
  const database = new DatabaseSync(":memory:");
  const id = "33333333-3333-4333-8333-333333333333";
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_lineup_revisions (internal_game_id TEXT, version INTEGER, is_final INTEGER,
        actual_lineup_json TEXT);
      CREATE TABLE game_lineups (internal_game_id TEXT PRIMARY KEY, actual_lineup_json TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT,
        UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO games VALUES ('${id}', '2026-08-19', '2026-08-19T05:00:00.000Z',
        'fighters', 'hawks', 'f-h-19', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES ('${id}', 'prediction_closed', NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, 0, '2026-08-19T03:00:00.000Z', '2026-08-19T04:50:00.000Z');
      INSERT INTO game_jobs_v3 (id, internal_game_id, job_type, scheduled_at, scheduled_slot_at,
        status, attempt_count, max_attempts, completed_at, created_at, updated_at)
      VALUES (3861, '${id}', 'lineup_fetch', '2026-08-19T04:50:00.000Z', '2026-08-19T04:50:00.000Z',
        'completed', 1, 12, '2026-08-19T04:50:02.000Z', '2026-08-19T04:50:00.000Z', '2026-08-19T04:50:02.000Z');
    `);
    const db = {
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
    const result = await v3.planV3MainJobs(db, [{
      internalGameId: id,
      gameDate: "2026-08-19",
      startAt: "2026-08-19T05:00:00.000Z",
      homeTeam: "fighters",
      awayTeam: "hawks",
      npbGameCode: "f-h-19",
      npbIdentityStatus: "resolved",
      gameStatus: "scheduled",
      isActive: 1
    }], new Date("2026-08-19T04:50:00.000Z"));
    const entry = result.planned.find((item) => item.plan?.jobType === "lineup_fetch");
    assert.ok(entry);
    assert.equal(entry.reasonCode, "V3_LINEUP_RECOVERY_JOB_CREATED");
    assert.equal(entry.recoveryOfJobId, 3861);
    assert.equal(entry.diagnostic.completedWithoutCandidate, true);
    assert.equal(entry.plan.scheduledSlotAt.toISOString(), "2026-08-19T04:50:01.000Z");
    const recovery = database.prepare(
      "SELECT status FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'lineup_fetch' AND id <> 3861"
    ).get(id);
    assert.equal(recovery.status, "pending");
  } finally {
    database.close();
  }
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
      CREATE TABLE game_lineup_revisions (internal_game_id TEXT, version INTEGER, is_final INTEGER,
        actual_lineup_json TEXT);
      CREATE TABLE game_lineups (internal_game_id TEXT PRIMARY KEY, actual_lineup_json TEXT,
        scoring_status TEXT, scored_at TEXT, publication_status TEXT, published_at TEXT);
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
    const lineupCandidate = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      battingOrder: index + 1,
      position: "P",
      playerId: `player-${index + 1}`
    })));
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
      if (job.job_type === "roster_fetch") return { status: "retry_wait", failureCode: "HTTP_FETCH_FAILED" };
      if (job.job_type === "lineup_fetch") {
        database.prepare("INSERT INTO game_lineup_revisions VALUES (?1, 1, 0, ?2)").run(id, lineupCandidate);
        database.prepare("INSERT OR REPLACE INTO game_lineups (internal_game_id, actual_lineup_json, scoring_status, scored_at, publication_status, published_at) VALUES (?1, ?2, 'pending', NULL, 'private', NULL)").run(id, lineupCandidate);
      }
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

test("lineup_fetchはcandidate/canonical dataなしでcompletedにせず、admin診断へ渡す", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(worker, /getV3LineupDataHealth\(env\.AUTH_DB, internalGameId, stateBefore\)/);
  assert.match(worker, /LINEUP_FETCH_COMPLETED_WITHOUT_CANDIDATE/);
  assert.match(worker, /completedWithoutCandidate/);
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
  assert.match(executor, /V3_JOB_COMPLETION_CONFLICT/);
  assert.match(executor, /reconcileCompletedV3StateTransitions/);
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

test("planner failure is isolated so the due-job claim phase remains reachable", () => {
  const executor = fs.readFileSync(path.join(root, "backend/automation-v3/executor.js"), "utf8");
  assert.match(executor, /async function runV3PlannerPhase\([\s\S]*?catch \(error\) \{[\s\S]*?emptyV3PlannerPhaseResult\(error/);
  assert.match(executor, /const auxiliary = await runV3PlannerPhase\(/);
  assert.match(executor, /const mainPlan = await runV3PlannerPhase\(/);
  const mainPlanIndex = executor.indexOf("const mainPlan = await runV3PlannerPhase(");
  const claimIndex = executor.indexOf("const claimReport = await claimDueJobs(");
  const runFinishedIndex = executor.indexOf('stage: "run_finished"', claimIndex);
  const optionalScheduleIndex = executor.indexOf("scheduleOptional(optionalPromise)", runFinishedIndex);
  assert.ok(mainPlanIndex >= 0 && claimIndex > mainPlanIndex && runFinishedIndex > claimIndex && optionalScheduleIndex > runFinishedIndex, "formal plan and claim must complete before optional work");
  assert.doesNotMatch(executor, /runV3PhaseWithTimeout/);
  assert.doesNotMatch(executor, /Promise\.race/);
  assert.doesNotMatch(executor.slice(executor.indexOf("async function runV3PlannerPhase"), executor.indexOf("function hasVerifiedLineupPayload")), /Promise\.race/);
  assert.match(executor, /scheduleOptional/);
  assert.match(executor, /observerScheduler/);
  assert.match(executor, /reconciliation_started/);
  assert.match(executor, /formal_plan_started/);
  assert.match(executor, /formal_due_plan_summary/);
  assert.match(executor, /formal_plan_error/);
  assert.match(executor, /auxiliary_plan_finished/);
  assert.match(executor, /stage: "run_finished"/);
});

test("formal plan summaryはclaim前に記録され、schedule syncはcritical path後へ分離される", () => {
  const executor = fs.readFileSync(path.join(root, "backend/automation-v3/executor.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const formalFinished = executor.indexOf('stage: "formal_plan_finished"');
  const formalSummary = executor.indexOf('stage: "formal_due_plan_summary"');
  const claimStarted = executor.indexOf('stage: "claim_phase_started"');
  assert.ok(formalFinished >= 0 && formalSummary > formalFinished && claimStarted > formalSummary);
  const criticalFinished = worker.indexOf('eventType: "CRON_CRITICAL_PATH_FINISHED"');
  const scheduleSync = worker.indexOf("const scheduleSyncPromise = runScheduleSync()");
  assert.ok(criticalFinished >= 0 && scheduleSync > criticalFinished);
  assert.match(worker, /formal_plan_error: "V3_FORMAL_PLAN_ERROR"/);
  assert.match(worker, /scheduleOptional\(scheduleSyncPromise\)/);
  assert.match(worker, /writeCriticalPathFinished: writeCronCriticalPathFinished/);
});

test("eligible後のformal entry checkpointは重いstate準備より先に記録される", () => {
  const executor = fs.readFileSync(path.join(root, "backend/automation-v3/executor.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const eligible = executor.indexOf('stage: "eligible_games"');
  const postEligible = executor.indexOf('stage: "post_eligible_started"');
  const formalStarted = executor.indexOf('stage: "formal_plan_started"');
  const inputStarted = executor.indexOf('stage: "formal_plan_input_started"');
  const plannerCall = executor.indexOf("const mainPlan = await runV3PlannerPhase(");
  assert.ok(eligible >= 0 && postEligible > eligible && formalStarted > postEligible);
  assert.ok(inputStarted > formalStarted && plannerCall > inputStarted);
  assert.doesNotMatch(executor.slice(eligible, formalStarted), /ensureV3State|transitionV3State/);
  assert.match(worker, /post_eligible_started: "V3_POST_ELIGIBLE_PHASE_STARTED"/);
  assert.match(worker, /formal_plan_input_started: "V3_FORMAL_PLAN_INPUT_STARTED"/);
  assert.match(worker, /formal_plan_input_finished: "V3_FORMAL_PLAN_INPUT_FINISHED"/);
  assert.match(worker, /formal_plan_input_error: "V3_FORMAL_PLAN_INPUT_ERROR"/);
});

test("formal planner失敗でもentry visibilityを保ちclaim phaseとrun finishedへ進む", async () => {
  const database = new DatabaseSync(":memory:");
  const id = "55555555-5555-4555-8555-555555555555";
  let optionalPromise = null;
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (
        internal_game_id TEXT PRIMARY KEY, state TEXT, prediction_closed_at TEXT,
        lineup_finalized_at TEXT, scoring_revision_id TEXT, ranked_at TEXT,
        published_at TEXT, excluded_at TEXT, failure_code TEXT, failure_message TEXT,
        version INTEGER, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT,
        scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT,
        UNIQUE(internal_game_id, job_type, scheduled_slot_at)
      );
      INSERT INTO games VALUES ('${id}', '2026-09-02', '2026-09-02T09:00:00.000Z',
        'fighters', 'hawks', 'f-h-22', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES ('${id}', 'scheduled', NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, NULL, 0, '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z');
    `);
    const phases = [];
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const result = await v3.runGameAutomationV3(env, new Date("2026-09-02T05:32:00.000Z"), {
      formalPlanner: async () => {
        throw Object.assign(new Error("input hydration failed"), { code: "V3_FORMAL_PLAN_INPUT_FAILED" });
      },
      auxiliaryPlanner: async () => ({
        created: 0,
        planned: [],
        errors: [],
        probablePlan: { created: 0, planned: [], errors: [] },
        rosterPlan: { created: 0, planned: [], errors: [] },
        identityPlan: { created: 0, planned: [], errors: [] }
      }),
      scheduleOptional: (promise) => { optionalPromise = promise; },
      onPhase: (phase) => phases.push(phase),
      executeJob: async () => ({ status: "completed" })
    });
    await optionalPromise;
    assert.equal(result.mainPlan.phaseStatus, "failed");
    const stages = phases.map((phase) => phase.stage);
    assert.ok(stages.indexOf("eligible_games") < stages.indexOf("post_eligible_started"));
    assert.ok(stages.indexOf("formal_plan_started") < stages.indexOf("formal_plan_input_started"));
    assert.ok(stages.includes("formal_plan_input_error"));
    assert.ok(stages.includes("formal_plan_error"));
    assert.ok(stages.includes("claim_phase_started"));
    assert.ok(stages.includes("claim_execution_completed"));
    assert.ok(stages.includes("run_finished"));
    assert.equal(phases.find((phase) => phase.stage === "formal_plan_input_started")?.eligibleGameCount, 1);
    assert.equal(phases.find((phase) => phase.stage === "formal_plan_input_finished")?.failedGameCount, 1);
  } finally {
    database.close();
  }
});
