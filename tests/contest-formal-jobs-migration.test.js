import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { claimV3Job, createV3Job, ensureV3State, retryV3Job, transitionV3State } from "../backend/automation-v3/repository.js";
import { claimDueJobs } from "../backend/automation-v3/orchestrator.js";
import { executeGameAutomationV3Job } from "../auth-worker.js";
import teamContext from "../frontend/shared/team-context.js";
import { createContestId } from "../backend/contest-identity.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(ROOT, "migrations");
const AUDIT_MIGRATIONS = path.join(ROOT, "migrations-audit");
const GAME_ID = "20000000-0000-4000-8000-000000000001";
const CONTEST_F = createContestId(GAME_ID, "fighters");
const CONTEST_M = createContestId(GAME_ID, "marines");
const NOW = "2026-10-21T10:00:00.000Z";

function applyThrough(db, last = "9999") {
  for (const file of fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql") && name <= last).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
  }
}

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        first: async () => statement.get(),
        all: async () => ({ results: statement.all() }),
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }),
        bind: (...values) => ({
          first: async () => statement.get(...values),
          all: async () => ({ results: statement.all(...values) }),
          run: async () => ({ meta: { changes: Number(statement.run(...values).changes || 0) } })
        })
      };
    }
  };
}

function seedGameAndContests(db, both = true) {
  db.prepare(`INSERT INTO games(internal_game_id,game_date,start_time,home_team,away_team,game_status,created_at,updated_at)
    VALUES(?,'2026-10-21','2026-10-21T18:00:00Z','fighters','marines','scheduled',?,?)`).run(GAME_ID, NOW, NOW);
  db.prepare("INSERT INTO game_contests(contest_id,internal_game_id,target_team_key,created_at) VALUES(?,?,'fighters',?)")
    .run(CONTEST_F, GAME_ID, NOW);
  if (both) db.prepare("INSERT INTO game_contests(contest_id,internal_game_id,target_team_key,created_at) VALUES(?,?,'marines',?)")
    .run(CONTEST_M, GAME_ID, NOW);
}

test("0049 admits same-game same-slot jobs per contest and rejects duplicates only within that contest", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyThrough(database);
    seedGameAndContests(database);
    const db = d1(database);
    const slot = new Date(NOW);
    const fighters = await createV3Job(db, { internalGameId: GAME_ID, contestId: CONTEST_F, jobType: "prediction_close", scheduledSlotAt: slot });
    const marines = await createV3Job(db, { internalGameId: GAME_ID, contestId: CONTEST_M, jobType: "prediction_close", scheduledSlotAt: slot });
    const duplicate = await createV3Job(db, { internalGameId: GAME_ID, contestId: CONTEST_F, jobType: "prediction_close", scheduledSlotAt: slot });
    assert.equal(fighters.created, true);
    assert.equal(marines.created, true);
    assert.notEqual(fighters.job.id, marines.job.id);
    assert.equal(duplicate.created, false);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM game_jobs_v3 WHERE job_type='prediction_close'").get().n, 2);
    const indexes = database.prepare("PRAGMA index_list(game_jobs_v3)").all()
      .filter((index) => !String(index.name).startsWith("sqlite_autoindex"))
      .map((index) => ({
        name: index.name,
        unique: Number(index.unique),
        partial: Number(index.partial),
        columns: database.prepare(`PRAGMA index_info(${index.name})`).all().map((column) => column.name)
      }));
    assert.ok(indexes.some((index) => index.unique === 1 && index.partial === 1
      && index.columns.join(",") === "contest_id,job_type,scheduled_slot_at"));
    assert.ok(indexes.some((index) => index.unique === 1 && index.partial === 1
      && index.columns.join(",") === "internal_game_id,job_type,scheduled_slot_at"));
    const duplicateDefinitions = indexes.map((index) => `${index.unique}:${index.partial}:${index.columns.join(",")}`);
    assert.equal(new Set(duplicateDefinitions).size, duplicateDefinitions.length, "migration must not add duplicate index definitions");

    const claimedMarines = await claimV3Job(db, { jobId: marines.job.id, now: slot });
    assert.equal(claimedMarines.contest_id, CONTEST_M);
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE id=?").get(fighters.job.id).status, "pending");
    const retry = await retryV3Job(db, {
      jobId: claimedMarines.id, claimToken: claimedMarines.claim_token,
      attemptCount: claimedMarines.attempt_count, maxAttempts: claimedMarines.max_attempts,
      now: slot, retryAt: new Date(slot.getTime() + 60_000), errorCode: "TEST_RETRY", errorMessage: "isolated"
    });
    assert.deepEqual(retry, { updated: true, status: "retry_wait" });
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE id=?").get(fighters.job.id).status, "pending");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { database.close(); }
});

