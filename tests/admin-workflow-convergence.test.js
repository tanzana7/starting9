const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("管理画面の状態表示は現行workflow stateとjob runsを観測し、旧同期処理を実行しない", () => {
  const worker = read("auth-worker.js");
  const script = read("script.js");
  const html = read("index.html");
  const currentHandler = worker.slice(worker.indexOf("async function handleAdminCurrentGameWorkflow"), worker.indexOf("async function handleAdminGameWorkflowPause"));

  assert.match(currentHandler, /getCurrentManagedGame\(env\.AUTH_DB, now\)/);
  assert.match(currentHandler, /getManagedGameJobSummary\(env\.AUTH_DB, selection\.internalGameId\)/);
  assert.match(currentHandler, /buildCurrentWorkflowObservation\(selection, status, jobSummary, publicationWorkflow(?:, now)?\)/);
  assert.match(worker, /workflowAuditSource: "game_workflow_state\+game_job_runs"/);
  assert.match(worker, /job\.jobType === "final_lineup_fetch"/);
  assert.match(worker, /job\.jobType === "scoring"/);
  assert.doesNotMatch(script, /syncGameWorkflowButton/);
  assert.doesNotMatch(html, /今すぐ同期/);
});

test("Cronはschedule登録後に同じrunGameWorkflows経路へ進む", () => {
  const worker = read("auth-worker.js");
  const scheduled = worker.slice(worker.indexOf("export async function runScheduledGameAutomation"), worker.indexOf("async function cleanupExpiredManualRescorePreviews"));
  assert.match(scheduled, /syncTodayFightersSchedule\(env, now\)/);
  assert.match(scheduled, /runGameWorkflows\(env, now, scheduleSync\.games\)/);
  assert.match(worker, /runDueCompletionWorkflowJobs\(executorEnv, executorNow, executorTimelines\)/);
  assert.match(worker, /runDuePregameAutomationJobs\(env, now, activeTimelines\)/);
});

test("ロースターと正式スタメンの取得は共通game identity resolverを優先する", () => {
  const worker = read("auth-worker.js");
  const resolver = worker.slice(worker.indexOf("async function resolvePregameIdentity"), worker.indexOf("export function isBeforeGameStart"));
  const roster = worker.slice(worker.indexOf("async function captureGameRosterSnapshot"), worker.indexOf("async function captureOfficialLineup"));
  const lineup = worker.slice(worker.indexOf("async function captureOfficialLineup"), worker.indexOf("const WORKFLOW_LOG_STATUSES"));

  assert.match(resolver, /resolveApiGameReference\(db, gameId\)/);
  assert.match(resolver, /getGameIdentityRegistryAvailability\(db\)/);
  assert.match(roster, /await resolveRosterScheduleTarget\(env\.AUTH_DB, gameId, target \|\| \{\}\)/);
  assert.match(lineup, /await resolvePregameIdentity\(env\.AUTH_DB, gameId, target \|\| \{\}\)/);
});
