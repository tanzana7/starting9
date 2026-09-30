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
    CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT, scoring_revision_id TEXT);
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
      final_lineup_revision_id TEXT,
      scoring_status TEXT,
      scored_at TEXT,
      publication_status TEXT,
      published_at TEXT
    );
    CREATE TABLE ranking_games (internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT);
    CREATE TABLE ranking_reflection_revisions (
      id INTEGER PRIMARY KEY,
      internal_game_id TEXT,
      status TEXT,
      scoring_revision_id TEXT,
      ranking_update_revision INTEGER
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
  assert.match(executor, /hasPotentialFormalWork\(env\.AUTH_DB, now, \{ v4SemiAuto \}\)/);
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
    database.prepare("INSERT INTO game_automation_v3_state (internal_game_id, state) VALUES ('future-game', 'scheduled')").run();
    assert.equal(await hasPotentialFormalWork(db, now), false);

    database.prepare(
      "INSERT INTO game_jobs_v3 VALUES (1, 'future-game', 'score', ?1, NULL, 'pending', NULL)"
    ).run(now.toISOString());
    assert.equal(await hasPotentialFormalWork(db, now), true);

    database.prepare("DELETE FROM game_jobs_v3").run();
    database.prepare("UPDATE game_automation_v3_state SET state = 'lineup_ready'").run();
    assert.equal(await hasPotentialFormalWork(db, now), false);

    // The same state becomes formal work only at the existing scoring slot.
    database.prepare("UPDATE games SET start_time = '2026-09-30T04:22:00.000Z', game_date = '2026-09-30'").run();
    database.prepare("INSERT INTO game_lineups (internal_game_id, final_lineup_revision_id, scoring_status) VALUES ('future-game', 'future-game:1', 'pending')").run();
    assert.equal(await hasPotentialFormalWork(db, now, { v4SemiAuto: false }), true);
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
    database.prepare("INSERT INTO game_automation_v3_state (internal_game_id, state) VALUES ('old-game', 'published')").run();
    database.prepare("INSERT INTO game_lineups (internal_game_id, final_lineup_revision_id) VALUES ('old-game', 'old-game:2')").run();
    database.prepare("INSERT INTO game_lineup_revisions VALUES ('old-game', 'old-game:2', 'old-game', 2)").run();
    database.prepare("INSERT INTO game_jobs_v3 VALUES (2, 'old-game', 'score', '2026-08-01T10:00:00.000Z', NULL, 'completed', NULL)").run();
    database.prepare("INSERT INTO game_scoring_revisions VALUES ('old-game', 'old-game:1', 1, 'completed')").run();
    assert.equal(await hasPotentialFormalWork(db, new Date("2026-09-30T04:24:00.000Z")), true);
  } finally {
    database.close();
  }
});

test("formal preflightは期限前のcandidateを避け、prediction closeとV4 downstream dueを検出する", async () => {
  const { database, db } = createDatabase();
  const now = new Date("2026-09-30T04:24:00.000Z");
  try {
    database.prepare(
      "INSERT INTO games VALUES ('deadline-game', '2026-09-30', '2026-09-30T05:24:00.000Z', 'scheduled', 1, NULL)"
    ).run();
    database.prepare("INSERT INTO game_automation_v3_state (internal_game_id, state) VALUES ('deadline-game', 'scheduled')").run();
    assert.equal(await hasPotentialFormalWork(db, now, { v4SemiAuto: true }), true);

    database.prepare("UPDATE game_automation_v3_state SET state = 'lineup_ready' WHERE internal_game_id = 'deadline-game'").run();
    database.prepare("INSERT INTO game_lineups (internal_game_id, final_lineup_revision_id, scoring_status) VALUES ('deadline-game', 'deadline-game:1', 'pending')").run();
    assert.equal(await hasPotentialFormalWork(db, now, { v4SemiAuto: true }), true);
  } finally {
    database.close();
  }
});

