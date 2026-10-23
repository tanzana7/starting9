import test from "node:test";
import assert from "node:assert/strict";
import { authorizeTestAdmin } from "../tooling/test-site/pages-project/functions/simu-admin-auth.js";

const TEST_ORIGIN = "https://starting9-test-auth.starting9.workers.dev";

test("lineup editor admin authorization fails closed outside the isolated Test Site", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; return Response.json({ ok: true, admin: true }); };
  try {
    const result = await authorizeTestAdmin(new Request("https://s9simu.pages.dev/", {
      headers: { Cookie: "s9_session=fake-test-session" }
    }), { SITE_ENVIRONMENT: "production", STARTING9_AUTH_ORIGIN: TEST_ORIGIN });
    assert.deepEqual(result, { ok: false, code: "TEST_ENVIRONMENT_REQUIRED", status: 503 });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lineup editor authorization reuses the browser session only against the fixed Test Auth admin endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl;
  let seenCookie;
  globalThis.fetch = async (request) => {
    seenUrl = new URL(request.url);
    seenCookie = request.headers.get("Cookie");
    assert.equal(request.method, "GET");
    return Response.json({ ok: true, admin: true });
  };
  try {
    const result = await authorizeTestAdmin(new Request("https://s9simu.pages.dev/simu-npb/api/lineups/g-t-1", {
      headers: { Cookie: "other=value; s9_session=fake-test-session; theme=dark" }
    }), { SITE_ENVIRONMENT: "test", STARTING9_AUTH_ORIGIN: TEST_ORIGIN });
    assert.deepEqual(result, { ok: true });
    assert.equal(seenUrl.origin, TEST_ORIGIN);
    assert.equal(seenUrl.pathname, "/api/admin/me");
    assert.equal(seenCookie, "s9_session=fake-test-session");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lineup editor authorization rejects missing sessions, non-admin sessions, and auth outages", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ ok: true, admin: false });
  };
  try {
    const env = { SITE_ENVIRONMENT: "test", STARTING9_AUTH_ORIGIN: TEST_ORIGIN };
    const missing = await authorizeTestAdmin(new Request("https://s9simu.pages.dev/"), env);
    assert.deepEqual(missing, { ok: false, code: "ADMIN_REQUIRED", status: 401 });
    assert.equal(calls, 0);

    const nonAdmin = await authorizeTestAdmin(new Request("https://s9simu.pages.dev/", {
      headers: { Cookie: "s9_session=fake-test-session" }
    }), env);
    assert.deepEqual(nonAdmin, { ok: false, code: "ADMIN_ROLE_REQUIRED", status: 403 });

    globalThis.fetch = async () => { throw new Error("simulated auth outage"); };
    const unavailable = await authorizeTestAdmin(new Request("https://s9simu.pages.dev/", {
      headers: { Cookie: "s9_session=fake-test-session" }
    }), env);
    assert.deepEqual(unavailable, { ok: false, code: "TEST_AUTH_UNAVAILABLE", status: 503 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
