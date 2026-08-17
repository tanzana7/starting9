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

test("通常画面は自分が参加した最新の公開済み結果だけを自動選択する", () => {
  assert.match(script, /function getLatestPublicPublishedGame\(\)/);
  assert.match(script, /const latestParticipatedPublishedGame = latestPublicPublishedGame/);
  assert.match(script, /getResultHistoryGameId\(game\) === getResultHistoryGameId\(latestPublicPublishedGame\)/);
  assert.match(script, /if \(!state\.resultHistory\.selectedGameId && latestParticipatedPublishedGame\)/);
  assert.match(script, /await loadResultHistoryGame\(getResultHistoryGameId\(latestParticipatedPublishedGame\)\)/);
  assert.match(publicResultsRenderer, /if \(!history\.isReady\) return null/);
  assert.match(publicResultsRenderer, /history\.games\.some\(\(game\) => deps\.getResultHistoryGameId\(game\) === resultId\)/);
  assert.match(script, /state\.resultHistory = \{ isLoading: false, isDetailLoading: false, isReady: true, games: \[\]/);
  assert.match(script, /state\.result = null;\s+removeFromStorage\(STORAGE_KEYS\.result\);/);
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

test("前回未参加時は最新結果カードを出さず、過去結果導線だけを残す", () => {
  assert.match(publicResultsRenderer, /result-history-no-participation/);
  assert.match(publicResultsRenderer, /前回参加した試合結果はありません。過去の試合成績から確認できます。/);
  assert.match(script, /state\.resultHistory\.games = publicResultsRenderer\.limitHistory\(payload\.games\)/);
  assert.match(script, /state\.resultHistory\.message = state\.resultHistory\.games\.length \? "" : "採点済みの過去試合はありません。"/);
  assert.match(script, /data-result-history-toggle/);
  assert.match(script, /data-result-history-select/);
});

test("公開結果は予想入力状態から独立して保持し、履歴一覧は最新5件に制限する", () => {
  assert.match(publicState, /results: \{ latest: null, history: state\.resultHistory \}/);
  assert.match(publicResultsRenderer, /function getDisplayedResult\(\)/);
  assert.match(publicResultsRenderer, /const displayedResult = getDisplayedResult\(\)/);
  assert.match(publicResultsRenderer, /games\.slice\(0, 5\)/);
  const handlerStart = worker.indexOf("async function handleGetResultGames");
  const handlerEnd = worker.indexOf("async function handleGetResultGame(", handlerStart);
  assert.match(worker.slice(handlerStart, handlerEnd), /LIMIT \$\{PUBLIC_RESULT_HISTORY_LIMIT\}/);
  assert.match(publicResults, /PUBLIC_RESULT_HISTORY_LIMIT = 5/);
});

test("通常画面の公開結果修正は新しいcache busterを使う", () => {
  assert.match(html, /style\.css\?v=public-hide-comparison-default-own-latest-result-1/);
  assert.match(html, /script\.js\?v=public-hide-comparison-default-own-latest-result-1/);
});
