const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("試合前自動処理の管理画面取得はタイムアウトとfinallyで固まりを防ぐ", () => {
  const script = read("script.js");
  const index = read("index.html");
  assert.match(script, /new AbortController\(\)/);
  assert.match(script, /controller\.abort\(\)/);
  assert.match(script, /setTimeout\(\(\) => controller\.abort\(\), 10_000\)/);
  assert.match(script, /signal: controller\.signal/);
  assert.match(script, /finally \{[\s\S]*state\.pregameAutomation\.isLoading = false/);
  assert.match(script, /試合前処理情報の取得がタイムアウトしました/);
  assert.match(script, /本日の対象試合はありません/);
  assert.match(script, /PREGAME_SCHEMA_NOT_READY/);
  assert.match(script, /HTTP \$\{error\.status\}/);
  assert.match(script, /PREGAME_UI_WATCHDOG_TIMEOUT/);
  assert.match(script, /PREGAME_RENDER_COMPLETED/);
  assert.match(script, /setPregameDiagnostic\("PREGAME_RENDER_COMPLETED"\);[\s\S]*clearPregameAutomationWatchdog\(watchdogGeneration\)/);
  assert.match(script, /watchdogTimedOutGeneration === watchdogGeneration/);
  assert.match(script, /watchdogTimedOutGeneration !== watchdogGeneration/);
  assert.match(script, /function ensurePregameAutomationWatchdog\(\)/);
  assert.match(script, /watchdogId === null/);
  assert.match(script, /function clearPregameAutomationWatchdog\(generation = null\)/);
  assert.match(script, /setTimeout\(\(\) => controller\.abort\(\), 10_000\)/);
  assert.equal((script.match(/試合前処理を確認中です。/g) || []).length, 1);
  assert.equal((script.match(/function renderPregameAutomationPanel\(/g) || []).length, 1);
  assert.equal((index.match(/id="adminPregameAutomationSummary"/g) || []).length, 1);
  assert.equal((index.match(/id="adminPregameAutomationMessage"/g) || []).length, 1);
  assert.equal((index.match(/id="adminPregameAutomationDiagnostic"/g) || []).length, 1);
});

test("watchdogは管理画面ごとに1つだけ保持し、再オープン・終了・各終了経路で解除する", () => {
  const script = read("script.js");
  assert.match(script, /beginPregameAutomationInitialization\(\);/);
  assert.match(script, /function startPregameAutomationWatchdog\(\)[\s\S]*clearPregameAutomationWatchdog\(\);/);
  assert.match(script, /function closeAdminPanel\(\)[\s\S]*clearPregameAutomationWatchdog\(\);/);
  assert.match(script, /PREGAME_GAME_ID_MISSING[\s\S]*clearPregameAutomationWatchdog\(\);/);
  assert.match(script, /PREGAME_API_URL_MISSING[\s\S]*clearPregameAutomationWatchdog\(\);/);
  assert.doesNotMatch(script, /watchdogToken|stopPregameAutomationWatchdog/);
});

test("管理画面の独立した初期化は一部のAPI失敗で停止しない", () => {
  const script = read("script.js");
  assert.match(script, /Promise\.allSettled\(\[/);
  assert.match(script, /fetchUserAchievements\(\{ force: true \}\)/);
  assert.match(script, /refreshYearlyRanking\(\{ force: true \}\)/);
  assert.match(script, /refreshAdminAccess\(\)/);
  assert.match(script, /beginPregameAutomationInitialization\(\);[\s\S]*refreshPregameAutomationStatus\(\{ force: true \}\)/);
  assert.match(script, /try \{\s*initializeGameSchedule\(\);[\s\S]*catch \(error\)/);
  assert.match(script, /try \{\s*renderAll\(\);[\s\S]*catch \(error\)/);
  assert.match(script, /function renderPregameAutomationPanelSafely/);
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
  assert.match(auth, /PREGAME_SUMMARY_TIMEOUT/);
  assert.match(auth, /PREGAME_SUMMARY_TIMEOUT_MS = 10_000/);
  assert.match(auth, /return noStoreJsonResponse\(\{ ok: false, error: code, code \}, status, cors\)/);
});

test("キャッシュされた旧script.jsを再利用しないscriptタグになっている", () => {
  const index = read("index.html");
  const scriptTags = index.match(/<script[^>]+src="[^"]+"[^>]*><\/script>/g) || [];
  const scriptJsTags = scriptTags.filter((tag) => /src="script\.js\?/.test(tag));
  assert.equal(scriptJsTags.length, 1);
  assert.match(scriptJsTags[0], /pregame-watchdog-/);
});

test("0010未適用時に必要なテーブルとカラムを検査できる", () => {
  const migration = read("migrations/0010_game_day_schedule_flow.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_day_notices/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_day_notice_games/);
  assert.match(migration, /ADD COLUMN roster_fixed_at/);
  assert.match(migration, /ADD COLUMN publication_status/);
});
