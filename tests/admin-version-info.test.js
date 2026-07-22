const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("管理画面だけに更新情報の表示領域を持つ", () => {
  const html = read("index.html");
  const script = read("script.js");
  const buildInfo = read("build-info.js");

  assert.match(html, /src="build-info\.js\?v=20260722-3"/);
  assert.doesNotMatch(html, /version\.js/);
  assert.match(html, /id="adminDeploymentInfo"/);
  assert.match(html, /更新情報/);
  assert.doesNotMatch(html, />VERSION</);
  assert.match(buildInfo, /frontendUpdatedAt: FRONTEND_UPDATED_AT/);
  assert.match(buildInfo, /2026-07-22T06:00:00\.000Z/);
  assert.match(script, /function refreshAdminDeploymentInfo\(\)/);
  assert.match(script, /cache: "no-store"/);
  assert.match(script, /buildAdminBuildInfoApiUrl/);
  assert.match(script, /buildNpbBuildInfoApiUrl/);
  assert.match(script, /timeZone: "Asia\/Tokyo"/);
});

test("Workerの更新情報APIは固定更新日時だけをno-storeで返す", () => {
  const authWorker = read("auth-worker.js");
  const npbWorker = read("cloudflare-worker.js");

  assert.match(authWorker, /path === "\/api\/admin\/build-info"/);
  assert.match(authWorker, /async function handleAdminBuildInfo/);
  assert.match(authWorker, /await requireAdminUser\(request, env, cors\)/);
  assert.match(authWorker, /function noStoreJsonResponse/);
  assert.match(authWorker, /updatedAt: AUTH_WORKER_UPDATED_AT/);
  assert.doesNotMatch(authWorker, /version: AUTH_WORKER/);
  assert.match(npbWorker, /requestUrl\.pathname === "\/build-info"/);
  assert.match(npbWorker, /service: "npb-worker"/);
  assert.match(npbWorker, /updatedAt: NPB_WORKER_UPDATED_AT/);
  assert.match(npbWorker, /"Cache-Control": "no-store"/);
});
