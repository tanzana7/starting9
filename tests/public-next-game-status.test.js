const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const script = read("script.js");
const css = read("style.css");
const worker = read("auth-worker.js");

test("通常画面はGame Hubを持たず、予想カード内で現在試合を案内する", () => {
  assert.match(html, /id="publicGameSelectionMeta"/);
  assert.doesNotMatch(html, /publicGameHub|public-game-hub/);
  assert.doesNotMatch(script, /renderPublicGameHub|handlePublicGameHubClick|selectPublicGame/);
  assert.match(script, /function renderPublicGameSelectionMeta\(\)/);
  assert.match(css, /\.public-game-selection-meta/);
  assert.doesNotMatch(css, /public-game-hub/);
});

test("canonical catalogを保持し、今日の受付対象がなければ未来の受付対象を使う", () => {
  assert.match(script, /function getPublicSelectableGames\(games = \[\], now = new Date\(\)\)/);
  assert.match(script, /const todayGames = selectable\.filter\(\(game\) => getScheduleDate\(game\) === today\)/);
  assert.match(script, /const futureGames = sorted\.filter\(\(game\) => getScheduleDate\(game\) > today\)\.slice\(0, 5\)/);
  assert.match(script, /const nextOpen = selectable\.find/);
  assert.match(script, /setPublicCurrentGame\(initialGame\)/);
});

test("公開済み・締切済み・中止の判定と結果導線を既存ロジックで維持する", () => {
  assert.match(script, /function getPublicGameStatusView\(game, deadline/);
  assert.match(script, /label: lineupWaiting \? "スタメン待ち" : "締切済み"/);
  assert.match(script, /label: "結果公開済み"/);
  assert.match(script, /function renderScoreResult\(\)/);
  assert.match(html, /id="result-title"/);
});

test("公開games APIはcanonical internalGameIdとV3状態を返す", () => {
  assert.match(worker, /path === "\/api\/public\/games" && request\.method === "GET"/);
  assert.match(worker, /game_automation_v3_state AS workflow/);
  assert.match(worker, /gameId: row\.internal_game_id/);
  assert.match(worker, /isPublished: publicationStatus === "published"/);
});

test("スマホでは現在試合メタを短く表示し、Game Hub専用レイアウトを持たない", () => {
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*#publicGameSelectionMeta \{[\s\S]*display: grid;[\s\S]*font-size: 0\.76rem/);
  assert.match(script, /public-game-meta-date/);
  assert.match(script, /public-game-meta-matchup/);
  assert.match(script, /public-game-meta-status/);
  assert.doesNotMatch(css, /public-game-hub-list|public-game-hub-select/);
});

test("受付可能な試合がない場合は予想入力を隠す", () => {
  assert.match(script, /renderPublicPredictionSurface\(null\)/);
  assert.match(script, /editor\.classList\.toggle\("hidden", !state\.publicGameCatalog\.isLoading\)/);
  assert.match(script, /editor\.classList\.toggle\("hidden", isScheduleGameUnavailable\(selectedGame\)\)/);
});

test("公開画面のcache busterは単一試合UI版へ更新される", () => {
  assert.match(html, /style\.css\?v=public-single-game-1/);
  assert.match(html, /script\.js\?v=public-single-game-1/);
});
