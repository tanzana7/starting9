const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("管理者テストAPIは既存の管理者認証を必須にする", () => {
  assert.match(worker, /async function handleAdminTestRoute\(request, env, cors, route\)/);
  assert.match(worker, /await requireAdminUser\(request, env, cors\)/);
  assert.doesNotMatch(worker, /requireDevelopmentUser/);
  assert.doesNotMatch(worker, /ENABLE_DEVELOPMENT_MODE/);
  assert.match(worker, /\/api\/dev\/status/);
  assert.match(worker, /create-perfect-prediction/);
  assert.match(worker, /cron\/run-auto-scoring/);
});

test("画面状態を通常と管理の2種類に整理し、テスト操作を管理画面へ含める", () => {
  assert.match(script, /appMode:\s*"normal"/);
  assert.match(script, /state\.appMode = "admin"/);
  assert.doesNotMatch(script, /appMode = "development"/);
  assert.match(html, /id="adminDetails"/);
  assert.match(html, /id="adminTestDetails"/);
  assert.match(html, /id="createPerfectPredictionButton"/);
  assert.match(html, /id="runAdminTestCronButton"/);
  assert.match(html, /開発用テスト/);
});
