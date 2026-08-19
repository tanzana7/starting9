import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
const headers = fs.readFileSync(path.join(root, "_headers"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const { default: worker } = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);

function unauthenticatedRequest(pathname, method = "GET") {
  return new Request(`https://starting9.test${pathname}`, { method });
}

async function fetchUnauthenticated(pathname, method = "GET") {
  return worker.fetch(unauthenticatedRequest(pathname, method), { AUTH_DB: {} }, {});
}

test("admin-v3は検索結果から除外する", () => {
  assert.match(page, /<meta name="robots" content="noindex, nofollow, noarchive">/);
  assert.match(headers, /\/admin-v3\.html[\s\S]*X-Robots-Tag: noindex, nofollow, noarchive/);
  assert.match(headers, /\/admin-v3\s[\s\S]*X-Robots-Tag: noindex, nofollow, noarchive/);
});

test("admin-v3に運用向けの防御ヘッダーを付ける", () => {
  assert.match(headers, /X-Frame-Options: DENY/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
});

test("既知admin routeの未認証メソッド不一致は先に401で拒否する", async () => {
  const cases = [
    ["/api/admin/v3/perfect-score-test/preview", "GET"],
    ["/api/admin/v3/ranking-resets/preview", "GET"],
    ["/api/admin/v3/schedule/add-game/preview", "GET"],
    ["/api/admin/v3/ranking-resets/execute", "GET"],
    ["/api/admin/v3/games/00000000-0000-4000-8000-000000000000/jobs", "GET"],
    ["/api/admin/v3/overview", "POST"]
  ];

  for (const [pathname, method] of cases) {
    const response = await fetchUnauthenticated(pathname, method);
    assert.equal(response.status, 401, `${method} ${pathname}`);
    assert.match(await response.text(), /ログインが必要です/);
  }
});

test("危険操作の認証・確認境界は既存のhandlerに残る", () => {
  assert.match(workerSource, /async function handleAdminV3RankingResetExecute[\s\S]*?requireAdminUser\(request, env, cors\)/);
  assert.match(workerSource, /RANKING_RESET_CONFIRMATION_REQUIRED/);
  assert.match(workerSource, /async function handleAdminV3PerfectScorePreview[\s\S]*?requireAdminUser\(request, env, cors\)/);
  assert.doesNotMatch(workerSource, /\/api\/admin\/v3\/perfect-score-test\/execute/);
});
