import test from "node:test";
import assert from "node:assert/strict";
import { onRequest, resolveAuthWorkerOrigin } from "../functions/api/[[path]].js";

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
