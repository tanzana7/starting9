const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const script = read("script.js");
const css = read("style.css");

function loadInitialGameSelector(deadlineStatus = "open") {
  const start = script.indexOf("function getPublicSelectableGames");
  const end = script.indexOf("function getPreferredPublicGameSelection", start);
  const context = {
    getJapanDateString: () => "2026-09-08",
    getScheduleDate: (game) => game.date,
    getScheduleSortValue: (game) => `${game.date}T${game.startTime}`,
    isNormalManagedSchedule: (game) => game.isTestGame !== true,
    isScheduleGameUnavailable: (game) => game.unavailable === true,
    isPublicGamePublished: (game) => game.published === true,
    parseJstScheduleDateTime: (game) => new Date(`${game.date}T${game.startTime}:00+09:00`),
    resolvePredictionDeadline: () => ({ status: deadlineStatus }),
    Date
  };
  vm.createContext(context);
  vm.runInContext(script.slice(start, end), context);
  return context.selectInitialPublicGame;
}

test("公開トップからGame Hubのカード・切替UI・専用CSSを撤去する", () => {
  assert.doesNotMatch(html, /publicGameHub|GAME HUB|試合を選ぶ/);
  assert.doesNotMatch(script, /publicGameHub|public-game-hub|selectPublicGame|handlePublicGameHubClick|publicGameSelection:\s*\{/);
  assert.doesNotMatch(css, /public-game-hub/);
  assert.match(html, /id="publicGameSelectionMeta"/);
});

test("公開試合一覧はcanonical APIを読み、既存の自動選択で現在試合を決める", () => {
  assert.match(script, /buildPublicGamesApiUrl\(\)/);
  assert.match(script, /catalog\.games = mergePublicGameSchedules\(\[\], apiGames\)/);
  assert.match(script, /const initialGame = getPreferredPublicGameSelection\(\)/);
  assert.match(script, /setPublicCurrentGame\(initialGame\)/);
  assert.match(script, /function selectInitialPublicGame\(games = \[\], now = new Date\(\)\)/);
  assert.doesNotMatch(script, /manualGameId/);
});

test("今日の試合を優先し、今日がなければ次の受付可能な試合を自動選択する", () => {
  const selectInitialPublicGame = loadInitialGameSelector();
  const games = [
    { internalGameId: "next", canonical: true, date: "2026-09-09", startTime: "18:00" },
    { internalGameId: "today", canonical: true, date: "2026-09-08", startTime: "18:00" }
  ];
  assert.equal(selectInitialPublicGame(games, new Date("2026-09-08T00:00:00Z")).internalGameId, "today");
});

test("締切後・試合中も今日の未公開試合を維持し、次の受付中試合へ勝手に切り替えない", () => {
  const selectInitialPublicGame = loadInitialGameSelector("closed");
  const games = [
    { internalGameId: "today-closed", canonical: true, date: "2026-09-08", startTime: "18:00" },
    { internalGameId: "next-open", canonical: true, date: "2026-09-09", startTime: "18:00" }
  ];
  assert.equal(selectInitialPublicGame(games, new Date("2026-09-08T12:00:00Z")).internalGameId, "today-closed");
});

test("今日の試合がない場合は未来の試合を自動選択する", () => {
  const selectInitialPublicGame = loadInitialGameSelector();
  assert.equal(selectInitialPublicGame([
    { internalGameId: "next", canonical: true, date: "2026-09-09", startTime: "18:00" }
  ], new Date("2026-09-08T00:00:00Z")).internalGameId, "next");
});

test("複数のcanonical試合は既存の日時順で自動選択し、手動切替状態を持たない", () => {
  const selectInitialPublicGame = loadInitialGameSelector();
  const games = [
    { internalGameId: "late", canonical: true, date: "2026-09-09", startTime: "18:00" },
    { internalGameId: "early", canonical: true, date: "2026-09-09", startTime: "13:00" },
    { internalGameId: "test", canonical: true, date: "2026-09-09", startTime: "12:00", isTestGame: true }
  ];
  assert.equal(selectInitialPublicGame(games, new Date("2026-09-08T00:00:00Z")).internalGameId, "early");
  assert.match(script, /\.sort\(\(left, right\) => getScheduleSortValue\(left\)\.localeCompare\(getScheduleSortValue\(right\)\)\)/);
});

test("試合単位のlocalStorage分離とstale response guardは維持する", () => {
  assert.match(script, /function getGameScopedStorageKey\(key, gameId\)/);
  assert.match(script, /legacyGameId === gameId/);
  assert.match(script, /function hydrateGameScopedState\(gameId\)/);
  assert.match(script, /beginPublicRequest\("account", \{ abort: true \}\)/);
  assert.match(script, /beginPublicRequest\("probable", \{ abort: true \}\)/);
  assert.match(script, /state\.probableStarter\.nextGame\?\.internalGameId/);
});

test("予想カード内の現在試合メタはloading・error・empty stateを持つ", () => {
  assert.match(script, /function renderPublicGameSelectionMeta\(\)/);
  assert.match(script, /試合情報を確認しています。/);
  assert.match(script, /現在、予想受付中の試合はありません。/);
  assert.match(script, /data-public-games-retry/);
  assert.match(script, /initializePublicGameCatalog\(\{ force: true \}\)/);
  assert.match(script, /renderPublicPredictionSurface\(selectedGame\)/);
});

test("公開トップは新しいcache busterで単一試合表示を配信する", () => {
  assert.match(html, /style\.css\?v=public-single-game-1/);
  assert.match(html, /script\.js\?v=public-single-game-1/);
});
