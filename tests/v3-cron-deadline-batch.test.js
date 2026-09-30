import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import test from "node:test";
import { listOfficialCancellationCandidates, listV3Games } from "../backend/automation-v3/repository.js";

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

test("通常Cron discoveryは古いranked試合をstale publish recovery対象に戻さない", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT,
        npb_identity_status TEXT, game_status TEXT, is_active INTEGER,
        deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, job_type TEXT, status TEXT
      );
      CREATE TABLE game_lineups (internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT);
      CREATE TABLE ranking_games (internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT);
      CREATE TABLE game_lineup_revisions (
        game_id TEXT, version INTEGER, revision_id TEXT, internal_game_id TEXT,
        PRIMARY KEY (game_id, version)
      );
      CREATE TABLE game_scoring_revisions (
        id TEXT PRIMARY KEY, internal_game_id TEXT, lineup_revision_id TEXT,
        status TEXT, is_active INTEGER
      );
      CREATE TABLE game_identifiers (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, provider TEXT,
        identifier_type TEXT, identifier_value TEXT, updated_at TEXT
      );
      INSERT INTO games VALUES
        ('stale-ranked', '2026-08-06', '2026-08-06T09:00:00.000Z', 'fighters', 'hawks', 'f-h-stale', 'resolved', 'scheduled', 1, NULL),
        ('recent-ranked', '2026-09-18', '2026-09-18T09:00:00.000Z', 'fighters', 'hawks', 'f-h-recent', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES
        ('stale-ranked', 'ranked'), ('recent-ranked', 'ranked');
      INSERT INTO game_lineups VALUES
        ('stale-ranked', 'pending', NULL), ('recent-ranked', 'pending', NULL);
      INSERT INTO ranking_games VALUES
        ('stale-ranked', 'scored_private', NULL), ('recent-ranked', 'scored_private', NULL);
      INSERT INTO game_lineup_revisions VALUES
        ('2026-08-06-fighters-hawks-1800', 1, '2026-08-06-fighters-hawks-1800:1', 'stale-ranked');
      INSERT INTO game_scoring_revisions VALUES
        ('score-stale', 'stale-ranked', 'stale-ranked:1', 'completed', 1);
      INSERT INTO game_jobs_v3 VALUES
        (1, 'stale-ranked', 'score', 'completed');
    `);

    const games = await listV3Games(d1(database), new Date("2026-09-19T00:00:00.000Z"), { limit: 12 });
    const ids = games.map((game) => game.internalGameId);
    assert.ok(ids.includes("recent-ranked"));
    assert.ok(!ids.includes("stale-ranked"));
  } finally {
    database.close();
  }
});

test("auxiliaryの12試合batchは当日分に続く翌日試合を含む", async () => {
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
    `);
    const insertGame = database.prepare(
      "INSERT INTO games VALUES (?, ?, ?, 'f', 'b', ?, 'resolved', 'scheduled', 1, NULL)"
    );
    const insertState = database.prepare("INSERT INTO game_automation_v3_state VALUES (?, 'scheduled')");
    for (let index = 0; index < 6; index += 1) {
      const id = `today-${index}`;
      insertGame.run(id, "2026-09-20", `2026-09-20T0${5 + index}:00:00.000Z`, `f-b-${index}`);
      insertState.run(id);
    }
    insertGame.run("tomorrow", "2026-09-21", "2026-09-21T05:00:00.000Z", "f-b-tomorrow");
    insertState.run("tomorrow");

    const games = await listV3Games(
      d1(database),
      new Date("2026-09-20T06:30:00.000Z"),
      { limit: 12, prioritizeDue: true }
    );
    assert.ok(games.some((game) => game.internalGameId === "tomorrow"));
  } finally {
    database.close();
  }
});

test("公式中止候補は通常Cronでは近日期間だけを取得し、保守時は過去訂正も取得する", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (
        internal_game_id TEXT PRIMARY KEY, state TEXT
      );
      INSERT INTO games VALUES
        ('recent-cancelled', '2026-09-20', '2026-09-20T05:00:00.000Z', 'f', 'b', 'f-b-recent', 'cancelled', 1, NULL),
        ('old-cancelled', '2026-08-01', '2026-08-01T05:00:00.000Z', 'f', 'b', 'f-b-old', 'postponed', 1, NULL),
        ('scheduled', '2026-09-20', '2026-09-20T08:00:00.000Z', 'f', 'b', 'f-b-open', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES
        ('recent-cancelled', 'scheduled'), ('old-cancelled', 'published'), ('scheduled', 'scheduled');
    `);

    const now = new Date("2026-09-20T06:30:00.000Z");
    const recent = await listOfficialCancellationCandidates(d1(database), now, { limit: 50 });
    assert.deepEqual(recent.map((game) => game.internalGameId), ["recent-cancelled"]);
    assert.equal(recent[0].gameStatus, "cancelled");

    const historical = await listOfficialCancellationCandidates(d1(database), now, { includeHistorical: true });
    assert.deepEqual(historical.map((game) => game.internalGameId), ["recent-cancelled", "old-cancelled"]);
  } finally {
    database.close();
  }
});

test("scheduled V3 runnerはbounded discoveryを使用する", async () => {
  const worker = fs.readFileSync(new URL("../auth-worker.js", import.meta.url), "utf8");
  const runnerStart = worker.indexOf("async function runScheduledGameAutomationV3");
  const runner = worker.slice(runnerStart);
  assert.match(worker, /const V3_CRON_GAME_BATCH_SIZE = 4/);
  assert.match(worker, /const V3_AUXILIARY_GAME_BATCH_SIZE = 12/);
  assert.match(runner, /gameListOptions:\s*auxiliaryOnly\s*\?[\s\S]*?V3_AUXILIARY_GAME_BATCH_SIZE[\s\S]*?V3_CRON_GAME_BATCH_SIZE/);
  assert.match(runner, /auxiliaryGameListOptions:\s*auxiliaryOnly\s*\?[\s\S]*?null[\s\S]*?V3_AUXILIARY_GAME_BATCH_SIZE/);
});

test("auxiliary discoveryはbounded critical pathとは別に翌日分を含むbounded batchを走査する", async () => {
  const executor = fs.readFileSync(new URL("../backend/automation-v3/executor.js", import.meta.url), "utf8");
  assert.match(executor, /auxiliaryGameListOptions\s*=\s*null/);
  assert.match(executor, /const formalDiscoveryCoveredAllRows =/);
  assert.match(executor, /formalDiscoveryCoveredAllRows[\s\S]*?Promise\.resolve\(games\)[\s\S]*?listV3Games\(env\.AUTH_DB, now, auxiliaryGameListOptions\)/);
  assert.match(executor, /runV3OptionalPhases\(env, auxiliaryGames, now/);
  assert.match(executor, /caller include the next day's probable-starter slots/);
});
