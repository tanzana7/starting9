const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const script = read("script.js");
const html = read("index.html");

test("公開画面の初期化はPublicAppCoordinatorの一経路に集約される", () => {
  const start = script.indexOf("class PublicAppCoordinator");
  const end = script.indexOf("async function initializeAuthDependentFeatures", start);
  const coordinator = script.slice(start, end);
  assert.match(coordinator, /start\(\) \{/);
  assert.match(coordinator, /initialization\.promise/);
  assert.match(coordinator, /await initializePublicGameCatalog\(\)/);
  assert.match(coordinator, /await this\.initializeSchedule\(\)/);
  assert.match(coordinator, /const rosterPromise = initializeRosterCandidateSync\(\)/);
  assert.match(coordinator, /const authPromise = initializeAuthDependentFeatures\(\)/);
  assert.equal((script.match(/DOMContentLoaded/g) || []).length, 1);
  assert.match(script, /void publicAppCoordinator\.start\(\)/);
});

test("公開アプリ状態はゲーム、予想、ロースター、結果、ランキング、アカウント、リクエストを分離する", () => {
  const stateStart = script.indexOf("const appState = {");
  const stateEnd = script.indexOf("function syncPublicAppState", stateStart);
  const declaration = script.slice(stateStart, stateEnd);
  for (const domain of ["gameCatalog", "currentGame", "predictionForm", "roster", "results", "ranking", "account", "requests"]) {
    assert.match(declaration, new RegExp(`\\b${domain}\\b`));
  }
  for (const requestName of ["catalog", "roster", "target", "probable", "result", "resultDetail", "account"]) {
    assert.match(declaration, new RegExp(`\\b${requestName}: \\{ sequence: 0, controller: null \\}`));
  }
});

test("公開リクエストはsequenceとAbortControllerで古い応答を無効化する", () => {
  const start = script.indexOf("const appState = {");
  const end = script.indexOf("class PublicAppCoordinator", start);
  const requestCode = script.slice(start, end);
  const context = {
    AbortController,
    console,
    state: {
      publicGameCatalog: {},
      publicRoster: {},
      resultHistory: {},
      yearlyRanking: {},
      monthlyRanking: {},
      predictionRemote: {}
    }
  };
  vm.createContext(context);
  vm.runInContext(requestCode, context);

  const first = vm.runInContext('beginPublicRequest("catalog", { abort: true })', context);
  const second = vm.runInContext('beginPublicRequest("catalog", { abort: true })', context);
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(vm.runInContext('isCurrentPublicRequest("catalog", 1)', context), false);
  assert.equal(vm.runInContext('isCurrentPublicRequest("catalog", 2)', context), true);
  assert.equal(vm.runInContext('appState.requests.catalog.controller.signal.aborted', context), false);
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
  const submitStart = script.indexOf("async function handlePredictionSubmit");
  const submitEnd = script.indexOf("function resetPredictionInput", submitStart);
  const resetEnd = script.indexOf("function handleActualSubmit", submitEnd);
  assert.match(script.slice(submitStart, submitEnd), /preserveDisplayedPublicResult\(\)/);
  assert.match(script.slice(submitEnd, resetEnd), /preserveDisplayedPublicResult\(\)/);
  const syncStart = script.indexOf("async function syncPredictionFromAccount");
  const syncEnd = script.indexOf("function createEmptyPredictionRemoteState", syncStart);
  assert.match(script.slice(syncStart, syncEnd), /preserveDisplayedPublicResult\(\)/);
  assert.match(script, /const latest = state\.resultHistory\.result \|\| state\.result \|\| null/);
});

test("公開画面のキャッシュバスターはCoordinator版へ更新される", () => {
  assert.match(html, /script\.js\?v=public-frontend-coordinator-1/);
});
