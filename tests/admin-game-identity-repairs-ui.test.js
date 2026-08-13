const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("旧ゲームID修復UIは通常公開bundleから除去される", () => {
  const html = read("index.html");
  const script = read("script.js");
  assert.doesNotMatch(html, /adminGameIdentityRepairsPanel|refreshAdminGameIdentityRepairsButton/);
  assert.doesNotMatch(script, /buildAdminGameIdentityRepair|refreshAdminGameIdentityRepair|executeGameIdentityRepair/);
});

test("ゲームID修復の管理API実装はWorker側に残し、公開画面へ露出しない", () => {
  const worker = read("auth-worker.js");
  const adminHtml = read("admin-v3.html");
  assert.match(worker, /game-identity-repairs/);
  assert.match(adminHtml, /admin-v3/);
  assert.doesNotMatch(read("index.html"), /game-identity-repairs|gameIdentityRepairs/);
});

test("旧管理画面用styleは通常画面のHTMLから参照されない", () => {
  assert.doesNotMatch(read("index.html"), /admin-game-identity-repairs/);
});
