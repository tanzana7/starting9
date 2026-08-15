const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const rankingRenderer = fs.readFileSync(path.join(root, "frontend", "public", "render-ranking.js"), "utf8");
const publicState = fs.readFileSync(path.join(root, "frontend", "public", "state.js"), "utf8");
const style = fs.readFileSync(path.join(root, "style.css"), "utf8");

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0001_auth.sql", "0003_predictions.sql", "0004_admin_role.sql", "0005_game_lineups.sql", "0006_user_achievements.sql", "0007_all_time_ranking.sql", "0008_monthly_ranking.sql", "0009_pregame_automation.sql", "0010_game_day_schedule_flow.sql"]) {
    db.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
  }
  return db;
}

function createD1Adapter(db) {
  return {
    prepare(sql) {
      return {
        bind(...bindings) {
          const statement = db.prepare(sql);
          return {
            async first() {
              return statement.get(...bindings) || null;
            },
            async all() {
              return { results: statement.all(...bindings) };
            }
          };
        }
      };
    }
  };
}

function insertUser(db, id, username) {
  db.prepare(
    `INSERT INTO users
       (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at, status, role)
     VALUES (?1, ?2, ?2, 'hash', 'salt', 100000, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z', 'active', 'user')`
  ).run(id, username);
}

function insertGame(db, gameId, gameDate, publicationStatus = "published") {
  db.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game, publication_status, created_at, updated_at)
     VALUES (?1, ?2, 1, '2026-08-10T10:00:00.000Z', 'scored', 0, ?3, '2026-08-10T10:00:00.000Z', '2026-08-10T10:00:00.000Z')`
  ).run(gameId, gameDate, publicationStatus);
}

function insertPrediction(db, id, gameId, userId) {
  db.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version, game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, status, score, max_score, scored_at, is_test_prediction)
     VALUES (?1, ?2, ?3, '{}', 1, ?4, 'f', 'm', 'm', 1, ?5, ?5, 'scored', 90, 100, ?5, 0)`
  ).run(id, userId, gameId, "2026-08-10", "2026-08-10T10:00:00.000Z");
}

test("JST週間境界は月曜00:00から翌月曜00:00をUTCへ正しく対応付ける", async () => {
  const { getJstWeekRange } = await import(pathToFileURL(path.join(root, "backend", "domain", "ranking.js")).href);
  const range = getJstWeekRange(new Date("2026-08-13T00:00:00.000Z"));
  assert.deepEqual(range, {
    periodType: "weekly",
    periodKey: "2026-08-10",
    startAt: "2026-08-10",
    endAt: "2026-08-17",
    startAtUtc: "2026-08-09T15:00:00.000Z",
    endAtUtc: "2026-08-16T15:00:00.000Z"
  });
  assert.equal(getJstWeekRange(new Date("2026-08-09T14:59:59.000Z")).startAt, "2026-08-03");
  assert.equal(getJstWeekRange(new Date("2026-08-09T15:00:00.000Z")).startAt, "2026-08-10");
});

test("weekly rankingは週内のpublished試合だけを共通集計し、前週・翌週・未公開を除外する", async () => {
  const { getRankingForPeriod } = await import(pathToFileURL(path.join(root, "backend", "repositories", "ranking-repository.js")).href);
  const db = createDatabase();
  insertUser(db, "u1", "alpha");
  insertGame(db, "inside", "2026-08-10", "published");
  insertGame(db, "private", "2026-08-11", "scored_private");
  insertGame(db, "unpublished", "2026-08-12", "pending");
  insertGame(db, "previous", "2026-08-09", "published");
  insertGame(db, "next", "2026-08-17", "published");
  for (const gameId of ["inside", "private", "unpublished", "previous", "next"]) {
    insertPrediction(db, `p-${gameId}`, gameId, "u1");
  }

  const ranking = await getRankingForPeriod(createD1Adapter(db), {
    limit: 50,
    offset: 0,
    qualifiedOnly: false,
    startAt: "2026-08-10",
    endAt: "2026-08-17",
    periodType: "weekly",
    periodKey: "2026-08-10",
    publishedOnly: true
  });
  assert.equal(ranking.summary.eligibleGames, 1);
  assert.equal(ranking.rows[0].gamesPlayed, 1);
  assert.equal(ranking.rows[0].totalScore, 90);
});

test("weekly APIはcurrent weekを既定にし、月曜以外と未来週を拒否する", async () => {
  const { parseWeeklyRankingQuery } = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);
  const now = new Date("2026-08-13T00:00:00.000Z");
  const current = parseWeeklyRankingQuery(new URLSearchParams(), now);
  assert.equal(current.ok, true);
  assert.equal(current.weekStart, "2026-08-10");
  assert.equal(current.endAt, "2026-08-17");
  assert.equal(parseWeeklyRankingQuery(new URLSearchParams("weekStart=2026-08-11"), now).ok, false);
  assert.equal(parseWeeklyRankingQuery(new URLSearchParams("weekStart=2026-08-17"), now).ok, false);
  assert.match(workerSource, /\/api\/rankings\/weekly/);
  assert.match(workerSource, /\/api\/me\/ranking\/weekly/);
  assert.match(workerSource, /publishedOnly: true/);
});

test("公開画面は年間・月間・週間を切り替え、週間の空表示とモバイル用3分割タブを持つ", () => {
  assert.match(html, /id="showWeeklyRankingButton" class="ranking-tab is-active"[^>]*>週間<\/button>/);
  assert.match(html, /id="showMonthlyRankingButton"/);
  assert.match(html, /id="showYearlyRankingButton" class="ranking-tab"[^>]*>年間<\/button>/);
  assert.ok(html.indexOf(">週間</button>") < html.indexOf(">月間</button>"));
  assert.ok(html.indexOf(">月間</button>") < html.indexOf(">年間</button>"));
  assert.match(html, /public-roster-warning-clear-shibata-master-1/);
  assert.match(script, /function refreshWeeklyRanking/);
  assert.match(script, /buildWeeklyRankingApiUrl/);
  assert.match(script, /selectRankingView\("weekly"\)/);
  assert.match(script, /rankingView: "weekly"/);
  assert.match(script, /今週はまだ公開済み試合がありません/);
  assert.match(rankingRenderer, /showWeeklyRankingButton/);
  assert.match(publicState, /weekly: state\.weeklyRanking/);
  assert.match(style, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});

test("週間ランキングの表示終了日は排他的な翌月曜ではなく日曜にする", () => {
  assert.match(script, /function formatWeeklyRankingDisplayEnd\(endExclusive\)/);
  assert.match(script, /endDate\.setUTCDate\(endDate\.getUTCDate\(\) - 1\)/);
  assert.match(script, /const weekEnd = formatWeeklyRankingDisplayEnd\(weekRange\.endAt\)/);
  assert.match(script, /const weekRange = getJapanWeekRange\(new Date\(`\$\{ranking\.weekStart\}T12:00:00\+09:00`\)\)/);
});
