const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("管理画面は日程から対象試合と開始日時を自動反映し、手動上書きを保持する", () => {
  const script = read("script.js");
  assert.match(script, /function selectAdminTargetGame\(\)/);
  assert.match(script, /getScheduleDate\(schedule\) === today/);
  assert.match(script, /function isAdminScheduleCompleted\(schedule\)/);
  assert.match(script, /state\.gameWorkflow\.record = payload/);
  const workflowRefresh = script.slice(script.indexOf("async function refreshAdminGameWorkflowStatus"), script.indexOf("function getWorkflowLogStatusLabel"));
  assert.doesNotMatch(workflowRefresh, /applyGameSchedule\(nextSchedule, "auto"\)/);
  assert.match(script, /manualGameSelection/);
  assert.match(script, /manualStartOverride/);
  assert.match(script, /function setGameStartManualOverride\(enabled\)/);
  assert.match(script, /input\.readOnly = !manual/);
  assert.match(script, /日時を日程データの自動値へ戻しました/);
});

test("管理画面は現行workflow監査を表示し、緊急停止だけを管理者専用APIで永続化する", () => {
  const html = read("index.html");
  const script = read("script.js");
  const worker = read("auth-worker.js");
  const migration = read("migrations/0012_game_workflow_controls.sql");

  assert.match(html, /id="adminGameWorkflowStatus"/);
  assert.doesNotMatch(html, /id="syncGameWorkflowButton"/);
  assert.match(html, /id="toggleGameWorkflowPauseButton"/);
  assert.match(html, /EMERGENCY RECOVERY/);
  assert.match(html, /id="editGameStartButton"/);
  assert.doesNotMatch(script, /syncGameWorkflowButton/);
  assert.doesNotMatch(worker, /pregame-automation\/workflow-status/);
  assert.match(script, /pause-workflow/);
  assert.match(script, /resume-workflow/);
  assert.match(script, /cache: "no-store"/);
  assert.match(worker, /workflowAuditSource: "game_workflow_state\+game_job_runs"/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /async function getPausedWorkflowGameIds/);
  assert.match(worker, /runDueAutoScoringJobs\(executorEnv, executorNow, pausedGameIds\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS game_workflow_controls/);
  assert.match(migration, /automation_paused INTEGER NOT NULL DEFAULT 0/);
});

test("緊急停止中の試合はCronの公示・スタメン・採点・公開対象から除外する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /const activeTimelines = timelines\.filter\(\(timeline\) => !pausedGameIds\.has\(timeline\.gameId\)\)/);
  assert.match(worker, /runDueGameDayScheduleJobs\(env, now, activeTimelines\)/);
  assert.match(worker, /runDuePregameAutomationJobs\(env, now, activeTimelines\)/);
  assert.match(worker, /game_id NOT IN/);
  assert.match(worker, /runDueGameDayPublicationJobs\(env, now, activeTimelines\)/);
});
