const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const script = read("script.js");
const index = read("index.html");
const worker = read("auth-worker.js");

test("公開画面はcanonical catalogの未来試合を締切判定に使い、旧日程fallbackで上書きしない", () => {
  assert.match(script, /const nextGame = catalogGame \|\| await resolvePredictionTargetGame/);
  assert.doesNotMatch(script, /state\.isAdminMode/);
  assert.match(script, /state\.publicGameCatalog\.games\.find\(\(item\) => item\?\.gameId === gameId/);
  assert.match(script, /const catalogGame = state\.publicGameCatalog\.games\.length[\s\S]*?getPreferredPublicGameSelection\(\)/);
  assert.doesNotMatch(script, /applyPublicPredictionTarget|selectNextPredictionGame/);
});

test("通常画面はlocalStorageに残る旧管理試合カードを描画せず、canonical UUIDを公示対象にする", () => {
  const noticeStart = script.indexOf("function getGameDayNoticeTarget");
  const noticeEnd = script.indexOf("function buildGameDayNoticeApiUrl", noticeStart);
  const targetResolver = script.slice(noticeStart, noticeEnd);
  assert.match(targetResolver, /state\.predictionTargetGame\?\.internalGameId \|\| state\.probableStarter\.nextGame\?\.internalGameId/);
  assert.match(targetResolver, /internalGameId:/);
  assert.match(index, /script\.js\?v=public-single-game-1/);
});

test("公開ゲームAPIはFightersのcanonical games行と表示用チーム名を返す", () => {
  const start = worker.indexOf("async function handleGetPublicGames");
  const end = worker.indexOf("async function handleGetProbableStarter", start);
  const handler = worker.slice(start, end);
  assert.match(handler, /game_automation_v3_state AS workflow/);
  assert.doesNotMatch(handler, /detected_game_schedule|game_workflow_state/);
  assert.match(handler, /LOWER\(games\.home_team\) = 'fighters' OR LOWER\(games\.away_team\) = 'fighters'/);
  assert.match(handler, /gameId: row\.internal_game_id/);
  assert.match(handler, /homeTeamName: formatTargetTeamLabel\(row\.home_team, targetTeam\)/);
  assert.match(handler, /awayTeamName: formatTargetTeamLabel\(row\.away_team, targetTeam\)/);
  assert.match(handler, /targetTeam\.key === PRODUCTION_TEAM\.key\s*\? createPublicGameDisplayLabel/);
  assert.match(handler, /:\s*`\$\{formatTargetTeamLabel/);
});
