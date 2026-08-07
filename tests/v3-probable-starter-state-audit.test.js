import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0033_probable_starter_audit_data_status.sql"), "utf8");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));
const { serializeProbableStarterRow } = await import(pathToFileURL(path.join(root, "auth-worker.js")));
const GAME_ID = "35ae1388-02f9-43d3-8643-79acac3cbd34";

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async () => ({ results: statement.all() }),
        first: async (...params) => statement.get(...params),
        run: async (...params) => ({ meta: { changes: Number(statement.run(...params).changes || 0) } }),
        bind(...params) {
          return {
            all: async () => ({ results: statement.all(...params) }),
            first: async () => statement.get(...params),
            run: async () => ({ meta: { changes: Number(statement.run(...params).changes || 0) } })
          };
        }
      };
    }
  };
}

test("予告先発のjob statusとdataStatusを分離し、失敗コードを保持する", () => {
  const base = { game_id: GAME_ID, internal_game_id: GAME_ID };
  assert.equal(serializeProbableStarterRow({ ...base, status: "unannounced" }).dataStatus, "unannounced");
  assert.equal(serializeProbableStarterRow({ ...base, status: "error", error_code: "NPB_HTTP_ERROR" }).dataStatus, "transient_error");
  assert.equal(serializeProbableStarterRow({ ...base, status: "error", error_code: "DATA_INTEGRITY_ERROR" }).dataStatus, "integrity_error");
  assert.equal(serializeProbableStarterRow({ ...base, status: "error", error_code: "NPB_HTTP_ERROR" }).errorCode, "NPB_HTTP_ERROR");
});

test("dataStatus正規化と後続slot停止判定を共有する", () => {
  assert.equal(v3.normalizeProbableStarterDataStatus({ status: "error", errorCode: "NPB_HTTP_ERROR", homePitcherName: "残存A", awayPitcherName: "残存B" }), "transient_error");
  assert.equal(v3.normalizeProbableStarterDataStatus({ status: "completed", dataStatus: "error", homePitcherName: "残存A", awayPitcherName: "残存B" }), "transient_error");
  assert.equal(v3.normalizeProbableStarterDataStatus({ status: "failed" }), "transient_error");
  assert.equal(v3.normalizeProbableStarterDataStatus({ status: "unannounced" }), "unannounced");
  assert.equal(v3.normalizeProbableStarterDataStatus({ status: "announced", homePitcherName: "A" }), "partial");
  assert.equal(v3.normalizeProbableStarterDataStatus({ status: "announced", homePitcherName: "A", awayPitcherName: "B" }), "announced");
  assert.equal(v3.shouldStopProbableStarterScheduling({ status: "error", errorCode: "NPB_HTTP_ERROR", homePitcherName: "A", awayPitcherName: "B", startAt: "2026-08-07T09:00:00.000Z", now: "2026-08-07T03:00:00.000Z" }).shouldStopScheduling, false);
  assert.equal(v3.shouldStopProbableStarterScheduling({ status: "announced", homePitcherName: "A", awayPitcherName: "B", startAt: "2026-08-07T09:00:00.000Z", now: "2026-08-07T03:00:00.000Z" }).shouldStopScheduling, true);
});

