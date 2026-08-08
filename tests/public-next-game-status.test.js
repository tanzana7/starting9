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

test("通常画面に試合ステータスカードと未来試合セレクターがある", () => {
  for (const id of ["publicGameStatusCard", "publicGameStatusBadge", "publicGameStatusGrid", "publicGameSelect"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /GAME STATUS/);
  assert.match(html, /for="publicGameSelect"/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*#predictionForm > \.public-game-status-card[\s\S]*grid-column: 1 \/ -1/);
});

test("未来試合は今日と先の5試合を同じカタログから選択できる", () => {
  assert.match(script, /function getPublicSelectableGames\(games = \[\], now = new Date\(\)\)/);
  assert.match(script, /const todayGames = sorted\.filter\(\(game\) => getScheduleDate\(game\) === today\)/);
  assert.match(script, /const futureGames = sorted\.filter\(\(game\) => getScheduleDate\(game\) > today\)\.slice\(0, 5\)/);
  assert.match(script, /function handlePublicGameSelectionChange\(event\)/);
  assert.match(script, /syncPredictionFromAccount\(\{ force: true \}\)/);
});

test("初期試合は今日の未締切、今日の未公開、次の未来試合の順で選ぶ", () => {
  assert.match(script, /function selectInitialPublicGame\(games = \[\], now = new Date\(\)\)/);
  assert.match(script, /return todayOpen \|\| todayUnpublished \|\| selectable\.find\(\(game\) => getScheduleDate\(game\) > today\)/);
  assert.match(script, /const catalogGame = !state\.publicGameCatalog\.manualSelection/);
});

test("公開用ゲーム一覧はcanonical internalGameIdとworkflow/publication状態を返す", () => {
  assert.match(worker, /path === "\/api\/public\/games" && request\.method === "GET"/);
  assert.match(worker, /async function handleGetPublicGames\(request, env, cors\)/);
  assert.match(worker, /games\.internal_game_id/);
  assert.match(worker, /workflow\.workflow_status/);
  assert.match(worker, /lineup\.publication_status/);
  assert.match(worker, /isPublished: publicationStatus === "published"/);
  assert.match(worker, /public game status joins unavailable; using canonical games fallback/);
  assert.match(worker, /SELECT internal_game_id, game_date, start_time, home_team, away_team, game_status/);
});

test("受付中・締切間近・締切済み・公開済みをユーザー向けに区別する", () => {
  assert.match(script, /function getPublicGameStatusView\(game, deadline/);
  assert.match(script, /label: near \? "締切間近" : "予想受付中"/);
  assert.match(script, /label: lineupWaiting \? "スタメン待ち" : "締切済み"/);
  assert.match(script, /label: "結果公開済み"/);
  assert.match(script, /resultsPublished/);
});

test("保存済み予想の表示は対象試合単位で、保存処理と既存締切判定を再利用する", () => {
  assert.match(script, /const saved = Boolean\(remoteState\?\.prediction/);
  assert.match(script, /function getCurrentGameId\(\)/);
  assert.match(script, /internalGameId \|\| state\.probableStarter\.nextGame\?\.internalGameId/);
  assert.match(script, /function ensurePredictionEditingAllowed\(\)/);
  assert.match(script, /function renderPredictionDeadline\(\)/);
});

test("スマホではカードを2列、試合選択を1列にして横溢れを抑える", () => {
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.public-game-status-grid[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.public-game-selector[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /public-game-status-grid strong[\s\S]*overflow-wrap: anywhere/);
});

test("公開画面のJS/CSS cache busterを更新する", () => {
  assert.match(html, /style\.css\?v=public-next-game-status-1/);
  assert.match(html, /script\.js\?v=account-prediction-save-auth-1/);
});
