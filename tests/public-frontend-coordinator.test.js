const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const script = read("script.js");
const html = read("index.html");
const modulePath = (name) => `frontend/public/${name}.js`;

function loadPublicModule(name, extra = {}) {
  const context = {
    AbortController,
    console,
    window: { fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }) },
    ...extra
  };
  vm.createContext(context);
  vm.runInContext(read(modulePath(name)), context);
  return context.window.Starting9Public;
}

test("公開画面のentry pointは分割moduleを読み込んでCoordinatorを一経路で起動する", () => {
  const moduleScripts = ["state", "request-guard", "storage", "api-client", "app-coordinator", "render-results", "render-ranking", "roster", "prediction-form"];
  const scriptOffset = html.indexOf("script.js?v=public-result-loading-speed-improvement-1");
  assert.ok(scriptOffset > 0);
  moduleScripts.forEach((name) => {
    const offset = html.indexOf(`${modulePath(name)}?v=public-past-result-date-heading-1`);
    assert.ok(offset >= 0, `${name} module is loaded`);
    assert.ok(offset < scriptOffset, `${name} loads before the entry point`);
  });
  assert.match(script, /new publicFrontend\.PublicAppCoordinator/);
  assert.equal((script.match(/DOMContentLoaded/g) || []).length, 1);
  assert.match(script, /void publicAppCoordinator\.start\(\)/);
});

test("公開アプリ状態はゲーム、予想、ロースター、結果、ランキング、アカウント、リクエストを分離する", () => {
  const publicFrontend = loadPublicModule("state");
  const appState = publicFrontend.state.createPublicAppState({
    publicGameCatalog: {}, publicRoster: {}, resultHistory: {}, yearlyRanking: {}, monthlyRanking: {}, predictionRemote: {}
  });
  for (const domain of ["gameCatalog", "currentGame", "predictionForm", "roster", "results", "ranking", "account", "requests"]) {
    assert.ok(Object.hasOwn(appState, domain));
  }
  for (const requestName of ["catalog", "roster", "target", "probable", "previousResultGame", "result", "resultDetail", "account"]) {
    assert.equal(appState.requests[requestName].sequence, 0);
    assert.equal(appState.requests[requestName].controller, null);
  }
});

test("公開リクエストはsequenceとAbortControllerで古い応答を無効化する", () => {
  const publicFrontend = loadPublicModule("request-guard");
  const requests = { catalog: { sequence: 0, controller: null } };
  const guard = publicFrontend.createPublicRequestGuard(requests);
  const first = guard.begin("catalog", { abort: true });
  const second = guard.begin("catalog", { abort: true });
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(guard.isCurrent("catalog", 1), false);
  assert.equal(guard.isCurrent("catalog", 2), true);
  assert.equal(requests.catalog.controller.signal.aborted, false);
});

test("公開メタデータは同一タブの短TTLキャッシュを再利用する", async () => {
  const values = new Map();
  let requestCount = 0;
  const publicFrontend = loadPublicModule("api-client", {
    sessionStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    }
  });
  const client = publicFrontend.createPublicApiClient(async () => {
    requestCount += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, value: requestCount }) };
  });
  const first = await client.getCached("/api/public/games", { cacheKey: "public-games-test", ttlMs: 30_000 });
  const second = await client.getCached("/api/public/games", { cacheKey: "public-games-test", ttlMs: 30_000 });
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(requestCount, 1);
  assert.equal(JSON.stringify(second.payload), JSON.stringify(first.payload));
  const bypassed = await client.getCached("/api/public/games", { cacheKey: "public-games-test", ttlMs: 30_000, cache: "no-store" });
  assert.equal(bypassed.fromCache, false);
  assert.equal(requestCount, 2);
  values.set("starting9:public-api:v1:expired-test", JSON.stringify({ expiresAt: Date.now() - 1, status: 200, payload: { ok: true, value: "stale" } }));
  const expired = await client.getCached("/api/public/games", { cacheKey: "expired-test", ttlMs: 30_000 });
  assert.equal(expired.fromCache, false);
  assert.equal(requestCount, 3);
});

