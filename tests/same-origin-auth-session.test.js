import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authSource = fs.readFileSync(path.join(root, "auth.js"), "utf8");
const publicScriptSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
const adminEntrySource = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const adminApiSource = fs.readFileSync(path.join(root, "frontend", "admin-v3", "api-client.js"), "utf8");
const functionSource = fs.readFileSync(path.join(root, "functions", "api", "[[path]].js"), "utf8");

test("本番の公開認証APIはPages同一オリジンへ解決する", () => {
  assert.match(authSource, /window\.location\.origin/);
  assert.doesNotMatch(authSource, /return AUTH_PRODUCTION_API_BASE_URL/);
  assert.match(authSource, /credentials:\s*["']include["']/);
  assert.match(publicScriptSource, /getAuthApiBaseUrl\(\)/);
  assert.match(publicScriptSource, /credentials:\s*["']include["']/);
  assert.match(adminEntrySource, /const V3_AUTH_PRODUCTION_BASE = ""/);
  assert.match(adminApiSource, /return location\.origin/);
});

test("Pages API Functionは固定Auth WorkerへCookie付きで中継する", () => {
  assert.match(functionSource, /const TARGET_AUTH_WORKER_ORIGIN = "https:\/\/starting9-auth\.starting9\.workers\.dev"/);
  assert.doesNotMatch(functionSource, /SOURCE_AUTH_WORKER_ORIGIN/);
  assert.match(functionSource, /request\.headers/);
  assert.match(functionSource, /"origin"/i);
  assert.match(functionSource, /headers\.append\("Set-Cookie"/);
  assert.doesNotMatch(functionSource, /https?:\/\/\$\{/);
});

test("Pages API FunctionはログインCookieをPages向けに保持し、Domainだけを除去する", async () => {
  const { onRequest } = await import(pathToFileURL(path.join(root, "functions", "api", "[[path]].js")).href);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (request) => {
    calls.push(request);
    return new Response(JSON.stringify({ ok: true, authenticated: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "s9_session=opaque-token; Domain=starting9-auth.tanzana7.workers.dev; Path=/; HttpOnly; Secure; SameSite=None"
      }
    });
  };

  try {
    const response = await onRequest({
      request: new Request("https://starting9.pages.dev/api/auth/login?next=home", {
        method: "POST",
        headers: {
          Cookie: "s9_session=old-token",
          Origin: "https://starting9.pages.dev",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ username: "tester", password: "password" })
      }),
      env: { STARTING9_AUTH_ORIGIN: "https://starting9-auth.starting9.workers.dev" }
    });

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://starting9-auth.starting9.workers.dev/api/auth/login?next=home");
    assert.equal(calls[0].headers.get("Cookie"), "s9_session=old-token");
    assert.equal(calls[0].headers.get("Origin"), null);
    const cookie = response.headers.get("Set-Cookie");
    assert.match(cookie, /^s9_session=opaque-token/);
    assert.doesNotMatch(cookie, /Domain=/i);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=None/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pages API FunctionはAPI以外を中継せず、上流障害を503へ分類する", async () => {
  const { onRequest } = await import(pathToFileURL(path.join(root, "functions", "api", "[[path]].js")).href);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("upstream unavailable");
  };
  try {
    const notFound = await onRequest({ request: new Request("https://starting9.pages.dev/other") });
    assert.equal(notFound.status, 404);

    const unavailable = await onRequest({
      request: new Request("https://starting9.pages.dev/api/auth/me"),
      env: { STARTING9_AUTH_ORIGIN: "https://starting9-auth.starting9.workers.dev" }
    });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      ok: false,
      code: "AUTH_PROXY_UNAVAILABLE",
      error: "認証サービスに接続できません。時間をおいて再試行してください。"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pages API FunctionはSOURCE fallbackを持たない", async () => {
  const { onRequest } = await import(pathToFileURL(path.join(root, "functions", "api", "[[path]].js")).href);
  const response = await onRequest({
    request: new Request("https://starting9.pages.dev/api/auth/me"),
    env: { STARTING9_AUTH_ORIGIN: "https://starting9-auth.tanzana7.workers.dev" }
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "AUTH_PROXY_NOT_CONFIGURED",
    error: "認証サービスの接続先が設定されていません。"
  });
});

test("Pages APIのルート設定はAPIだけをFunctionへ送る", () => {
  const routes = JSON.parse(fs.readFileSync(path.join(root, "_routes.json"), "utf8"));
  assert.deepEqual(routes, { version: 1, include: ["/api/*"], exclude: [] });
  assert.doesNotMatch(fs.readFileSync(path.join(root, "_redirects"), "utf8"), /starting9-auth\.tanzana7\.workers\.dev/);
});
