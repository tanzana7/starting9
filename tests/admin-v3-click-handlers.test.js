import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { canonicalAdmin } = require("./helpers/admin-canonical-runtime.cjs");
const source = fs.readFileSync(path.join(root, "frontend", "admin-v3", "app-coordinator.js"), "utf8");
const html = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

function createHarness() {
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
    updateManualLineupRow: (...args) => calls.push(["updateManualLineupRow", ...args]),
    updateManualLineupPosition: (...args) => calls.push(["updateManualLineupPosition", ...args]),
    load: async () => calls.push(["load"]),
    changeFilter: (...args) => calls.push(["changeFilter", ...args]),
    selectGameFromToolbar: (...args) => calls.push(["selectGameFromToolbar", ...args]),
    handleHashChange: () => calls.push(["handleHashChange"]),
    restoreInitialRoute: () => calls.push(["restoreInitialRoute"])
  };
  const app = canonicalAdmin({ withCoordinator: true, coordinatorActions: actions });
  app.coordinator.start();
  return { app, calls };
}

function targetFor(selector, dataset = {}) {
  return { closest: (candidate) => candidate === selector ? { dataset } : null };
}

test("admin-v3の動的click delegationはElement以外のtargetでも例外なく試合操作を拾う", async () => {
  const { app, calls } = createHarness();
  const parent = targetFor("[data-v3-select-game]", { v3SelectGame: "game-1" });
  await app.emitDocument("click", { target: { closest: (selector) => parent.closest(selector), parentElement: parent } });
  await app.emitDocument("click", { target: targetFor("[data-v3-job-detail]", { v3JobDetail: "game-1", v3JobId: "12" }) });
  await app.emitDocument("click", { target: targetFor("[data-v3-job-diagnose]", { v3JobDiagnose: "game-1", v3JobType: "lineup_fetch" }) });
  assert.deepEqual(calls.slice(-3).map((call) => call.slice(0, 3)), [
    ["selectGame", "game-1"],
    ["toggleJobDetail", "game-1", "12"],
    ["diagnoseJob", "game-1", "lineup_fetch"]
  ]);
});

test("admin-v3の明示的な中止ボタンは既存のcancel操作へ委譲する", async () => {
  const { app, calls } = createHarness();
  await app.emitDocument("click", { target: targetFor("[data-v3-schedule-cancel]", { v3ScheduleCancel: "game-1" }) });
  assert.deepEqual(calls.at(-1), ["cancelGame", "game-1"]);
});

test("admin-v3のmanual lineup守備位置picker変更は選択行へ委譲する", async () => {
  const { app, calls } = createHarness();
  const target = {
    dataset: { v3ManualLineupPositionOption: "2", position: "遊" },
    closest(selector) { return selector === "[data-v3-manual-lineup-position-option]" ? this : null; }
  };
  await app.emitDocument("click", { target });
  assert.equal(calls.at(-1)[0], "updateManualLineupPosition");
  assert.equal(calls.at(-1)[1], 2);
  assert.equal(calls.at(-1)[2], "遊");
});

test("admin-v3の各操作data属性とcache busterがentrypointで一致する", () => {
  const buster = "independent-roster-lineup-safety-1";
  assert.match(html, new RegExp(`admin-v3\.html|admin-v3\.js\\?v=${buster}`));
  assert.match(html, new RegExp(`app-coordinator\\.js\\?v=${buster}`));
  assert.match(source, /\[data-v3-select-game\]/);
  assert.match(source, /\[data-v3-job-detail\]/);
  assert.match(source, /\[data-v3-job-diagnose\]/);
  assert.match(source, /\[data-v3-job-run\]/);
  assert.match(source, /\[data-v3-schedule-cancel\]/);
});
