import test from "node:test";
import assert from "node:assert/strict";
import { onRequest, resolveAuthWorkerOrigin, resolveTestSimulatorMode, resolveTestTeam } from "../functions/api/[[path]].js";

const TARGET_ORIGIN = "https://starting9-auth.starting9.workers.dev";

test("Pages proxy requires the explicit TARGET origin and rejects SOURCE/invalid values", () => {
  assert.equal(resolveAuthWorkerOrigin(), null);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: TARGET_ORIGIN }), TARGET_ORIGIN);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: "https://starting9-auth.tanzana7.workers.dev" }), null);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: "https://untrusted.example" }), null);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: `${TARGET_ORIGIN}/` }), TARGET_ORIGIN);
});

test("test team selection is cookie/query scoped to the isolated Pages environment", () => {
  assert.equal(resolveTestTeam(new Request("https://starting9-test.pages.dev/api/public/games?testTeam=giants"), { SITE_ENVIRONMENT: "test" }), "giants");
  assert.equal(resolveTestTeam(new Request("https://starting9-test.pages.dev/api/public/games", { headers: { Cookie: "s9_test_team=marines" } }), { SITE_ENVIRONMENT: "test" }), "marines");
  assert.equal(resolveTestTeam(new Request("https://starting9-test.pages.dev/api/public/games?testTeam=unknown"), { SITE_ENVIRONMENT: "test" }), "__invalid_test_team__");
  assert.equal(resolveTestTeam(new Request("https://starting9-test.pages.dev/api/public/games"), { SITE_ENVIRONMENT: "test" }), "fighters");
  assert.equal(resolveTestTeam(new Request("https://starting9-app.pages.dev/api/public/games?testTeam=giants", { headers: { Cookie: "s9_test_team=giants" } }), { SITE_ENVIRONMENT: "production" }), "");
});

test("simulated provider routing is opt-in by the Test Site cookie and impossible in production", () => {
  const request = new Request("https://s9simu.pages.dev/api/public/games", { headers: { Cookie: "s9_test_source=simu-npb" } });
  assert.equal(resolveTestSimulatorMode(request, { SITE_ENVIRONMENT: "test" }), true);
  assert.equal(resolveTestSimulatorMode(request, { SITE_ENVIRONMENT: "production" }), false);
  assert.equal(resolveTestSimulatorMode(new Request("https://s9simu.pages.dev/api/public/games"), { SITE_ENVIRONMENT: "test" }), false);
});

test("Pages test proxy forwards only the allowlisted synthetic team and never alters production requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (request) => {
    requests.push(request.url);
    return new Response("ok", { status: 200 });
  };
  try {
    await onRequest({ request: new Request("https://starting9-test.pages.dev/api/public/games", { headers: { Cookie: "s9_test_team=giants" } }),
      env: { SITE_ENVIRONMENT: "test", STARTING9_AUTH_ORIGIN: "https://starting9-test-auth.starting9.workers.dev" } });
    await onRequest({ request: new Request("https://starting9-app.pages.dev/api/public/games", { headers: { Cookie: "s9_test_team=giants" } }),
      env: { SITE_ENVIRONMENT: "production", STARTING9_AUTH_ORIGIN: TARGET_ORIGIN } });
    await onRequest({ request: new Request("https://s9simu.pages.dev/api/public/games", { headers: { Cookie: "s9_test_team=marines; s9_test_source=simu-npb" } }),
      env: { SITE_ENVIRONMENT: "test", STARTING9_AUTH_ORIGIN: "https://starting9-test-auth.starting9.workers.dev" } });
    assert.equal(requests[0], "https://starting9-test-auth.starting9.workers.dev/api/public/games?testTeam=giants");
    assert.equal(requests[1], `${TARGET_ORIGIN}/api/public/games`);
    assert.equal(requests[2], "https://starting9-test-auth.starting9.workers.dev/api/public/games?testTeam=marines&simuNpb=1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid Test Site team fails closed before contacting the Worker", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error("unexpected upstream call"); };
  try {
    const response = await onRequest({
      request: new Request("https://starting9-test.pages.dev/api/public/games?testTeam=unknown"),
      env: { SITE_ENVIRONMENT: "test", STARTING9_AUTH_ORIGIN: "https://starting9-test-auth.starting9.workers.dev" }
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_TEST_TEAM");
    assert.equal(fetchCalled, false);
  } finally { globalThis.fetch = originalFetch; }
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
