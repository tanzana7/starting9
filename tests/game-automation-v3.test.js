import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));

const GAME_ID = "12d554bb-ad25-44be-8159-0134c046dcee";
const START = "2026-08-04T09:00:00.000Z";

function game() {
  return { internalGameId: GAME_ID, startAt: START, gameStatus: "scheduled", isActive: 1, deletedAt: null };
}

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bound = (...params) => ({
        all: async () => ({ results: statement.all(...params) }),
        first: async () => statement.get(...params),
        run: async () => {
          const result = statement.run(...params);
          return { meta: { changes: Number(result.changes || 0) } };
        }
      });
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => {
          const result = statement.run();
          return { meta: { changes: Number(result.changes || 0) } };
        },
        bind(...params) {
          return bound(...params);
        }
      };
    }
  };
}

test("V3はfeature flagが明示的に有効なときだけ起動する", () => {
  assert.equal(v3.isGameAutomationV3Enabled({}), false);
  assert.equal(v3.isGameAutomationV3Enabled({ ENABLE_GAME_AUTOMATION_V3: "false" }), false);
  assert.equal(v3.isGameAutomationV3Enabled({ ENABLE_GAME_AUTOMATION_V3: "true" }), true);
});

test("V3の派生時刻はDB startAtから固定され、外部IDを要求しない", () => {
  const schedule = v3.deriveV3Schedule(game());
  assert.equal(schedule.predictionDeadline.toISOString(), "2026-08-04T08:00:00.000Z");
  assert.equal(schedule.lineupPollingStart.toISOString(), "2026-08-04T08:10:00.000Z");
  assert.equal(schedule.finalLineupAt.toISOString(), "2026-08-04T09:02:00.000Z");
  assert.equal(schedule.publicationAt.toISOString(), "2026-08-04T09:10:00.000Z");
  assert.equal(v3.getV3DuePlan(game(), "scheduled", "2026-08-04T08:00:00.000Z").jobType, "prediction_close");
});

test("NPB識別解決は前日18時・当日16時・10分スロットをJSTで計画する", () => {
  const target = { ...game(), gameDate: "2026-08-05", startAt: "2026-08-05T09:00:00.000Z", npbIdentityStatus: "unresolved" };
  const previousDay = v3.getV3IdentityResolvePlans(target, "2026-08-04T09:00:00.000Z");
  assert.deepEqual(previousDay.map((plan) => plan.scheduledSlotAt.toISOString()), ["2026-08-04T09:00:00.000Z"]);
  const polling = v3.getV3IdentityResolvePlans(target, "2026-08-05T08:20:00.000Z");
  assert.deepEqual(polling.map((plan) => plan.scheduledSlotAt.toISOString()), [
    "2026-08-04T09:00:00.000Z",
    "2026-08-05T07:00:00.000Z",
    "2026-08-05T08:10:00.000Z",
    "2026-08-05T08:20:00.000Z"
  ]);
  assert.equal(v3.getV3IdentityResolvePlans({ ...target, npbIdentityStatus: "resolved" }, "2026-08-05T08:20:00.000Z").length, 0);
});

test("NPB識別情報が未解決の間はlineup jobを計画しない", () => {
  const target = { ...game(), npbIdentityStatus: "unresolved" };
  assert.equal(v3.getV3DuePlan(target, "prediction_closed", "2026-08-04T08:20:00.000Z"), null);
  assert.equal(v3.getV3DuePlan({ ...target, npbIdentityStatus: "resolved" }, "prediction_closed", "2026-08-04T08:20:00.000Z").jobType, "lineup_fetch");
});

test("V3の状態機械は正常遷移だけを受け入れ、旧状態名を含めない", () => {
  assert.equal(v3.getV3AllowedTransitions("scheduled", "prediction_closed"), true);
  assert.equal(v3.getV3AllowedTransitions("prediction_closed", "lineup_ready"), true);
  assert.equal(v3.getV3AllowedTransitions("lineup_ready", "scored"), true);
  assert.equal(v3.getV3AllowedTransitions("scored", "ranked"), true);
  assert.equal(v3.getV3AllowedTransitions("ranked", "published"), true);
  assert.equal(v3.getV3AllowedTransitions("published", "scored"), false);
  assert.equal(v3.getV3AllowedTransitions("scheduled", "retrying"), false);
});

