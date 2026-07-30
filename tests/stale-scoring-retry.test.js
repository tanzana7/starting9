import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const automationUrl = pathToFileURL(path.join(root, "pregame-automation.js")).href;

test("最終スタメンの再試行期限は試合開始から12時間で、期限前は再試行可能", async () => {
  const automation = await import(automationUrl);
  const timeline = {
    gameId: "2026-07-25-f-e-15",
    game: { date: "2026-07-25" },
    startAt: new Date("2026-07-25T10:00:00.000Z")
  };
  const deadline = automation.getFinalLineupRetryDeadline(timeline);
  assert.equal(automation.FINAL_LINEUP_RETRY_WINDOW_HOURS, 12);
  assert.equal(deadline.toISOString(), "2026-07-25T22:00:00.000Z");
  assert.equal(automation.isFinalLineupRetryExpired(timeline, new Date("2026-07-25T21:59:59.999Z")), false);
  assert.equal(automation.isFinalLineupRetryExpired(timeline, deadline), true);
});

test("開始時刻がない場合は試合翌日06:00 JSTを再試行期限にする", async () => {
  const { getFinalLineupRetryDeadline, isFinalLineupRetryExpired } = await import(automationUrl);
  const timeline = { gameId: "2026-07-26-f-e-16", game: { date: "2026-07-26" } };
  const deadline = getFinalLineupRetryDeadline(timeline);
  assert.equal(deadline.toISOString(), "2026-07-26T21:00:00.000Z");
  assert.equal(isFinalLineupRetryExpired(timeline, new Date("2026-07-26T20:59:59.999Z")), false);
  assert.equal(isFinalLineupRetryExpired(timeline, new Date("2026-07-26T21:00:00.000Z")), true);
});

test("取得失敗由来のLINEUP_REQUIREDは永続ログへ二重保存せず、根本原因ログを残す", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /eventType: isFinalPhase \? "final_lineup_fetch" : "lineup_fetch"/);
  assert.match(worker, /errorCode: String\(error\?\.code \|\| "LINEUP_FETCH_FAILED"\)/);
  assert.doesNotMatch(worker, /eventType: "scoring_skipped"/);
});

test("期限超過試合はSCORING_RETRY_EXPIREDを一度だけ記録し、取得・採点処理を行わない", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /const SCORING_RETRY_EXPIRED_CODE = "SCORING_RETRY_EXPIRED"/);
  assert.match(worker, /async function recordScoringRetryExpiredOnce\(db, timeline, now/);
  assert.match(worker, /eventType: "scoring_retry_expired"/);
  assert.match(worker, /status: "warning"/);
  assert.match(worker, /WHERE event_type = 'scoring_retry_expired'/);
  assert.match(worker, /next_lineup_attempt_at = NULL/);
  assert.match(worker, /if \(isFinalPhase && isFinalLineupRetryExpired\(timeline, now\)\)/);
  assert.match(worker, /await recordScoringRetryExpiredOnce\(env\.AUTH_DB, timeline, now/);
  assert.match(worker, /continue;/);
});

test("有効なスタメンがある試合、採点済み試合、テスト試合は既存の正常経路を維持する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /const currentLineup = await getGameLineup\(env\.AUTH_DB, gameId\);\s*if \(currentLineup\) continue;/);
  assert.match(worker, /game_id NOT IN \(SELECT game_id FROM ranking_games WHERE is_test_game = 1\)/);
  assert.match(worker, /eventType: "scoring_succeeded"/);
  assert.match(worker, /eventType: "ranking_reflected"/);
  assert.match(worker, /eventType: "result_published"/);
});

test("ログの重複キーはgameIdまたはgameDate、event、status、errorCodeを使いUTC ISO時刻で30分比較する", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /WORKFLOW_LOG_DEDUPE_WINDOW_MS = 30 \* 60 \* 1000/);
  assert.match(worker, /event_type = \?1 AND game_id = \?2 AND occurred_at > \?3/);
  assert.match(worker, /game_id IS NULL AND occurred_at > \?2/);
  assert.match(worker, /String\(metadata\?\.gameDate \|\| metadata\?\.date \|\| ""\)/);
  assert.match(worker, /recent\.status === status/);
  assert.match(worker, /String\(recent\.error_code \|\| ""\) === normalizedErrorCode/);
  assert.match(worker, /occurred\.toISOString\(\)/);
});

test("管理画面のGETログAPIは採点・取得・期限判定を起動しない", () => {
  const worker = read("auth-worker.js");
  const script = read("script.js");
  assert.match(worker, /path === "\/api\/admin\/workflow-logs" && request\.method === "GET"/);
  assert.match(worker, /async function handleAdminWorkflowLogs\(request, env, cors\)/);
  assert.doesNotMatch(script, /runDuePregameAutomationJobs/);
  assert.doesNotMatch(script, /runDueAutoScoringJobs/);
});
