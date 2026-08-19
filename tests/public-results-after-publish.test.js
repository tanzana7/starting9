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
  assert.match(worker, /path === "\/api\/public\/previous-result-game" && request\.method === "GET"/);
  assert.match(script, /function fetchPreviousResultGame\(\{ force = false \} = \{\}\)/);
  assert.match(script, /function resolveResultHistorySelection\(\)/);
  assert.match(script, /getResultHistoryGameId\(game\) === String\(previousGame\.internalGameId \|\| ""\)/);
  assert.match(script, /if \(latestParticipatedPublishedGame\)/);
  assert.match(script, /void loadResultHistoryGame\(getResultHistoryGameId\(latestParticipatedPublishedGame\), \{ manual: false \}\)/);
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
  assert.match(publicResultsRenderer, /前回は参加していません。過去に参加した試合は「過去の試合成績を見る」から確認できます。/);
  assert.match(publicResultsRenderer, /if \(previousGame\)/);
  assert.match(publicResultsRenderer, /ログインすると前回の採点結果を確認できます。/);
  assert.match(publicResultsRenderer, /前回\（\$\{date\}）の採点結果/);
  assert.match(publicResultsRenderer, /function updateResultHeader\(game, hasResult, displayMode = "previous"\)/);
  assert.match(publicResultsRenderer, /date \? `\$\{date\}の採点結果` : "選択した試合の採点結果"/);
  assert.match(publicResultsRenderer, /history\.displayMode/);
  assert.match(publicResultsRenderer, /legend\.classList\.toggle\("hidden", !hasResult\)/);
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
  assert.match(html, /style\.css\?v=public-beta-release-qa-fixes-1/);
  assert.match(html, /script\.js\?v=public-result-loading-speed-improvement-1/);
});

test("結果表示の公開文言は前回基準で、旧採点待ち文言を残さない", () => {
  assert.match(html, /id="result-title">前回の採点結果/);
  assert.match(html, /id="result-legend" class="hidden">◎は完全一致、◯はスタメン入り、×はスタメン外です。/);
  assert.doesNotMatch(html, /最新の採点結果|採点すると結果が表示されます/);
  assert.doesNotMatch(publicResultsRenderer, /採点すると結果が表示されます/);
  assert.match(publicResultsRenderer, /結果公開後に表示されます/);
});

test("前回の公開状態で未参加文言と公開待ち文言を分ける", () => {
  assert.match(publicResultsRenderer, /function getPreviousPublicGame\(\)/);
  assert.match(publicResultsRenderer, /前回は参加していません。/);
  assert.match(publicResultsRenderer, /結果公開後に表示されます。/);
  assert.doesNotMatch(publicResultsRenderer, /前回参加した試合結果はありません。過去に参加した試合/);
});

test("前回公開試合APIは公開ゲーム一覧と分離し、過去・当日だけを既存公開判定で返す", () => {
  const start = worker.indexOf("async function handleGetPreviousResultGame");
  const end = worker.indexOf("async function handleGetProbableStarter", start);
  const handler = worker.slice(start, end);
  assert.match(handler, /WHERE game_date <= \?1/);
  assert.match(handler, /ORDER BY game_date DESC, start_time DESC/);
  assert.match(handler, /isGameResultsPublished\(env\.AUTH_DB, internalGameId, now\)/);
  assert.match(handler, /INTERNAL_GAME_ID_PATTERN\.test\(internalGameId\)/);
  assert.match(handler, /LOWER\(home_team\) = 'fighters' OR LOWER\(away_team\) = 'fighters'/);
  assert.match(handler, /state: "published"/);
  assert.match(handler, /let game = null/);
  assert.match(handler, /Cache-Control/, "公開メタデータはno-storeで返す");
});

test("前回結果の読み込みはランキング・ベストナインの完了を待たずに開始する", () => {
  const coordinatorStart = fs.readFileSync(path.join(root, "frontend", "public", "app-coordinator.js"), "utf8");
  assert.match(coordinatorStart, /void ops\.fetchPreviousResultGame\(\{ force: false \}\)/);
  assert.match(coordinatorStart, /void ops\.initializePublicGameCatalog\(\)\s*\.then/);
  assert.match(coordinatorStart, /void Promise\.allSettled\(\[[\s\S]*ops\.initializePredictionRemoteSync\(\),[\s\S]*ops\.initializeDailyBestNine\(\)[\s\S]*\]\)/);
  assert.doesNotMatch(coordinatorStart, /await ops\.initializePublicGameCatalog\(\)/);
  assert.match(coordinatorStart, /this\.state\.publicGameCatalog\.isLoading = true/);
  assert.doesNotMatch(coordinatorStart, /await ops\.initializeDailyBestNine\(\)/);
  assert.doesNotMatch(coordinatorStart, /await ops\.initializePredictionRemoteSync\(\)/);
  assert.match(publicResultsRenderer, /previousResultGame\?\.isLoading/);
  assert.match(publicResultsRenderer, /previousResultGame\?\.message/);
});