test("V3全job typeはstate gateから各plannerへ到達できる", () => {
  const target = { ...game(), npbIdentityStatus: "resolved" };
  assert.deepEqual(v3.V3_JOB_TYPES, [
    "npb_identity_resolve", "prediction_close", "lineup_fetch", "lineup_finalize",
    "score", "ranking_rebuild", "publish", "probable_starter_fetch", "roster_fetch"
  ]);
  assert.deepEqual(v3.getV3DuePlans(target, "scheduled", "2026-08-04T08:00:00.000Z").map((plan) => plan.jobType), ["prediction_close"]);
  assert.deepEqual(v3.getV3DuePlans(target, "prediction_closed", "2026-08-04T08:20:00.000Z").map((plan) => plan.jobType), ["lineup_fetch"]);
  assert.deepEqual(v3.getV3DuePlans(target, "prediction_closed", "2026-08-04T09:03:00.000Z").map((plan) => plan.jobType), ["lineup_finalize"]);
  assert.deepEqual(v3.getV3DuePlans(target, "lineup_ready", "2026-08-04T09:03:00.000Z").map((plan) => plan.jobType), ["score"]);
  assert.deepEqual(v3.getV3DuePlans(target, "scored", "2026-08-04T09:03:00.000Z").map((plan) => plan.jobType), ["ranking_rebuild"]);
  assert.deepEqual(v3.getV3DuePlans(target, "ranked", "2026-08-04T09:11:00.000Z").map((plan) => plan.jobType), ["publish"]);
});

test("V3 job slot is unique and claim is atomic", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return { bind(...args) { statements.push({ sql, args }); return { async run() { return { meta: { changes: 1 } }; }, async first() { return { id: 1, ...Object.fromEntries(args.map((value, index) => [`arg${index}`, value])) }; } }; } };
    }
  };
  const created = await v3.createV3Job(db, { internalGameId: GAME_ID, jobType: "lineup_fetch", scheduledSlotAt: START });
  assert.equal(created.created, true);
  assert.match(statements[0].sql, /INSERT OR IGNORE/);
  assert.match(statements[0].sql, /UNIQUE|game_jobs_v3/);
});

test("V3 runnerは同じDB行をprediction closeからpublishまで一度ずつ進める", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-04', '${START}', 'hawks', 'fighters', 'h-f-15', 'scheduled', 1, NULL);
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const executed = [];
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
      const next = { prediction_close: "prediction_closed", lineup_finalize: "lineup_ready", score: "scored", ranking_rebuild: "ranked", publish: "published" }[job.job_type];
      const current = { prediction_close: "scheduled", lineup_finalize: "prediction_closed", score: "lineup_ready", ranking_rebuild: "scored", publish: "ranked" }[job.job_type];
      return { stateBefore: current, stateAfter: next || current, status: "completed" };
    };
    for (const at of ["2026-08-04T08:00:00.000Z", "2026-08-04T08:10:00.000Z", "2026-08-04T09:02:00.000Z", "2026-08-04T09:03:00.000Z", "2026-08-04T09:10:00.000Z", "2026-08-04T09:11:00.000Z"]) {
      await v3.runGameAutomationV3(env, new Date(at), { executeJob });
    }
    assert.deepEqual(executed, ["roster_fetch", "probable_starter_fetch", "prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]);
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(GAME_ID).state, "published");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1").get(GAME_ID).count, 8);
  } finally {
    database.close();
  }
});

test("lineup未発表の戻り値は成功完了にせず次slotのretry_waitへ戻す", async () => {
  const database = new DatabaseSync(":memory:");
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
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-04', '${START}', 'hawks', 'fighters', 'h-f-15', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES ('${GAME_ID}', 'prediction_closed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, '${START}', '${START}');
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const at = new Date("2026-08-04T08:20:00.000Z");
    await v3.runGameAutomationV3(env, at, {
      executeJob: async () => ({ status: "retry_wait", failureCode: "LINEUP_NOT_ANNOUNCED", failureMessage: "未発表" })
    });
    const row = database.prepare(
      "SELECT job_type, status, failure_code, attempt_count FROM game_jobs_v3 WHERE job_type = 'lineup_fetch'"
    ).get();
    assert.equal(row.job_type, "lineup_fetch");
    assert.equal(row.status, "retry_wait");
    assert.equal(row.failure_code, "LINEUP_NOT_ANNOUNCED");
    assert.equal(row.attempt_count, 1);
  } finally {
    database.close();
  }
});

