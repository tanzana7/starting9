import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authWorkerPath = path.join(root, "auth-worker.js");
const authWorkerUrl = pathToFileURL(authWorkerPath).href;
const worker = fs.readFileSync(authWorkerPath, "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("試合開始前は対象を維持し、開始時刻到達後は次の試合を選択する", async () => {
  const { selectNextPredictionTarget } = await import(authWorkerUrl);
  const games = [
    { gameId: "2026-07-25-f-e-14", date: "2026-07-25", startTime: "14:00", status: "scheduled" },
    { gameId: "2026-07-26-f-e-15", date: "2026-07-26", startTime: "15:00", status: "scheduled" }
  ];

  assert.equal(
    selectNextPredictionTarget(games, new Date("2026-07-25T04:59:59.000Z")).gameId,
    "2026-07-25-f-e-14"
  );
  assert.equal(
    selectNextPredictionTarget(games, new Date("2026-07-25T05:00:00.000Z")).gameId,
    "2026-07-26-f-e-15"
  );
  assert.equal(
    selectNextPredictionTarget(games, new Date("2026-07-26T06:00:00.000Z")),
    null
  );
});

test("同じ試合を重複切り替えせず、次戦がない場合も現在のデータを破壊しない", async () => {
  const { selectNextPredictionTarget } = await import(authWorkerUrl);
  const games = [
    { gameId: "2026-07-25-f-e-14", date: "2026-07-25", startTime: "14:00", status: "scheduled" },
    { gameId: "2026-07-25-f-e-14", date: "2026-07-25", startTime: "14:00", status: "scheduled" }
  ];
  const now = new Date("2026-07-25T04:00:00.000Z");
  assert.equal(selectNextPredictionTarget(games, now).gameId, "2026-07-25-f-e-14");
  assert.equal(selectNextPredictionTarget(games, now).gameId, "2026-07-25-f-e-14");
  assert.match(script, /if \(!nextGame\) \{\s+return;\s+\}/);
  assert.match(script, /const preservedGame = nextGame \|\| schedule\.find/);
  assert.match(worker, /const target = selectNextPredictionTarget\(\[\.\.\.detectedGames, \.\.\.getScheduledGames\(\)\], now\)/);
  assert.match(worker, /if \(path === "\/api\/prediction-target" && request\.method === "GET"\)/);
  assert.match(worker, /export async function runScheduledGameAutomation\(env, now\)/);
});

test("過去結果APIは採点済みの通常試合だけを一覧化し、公開前データを隠す", () => {
  assert.match(worker, /path === "\/api\/results\/games" && request\.method === "GET"/);
  assert.match(worker, /async function handleGetResultGames\(request, env, cors\)/);
  assert.match(worker, /latest_predictions\.status = 'scored'/);
  assert.match(worker, /ranking_games\.game_status = 'scored'/);
  assert.match(worker, /ranking_games\.is_test_game = 0/);
  assert.match(worker, /const resultsPublished = await isGameResultsPublished/);
  assert.match(worker, /score: resultsPublished && row\.score !== null/);
  assert.match(worker, /actualLineup: resultsPublished && row\.actual_lineup_json/);
});

test("gameId指定の結果詳細APIと通常画面の選択UIが存在する", () => {
  assert.match(worker, /function parseResultGameRoute\(path\)/);
  assert.match(worker, /async function handleGetResultGame\(request, env, cors, gameId\)/);
  assert.match(worker, /const resultGameRoute = parseResultGameRoute\(path\)/);
  assert.match(script, /function buildResultGamesApiUrl\(gameId = ""\)/);
  assert.match(script, /function handleResultHistoryClick\(event\)/);
  assert.match(script, /data-result-game-id/);
  assert.match(html, /id="resultHistoryList"/);
  assert.match(html, /過去の試合結果/);
});

test("ページを開かなくてもCronがサーバー側の対象試合評価を呼ぶ", () => {
  assert.match(worker, /await syncTodayFightersSchedule\(env, now\)/);
  assert.match(worker, /scheduleSync\.predictionTarget = await getServerPredictionTarget\(env\.AUTH_DB, now\)/);
  assert.doesNotMatch(script, /runScheduledGameAutomation\(/);
});

test("通常画面はprediction-targetの保存済みgameIdを予想保存と締切判定へ引き継ぐ", () => {
  assert.match(script, /const nextGame = await resolvePredictionTargetGame\(schedule, true\)/);
  assert.match(script, /state\.predictionTargetGame = preservedGame/);
  assert.match(script, /async function refreshPredictionTarget\(\{ retryUnannounced = true, useServer = true \} = \{\}\)/);
  assert.match(script, /if \(!response\.ok \|\| !payload\?\.ok\) return null/);
  assert.match(script, /state\.predictionTargetGame\?\.gameId === gameId \? state\.predictionTargetGame : null/);
  assert.match(script, /state\.prediction = \{\s*gameId: getCurrentGameId\(\)/);
});
