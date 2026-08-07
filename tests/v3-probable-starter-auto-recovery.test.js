import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
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

function createDb() {
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
      next_retry_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(internal_game_id, job_type, scheduled_slot_at)
    );
    CREATE TABLE game_automation_v3_state (
      internal_game_id TEXT PRIMARY KEY,
      state TEXT
    );
    CREATE TABLE probable_starters (
      game_id TEXT PRIMARY KEY,
      internal_game_id TEXT,
      status TEXT,
      home_pitcher_name TEXT,
      away_pitcher_name TEXT,
      fetched_at TEXT,
      updated_at TEXT
    );
  `);
  return database;
}

function game() {
  return {
    internalGameId: GAME_ID,
    gameDate: "2026-08-07",
    startAt: "2026-08-07T09:00:00.000Z",
    homeTeam: "fighters",
    awayTeam: "eagles",
    gameStatus: "scheduled",
    isActive: 1,
    deletedAt: null
  };
}

test("予告先発は前日18時と当日slotをJSTで安定生成する", () => {
  assert.deepEqual(v3.getV3ProbableStarterSlots(game()).map((slot) => slot.toISOString()), [
    "2026-08-06T09:00:00.000Z",
    "2026-08-07T00:00:00.000Z",
    "2026-08-07T03:00:00.000Z",
    "2026-08-07T06:00:00.000Z",
    "2026-08-07T07:00:00.000Z",
    "2026-08-07T08:00:00.000Z",
    "2026-08-07T08:30:00.000Z"
  ]);
});

test("期限到達済みの最新未実行slotを1件だけ救済し、次slotを先取りしない", async () => {
  const database = createDb();
  try {
    const db = d1(database);
    database.prepare(`INSERT INTO game_jobs_v3
      (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'completed', 1, ?, ?)`)
      .run(GAME_ID, "probable_starter_fetch", "2026-08-06T09:00:00.000Z", "2026-08-06T09:00:00.000Z", "2026-08-06T09:01:00.000Z", "2026-08-06T09:01:00.000Z");
    const now = new Date("2026-08-07T01:17:00.000Z");
    const first = await v3.planV3ProbableStarterJobs(db, [game()], now);
    assert.equal(first.created, 1);
    assert.equal(first.planned[0].job.scheduled_slot_at, "2026-08-07T00:00:00.000Z");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE scheduled_slot_at = '2026-08-07T03:00:00.000Z'").get().count, 0);
    const second = await v3.planV3ProbableStarterJobs(db, [game()], now);
    assert.equal(second.created, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3").get().count, 2);
  } finally {
    database.close();
  }
});

test("両側のUUID正規rowが揃った試合は以後のprobable starter jobを生成しない", async () => {
  const database = createDb();
  try {
    database.prepare("INSERT INTO probable_starters (game_id, internal_game_id, status, home_pitcher_name, away_pitcher_name, updated_at) VALUES (?, ?, 'announced', ?, ?, ?)")
      .run(GAME_ID, GAME_ID, "投手A", "投手B", "2026-08-07T00:01:00.000Z");
    const result = await v3.planV3ProbableStarterJobs(d1(database), [game()], new Date("2026-08-07T01:17:00.000Z"));
    assert.equal(result.created, 0);
  } finally {
    database.close();
  }
});

test("古いslotのopen jobがある間は次slotを並列生成しない", async () => {
  const database = createDb();
  try {
    database.prepare(`INSERT INTO game_jobs_v3
      (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`)
      .run(GAME_ID, "probable_starter_fetch", "2026-08-06T09:00:00.000Z", "2026-08-06T09:00:00.000Z", "2026-08-06T09:00:00.000Z", "2026-08-06T09:00:00.000Z");
    const db = d1(database);
    const now = new Date("2026-08-07T04:01:00.000Z");
    assert.equal((await v3.planV3ProbableStarterJobs(db, [game()], now)).created, 0);
    database.prepare("UPDATE game_jobs_v3 SET status = 'completed' WHERE internal_game_id = ?").run(GAME_ID);
    const resumed = await v3.planV3ProbableStarterJobs(db, [game()], now);
    assert.equal(resumed.created, 1);
    assert.equal(resumed.planned[0].job.scheduled_slot_at, "2026-08-07T03:00:00.000Z");
  } finally {
    database.close();
  }
});

test("片側取得・UUID rowなしでもV3は次slotを計画し、legacy rowを参照しない", () => {
  assert.match(worker, /const storageGameId = source === "v3" \? String\(internalGameId \|\| ""\)\.trim\(\) : gameId/);
  assert.match(worker, /readProbableStarterRow\(env\.AUTH_DB, \{\s*internalGameId: target\?\.internalGameId/);
  assert.match(worker, /const fullyAnnounced = Boolean\(homePitcherName && awayPitcherName\)/);
  assert.match(worker, /const dataStatus = status === "error"/);
  assert.match(worker, /source !== "v3"\) await linkLegacyGameRowsToInternalGameId/);
});

test("serializerはunannounced・partial・announced・errorをデータ状態として区別する", async () => {
  const { serializeProbableStarterRow } = await import(pathToFileURL(path.join(root, "auth-worker.js")));
  const base = { game_id: GAME_ID, internal_game_id: GAME_ID, fetched_at: "2026-08-07T00:00:00.000Z" };
  assert.equal(serializeProbableStarterRow({ ...base, status: "unannounced" }).dataStatus, "unannounced");
  const partial = serializeProbableStarterRow({ ...base, status: "announced", home_pitcher_name: "投手A" });
  assert.equal(partial.dataStatus, "partial");
  assert.equal(partial.isConfirmed, false);
  const announced = serializeProbableStarterRow({ ...base, status: "announced", home_pitcher_name: "投手A", away_pitcher_name: "投手B" });
  assert.equal(announced.dataStatus, "announced");
  assert.equal(announced.isConfirmed, true);
  assert.equal(serializeProbableStarterRow({ ...base, status: "error", error_code: "NPB_FETCH_FAILED" }).dataStatus, "error");
});

test("V3 runnerはprobable starterをUUID対象として実行し、完了したslotを次のslotと混同しない", () => {
  const runner = worker.slice(worker.indexOf("async function executeGameAutomationV3Job"), worker.indexOf("async function executeGameAutomationV3Job") + 1600);
  assert.match(runner, /jobType === "probable_starter_fetch"/);
  assert.match(runner, /gameId: internalGameId/);
  assert.match(runner, /date: target\.game_date/);
  assert.match(runner, /homeTeam: target\.home_team/);
  assert.match(runner, /awayTeam: target\.away_team/);
  assert.match(runner, /source: "v3"/);
  assert.doesNotMatch(runner, /probable-starter\/refresh/);
});
