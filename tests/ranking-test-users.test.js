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
import {
  getRankingTestPresetDefinition,
  getRankingTestPresetSummaries,
  resolveRankingTestPreset
} from "../backend/domain/ranking-test-presets.js";
import { getRankingForPeriod } from "../backend/repositories/ranking-repository.js";
import { scoreRankingTestPredictionsForGame } from "../auth-worker.js";

const root = path.join(import.meta.dirname, "..");
const migration = fs.readFileSync(path.join(root, "migrations", "0037_ranking_test_users.sql"), "utf8");
const globalMigration = fs.readFileSync(path.join(root, "migrations", "0038_ranking_test_global_settings.sql"), "utf8");
const defaultOnMigration = fs.readFileSync(path.join(root, "migrations", "0039_ranking_test_global_default_on.sql"), "utf8");
const enableExistingDefaultMigration = fs.readFileSync(path.join(root, "migrations", "0040_ranking_test_global_enable_existing_default.sql"), "utf8");
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
  db.exec(defaultOnMigration);
  db.exec(enableExistingDefaultMigration);
  return db;
}

function createGlobalSettingsDbWithoutDefaultMigration() {
  const db = new DatabaseSync(":memory:");
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

test("0037〜0040は必要なschema/defaultだけを追加し、clean/existing DBへ冪等適用できる", () => {
  const db = createMinimalMigrationDb();
  db.exec(migration);
  db.exec(globalMigration);
  db.exec(defaultOnMigration);
  db.exec(enableExistingDefaultMigration);
  assert.doesNotThrow(() => db.exec(migration));
  assert.doesNotThrow(() => db.exec(globalMigration));
  assert.doesNotThrow(() => db.exec(defaultOnMigration));
  assert.doesNotThrow(() => db.exec(enableExistingDefaultMigration));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ranking_test_%' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ["ranking_test_game_settings", "ranking_test_global_settings", "ranking_test_predictions"]);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ranking_test_predictions'").get().sql.includes("slot BETWEEN 1 AND 9"), true);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ranking_test_global_settings'").get().sql.includes("id = 1"), true);
  assert.equal(db.prepare("SELECT global_enabled FROM ranking_test_global_settings WHERE id = 1").get().global_enabled, 1);
});

test("0040は0038由来の既存OFFだけを一度ONへ移行し、その後の明示OFFを尊重する", async () => {
  const db = createGlobalSettingsDbWithoutDefaultMigration();
  db.prepare(
    "INSERT INTO ranking_test_global_settings (id, global_enabled, slot_names_json, updated_by, created_at, updated_at) VALUES (1, 0, '{}', 'migration:0038_default', '2026-09-10', '2026-09-10')"
  ).run();
  db.exec(defaultOnMigration);
  assert.equal(db.prepare("SELECT global_enabled FROM ranking_test_global_settings WHERE id = 1").get().global_enabled, 0);
  db.exec(enableExistingDefaultMigration);
  assert.equal(db.prepare("SELECT global_enabled FROM ranking_test_global_settings WHERE id = 1").get().global_enabled, 1);

  const d1 = adapter(db);
  await updateRankingTestGlobalSettings(d1, { globalEnabled: false, slotNames: {}, updatedBy: "admin", now: new Date("2026-09-10T00:00:01Z") });
  assert.equal((await getRankingTestGlobalSettings(d1)).globalEnabled, false);
  // A new repository instance represents a Worker restart/deploy read.
  assert.equal((await getRankingTestGlobalSettings(adapter(db))).globalEnabled, false);
});