test("formal preflightはprediction closeの1分Cron境界を維持する", async () => {
  const { database, db } = createDatabase();
  const now = new Date("2026-09-30T04:24:00.000Z");
  try {
    database.prepare("INSERT INTO game_automation_v3_state (internal_game_id, state) VALUES ('boundary-game', 'scheduled')").run();
    database.prepare("INSERT INTO games VALUES ('boundary-game', '2026-09-30', '2026-09-30T05:25:00.000Z', 'scheduled', 1, NULL)").run();
    assert.equal(await hasPotentialFormalWork(db, now, { v4SemiAuto: true }), false);
    database.prepare("UPDATE games SET start_time = '2026-09-30T05:24:00.000Z'").run();
    assert.equal(await hasPotentialFormalWork(db, now, { v4SemiAuto: true }), true);
    database.prepare("UPDATE games SET start_time = '2026-09-30T05:23:00.000Z'").run();
    assert.equal(await hasPotentialFormalWork(db, now, { v4SemiAuto: true }), true);
  } finally {
    database.close();
  }
});

test("formal preflightはretry_atと期限切れleaseをゲーム時刻に関係なく優先する", async () => {
  const { database, db } = createDatabase();
  const now = new Date("2026-09-30T04:24:00.000Z");
  try {
    database.prepare("INSERT INTO game_jobs_v3 (id, internal_game_id, job_type, scheduled_at, next_retry_at, status, lease_expires_at) VALUES (1, 'retry-game', 'score', ?1, ?2, 'retry_wait', NULL)").run(now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
    assert.equal(await hasPotentialFormalWork(db, now), false);
    database.prepare("UPDATE game_jobs_v3 SET next_retry_at = ?1").run(now.toISOString());
    assert.equal(await hasPotentialFormalWork(db, now), true);
    database.prepare("DELETE FROM game_jobs_v3").run();
    database.prepare("INSERT INTO game_jobs_v3 (id, internal_game_id, job_type, scheduled_at, next_retry_at, status, lease_expires_at) VALUES (2, 'lease-game', 'publish', ?1, NULL, 'claimed', ?2)").run(now.toISOString(), new Date(now.getTime() - 1).toISOString());
    assert.equal(await hasPotentialFormalWork(db, now), true);
  } finally {
    database.close();
  }
});

test("formal preflightは反映済みscored/rankedをidleとし、未反映・未公開だけを通す", async () => {
  const { database, db } = createDatabase();
  const now = new Date("2026-09-30T04:24:00.000Z");
  try {
    database.prepare(
      "INSERT INTO games VALUES ('downstream-game', '2026-09-30', '2026-09-30T03:00:00.000Z', 'scheduled', 1, NULL)"
    ).run();
    database.prepare("INSERT INTO game_automation_v3_state (internal_game_id, state, scoring_revision_id) VALUES ('downstream-game', 'scored', 'score-1')").run();
    database.prepare("INSERT INTO game_lineups (internal_game_id, final_lineup_revision_id, scoring_status, scored_at, publication_status) VALUES ('downstream-game', 'downstream-game:1', 'scored', '2026-09-30T03:10:00.000Z', 'pending')").run();
    database.prepare("INSERT INTO ranking_reflection_revisions (id, internal_game_id, status, scoring_revision_id, ranking_update_revision) VALUES (1, 'downstream-game', 'reflected', 'score-1', 1)").run();
    assert.equal(await hasPotentialFormalWork(db, now, { v4SemiAuto: false }), false);

    database.prepare("DELETE FROM ranking_reflection_revisions").run();
    assert.equal(await hasPotentialFormalWork(db, now, { v4SemiAuto: false }), true);

    database.prepare("UPDATE game_automation_v3_state SET state = 'ranked' WHERE internal_game_id = 'downstream-game'").run();
    database.prepare("INSERT INTO ranking_reflection_revisions (id, internal_game_id, status, scoring_revision_id, ranking_update_revision) VALUES (2, 'downstream-game', 'reflected', 'score-1', 2)").run();
    database.prepare("UPDATE game_lineups SET publication_status = 'published', published_at = '2026-09-30T03:20:00.000Z' WHERE internal_game_id = 'downstream-game'").run();
    assert.equal(await hasPotentialFormalWork(db, now, { v4SemiAuto: false }), false);

    database.prepare("UPDATE game_lineups SET publication_status = 'pending', published_at = NULL WHERE internal_game_id = 'downstream-game'").run();
    assert.equal(await hasPotentialFormalWork(db, now, { v4SemiAuto: false }), true);
  } finally {
    database.close();
  }
});