test("救済jobの対象slot、実行時刻、監査状態、診断情報を別々に扱う", () => {
  assert.match(worker, /stateAfter\s*[,=].*statusAfter|statusAfter\s*=\s*String\(job\?\.status/);
  assert.match(worker, /scheduled_slot_at/);
  assert.match(worker, /dataStatus/);
  assert.match(worker, /httpStatus/);
  assert.match(worker, /parserResult/);
  assert.match(worker, /candidateCount/);
  assert.match(worker, /normalizeProbableStarterDataStatus/);
  assert.match(worker, /probable_starter_job_plan_observed/);
  assert.match(worker, /probable_starter_job_claimed/);
  assert.match(worker, /claimResult/);
  assert.match(worker, /insertedRowCount/);
  assert.match(worker, /actualJobExists/);
  assert.match(worker, /gameId: String\(job\?\.legacyGameId \|\| internalGameId \|\| ""\)/);
  assert.match(worker, /probableStarterNextCheckAt/);
  assert.match(worker, /probableStarterJob/);
  assert.match(admin, /対象slot:/);
  assert.match(admin, /実行:/);
  assert.match(admin, /次回自動確認:/);
  assert.match(admin, /job: 未生成/);
  assert.match(admin, /未生成理由:/);
  assert.match(admin, /probableJob \|\| probableMissingPastSlot/);
  assert.match(migration, /ADD COLUMN data_status TEXT NULL/);
});

test("createdAt <= claimedAt <= completedAt <= updatedAtをjob操作で保証する", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_game_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      scheduled_slot_at TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 12,
      next_retry_at TEXT,
      claimed_at TEXT,
      claim_token TEXT,
      lease_expires_at TEXT,
      completed_at TEXT,
      failure_code TEXT,
      failure_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(internal_game_id, job_type, scheduled_slot_at)
    )
  `);
  try {
    const db = d1(database);
    const created = await v3.createV3Job(db, {
      internalGameId: GAME_ID,
      jobType: "probable_starter_fetch",
      scheduledSlotAt: new Date(Date.now() - 60_000),
      scheduledAt: new Date(Date.now() - 60_000)
    });
    const claimed = await v3.claimV3Job(db, { jobId: created.job.id, now: new Date(Date.now() - 120_000) });
    assert.ok(claimed);
    await v3.completeV3Job(db, { jobId: claimed.id, claimToken: claimed.claim_token, now: new Date(Date.now() - 180_000) });
    const row = database.prepare("SELECT created_at, claimed_at, completed_at, updated_at FROM game_jobs_v3 WHERE id = ?").get(created.job.id);
    const timestamps = [row.created_at, row.claimed_at, row.completed_at, row.updated_at].map((value) => Date.parse(value));
    assert.ok(timestamps.every(Number.isFinite));
    assert.ok(timestamps[0] <= timestamps[1]);
    assert.ok(timestamps[1] <= timestamps[2]);
    assert.ok(timestamps[2] <= timestamps[3]);
  } finally {
    database.close();
  }
});

test("09:00救済完了後は12:00到達後に次slotを1件だけ生成する", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_game_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      scheduled_slot_at TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 12,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(internal_game_id, job_type, scheduled_slot_at)
    );
    CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE probable_starters (internal_game_id TEXT, status TEXT, error_code TEXT, home_pitcher_name TEXT, away_pitcher_name TEXT, fetched_at TEXT, updated_at TEXT);
  `);
  try {
    const db = d1(database);
    database.prepare(`INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', 1, ?, ?)`)
      .run(GAME_ID, "probable_starter_fetch", "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z", "2026-08-07T00:01:00.000Z", "2026-08-07T00:01:00.000Z");
    database.prepare(`INSERT INTO probable_starters (internal_game_id, status, error_code, home_pitcher_name, away_pitcher_name, fetched_at, updated_at) VALUES (?, 'error', ?, ?, ?, ?, ?)`)
      .run(GAME_ID, "NPB_HTTP_ERROR", "前回の投手", "前回の投手", "2026-08-07T02:00:00.000Z", "2026-08-07T02:00:00.000Z");
    const game = { internalGameId: GAME_ID, gameDate: "2026-08-07", startAt: "2026-08-07T09:00:00.000Z", gameStatus: "scheduled", isActive: 1 };
    const before = await v3.planV3ProbableStarterJobs(db, [game], new Date("2026-08-07T02:59:00.000Z"));
    assert.equal(before.created, 0);
    const after = await v3.planV3ProbableStarterJobs(db, [game], new Date("2026-08-07T03:01:00.000Z"));
    assert.equal(after.created, 1);
    assert.equal(after.planned[0].job.scheduled_slot_at, "2026-08-07T03:00:00.000Z");
    assert.equal(after.diagnostics[0].insertedRowCount, 1);
    assert.equal(after.diagnostics[0].actualJobExists, true);
    assert.equal(after.diagnostics[0].scheduledSlotAt, "2026-08-07T03:00:00.000Z");
    assert.equal((await v3.planV3ProbableStarterJobs(db, [game], new Date("2026-08-07T03:01:00.000Z"))).created, 0);
  } finally {
    database.close();
  }
});