test("audit migration adds nullable contest identity while preserving physical-game audit writes", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const file of fs.readdirSync(AUDIT_MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()) {
      database.exec(fs.readFileSync(path.join(AUDIT_MIGRATIONS, file), "utf8"));
    }
    database.prepare(`INSERT INTO game_automation_v3_audit
      (internal_game_id,job_type,occurred_at,contest_id) VALUES(?,'probable_starter_fetch',?,NULL)`)
      .run(GAME_ID, NOW);
    database.prepare(`INSERT INTO game_automation_v3_audit
      (internal_game_id,job_type,occurred_at,contest_id) VALUES(?,'score',?,?)`)
      .run(GAME_ID, NOW, CONTEST_M);
    assert.deepEqual(database.prepare("SELECT job_type,contest_id FROM game_automation_v3_audit ORDER BY id").all().map((row) => ({ ...row })), [
      { job_type: "probable_starter_fetch", contest_id: null },
      { job_type: "score", contest_id: CONTEST_M }
    ]);
    assert.deepEqual(database.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check), ["ok"]);
  } finally { database.close(); }
});

test("bounded due claim filters formal work to the selected target team", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyThrough(database);
    seedGameAndContests(database);
    const db = d1(database);
    const slot = new Date("2026-10-21T09:00:00.000Z");
    const fighters = await createV3Job(db, { internalGameId: GAME_ID, contestId: CONTEST_F, jobType: "prediction_close", scheduledSlotAt: slot });
    const marines = await createV3Job(db, { internalGameId: GAME_ID, contestId: CONTEST_M, jobType: "prediction_close", scheduledSlotAt: slot });
    const report = await claimDueJobs(db, new Date(NOW), [], { targetTeamKey: "marines" });
    assert.equal(report.claimed.length, 1);
    assert.equal(report.claimed[0].claimed.contest_id, CONTEST_M);
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE id=?").get(fighters.job.id).status, "pending");
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE id=?").get(marines.job.id).status, "claimed");
  } finally { database.close(); }
});

test("formal prediction-close executor locks only the claimed contest's shared-user prediction", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyThrough(database);
    seedGameAndContests(database);
    database.prepare(`INSERT INTO users
      (id,username,username_normalized,password_hash,password_salt,password_iterations,status,role,created_at,updated_at)
      VALUES('shared-user','shared','shared','h','s',1,'active','user',?,?)`).run(NOW,NOW);
    database.prepare(`INSERT INTO predictions
      (id,user_id,game_id,internal_game_id,contest_id,prediction_json,schema_version,game_date,home_team,away_team,
       opponent_code,is_home,submitted_at,updated_at,status,is_test_prediction,scoring_status)
      VALUES('prediction-f','shared-user',?1,?1,?2,'{}',1,'2026-10-21','fighters','marines','marines',1,?3,?3,'submitted',0,'pending'),
            ('prediction-m','shared-user',?1,?1,?4,'{}',1,'2026-10-21','fighters','marines','fighters',0,?5,?5,'submitted',0,'pending')`)
      .run(GAME_ID,CONTEST_F,NOW,CONTEST_M,NOW);
    const db = d1(database);
    await ensureV3State(db, GAME_ID, new Date(NOW), CONTEST_F);
    await ensureV3State(db, GAME_ID, new Date(NOW), CONTEST_M);
    const slot = new Date(NOW);
    const fighters = await createV3Job(db, { internalGameId: GAME_ID, contestId: CONTEST_F, jobType: "prediction_close", scheduledSlotAt: slot });
    const marines = await createV3Job(db, { internalGameId: GAME_ID, contestId: CONTEST_M, jobType: "prediction_close", scheduledSlotAt: slot });
    const claimed = await claimV3Job(db, { jobId: marines.job.id, now: slot });
    const env = {
      AUTH_DB: db,
      TARGET_TEAM_CONTEXT: teamContext.MARINES,
      ENVIRONMENT: "test",
      TEST_SITE_ID: "starting9-isolated-v1",
      TEST_WORKER_NAME: "starting9-test-auth"
    };
    const result = await executeGameAutomationV3Job({ env, job: claimed, internalGameId: GAME_ID, now: slot });
    assert.equal(result.stateAfter, "prediction_closed");
    assert.deepEqual(database.prepare("SELECT id,status FROM predictions ORDER BY id").all().map((row) => ({ ...row })), [
      { id: "prediction-f", status: "submitted" },
      { id: "prediction-m", status: "locked" }
    ]);
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE id=?").get(fighters.job.id).status, "pending");
  } finally { database.close(); }
});

