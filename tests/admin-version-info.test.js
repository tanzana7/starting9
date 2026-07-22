const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("管理画面だけにバージョン情報の表示領域を持つ", () => {
  const html = read("index.html");
  const script = read("script.js");
  const version = read("version.js");

  assert.match(html, /id="adminVersionInfo"/);
  assert.match(html, /バージョン情報/);
  assert.match(version, /const APP_VERSION = "2026\.07\.22-1"/);
  assert.match(script, /function refreshAdminVersionInfo\(\)/);
  assert.match(script, /cache: "no-store"/);
  assert.match(script, /buildAdminVersionApiUrl/);
  assert.match(script, /buildNpbVersionApiUrl/);
});

test("WorkerのバージョンAPIは安全な識別子だけをno-storeで返す", () => {
  const authWorker = read("auth-worker.js");
  const npbWorker = read("cloudflare-worker.js");

  assert.match(authWorker, /path === "\/api\/admin\/version"/);
  assert.match(authWorker, /async function handleAdminVersion/);
  assert.match(authWorker, /await requireAdminUser\(request, env, cors\)/);
  assert.match(authWorker, /function noStoreJsonResponse/);
  assert.match(npbWorker, /requestUrl\.pathname === "\/version"/);
  assert.match(npbWorker, /service: "npb-worker"/);
  assert.match(npbWorker, /"Cache-Control": "no-store"/);
});
