const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const coordinatorSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "app-coordinator.js"), "utf8");
const adminHtml = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

function makeTarget(selector, dataset) {
  return {
    dataset,
    closest(requested) {
      return requested === selector ? this : null;
    }
  };
}

function setupCoordinator(actionName, candidateSelector) {
  const context = { window: {} };
  vm.runInNewContext(coordinatorSource, context);
  const listeners = new Map();
  let candidateContainer = { scrollTop: 0 };
  let actionCalls = 0;
  const document = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    getElementById() { return null; },
    querySelector(selector) {
      return selector === candidateSelector ? candidateContainer : null;
    }
  };
  const actions = {
    restoreInitialRoute() {},
    load() {},
    [actionName]() {
      actionCalls += 1;
      candidateContainer = { scrollTop: 0 };
    }
  };
  const coordinator = context.window.Starting9AdminV3.createAdminV3Coordinator({
    document,
    window: { addEventListener() {} },
    state: { manualRoster: {}, manualLineup: {}, rankingReset: {}, perfectScorePreview: {} },
    actions
  });
  coordinator.start();
  candidateContainer.scrollTop = 347;
  return { listeners, actions, getCandidateContainer: () => candidateContainer, getActionCalls: () => actionCalls };
}

test("manual lineup選手選択後も候補一覧のscrollTopを維持する", async () => {
  const selector = '[data-v3-manual-lineup-candidates="0"]';
  const setup = setupCoordinator("selectManualLineupPlayer", selector);
  const target = makeTarget("[data-v3-manual-lineup-player]", {
    v3ManualLineupPlayer: "0",
    v3ManualLineupPlayerId: "F-53"
  });
  await setup.listeners.get("click")({ target });
  assert.equal(setup.getActionCalls(), 1);
  assert.equal(setup.getCandidateContainer().scrollTop, 347);
});

test("manual roster候補のactive/inactive変更後も候補一覧のscrollTopを維持する", async () => {
  const selector = "[data-v3-manual-roster-candidates]";
  const setup = setupCoordinator("updateManualRosterEntry", selector);
  const target = makeTarget("[data-v3-manual-roster-status]", {
    v3ManualRosterStatus: "F-3"
  });
  target.value = "inactive";
  await setup.listeners.get("change")({ target });
  assert.equal(setup.getActionCalls(), 1);
  assert.equal(setup.getCandidateContainer().scrollTop, 347);
});

test("候補scroll保持は検索入力のcomposition処理とcache busterを壊さない", () => {
  assert.match(coordinatorSource, /compositionend/);
  assert.match(coordinatorSource, /preservePickerScroll/);
  assert.match(adminHtml, /app-coordinator\.js\?v=independent-roster-lineup-safety-1-preserve-picker-scroll-1/);
});

