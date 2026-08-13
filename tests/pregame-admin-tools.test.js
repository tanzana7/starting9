const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("旧の緊急復旧ツールと手動pregame操作は通常公開bundleから除去される", () => {
  const html = read("index.html");
  const script = read("script.js");
  assert.doesNotMatch(html, /adminPregameTools|runPregameNoticeButton|fixPregameRosterButton|runPregameLineupButton/);
  assert.doesNotMatch(script, /renderPregameAutomationTools|runPregameAutomationAction|refreshPregameAutomationStatus|PREGAME_UI_WATCHDOG_TIMEOUT/);
});

test("Workerの旧pregame mutation endpointは公開画面へ復活しない", () => {
  const worker = read("auth-worker.js");
  assert.doesNotMatch(read("index.html"), /pregame-automation|distributePregameNotice/);
  assert.match(worker, /legacyAdminOperationRetiredResponse|requireAdminUser/);
});

test("更新情報の残骸を公開bundleへ含めない", () => {
  assert.doesNotMatch(read("index.html"), /build-info\.js|更新情報|バージョン情報/);
  assert.doesNotMatch(read("script.js"), /STARTING9_BUILD_INFO|FRONTEND_UPDATED_AT/);
});
