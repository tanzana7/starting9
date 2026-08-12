import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = path.join(root, "frontend", "admin-v3");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

function loadModules() {
  const context = {
    window: {},
    Map,
    Set,
    URLSearchParams,
    Intl,
    Date
  };
  vm.createContext(context);
  for (const name of ["state", "api-client", "app-coordinator"]) {
    vm.runInContext(fs.readFileSync(path.join(moduleDir, `${name}.js`), "utf8"), context);
  }
  return context.window.Starting9AdminV3;
}

test("admin-v3はstate -> API client -> coordinator -> entry pointの順で読み込む", () => {
  const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scripts, [
    "frontend/admin-v3/state.js?v=admin-and-repo-polish-1",
    "frontend/admin-v3/api-client.js?v=admin-and-repo-polish-1",
    "frontend/admin-v3/app-coordinator.js?v=admin-and-repo-polish-1",
    "admin-v3.js?v=admin-and-repo-polish-1"
  ]);
  const modules = loadModules();
  assert.equal(typeof modules.createAdminV3State, "function");
  assert.equal(typeof modules.createAdminV3ApiClient, "function");
  assert.equal(typeof modules.createAdminV3Coordinator, "function");
});

test("admin API clientは認証付きGET/POSTとendpoint境界を集約する", async () => {
  const calls = [];
  const api = loadModules().createAdminV3ApiClient({
    location: { hostname: "starting9.pages.dev" },
    productionBase: "https://auth.example.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ ok: true }) };
    }
  });
  await api.getSession();
  await api.previewPerfectScore({ internalGameId: "game-1", reason: "release review" });
  assert.equal(calls[0].url, "https://auth.example.test/api/admin/me");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[1].options.method, "POST");
  assert.match(calls[1].url, /perfect-score-test\/preview/);
});

test("stateはdangerous previewとfixtureの状態を通常workflow stateから分離する", () => {
  const state = loadModules().createAdminV3State({ releaseFixtureKey: "release_full_score_debug_1" });
  assert.equal(state.rankingReset.preview, null);
  assert.equal(state.rankingReset.confirmation, "");
  assert.equal(state.perfectScorePreview.fixtureKey, "release_full_score_debug_1");
  assert.equal(state.perfectScorePreview.result, null);
});
