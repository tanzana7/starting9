import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

test("正式スタメン保存を採点トリガーにし、公開は試合開始後に限定する", () => {
  assert.match(worker, /scoringDueAt: detectedAt/);
  assert.match(worker, /id: "score", trigger: "lineup_confirmed"/);
  assert.match(worker, /if \(now < timeline\.startAt\) continue/);
  assert.match(worker, /if \(now < identity\.startAt\) return \{ published: false, status: "not_due"/);
});

test("採点更新と非公開ランキング化を同じD1 batchへ含める", () => {
  assert.match(worker, /const rankingStatement = createGameRankingScoredPrivateStatement\(db, gameId, scoredAt\)/);
  assert.match(worker, /statements\.push\(rankingStatement\)/);
  assert.match(worker, /const results = await db\.batch\(statements\)/);
  assert.match(worker, /publication_status = 'scored_private'/);
});

test("公開前のユーザーAPIは得点、実スタメン、満点者、ランキングを返さない", () => {
  assert.match(worker, /status: published \? row\.status : row\.status === "scored" \? "submitted"/);
  assert.match(worker, /score: published && row\.score !== null \? Number\(row\.score\) : null/);
  assert.match(worker, /actualLineup: published && row\.actual_lineup_json/);
  assert.match(worker, /if \(!await isGameResultsPublished\(env\.AUTH_DB, gameId, new Date\(\)\)\)/);
  assert.match(worker, /is_ranking_eligible = 0/);
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
