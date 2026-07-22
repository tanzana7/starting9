const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");

test("試合前時刻はJST基準で2時間前・1時間前・開始時刻を計算する", async () => {
  const automation = await import(pathToFileURL(path.join(root, "pregame-automation.js")).href);
  const timeline = automation.getPregameTimeline("2026-07-22-l-f-16");
  assert.equal(timeline.startAt.toISOString(), "2026-07-22T09:00:00.000Z");
  assert.equal(timeline.rosterCaptureAt.toISOString(), "2026-07-22T07:00:00.000Z");
  assert.equal(timeline.predictionDeadlineAt.toISOString(), "2026-07-22T08:00:00.000Z");
  assert.equal(timeline.lineupFetchStartAt.toISOString(), "2026-07-22T08:00:00.000Z");
});

test("スタメン取得はCronの秒ずれを10分枠として扱い、開始後は取得しない", async () => {
  const automation = await import(pathToFileURL(path.join(root, "pregame-automation.js")).href);
  const timeline = automation.getPregameTimeline("2026-07-22-l-f-16");
  assert.equal(automation.getDueLineupAttemptAt(timeline, new Date("2026-07-22T08:10:37.000Z")).toISOString(), "2026-07-22T08:10:00.000Z");
  assert.equal(automation.getDueLineupAttemptAt(timeline, new Date("2026-07-22T09:00:01.000Z")), null);
});
