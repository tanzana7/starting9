const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("通常公開bundleに試合進行ログの管理UIを含めない", () => {
  const html = read("index.html");
  const script = read("script.js");
  assert.doesNotMatch(html, /adminWorkflowLogs|toggleAdminWorkflowLogsButton/);
  assert.doesNotMatch(script, /ADMIN_WORKFLOW_LOGS_EXPANDED_STORAGE_KEY|refreshAdminWorkflowLogs/);
});

test("管理監査ログはadmin-v3側に分離されている", () => {
  const html = read("admin-v3.html");
  const script = read("admin-v3.js");
  assert.match(html, /admin-v3/);
  assert.match(script, /admin|audit|workflow/i);
});

test("通常画面には管理ログのフィルターや詳細表示を含めない", () => {
  const html = read("index.html");
  const script = read("script.js");
  assert.doesNotMatch(html, /adminWorkflowLog(GameId|EventType|Status)/);
  assert.doesNotMatch(script, /adminWorkflowLog(GameId|EventType|Status)|query\.set\("eventType"/);
});
