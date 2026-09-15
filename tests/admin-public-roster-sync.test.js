import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import worker, { readSharedGameDayRoster } from "../auth-worker.js";
import {
  applyLiveRosterToManualLineupCatalog,
  prioritizeManualRosterCatalog
} from "../backend/automation-v3/manual-roster-repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const adminSource = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const rendererSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");

function catalog() {
  return [
    { playerId: "F-1", playerName: "現行選手", uniformNumber: "1", candidateVisibility: "auto" },
    { playerId: "F-2", playerName: "新規登録選手", uniformNumber: "2", candidateVisibility: "auto" },
    { playerId: "F-3", playerName: "手動追加選手", uniformNumber: "3", candidateVisibility: "auto" },
    { playerId: "F-4", playerName: "抹消選手", uniformNumber: "4", candidateVisibility: "auto" }
  ];
}

test("admin lineupはpublicと同じlive rosterを基準にし、manual overrideだけを重ねる", () => {
  const players = catalog();
  const manualRoster = {
    source: "manual",
    isManualSaved: true,
    entries: [
      { playerId: "F-1", status: "inactive" },
      { playerId: "F-3", status: "active" }
    ]
  };
  const resolved = applyLiveRosterToManualLineupCatalog(players, {
    sourceOfTruth: "official_live",
    capturedAt: "2026-09-15T00:00:00.000Z",
    players: [
      { name: "現行選手", number: "1", position: "外野手" },
      { name: "新規登録選手", number: "2", position: "内野手" }
    ]
  }, manualRoster);

  assert.equal(resolved.find((player) => player.playerId === "F-1").effectiveRosterActive, false, "manual inactive override wins");
  assert.equal(resolved.find((player) => player.playerId === "F-2").effectiveRosterActive, true, "live registration is reflected");
  assert.equal(resolved.find((player) => player.playerId === "F-3").effectiveRosterActive, true, "manual addition remains active");
  assert.equal(resolved.find((player) => player.playerId === "F-4").effectiveRosterActive, false, "live deregistration moves out");
  assert.equal(resolved.find((player) => player.playerId === "F-4").effectiveRosterSource, "live-roster-out");
});

test("live rosterが空・不正のときはmanual/static catalogを置き換えない", () => {
  const players = catalog();
  assert.equal(applyLiveRosterToManualLineupCatalog(players, { sourceOfTruth: "official_live", players: [] }, null), null);
  const manual = prioritizeManualRosterCatalog(players, {
    source: "manual",
    isManualSaved: true,
    entries: [{ playerId: "F-1", status: "active" }]
  });
  assert.equal(manual.find((player) => player.playerId === "F-1").manualRosterActive, true);
});

test("admin candidate filterはeffective live rosterのin/outをそのまま表示する", () => {
  const context = vm.createContext({ window: {}, Map, Set, Intl, Date });
  vm.runInContext(rendererSource, context);
  const renderer = context.window.Starting9AdminV3.createAdminV3ManualLineupRenderer({
    escapeHtml: (value) => String(value ?? ""),
    formatJst: (value) => String(value || "-"),
    getFinalizeSafety: () => ({ allowed: true, message: "" }),
    getGameDayStatus: () => ({ key: "today", label: "今日", tone: "today", isFuture: false, isPast: false })
  });
  const players = catalog().map((player, index) => ({
    ...player,
    effectiveRosterStatus: index < 2 ? "active" : "inactive",
    effectiveRosterActive: index < 2
  }));
  const row = { playerId: "", search: "" };
  const active = renderer.renderCandidates(players, row, 0, { source: "manual", entries: [] }, "active");
  const inactive = renderer.renderCandidates(players, row, 0, { source: "manual", entries: [] }, "inactive");
  assert.match(active, /現行選手/);
  assert.match(active, /新規登録選手/);
  assert.doesNotMatch(active, /手動追加選手|抹消選手/);
  assert.match(inactive, /手動追加選手/);
  assert.match(inactive, /抹消選手/);
});