test("09:00のtransient_errorは12:00 slotを抑止せず、12:58時点で1件だけclaim・実行する", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY,
      game_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      home_team TEXT,
      away_team TEXT,
      npb_game_code TEXT,
      npb_identity_status TEXT,
      game_status TEXT,
      is_active INTEGER DEFAULT 1,
      deleted_at TEXT
    );
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_game_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      scheduled_slot_at TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 12,
      next_retry_at TEXT,
      claimed_at TEXT,
      claim_token TEXT,
      lease_expires_at TEXT,
      completed_at TEXT,
      failure_code TEXT,
      failure_message TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(internal_game_id, job_type, scheduled_slot_at)
    );
    CREATE TABLE game_automation_v3_state (
      internal_game_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      version INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      failure_code TEXT,
      failure_message TEXT,
      prediction_closed_at TEXT,
      lineup_finalized_at TEXT,
      ranked_at TEXT,
      published_at TEXT,
      excluded_at TEXT
    );
    CREATE TABLE probable_starters (
      internal_game_id TEXT,
      status TEXT,
      error_code TEXT,
      home_pitcher_name TEXT,
      away_pitcher_name TEXT,
      fetched_at TEXT,
      updated_at TEXT
    );
  `);
  try {
    const db = d1(database);
    const game = {
      internalGameId: GAME_ID,
      gameDate: "2026-08-07",
      startAt: "2026-08-07T09:00:00.000Z",
      isActive: 1,
      gameStatus: "scheduled"
    };
    database.prepare("INSERT INTO games (internal_game_id, game_date, start_time, npb_identity_status, game_status, is_active) VALUES (?, ?, ?, 'resolved', ?, ?)")
      .run(GAME_ID, game.gameDate, game.startAt, game.gameStatus, 1);
    database.prepare("INSERT INTO probable_starters (internal_game_id, status, error_code, home_pitcher_name, away_pitcher_name, fetched_at, updated_at) VALUES (?, 'error', ?, ?, ?, ?, ?)")
      .run(GAME_ID, "NPB_HTTP_ERROR", "前回の投手", "前回の投手", "2026-08-07T02:00:00.000Z", "2026-08-07T02:00:00.000Z");
    database.prepare("INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', 1, ?, ?)")
      .run(GAME_ID, "probable_starter_fetch", "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z", "2026-08-07T00:01:00.000Z", "2026-08-07T00:01:00.000Z");
    const env = { ENABLE_GAME_AUTOMATION_V3: "true", AUTH_DB: db };
    const executed = [];
    const planEvents = [];
    const result = await v3.runGameAutomationV3(env, new Date("2026-08-07T03:58:00.000Z"), {
      executeJob: async ({ job, now }) => {
        executed.push({ job, now });
        return { stateBefore: "scheduled", stateAfter: "scheduled" };
      },
      onPlan: (entry) => {
        if (entry.plan?.jobType === "probable_starter_fetch") planEvents.push(entry);
      }
    });
    assert.equal(result.created, 1);
    assert.equal(result.processed, 1);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].job.scheduled_slot_at, "2026-08-07T03:00:00.000Z");
    assert.equal(executed[0].job.status, "claimed");
    assert.equal(executed[0].job.attempt_count, 1);
    assert.deepEqual(planEvents.map((entry) => entry.stage), ["probable_plan", "probable_claim"]);
    assert.equal(planEvents.at(-1).diagnostic.claimResult, "claimed");
    assert.ok(Date.parse(executed[0].now.toISOString()) >= Date.parse("2026-08-07T03:58:00.000Z"));
    const rows = database.prepare("SELECT status, scheduled_slot_at, attempt_count, claimed_at, completed_at FROM game_jobs_v3 WHERE internal_game_id = ? ORDER BY scheduled_slot_at").all(GAME_ID);
    assert.deepEqual(rows.map((row) => [row.status, row.scheduled_slot_at, row.attempt_count, row.claimed_at, row.completed_at]), [
      ["completed", "2026-08-07T00:00:00.000Z", 1, null, null],
      ["completed", "2026-08-07T03:00:00.000Z", 1, executed[0].now.toISOString(), executed[0].now.toISOString()]
    ]);
    const secondRun = await v3.runGameAutomationV3(env, new Date("2026-08-07T03:58:00.000Z"), {
      executeJob: async ({ job }) => {
        executed.push({ job });
        return { stateBefore: "scheduled", stateAfter: "scheduled" };
      }
    });
    assert.equal(secondRun.created, 0);
    assert.equal(secondRun.processed, 0);
    assert.equal(executed.length, 1);
  } finally {
    database.close();
  }
});

for (const scenario of [
  { name: "announcedは停止", status: "announced", home: "投手A", away: "投手B", expected: 0 },
  { name: "partialは継続", status: "announced", home: "投手A", away: "", expected: 1 },
  { name: "unannouncedは継続", status: "unannounced", home: "", away: "", expected: 1 },
  { name: "transient_errorは継続", status: "error", home: "投手A", away: "投手B", expected: 1 },
  { name: "failed slotは次slotを抑止しない", status: null, jobStatus: "failed", expected: 1 },
  { name: "cancelled slotは次slotを抑止しない", status: null, jobStatus: "cancelled", expected: 1 }
]) {
  test(`予告先発のdataStatus分類: ${scenario.name}`, async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        internal_game_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        scheduled_slot_at TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER DEFAULT 0,
        max_attempts INTEGER DEFAULT 12,
        created_at TEXT,
        updated_at TEXT,
        UNIQUE(internal_game_id, job_type, scheduled_slot_at)
      );
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE probable_starters (
        internal_game_id TEXT,
        status TEXT,
        home_pitcher_name TEXT,
        away_pitcher_name TEXT,
        fetched_at TEXT,
        updated_at TEXT
      );
    `);
    try {
      const db = d1(database);
      database.prepare("INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
        .run(GAME_ID, "probable_starter_fetch", "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z", scenario.jobStatus || "completed", "2026-08-07T00:01:00.000Z", "2026-08-07T00:01:00.000Z");
      if (scenario.status) {
        database.prepare("INSERT INTO probable_starters (internal_game_id, status, home_pitcher_name, away_pitcher_name, fetched_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(GAME_ID, scenario.status, scenario.home || "", scenario.away || "", "2026-08-07T02:00:00.000Z", "2026-08-07T02:00:00.000Z");
      }
      const result = await v3.planV3ProbableStarterJobs(db, [{
        internalGameId: GAME_ID,
        gameDate: "2026-08-07",
        startAt: "2026-08-07T09:00:00.000Z",
        gameStatus: "scheduled",
        isActive: 1
      }], new Date("2026-08-07T03:35:00.000Z"));
      assert.equal(result.created, scenario.expected);
    } finally {
      database.close();
    }
  });
}

