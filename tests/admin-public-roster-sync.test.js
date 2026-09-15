import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
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

test("admin lineupはpublic resolverを再利用し、低頻度・visible時だけlineup rosterを更新する", () => {
  assert.match(workerSource, /async function getAdminPublicRosterForLineup/);
  assert.match(workerSource, /handleGetGameDayRoster\(/);
  assert.match(workerSource, /applyLiveRosterToManualLineupCatalog\(baseCatalog, publicRosterResolution\.roster, manualRoster\)/);
  assert.match(adminSource, /ADMIN_V3_ROSTER_REFRESH_INTERVAL_MS = 5 \* 60 \* 1000/);
  assert.match(adminSource, /document\.visibilityState === "hidden"/);
  assert.match(adminSource, /getGameOperationDetail\(id, "\/lineup"\)/);
  assert.match(adminSource, /document\.visibilityState === "visible"/);
  assert.match(htmlSource, /admin-v3\.js\?[^"']*public-roster-sync-1/);
  assert.match(rendererSource, /effectiveRosterStatus/);
});
