import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  getDailyBestNineForGame,
  getPerfectAchieversForDate,
  getRankingEntryForUser,
  getRankingForPeriod
} from "../backend/repositories/ranking-repository.js";
import {
  getEffectiveRankingCutoffBoundary,
  getRankingCutoffBoundary
} from "../backend/domain/ranking.js";

const root = path.join(import.meta.dirname, "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const productionConfig = JSON.parse(fs.readFileSync(path.join(root, "wrangler.auth.production.jsonc"), "utf8"));

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of [
    "0001_auth.sql",
    "0003_predictions.sql",
    "0004_admin_role.sql",
    "0005_game_lineups.sql",
    "0006_user_achievements.sql",
    "0007_all_time_ranking.sql",
    "0008_monthly_ranking.sql",
    "0009_pregame_automation.sql",
    "0010_game_day_schedule_flow.sql",
    "0035_ranking_reset_markers.sql"
  ]) {
    db.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
  }
  return db;
}

function createD1Adapter(db) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              return db.prepare(sql).get(...values) || null;
            },
            async all() {
              return { results: db.prepare(sql).all(...values) };
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
       (id, username, username_normalized, password_hash, password_salt, password_iterations,
        created_at, updated_at, status, role)
     VALUES (?1, ?2, ?2, 'hash', 'salt', 100000, '2026-08-14T00:00:00.000Z',
             '2026-08-14T00:00:00.000Z', 'active', 'user')`
  ).run(id, username);
}

function insertGame(db, gameId, gameDate, publicationStatus = "published") {
  db.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status,
        is_test_game, publication_status, created_at, updated_at)
     VALUES (?1, ?2, 1, ?3, 'scored', 0, ?4, ?3, ?3)`
  ).run(gameId, gameDate, `${gameDate}T10:00:00.000Z`, publicationStatus);
}

