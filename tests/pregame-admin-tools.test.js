const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("管理画面は試合前処理サマリーを自動取得せず緊急復旧ツールだけを持つ", () => {
  const html = read("index.html");
  const script = read("script.js");
  const authWorker = read("auth-worker.js");

  for (const legacyId of ["adminPregameAutomationSummary", "adminPregameAutomationMessage", "adminPregameAutomationDiagnostic"]) {
    assert.doesNotMatch(html, new RegExp(`id="${legacyId}"`));
    assert.doesNotMatch(script, new RegExp(legacyId));
  }
  assert.doesNotMatch(script, /refreshPregameAutomationStatus|PREGAME_UI_WATCHDOG_TIMEOUT|PREGAME_RENDER_COMPLETED/);
  assert.doesNotMatch(authWorker, /pregame-automation\/status|PREGAME_SUMMARY_TIMEOUT/);
  for (const id of [
    "runPregameNoticeButton",
    "distributePregameNoticeButton",
    "fixPregameRosterButton",
    "runPregameLineupButton",
    "runPregameScoringButton",
    "publishPregameResultsButton",
    "adminPregameAutomationToolsMessage"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function renderPregameAutomationTools\(\)/);
  assert.match(script, /distribute-notice/);
  assert.match(html, /id="adminPregameTools" class="admin-test-details"/);
  assert.match(html, /通常は使用しない手動復旧/);
});

test("更新情報機能の残骸を持たない", () => {
  const html = read("index.html");
  const script = read("script.js");
  const authWorker = read("auth-worker.js");
  const npbWorker = read("cloudflare-worker.js");
  assert.doesNotMatch(html, /build-info\.js|更新情報|バージョン情報/);
  assert.doesNotMatch(script, /build-info|STARTING9_BUILD_INFO|FRONTEND_UPDATED_AT/);
  assert.doesNotMatch(authWorker, /build-info|AUTH_WORKER_UPDATED_AT|api\/admin\/version/);
  assert.doesNotMatch(npbWorker, /build-info|NPB_WORKER_UPDATED_AT/);
  assert.equal(fs.existsSync(path.join(root, "build-info.js")), false);
});
