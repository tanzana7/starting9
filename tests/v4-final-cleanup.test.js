import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schedule = JSON.parse(fs.readFileSync(path.join(root, "game-schedule-2026.json"), "utf8"));
const publicScript = fs.readFileSync(path.join(root, "script.js"), "utf8");
const publicResultsRenderer = fs.readFileSync(path.join(root, "frontend", "public", "render-results.js"), "utf8");
const lineupRendererSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");
const diagnosticsRendererSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-diagnostics.js"), "utf8");
const css = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

test("2026-09-27 Marines/Fightersは既存の正式識別情報m-f-23をcanonical scheduleへ使う", () => {
  const game = schedule.find((entry) => entry.date === "2026-09-27" && entry.homeTeam === "marines" && entry.awayTeam === "fighters");
  assert.ok(game);
  assert.equal(game.gameId, "2026-09-27-m-f-23");
  assert.match(game.npbScoreUrl, /\/0927\/m-f-23\/$/);
  assert.equal(schedule.filter((entry) => entry.gameId === "2026-09-27-m-f-24").length, 0);
});

test("Best Nineの対象gameは個人resultではなく全体のpreviousResultGameを使う", () => {
  const start = publicScript.indexOf("function getDailyBestNineGameId()");
  const end = publicScript.indexOf("function resetDailyBestNine", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    state: {
      previousResultGame: { game: { internalGameId: "global-latest", gameId: "legacy-global" } },
      resultHistory: { result: { internalGameId: "personal-older" }, selectedGameId: "personal-older" }
    },
    getFastPreviousResultGame() { return null; }
  });
  vm.runInContext(`${publicScript.slice(start, end)}; globalThis.getDailyBestNineGameId = getDailyBestNineGameId;`, context);
  assert.equal(context.getDailyBestNineGameId(), "global-latest");
});

test("未参加ユーザーでもglobal Best Nineは個人結果のavailabilityで隠れない", () => {
  const elements = new Map([
    ["dailyBestNineCard", { classList: { toggle(_name, value) { this.hidden = value; } } }],
    ["dailyBestNineContent", { innerHTML: "" }]
  ]);
  const context = vm.createContext({
    document: { getElementById(id) { return elements.get(id) || null; } },
    window: { Starting9Public: {} }
  });
  vm.runInContext(publicResultsRenderer, context);
  const renderer = context.window.Starting9Public.createPublicResultsRenderer({
    state: {
      previousResultGame: { game: { internalGameId: "global-latest" } },
      dailyBestNine: { status: "published", isLoading: false, message: "", rows: [{ rank: 1, username: "top-user", score: 88 }] },
      resultHistory: { result: { resultAvailability: "not_participated" } },
      result: null
    },
    getPublicResultAvailability(result) { return result?.resultAvailability ? { key: result.resultAvailability } : null; },
    escapeHtml: (value) => String(value)
  });
  renderer.renderDailyBestNine();
  assert.equal(elements.get("dailyBestNineCard").classList.hidden, false);
  assert.match(elements.get("dailyBestNineContent").innerHTML, /top-user/);
});

test("manual lineupはAUTOのeffectiveActiveを使い、active rosterを先に背番号順で並べる", () => {
  const context = vm.createContext({ window: { Starting9Public: {} } });
  vm.runInContext(lineupRendererSource, context);
  const renderer = context.window.Starting9AdminV3.createAdminV3ManualLineupRenderer({ escapeHtml });
  const players = [
    { playerId: "active-21", playerName: "Active 21", uniformNumber: "21" },
    { playerId: "auto-active-10", playerName: "Auto Active 10", uniformNumber: "10" },
    { playerId: "auto-inactive-2", playerName: "Auto Inactive 2", uniformNumber: "2" },
    { playerId: "inactive-3", playerName: "Inactive 3", uniformNumber: "3" },
    { playerId: "unknown", playerName: "Unknown", uniformNumber: "" }
  ];
  const manualRoster = {
    entries: [
      { playerId: "active-21", mode: "active" },
      { playerId: "auto-active-10", mode: "auto", effectiveActive: true },
      { playerId: "auto-inactive-2", mode: "auto", effectiveActive: false },
      { playerId: "inactive-3", mode: "inactive" },
      { playerId: "unknown", mode: "auto", effectiveActive: false }
    ]
  };
  const sorted = renderer.sortPlayersByRosterAndUniformNumber(players, manualRoster);
  assert.equal(JSON.stringify(sorted.map((player) => player.playerId)), JSON.stringify(["auto-active-10", "active-21", "auto-inactive-2", "inactive-3", "unknown"]));
});

