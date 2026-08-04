const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("共通selectorは当日未完了、当日採点公開未完了、直近48時間、次回、過去失敗の順で候補を選ぶ", () => {
  const worker = read("auth-worker.js");
  const start = worker.indexOf("export function selectCurrentManagedGame");
  const block = worker.slice(start, worker.indexOf("async function getCurrentManagedGameCandidates", start));
  assert.ok(start >= 0);
  assert.match(block, /todayUncompleted\[0\] \|\| todayIncomplete\[0\] \|\| recentUncompleted\[0\] \|\| nextUpcoming\[0\] \|\| recentFailures\[0\] \|\| historical\[0\]/);
  assert.match(block, /!candidate\.isTestGame/);
  assert.match(block, /selectionReason/);
  assert.match(block, /isCurrent: !selected\.isHistorical/);
  assert.match(block, /candidate\.gameDate === currentDate && candidate\.gameStatus === "completed" && !candidate\.isTerminal/);
});

test("selector候補はinternal ID単位で状態・schedule・テスト試合を読み取る", () => {
  const worker = read("auth-worker.js");
  const block = worker.slice(worker.indexOf("async function getCurrentManagedGameCandidates"), worker.indexOf("function scheduleGameFromDetectedRow"));
  assert.match(block, /FROM games/);
  assert.match(block, /LEFT JOIN game_workflow_state/);
  assert.match(block, /FROM detected_game_schedule/);
  assert.match(block, /WHERE is_test_game = 1/);
  assert.match(block, /isTestGame:/);
});

test("上段と下段は同じサーバーselectorを使い、古いfailureをcurrentへ直接渡さない", () => {
  const worker = read("auth-worker.js");
  const script = read("script.js");
  assert.match(worker, /\/api\/admin\/audit\/current-game-workflow/);
  assert.match(worker, /managed = await getCurrentManagedGame\(env\.AUTH_DB, new Date\(\)\)/);
  assert.match(worker, /currentGame: currentSelection/);
  const topRefresh = script.slice(script.indexOf("async function refreshAdminGameWorkflowStatus"), script.indexOf("function getGameProgressStatusLabel"));
  assert.match(topRefresh, /buildAdminCurrentGameWorkflowApiUrl\(\)/);
  assert.doesNotMatch(topRefresh, /getAdminGameApiUrl\(gameId, "pregame-automation\/workflow-status"\)/);
  assert.match(script, /state\.gameWorkflow\.record\?\.currentGame\?\.legacyGameId/);
  assert.match(script, /historicalFailures/);
  assert.match(script, /直近の要確認/);
});

test("readinessのjobとworkflow件数はcurrent/future候補へ限定し、過去失敗を別表示する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /const currentAndFutureIds = new Set/);
  assert.match(worker, /const scopedJobs = currentAndFutureIds\.size/);
  assert.match(worker, /historicalFailures/);
  assert.match(worker, /activeWorkflowGameIds/);
});

test("将来試合のSCHEDULE_UNAVAILABLEは待機、本当の取得失敗はerrorとして分類する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /export function classifyScheduleUnavailable/);
  assert.match(worker, /code: "SCHEDULE_NOT_PUBLISHED"/);
  assert.match(worker, /status: "waiting"/);
  assert.match(worker, /status: "error", code: "SCHEDULE_FETCH_FAILED"/);
  assert.match(worker, /scheduleWaiting \? "試合情報公開待ち"/);
});

test("運用画面の56件表示は現在対象試合数と混同しないラベルになっている", () => {
  const script = read("script.js");
  assert.match(script, /Cron処理確認件数/);
  assert.match(script, /保留job/);
  assert.match(script, /再試行待ちjob/);
  assert.match(script, /次回実行/);
});
