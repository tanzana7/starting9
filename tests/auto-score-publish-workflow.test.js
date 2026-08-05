import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RESULT_RELEASE_MINUTES_AFTER_START } from "../pregame-automation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

function createIdentity() {
  return {
    startAt: new Date("2026-07-25T05:00:00.000Z"),
    lineupFetchStartAt: new Date("2026-07-25T04:00:00.000Z"),
    predictionDeadlineAt: new Date("2026-07-25T04:00:00.000Z")
  };
}

test("開始+1分の最終スタメンを開始+2分に採点し、開始+10分に公開する", () => {
  assert.equal(RESULT_RELEASE_MINUTES_AFTER_START, 10);
  assert.match(worker, /RESULT_RELEASE_MINUTES_AFTER_START,\s*getScheduledGame/);
  assert.match(worker, /scoringDueAt: new Date\(identity\.startAt\.getTime\(\) \+ 2 \* 60 \* 1000\)/);
  assert.match(worker, /id: "final_lineup", offsetMinutes: AUTOMATION_V2_TIMING\.finalLineupMinutesAfterStart/);
  assert.match(worker, /id: "score", offsetMinutes: 2/);
  assert.match(worker, /id: "publish", offsetMinutes: AUTOMATION_V2_TIMING\.publicationMinutesAfterStart/);
  assert.match(worker, /if \(now < timeline\.resultReleaseAt\) continue/);
  assert.match(worker, /const resultReleaseAt = new Date\(startAt\.getTime\(\) \+ RESULT_RELEASE_MINUTES_AFTER_START \* 60 \* 1000\)/);
  assert.match(worker, /if \(now < resultReleaseAt\) return \{ published: false, status: "not_due"/);
});

test("採点更新と非公開ランキング化を同じD1 batchへ含める", () => {
  assert.match(worker, /const rankingStatement = await createGameRankingScoredPrivateStatement\(db, gameId, scoredAt, 0, internalGameId\)/);
  assert.match(worker, /statements\.push\(rankingStatement\)/);
  assert.match(worker, /const results = await db\.batch\(statements\)/);
  assert.match(worker, /publication_status = 'scored_private'/);
  assert.match(worker, /VALUES \(\?1, \?2, 1, \?4, 'scored'/);
});

test("最終スタメン取得失敗時は有効な仮スタメンへフォールバックし、管理状態へ記録する", () => {
  assert.match(worker, /async function useProvisionalLineupFallback/);
  assert.match(worker, /sanitizeActualLineupForScoring\(provisional\)/);
  assert.match(worker, /final_lineup_fallback_used = 1/);
  assert.match(worker, /最終取得失敗・直前取得データを使用/);
  assert.match(worker, /if \(isFinalPhase\) \{[\s\S]*?useProvisionalLineupFallback/);
  assert.match(worker, /if \(!actualResult\.ok\) return \{ used: false \}/);
});

test("公開前のユーザーAPIは得点、実スタメン、満点者、ランキングを返さない", () => {
  assert.match(worker, /status: published \? row\.status : row\.status === "scored" \? "submitted"/);
  assert.match(worker, /score: published && row\.score !== null \? Number\(row\.score\) : null/);
  assert.match(worker, /actualLineup: published && row\.actual_lineup_json/);
  assert.match(worker, /if \(!await isGameResultsPublished\(env\.AUTH_DB, gameId, new Date\(\)\)\)/);
  assert.match(worker, /publication_status = 'published'/);
});

test("採点済みなら正式結果公開前でもランキング集計対象にする", () => {
  const match = /function createRankingCte\(\) \{[\s\S]*?return `([\s\S]*?)`;/m.exec(worker);
  assert.ok(match);
  assert.doesNotMatch(match[1], /publication_status = 'published'/);
});

test("管理状態は採点待ち、採点中、非公開採点済み、公開済み、失敗を区別する", async () => {
  const { deriveGameWorkflowProgress } = await import(authWorkerUrl);
  const identity = createIdentity();

  assert.equal(deriveGameWorkflowProgress({ identity, now: new Date("2026-07-25T04:30:00.000Z") }).currentStep, "lineup");
  assert.equal(deriveGameWorkflowProgress({ identity, lineup: { scoring_status: "pending", publication_status: "pending" } }).lastResult, "scoring_pending");
  assert.equal(deriveGameWorkflowProgress({ identity, lineup: { scoring_status: "processing", publication_status: "pending" } }).lastResult, "scoring");
  assert.equal(deriveGameWorkflowProgress({ identity, lineup: { scoring_status: "scored", publication_status: "scored_private" } }).lastResult, "scored_private");
  assert.equal(deriveGameWorkflowProgress({ identity, lineup: { scoring_status: "scored", publication_status: "published" } }).lastResult, "published");
  assert.equal(deriveGameWorkflowProgress({ identity, job: { last_error_code: "PUBLISH_FAILED", last_error_message: "safe failure" }, lineup: { scoring_status: "scored", publication_status: "scored_private" } }).lastResult, "publish_failed");
  assert.equal(deriveGameWorkflowProgress({ identity, lineup: { scoring_status: "failed", publication_status: "pending", last_error: "safe failure" } }).lastResult, "scoring_failed");
});

test("Cronと手動フォールバックは共通の採点・公開関数を使い、失敗を状態へ記録する", () => {
  assert.match(worker, /async function scoreClaimedGameLineup/);
  assert.match(worker, /async function publishScoredGameResults/);
  assert.match(worker, /publishScoredGameResults\(env, timeline\.gameId, now\)/);
  assert.match(worker, /publishScoredGameResults\(env, metadata\.gameId, new Date\(\)\)/);
  assert.match(worker, /recordGameWorkflowOutcome\(env\.AUTH_DB, claimed\.game_id, "score", "failed"/);
  assert.match(worker, /recordGameWorkflowOutcome\(env\.AUTH_DB, gameId, "publish", "failed"/);
});

test("復旧したpublication jobは既存executorから公開済み状態とsucceededへ進む", () => {
  const executorStart = worker.indexOf("async function executeCompletionWorkflowJob");
  const executorEnd = worker.indexOf("async function runDueCompletionWorkflowJobs", executorStart);
  const executor = worker.slice(executorStart, executorEnd);
  const publicationStart = worker.indexOf("async function publishGameResults");
  const publicationEnd = worker.indexOf("async function publishScoredGameResults", publicationStart);
  const publication = worker.slice(publicationStart, publicationEnd);
  assert.match(executor, /job\.job_type === "publication"/);
  assert.match(executor, /publishScoredGameResults\(env, target\.gameId, now/);
  assert.match(executor, /to: "published", completedJobType: job\.job_type/);
  assert.match(executor, /completeWorkflowJob\(env\.AUTH_DB/);
  assert.match(publication, /publication_status = 'published'/);
  assert.match(publication, /published_at = \?1/);
});
