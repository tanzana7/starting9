import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAutoScoringAnswerLineup, parseAutoScoringRosterText } from "../auth-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("自動採点テストのロースターと正解スタメンを既存IDへ正規化する", () => {
  const roster = parseAutoScoringRosterText([
    "郡司裕也", "清水優心", "進藤勇也", "吉田賢吾", "田宮裕涼",
    "上川畑大悟", "野村佑希", "清宮幸太郎", "水野達稀"
  ].join("\n"));
  assert.equal(roster.ok, true);
  assert.equal(roster.players.length, 9);
  const answer = parseAutoScoringAnswerLineup([
    "1 中 郡司裕也", "2 左 清水優心", "3 三 進藤勇也", "4 指 吉田賢吾",
    "5 一 田宮裕涼", "6 右 上川畑大悟", "7 二 野村佑希", "8 捕 清宮幸太郎", "9 遊 水野達稀"
  ].join("\n"));
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.lineup.map((row) => row.battingOrder), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("不完全または重複した正解スタメンを拒否する", () => {
  const incomplete = parseAutoScoringAnswerLineup("1 中 郡司裕也\n2 左 清水優心");
  assert.equal(incomplete.ok, false);
  const duplicate = parseAutoScoringAnswerLineup([
    "1 中 郡司裕也", "1 左 清水優心", "3 三 進藤勇也", "4 指 吉田賢吾",
    "5 一 田宮裕涼", "6 右 上川畑大悟", "7 二 野村佑希", "8 捕 清宮幸太郎", "9 遊 水野達稀"
  ].join("\n"));
  assert.equal(duplicate.ok, false);
});

test("自動採点テストのDB・API・Cron・管理UIが本番から分離される", () => {
  const migration = read("migrations/0017_auto_scoring_tests.sql");
  const worker = read("auth-worker.js");
  const html = read("index.html");
  const script = read("script.js");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS auto_scoring_tests/);
  assert.match(migration, /mode TEXT NOT NULL DEFAULT 'auto_scoring'/);
  assert.match(migration, /answer_lineup_json TEXT NULL/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /\/api\/admin\/auto-scoring-tests/);
  assert.match(worker, /runDueAutoScoringTestJobs\(env, now\)/);
  assert.match(worker, /is_test_prediction = 1/);
  assert.match(worker, /is_test_game = 1/);
  assert.match(worker, /scoreClaimedGameLineup\(env\.AUTH_DB, claimed, now, 1\)/);
  assert.match(html, /id="adminAutoScoringTestCreateForm"/);
  assert.match(html, /自動採点テスト/);
  assert.match(html, /締切補助/);
  assert.match(script, /自動処理を今すぐ確認/);
  assert.match(script, /正解と同じテスト予想を保存/);
  assert.match(script, /autoScoringTestAnswerPreview/);
  assert.match(worker, /AUTO_SCORING_TEST_LINEUP_ROSTER_MISMATCH/);
});

test("通常Cronの採点対象からテスト試合を除外する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /game_id NOT IN \(SELECT game_id FROM ranking_games WHERE is_test_game = 1\)/);
  assert.match(worker, /isTestGame/);
  assert.match(worker, /is_ranking_eligible = 0/);
});

test("テスト試合の結果と予想は通常ユーザーAPIへ露出しない", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /const testGame = await isTestRankingGame/);
  assert.match(worker, /const row = testGame \? null : await getPredictionRow/);
  assert.match(worker, /if \(Number\(row\?\.is_test_game \|\| 0\) === 1\) return false/);
});
