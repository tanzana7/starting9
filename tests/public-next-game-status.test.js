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

test("通常画面は大型ステータスカードを持たず、シンプルな試合選択だけを表示する", () => {
  for (const id of ["publicGameStatusCard", "publicGameStatusBadge", "publicGameStatusGrid"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /public-game-status-card|public-game-status-badge|public-game-status-grid/);
  assert.match(html, /id="publicGameSelect"/);
  assert.match(html, /id="publicGameSelectionMeta"/);
  assert.match(html, /for="publicGameSelect"/);
  assert.match(css, /@media \(min-width: 900px\)[\s\S]*#predictionForm > \.public-game-picker[\s\S]*grid-column: 1 \/ -1/);
  assert.match(script, /function renderPublicGameSelectionMeta\(\)/);
  assert.doesNotMatch(script, /function renderPublicGameStatusCard\(\)/);
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

test("公開用ゲーム一覧はcanonical internalGameIdとV3 workflow/publication状態を返す", () => {
  assert.match(worker, /path === "\/api\/public\/games" && request\.method === "GET"/);
  assert.match(worker, /async function handleGetPublicGames\(request, env, cors\)/);
  assert.match(worker, /games\.internal_game_id/);
  assert.match(worker, /game_automation_v3_state AS workflow/);
  assert.match(worker, /workflow\.state/);
  assert.match(worker, /lineup\.publication_status/);
  assert.match(worker, /gameId: row\.internal_game_id/);
  assert.match(worker, /displayLabel: createPublicGameDisplayLabel/);
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

test("スマホでは試合選択を1列にして横溢れを抑える", () => {
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*\.public-game-picker[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /\.public-game-picker select \{[\s\S]*min-width: 0/);
  assert.match(css, /\.public-game-selection-meta \{[\s\S]*font-size: 0\.82rem/);
});

test("公開画面のJS/CSS cache busterを更新する", () => {
  assert.match(html, /style\.css\?v=public-remove-next-game-card-1/);
  assert.match(html, /script\.js\?v=public-remove-next-game-card-1/);
});

test("通常画面は管理用システム表示を初期HTMLから非表示にする", () => {
  const publicMarkup = html.slice(0, html.indexOf('<details id="adminDetails"'));
  for (const internalLabel of ["schema ready", "feature flag", "Cron最終監査", "V3 job", "diagnostics", "internal state"]) {
    assert.doesNotMatch(publicMarkup, new RegExp(internalLabel, "i"));
  }
  assert.match(html, /id="adminDetails"[^>]*hidden[^>]*aria-hidden="true"/);
  assert.match(script, /adminDetails\.hidden = !isAdminScreenOpen/);
});

test("通常画面は公示なし・取得失敗を表示せず、公示ありだけ自然な要約を表示する", () => {
  assert.doesNotMatch(html, /NEXT GAME/);
  const start = script.indexOf("function renderGameDayNoticeStatus");
  const end = script.indexOf("async function refreshGameDayNoticeStatus", start);
  const renderer = script.slice(start, end);
  assert.match(renderer, /const hasNotice =/);
  assert.match(renderer, /container\.classList\.add\("hidden"\)/);
  assert.match(renderer, /選手登録・抹消/);
  assert.doesNotMatch(renderer, /確認できていません|確認中です|最終確認/);
});