test("0049 preserves legacy job status and lease fields when one contest proves ownership", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyThrough(database, "0048_contest_scoped_results.sql");
    seedGameAndContests(database, false);
    const rows = [
      ["pending", 0, null, null, null],
      ["claimed", 1, "claim-a", "2026-10-21T10:05:00.000Z", null],
      ["retry_wait", 2, null, null, "2026-10-21T10:10:00.000Z"],
      ["failed", 12, null, null, null],
      ["completed", 1, null, null, null]
    ];
    for (let index = 0; index < rows.length; index += 1) {
      const [status, attempt, token, lease, retryAt] = rows[index];
      database.prepare(`INSERT INTO game_jobs_v3
        (internal_game_id,job_type,scheduled_at,scheduled_slot_at,status,attempt_count,max_attempts,
         claim_token,lease_expires_at,next_retry_at,created_at,updated_at,completed_at)
        VALUES(?,'score',?,?,?,?,12,?,?,?, ?,?,?)`).run(
        GAME_ID, NOW, `2026-10-21T10:00:0${index}.000Z`, status, attempt, token, lease, retryAt,
        NOW, NOW, status === "completed" ? NOW : null
      );
    }
    database.prepare(`INSERT INTO contest_lineup_revisions
      (contest_id,internal_game_id,game_id,version,revision_id,actual_lineup_json,lineup_fingerprint,source,
       created_at,reason,is_current,is_final)
      VALUES(?,?,?,1,'legacy-f-lineup','[]','legacy-fingerprint','manual',?,'migration fixture',1,1)`)
      .run(CONTEST_F, GAME_ID, GAME_ID, NOW);
    database.prepare(`INSERT INTO contest_scoring_revisions
      (contest_id,internal_game_id,id,game_id,revision_number,lineup_revision_id,status,reason,created_by,created_at,is_active)
      VALUES(?,?, 'legacy-f-score', ?,1,'legacy-f-lineup','completed','migration fixture','fixture',?,1)`)
      .run(CONTEST_F, GAME_ID, GAME_ID, NOW);
    const scoreJobId = database.prepare("SELECT id FROM game_jobs_v3 WHERE job_type='score' ORDER BY id LIMIT 1").get().id;
    database.prepare(`INSERT INTO contest_score_attempts
      (attempt_id,contest_id,internal_game_id,game_id,canonical_lineup_revision_id,scoring_lineup_revision_id,
       canonical_lineup_fingerprint,job_id,claim_token,status,expected_prediction_count,expected_test_count,
       scoring_revision_id,scoring_revision_number,actual_lineup_json,created_at,ready_at)
      VALUES('legacy-f-attempt',?,?,?,'legacy-f-lineup','legacy-f-lineup','legacy-fingerprint',?,'legacy-claim',
       'ready',0,1,'legacy-f-score',1,'[]',?,?)`)
      .run(CONTEST_F, GAME_ID, GAME_ID, scoreJobId, NOW, NOW);
    database.prepare(`INSERT INTO contest_score_attempt_test_rows
      (attempt_id,slot,prediction_json,status,score,max_score) VALUES('legacy-f-attempt',1,'{}','scored',5,99)`)
      .run();
    const before = database.prepare("SELECT id,status,attempt_count,claim_token,lease_expires_at,next_retry_at,completed_at FROM game_jobs_v3 ORDER BY id").all();
    database.exec("BEGIN");
    try {
      database.exec(fs.readFileSync(path.join(MIGRATIONS, "0049_contest_scoped_formal_jobs.sql"), "utf8"));
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    const after = database.prepare(`SELECT id,contest_id,status,attempt_count,claim_token,lease_expires_at,next_retry_at,completed_at
      FROM game_jobs_v3 ORDER BY id`).all();
    assert.deepEqual(JSON.parse(JSON.stringify(after.map(({ id, status, attempt_count, claim_token, lease_expires_at, next_retry_at, completed_at }) =>
      ({ id, status, attempt_count, claim_token, lease_expires_at, next_retry_at, completed_at })))),
    JSON.parse(JSON.stringify(before)));
    assert.ok(after.every((job) => job.contest_id === CONTEST_F));
    assert.deepEqual(database.prepare("SELECT attempt_id,contest_id,job_id,status,claim_token FROM contest_score_attempts").all().map((row) => ({ ...row })), [
      { attempt_id: "legacy-f-attempt", contest_id: CONTEST_F, job_id: scoreJobId, status: "ready", claim_token: "legacy-claim" }
    ]);
    assert.deepEqual(database.prepare("SELECT attempt_id,slot,prediction_json,status,score,max_score FROM contest_score_attempt_test_rows").all().map((row) => ({ ...row })), [
      { attempt_id: "legacy-f-attempt", slot: 1, prediction_json: "{}", status: "scored", score: 5, max_score: 99 }
    ]);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM game_jobs_v3 WHERE contest_id=?").get(CONTEST_F).n, rows.length);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { database.close(); }
});

