const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const migration = fs.readFileSync(path.join(root, "migrations", "0005_game_lineups.sql"), "utf8");

test("自動採点はCron、原子的なclaim、共通採点コアを持つ", () => {
  assert.match(worker, /async scheduled\(event, env, ctx\)/);
  assert.match(worker, /const formalRun = runScheduledGameAutomationV3/);
  assert.match(worker, /ctx\.waitUntil\(formalRun\.then\(/);
  assert.match(worker, /V3_JOB_TYPE\.SCORE/);
  assert.doesNotMatch(worker, /runDuePregameAutomationJobs|runDueAutoScoringJobs/);
  assert.match(worker, /AUTO_SCORING_DEFAULT_DELAY_SECONDS = 300/);
  assert.match(worker, /AUTO_SCORING_MAX_ATTEMPTS = 3/);
  assert.match(worker, /scoring_status = 'processing'/);
  assert.match(worker, /scoreClaimedGameLineup/);
  assert.match(worker, /INSERT OR IGNORE INTO perfect_achievers/);
});

test("実スタメン保存・状態確認・手動操作の管理者APIを公開する", () => {
  for (const route of ["actual-lineup", "auto-scoring/status", "auto-scoring/run-now", "auto-scoring/retry", "auto-scoring/cancel"]) {
    assert.ok(worker.includes(route), `${route} が見つかりません`);
  }
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
});

test("game_lineups migrationは状態・期限・再試行情報を保存する", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_lineups/);
  assert.match(migration, /lineup_detected_at TEXT NOT NULL/);
  assert.match(migration, /scoring_due_at TEXT NOT NULL/);
  assert.match(migration, /scoring_status TEXT NOT NULL DEFAULT 'pending'/);
  assert.match(migration, /scoring_attempts INTEGER NOT NULL DEFAULT 0/);
});

test("試合前自動処理はロースタースナップショット・取得状態・手動優先を持つ", () => {
  const pregameMigration = fs.readFileSync(path.join(root, "migrations", "0009_pregame_automation.sql"), "utf8");
  assert.match(pregameMigration, /CREATE TABLE IF NOT EXISTS game_roster_snapshots/);
  assert.match(pregameMigration, /CREATE TABLE IF NOT EXISTS game_pregame_automation/);
  assert.match(pregameMigration, /lineup_source/);
  assert.match(worker, /preventOverwrite/);
  assert.match(worker, /source: "npb-auto"/);
  assert.match(worker, /source: "manual"/);
  assert.match(worker, /is_test_prediction = 0/);
});
