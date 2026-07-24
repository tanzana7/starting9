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
      const isAchievementsRequest = String(url).endsWith("/api/me/achievements");
      const isYearlyPublicRankingRequest = String(url).includes("/api/rankings/yearly");
      const isYearlyMyRankingRequest = String(url).endsWith("/api/me/ranking/yearly");
      const isMonthlyPublicRankingRequest = String(url).includes("/api/rankings/monthly");
      const isMonthlyMyRankingRequest = String(url).endsWith("/api/me/ranking/monthly");
      return {
        ok: true,
        json: async () => {
          if (isAchievementsRequest) return { ok: true, achievements: [] };
          if (isYearlyPublicRankingRequest) return { year: 2026, ranking: [], summary: { eligibleGames: 0, requiredGames: 0, qualifiedUsers: 0, totalUsers: 0 }, pagination: { limit: 50, offset: 0, totalUsers: 0 } };
          if (isYearlyMyRankingRequest) return { ok: true, year: 2026, rankingData: null };
          if (isMonthlyPublicRankingRequest) return { year: 2026, month: 7, ranking: [], summary: { eligibleGames: 0, requiredGames: 0, qualifiedUsers: 0, totalUsers: 0 }, pagination: { limit: 50, offset: 0, totalUsers: 0 } };
          if (isMonthlyMyRankingRequest) return { ok: true, year: 2026, month: 7, rankingData: null };
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
    "applyAdminMode = () => {}; initializeGameSchedule = () => {}; renderAll = () => {}; refreshAdminScoringSummary = () => {}; refreshAutoScoringStatus = () => {}; refreshAdminGameWorkflowStatus = () => {}; refreshAdminTestStatus = () => {}; refreshAdminTestAchievements = () => {}; refreshAdminDeploymentInfo = () => {}; renderAdminTestPanel = () => {};",
    context
  );

  const initialization = vm.runInContext("initializeAuthDependentFeatures()", context);
  await Promise.resolve();
  assert.equal(fetchUrls.length, 0);

  resolveAuthReady();
  await initialization;

  assert.deepEqual(fetchUrls, [
    "https://starting9-auth.tanzana7.workers.dev/api/me/achievements",
    "https://starting9-auth.tanzana7.workers.dev/api/rankings/yearly?year=2026&limit=50&qualifiedOnly=false",
    "https://starting9-auth.tanzana7.workers.dev/api/me/ranking/yearly?year=2026",
    "https://starting9-auth.tanzana7.workers.dev/api/admin/me"
  ]);
  assert.equal((listeners.get("starting9-auth-state-changed") || []).length, 1);
});