test("同時Cronでも12:00 slotは一意制約で1件だけ生成される", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_game_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      scheduled_slot_at TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 12,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(internal_game_id, job_type, scheduled_slot_at)
    );
    CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE probable_starters (internal_game_id TEXT, status TEXT, home_pitcher_name TEXT, away_pitcher_name TEXT, fetched_at TEXT, updated_at TEXT);
  `);
  try {
    const db = d1(database);
    database.prepare("INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'completed', 1, ?, ?)")
      .run(GAME_ID, "probable_starter_fetch", "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z", "2026-08-07T00:01:00.000Z", "2026-08-07T00:01:00.000Z");
    const game = { internalGameId: GAME_ID, gameDate: "2026-08-07", startAt: "2026-08-07T09:00:00.000Z", gameStatus: "scheduled", isActive: 1 };
    const [first, second] = await Promise.all([
      v3.planV3ProbableStarterJobs(db, [game], new Date("2026-08-07T03:35:00.000Z")),
      v3.planV3ProbableStarterJobs(db, [game], new Date("2026-08-07T03:35:00.000Z"))
    ]);
    assert.equal(first.created + second.created, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE scheduled_slot_at = '2026-08-07T03:00:00.000Z'").get().count, 1);
  } finally {
    database.close();
  }
});
