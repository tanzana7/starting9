import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;

function createDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const file of ["0001_auth.sql", "0003_predictions.sql", "0004_admin_role.sql", "0007_all_time_ranking.sql", "0008_monthly_ranking.sql"]) {
    database.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
  }
  return createD1Adapter(database);
}

function createD1Adapter(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...values) {
          return {
            async first() { return statement.get(...values) || null; },
            async all() { return { results: statement.all(...values) }; }
          };
        }
      };
    },
    raw: database
  };
}

function insertUser(db, id, username) {
  db.raw.prepare(
    `INSERT INTO users
       (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at, status, role)
     VALUES (?1, ?2, ?2, 'hash', 'salt', 100000, '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z', 'active', 'user')`
  ).run(id, username);
}

function insertRankingGame(db, gameId, gameDate, { eligible = 1, status = "scored" } = {}) {
  db.raw.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game, created_at, updated_at)
     VALUES (?1, ?2, ?3, '2026-07-23T00:00:00.000Z', ?4, 0, '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00.000Z')`
  ).run(gameId, gameDate, eligible, status);
}

function insertPrediction(db, { id, userId, gameId, score, maxScore = 100, status = "scored", submittedAt = "2026-07-23T09:00:00.000Z", updatedAt = submittedAt, opponent = "marines" }) {
  db.raw.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version, game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, status, score, max_score, scored_at, is_test_prediction)
     VALUES (?1, ?2, ?3, '{"schemaVersion":1,"lineup":[]}', 1, '2026-07-23', 'fighters', 'marines', ?4, 1,
             ?5, ?6, ?7, ?8, ?9, ?6, 0)`
  ).run(id, userId, gameId, opponent, submittedAt, updatedAt, status, score, maxScore);
}

test("本日の満点者は公開済み正式採点の満点だけを返す", async () => {
  const { getPerfectAchieversForDate } = await import(authWorkerUrl);
  const db = createDatabase();
  for (const [id, username] of [["u1", "perfect"], ["u2", "near"], ["u3", "hidden"], ["u4", "pending"]]) {
    insertUser(db, id, username);
  }
  insertRankingGame(db, "published", "2026-07-23");
  insertRankingGame(db, "unpublished", "2026-07-23", { eligible: 0 });
  insertPrediction(db, { id: "p1", userId: "u1", gameId: "published", score: 100, submittedAt: "2026-07-23T09:00:00.000Z" });
  insertPrediction(db, { id: "p2", userId: "u2", gameId: "published", score: 99 });
  insertPrediction(db, { id: "p3", userId: "u3", gameId: "unpublished", score: 100 });
  insertPrediction(db, { id: "p4", userId: "u4", gameId: "published", score: null, status: "submitted" });

  const achievers = await getPerfectAchieversForDate(db, { date: "2026-07-23", limit: 50, offset: 0 });
  assert.equal(achievers.totalCount, 1);
  assert.deepEqual(achievers.rows, [{
    username: "perfect",
    score: 100,
    gameDate: "2026-07-23",
    opponent: "marines",
    submittedAt: "2026-07-23T09:00:00.000Z"
  }]);
});

test("同一ユーザー・同一試合は最新提出だけを満点者判定に使う", async () => {
  const { getPerfectAchieversForDate } = await import(authWorkerUrl);
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE ranking_games (game_id TEXT PRIMARY KEY, game_date TEXT NOT NULL, is_ranking_eligible INTEGER NOT NULL, game_status TEXT NOT NULL, is_test_game INTEGER NOT NULL);
    CREATE TABLE predictions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, game_id TEXT NOT NULL, score INTEGER, max_score INTEGER,
      opponent_code TEXT, submitted_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, is_test_prediction INTEGER NOT NULL
    );
  `);
  database.prepare("INSERT INTO users VALUES ('u1', 'latest', 'active')").run();
  database.prepare("INSERT INTO ranking_games VALUES ('g1', '2026-07-23', 1, 'scored', 0)").run();
  database.prepare("INSERT INTO predictions VALUES ('old', 'u1', 'g1', 100, 100, 'hawks', '2026-07-23T09:00:00.000Z', '2026-07-23T09:00:00.000Z', 'scored', 0)").run();
  database.prepare("INSERT INTO predictions VALUES ('new', 'u1', 'g1', NULL, NULL, 'hawks', '2026-07-23T10:00:00.000Z', '2026-07-23T10:00:00.000Z', 'submitted', 0)").run();

  const achievers = await getPerfectAchieversForDate(createD1Adapter(database), { date: "2026-07-23", limit: 50, offset: 0 });
  assert.equal(achievers.totalCount, 0);
  assert.deepEqual(achievers.rows, []);
});

test("満点者がいない日も正常な空結果を返し、月間・年間ランキングの経路を維持する", async () => {
  const { getPerfectAchieversForDate } = await import(authWorkerUrl);
  const db = createDatabase();
  const achievers = await getPerfectAchieversForDate(db, { date: "2026-07-23", limit: 50, offset: 0 });
  assert.deepEqual(achievers, { rows: [], totalCount: 0 });

  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  assert.match(worker, /\/api\/rankings\/perfect/);
  assert.match(worker, /\/api\/rankings\/monthly/);
  assert.match(worker, /\/api\/rankings\/yearly/);
  assert.doesNotMatch(worker, /\/api\/rankings\/daily/);
  assert.match(html, /id="todayPerfectAchieversCard"/);
  assert.match(html, /id="showMonthlyRankingButton"/);
  assert.match(html, /id="showYearlyRankingButton"/);
  assert.doesNotMatch(html, /showDailyRankingButton/);
  assert.match(script, /function fetchTodayPerfectAchievers/);
  assert.match(script, /本日の満点者はいません/);
  assert.doesNotMatch(script, /refreshDailyRanking|showDailyRankingButton|dailyRankingDate/);
});
