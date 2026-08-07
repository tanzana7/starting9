const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0022_service_unavailable_scoring_games.sql"), "utf8");

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const file of [
    "0001_auth.sql", "0002_perfect_achievers.sql", "0003_predictions.sql", "0004_admin_role.sql",
    "0005_game_lineups.sql", "0006_user_achievements.sql", "0007_all_time_ranking.sql",
    "0008_monthly_ranking.sql", "0009_pregame_automation.sql", "0010_game_day_schedule_flow.sql", "0022_service_unavailable_scoring_games.sql"
  ]) {
    db.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
  }
  return db;
}

test("期限切れ試合はservice_unavailableとして保存でき、正常試合と異なる状態になる", () => {
  const db = createDatabase();
  db.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, game_status, is_test_game, publication_status, created_at, updated_at)
     VALUES ('2026-08-01-f-m-1400', '2026-08-01', 0, 'service_unavailable', 0, 'pending', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`
  ).run();
  const row = db.prepare("SELECT game_status, is_ranking_eligible FROM ranking_games WHERE game_id = '2026-08-01-f-m-1400'").get();
  assert.deepEqual({ game_status: row.game_status, is_ranking_eligible: row.is_ranking_eligible }, { game_status: "service_unavailable", is_ranking_eligible: 0 });
  assert.match(migration, /service_unavailable/);
});

test("service_unavailable試合はランキング共通抽出と自動採点・公開の対象外になる", () => {
  assert.match(worker, /AND game_status = 'scored'/);
  assert.match(worker, /game_status = 'service_unavailable'/);
  assert.match(worker, /async function isServiceUnavailableGame/);
  assert.match(worker, /if \(await isServiceUnavailableGame\(env\.AUTH_DB, gameId\)\)/);
});

test("期限切れ試合の結果APIは予想を保持したまま対象外理由を返し、通常の採点結果とは分離する", () => {
  assert.match(worker, /const SERVICE_UNAVAILABLE_GAME_STATUS = "service_unavailable"/);
  assert.match(worker, /const SERVICE_UNAVAILABLE_MESSAGE = "この試合はサービス未稼働のため集計対象外です。"/);
  assert.match(worker, /OR ranking_games\.game_status = 'service_unavailable'/);
  assert.match(worker, /serviceUnavailableReason: serviceUnavailable \? SCORING_RETRY_EXPIRED_CODE : null/);
  assert.match(worker, /if \(serviceUnavailable\) \{[\s\S]*?score: null,[\s\S]*?actualLineup: null/);
  assert.match(script, /集計対象外/);
  assert.match(script, /serviceUnavailableMessage/);
});

test("SCORING_RETRY_EXPIRED時に対象外状態を作成し、管理者が解除できる", () => {
  assert.match(worker, /await markGameServiceUnavailable\(db, gameId, now, SCORING_RETRY_EXPIRED_CODE\)/);
  assert.match(worker, /service-unavailable\|restore-service-unavailable/);
  assert.match(worker, /eventType: "service_unavailable_marked"/);
  assert.match(worker, /eventType: "service_unavailable_restored"/);
  assert.match(worker, /game_status = 'pending'/);
  assert.match(worker, /restore-service-unavailable/);
});

test("通常のランキング集計条件はis_ranking_eligibleとscoredを維持する", () => {
  const cte = worker.match(/function createRankingCte\(\) \{[\s\S]*?return `([\s\S]*?)`;\r?\n\}/)?.[1] || "";
  assert.match(cte, /is_ranking_eligible = 1/);
  assert.match(cte, /game_status = 'scored'/);
  assert.doesNotMatch(cte, /service_unavailable.*is_ranking_eligible = 1/);
});
