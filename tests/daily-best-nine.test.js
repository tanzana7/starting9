import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;

function createD1Adapter(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        bind(...values) {
          return {
            async first() { return statement.get(...values) || null; },
            async all() { return { results: statement.all(...values) }; },
            async run() { return { meta: { changes: statement.run(...values).changes } }; }
          };
        }
      };
    }
  };
}

function createDatabase({ published = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE games (
      internal_game_id TEXT PRIMARY KEY, game_date TEXT NOT NULL, start_time TEXT NOT NULL,
      home_team TEXT NOT NULL, away_team TEXT NOT NULL, game_status TEXT NOT NULL,
      npb_game_code TEXT, stadium TEXT
    );
    CREATE TABLE game_identifiers (
      id INTEGER PRIMARY KEY, internal_game_id TEXT NOT NULL, provider TEXT NOT NULL,
      identifier_type TEXT NOT NULL, identifier_value TEXT NOT NULL
    );
    CREATE TABLE detected_game_schedule (
      game_id TEXT PRIMARY KEY, source_game_key TEXT, game_date TEXT NOT NULL, start_at TEXT NOT NULL,
      home_team TEXT NOT NULL, away_team TEXT NOT NULL, game_code TEXT, game_status TEXT,
      internal_game_id TEXT, updated_at TEXT
    );
    CREATE TABLE ranking_games (
      game_id TEXT PRIMARY KEY, internal_game_id TEXT, game_date TEXT NOT NULL,
      is_ranking_eligible INTEGER NOT NULL, ranking_eligible_at TEXT, game_status TEXT NOT NULL,
      is_test_game INTEGER NOT NULL, publication_status TEXT NOT NULL, scored_private_at TEXT,
      published_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE predictions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, game_id TEXT NOT NULL, score INTEGER,
      max_score INTEGER, submitted_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      status TEXT NOT NULL, is_test_prediction INTEGER NOT NULL
    );
  `);
  const gameId = "legacy-f-l-19-1800";
  const internalGameId = "022a8838-9e5c-4d64-88b7-7a8b43181aed";
  db.prepare("INSERT INTO games VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    internalGameId, "2026-08-12", "2026-08-12T09:00:00.000Z", "fighters", "lions", "scored", "f-l-19", ""
  );
  db.prepare("INSERT INTO detected_game_schedule VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    gameId, "2026-08-12:fighters:lions:1800", "2026-08-12", "2026-08-12T09:00:00.000Z", "fighters", "lions", "f-l-19", "scored", internalGameId, "2026-08-12T09:00:00.000Z"
  );
  db.prepare("INSERT INTO ranking_games VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    gameId, internalGameId, "2026-08-12", 1, "2026-08-12T09:00:00.000Z", "scored", 0,
    published ? "published" : "pending", "2026-08-12T09:05:00.000Z", published ? "2026-08-12T09:10:00.000Z" : null,
    "2026-08-12T09:00:00.000Z", "2026-08-12T09:10:00.000Z"
  );
  return { db, gameId, internalGameId };
}

function insertUser(db, id, username) {
  db.prepare("INSERT INTO users VALUES (?, ?, 'active')").run(id, username);
}

function insertPrediction(db, { id, userId, gameId, score, submittedAt, updatedAt = submittedAt, isTest = 0 }) {
    db.prepare("INSERT INTO predictions VALUES (?, ?, ?, ?, 99, ?, ?, 'scored', ?)").run(
    id, userId, gameId, score, submittedAt, updatedAt, isTest
  );
}

test("今日のベストナインは公開済み採点結果をscore desc、提出時刻、nicknameで最大9人返す", async () => {
  const { getDailyBestNineForGame } = await import(workerUrl);
  const { db, internalGameId, gameId } = createDatabase();
  const users = [
    ["u1", "zeta"], ["u2", "alpha"], ["u3", "early"], ["u4", "four"], ["u5", "five"],
    ["u6", "six"], ["u7", "seven"], ["u8", "eight"], ["u9", "nine"], ["u10", "ten"], ["u11", "eleven"]
  ];
  users.forEach(([id, username]) => insertUser(db, id, username));
  insertPrediction(db, { id: "p1", userId: "u1", gameId, score: 99, submittedAt: "2026-08-12T08:10:00.000Z" });
  insertPrediction(db, { id: "p2", userId: "u2", gameId, score: 99, submittedAt: "2026-08-12T08:00:00.000Z" });
  insertPrediction(db, { id: "p3", userId: "u3", gameId, score: 99, submittedAt: "2026-08-12T08:00:00.000Z" });
  users.slice(3).forEach(([id], index) => insertPrediction(db, {
    id: `p${index + 4}`, userId: id, gameId, score: 98 - index, submittedAt: `2026-08-12T08:${String(index + 1).padStart(2, "0")}:00.000Z`
  }));
  insertPrediction(db, { id: "test", userId: "u11", gameId, score: 99, submittedAt: "2026-08-12T07:00:00.000Z", isTest: 1 });

  const result = await getDailyBestNineForGame(createD1Adapter(db), { internalGameId, legacyGameId: gameId });
  assert.equal(result.totalCount, 11);
  assert.equal(result.rows.length, 9);
  assert.deepEqual(result.rows.slice(0, 3).map((row) => row.username), ["alpha", "early", "zeta"]);
  assert.deepEqual(result.rows.map((row) => row.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(result.rows.every((row) => !Object.hasOwn(row, "userId")), true);
});

test("同時刻の同点はnickname昇順で安定し、満点情報はserver scoreから判定する", async () => {
  const { getDailyBestNineForGame } = await import(workerUrl);
  const { db, internalGameId, gameId } = createDatabase();
  insertUser(db, "u1", "bravo");
  insertUser(db, "u2", "alpha");
  insertPrediction(db, { id: "p1", userId: "u1", gameId, score: 99, submittedAt: "2026-08-12T08:00:00.000Z" });
  insertPrediction(db, { id: "p2", userId: "u2", gameId, score: 99, submittedAt: "2026-08-12T08:00:00.000Z" });
  const result = await getDailyBestNineForGame(createD1Adapter(db), { internalGameId, legacyGameId: gameId });
  assert.deepEqual(result.rows.map((row) => [row.username, row.isPerfect]), [["alpha", true], ["bravo", true]]);
});

test("未公開試合・採点前試合・参加者0件はベストナインを返さない", async () => {
  const { getDailyBestNineForGame } = await import(workerUrl);
  const unpublished = createDatabase({ published: false });
  insertUser(unpublished.db, "u1", "hidden");
  insertPrediction(unpublished.db, { id: "p1", userId: "u1", gameId: unpublished.gameId, score: 99, submittedAt: "2026-08-12T08:00:00.000Z" });
  assert.deepEqual(await getDailyBestNineForGame(createD1Adapter(unpublished.db), unpublished), { rows: [], totalCount: 0 });

  const empty = createDatabase();
  assert.deepEqual(await getDailyBestNineForGame(createD1Adapter(empty.db), empty), { rows: [], totalCount: 0 });
});

test("公開APIはcanonical internalGameIdで公開結果を解決する", async () => {
  const worker = await import(workerUrl);
  const fixture = createDatabase();
  insertUser(fixture.db, "u1", "canonical-user");
  insertPrediction(fixture.db, { id: "p1", userId: "u1", gameId: fixture.gameId, score: 87, submittedAt: "2026-08-12T08:00:00.000Z" });
  const response = await worker.default.fetch(
    new Request(`https://starting9.test/api/results/daily-best-nine?internalGameId=${fixture.internalGameId}`),
    { AUTH_DB: createD1Adapter(fixture.db) },
    {}
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.published, true);
  assert.deepEqual(payload.bestNine.map((row) => row.username), ["canonical-user"]);
});

test("公開APIはclient score/maxScoreを受け付けず、server-side結果だけを返す", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(worker, /\/api\/results\/daily-best-nine/);
  assert.match(worker, /getDailyBestNineForGame\(env\.AUTH_DB/);
  assert.doesNotMatch(worker.slice(worker.indexOf("async function handleGetDailyBestNine"), worker.indexOf("async function handleGetYearlyRanking")), /request\.json|params\.get\("score"\)|params\.get\("maxScore"\)/);
});
