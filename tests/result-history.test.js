import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authWorkerPath = path.join(root, "auth-worker.js");
const authWorkerUrl = pathToFileURL(authWorkerPath).href;
const worker = fs.readFileSync(authWorkerPath, "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "frontend/public/results.js"), "utf8");
const predictionForm = fs.readFileSync(path.join(root, "frontend", "public", "prediction-form.js"), "utf8");
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

test("過去結果APIは採点済みの通常試合だけを一覧化し、公開前データを隠す", () => {
  assert.match(worker, /path === "\/api\/results\/games" && request\.method === "GET"/);
  assert.match(worker, /async function handleGetResultGames\(request, env, cors\)/);
  assert.match(worker, /latest_predictions\.status = 'scored'/);
  assert.match(worker, /ranking_games\.game_status = 'scored'/);
  assert.match(worker, /ranking_games\.is_test_game = 0/);
  assert.match(worker, /const resultsPublished = await isGameResultsPublished/);
  assert.match(worker, /SELECT predictions\.game_id, predictions\.internal_game_id/);
  assert.match(worker, /const resultId = String\(row\.internal_game_id \|\| row\.game_id \|\| ""\)/);
  assert.match(worker, /resultId: metadata\.resultId \|\| resultId/);
  assert.match(worker, /score: resultsPublished && row\.score !== null/);
  assert.match(worker, /actualLineup: resultsPublished && row\.actual_lineup_json/);
});

test("結果詳細APIはcanonical internalGameId経路を維持する", () => {
  assert.match(worker, /function parseResultGameRoute\(path\)/);
  assert.match(worker, /async function handleGetResultGame\(request, env, cors, gameId\)/);
  assert.match(worker, /const resultGameRoute = parseResultGameRoute\(path\)/);
});

test("過去結果一覧APIは各行のメタデータを解決する", () => {
  assert.match(worker, /const games = await Promise\.all\(\(rows\.results \|\| \[\]\)\.map/);
});


test("通常画面はcanonical public gameのinternalGameIdを予想保存と締切判定へ引き継ぐ", () => {
  assert.match(script, /const nextGame = catalogGame \|\| await resolvePredictionTargetGame\(schedule, useServer\)/);
  assert.match(script, /state\.predictionTargetGame = nextGame \|\| null/);
  assert.match(script, /async function refreshPredictionTarget\(\{ retryUnannounced = true, useServer = true \} = \{\}\)/);
  assert.doesNotMatch(script, /state\.isAdminMode/);
  assert.match(script, /state\.predictionTargetGameId = nextId/);
  assert.match(script, /state\.predictionTargetGame\?\.gameId === gameId \|\| state\.predictionTargetGame\?\.internalGameId === gameId \? state\.predictionTargetGame : null/);
  assert.match(predictionForm, /deps\.state\.prediction = \{\s*gameId: deps\.getCurrentGameId\(\)/);
});
