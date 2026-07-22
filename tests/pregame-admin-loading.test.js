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
  assert.match(script, /setTimeout\(\(\) => controller\.abort\(\), 10_000\)/);
  assert.match(script, /PREGAME_RESPONSE_INVALID/);
  assert.match(script, /PREGAME_RENDER_TARGET_MISSING/);
  assert.match(script, /PREGAME_GAME_ID_MISSING/);
  assert.match(script, /getPregameAutomationRenderTargets\(\)/);
  assert.match(script, /isPregameLoadingVisible\(targets\)/);
  assert.match(script, /loadingCleared/);
  assert.match(script, /responseKeys/);
  assert.match(script, /\[PREGAME\] rendered game=/);
  assert.equal((script.match(/試合前処理を確認中です。/g) || []).length, 1);
  assert.equal((script.match(/function renderPregameAutomationPanel\(/g) || []).length, 1);
  assert.equal((index.match(/id="adminPregameAutomationSummary"/g) || []).length, 1);
  assert.equal((index.match(/id="adminPregameAutomationMessage"/g) || []).length, 1);
  assert.equal((index.match(/id="adminPregameAutomationDiagnostic"/g) || []).length, 1);
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
  assert.match(scriptJsTags[0], /pregame-diagnostic-/);
});

test("PREGAME_RENDER_COMPLETEDは実DOMの成功または対象試合なしの描画後だけ設定する", () => {
  const script = read("script.js");
  assert.match(script, /else if \(renderResult\.completed\) \{[\s\S]*setPregameDiagnostic\("PREGAME_RENDER_COMPLETED"\)/);
  assert.match(script, /completed: ok && \["success", "empty"\]\.includes\(stateName\)/);
  assert.match(script, /const loadingCleared = !isPregameLoadingTextPresent\(targets\)/);
  assert.doesNotMatch(script, /renderPregameAutomationPanelSafely\(\);\s*setPregameDiagnostic\("PREGAME_RENDER_COMPLETED"\)/);
});

test("watchdogは実DOMのloading文言を監視し、診断情報を安全に表示する", () => {
  const script = read("script.js");
  assert.match(script, /if \(!isPregameLoadingVisible\(targets\)\)/);
  assert.match(script, /fetch開始：\$\{state\.pregameAutomation\.fetchStarted/);
  assert.match(script, /response\.ok：\$\{state\.pregameAutomation\.responseOk/);
  assert.match(script, /HTTP status：\$\{state\.pregameAutomation\.httpStatus/);
  assert.match(script, /DOM：\$\{state\.pregameAutomation\.domPresent/);
  assert.match(script, /response keys：\$\{responseKeys\}/);
  assert.match(script, /stopPregameAutomationWatchdog\(watchdogToken\)/);
  assert.match(script, /requestId !== state\.pregameAutomation\.requestId/);
  assert.match(script, /function closeAdminPanel\(\)[\s\S]*state\.pregameAutomation\.requestId \+= 1[\s\S]*stopPregameAutomationWatchdog/);
});

test("レスポンスの必須キーとgameIdを検証し、描画対象DOMを一意に扱う", () => {
  const script = read("script.js");
  const index = read("index.html");
  for (const key of ["gameId", "game", "notice", "roster", "lineup", "scoring", "publishing", "pregame"]) {
    assert.match(script, new RegExp(`\\"${key}\\"`));
  }
  assert.match(script, /payload\.gameId !== requestedGameId/);
  assert.match(script, /payload\.game === null \? null : payload\.pregame/);
  assert.match(script, /function getPregameAutomationRenderTargets\(\)/);
  assert.equal((index.match(/id="adminPregameAutomationSummary"/g) || []).length, 1);
  assert.equal((index.match(/id="adminPregameAutomationMessage"/g) || []).length, 1);
  assert.equal((index.match(/id="adminPregameAutomationDiagnostic"/g) || []).length, 1);
});

test("0010未適用時に必要なテーブルとカラムを検査できる", () => {
  const migration = read("migrations/0010_game_day_schedule_flow.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_day_notices/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_day_notice_games/);
  assert.match(migration, /ADD COLUMN roster_fixed_at/);
  assert.match(migration, /ADD COLUMN publication_status/);
});
