const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("開発APIは管理者認証とサーバー側の有効フラグを必須にする", () => {
  assert.match(worker, /async function requireDevelopmentUser\(request, env, cors\)/);
  assert.match(worker, /await requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /ENABLE_DEVELOPMENT_MODE/);
  assert.match(worker, /\/api\/dev\/status/);
  assert.match(worker, /create-perfect-prediction/);
  assert.match(worker, /cron\/run-auto-scoring/);
});

test("画面状態と管理権限状態を分離し、開発画面を別セクションにする", () => {
  assert.match(script, /appMode:\s*"normal"/);
  assert.match(script, /state\.appMode = "admin"/);
  assert.match(script, /state\.appMode = "development"/);
  assert.match(html, /id="adminDetails"/);
  assert.match(html, /id="developmentDetails"/);
  assert.match(html, /id="createPerfectPredictionButton"/);
  assert.match(html, /id="runDevelopmentCronButton"/);
  assert.doesNotMatch(html, /admin-test-tools/);
});
