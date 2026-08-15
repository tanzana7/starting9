const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const script = read("script.js");
const index = read("index.html");
const worker = read("auth-worker.js");

test("通常画面の試合カタログはcanonical APIのUUID行だけを採用する", () => {
  const start = script.indexOf("function mergePublicGameSchedules");
  const end = script.indexOf("function getPublicSelectableGames", start);
  const merger = script.slice(start, end);
  assert.match(merger, /void staticGames/);
  assert.match(merger, /Boolean\(game\?\.internalGameId\)/);
  assert.match(merger, /canonical: true/);
  assert.match(merger, /gameId: game\.internalGameId/);
  assert.doesNotMatch(merger, /merged\.set|publicGameIdentityKey/);
});

test("2026-08-09はstaticの別カードではなくcanonical Fighters対Eaglesを表示対象にする", () => {
  const start = script.indexOf("function mergePublicGameSchedules");
  const end = script.indexOf("function selectInitialPublicGame", start);
  const context = {
    isNormalManagedSchedule: () => true,
    isScheduleGameUnavailable: () => false,
    getScheduleDate: (game) => game.date,
    getScheduleSortValue: (game) => `${game.date}T${game.startTime}`,
    getJapanDateString: () => "2026-08-09"
  };
  vm.createContext(context);
  vm.runInContext(script.slice(start, end), context);

  const games = context.mergePublicGameSchedules([
    { gameId: "legacy-hawks-fighters", date: "2026-08-09", startTime: "14:00", homeTeam: "hawks", awayTeam: "fighters", matchupLabel: "ソフトバンク vs 日本ハム" }
  ], [
    { internalGameId: "348e8d56-9565-474e-96e9-33b1e5ef6ae0", date: "2026-08-09", startTime: "14:00", homeTeam: "fighters", awayTeam: "eagles", displayLabel: "日本ハム vs 楽天" }
  ]);

  assert.equal(games.length, 1);
  assert.equal(games[0].internalGameId, "348e8d56-9565-474e-96e9-33b1e5ef6ae0");
  assert.equal(games[0].displayLabel, "日本ハム vs 楽天");
  assert.equal(context.getPublicSelectableGames(games, new Date("2026-08-09T00:17:00.000Z")).map((game) => game.internalGameId).join(","), "348e8d56-9565-474e-96e9-33b1e5ef6ae0");
});

test("公開カタログとcanonical対象表示はAPI displayLabelを優先し、静的日程を上書き元にしない", () => {
  assert.match(script, /const matchup = game\?\.displayLabel \|\| game\?\.matchupLabel/);
  assert.match(script, /function formatPublicPredictionGameLabel\(game\)/);
  assert.match(script, /catalog\.games = mergePublicGameSchedules\(\[\], apiGames\)/);
  assert.match(script, /catalog\.games = \[\];\s*catalog\.message = "試合情報を取得できませんでした。"/);
});

test("公開画面はcanonical catalogの未来試合を締切判定に使い、旧日程fallbackで上書きしない", () => {
  assert.match(script, /const nextGame = catalogGame \|\| await resolvePredictionTargetGame/);
  assert.doesNotMatch(script, /state\.isAdminMode/);
  assert.match(script, /state\.publicGameCatalog\.games\.find\(\(item\) => item\?\.gameId === gameId/);
  assert.match(script, /state\.predictionTargetGameId = state\.probableStarter\.nextGame\?\.internalGameId/);
  assert.doesNotMatch(script, /applyPublicPredictionTarget|selectNextPredictionGame/);
});

test("通常画面はlocalStorageに残る旧管理試合カードを描画せず、canonical UUIDを公示対象にする", () => {
  const noticeStart = script.indexOf("function getGameDayNoticeTarget");
  const noticeEnd = script.indexOf("function buildGameDayNoticeApiUrl", noticeStart);
  const targetResolver = script.slice(noticeStart, noticeEnd);
  assert.match(targetResolver, /state\.predictionTargetGame\?\.internalGameId \|\| state\.probableStarter\.nextGame\?\.internalGameId/);
  assert.match(targetResolver, /internalGameId:/);
  assert.match(index, /script\.js\?v=public-roster-warning-show-fallback-list-1/);
});

test("公開ゲームAPIはFightersのcanonical games行と表示用チーム名を返す", () => {
  const start = worker.indexOf("async function handleGetPublicGames");
  const end = worker.indexOf("async function handleGetProbableStarter", start);
  const handler = worker.slice(start, end);
  assert.match(handler, /game_automation_v3_state AS workflow/);
  assert.doesNotMatch(handler, /detected_game_schedule|game_workflow_state/);
  assert.match(handler, /LOWER\(games\.home_team\) = 'fighters' OR LOWER\(games\.away_team\) = 'fighters'/);
  assert.match(handler, /gameId: row\.internal_game_id/);
  assert.match(handler, /homeTeamName: formatPublicResultTeamName/);
  assert.match(handler, /awayTeamName: formatPublicResultTeamName/);
  assert.match(handler, /displayLabel: createPublicGameDisplayLabel/);
});
