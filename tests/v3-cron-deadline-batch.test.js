import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import test from "node:test";
import { listV3Games } from "../backend/automation-v3/repository.js";

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async (...args) => ({ results: statement.all(...args) }),
        first: async (...args) => statement.get(...args),
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

test("Cronのbounded discoveryは締切到来した当日試合を先に返す", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT,
        npb_identity_status TEXT, game_status TEXT, is_active INTEGER,
        deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (
        internal_game_id TEXT PRIMARY KEY, state TEXT
      );
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, job_type TEXT,
        status TEXT, scheduled_slot_at TEXT
      );
      CREATE TABLE game_identifiers (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, provider TEXT,
        identifier_type TEXT, identifier_value TEXT, updated_at TEXT
      );
      INSERT INTO games VALUES
        ('old', '2026-09-18', '2026-09-18T05:00:00.000Z', 'f', 'b', 'f-b-old', 'resolved', 'scheduled', 1, NULL),
        ('target', '2026-09-19', '2026-09-19T05:00:00.000Z', 'f', 'b', 'f-b-22', 'resolved', 'scheduled', 1, NULL),
        ('future', '2026-09-19', '2026-09-19T08:00:00.000Z', 'f', 'b', 'f-b-future', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES
        ('old', 'scheduled'), ('target', 'scheduled'), ('future', 'scheduled');
    `);

    const games = await listV3Games(
      d1(database),
      new Date("2026-09-19T04:30:00.000Z"),
      { limit: 1, prioritizeDue: true }
    );
    assert.equal(games.length, 1);
    assert.equal(games[0].internalGameId, "target");
  } finally {
    database.close();
  }
});

test("scheduled V3 runnerはbounded discoveryを使用する", async () => {
  const worker = fs.readFileSync(new URL("../auth-worker.js", import.meta.url), "utf8");
  const runnerStart = worker.indexOf("async function runScheduledGameAutomationV3");
  const runner = worker.slice(runnerStart);
  assert.match(worker, /const V3_CRON_GAME_BATCH_SIZE = 4/);
  assert.match(runner, /gameListOptions:\s*\{\s*limit:\s*V3_CRON_GAME_BATCH_SIZE,\s*prioritizeDue:\s*true\s*\}/);
});
