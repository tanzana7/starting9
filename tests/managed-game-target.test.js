const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("公開bundleに旧管理対象試合の初期化処理を含めない", () => {
  const script = read("script.js");
  assert.doesNotMatch(script, /selectAdminTargetGame|restoreManagedGameSchedule|renderLoadedScheduleInfo/);
  assert.match(script, /initializePublicGameCatalog/);
});

test("公開bundleに旧管理対象試合の自動反映ログを含めない", () => {
  const script = read("script.js");
  assert.doesNotMatch(script, /addScheduleLoadLog|自動反映した試合|applyGameSchedule/);
});

test("管理画面の公開状態更新ではブラウザが次戦へ自動切替しない", () => {
  const script = read("script.js");
  assert.doesNotMatch(script, /payload\?\.publishing\?\.status === "published"[\s\S]*?applyGameSchedule\(nextSchedule, "auto"\)/);
});

test("公開カタログは通常試合だけをcanonical対象として扱う", () => {
  const script = read("script.js");
  assert.match(script, /function isNormalManagedSchedule\(schedule\)/);
  assert.match(script, /schedule\?\.isTestGame !== true/);
  assert.match(script, /schedule\?\.isAutoScoringTest !== true/);
  assert.match(script, /mergePublicGameSchedules/);
  assert.match(script, /game\.internalGameId/);
});

test("日程JSONの自動読込成功・開始ログとNPB URL生成ログを画面ログへ追加しない", () => {
  const schedule = read("game-schedule.js");
  const script = read("script.js");
  assert.doesNotMatch(schedule, /addScheduleLog\("日程JSONの読み込みを開始"\)/);
  assert.doesNotMatch(schedule, /addScheduleLog\(`日程JSONを読み込みました/);
  assert.doesNotMatch(script, /addScheduleLoadLog\(`NPB URL生成/);
});

test("公開bundleは旧管理対象gameIdではなくcanonical対象を保持する", () => {
  const script = read("script.js");
  assert.match(script, /gameInfo: "hamStarting9GameInfo"/);
  assert.match(script, /state\.gameInfo = normalizeGameInfo\(loadFromStorage\(STORAGE_KEYS\.gameInfo\)\)/);
  assert.match(script, /state\.predictionTargetGame\?\.internalGameId/);
  assert.doesNotMatch(script, /state\.nextScheduleId/);
});
