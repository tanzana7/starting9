import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import worker from "../auth-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apiSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "api-client.js"), "utf8");
const adminSource = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

function loadApiClient(fetchImpl) {
  const window = {};
  const context = { window, URLSearchParams, console };
  vm.createContext(context);
  vm.runInContext(apiSource, context);
  return window.Starting9AdminV3.createAdminV3ApiClient({
    fetchImpl,
    location: { hostname: "starting9.pages.dev" },
    productionBase: "https://starting9-auth.tanzana7.workers.dev"
  });
}

function okResponse(body = { ok: true }) {
  return { ok: true, status: 200, json: async () => body };
}

test("admin mutationは全て共通request経由でcredentials includeを維持する", async () => {
  const calls = [];
  const api = loadApiClient(async (url, options) => {
    calls.push({ url, options });
    return okResponse({ ok: true, roster: { entries: [] } });
  });

  await api.getSession();
  await api.saveManualRoster({ teamCode: "fighters", entries: [], confirmed: true });
  await api.saveManualLineup("game-1", { lineup: [], reason: "確認", confirmed: true });
  await api.finalizeManualLineup("game-1", { lineupRevisionId: "game-1:1", reason: "確認", confirmed: true });
  await api.request("/api/admin/v3/example", { method: "POST", credentials: "omit", body: JSON.stringify({ ok: true }) });

  assert.equal(calls.length, 5);
  for (const { options } of calls) assert.equal(options.credentials, "include");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers["Content-Type"], undefined);
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[2].options.method, "POST");
  assert.equal(calls[3].options.method, "POST");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  assert.equal(calls[2].options.headers["Content-Type"], "application/json");
  assert.equal(calls[3].options.headers["Content-Type"], "application/json");
  assert.equal(calls[4].options.headers["Content-Type"], "application/json");
  assert.match(calls[1].url, /\/api\/admin\/v3\/manual-roster$/);
  assert.match(calls[2].url, /\/api\/admin\/v3\/games\/game-1\/lineup-revisions$/);
  assert.match(calls[3].url, /\/api\/admin\/v3\/games\/game-1\/lineup-finalize$/);
});

test("認証失敗の表示は401/403/503/通信失敗を区別し、内部詳細を直接表示しない", () => {
  assert.match(adminSource, /function formatV3AdminError\(error, fallbackCode\)/);
  assert.match(adminSource, /adminAuthErrorMessage\(error\)/);
  assert.match(adminSource, /formatV3AdminError\(error, "V3_MANUAL_LINEUP_SAVE_FAILED"\)/);
  assert.match(adminSource, /formatV3AdminError\(error, "V3_MANUAL_LINEUP_FINALIZE_FAILED"\)/);
  assert.match(adminSource, /formatV3AdminError\(error, "MANUAL_ROSTER_SAVE_FAILED"\)/);
  assert.doesNotMatch(adminSource, /V3_MANUAL_LINEUP_SAVE_FAILED\"\}: \$\{error\.message\}/);
  assert.doesNotMatch(adminSource, /MANUAL_ROSTER_SAVE_FAILED\"\}: \$\{error\.message\}/);
  assert.match(apiSource, /error\.code = "NETWORK_ERROR"/);
  assert.match(apiSource, /管理APIへ接続できません/);
});

test("通信例外はNETWORK_ERRORへ正規化し、元の内部例外をUIへ渡さない", async () => {
  const api = loadApiClient(async () => {
    throw new Error("internal socket detail");
  });
  await assert.rejects(api.getSession(), (error) => {
    assert.equal(error.code, "NETWORK_ERROR");
    assert.equal(error.status, 0);
    assert.equal(error.message, "管理APIへ接続できません。通信状況を確認して再試行してください。");
    return true;
  });
});

test("manual roster mutationは未認証を401で拒否し、CORSは許可Originに限定する", async () => {
  const response = await worker.fetch(new Request("https://starting9-auth.test/api/admin/v3/manual-roster", {
    method: "PUT",
    headers: {
      Origin: "https://starting9.pages.dev",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ teamCode: "fighters", entries: [], confirmed: true })
  }), {
    AUTH_DB: {},
    AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev"
  }, {});
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "ログインが必要です。");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://starting9.pages.dev");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true");
  assert.doesNotMatch(workerSource, /Access-Control-Allow-Origin["']?\s*:\s*["']\*["']/);
  assert.match(workerSource, /if \(resolvedRole !== "admin"\)/);
});

test("manual mutationのpreflightはPUT/POSTとContent-Type/credentialsを許可する", async () => {
  const response = await worker.fetch(new Request("https://starting9-auth.test/api/admin/v3/manual-roster", {
    method: "OPTIONS",
    headers: {
      Origin: "https://starting9.pages.dev",
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type"
    }
  }), {
    AUTH_DB: {},
    AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev"
  }, {});
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://starting9.pages.dev");
  assert.match(response.headers.get("Access-Control-Allow-Methods") || "", /PUT/);
  assert.match(response.headers.get("Access-Control-Allow-Methods") || "", /POST/);
  assert.match((response.headers.get("Access-Control-Allow-Headers") || "").toLowerCase(), /content-type/);
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), "true");
});

test("admin-v3は変更済みapi-client cache busterを読み込む", () => {
  assert.match(htmlSource, /frontend\/admin-v3\/api-client\.js\?v=independent-roster-lineup-safety-1/);
});