test("予告先発announcedでもロースターの期限到達slotは独立して1件だけ救済される", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE probable_starters (game_id TEXT PRIMARY KEY, internal_game_id TEXT,
        status TEXT, data_status TEXT, error_code TEXT, home_pitcher_name TEXT,
        away_pitcher_name TEXT, fetched_at TEXT, updated_at TEXT);
      CREATE TABLE game_roster_snapshots (game_id TEXT PRIMARY KEY, internal_game_id TEXT,
        status TEXT, player_count INTEGER, captured_at TEXT, updated_at TEXT);
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-07', '2026-08-07T09:00:00.000Z',
        'fighters', 'eagles', 'f-e-17', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO probable_starters VALUES ('${GAME_ID}', '${GAME_ID}', 'announced', 'announced', NULL,
        '投手A', '投手B', '2026-08-07T03:00:00.000Z', '2026-08-07T03:00:00.000Z');
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const executed = [];
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
      return { status: "captured", stateBefore: "scheduled", stateAfter: "scheduled" };
    };
    const now = new Date("2026-08-07T07:50:00.000Z");
    const first = await v3.runGameAutomationV3(env, now, { executeJob });
    const second = await v3.runGameAutomationV3(env, now, { executeJob });
    const rosterJobs = database.prepare(
      "SELECT job_type, scheduled_slot_at, status, attempt_count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'roster_fetch'"
    ).all(GAME_ID);
    assert.equal(first.rosterPlan.created, 1);
    assert.equal(second.rosterPlan.created, 0);
    assert.equal(rosterJobs.length, 1);
    assert.equal(rosterJobs[0].job_type, "roster_fetch");
    assert.equal(rosterJobs[0].scheduled_slot_at, "2026-08-07T07:10:00.000Z");
    assert.equal(rosterJobs[0].status, "completed");
    assert.equal(rosterJobs[0].attempt_count, 1);
    assert.deepEqual(executed, ["roster_fetch"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE job_type = 'probable_starter_fetch'").get().count, 0);
    assert.deepEqual(v3.getV3RosterSlots({ ...game(), gameDate: "2026-08-07", startAt: "2026-08-07T09:00:00.000Z" }).map((slot) => slot.toISOString()), [
      "2026-08-07T07:00:00.000Z",
      "2026-08-07T07:02:00.000Z",
      "2026-08-07T07:10:00.000Z"
    ]);
  } finally {
    database.close();
  }
});

test("V3 Cronは未解決試合のNPB識別jobを固定slotで一度だけ投入する", async () => {
  const database = new DatabaseSync(":memory:");
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
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-05', '2026-08-05T09:00:00.000Z', 'hawks', 'fighters', NULL, 'unresolved', 'scheduled', 1, NULL);
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const executed = [];
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
      return { status: "pending", stateBefore: "scheduled", stateAfter: "scheduled" };
    };
    const at = new Date("2026-08-04T09:00:00.000Z");
    await v3.runGameAutomationV3(env, at, { executeJob });
    await v3.runGameAutomationV3(env, at, { executeJob });
    const row = database.prepare("SELECT job_type, scheduled_slot_at, status, attempt_count FROM game_jobs_v3 WHERE internal_game_id = ?1").get(GAME_ID);
    assert.equal(row.job_type, "npb_identity_resolve");
    assert.equal(row.scheduled_slot_at, "2026-08-04T09:00:00.000Z");
    assert.equal(row.status, "completed");
    assert.equal(row.attempt_count, 1);
    assert.deepEqual(executed, ["probable_starter_fetch", "npb_identity_resolve"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1").get(GAME_ID).count, 2);
  } finally {
    database.close();
  }
});

test("0029 is additive, has no backfill, and applies to an existing migration chain", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const files = fs.readdirSync(path.join(root, "migrations"))
      .filter((file) => /^00(?:0[1-9]|1[0-9]|2[0-8])_.*\.sql$/.test(file))
      .sort();
    for (const file of files) database.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
    database.exec(`INSERT INTO games (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
      VALUES ('${GAME_ID}', '2026-08-04', '${START}', 'hawks', 'fighters', 'completed', '${START}', '${START}')`);
    database.exec(fs.readFileSync(path.join(root, "migrations", "0029_game_automation_v3.sql"), "utf8"));
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('game_jobs_v3', 'game_automation_v3_state') ORDER BY name").all();
    assert.deepEqual(table.map((row) => row.name), ["game_automation_v3_state", "game_jobs_v3"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3").get().count, 0);
    assert.equal(database.prepare("SELECT start_time FROM games WHERE internal_game_id = ?1").get(GAME_ID).start_time, START);
    database.exec(fs.readFileSync(path.join(root, "migrations", "0030_game_automation_v3_npb_code_audit.sql"), "utf8"));
    database.exec(fs.readFileSync(path.join(root, "migrations", "0031_game_npb_identity_registry.sql"), "utf8"));
    database.exec(`INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, created_at, updated_at)
      VALUES ('${GAME_ID}', 'prediction_close', '${START}', '${START}', '${START}', '${START}')`);
    database.exec(`INSERT INTO game_automation_v3_audit (internal_game_id, job_id, job_type, occurred_at)
      VALUES ('${GAME_ID}', 1, 'prediction_close', '${START}')`);
    database.exec(fs.readFileSync(path.join(root, "migrations", "0032_game_automation_v3_npb_identity_job.sql"), "utf8"));
    const jobSchema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'game_jobs_v3'").get().sql;
    assert.match(jobSchema, /npb_identity_resolve/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE job_type = 'prediction_close'").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_automation_v3_audit").get().count, 1);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    database.prepare("INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(GAME_ID, "npb_identity_resolve", START, "2026-08-04T09:00:00.000Z", START, START);
  } finally {
    database.close();
  }
});