test("結果表示は当日公開済み試合を先行取得し、履歴はユーザー別短TTLで再利用する", () => {
  const coordinator = read(modulePath("app-coordinator"));
  assert.match(script, /function getFastPreviousResultGame\(\)/);
  assert.match(script, /function maybeLoadFastPreviousResult\(\)/);
  assert.match(script, /RESULT_HISTORY_SESSION_CACHE_TTL_MS = 30 \* 1000/);
  assert.match(script, /cacheKey: userId \? `result-history:\$\{userId\}`/);
  assert.match(script, /fastPrevious && response\.status === 404/);
  assert.match(coordinator, /void ops\.maybeLoadFastPreviousResult\(\)/);
});

test("canonicalゲーム設定はlegacy/localStorageの古い試合を予想対象へ戻さない", () => {
  const start = script.indexOf("function setPublicCurrentGame");
  const end = script.indexOf("async function initializePublicGameCatalog", start);
  const setter = script.slice(start, end);
  assert.match(setter, /nextGame\?\.internalGameId/);
  assert.match(setter, /discardStoredStateForGame\(nextId\)/);
  assert.match(setter, /state\.predictionTargetGameId = nextId/);
  assert.doesNotMatch(setter, /state\.gameInfo\.selectedGameId/);
  assert.doesNotMatch(setter, /localStorage\.getItem/);
});

test("予想保存・リセット・アカウント同期は最新結果表示を保持する", () => {
  const form = read(modulePath("prediction-form"));
  const results = read(modulePath("render-results"));
  assert.match(form, /deps\.preserveDisplayedResult\(\)/);
  assert.match(results, /const latest = deps\.state\.resultHistory\.result \|\| deps\.state\.result \|\| null/);
  assert.match(script, /preserveDisplayedPublicResult\(\)/);
});

test("公開画面のキャッシュバスターはmodule分割版へ更新される", () => {
  assert.match(html, /script\.js\?v=public-result-loading-speed-improvement-1/);
  assert.match(html, /style\.css\?v=public-beta-release-qa-fixes-1/);
});

test("認証後の補助データはcritical UIの完了後にアイドル開始する", () => {
  const coordinator = read(modulePath("app-coordinator"));
  assert.match(coordinator, /ops\.syncPredictionFromAccount\(\{ force: true \}\)/);
  assert.match(coordinator, /ops\.refreshResultHistory\(\{ force: true \}\)/);
  assert.match(coordinator, /requestIdleCallback/);
  assert.match(coordinator, /ops\.refreshYearlyRanking\(\{ force: true \}\)/);
  assert.match(coordinator, /ops\.fetchUserAchievements\(\{ force: true \}\)/);
});

test("前回試合と結果一覧は初期表示で並列取得し、前回取得完了時に一覧を再取得しない", () => {
  const initializer = script.slice(script.indexOf("async function initializeAuthDependentFeatures"), script.indexOf("function bindEvents", script.indexOf("async function initializeAuthDependentFeatures")));
  const previousFetcher = script.slice(script.indexOf("function fetchPreviousResultGame"), script.indexOf("function buildProbableStarterApiUrl", script.indexOf("function fetchPreviousResultGame")));
  assert.match(initializer, /Promise\.allSettled\(\[[\s\S]*fetchPreviousResultGame\(\{ force: false \}\)[\s\S]*refreshResultHistory\(\{ force: false \}\)/);
  assert.match(previousFetcher, /resolveResultHistorySelection\(\)/);
  assert.match(previousFetcher, /previous\.isLoading \|\| previous\.isReady/);
  assert.doesNotMatch(previousFetcher, /refreshResultHistory\(\{ force: true \}\)/);
});
