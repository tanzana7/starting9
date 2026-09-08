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
const roster = read("frontend/public/roster.js");

function loadHubSelector() {
  const start = script.indexOf("function getPublicGameHubGames");
  const end = script.indexOf("function formatPublicGameHubDate", start);
  const context = {
    getJapanDateString: () => "2026-09-08",
    getScheduleDate: (game) => game.date,
    getScheduleStartTime: (game) => game.startTime,
    getScheduleSortValue: (game) => `${game.date}T${game.startTime}`,
    isNormalManagedSchedule: (game) => game.isTestGame !== true,
    Date
  };
  vm.createContext(context);
  vm.runInContext(script.slice(start, end), context);
  return context.getPublicGameHubGames;
}

test("試合ハブはcanonical games APIの今日と直近未来だけを表示する", () => {
  assert.match(html, /id="publicGameHub"/);
  assert.match(html, /id="publicGameHubContent"/);
  assert.match(script, /buildPublicGamesApiUrl\(\)/);
  assert.match(script, /function getPublicGameHubGames\(games = \[\], now = new Date\(\)\)/);
  assert.match(script, /futureGames = sorted\.filter\(\(game\) => getScheduleDate\(game\) > today\)\.slice\(0, 5\)/);
  assert.doesNotMatch(script, /\/api\/public\/games[^\n]*selectPublicGame/);
});

test("試合ハブの初期選択は既存の自動選択ロジックを使い、初回の強制選択を行わない", () => {
  assert.match(script, /const initialGame = getPreferredPublicGameSelection\(\)/);
  assert.match(script, /setPublicCurrentGame\(initialGame\)/);
  assert.match(script, /function getPreferredPublicGameSelection\(now = new Date\(\)\)/);
  assert.match(script, /manualGameId/);
  assert.match(script, /getPreferredPublicGameSelection\(\)/);
  assert.match(script, /if \(normalizedGameId === getCurrentGameId\(\)\) \{/);
  assert.match(script, /function selectInitialPublicGame\(games = \[\], now = new Date\(\)\)/);
});

test("試合ハブのA/B切替は選択対象をcurrent gameとして再ロードする", () => {
  assert.match(script, /function selectPublicGame\(internalGameId\)/);
  assert.match(script, /const game = state\.publicGameCatalog\.games\.find/);
  assert.match(script, /setPublicCurrentGame\(game\)/);
  assert.match(script, /initializeRosterCandidateSync\(\)/);
  assert.match(script, /fetchStoredProbableStarter\(\)/);
  assert.match(script, /syncPredictionFromAccount\(\{ force: true \}\)/);
  assert.match(script, /setLineupValues\("prediction", state\.prediction\?\.lineup \|\| \[\]\)/);
});

test("試合単位localStorageはA/Bを分離し、旧キーは一致する試合だけ移行する", () => {
  assert.match(script, /function getGameScopedStorageKey\(key, gameId\)/);
  assert.match(script, /:game:\$\{encodeURIComponent\(normalizedGameId\)\}/);
  assert.match(script, /function loadGameScopedStorage\(key\)/);
  assert.match(script, /legacyGameId === gameId/);
  assert.match(script, /function hydrateGameScopedState\(gameId\)/);
  assert.match(script, /state\.prediction = prediction\?\.gameId === normalizedGameId \? prediction : null/);
  assert.match(script, /persistCurrentGameScopedState\(\)/);
});

test("試合単位の切替で旧roster・予告先発・結果を画面に残さない", () => {
  const setterStart = script.indexOf("function setPublicCurrentGame");
  const setterEnd = script.indexOf("async function initializePublicGameCatalog", setterStart);
  const setter = script.slice(setterStart, setterEnd);
  assert.match(setter, /beginPublicRequest\("account", \{ abort: true \}\)/);
  assert.match(setter, /beginPublicRequest\("probable", \{ abort: true \}\)/);
  assert.match(setter, /state\.predictionRemote = createEmptyPredictionRemoteState\(\)/);
  assert.match(setter, /state\.prediction = null/);
  assert.match(setter, /state\.actual = null/);
  assert.match(setter, /state\.result = null/);
  assert.match(script, /state\.publicRoster = \{[\s\S]*status: "pending"/);
});

test("roster・probable・predictionのstale responseはrequest guardとgame IDで拒否する", () => {
  assert.match(roster, /deps\.requestGuard\.isCurrent\("roster", requestId\)/);
  assert.match(roster, /internalGameId !== deps\.getTargetInternalGameId\(\)/);
  assert.match(script, /isCurrentPublicRequest\("probable", request\.id\) \|\| getCurrentGameId\(\) !== game\.internalGameId/);
  assert.match(script, /isCurrentPublicRequest\("account", request\.id\) \|\| getCurrentGameId\(\) !== gameId/);
  assert.match(script, /beginPublicRequest\("account", \{ abort: true \}\)/);
  assert.match(script, /beginPublicRequest\("probable", \{ abort: true \}\)/);
});

test("締切・公開済み・中止の状態表示は既存判定を再利用する", () => {
  assert.match(script, /getPublicGameStatusView\(game, deadline, state\.predictionRemote, now\)/);
  assert.match(script, /const disabled = isScheduleGameUnavailable\(game\)/);
  assert.match(script, /if \(isScheduleGameUnavailable\(game\)\) return/);
  assert.match(script, /label: lineupWaiting \? "スタメン待ち" : "締切済み"/);
  assert.match(script, /label: "結果公開済み"/);
});

test("API errorにはエラー表示と再試行があり、既存ゲーム一覧がある場合は画面を破棄しない", () => {
  assert.match(script, /data-public-games-retry/);
  assert.match(script, /initializePublicGameCatalog\(\{ force: true \}\)/);
  assert.match(script, /catalog\.message = "試合情報を取得できませんでした。"/);
  assert.match(script, /if \(catalog\.message && !catalog\.games\.length\)/);
  assert.match(script, /catalog\.games = mergePublicGameSchedules\(\[\], apiGames\)/);
});

test("試合なし表示は架空の試合を作らず既存導線へ案内する", () => {
  assert.match(script, /現在、予想受付中の試合はありません。/);
  assert.match(script, /href="#result-title"/);
  assert.match(script, /href="\.\/how-to-play\.html"/);
});

test("ハブカードはキーボード操作可能なbuttonで選択状態を表現する", () => {
  assert.match(script, /<button type="button" class="public-game-hub-select"/);
  assert.match(script, /aria-pressed=/);
  assert.match(css, /\.public-game-hub-select:focus-visible/);
});

test("ハブの未来試合選択ロジックは今日と未来を分離する", () => {
  const getGames = loadHubSelector();
  const games = getGames([
    { internalGameId: "future-late", canonical: true, date: "2026-09-11", startTime: "18:00" },
    { internalGameId: "today", canonical: true, date: "2026-09-08", startTime: "18:00" },
    { internalGameId: "future-near", canonical: true, date: "2026-09-09", startTime: "18:00" },
    { internalGameId: "old", canonical: true, date: "2026-09-07", startTime: "18:00" },
    { internalGameId: "test", canonical: true, date: "2026-09-10", startTime: "18:00", isTestGame: true }
  ]);
  assert.equal(JSON.stringify(games.map((game) => game.internalGameId)), JSON.stringify(["today", "future-near", "future-late"]));
});

test("公開ハブはフロントエンドのみで、Auth Workerとschemaを変更しない", () => {
  assert.match(html, /public-game-hub-1/);
  assert.doesNotMatch(script, /CREATE TABLE/);
  assert.doesNotMatch(script, /\/api\/public\/games.*PUT|\/api\/public\/games.*POST/);
});
