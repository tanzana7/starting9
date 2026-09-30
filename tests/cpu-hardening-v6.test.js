import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { hasV3ProbableStarterCandidate, listV3ProbableStarterCandidates } from "../game-automation-v3.js";

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        bind(...params) {
          return {
            all: async () => ({ results: statement.all(...params) }),
            first: async () => statement.get(...params)
          };
        }
      };
    }
  };
}

function createGamesDb() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY,
      game_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      npb_game_code TEXT,
      npb_game_url TEXT,
      game_status TEXT,
      is_active INTEGER,
      deleted_at TEXT,
      actual_start_at TEXT
    );
  `);
  return { database, db: d1(database) };
}

test("probable専用candidateのscalar preflightは対象なしを詳細取得前に止める", async () => {
  const { database, db } = createGamesDb();
  const now = new Date("2026-09-30T00:00:00.000Z");
  assert.equal(await hasV3ProbableStarterCandidate(db, now), false);
  assert.deepEqual(await listV3ProbableStarterCandidates(db, now), []);
  database.close();
});

test("probable専用projectionは近日期間の有効試合だけをboundedに返す", async () => {
  const { database, db } = createGamesDb();
  database.exec(`
    INSERT INTO games VALUES
      ('near', '2026-09-30', '2026-09-30T09:00:00.000Z', 'fighters', 'marines', 'f-m-1', NULL, 'scheduled', 1, NULL, NULL),
      ('cancelled', '2026-09-30', '2026-09-30T10:00:00.000Z', 'fighters', 'eagles', 'f-e-1', NULL, 'cancelled', 1, NULL, NULL),
      ('far', '2026-10-05', '2026-10-05T09:00:00.000Z', 'fighters', 'lions', 'f-l-1', NULL, 'scheduled', 1, NULL, NULL)
  `);
  const now = new Date("2026-09-30T00:00:00.000Z");
  assert.equal(await hasV3ProbableStarterCandidate(db, now), true);
  const games = await listV3ProbableStarterCandidates(db, now, { limit: 1 });
  assert.deepEqual(games.map((game) => game.internalGameId), ["near"]);
  database.close();
});

test("分離Cronは各modeで単一責務へreturnし、probableは既存optional lifecycleへ接続する", () => {
  const worker = fs.readFileSync(new URL("../auth-worker.js", import.meta.url), "utf8");
  const dispatchStart = worker.indexOf("async function runScheduledGameAutomationV3");
  const dispatchEnd = worker.indexOf("await writeV3RuntimeAudit", dispatchStart);
  assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart);
  const dispatch = worker.slice(dispatchStart, dispatchEnd);
  assert.match(dispatch, /if \(mode === "schedule"\) return runScheduledScheduleSync/);
  assert.match(dispatch, /if \(mode === "shadow"\) return runScheduledLineupShadow/);
  assert.match(dispatch, /if \(mode === "probable"\) return runScheduledProbableStarter/);
  assert.match(dispatch, /if \(mode === "observer"\) return runScheduledObserverTasks/);
  assert.match(worker, /runV3OptionalPhases\(env, games, now/);
  assert.match(worker, /disabledJobTypes: V3_MAIN_JOB_TYPES/);
  assert.doesNotMatch(worker, /Number\(probablePlan\.created/);
  assert.doesNotMatch(worker, /Number\(identityPlan\.created/);
  assert.doesNotMatch(worker, /Number\(rosterPlan\.created/);
});
