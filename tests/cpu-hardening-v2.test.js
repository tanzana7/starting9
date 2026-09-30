import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { hasPotentialFormalWork } from "../backend/automation-v3/repository.js";
import { resolveV3CronMode } from "../auth-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...params) {
          return {
            first() {
              return statement.get(...params);
            }
          };
        }
      };
    }
  };
}

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY,
      game_date TEXT,
      start_time TEXT,
      game_status TEXT,
      is_active INTEGER,
      deleted_at TEXT
    );
    CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
    CREATE TABLE game_jobs_v3 (
      id INTEGER PRIMARY KEY,
      internal_game_id TEXT,
      job_type TEXT,
      scheduled_at TEXT,
      next_retry_at TEXT,
      status TEXT,
      lease_expires_at TEXT
    );
    CREATE TABLE game_lineups (
      internal_game_id TEXT PRIMARY KEY,
      final_lineup_revision_id TEXT
    );
    CREATE TABLE game_lineup_revisions (
      internal_game_id TEXT,
      revision_id TEXT,
      game_id TEXT,
      version INTEGER
    );
    CREATE TABLE game_scoring_revisions (
      internal_game_id TEXT,
      lineup_revision_id TEXT,
      is_active INTEGER,
      status TEXT
    );
  `);
  return { database, db: d1(database) };
}

test("Cron modeはauxiliary triggerだけを補助経路へ振り分け、unknownはcriticalへfail-closedする", () => {
  assert.equal(resolveV3CronMode("* * * * *"), "critical");
  assert.equal(resolveV3CronMode("*/5 * * * *"), "auxiliary");
  assert.equal(resolveV3CronMode(""), "critical");
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const config = fs.readFileSync(path.join(root, "wrangler.auth.production.jsonc"), "utf8");
  assert.ok(config.includes('"crons": ["* * * * *", "*/5 * * * *"]'));
  assert.match(worker, /const cronMode = resolveV3CronMode\(event\?\.cron\)/);
  assert.match(worker, /if \(isCriticalCron\) ctx\.waitUntil\(writeCronHeartbeatSafely\(env, recordCronInvocation/);
  assert.match(worker, /mode: cronMode/);
});

test("criticalとauxiliaryは同じexecutor内でもformal claim経路を共有しない", () => {
  const executor = fs.readFileSync(path.join(root, "backend/automation-v3/executor.js"), "utf8");
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(executor, /if \(auxiliaryOnly\)/);
  assert.match(executor, /if \(!runAuxiliary\) return criticalResult/);
  assert.match(worker, /runAuxiliary: !criticalOnly/);
  assert.match(worker, /skipFormalDiscoveryIfIdle: criticalOnly/);
  assert.match(worker, /reasonCode: "CRON_MODE_CRITICAL"/);
});

test("formal idle fast-pathは安全な候補がないときだけplannerを省略し、due jobは必ず通す", async () => {
  const { database, db } = createDatabase();
  const now = new Date("2026-09-30T04:24:00.000Z");
  try {
    database.prepare(
      "INSERT INTO games VALUES ('future-game', '2026-10-01', '2026-10-01T09:00:00.000Z', 'scheduled', 1, NULL)"
    ).run();
    database.prepare("INSERT INTO game_automation_v3_state VALUES ('future-game', 'scheduled')").run();
    assert.equal(await hasPotentialFormalWork(db, now), false);

    database.prepare(
      "INSERT INTO game_jobs_v3 VALUES (1, 'future-game', 'score', ?1, NULL, 'pending', NULL)"
    ).run(now.toISOString());
    assert.equal(await hasPotentialFormalWork(db, now), true);

    database.prepare("DELETE FROM game_jobs_v3").run();
    database.prepare("UPDATE game_automation_v3_state SET state = 'lineup_ready'").run();
    assert.equal(await hasPotentialFormalWork(db, now), true);
  } finally {
    database.close();
  }
});

test("formal preflightはD1/schema異常時にfail-openする", async () => {
  const db = { prepare() { throw new Error("schema unavailable"); } };
  assert.equal(await hasPotentialFormalWork(db, new Date("2026-09-30T04:24:00.000Z")), true);
});

test("古いpublished correction候補は日付window外でもformal fast-pathから除外されない", async () => {
  const { database, db } = createDatabase();
  try {
    database.prepare(
      "INSERT INTO games VALUES ('old-game', '2026-08-01', '2026-08-01T09:00:00.000Z', 'scheduled', 1, NULL)"
    ).run();
    database.prepare("INSERT INTO game_automation_v3_state VALUES ('old-game', 'published')").run();
    database.prepare("INSERT INTO game_lineups VALUES ('old-game', 'old-game:2')").run();
    database.prepare("INSERT INTO game_lineup_revisions VALUES ('old-game', 'old-game:2', 'old-game', 2)").run();
    database.prepare("INSERT INTO game_jobs_v3 VALUES (2, 'old-game', 'score', '2026-08-01T10:00:00.000Z', NULL, 'completed', NULL)").run();
    database.prepare("INSERT INTO game_scoring_revisions VALUES ('old-game', 'old-game:1', 1, 'completed')").run();
    assert.equal(await hasPotentialFormalWork(db, new Date("2026-09-30T04:24:00.000Z")), true);
  } finally {
    database.close();
  }
});
