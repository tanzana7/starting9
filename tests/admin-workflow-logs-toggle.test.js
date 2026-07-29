const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("試合進行ログは初期閉鎖・localStorage復元・アクセシブルな開閉操作を持つ", () => {
  const html = read("index.html");
  const script = read("script.js");
  assert.match(html, /id="adminWorkflowLogsContent" class="admin-workflow-logs-content hidden"/);
  assert.match(html, /id="toggleAdminWorkflowLogsButton"[^>]*aria-expanded="false"[^>]*aria-controls="adminWorkflowLogsContent"/);
  assert.match(script, /ADMIN_WORKFLOW_LOGS_EXPANDED_STORAGE_KEY/);
  assert.match(script, /localStorage\.getItem\(ADMIN_WORKFLOW_LOGS_EXPANDED_STORAGE_KEY\)/);
  assert.match(script, /localStorage\.setItem\(ADMIN_WORKFLOW_LOGS_EXPANDED_STORAGE_KEY, String\(state\.workflowLogs\.expanded\)\)/);
  assert.match(script, /toggle\.setAttribute\("aria-expanded", String\(expanded\)\)/);
  assert.match(script, /toggle\.textContent = expanded \? "ログを閉じる" : "ログを表示"/);
});

test("閉じている間はフィルター等を隠し、開いた時だけ最新ログを取得する", () => {
  const script = read("script.js");
  assert.match(script, /content\.classList\.toggle\("hidden", !expanded\)/);
  assert.match(script, /refresh\.classList\.toggle\("hidden", !expanded\)/);
  assert.match(script, /if \(!state\.workflowLogs\.expanded\) return;/);
  assert.match(script, /if \(state\.workflowLogs\.expanded\) \{\s+void refreshAdminWorkflowLogs\(\{ force: true \}\);/);
  assert.match(script, /bindAdminEvent\("toggleAdminWorkflowLogsButton", "click", toggleAdminWorkflowLogs\)/);
});

test("既存のフィルター・詳細表示は展開後のログ領域に残る", () => {
  const html = read("index.html");
  const script = read("script.js");
  assert.match(html, /id="adminWorkflowLogGameId"/);
  assert.match(html, /id="adminWorkflowLogEventType"/);
  assert.match(html, /id="adminWorkflowLogStatus"/);
  assert.match(script, /<details><summary>詳細<\/summary><pre>/);
  assert.match(script, /query\.set\("gameId", gameId\)/);
  assert.match(script, /query\.set\("eventType", eventType\)/);
  assert.match(script, /query\.set\("status", status\)/);
});
