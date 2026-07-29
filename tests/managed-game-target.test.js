const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("保存済み管理対象試合はページ初期化で復元し、日程から再選択しない", () => {
  const script = read("script.js");
  const savedBranch = script.indexOf("const savedGameId = state.gameInfo.selectedGameId || state.nextScheduleId;");
  const selector = script.indexOf("const nextSchedule = selectAdminTargetGame();");

  assert.ok(savedBranch >= 0);
  assert.ok(selector > savedBranch);
  assert.match(script, /restoreManagedGameSchedule\(savedSchedule\);/);
  assert.match(script, /renderLoadedScheduleInfo\(schedule, scoreUrl\);/);
});

test("同じgameIdの適用は保存・自動反映ログを行わず表示だけ復元する", () => {
  const script = read("script.js");
  assert.match(script, /const targetChanged = previousGameId !== \(schedule\.gameId \|\| ""\);/);
  assert.match(script, /if \(!targetChanged\) \{[\s\S]*?restoreManagedGameSchedule\(schedule\);[\s\S]*?return false;/);
  assert.match(script, /if \(source === "auto"\) \{[\s\S]*?addScheduleLoadLog\(`自動反映した試合/);
});

test("管理画面の公開状態更新ではブラウザが次戦へ自動切替しない", () => {
  const script = read("script.js");
  assert.doesNotMatch(script, /payload\?\.publishing\?\.status === "published"[\s\S]*?applyGameSchedule\(nextSchedule, "auto"\)/);
});

test("通常の管理対象試合からテスト試合を除外する", () => {
  const script = read("script.js");
  assert.match(script, /function isNormalManagedSchedule\(schedule\)/);
  assert.match(script, /schedule\?\.isTestGame !== true/);
  assert.match(script, /schedule\?\.isAutoScoringTest !== true/);
  assert.match(script, /getHamGameSchedule\(\)\.filter\(isNormalManagedSchedule\)/);
  assert.match(script, /find\(\(item\) => isNormalManagedSchedule\(item\) && item\.gameId === gameId\)/);
});

test("日程JSONの自動読込成功・開始ログとNPB URL生成ログを画面ログへ追加しない", () => {
  const schedule = read("game-schedule.js");
  const script = read("script.js");
  assert.doesNotMatch(schedule, /addScheduleLog\("日程JSONの読み込みを開始"\)/);
  assert.doesNotMatch(schedule, /addScheduleLog\(`日程JSONを読み込みました/);
  assert.doesNotMatch(script, /addScheduleLoadLog\(`NPB URL生成/);
});

test("管理対象gameIdは既存のgameInfo永続化キーから復元される", () => {
  const script = read("script.js");
  assert.match(script, /gameInfo: "hamStarting9GameInfo"/);
  assert.match(script, /state\.gameInfo = normalizeGameInfo\(loadFromStorage\(STORAGE_KEYS\.gameInfo\)\)/);
  assert.match(script, /selectedGameId: state\.nextScheduleId \|\| state\.gameInfo\.selectedGameId \|\| ""/);
});
