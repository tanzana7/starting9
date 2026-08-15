import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const publicResults = fs.readFileSync(path.join(root, "backend", "domain", "public-results.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const publicState = fs.readFileSync(path.join(root, "frontend", "public", "state.js"), "utf8");
const publicResultsRenderer = fs.readFileSync(path.join(root, "frontend", "public", "render-results.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("published済みV3結果はgamesのcanonical rowから一覧メタデータを作る", () => {
  const start = worker.indexOf("async function getResultGameMetadata");
  const end = worker.indexOf("async function handleGetResultGames", start);
  const resolver = worker.slice(start, end);
  assert.match(resolver, /FROM games WHERE internal_game_id = \?1 LIMIT 1/);
  assert.match(resolver, /resultId: internalGameId/);
  assert.match(resolver, /internalGameId,/);
  assert.match(resolver, /displayLabel: createPublicResultDisplayLabel/);
  assert.match(publicResults, /fighters: "日本ハム"/);
  assert.match(publicResults, /eagles: "楽天"/);
});

test("結果詳細はUUIDでprediction・ranking・公開状態を読む", () => {
  const start = worker.indexOf("async function handleGetResultGame");
  const end = worker.indexOf("async function getTableColumnSet", start);
  const handler = worker.slice(start, end);
  assert.match(handler, /const resultId = String\(game\.resultId \|\| metadata\.internalGameId/);
  assert.match(handler, /getRankingGameState\(env\.AUTH_DB, resultId, internalGameId\)/);
  assert.match(handler, /getPredictionRow\(env\.AUTH_DB, access\.user\.id, \{ gameId: resultId, internalGameId \}\)/);
  assert.match(handler, /isGameResultsPublished\(env\.AUTH_DB, resultId, new Date\(\)\)/);
  assert.match(handler, /internalGameId,/);
});

test("通常画面は公開済み結果を自動選択し、内部IDを表示しない", () => {
  assert.match(script, /const latestPublishedGame = state\.resultHistory\.games\.find/);
  assert.match(script, /if \(!state\.resultHistory\.selectedGameId && latestPublishedGame\)/);
  assert.doesNotMatch(script, /if \(!state\.result && !state\.resultHistory\.selectedGameId && latestPublishedGame\)/);
  assert.match(script, /await loadResultHistoryGame\(getResultHistoryGameId\(latestPublishedGame\)\)/);
  assert.match(script, /const matchup = formatResultHistoryMatchup\(game\)/);
  assert.match(script, /対戦情報を確認中/);
  const rendererStart = script.indexOf("function renderResultHistory");
  const rendererEnd = script.indexOf("function buildCurrentPredictionApiUrl", rendererStart);
  const renderer = script.slice(rendererStart, rendererEnd);
  assert.doesNotMatch(renderer, /: game\.gameId/);
  assert.match(renderer, /data-result-history-toggle/);
  assert.match(renderer, /data-result-history-select/);
  assert.doesNotMatch(renderer, /class="result-history-item/);
});

test("公開結果は予想入力状態から独立して保持し、履歴一覧は最新5件に制限する", () => {
  assert.match(publicState, /results: \{ latest: null, history: state\.resultHistory \}/);
  assert.match(publicResultsRenderer, /const displayedResult = deps\.state\.resultHistory\.result \|\| deps\.state\.result/);
  assert.match(publicResultsRenderer, /games\.slice\(0, 5\)/);
  const handlerStart = worker.indexOf("async function handleGetResultGames");
  const handlerEnd = worker.indexOf("async function handleGetResultGame(", handlerStart);
  assert.match(worker.slice(handlerStart, handlerEnd), /LIMIT \$\{PUBLIC_RESULT_HISTORY_LIMIT\}/);
  assert.match(publicResults, /PUBLIC_RESULT_HISTORY_LIMIT = 5/);
});

test("通常画面の公開結果修正は新しいcache busterを使う", () => {
  assert.match(html, /style\.css\?v=public-mobile-compact-game-meta-1/);
  assert.match(html, /script\.js\?v=public-mobile-compact-game-meta-1/);
});
