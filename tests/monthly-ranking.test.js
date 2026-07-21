const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0008_monthly_ranking.sql"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0001_auth.sql", "0003_predictions.sql", "0004_admin_role.sql", "0006_user_achievements.sql", "0007_all_time_ranking.sql", "0008_monthly_ranking.sql"]) {
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

function insertRankingGame(db, gameId, gameDate, { eligible = 1, testGame = 0 } = {}) {
  db.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game, created_at, updated_at)
     VALUES (?1, ?2, ?3, '2026-07-21T10:00:00.000Z', 'scored', ?4, '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z')`
  ).run(gameId, gameDate, eligible, testGame);
}

function insertPrediction(db, { id, userId, gameId, score, isTest = 0, status = "scored" }) {
  db.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version, game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, status, score, max_score, scored_at, is_test_prediction)
     VALUES (?1, ?2, ?3, '{"schemaVersion":1,"lineup":[]}', 1, '2026-07-21', 'f', 'm', 'm', 1,
             '2026-07-21T10:00:00.000Z', '2026-07-21T10:00:00.000Z', ?4, ?5, 100, '2026-07-21T10:00:00.000Z', ?6)`
  ).run(id, userId, gameId, status, score, isTest);
}

function getRankingCte() {
  const match = /function createAllTimeRankingCte\(\) \{[\s\S]*?return `([\s\S]*?)`;\r?\n\}/.exec(worker);
  assert.ok(match, "Workerの共通ランキング集計CTEを取得できること");
  return match[1];
}

function monthRange(year, month) {
  return {
    startAt: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`,
    endAt: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10)
  };
}

test("月間migrationは推測しない試合日と月別集計索引を追加する", () => {
  assert.match(migration, /ADD COLUMN game_date/);
  assert.match(migration, /game_date IS NULL/);
  assert.match(migration, /idx_ranking_games_monthly/);
});

test("月範囲は年跨ぎとうるう年を正しく切り替える", () => {
  assert.deepEqual(monthRange(2026, 1), { startAt: "2026-01-01", endAt: "2026-02-01" });
  assert.deepEqual(monthRange(2026, 12), { startAt: "2026-12-01", endAt: "2027-01-01" });
  assert.deepEqual(monthRange(2028, 2), { startAt: "2028-02-01", endAt: "2028-03-01" });
});

test("月間ランキングは試合日で対象月のみを集計し、規定と競技順位を適用する", () => {
  const db = createDatabase();
  for (const [id, username] of [["u1", "alpha"], ["u2", "bravo"], ["u3", "charlie"], ["u4", "delta"]]) {
    insertUser(db, id, username);
  }
  for (const [gameId, gameDate] of [["j1", "2026-07-01"], ["j2", "2026-07-15"], ["j3", "2026-07-31"], ["a1", "2026-08-01"]]) {
    insertRankingGame(db, gameId, gameDate);
  }
  insertRankingGame(db, "test-july", "2026-07-20", { testGame: 1 });

  insertPrediction(db, { id: "a1", userId: "u1", gameId: "j1", score: 100 });
  insertPrediction(db, { id: "a2", userId: "u1", gameId: "j2", score: 80 });
  insertPrediction(db, { id: "b1", userId: "u2", gameId: "j1", score: 90 });
  insertPrediction(db, { id: "b2", userId: "u2", gameId: "j2", score: 90 });
  insertPrediction(db, { id: "c1", userId: "u3", gameId: "j1", score: 100 });
  insertPrediction(db, { id: "d1", userId: "u4", gameId: "a1", score: 100 });
  insertPrediction(db, { id: "test1", userId: "u1", gameId: "j3", score: 100, isTest: 1 });
  insertPrediction(db, { id: "unscored", userId: "u2", gameId: "j3", score: null, status: "submitted" });

  const { startAt, endAt } = monthRange(2026, 7);
  const rows = db.prepare(`${getRankingCte()}
    SELECT username, games_played, total_score, perfect_count, is_qualified, games_needed, ranking_rank
      FROM combined
     ORDER BY is_qualified DESC, ranking_rank ASC, username ASC`).all(startAt, endAt).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { username: "alpha", games_played: 2, total_score: 180, perfect_count: 1, is_qualified: 1, games_needed: 0, ranking_rank: 1 },
    { username: "bravo", games_played: 2, total_score: 180, perfect_count: 0, is_qualified: 1, games_needed: 0, ranking_rank: 2 },
    { username: "charlie", games_played: 1, total_score: 100, perfect_count: 1, is_qualified: 0, games_needed: 1, ranking_rank: null }
  ]);

  const allTimeGameCount = db.prepare(`${getRankingCte()} SELECT MAX(eligible_games) AS count FROM combined`).get(null, null).count;
  assert.equal(allTimeGameCount, 4, "通算の対象試合数は月間フィルターで減らないこと");
});

test("月間APIは公開・本人取得を分け、未来月と不正値を拒否する実装を持つ", () => {
  assert.match(worker, /\/api\/rankings\/monthly/);
  assert.match(worker, /\/api\/me\/ranking\/monthly/);
  assert.match(worker, /requireAuthenticatedUser\(request, env, cors\)/);
  assert.match(worker, /未来月の月間ランキングは取得できません/);
  assert.match(worker, /yearは有効な4桁の年/);
  assert.match(worker, /monthは1から12/);
  assert.match(worker, /game_date >= \?1/);
  assert.match(worker, /Cache-Control", "public, max-age=30/);
});

test("通常画面は通算と月間を切り替え、月移動と自動取得を持つが手動再読み込みは置かない", () => {
  assert.match(html, /id="showAllTimeRankingButton"/);
  assert.match(html, /id="showMonthlyRankingButton"/);
  assert.match(script, /function selectRankingView/);
  assert.match(script, /function handleMonthlyRankingContentClick/);
  assert.match(script, /function refreshMonthlyRanking/);
  assert.match(script, /前月/);
  assert.match(script, /次月/);
  assert.match(script, /refreshMonthlyRanking\(\{ force: true \}\)/);
  assert.doesNotMatch(html, /reloadMonthlyRankingButton/);
  assert.doesNotMatch(script, /reloadMonthlyRankingButton/);
});
