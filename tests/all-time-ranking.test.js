const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0007_all_time_ranking.sql"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

function requiredGames(eligibleGames) {
  return Math.ceil(eligibleGames * 2 / 3);
}

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0001_auth.sql", "0003_predictions.sql", "0004_admin_role.sql", "0006_user_achievements.sql", "0007_all_time_ranking.sql"]) {
    db.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
  }
  return db;
}

function insertUser(db, id, username) {
  db.prepare(
    `INSERT INTO users
       (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at, status, role)
     VALUES (?1, ?2, ?2, 'hash', 'salt', 100000, '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', 'active', 'user')`
  ).run(id, username);
}

function insertRankingGame(db, gameId, eligible = 1) {
  db.prepare(
    `INSERT INTO ranking_games
       (game_id, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game, created_at, updated_at)
     VALUES (?1, ?2, '2026-07-21T10:00:00.000Z', 'scored', 0, '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z')`
  ).run(gameId, eligible);
}

function insertPrediction(db, { id, userId, gameId, score, isTest = 0, scoredAt = "2026-07-21T10:00:00.000Z" }) {
  db.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version, game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, status, score, max_score, scored_at, is_test_prediction)
     VALUES (?1, ?2, ?3, '{"schemaVersion":1,"lineup":[]}', 1, '2026-07-21', 'f', 'm', 'm', 1,
             ?4, ?4, 'scored', ?5, 100, ?4, ?6)`
  ).run(id, userId, gameId, scoredAt, score, isTest);
}

function getRankingCte() {
  const match = /function createAllTimeRankingCte\(\) \{[\s\S]*?return `([\s\S]*?)`;\r?\n\}/.exec(worker);
  assert.ok(match, "Workerのランキング集計CTEを取得できること");
  return match[1];
}

test("必要参加数は対象試合数の3分の2を切り上げる", () => {
  const expected = new Map([[0, 0], [1, 1], [2, 2], [3, 2], [4, 3], [5, 4], [6, 4], [10, 7], [30, 20]]);
  for (const [eligibleGames, required] of expected) {
    assert.equal(requiredGames(eligibleGames), required);
  }
});

test("ランキングmigrationは対象試合とテスト予想の明示フラグ・索引を定義する", () => {
  assert.match(migration, /ADD COLUMN is_test_prediction/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ranking_games/);
  assert.match(migration, /is_ranking_eligible/);
  assert.match(migration, /is_test_game/);
  assert.match(migration, /idx_predictions_ranking_scores/);
  assert.match(migration, /idx_ranking_games_eligible/);
});

test("対象外試合・未採点・テスト予想を除き、規定と競技順位をD1互換SQLiteで集計できる", () => {
  const db = createDatabase();
  insertUser(db, "u1", "alpha");
  insertUser(db, "u2", "bravo");
  insertUser(db, "u3", "charlie");
  insertUser(db, "u4", "dev");
  for (const gameId of ["g1", "g2", "g3"]) insertRankingGame(db, gameId);
  insertRankingGame(db, "outside", 0);

  insertPrediction(db, { id: "p1", userId: "u1", gameId: "g1", score: 100, scoredAt: "2026-07-21T10:00:00.000Z" });
  insertPrediction(db, { id: "p2", userId: "u1", gameId: "g2", score: 80, scoredAt: "2026-07-21T10:01:00.000Z" });
  insertPrediction(db, { id: "p3", userId: "u2", gameId: "g1", score: 90, scoredAt: "2026-07-21T09:00:00.000Z" });
  insertPrediction(db, { id: "p4", userId: "u2", gameId: "g2", score: 90, scoredAt: "2026-07-21T09:01:00.000Z" });
  insertPrediction(db, { id: "p5", userId: "u3", gameId: "g1", score: 100 });
  insertPrediction(db, { id: "p6", userId: "u4", gameId: "g1", score: 100, isTest: 1 });
  insertPrediction(db, { id: "p7", userId: "u1", gameId: "outside", score: 100 });
  db.prepare("UPDATE predictions SET status = 'submitted', score = NULL, scored_at = NULL WHERE id = 'p7'").run();

  const rows = db.prepare(`${getRankingCte()}
    SELECT username, games_played, total_score, perfect_count, is_qualified, ranking_rank
      FROM combined
     ORDER BY is_qualified DESC, ranking_rank ASC, username ASC`).all(null, null).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { username: "alpha", games_played: 2, total_score: 180, perfect_count: 1, is_qualified: 1, ranking_rank: 1 },
    { username: "bravo", games_played: 2, total_score: 180, perfect_count: 0, is_qualified: 1, ranking_rank: 2 },
    { username: "charlie", games_played: 1, total_score: 100, perfect_count: 1, is_qualified: 0, ranking_rank: null }
  ]);
  assert.throws(() => insertPrediction(db, { id: "duplicate", userId: "u1", gameId: "g1", score: 60 }));
});

test("主要指標が同一の規定到達者には競技順位を付け、次順位を飛ばす", () => {
  const db = createDatabase();
  for (const [id, username] of [["u1", "alpha"], ["u2", "bravo"], ["u3", "charlie"]]) insertUser(db, id, username);
  for (const gameId of ["g1", "g2", "g3"]) insertRankingGame(db, gameId);
  for (const userId of ["u1", "u2"]) {
    insertPrediction(db, { id: `${userId}-1`, userId, gameId: "g1", score: 90, scoredAt: "2026-07-21T09:00:00.000Z" });
    insertPrediction(db, { id: `${userId}-2`, userId, gameId: "g2", score: 90, scoredAt: userId === "u1" ? "2026-07-21T10:00:00.000Z" : "2026-07-21T11:00:00.000Z" });
  }
  insertPrediction(db, { id: "u3-1", userId: "u3", gameId: "g1", score: 80, scoredAt: "2026-07-21T09:00:00.000Z" });
  insertPrediction(db, { id: "u3-2", userId: "u3", gameId: "g2", score: 80, scoredAt: "2026-07-21T10:00:00.000Z" });
  const rows = db.prepare(`${getRankingCte()}
    SELECT username, ranking_rank FROM combined WHERE is_qualified = 1 ORDER BY ranking_rank ASC, user_id ASC`).all(null, null).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { username: "alpha", ranking_rank: 1 },
    { username: "bravo", ranking_rank: 1 },
    { username: "charlie", ranking_rank: 3 }
  ]);
});

test("公開ランキングは内部ID・隠し実績・metadataを返さず、本人APIは認証を要求する", () => {
  assert.match(worker, /\/api\/rankings\/all-time/);
  assert.match(worker, /\/api\/me\/ranking\/all-time/);
  assert.match(worker, /requireAuthenticatedUser\(request, env, cors\)/);
  assert.match(worker, /achievements\.is_hidden = 0/);
  assert.match(worker, /RANKING_ACHIEVEMENT_DISPLAY_LIMIT/);
  assert.match(worker, /Cache-Control", "public, max-age=30/);
  assert.match(worker, /ALL_TIME_RANKING_MAX_LIMIT = 100/);
  assert.match(worker, /qualifiedOnly/);
  assert.doesNotMatch(worker, /rankingData:[\s\S]{0,200}userId/);
});

test("通常画面にはカード型の通算ランキングがあり、手動再読み込み導線を置かない", () => {
  assert.match(html, /id="allTimeRankingPanel"/);
  assert.match(script, /function refreshAllTimeRanking/);
  assert.match(script, /function renderAllTimeRanking/);
  assert.match(script, /規定未到達者を見る/);
  assert.match(script, /規定まであと/);
  assert.doesNotMatch(html, /reloadAllTimeRankingButton/);
  assert.doesNotMatch(script, /reloadAllTimeRankingButton/);
});