test("admin lineupとpublicは同じgame-day-roster resolver/cacheを共有し、5分固定pollingを持たない", () => {
  assert.match(workerSource, /async function getAdminPublicRosterForLineup/);
  assert.match(workerSource, /handleGetGameDayRosterWithCache\(/);
  assert.match(workerSource, /kind: "game-day-roster"/);
  assert.match(workerSource, /PUBLIC_ROSTER_CACHE_FRESH_TTL_SECONDS = 60/);
  assert.match(workerSource, /applyLiveRosterToManualLineupCatalog\(baseCatalog, publicRosterResolution\.roster, manualRoster\)/);
  assert.doesNotMatch(adminSource, /ADMIN_V3_ROSTER_REFRESH_INTERVAL_MS/);
  assert.doesNotMatch(adminSource, /setInterval\([^\n]*refreshV3LineupRoster/);
  assert.match(adminSource, /getGameOperationDetail\(id, "\/lineup"\)/);
  assert.match(adminSource, /requestToken !== Number\(v3State\.operationDetailsRequestToken/);
  assert.match(adminSource, /skipLineupLoad/);
  assert.match(adminSource, /refreshLineupRoster: refreshV3LineupRoster/);
  const coordinatorSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "app-coordinator.js"), "utf8");
  assert.match(coordinatorSource, /visibilitychange/);
  assert.match(coordinatorSource, /window\.addEventListener\("focus"/);
  assert.match(coordinatorSource, /window\.addEventListener\("pageshow"/);
  assert.match(rendererSource, /data-v3-lineup-roster-refresh/);
  assert.match(htmlSource, /admin-v3\.js\?[^"']*public-roster-sync-1/);
  assert.match(rendererSource, /effectiveRosterStatus/);
});

class MemoryCache {
  constructor() { this.entries = new Map(); }
  async match(request) { return this.entries.get(request.url)?.clone(); }
  async put(request, response) { this.entries.set(request.url, response.clone()); }
  deleteFresh() {
    for (const key of this.entries.keys()) {
      if (key.includes("/game-day-roster/fresh")) this.entries.delete(key);
    }
  }
  keys() { return [...this.entries.keys()]; }
}

function rosterPlayers(version) {
  return Array.from({ length: 20 }, (_, index) => ({
    playerId: `npb:${version}-${index + 1}`,
    name: `${version}候補${index + 1}`,
    number: String(index + 1),
    position: "外野手"
  }));
}

function sharedRosterDb() {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => sql.includes("FROM games")
              ? {
                internal_game_id: "11111111-1111-4111-8111-111111111111",
                game_date: "2026-09-15",
                start_time: "2026-09-15T09:00:00.000Z",
                home_team: "fighters",
                away_team: "hawks"
              }
              : null
          };
        }
      };
    }
  };
}

test("public取得後のshared cacheをadmin readがそのまま再利用し、同じrosterを返す", async () => {
  const cache = new MemoryCache();
  let players = rosterPlayers("old");
  const env = {
    AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev",
    AUTH_DB: sharedRosterDb(),
    PUBLIC_CACHE: cache,
    NPB_FETCH_WORKER: { fetch: async () => new Response(JSON.stringify({ ok: true, players, fetchedAt: "2026-09-15T00:00:00.000Z" }), { status: 200 }) }
  };
  const publicResponse = await worker.fetch(new Request("https://auth.test/api/game-day-roster?internalGameId=11111111-1111-4111-8111-111111111111", { headers: { Origin: "https://starting9.pages.dev" } }), env, { waitUntil() {} });
  const oldPublicRoster = await publicResponse.json();
  players = rosterPlayers("new");
  cache.deleteFresh();
  const updatedPublicResponse = await worker.fetch(new Request("https://auth.test/api/game-day-roster?internalGameId=11111111-1111-4111-8111-111111111111", { headers: { Origin: "https://starting9.pages.dev" } }), env, { waitUntil() {} });
  const publicRoster = await updatedPublicResponse.json();
  const adminRoster = await readSharedGameDayRoster({ ...env, AUTH_DB: { prepare() { throw new Error("shared cache hit must not read D1"); } } }, { internalGameId: "11111111-1111-4111-8111-111111111111", gameDate: "2026-09-15", homeTeam: "fighters", awayTeam: "hawks" });

  assert.equal(publicResponse.status, 200);
  assert.equal(oldPublicRoster.cacheStatus, "miss");
  assert.equal(updatedPublicResponse.status, 200);
  assert.equal(publicRoster.cacheStatus, "miss");
  assert.notDeepEqual(publicRoster.players, oldPublicRoster.players);
  assert.deepEqual(adminRoster.players, publicRoster.players);
  assert.equal(adminRoster.internalGameId, publicRoster.internalGameId);
  assert.equal(adminRoster.gameDate, publicRoster.gameDate);
  assert.equal(adminRoster.sourceOfTruth, publicRoster.sourceOfTruth);
  assert.ok(cache.keys().some((key) => key.includes("/game-day-roster/fresh")));
});
