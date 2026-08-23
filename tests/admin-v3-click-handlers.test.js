import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "frontend", "admin-v3", "app-coordinator.js"), "utf8");
const html = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

function createHarness() {
  const listeners = {};
  const calls = [];
  const actions = {
    chooseView: (...args) => calls.push(["chooseView", ...args]),
    previewRankingReset: async () => calls.push(["previewRankingReset"]),
    executeRankingReset: async () => calls.push(["executeRankingReset"]),
    previewPerfectScore: async (...args) => calls.push(["previewPerfectScore", ...args]),
    previewManualGame: async () => calls.push(["previewManualGame"]),
    refreshAutomationLogs: async () => calls.push(["refreshAutomationLogs"]),
    diagnoseJob: async (...args) => calls.push(["diagnoseJob", ...args]),
    runJob: async (...args) => calls.push(["runJob", ...args]),
    reconcileState: async (...args) => calls.push(["reconcileState", ...args]),
    saveSchedule: async (...args) => calls.push(["saveSchedule", ...args]),
    cancelGame: async (...args) => calls.push(["cancelGame", ...args]),
    excludeFromRanking: async (...args) => calls.push(["excludeFromRanking", ...args]),
    selectGame: async (...args) => calls.push(["selectGame", ...args]),
    copyJobDetail: async (...args) => calls.push(["copyJobDetail", ...args]),
    refreshJobDetail: async (...args) => calls.push(["refreshJobDetail", ...args]),
    toggleJobDetail: async (...args) => calls.push(["toggleJobDetail", ...args]),
    load: async () => calls.push(["load"]),
    changeFilter: (...args) => calls.push(["changeFilter", ...args]),
    selectGameFromToolbar: (...args) => calls.push(["selectGameFromToolbar", ...args]),
    handleHashChange: () => calls.push(["handleHashChange"]),
    restoreInitialRoute: () => calls.push(["restoreInitialRoute"])
  };
  const document = {
    addEventListener(type, listener) { listeners[type] = listener; },
    getElementById() { return null; }
  };
  const window = { addEventListener() {} };
  const context = vm.createContext({ window, document, state: { rankingReset: {}, perfectScorePreview: {} }, actions, calls });
  vm.runInContext(source, context);
  vm.runInContext(`this.coordinator = window.Starting9AdminV3.createAdminV3Coordinator({ document, window, state, actions });`, context);
  context.coordinator.start();
  return { listeners, calls };
}

function targetFor(selector, dataset = {}) {
  return { closest: (candidate) => candidate === selector ? { dataset } : null };
}

test("admin-v3の動的click delegationはElement以外のtargetでも例外なく試合操作を拾う", async () => {
  const { listeners, calls } = createHarness();
  await listeners.click({ target: { parentElement: targetFor("[data-v3-select-game]", { v3SelectGame: "game-1" }) } });
  await listeners.click({ target: targetFor("[data-v3-job-detail]", { v3JobDetail: "game-1", v3JobId: "12" }) });
  await listeners.click({ target: targetFor("[data-v3-job-diagnose]", { v3JobDiagnose: "game-1", v3JobType: "lineup_fetch" }) });
  assert.deepEqual(calls.slice(-3).map((call) => call.slice(0, 3)), [
    ["selectGame", "game-1"],
    ["toggleJobDetail", "game-1", "12"],
    ["diagnoseJob", "game-1", "lineup_fetch"]
  ]);
});

test("admin-v3の明示的な中止ボタンは既存のcancel操作へ委譲する", async () => {
  const { listeners, calls } = createHarness();
  await listeners.click({ target: targetFor("[data-v3-schedule-cancel]", { v3ScheduleCancel: "game-1" }) });
  assert.deepEqual(calls.at(-1), ["cancelGame", "game-1"]);
});

test("admin-v3の各操作data属性とcache busterがentrypointで一致する", () => {
  const buster = "admin-v3-v35-derived-diagnostics-1";
  assert.match(html, new RegExp(`admin-v3\.html|admin-v3\.js\\?v=${buster}`));
  assert.match(html, new RegExp(`app-coordinator\\.js\\?v=${buster}`));
  assert.match(source, /\[data-v3-select-game\]/);
  assert.match(source, /\[data-v3-job-detail\]/);
  assert.match(source, /\[data-v3-job-diagnose\]/);
  assert.match(source, /\[data-v3-job-run\]/);
  assert.match(source, /\[data-v3-schedule-cancel\]/);
});
