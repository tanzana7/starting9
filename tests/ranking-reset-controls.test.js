import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  getRankingForPeriod,
  getRankingResetConfirmation,
  getRankingResetDateBoundary,
  getRankingResetPreview,
  normalizeRankingResetRequest
} from "../auth-worker.js";

const root = path.join(import.meta.dirname, "..");
const migration = fs.readFileSync(path.join(root, "migrations", "0035_ranking_reset_markers.sql"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const adminScript = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0001_auth.sql", "0003_predictions.sql", "0004_admin_role.sql", "0005_game_lineups.sql", "0006_user_achievements.sql", "0007_all_time_ranking.sql", "0008_monthly_ranking.sql"]) {
    db.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
  }
  db.exec(migration);
  return db;
}

function insertUser(db, id, username) {
  db.prepare(
    `INSERT INTO users
       (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at, status, role)
     VALUES (?1, ?2, ?2, 'hash', 'salt', 100000, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 'active', 'user')`
  ).run(id, username);
}

function insertGame(db, gameId, gameDate) {
  db.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game, created_at, updated_at)
     VALUES (?1, ?2, 1, ?3, 'scored', 0, ?3, ?3)`
  ).run(gameId, gameDate, `${gameDate}T10:00:00.000Z`);
}

function insertPrediction(db, id, gameId) {
  db.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version, game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, status, score, max_score, scored_at, is_test_prediction)
     VALUES (?1, 'u1', ?2, '{}', 1, ?3, 'f', 'l', 'l', 1, ?4, ?4, 'scored', 80, 99, ?4, 0)`
  ).run(id, gameId, gameId.startsWith("before") ? "2026-08-11" : "2026-08-12", "2026-08-12T10:00:00.000Z");
}

function createD1Adapter(db) {
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
    }
  };
}

test("0035は非破壊marker tableとactive期間一意indexを定義する", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ranking_reset_markers/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_ranking_reset_markers_active/);
  assert.match(migration, /WHERE is_active = 1/);
  assert.doesNotMatch(migration, /DELETE FROM|DROP TABLE|UPDATE predictions|UPDATE ranking_games/);
  const db = createDatabase();
  db.exec(migration);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ranking_reset_markers").get().count, 0);
});

test("期間・基準日時・理由・確認文字列を厳格に検証する", () => {
  const input = normalizeRankingResetRequest({ periodType: "monthly", periodKey: "2026-08", resetAt: "2026-08-12T00:00:00+09:00", reason: "正式リリース前のテストデータ除外" });
  assert.equal(input.ok, true);
  assert.equal(input.resetBoundary, "2026-08-12");
  assert.equal(getRankingResetDateBoundary("2026-08-11T15:00:00Z"), "2026-08-12");
  assert.equal(getRankingResetConfirmation("yearly", "2026"), "RESET YEARLY 2026");
  assert.equal(normalizeRankingResetRequest({ ...input, periodKey: "2026-13" }).ok, false);
  assert.equal(normalizeRankingResetRequest({ ...input, reason: "" }).code, "RANKING_RESET_REASON_REQUIRED");
});

test("previewは既存行を変更せず、基準日より前の試合と予想を明示する", async () => {
  const db = createDatabase();
  insertUser(db, "u1", "alpha");
  insertGame(db, "before-1", "2026-08-11");
  insertGame(db, "after-1", "2026-08-12");
  insertPrediction(db, "p-before", "before-1");
  insertPrediction(db, "p-after", "after-1");
  const beforeMarkerCount = db.prepare("SELECT COUNT(*) AS count FROM ranking_reset_markers").get().count;
  const preview = await getRankingResetPreview(createD1Adapter(db), { periodType: "monthly", periodKey: "2026-08", resetAt: "2026-08-12T00:00:00+09:00" });
  assert.deepEqual({ gamesExcluded: preview.gamesExcluded, gamesRemaining: preview.gamesRemaining, predictionsExcluded: preview.predictionsExcluded, predictionsRemaining: preview.predictionsRemaining }, { gamesExcluded: 1, gamesRemaining: 1, predictionsExcluded: 1, predictionsRemaining: 1 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ranking_reset_markers").get().count, beforeMarkerCount);
});

test("active markerは指定期間のランキング集計から過去試合を除外する", async () => {
  const db = createDatabase();
  insertUser(db, "u1", "alpha");
  insertGame(db, "before-1", "2026-08-11");
  insertGame(db, "after-1", "2026-08-12");
  insertPrediction(db, "p-before", "before-1");
  insertPrediction(db, "p-after", "after-1");
  db.prepare(
    `INSERT INTO ranking_reset_markers (period_type, period_key, reset_at, reason, created_by, created_at, is_active)
     VALUES ('monthly', '2026-08', '2026-08-11T15:00:00.000Z', 'release', 'admin-1', '2026-08-11T15:00:00.000Z', 1)`
  ).run();
  const ranking = await getRankingForPeriod(createD1Adapter(db), { limit: 50, offset: 0, qualifiedOnly: false, startAt: "2026-08-01", endAt: "2026-09-01", periodType: "monthly", periodKey: "2026-08" });
  assert.equal(ranking.summary.eligibleGames, 1);
  assert.equal(ranking.rows[0].gamesPlayed, 1);
  assert.equal(ranking.rows[0].gamesNeeded, 0);
});

test("管理APIはpreview/executeを分離し、管理者確認とcache busterを要求する", () => {
  assert.match(worker, /\/api\/admin\/v3\/ranking-resets\/preview/);
  assert.match(worker, /\/api\/admin\/v3\/ranking-resets\/execute/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /RANKING_RESET_CONFIRMATION_REQUIRED/);
  assert.match(worker, /RANKING_RESET_MARKER_EXISTS/);
  assert.match(adminScript, /ranking-reset-controls-1|ranking-reset/);
  assert.match(adminHtml, /admin-v3\.css\?v=manual-lineup-confirmation-1/);
  assert.match(adminHtml, /admin-v3\.js\?v=manual-lineup-finalize-safety-1/);
  assert.match(adminHtml, /data-v3-view="ranking-reset"/);
});
