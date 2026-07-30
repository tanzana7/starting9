const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("ロースター自動取得は6時間間隔、試合3時間前の直前確認、失敗後30分待機を適用する", async () => {
  const automation = await import(pathToFileURL(path.join(root, "pregame-automation.js")).href);
  const timeline = automation.getPregameTimeline("2026-07-22-l-f-16");
  const successAt = "2026-07-22T00:00:00.000Z";

  assert.deepEqual(automation.getRosterFetchDecision(timeline, {}, new Date("2026-07-22T00:00:00.000Z")), { due: true, kind: "regular" });
  assert.equal(automation.getRosterFetchDecision(timeline, { lastSuccessfulFetchAt: successAt }, new Date("2026-07-22T04:00:00.000Z")).due, false);
  assert.deepEqual(automation.getRosterFetchDecision(timeline, { lastSuccessfulFetchAt: successAt }, new Date("2026-07-22T06:00:00.000Z")), { due: true, kind: "pregame" });
  assert.equal(automation.getRosterFetchDecision(timeline, { lastSuccessfulFetchAt: "2026-07-22T06:00:00.000Z", lastPregameCheckGameId: timeline.gameId }, new Date("2026-07-22T06:30:00.000Z")).due, false);
  assert.equal(automation.getRosterFetchDecision(timeline, { nextCheckAt: "2026-07-22T06:30:00.000Z" }, new Date("2026-07-22T06:29:59.000Z")).reason, "retry_wait");
  assert.deepEqual(automation.getRosterFetchDecision(timeline, { nextCheckAt: "2026-07-22T06:30:00.000Z" }, new Date("2026-07-22T06:30:00.000Z")), { due: true, kind: "pregame" });
  assert.equal(automation.getRosterFetchDecision(timeline, {}, new Date("2026-07-22T09:00:00.000Z")).reason, "after_start");
});

test("ロースターCronは保存状態を参照し、変更なしを管理ログへ記録しない", () => {
  const worker = read("auth-worker.js");
  const script = read("script.js");
  const migration = read("migrations/0021_roster_fetch_schedule.sql");
  assert.match(worker, /async function runDueRosterCaptureJobs\(/);
  assert.match(worker, /getRosterFetchDecision\(timeline, decisionState, now\)/);
  assert.match(worker, /source: "cron"/);
  assert.match(worker, /eventType: "roster_fetch"/);
  assert.match(worker, /if \(changed \|\| !previousSnapshot\.players\.length\)/);
  assert.match(worker, /ROSTER_AUTO_FETCH_RETRY_INTERVAL_MS/);
  assert.match(migration, /last_successful_roster_fetch_at/);
  assert.match(migration, /roster_next_check_at/);
  assert.match(migration, /last_pregame_check_game_id/);
  assert.match(migration, /last_roster_error_code/);
  assert.doesNotMatch(script, /addAutoFetchLog\("1軍登録状況に変更はありません。"\)/);
});

test("ページ表示は保存済みロースターを読むだけでNPB取得を開始しない", () => {
  const script = read("script.js");
  const start = script.indexOf("async function initializeRosterCandidateSync");
  const end = script.indexOf("function buildNpbWorkerRequestUrl", start);
  const init = script.slice(start, end);
  assert.match(init, /renderPicker\("prediction"\)/);
  assert.doesNotMatch(init, /performRosterCheck\(/);
});

test("管理ログは成功0件、読込中、取得失敗を区別して表示する", () => {
  const script = read("script.js");
  assert.match(script, /管理ログは特にありません。/);
  assert.match(script, /試合進行ログを読み込み中です。/);
  assert.match(script, /試合進行ログを取得できませんでした。/);
  assert.match(script, /if \(!expanded\) return;/);
});
