const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("初回認証イベントを取りこぼしてもPromise完了後にadmin APIを1回呼ぶ", async () => {
  let resolveAuthReady;
  const authReady = new Promise((resolve) => {
    resolveAuthReady = resolve;
  });
  const listeners = new Map();
  const fetchUrls = [];

  const window = {
    location: {
      href: "https://starting9.pages.dev/?admin=1",
      hostname: "starting9.pages.dev",
      protocol: "https:",
      search: "?admin=1"
    },
    history: {
      state: null,
      replaceState() {}
    },
    starting9AuthReady: authReady,
    starting9Auth: {
      getUser: () => ({ id: "admin-user", username: "admin" }),
      getApiBaseUrl: () => "https://starting9-auth.tanzana7.workers.dev",
      isInitialized: () => true,
      whenInitialized: () => authReady
    },
    addEventListener(type, listener) {
      const registered = listeners.get(type) || [];
      registered.push(listener);
      listeners.set(type, registered);
    },
    dispatchEvent(event) {
      (listeners.get(event.type) || []).forEach((listener) => listener(event));
    }
  };
  const document = {
    addEventListener() {},
    getElementById() {
      return null;
    }
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    document,
    fetch: async (url) => {
      fetchUrls.push(url);
      const isCapabilityRequest = String(url).endsWith("/api/admin/mode-capabilities");
      const isAchievementsRequest = String(url).endsWith("/api/me/achievements");
      const isAllTimePublicRankingRequest = String(url).includes("/api/rankings/all-time");
      const isAllTimeMyRankingRequest = String(url).endsWith("/api/me/ranking/all-time");
      const isMonthlyPublicRankingRequest = String(url).includes("/api/rankings/monthly");
      const isMonthlyMyRankingRequest = String(url).endsWith("/api/me/ranking/monthly");
      return {
        ok: true,
        json: async () => {
          if (isAchievementsRequest) return { ok: true, achievements: [] };
          if (isAllTimePublicRankingRequest) return { ranking: [], summary: { eligibleGames: 0, requiredGames: 0 }, pagination: { limit: 50, offset: 0, totalUsers: 0 } };
          if (isAllTimeMyRankingRequest) return { ok: true, rankingData: null };
          if (isMonthlyPublicRankingRequest) return { year: 2026, month: 7, ranking: [], summary: { eligibleGames: 0, requiredGames: 0, qualifiedUsers: 0, totalUsers: 0 }, pagination: { limit: 50, offset: 0, totalUsers: 0 } };
          if (isMonthlyMyRankingRequest) return { ok: true, year: 2026, month: 7, rankingData: null };
          if (isCapabilityRequest) return { ok: true, adminModeAvailable: true, developmentModeAvailable: false };
          return { ok: true, admin: true };
        }
      };
    },
    Map,
    Promise,
    Set,
    setInterval,
    setTimeout,
    window
  });

  // script.jsの読込前に初期イベントが終わった状況を再現します。
  window.dispatchEvent({ type: "starting9-auth-state-changed" });
  const scriptPath = path.join(__dirname, "..", "script.js");
  vm.runInContext(fs.readFileSync(scriptPath, "utf8"), context, { filename: scriptPath });
  vm.runInContext(
    "applyAdminMode = () => {}; initializeGameSchedule = () => {}; renderAll = () => {}; refreshAdminScoringSummary = () => {}; refreshAutoScoringStatus = () => {};",
    context
  );

  const initialization = vm.runInContext("initializeAuthDependentFeatures()", context);
  await Promise.resolve();
  assert.equal(fetchUrls.length, 0);

  resolveAuthReady();
  await initialization;

  assert.deepEqual(fetchUrls, [
    "https://starting9-auth.tanzana7.workers.dev/api/me/achievements",
    "https://starting9-auth.tanzana7.workers.dev/api/rankings/all-time?limit=50&qualifiedOnly=false",
    "https://starting9-auth.tanzana7.workers.dev/api/me/ranking/all-time",
    "https://starting9-auth.tanzana7.workers.dev/api/admin/me",
    "https://starting9-auth.tanzana7.workers.dev/api/admin/mode-capabilities"
  ]);
  assert.equal((listeners.get("starting9-auth-state-changed") || []).length, 1);
});
