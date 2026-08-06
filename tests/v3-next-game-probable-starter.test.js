import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));
const GAME_ID = "35ae1388-02f9-43d3-8643-79acac3cbd34";

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }),
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

function createJobsDb({ includeGames = false, includeState = false } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    ${includeGames ? `CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
      home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
      game_status TEXT, is_active INTEGER, deleted_at TEXT
    );` : ""}
    ${includeState ? `CREATE TABLE game_automation_v3_state (
      internal_game_id TEXT PRIMARY KEY, state TEXT, version INTEGER, created_at TEXT,
      updated_at TEXT
    );` : ""}
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT,
      scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 12, next_retry_at TEXT, claimed_at TEXT,
      claim_token TEXT, lease_expires_at TEXT, completed_at TEXT, failure_code TEXT,
      failure_message TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(internal_game_id, job_type, scheduled_slot_at)
    );
  `);
  return database;
}

function futureGame(startAt = "2026-08-07T09:00:00.000Z", gameDate = "2026-08-07") {
  return {
    internalGameId: GAME_ID,
    gameDate,
    startAt,
    homeTeam: "fighters",
    awayTeam: "eagles",
    gameStatus: "scheduled",
    isActive: 1,
    deletedAt: null,
    npbIdentityStatus: "resolved"
  };
}

test("前日18:00 JSTまでは未生成、到達時に翌日試合のslotを生成する", async () => {
  const database = createJobsDb();
  try {
    const db = d1(database);
    const game = futureGame();
    assert.equal(v3.getV3ProbableStarterSlot(game).toISOString(), "2026-08-06T09:00:00.000Z");
    assert.equal(v3.getV3ProbableStarterPlan(game, new Date("2026-08-06T08:59:00.000Z")), null);
    const before = await v3.planV3ProbableStarterJobs(db, [game], new Date("2026-08-06T08:59:00.000Z"));
    assert.equal(before.created, 0);
    const atSlot = await v3.planV3ProbableStarterJobs(db, [game], new Date("2026-08-06T09:00:00.000Z"));
    assert.equal(atSlot.created, 1);
    assert.equal(atSlot.planned[0].job.scheduled_slot_at, "2026-08-06T09:00:00.000Z");
  } finally {
    database.close();
  }
});

test("過去slotのCron復旧は同じjobを再生成せず、V3 stateなしでも計画できる", async () => {
  const database = createJobsDb({ includeGames: true, includeState: true });
  try {
    const db = d1(database);
    const game = futureGame();
    database.prepare("INSERT INTO games (internal_game_id, game_date, start_time, home_team, away_team, npb_game_code, npb_identity_status, game_status, is_active, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(GAME_ID, game.gameDate, game.startAt, game.homeTeam, game.awayTeam, "f-e-12", "resolved", "scheduled", 1, null);
    const env = { AUTH_DB: db, ENABLE_GAME_AUTOMATION_V3: "true" };
    const executed = [];
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
      return { status: "completed", stateBefore: "scheduled", stateAfter: "scheduled" };
    };
    const now = new Date("2026-08-06T10:12:00.000Z");
    const first = await v3.runGameAutomationV3(env, now, { executeJob });
    const second = await v3.runGameAutomationV3(env, now, { executeJob });
    const row = database.prepare("SELECT job_type, scheduled_slot_at, status, attempt_count FROM game_jobs_v3 WHERE internal_game_id = ? LIMIT 1").get(GAME_ID);
    assert.equal(first.created, 1);
    assert.equal(second.created, 0);
    assert.equal(row.job_type, "probable_starter_fetch");
    assert.equal(row.scheduled_slot_at, "2026-08-06T09:00:00.000Z");
    assert.equal(row.status, "completed");
    assert.equal(row.attempt_count, 1);
    assert.deepEqual(executed, ["probable_starter_fetch"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_automation_v3_state WHERE internal_game_id = ?").get(GAME_ID).count, 1);
  } finally {
    database.close();
  }
});

test("15:00 JST開始試合でも予告先発slotは試合日の前日18:00 JSTで固定する", () => {
  const game = futureGame("2026-08-07T06:00:00.000Z", "2026-08-07");
  assert.equal(v3.getV3ProbableStarterSlot(game).toISOString(), "2026-08-06T09:00:00.000Z");
});

test("excludedまたはpublishedのV3 stateは予告先発jobの対象外になる", async () => {
  const database = createJobsDb({ includeState: true });
  try {
    const db = d1(database);
    database.prepare("INSERT INTO game_automation_v3_state (internal_game_id, state, version, created_at, updated_at) VALUES (?, ?, 0, ?, ?)")
      .run(GAME_ID, "excluded", "2026-08-06T09:12:00.000Z", "2026-08-06T09:12:00.000Z");
    const result = await v3.planV3ProbableStarterJobs(db, [futureGame()], new Date("2026-08-06T10:12:00.000Z"));
    assert.equal(result.created, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3").get().count, 0);
  } finally {
    database.close();
  }
});
