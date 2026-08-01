import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseTestLineupInput, parseTestRosterText } from "../auth-worker.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0016_admin_test_games.sql"), "utf8");

const rosterText = [
  "万波中正,外野手", "水谷瞬,外野手", "郡司裕也,捕手", "レイエス,DH", "清宮幸太郎,内野手",
  "上川畑大悟,二", "野村佑希,三", "水野達稀,遊", "淺間大基,外野手"
].join("\n");

const lineupText = [
  "1 中 万波中正", "2 二 上川畑大悟", "3 遊 水野達稀", "4 一 清宮幸太郎", "5 三 野村佑希",
  "6 左 水谷瞬", "7 右 淺間大基", "8 捕 郡司裕也", "9 指 レイエス"
].join("\n");

test("テストロースターは複数行とカテゴリ位置を受け付け、重複を拒否する", () => {
  const parsed = parseTestRosterText(rosterText);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.players.length, 9);
  assert.equal(parsed.players[0].playerId, "F-66");
  assert.equal(parsed.players[0].position, "外野手");

  const duplicate = parseTestRosterText(`${rosterText}\n水谷瞬,外野手`);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /重複/);
});

test("テストスタメンは9人の既存選手IDへ正規化される", () => {
  const parsed = parseTestLineupInput(lineupText);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.lineup.length, 9);
  assert.deepEqual(parsed.lineup[0], {
    battingOrder: 1,
    playerId: "F-66",
    teamId: "F",
    teamCode: "fighters",
    uniformNumber: "66",
    playerName: "万波中正",
    position: "中"
  });
});

test("テスト試合は管理者APIと専用migrationで本番試合から分離される", () => {
  assert.match(worker, /\/api\/admin\/test-games/);
  assert.match(worker, /is_test_prediction = 1/);
  assert.match(worker, /is_test_game = 1/);
  assert.match(worker, /DELETE FROM test_games/);
  assert.match(worker, /DELETE FROM predictions WHERE game_id = \?1 AND is_test_prediction = 1/);
  assert.match(worker, /is_test_game = 0/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS test_games/);
  assert.match(migration, /created_by INTEGER NOT NULL/);
});

test("管理画面に作成・一覧・詳細のテスト試合操作とTEST表示がある", () => {
  assert.match(page, /adminTestGameCreateForm/);
  assert.match(page, /テスト試合を作成/);
  assert.match(page, /adminTestGamesList/);
  assert.match(page, /adminTestGameDetail/);
  assert.match(page, /adminTestGameRosterPreview/);
  assert.match(script, /TEST MODE/);
  assert.match(script, /save-deadline/);
  assert.match(script, /テスト採点結果/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
});

test("テスト採点は既存の採点準備・保存関数へis_testフラグを渡す", () => {
  assert.match(worker, /prepareGamePredictionScoring\(env\.AUTH_DB, game\.game_id, actual\.lineup, 1\)/);
  assert.match(worker, /scoreClaimedGameLineup\(env\.AUTH_DB, claimed, now, 1\)/);
  assert.match(worker, /scorePredictionLineup\(sanitized\.prediction\.lineup, actualLineup\)/);
  assert.match(worker, /persistGamePredictionScoring\(db, record\.game_id, actualResult\.lineup, scoring, now, isTestPrediction, record\.internal_game_id \|\| ""\)/);
});

test("Cronの日程集合へtest_gamesを混ぜる処理を追加していない", () => {
  assert.doesNotMatch(worker, /getPregameTimelines\([^)]*test_games/);
  assert.match(worker, /game_id NOT IN \(SELECT game_id FROM ranking_games WHERE is_test_game = 1\)/);
  assert.match(worker, /ranking_games\.is_test_game = 0/);
});
