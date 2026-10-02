import test from "node:test";
import assert from "node:assert/strict";
import { onRequest, resolveAsiaCsWorkerOrigin, resolveAuthWorkerOrigin } from "../functions/api/[[path]].js";

const TARGET_ORIGIN = "https://starting9-auth.starting9.workers.dev";

test("Pages proxy requires the explicit TARGET origin and rejects SOURCE/invalid values", () => {
  assert.equal(resolveAuthWorkerOrigin(), null);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: TARGET_ORIGIN }), TARGET_ORIGIN);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: "https://starting9-auth.tanzana7.workers.dev" }), null);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: "https://untrusted.example" }), null);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: `${TARGET_ORIGIN}/` }), TARGET_ORIGIN);
});

test("Pages proxy preserves response and normalizes same-origin cookies for TARGET", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamUrl = "";
  globalThis.fetch = async (request) => {
    upstreamUrl = request.url;
    return new Response("upstream", {
      status: 201,
      headers: {
        "Content-Type": "text/plain",
        "Set-Cookie": "s9_session=abc; Domain=starting9-auth.tanzana7.workers.dev; Path=/; HttpOnly"
      }
    });
  };

  try {
    const response = await onRequest({
      request: new Request("https://starting9.pages.dev/api/auth/login?next=1", { method: "GET" }),
      env: { STARTING9_AUTH_ORIGIN: TARGET_ORIGIN }
    });

    assert.equal(upstreamUrl, `${TARGET_ORIGIN}/api/auth/login?next=1`);
    assert.equal(response.status, 201);
    assert.equal(await response.text(), "upstream");
    assert.match(response.headers.get("set-cookie") || "", /^s9_session=abc;/);
    assert.doesNotMatch(response.headers.get("set-cookie") || "", /Domain=/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pages proxy fails closed when TARGET upstream is not explicitly configured", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("must not reach an upstream");
  };

  try {
    for (const env of [
      {},
      { STARTING9_AUTH_ORIGIN: "https://starting9-auth.tanzana7.workers.dev" },
      { STARTING9_AUTH_ORIGIN: "https://untrusted.example" }
    ]) {
      const response = await onRequest({
        request: new Request("https://starting9.pages.dev/api/auth/me"),
        env
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        ok: false,
        code: "AUTH_PROXY_NOT_CONFIGURED",
        error: "認証サービスの接続先が設定されていません。"
      });
    }
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Pagesは/api/asia-cs/*だけを明示設定されたAsia CS originへ同一origin転送する", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (request) => {
    calls.push(request);
    return new Response(JSON.stringify({ ok: true, authenticated: false, user: null }), { status: 200 });
  };
  try {
    const env = { ASIA_CS_API_ORIGIN: "https://asia-cs-api.example" };
    assert.equal(resolveAsiaCsWorkerOrigin(env), "https://asia-cs-api.example");
    assert.equal(resolveAsiaCsWorkerOrigin({}), null);
    assert.equal(resolveAsiaCsWorkerOrigin({ ASIA_CS_API_ORIGIN: "http://asia-cs-api.example" }), null);
    assert.equal(resolveAsiaCsWorkerOrigin({ ASIA_CS_API_ORIGIN: "https://asia-cs-api.example/path" }), null);
    const response = await onRequest({
      request: new Request("https://starting9.pages.dev/api/asia-cs/auth/me?source=pages", {
        headers: { Cookie: "s9_session=abc%3D; unrelated=drop" }
      }),
      env
    });
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, "https://asia-cs-api.example/api/auth/me?source=pages");
    assert.equal(calls[0].headers.get("Cookie"), "s9_session=abc%3D");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PagesはAsia CS origin未設定時にfail closedし、既存Auth proxyを変えない", async () => {
  const response = await onRequest({
    request: new Request("https://starting9.pages.dev/api/asia-cs/auth/me"),
    env: {}
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "ASIA_CS_PROXY_NOT_CONFIGURED",
    error: "Asia CS APIの接続先が設定されていません。"
  });
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: TARGET_ORIGIN }), TARGET_ORIGIN);
});