test("global setting is ON when unset, while explicit OFF survives the default migration", async () => {
  const unsetDb = createGlobalSettingsDbWithoutDefaultMigration();
  const unset = await getRankingTestGlobalSettings(adapter(unsetDb));
  assert.equal(unset.schemaAvailable, true);
  assert.equal(unset.globalEnabled, true);

  const explicitOffDb = createGlobalSettingsDbWithoutDefaultMigration();
  explicitOffDb.prepare(
    "INSERT INTO ranking_test_global_settings (id, global_enabled, slot_names_json, updated_by, created_at, updated_at) VALUES (1, 0, '{}', 'admin', '2026-09-10', '2026-09-10')"
  ).run();
  explicitOffDb.exec(defaultOnMigration);
  assert.equal(explicitOffDb.prepare("SELECT global_enabled FROM ranking_test_global_settings WHERE id = 1").get().global_enabled, 0);
  assert.equal((await getRankingTestGlobalSettings(adapter(explicitOffDb))).globalEnabled, false);
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

test("T1〜T9固定プリセットはFighters masterへ解決され、指定順と守備を保持する", () => {
  const expected = {
    1: [["水谷瞬", 7], ["水野達稀", 6], ["レイエス", 0], ["野村佑希", 9], ["清宮幸太郎", 3], ["有薗直輝", 5], ["奈良間大己", 4], ["田宮裕涼", 2], ["五十幡亮汰", 8]],
    2: [["水野達稀", 6], ["水谷瞬", 7], ["レイエス", 0], ["清宮幸太郎", 3], ["吉田賢吾", 9], ["大塚瑠晏", 4], ["カストロ", 8], ["田宮裕涼", 2], ["奈良間大己", 5]],
    3: [["郡司裕也", 3], ["水野達稀", 6], ["レイエス", 0], ["有薗直輝", 5], ["野村佑希", 7], ["万波中正", 9], ["カストロ", 8], ["山縣秀", 4], ["進藤勇也", 2]],
    4: [["五十幡亮汰", 8], ["水野達稀", 6], ["レイエス", 0], ["野村佑希", 9], ["吉田賢吾", 7], ["清宮幸太郎", 3], ["大塚瑠晏", 4], ["郡司裕也", 2], ["山縣秀", 5]],
    5: [["万波中正", 9], ["水野達稀", 6], ["レイエス", 0], ["野村佑希", 8], ["清宮幸太郎", 3], ["吉田賢吾", 7], ["郡司裕也", 2], ["有薗直輝", 5], ["カストロ", 4]],
    6: [["水野達稀", 6], ["万波中正", 9], ["レイエス", 0], ["カストロ", 8], ["清宮幸太郎", 3], ["野村佑希", 5], ["奈良間大己", 4], ["田宮裕涼", 2], ["水谷瞬", 7]],
    7: [["今川優馬", 7], ["山縣秀", 6], ["レイエス", 0], ["野村佑希", 9], ["カストロ", 8], ["吉田賢吾", 3], ["有薗直輝", 5], ["奈良間大己", 4], ["進藤勇也", 2]],
    8: [["郡司裕也", 5], ["水野達稀", 6], ["レイエス", 0], ["万波中正", 9], ["大塚瑠晏", 8], ["野村佑希", 7], ["清宮幸太郎", 3], ["山縣秀", 4], ["田宮裕涼", 2]],
    9: [["水野達稀", 6], ["郡司裕也", 2], ["レイエス", 0], ["万波中正", 9], ["野村佑希", 5], ["清宮幸太郎", 3], ["吉田賢吾", 7], ["細川凌平", 8], ["山縣秀", 4]]
  };
  for (const [slot, rows] of Object.entries(expected)) {
    const preset = resolveRankingTestPreset(Number(slot));
    assert.equal(preset.ok, true, `TEST ${slot} should resolve`);
    assert.equal(preset.lineup.length, 9);
    assert.deepEqual(preset.definition.map((row) => [row.playerName, row.position]), rows);
    assert.equal(new Set(preset.lineup.map((row) => row.playerId)).size, 9);
    assert.equal(new Set(preset.lineup.map((row) => row.position).filter((position) => position !== "指")).size, 8);
  }
  const t8 = resolveRankingTestPreset(8);
  assert.equal(t8.lineup[4].playerName, "大塚瑠晏");
  assert.equal(t8.lineup[4].position, "中");
  assert.equal(t8.lineup[7].playerName, "山縣秀");
  assert.equal(t8.lineup[7].position, "二");
  assert.doesNotMatch(JSON.stringify(t8.definition), /細川/);
  assert.equal(getRankingTestPresetDefinition(8)[0].positionLabel, "3B");
  assert.equal(getRankingTestPresetSummaries()["9"].ok, true);
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

test("global settings default ON and display names persist without changing slot identity", async () => {
  const db = createMinimalMigrationDb();
  const d1 = adapter(db);
  const before = await getRankingTestGlobalSettings(d1);
  assert.equal(before.globalEnabled, true);
  assert.equal(before.displayNames["1"], "S9_TEST_1");
  await updateRankingTestGlobalSettings(d1, { globalEnabled: true, slotNames: {}, updatedBy: "admin-1", now: new Date("2026-09-10T00:00:00Z") });
  await updateRankingTestDisplayName(d1, { slot: 3, displayName: "まりすA", updatedBy: "admin-1", now: new Date("2026-09-10T00:00:01Z") });
  const after = await getRankingTestGlobalSettings(d1);
  assert.equal(after.globalEnabled, true);
  assert.equal(after.slotNames["3"], "まりすA");
  assert.equal(after.displayNames["1"], "S9_TEST_1");
  assert.equal(after.displayNames["3"], "まりすA");
});

test("ranking treats an absent global singleton as ON and keeps count/pagination consistent", async () => {
  const db = createRankingDb();
  const d1 = adapter(db);
  db.prepare("DELETE FROM ranking_test_global_settings").run();
  db.prepare("UPDATE ranking_test_game_settings SET include_in_public_ranking = 0").run();
  const firstPage = await getRankingForPeriod(d1, { limit: 1, offset: 0, qualifiedOnly: false, startAt: "2026-09-01", endAt: "2026-10-01", includeTestUsers: true });
  const secondPage = await getRankingForPeriod(d1, { limit: 1, offset: 1, qualifiedOnly: false, startAt: "2026-09-01", endAt: "2026-10-01", includeTestUsers: true });
  assert.equal(firstPage.pagination.totalUsers, 2);
  assert.equal(secondPage.pagination.totalUsers, 2);
  assert.equal(firstPage.rows.length, 1);
  assert.equal(secondPage.rows.length, 1);
  assert.notEqual(firstPage.rows[0].username, secondPage.rows[0].username);
});

test("repeated TEST materialization is idempotent and does not duplicate doubleheader game rows", async () => {
  const db = createMinimalMigrationDb();
  const d1 = adapter(db);
  db.prepare("INSERT INTO games VALUES ('ig1')").run();
  const first = await scoreRankingTestPredictionsForGame(d1, "ig1", new Date("2026-09-10T00:00:00Z"));
  const second = await scoreRankingTestPredictionsForGame(d1, "ig1", new Date("2026-09-10T00:00:01Z"));
  assert.equal(first.materialized, 9);
  assert.equal(second.materialized, 9);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ranking_test_predictions WHERE internal_game_id = 'ig1'").get().count, 9);

  const rankingDb = createRankingDb();
  rankingDb.prepare("INSERT INTO ranking_games VALUES ('g2', 'ig2', '2026-09-10', 1, 'scored', 0, 'published')").run();
  rankingDb.prepare("INSERT INTO game_lineups VALUES ('ig2', 'lineup-2')").run();
  rankingDb.prepare("INSERT INTO game_scoring_revisions VALUES ('score-2', 'ig2', 'lineup-2', 1, 'completed')").run();
  rankingDb.prepare("INSERT INTO ranking_test_game_settings VALUES ('ig2', 1, 'admin', '2026-09-10', '2026-09-10')").run();
  rankingDb.prepare("INSERT INTO ranking_test_predictions VALUES ('ig2', 1, '{}', 'scored', 90, 99, 'lineup-2', 'score-2', '2026-09-10', '2026-09-10', '2026-09-10')").run();
  const combined = await getRankingForPeriod(adapter(rankingDb), { limit: 50, offset: 0, qualifiedOnly: false, startAt: "2026-09-01", endAt: "2026-10-01", includeTestUsers: true });
  const t1 = combined.rows.find((row) => row.username === "S9_TEST_1");
  assert.equal(t1.gamesPlayed, 2);
  assert.equal(t1.totalScore, 189);
  assert.equal(combined.pagination.totalUsers, 2);
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

test("global/game toggle ONはmanual saveなしで固定presetを専用tableへmaterializeし、OFFはwriteしない", async () => {
  const db = createMinimalMigrationDb();
  const d1 = adapter(db);
  db.prepare("INSERT INTO games VALUES ('ig1')").run();
  await updateRankingTestGlobalSettings(d1, { globalEnabled: true, slotNames: {}, updatedBy: "admin", now: new Date("2026-09-10T00:00:00Z") });
  let result = await scoreRankingTestPredictionsForGame(d1, "ig1", new Date("2026-09-10T00:00:00Z"));
  assert.equal(result.materialized, 9);
  assert.equal(result.invalid, 0);
  assert.deepEqual(result.warnings, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ranking_test_predictions").get().count, 9);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().count, 0);
  const before = db.prepare("SELECT COUNT(*) AS count FROM ranking_test_predictions").get().count;
  await updateRankingTestGlobalSettings(d1, { globalEnabled: false, slotNames: {}, updatedBy: "admin", now: new Date("2026-09-10T00:00:01Z") });
  result = await scoreRankingTestPredictionsForGame(d1, "ig1", new Date("2026-09-10T00:00:01Z"));
  assert.equal(result.materialized, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ranking_test_predictions").get().count, before);

  const gameOnlyDb = createMinimalMigrationDb();
  const gameOnly = adapter(gameOnlyDb);
  gameOnlyDb.prepare("INSERT INTO games VALUES ('ig2')").run();
  await updateRankingTestToggle(gameOnly, { internalGameId: "ig2", includeInPublicRanking: true, updatedBy: "admin", now: new Date("2026-09-10T00:00:00Z") });
  result = await scoreRankingTestPredictionsForGame(gameOnly, "ig2", new Date("2026-09-10T00:00:00Z"));
  assert.equal(result.materialized, 9);
  assert.equal(result.invalid, 0);
  assert.equal(gameOnlyDb.prepare("SELECT COUNT(*) AS count FROM ranking_test_predictions").get().count, 9);
});

test("TEST feature is admin-only and isolated from real-user endpoints/data", () => {
  assert.match(worker, /ranking-test-users/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /scorePredictionLineup\(validation\.lineup, actual\.lineup\)/);
  assert.match(worker, /RANKING_TEST_TOGGLE_CONFIRMATION_REQUIRED/);
  assert.match(worker, /supplemental_score_failed/);
  assert.match(worker, /includeTestUsers: true/);
  assert.match(worker, /RANKING_TEST_FIXED_PRESET_ONLY/);
  assert.match(worker, /materializeRankingTestPresetsForGame/);
  assert.match(renderer, /TEST 1/);
  assert.match(renderer, /0: "DH"/);
  assert.match(renderer, /固定プリセット/);
  assert.doesNotMatch(renderer, /data-v3-ranking-test-field|data-v3-ranking-test-save|data-v3-ranking-test-clear/);
  assert.match(renderer, /ranking-test-toggle/);
  assert.match(worker, /GLOBAL TEST USERS ON/);
  assert.match(worker, /RANKING_TEST_DISPLAY_NAME_DUPLICATE/);
  assert.match(renderer, /ranking-test-global/);
  assert.match(renderer, /ranking-test-name/);
});