test("manual lineupはAUTOのeffectiveActiveがない旧データで既存fallbackを使う", () => {
  const context = vm.createContext({ window: { Starting9Public: {} } });
  vm.runInContext(lineupRendererSource, context);
  const renderer = context.window.Starting9AdminV3.createAdminV3ManualLineupRenderer({ escapeHtml });
  const players = [
    { playerId: "fallback-active", playerName: "Fallback Active", uniformNumber: "7", manualRosterStatus: "active" },
    { playerId: "unknown-auto", playerName: "Unknown Auto", uniformNumber: "8" }
  ];
  const sorted = renderer.sortPlayersByRosterAndUniformNumber(players, {
    entries: [
      { playerId: "fallback-active", mode: "auto" },
      { playerId: "unknown-auto", mode: "auto" }
    ]
  });
  assert.equal(JSON.stringify(sorted.map((player) => player.playerId)), JSON.stringify(["fallback-active", "unknown-auto"]));
});

test("V4診断は停止中のfetch jobを異常扱いせず、手動stageを明示する", () => {
  const context = vm.createContext({ window: {} });
  vm.runInContext(diagnosticsRendererSource, context);
  const renderer = context.window.Starting9AdminV3.createAdminV3DiagnosticsRenderer({
    state: { automationLogs: null, automationLogFilters: {} },
    escapeHtml: (value) => String(value ?? ""),
    formatJst: (value) => String(value || "-"),
    listItems: (value, key = "items") => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [],
    filterGames: (games, filter) => filter === "today" ? games.filter((game) => game.gameDate === "2026-09-28") : games,
    jstDate: () => "2026-09-28",
    gameDateForFilter: (game) => game.gameDate,
    currentFailedJobs: (game) => (game.jobs || []).filter((job) => job.status === "failed"),
    currentRetryWaitJobs: () => [],
    normalizedPhaseState: () => null,
    rosterDisplayState: () => ({ status: "waiting", detail: "legacy" }),
    lineupDisplayState: () => ({ status: "waiting", detail: "legacy" }),
    nextActionText: () => "次の処理",
    renderSelectedGameHeader: () => "",
    renderJobRows: () => "",
    latestJob: () => null,
    jobTypes: [],
    statusLabel: (value) => String(value || ""),
    identityStatusLabel: (value) => String(value || "")
  });
  const game = {
    internalGameId: "v4-game",
    gameDate: "2026-09-28",
    state: { state: "scheduled" },
    jobs: [
      { job_type: "roster_fetch", status: "failed" },
      { job_type: "lineup_fetch", status: "failed" }
    ],
    rosterDiagnostics: { rosterSnapshotExists: false },
    canonicalArtifacts: { aggregate: { lineupReady: false, needsAttention: false } },
    schedule: {}
  };
  const model = renderer.buildTodayOpsModel({ automationMode: { isV4SemiAuto: true }, todayOps: { futureGamesCount: 3, cronLastRunAt: "2026-09-28T00:59:00.000Z" } }, [game], new Date("2026-09-28T01:00:00.000Z"));
  assert.equal(model.gameModels[0].status, "ok");
  assert.equal(model.gameModels[0].steps.roster, "waiting");
  assert.match(model.gameModels[0].steps.rosterDetail, /V4_MANUAL_ROSTER/);
  assert.match(model.gameModels[0].steps.lineupDetail, /手動確定待ち/);
  assert.match(model.gameModels[0].steps.lineupDetail, /V4_MANUAL_LINEUP/);
});

test("manual lineupのモバイル操作は16px以上・touch-actionを維持し、zoom禁止を使わない", () => {
  const mobileBlock = css.slice(css.indexOf("@media (max-width: 720px)"));
  assert.match(mobileBlock, /\.admin-v3-shell button[\s\S]*\.admin-v3-shell textarea \{ font-size: 16px; \}/);
  assert.match(mobileBlock, /\.manual-lineup-candidate,[\s\S]*\.manual-roster-candidate \{ touch-action: manipulation; \}/);
  assert.doesNotMatch(adminHtml, /user-scalable\s*=\s*["']?no/i);
  assert.doesNotMatch(adminHtml, /maximum-scale\s*=\s*1(?:\.0+)?/i);
});
