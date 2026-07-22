const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("試合前自動処理の管理画面取得はタイムアウトとfinallyで固まりを防ぐ", () => {
  const script = read("script.js");
  assert.match(script, /new AbortController\(\)/);
  assert.match(script, /controller\.abort\(\)/);
  assert.match(script, /setTimeout\(\(\) => controller\.abort\(\), 10_000\)/);
  assert.match(script, /signal: controller\.signal/);
  assert.match(script, /finally \{[\s\S]*state\.pregameAutomation\.isLoading = false/);
  assert.match(script, /試合前処理情報の取得がタイムアウトしました/);
  assert.match(script, /本日の対象試合はありません/);
  assert.match(script, /PREGAME_SCHEMA_NOT_READY/);
  assert.match(script, /HTTP \$\{error\.status\}/);
});

test("管理画面の独立した初期化は一部のAPI失敗で停止しない", () => {
  const script = read("script.js");
  assert.match(script, /Promise\.allSettled\(\[/);
  assert.match(script, /fetchUserAchievements\(\{ force: true \}\)/);
  assert.match(script, /refreshYearlyRanking\(\{ force: true \}\)/);
  assert.match(script, /refreshAdminAccess\(\)/);
});

test("試合前自動処理サマリーAPIは安全なエラーコードと構造化レスポンスを返す", () => {
  const auth = read("auth-worker.js");
  assert.match(auth, /isPregameSchemaError\(error\)/);
  assert.match(auth, /error: code, code/);
  assert.match(auth, /status\.game/);
  assert.match(auth, /status\.notice/);
  assert.match(auth, /status\.roster/);
  assert.match(auth, /status\.lineup/);
  assert.match(auth, /status\.scoring/);
  assert.match(auth, /publishing: status\.publishing/);
  assert.match(auth, /return noStoreJsonResponse\(\{/);
  assert.match(auth, /console\.error\(`\[PREGAME\] summary failed: code=\$\{code\}`\)/);
});

test("0010未適用時に必要なテーブルとカラムを検査できる", () => {
  const migration = read("migrations/0010_game_day_schedule_flow.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_day_notices/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_day_notice_games/);
  assert.match(migration, /ADD COLUMN roster_fixed_at/);
  assert.match(migration, /ADD COLUMN publication_status/);
});