function insertPrediction(db, { id, userId, gameId, gameDate, score = 99, submittedAt = `${gameDate}T09:00:00.000Z` }) {
  db.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version, game_date, home_team, away_team,
        opponent_code, is_home, submitted_at, updated_at, status, score, max_score,
        scored_at, is_test_prediction)
     VALUES (?1, ?2, ?3, '{}', 1, ?4, 'fighters', 'lions', 'lions', 1,
             ?5, ?5, 'scored', ?6, 99, ?5, 0)`
  ).run(id, userId, gameId, gameDate, submittedAt, score);
}

function rankingOptions(overrides = {}) {
  return {
    limit: 50,
    offset: 0,
    qualifiedOnly: false,
    startAt: "2026-01-01",
    endAt: "2027-01-01",
    periodType: "yearly",
    periodKey: "2026",
    ...overrides
  };
}

test("release cutoffはJST日付境界へ正規化され、markerより遅い境界を採用する", () => {
  assert.equal(getRankingCutoffBoundary("2026-08-14T00:00:00+09:00"), "2026-08-14");
  assert.equal(getEffectiveRankingCutoffBoundary({
    releaseCutoffAt: "2026-08-14T00:00:00+09:00",
    resetAt: "2026-08-15T00:00:00+09:00"
  }), "2026-08-15");
  assert.equal(getEffectiveRankingCutoffBoundary({
    releaseCutoffAt: "2026-08-15T00:00:00+09:00",
    resetAt: "2026-08-14T00:00:00+09:00"
  }), "2026-08-15");
  assert.equal(getEffectiveRankingCutoffBoundary(), "");
});

test("未設定なら従来挙動、設定時は年間・月間・週間からcutoff前試合を除外する", async () => {
  const db = createDatabase();
  insertUser(db, "u1", "alpha");
  insertGame(db, "pre", "2026-08-11");
  insertGame(db, "post", "2026-08-14");
  insertPrediction(db, { id: "p-pre", userId: "u1", gameId: "pre", gameDate: "2026-08-11", score: 80 });
  insertPrediction(db, { id: "p-post", userId: "u1", gameId: "post", gameDate: "2026-08-14", score: 90 });

  const adapter = createD1Adapter(db);
  const withoutCutoff = await getRankingForPeriod(adapter, rankingOptions());
  assert.equal(withoutCutoff.summary.eligibleGames, 2);
  assert.equal(withoutCutoff.rows[0].gamesPlayed, 2);

  const releaseCutoffAt = "2026-08-14T00:00:00+09:00";
  const yearly = await getRankingForPeriod(adapter, rankingOptions({ releaseCutoffAt }));
  assert.equal(yearly.summary.eligibleGames, 1);
  assert.equal(yearly.rows[0].gamesPlayed, 1);
  assert.equal(yearly.rows[0].totalScore, 90);

  const monthly = await getRankingForPeriod(adapter, rankingOptions({
    startAt: "2026-08-01",
    endAt: "2026-09-01",
    periodType: "monthly",
    periodKey: "2026-08",
    releaseCutoffAt
  }));
  assert.equal(monthly.summary.eligibleGames, 1);

  const weekly = await getRankingForPeriod(adapter, rankingOptions({
    startAt: "2026-08-10",
    endAt: "2026-08-17",
    periodType: "weekly",
    periodKey: "2026-08-10",
    publishedOnly: true,
    releaseCutoffAt
  }));
  assert.equal(weekly.summary.eligibleGames, 1);
  assert.equal(weekly.rows[0].gamesPlayed, 1);
});

test("既存period markerとrelease cutoffは遅い方を使い、本人ランキングも同じ境界になる", async () => {
  const db = createDatabase();
  insertUser(db, "u1", "alpha");
  insertGame(db, "pre", "2026-08-14");
  insertGame(db, "post", "2026-08-16");
  insertPrediction(db, { id: "p-pre", userId: "u1", gameId: "pre", gameDate: "2026-08-14", score: 80 });
  insertPrediction(db, { id: "p-post", userId: "u1", gameId: "post", gameDate: "2026-08-16", score: 90 });
  db.prepare(
    `INSERT INTO ranking_reset_markers
       (period_type, period_key, reset_at, reason, created_by, created_at, is_active)
     VALUES ('yearly', '2026', '2026-08-15T00:00:00.000Z', 'release test', 'admin', '2026-08-15T00:00:00.000Z', 1)`
  ).run();

  const adapter = createD1Adapter(db);
  const options = rankingOptions({ releaseCutoffAt: "2026-08-14T00:00:00+09:00" });
  const ranking = await getRankingForPeriod(adapter, options);
  assert.equal(ranking.summary.eligibleGames, 1);
  assert.equal(ranking.rows[0].totalScore, 90);

  const mine = await getRankingEntryForUser(adapter, "u1", options);
  assert.equal(mine.gamesPlayed, 1);
  assert.equal(mine.totalScore, 90);
});

test("perfect rankingはrelease cutoff前を除外し、daily-best-nineは過去公開試合を保持する", async () => {
  const db = createDatabase();
  insertUser(db, "u1", "alpha");
  insertGame(db, "pre", "2026-08-13");
  insertGame(db, "post", "2026-08-14");
  insertPrediction(db, { id: "p-pre", userId: "u1", gameId: "pre", gameDate: "2026-08-13", score: 99 });
  insertPrediction(db, { id: "p-post", userId: "u1", gameId: "post", gameDate: "2026-08-14", score: 99 });
  const adapter = createD1Adapter(db);
  const releaseCutoffAt = "2026-08-14T00:00:00+09:00";

  const before = await getPerfectAchieversForDate(adapter, {
    date: "2026-08-13",
    limit: 50,
    offset: 0,
    releaseCutoffAt
  });
  assert.deepEqual(before, { rows: [], totalCount: 0 });

  const after = await getPerfectAchieversForDate(adapter, {
    date: "2026-08-14",
    limit: 50,
    offset: 0,
    releaseCutoffAt
  });
  assert.equal(after.totalCount, 1);

  const dailyBestNine = await getDailyBestNineForGame(adapter, {
    legacyGameId: "pre",
    releaseCutoffAt
  });
  assert.equal(dailyBestNine.totalCount, 1);
  assert.equal(dailyBestNine.rows[0].username, "alpha");
});

test("ランキング集計のβ開始設定を保持し、公開経路はadmin専用にする", () => {
  assert.equal(productionConfig.vars.PUBLIC_RANKING_RELEASED_AT, "2026-09-21T00:00:00+09:00");
  assert.match(workerSource, /getPublicRankingStartDate\(env\)/);
  assert.match(workerSource, /getPublicWeeklyRankingAvailability/);
  assert.match(workerSource, /PUBLIC_RANKING_ADMIN_ONLY/);
  assert.match(workerSource, /publishedOnly: true,\s*includeTestUsers: true/);
});
