import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { planAuxiliaryJobs } from "../game-automation-v3.js";

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
    CREATE TABLE game_automation_v3_state (
      internal_game_id TEXT PRIMARY KEY, state TEXT
    );
    CREATE TABLE probable_starters (
      game_id TEXT PRIMARY KEY, internal_game_id TEXT, status TEXT,
      data_status TEXT, error_code TEXT, home_pitcher_name TEXT,
      away_pitcher_name TEXT, next_check_at TEXT, fetched_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      internal_game_id TEXT NOT NULL, job_type TEXT NOT NULL,
      scheduled_at TEXT NOT NULL, scheduled_slot_at TEXT NOT NULL,
      status TEXT NOT NULL, attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 12, created_at TEXT, updated_at TEXT,
      UNIQUE(internal_game_id, job_type, scheduled_slot_at)
    );
  `);
  return database;
}

test("probable専用Cronは予告先発だけを計画し、identity/roster plannerを実行しない", async () => {
  const database = createDb();
  try {
    const result = await planAuxiliaryJobs(d1(database), [{
      internalGameId: "35ae1388-02f9-43d3-8643-79acac3cbd34",
      gameDate: "2026-10-01",
      startAt: "2026-10-01T09:00:00.000Z",
      homeTeam: "fighters",
      awayTeam: "marines",
      gameStatus: "scheduled",
      isActive: 1,
      deletedAt: null,
      npbIdentityStatus: "resolved"
    }], new Date("2026-09-30T10:00:00.000Z"), {
      autoProbableStarter: true,
      autoRosterFetch: false,
      includeStartBoundaryLookup: false,
      probableStarterOnly: true
    });

    assert.equal(result.probablePlan.created, 1);
    assert.equal(result.rosterPlan.created, 0);
    assert.equal(result.rosterPlan.planned.length, 0);
    assert.equal(result.identityPlan.created, 0);
    assert.equal(result.identityPlan.planned.length, 0);
    assert.equal(result.identityPlan.diagnostics[0].reasonCode, "PROBABLE_STARTER_ONLY");
    assert.deepEqual(
      database.prepare("SELECT job_type FROM game_jobs_v3 ORDER BY id").all().map((row) => row.job_type),
      ["probable_starter_fetch"]
    );
  } finally {
    database.close();
  }
});
