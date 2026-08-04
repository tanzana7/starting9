const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

test("開始後の正式スタメンjobは保存済みlineupを未発表扱いせず、開始後取得を許可する", () => {
  const captureStart = worker.indexOf("async function captureOfficialLineup");
  const captureEnd = worker.indexOf("const WORKFLOW_LOG_STATUSES", captureStart);
  const capture = worker.slice(captureStart, captureEnd);

  assert.match(capture, /const existing = await getGameLineup\(env\.AUTH_DB, \{ gameId, internalGameId \}\)/);
  assert.match(capture, /status: isFinalCapture \? "already_captured" : "provisional"/);
  assert.match(capture, /allowAfterStart: true/);
  assert.match(capture, /status: isFinalCapture \? "not_due" : "superseded_after_start"/);
});

test("開始後に残ったprovisional jobはDATA_NOT_ANNOUNCEDへ変換せずfinal jobへ引き継ぐ", () => {
  const executorStart = worker.indexOf("async function executeCompletionWorkflowJob");
  const executorEnd = worker.indexOf("async function runDueCompletionWorkflowJobs", executorStart);
  const executor = worker.slice(executorStart, executorEnd);

  assert.match(executor, /\["provisional", "superseded_after_start"\]\.includes\(result\.status\)/);
  assert.match(executor, /if \(result\.status === "provisional"\)/);
  assert.match(worker, /provisional_lineup_fetch: "final_lineup_fetch"/);
  assert.match(worker, /cancelSupersededLineupJobs\(env\.AUTH_DB, internalGameId, now\)/);
});

test("8/5のrosterは解決済みtargetのinternalGameIdとstartAtを共通resolver fallbackへ渡す", () => {
  const resolverStart = worker.indexOf("async function resolvePregameIdentity");
  const resolverEnd = worker.indexOf("export function isBeforeGameStart", resolverStart);
  const resolver = worker.slice(resolverStart, resolverEnd);
  const rosterStart = worker.indexOf("async function captureGameRosterSnapshot");
  const rosterEnd = worker.indexOf("async function captureOfficialLineup", rosterStart);
  const roster = worker.slice(rosterStart, rosterEnd);
  const cronStart = worker.indexOf("async function runDueRosterCaptureJobs");
  const cronEnd = worker.indexOf("async function handleAdminAutomationHealth", cronStart);
  const cron = worker.slice(cronStart, cronEnd);

  assert.match(resolver, /fallbackInternalGameId/);
  assert.match(resolver, /workflow_target_fallback/);
  assert.match(roster, /resolvePregameIdentity\(env\.AUTH_DB, gameId, target \|\| \{\}\)/);
  assert.match(cron, /target\s*\}\)/);
  assert.match(roster, /SCHEDULE_UNAVAILABLE/);
  assert.match(cron, /rosterResolutionStage/);
  assert.match(cron, /rosterResolvedBy/);
  assert.match(cron, /rosterStartAtFound/);
});

test("workflow監査へjob種別、NPBコード、取得分類、roster解決診断を保存する", () => {
  assert.match(worker, /function getWorkflowExecutionDiagnostics/);
  assert.match(worker, /claimedJobId/);
  assert.match(worker, /resolvedNpbGameCode/);
  assert.match(worker, /lineupSourceUrl/);
  assert.match(worker, /lineupHttpStatus/);
  assert.match(worker, /lineupParseStage/);
  assert.match(worker, /lineupDataClassification/);
  assert.match(worker, /dataNotAnnouncedReason/);
  assert.match(worker, /rosterResolutionStage/);
  assert.match(worker, /rosterResolvedBy/);
  assert.match(worker, /rosterStartAtFound/);
  assert.match(worker, /resultMetadata: \{[\s\S]*getWorkflowExecutionDiagnostics/);
});

test("scheduleが本当に解決できない場合だけroster SCHEDULE_UNAVAILABLEを返す", () => {
  const rosterStart = worker.indexOf("async function captureGameRosterSnapshot");
  const rosterEnd = worker.indexOf("async function captureOfficialLineup", rosterStart);
  const roster = worker.slice(rosterStart, rosterEnd);

  assert.match(roster, /if \(!identity\)/);
  assert.match(roster, /error\.rosterResolution = \{[\s\S]*startAtFound: false/);
  assert.match(roster, /const identity = await resolvePregameIdentity/);
});
