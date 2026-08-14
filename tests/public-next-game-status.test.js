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
const worker = read("auth-worker.js");

test("通常画面は大型カードも試合選択UIも持たず、canonical対象の補助表示だけを表示する", () => {
  for (const id of ["publicGameStatusCard", "publicGameStatusBadge", "publicGameStatusGrid"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /public-game-status-card|public-game-status-badge|public-game-status-grid/);
  const predictionForm = html.slice(html.indexOf('<form id="predictionForm"'), html.indexOf("</form>", html.indexOf('<form id="predictionForm"')));
  assert.match(html, /id="publicGameSelectionMeta"/);
  assert.doesNotMatch(predictionForm, /id="publicGameSelect"|試合を選択/);
  assert.doesNotMatch(css, /public-game-picker/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*#predictionForm > \.public-game-selection-meta[\s\S]*grid-column: 1 \/ -1/);
  assert.match(script, /function renderPublicGameSelectionMeta\(\)/);
  assert.doesNotMatch(script, /renderPublicGameSelector|handlePublicGameSelectionChange|manualSelection/);
  assert.doesNotMatch(script, /function renderPublicGameStatusCard\(\)/);
});

test("未来試合はcanonical catalogに保持し、通常画面は受付可能な1試合だけを使う", () => {
  assert.match(script, /function getPublicSelectableGames\(games = \[\], now = new Date\(\)\)/);
  assert.match(script, /const todayGames = sorted\.filter\(\(game\) => getScheduleDate\(game\) === today\)/);
  assert.match(script, /const futureGames = sorted\.filter\(\(game\) => getScheduleDate\(game\) > today\)\.slice\(0, 5\)/);
  assert.match(script, /function selectInitialPublicGame\(games = \[\], now = new Date\(\)\)/);
  assert.match(script, /return todayOpen \|\| nextOpen \|\| null/);
  assert.match(script, /syncPredictionFromAccount\(\{ force: true \}\)/);
});

test("初期試合は今日の受付中、次の受付可能な未来試合の順で選ぶ", () => {
  assert.match(script, /function selectInitialPublicGame\(games = \[\], now = new Date\(\)\)/);
  assert.match(script, /const todayOpen = todayGames\.find\(\(game\) => !isPublicGamePublished\(game\)/);
  assert.match(script, /const nextOpen = selectable\.find\(\(game\) => getScheduleDate\(game\) > today/);
  assert.match(script, /const catalogGame = state\.publicGameCatalog\.games\.length/);
});

test("canonical catalogの締切判定は未定義のstatic schedule helperに依存せず、次の受付可能試合へ進む", () => {
  const resolverStart = script.indexOf("function parseJstScheduleDateTime");
  const resolverEnd = script.indexOf("function getEffectivePredictionDeadline", resolverStart);
  const selectionStart = script.indexOf("function getPublicSelectableGames");
  const selectionEnd = script.indexOf("function formatPublicPredictionGameLabel", selectionStart);
  const context = {
    state: { publicGameCatalog: { games: [] }, predictionTargetGame: null },
    window: { STARTING9_PREGAME_CONFIG: {} },
    isPublicGamePublished: () => false,
    isNormalManagedSchedule: () => true,
    getScheduleDate: (game) => game.date,
    getScheduleStartTime: (game) => game.startTime,
    getScheduleSortValue: (game) => `${game.date}T${game.startTime}`,
    getJapanDateString: (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(date),
    Date,
    Intl
  };
  vm.createContext(context);
  vm.runInContext(`${script.slice(resolverStart, resolverEnd)}\n${script.slice(selectionStart, selectionEnd)}`, context);

  const games = [
    { internalGameId: "today", canonical: true, date: "2026-08-14", startTime: "18:00", startAt: "2026-08-14T09:00:00.000Z" },
    { internalGameId: "tomorrow", canonical: true, date: "2026-08-15", startTime: "14:00", startAt: "2026-08-15T05:00:00.000Z" }
  ];
  context.state.publicGameCatalog.games = games;

  assert.equal(
    context.selectInitialPublicGame(games, new Date("2026-08-14T02:26:00.000Z")).internalGameId,
    "today"
  );
  assert.equal(
    context.selectInitialPublicGame(games, new Date("2026-08-14T09:00:00.000Z")).internalGameId,
    "tomorrow"
  );
});

test("canonical catalogの未来試合はstatic scheduleに未掲載でもstartAtから締切を判定する", () => {
  const start = script.indexOf("function resolvePredictionDeadline");
  const resolver = script.slice(start, script.indexOf("function getEffectivePredictionDeadline", start));
  assert.match(resolver, /state\.publicGameCatalog\.games\.find/);
  assert.doesNotMatch(resolver, /getHamGameSchedule/);
  assert.match(resolver, /game\.startAt\s*\?\s*new Date\(game\.startAt\)/);
  assert.match(resolver, /status: isClosed \? "closed" : "open"/);
});

test("future canonical gameがある場合は対象なし表示ではなく入力フォームを維持する", () => {
  assert.match(script, /const nextOpen = selectable\.find/);
  assert.match(script, /state\.predictionTargetGame = preservedGame/);
  assert.match(script, /renderPublicPredictionSurface\(selectedGame\)/);
  assert.match(script, /if \(editor\) editor\.classList\.remove\("hidden"\)/);
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

test("スマホでも選択UIを追加せず、補助表示と既存導線を維持する", () => {
  assert.doesNotMatch(css, /public-game-picker/);
  assert.match(css, /\.public-game-selection-meta \{[\s\S]*font-size: 0\.82rem/);
});

test("公開画面のJS/CSS cache busterを更新する", () => {
  assert.match(html, /style\.css\?v=public-results-below-prediction-layout-1/);
  assert.match(html, /script\.js\?v=public-next-prediction-target-regression-1/);
});

test("受付可能なcanonical対象がない場合は入力面を隠し、自然な案内を表示する", () => {
  assert.match(script, /現在、予想受付中の試合はありません。/);
  assert.match(script, /renderPublicPredictionSurface\(null\)/);
  assert.match(script, /if \(!selectedGame\) \{[\s\S]*if \(editor\) editor\.classList\.add\("hidden"\)/);
});

test("旧localStorageの選択値はcanonical予想対象を上書きしない", () => {
  const currentGameStart = script.indexOf("function getCurrentGameId");
  const currentGameEnd = script.indexOf("function getAuthApiBaseUrl", currentGameStart);
  const currentGameResolver = script.slice(currentGameStart, currentGameEnd);
  assert.match(currentGameResolver, /state\.predictionTargetGame\?\.internalGameId/);
  assert.doesNotMatch(currentGameResolver, /state\.gameInfo\.selectedGameId|localStorage/);
});

test("通常画面は管理用システム表示をbundleから除去する", () => {
  const publicMarkup = html;
  for (const internalLabel of ["schema ready", "feature flag", "Cron最終監査", "V3 job", "diagnostics", "internal state"]) {
    assert.doesNotMatch(publicMarkup, new RegExp(internalLabel, "i"));
  }
  assert.doesNotMatch(publicMarkup, /adminDetails|adminPregameTools|adminServerScoring/);
  assert.doesNotMatch(script, /renderAdminFlow|refreshAdminAccess|runServerScoring/);
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
