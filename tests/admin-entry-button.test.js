const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const scriptPath = path.join(__dirname, "..", "script.js");
const scriptSource = fs.readFileSync(scriptPath, "utf8");

function createApp({ href = "https://starting9.pages.dev/", user = null, admin = false } = {}) {
  const fetchUrls = [];
  const historyUrls = [];
  const listeners = new Map();
  const authReady = Promise.resolve();
  const window = {
    location: new URL(href),
    history: {
      state: null,
      replaceState(_state, _title, url) {
        historyUrls.push(String(url));
      }
    },
    starting9AuthReady: authReady,
    starting9Auth: {
      getUser: () => user,
      getApiBaseUrl: () => "https://starting9-auth.tanzana7.workers.dev",
      isInitialized: () => true,
      whenInitialized: () => authReady
    },
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    }
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    document: {
      addEventListener() {},
      getElementById() {
        return null;
      }
    },
    fetch: async (url) => {
      fetchUrls.push(url);
      const isCapabilityRequest = String(url).endsWith("/api/admin/mode-capabilities");
      const isAchievementsRequest = String(url).endsWith("/api/me/achievements");
      const isAllTimePublicRankingRequest = String(url).includes("/api/rankings/all-time");
      const isAllTimeMyRankingRequest = String(url).endsWith("/api/me/ranking/all-time");
      const isMonthlyPublicRankingRequest = String(url).includes("/api/rankings/monthly");
      const isMonthlyMyRankingRequest = String(url).endsWith("/api/me/ranking/monthly");
      return {
        ok: admin,
        json: async () => {
          if (!admin) return { ok: false, admin: false };
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
  vm.runInContext(scriptSource, context, { filename: scriptPath });
  vm.runInContext(
    "applyAdminMode = () => {}; initializeGameSchedule = () => {}; renderAll = () => {}; refreshAdminScoringSummary = () => {}; refreshAutoScoringStatus = () => {}; stopAutoFetch = () => {}; stopRosterMonitor = () => {};",
    context
  );

  return { context, fetchUrls, historyUrls, listeners };
}

test("旧adminクエリだけを削除し、他クエリとハッシュを維持する", () => {
  const app = createApp({ href: "https://starting9.pages.dev/?admin=1&game=next#result" });
  vm.runInContext("removeLegacyAdminQueryParameter()", app.context);

  assert.deepEqual(app.historyUrls, ["https://starting9.pages.dev/?game=next#result"]);
});

test("管理者は初期Promise完了後に一度だけ確認され、ボタンを開閉できる", async () => {
  const app = createApp({ user: { id: "admin-user", username: "admin" }, admin: true });

  await vm.runInContext("initializeAuthDependentFeatures()", app.context);
  assert.deepEqual(app.fetchUrls, [
    "https://starting9-auth.tanzana7.workers.dev/api/me/achievements",
    "https://starting9-auth.tanzana7.workers.dev/api/rankings/all-time?limit=50&qualifiedOnly=false",
    "https://starting9-auth.tanzana7.workers.dev/api/me/ranking/all-time",
    "https://starting9-auth.tanzana7.workers.dev/api/admin/me",
    "https://starting9-auth.tanzana7.workers.dev/api/admin/mode-capabilities"
  ]);
  assert.equal(vm.runInContext("state.adminAccess.status", app.context), "authorized");

  for (let index = 0; index < 3; index += 1) {
    vm.runInContext("openAdminPanel()", app.context);
    assert.equal(vm.runInContext("state.adminAccess.status", app.context), "authorized");
    assert.equal(vm.runInContext("state.appMode", app.context), "admin");
    vm.runInContext("closeAdminPanel()", app.context);
    assert.equal(vm.runInContext("state.adminAccess.status", app.context), "authorized");
    assert.equal(vm.runInContext("state.appMode", app.context), "normal");
  }

  app.context.window.starting9Auth.getUser = () => null;
  await vm.runInContext("refreshAdminAccess()", app.context);
  assert.equal(vm.runInContext("state.adminAccess.status", app.context), "inactive");
});

test("未ログインでは管理者APIを呼ばず、一般ユーザーは403後に管理状態を持たない", async () => {
  const signedOut = createApp();
  await vm.runInContext("refreshAdminAccess()", signedOut.context);
  assert.equal(signedOut.fetchUrls.length, 0);
  assert.equal(vm.runInContext("state.adminAccess.status", signedOut.context), "inactive");

  const regularUser = createApp({ user: { id: "user", username: "user" }, admin: false });
  await vm.runInContext("refreshAdminAccess()", regularUser.context);
  assert.deepEqual(regularUser.fetchUrls, ["https://starting9-auth.tanzana7.workers.dev/api/admin/me"]);
  assert.equal(vm.runInContext("state.adminAccess.status", regularUser.context), "inactive");
});
