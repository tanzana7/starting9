const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const moduleDir = path.join(root, "frontend", "public");
const moduleNames = ["state", "request-guard", "storage", "api-client", "app-coordinator", "render-results", "daily-best-nine", "roster", "prediction-form"];

function load(name, { fetchImpl, storage } = {}) {
  const context = {
    AbortController,
    console,
    window: {
      fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ ok: true }) })),
      localStorage: storage
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(moduleDir, `${name}.js`), "utf8"), context);
  return context.window.Starting9Public;
}

test("公開frontendの責務は実ファイルへ分離されている", () => {
  moduleNames.forEach((name) => {
    assert.equal(fs.existsSync(path.join(moduleDir, `${name}.js`)), true, `${name} module exists`);
  });
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8") + "\n" + fs.readFileSync(path.join(root, "frontend/public/results.js"), "utf8");
  assert.match(script, /createPublicApiClient\(\)/);
  assert.match(script, /createPublicRequestGuard\(appState\.requests\)/);
  assert.match(script, /createPublicResultsRenderer/);
  assert.doesNotMatch(script, /createPublicRankingRenderer/);
  assert.match(script, /createPublicRosterController/);
  assert.match(script, /createPublicPredictionFormController/);
});

test("storageはJSON破損を安全に無視し、例外を公開状態へ伝播しない", () => {
  const map = new Map([["broken", "{"]]);
  const storage = { getItem: (key) => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: (key) => map.delete(key) };
  const publicFrontend = load("storage", { storage });
  const client = publicFrontend.createPublicStorage(storage, { error() {} });
  assert.equal(client.load("broken"), null);
  assert.equal(client.save("safe", { gameId: "canonical" }), true);
  assert.equal(client.load("safe").gameId, "canonical");
});

test("API clientは公開APIのfetchとJSON解析を一箇所で扱う", async () => {
  const calls = [];
  const publicFrontend = load("api-client", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, games: [] }) };
    }
  });
  const client = publicFrontend.createPublicApiClient(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, games: [] }) };
  });
  const { response, payload } = await client.get("/api/public/games", { signal: "request-signal" });
  assert.equal(response.ok, true);
  assert.deepEqual(payload, { ok: true, games: [] });
  assert.equal(calls[0].url, "/api/public/games");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.signal, "request-signal");
});

test("results moduleは現在の公開文言と最大5件の表示契約を保持する", () => {
  const results = fs.readFileSync(path.join(moduleDir, "results.js"), "utf8")
    + fs.readFileSync(path.join(moduleDir, "render-results.js"), "utf8");
  assert.match(results, /games\.slice\(0, 5\)/);
  assert.match(results, /renderDailyBestNine/);
  assert.match(results, /今日のベストナイン/);
});

test("Daily Best Nine moduleは個人結果・予想選択から独立し、共有rendererと公開APIを使う", () => {
  const module = fs.readFileSync(path.join(moduleDir, "daily-best-nine.js"), "utf8");
  const entryScript = fs.readFileSync(path.join(root, "script.js"), "utf8");
  assert.match(module, /\/api\/results\/daily-best-nine/);
  assert.match(module, /payload\.internalGameId \|\| payload\.gameId/);
  assert.doesNotMatch(module, /selectedGameId|resultHistory|detailCache|predictionTargetGameId/);
  assert.match(entryScript, /render:\s*publicResultsRenderer\.renderDailyBestNine/);
  assert.doesNotMatch(module, /setInterval|setTimeout|localStorage/);
});