test("0049 fails closed for ambiguous game-only formal jobs", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyThrough(database, "0048_contest_scoped_results.sql");
    seedGameAndContests(database, true);
    database.prepare(`INSERT INTO game_jobs_v3(internal_game_id,job_type,scheduled_at,scheduled_slot_at,created_at,updated_at)
      VALUES(?,'score',?,?,?,?)`).run(GAME_ID, NOW, NOW, NOW, NOW);
    database.exec("BEGIN");
    assert.throws(() => database.exec(fs.readFileSync(path.join(MIGRATIONS, "0049_contest_scoped_formal_jobs.sql"), "utf8")), /CHECK constraint failed/);
    database.exec("ROLLBACK");
    assert.equal(database.prepare("PRAGMA table_info(game_jobs_v3)").all().some((column) => column.name === "contest_id"), false);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM game_jobs_v3").get().n, 1);
  } finally { database.close(); }
});

test("pre-0049 Fighters-only schema retains its formal job contract and rejects multi-contest writes", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyThrough(database, "0048_contest_scoped_results.sql");
    seedGameAndContests(database, false);
    const db = d1(database);
    const fightersJob = await createV3Job(db, {
      internalGameId: GAME_ID, contestId: CONTEST_F, jobType: "prediction_close",
      scheduledSlotAt: new Date(NOW), scheduledAt: new Date(NOW)
    });
    assert.equal(fightersJob.created, true);
    assert.equal("contest_id" in fightersJob.job, false);
    const duplicate = await createV3Job(db, {
      internalGameId: GAME_ID, contestId: CONTEST_F, jobType: "prediction_close",
      scheduledSlotAt: new Date(NOW), scheduledAt: new Date(NOW)
    });
    assert.equal(duplicate.created, false);
    const state = await ensureV3State(db, GAME_ID, new Date(NOW), CONTEST_F);
    assert.equal(state.state, "scheduled");
    await transitionV3State(db, { internalGameId: GAME_ID, contestId: CONTEST_F,
      from: "scheduled", to: "prediction_closed", now: new Date(NOW) });
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id=?").get(GAME_ID).state,
      "prediction_closed");

    database.prepare("INSERT INTO game_contests(contest_id,internal_game_id,target_team_key,created_at) VALUES(?,?,'marines',?)")
      .run(CONTEST_M, GAME_ID, NOW);
    await assert.rejects(() => createV3Job(db, {
      internalGameId: GAME_ID, contestId: CONTEST_M, jobType: "prediction_close",
      scheduledSlotAt: new Date("2026-10-21T10:01:00.000Z")
    }), { code: "V3_CONTEST_JOB_SCHEMA_REQUIRED" });
  } finally { database.close(); }
});
