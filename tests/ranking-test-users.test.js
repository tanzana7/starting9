import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  getRankingTestState,
  getRankingTestGlobalSettings,
  upsertRankingTestPrediction,
  deleteRankingTestPrediction,
  updateRankingTestToggle,
  updateRankingTestGlobalSettings,
  updateRankingTestDisplayName
} from "../backend/repositories/ranking-test-repository.js";
import {
  RANKING_TEST_POSITION_CANONICAL,
  defaultRankingTestDisplayName,
  normalizeRankingTestDisplayName,
  normalizeRankingTestPosition,
  rankingTestUsername
} from "../backend/domain/ranking-test-users.js";
import { getRankingForPeriod } from "../backend/repositories/ranking-repository.js";

const root = path.join(import.meta.dirname, "..");
const migration = fs.readFileSync(path.join(root, "migrations", "0037_ranking_test_users.sql"), "utf8");
const globalMigration = fs.readFileSync(path.join(root, "migrations", "0038_ranking_test_global_settings.sql"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const renderer = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-ranking-test-users.js"), "utf8");

function adapter(db) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            first: async () => db.prepare(sql).get(...values),
            all: async () => ({ results: db.prepare(sql).all(...values) }),
            run: async () => ({ meta: db.prepare(sql).run(...values) })
          };
        }
      };
    },
    batch(statements) {
      return Promise.resolve(statements.map((statement) => statement.run()));
    }
  };
}

function createMinimalMigrationDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE games (internal_game_id TEXT PRIMARY KEY NOT NULL)");
  db.exec(migration);
  db.exec(globalMigration);
  return db;
}

function createRankingDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE ranking_games (
      game_id TEXT PRIMARY KEY, internal_game_id TEXT, game_date TEXT,
      is_ranking_eligible INTEGER, game_status TEXT, is_test_game INTEGER,
      publication_status TEXT
    );
    CREATE TABLE ranking_test_game_settings (
      internal_game_id TEXT PRIMARY KEY, include_in_public_ranking INTEGER,
      updated_by TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE ranking_test_predictions (
      internal_game_id TEXT, slot INTEGER, prediction_json TEXT, status TEXT,
      score INTEGER, max_score INTEGER, lineup_revision_id TEXT,
      scoring_revision_id TEXT, scored_at TEXT, created_at TEXT, updated_at TEXT,
      PRIMARY KEY (internal_game_id, slot)
    );
    CREATE TABLE ranking_test_global_settings (
      id INTEGER PRIMARY KEY, global_enabled INTEGER, slot_names_json TEXT,
      updated_by TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE game_lineups (internal_game_id TEXT, final_lineup_revision_id TEXT);
    CREATE TABLE game_scoring_revisions (
      id TEXT, internal_game_id TEXT, lineup_revision_id TEXT,
      is_active INTEGER, status TEXT
    );
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, status TEXT);
    CREATE TABLE achievements (id TEXT PRIMARY KEY, code TEXT, name TEXT, icon_key TEXT, rarity TEXT, is_hidden INTEGER);
    CREATE TABLE user_achievements (user_id TEXT, achievement_id TEXT, earned_at TEXT);
    CREATE TABLE predictions (
      user_id TEXT, game_id TEXT, status TEXT, score INTEGER,
      max_score INTEGER, scored_at TEXT, is_test_prediction INTEGER
    );
  `);
  db.prepare("INSERT INTO ranking_games VALUES ('g1', 'ig1', '2026-09-10', 1, 'scored', 0, 'published')").run();
  db.prepare("INSERT INTO game_lineups VALUES ('ig1', 'lineup-1')").run();
  db.prepare("INSERT INTO game_scoring_revisions VALUES ('score-1', 'ig1', 'lineup-1', 1, 'completed')").run();
  db.prepare("INSERT INTO ranking_test_game_settings VALUES ('ig1', 1, 'admin', '2026-09-10', '2026-09-10')").run();
  db.prepare("INSERT INTO ranking_test_predictions VALUES ('ig1', 1, '{}', 'scored', 99, 99, 'lineup-1', 'score-1', '2026-09-10', '2026-09-10', '2026-09-10')").run();
  db.prepare("INSERT INTO ranking_test_predictions VALUES ('ig1', 2, '{}', 'scored', 99, 99, 'lineup-1', 'score-1', '2026-09-10', '2026-09-10', '2026-09-10')").run();
  db.prepare("INSERT INTO ranking_test_global_settings VALUES (1, 0, '{}', 'admin', '2026-09-10', '2026-09-10')").run();
  return db;
}

test("0037/0038は必要なテーブルだけを追加し、clean/existing DBへ冪等適用できる", () => {
  const db = createMinimalMigrationDb();
  db.exec(migration);
  db.exec(globalMigration);
  assert.doesNotThrow(() => db.exec(migration));
  assert.doesNotThrow(() => db.exec(globalMigration));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ranking_test_%' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ["ranking_test_game_settings", "ranking_test_global_settings", "ranking_test_predictions"]);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ranking_test_predictions'").get().sql.includes("slot BETWEEN 1 AND 9"), true);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ranking_test_global_settings'").get().sql.includes("id = 1"), true);
});

test("TEST position mapping and fixed names are explicit", () => {
  assert.equal(normalizeRankingTestPosition("0"), "指");
  assert.equal(normalizeRankingTestPosition("9"), "右");
  assert.equal(normalizeRankingTestPosition("10"), null);
  assert.equal(RANKING_TEST_POSITION_CANONICAL[1], "投");
  assert.equal(rankingTestUsername(9), "S9_TEST_9");
  assert.equal(defaultRankingTestDisplayName(3), "S9_TEST_3");
  assert.deepEqual(normalizeRankingTestDisplayName("  まりすA  "), { ok: true, value: "まりすA" });
  assert.equal(normalizeRankingTestDisplayName("a").ok, false);
  assert.equal(normalizeRankingTestDisplayName("安全<3").ok, false);
});

test("admin TEST rows support save/reload/clear and per-game toggle state", async () => {
  const db = createMinimalMigrationDb();
  const d1 = adapter(db);
  db.prepare("INSERT INTO games VALUES ('ig1')").run();
  await upsertRankingTestPrediction(d1, { internalGameId: "ig1", slot: 1, predictionJson: JSON.stringify({ schemaVersion: 1, lineup: [] }), now: new Date("2026-09-10T00:00:00Z") });
  await updateRankingTestToggle(d1, { internalGameId: "ig1", includeInPublicRanking: true, updatedBy: "admin-1", now: new Date("2026-09-10T00:00:00Z") });
  let state = await getRankingTestState(d1, "ig1");
  assert.equal(state.setting.includeInPublicRanking, true);
  assert.equal(state.slots[0].prediction.schemaVersion, 1);
  await deleteRankingTestPrediction(d1, { internalGameId: "ig1", slot: 1 });
  state = await getRankingTestState(d1, "ig1");
  assert.equal(state.slots[0].prediction, null);
  assert.equal(state.setting.includeInPublicRanking, true);
});

test("global settings and display names persist without changing slot identity", async () => {
  const db = createMinimalMigrationDb();
  const d1 = adapter(db);
  const before = await getRankingTestGlobalSettings(d1);
  assert.equal(before.globalEnabled, false);
  assert.equal(before.displayNames["1"], "S9_TEST_1");
  await updateRankingTestGlobalSettings(d1, { globalEnabled: true, slotNames: {}, updatedBy: "admin-1", now: new Date("2026-09-10T00:00:00Z") });
  await updateRankingTestDisplayName(d1, { slot: 3, displayName: "まりすA", updatedBy: "admin-1", now: new Date("2026-09-10T00:00:01Z") });
  const after = await getRankingTestGlobalSettings(d1);
  assert.equal(after.globalEnabled, true);
  assert.equal(after.slotNames["3"], "まりすA");
  assert.equal(after.displayNames["1"], "S9_TEST_1");
  assert.equal(after.displayNames["3"], "まりすA");
});

test("public period ranking merges current TEST rows only when toggle and lineage are valid", async () => {
  const db = createRankingDb();
  const d1 = adapter(db);
  let ranking = await getRankingForPeriod(d1, { limit: 50, offset: 0, qualifiedOnly: false, startAt: "2026-09-01", endAt: "2026-10-01", includeTestUsers: true });
  assert.deepEqual(ranking.rows.map((row) => row.username), ["S9_TEST_1", "S9_TEST_2"]);
  assert.equal(ranking.rows[0].totalScore, 99);
  db.prepare("UPDATE ranking_test_game_settings SET include_in_public_ranking = 0").run();
  ranking = await getRankingForPeriod(d1, { limit: 50, offset: 0, qualifiedOnly: false, startAt: "2026-09-01", endAt: "2026-10-01", includeTestUsers: true });
  assert.equal(ranking.rows.length, 0);
  db.prepare("UPDATE ranking_test_game_settings SET include_in_public_ranking = 1").run();
  db.prepare("UPDATE ranking_test_predictions SET scoring_revision_id = 'old' WHERE slot = 2").run();
  ranking = await getRankingForPeriod(d1, { limit: 50, offset: 0, qualifiedOnly: false, startAt: "2026-09-01", endAt: "2026-10-01", includeTestUsers: true });
  assert.deepEqual(ranking.rows.map((row) => row.username), ["S9_TEST_1"]);
});

test("global ON includes game-OFF TEST rows, OFF restores game-only behavior, and names flow to all periods", async () => {
  const db = createRankingDb();
  const d1 = adapter(db);
  db.prepare("UPDATE ranking_test_game_settings SET include_in_public_ranking = 0").run();
  await updateRankingTestGlobalSettings(d1, { globalEnabled: true, slotNames: { "1": "まりすA" }, updatedBy: "admin", now: new Date("2026-09-10T00:00:00Z") });
  let ranking = await getRankingForPeriod(d1, { limit: 50, offset: 0, qualifiedOnly: false, startAt: "2026-09-01", endAt: "2026-10-01", includeTestUsers: true });
  assert.deepEqual(ranking.rows.map((row) => row.username), ["まりすA", "S9_TEST_2"]);
  await updateRankingTestGlobalSettings(d1, { globalEnabled: false, slotNames: { "1": "まりすA" }, updatedBy: "admin", now: new Date("2026-09-10T00:00:01Z") });
  ranking = await getRankingForPeriod(d1, { limit: 50, offset: 0, qualifiedOnly: false, startAt: "2026-09-01", endAt: "2026-10-01", includeTestUsers: true });
  assert.equal(ranking.rows.length, 0);
  db.prepare("UPDATE ranking_test_game_settings SET include_in_public_ranking = 1").run();
  ranking = await getRankingForPeriod(d1, { limit: 50, offset: 0, qualifiedOnly: false, startAt: "2026-09-01", endAt: "2026-10-01", includeTestUsers: true });
  assert.equal(ranking.rows[0].username, "まりすA");
  assert.equal(ranking.rows[0].totalScore, 99);
});

test("TEST feature is admin-only and isolated from real-user endpoints/data", () => {
  assert.match(worker, /ranking-test-users/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /scorePredictionLineup\(validation\.lineup, actual\.lineup\)/);
  assert.match(worker, /RANKING_TEST_TOGGLE_CONFIRMATION_REQUIRED/);
  assert.match(worker, /supplemental_score_failed/);
  assert.match(worker, /includeTestUsers: true/);
  assert.match(renderer, /TEST 1/);
  assert.match(renderer, /0=DH/);
  assert.match(renderer, /ranking-test-clear/);
  assert.match(renderer, /ranking-test-toggle/);
  assert.match(worker, /GLOBAL TEST USERS ON/);
  assert.match(worker, /RANKING_TEST_DISPLAY_NAME_DUPLICATE/);
  assert.match(renderer, /ranking-test-global/);
  assert.match(renderer, /ranking-test-name/);
});
