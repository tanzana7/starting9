import test from "node:test";
import assert from "node:assert/strict";
import { onRequest, resolveAuthWorkerOrigin } from "../functions/api/[[path]].js";

const SOURCE_ORIGIN = "https://starting9-auth.tanzana7.workers.dev";
const TARGET_ORIGIN = "https://starting9-auth.starting9.workers.dev";

test("Pages proxy defaults to SOURCE and accepts only the controlled TARGET origin", () => {
  assert.equal(resolveAuthWorkerOrigin(), SOURCE_ORIGIN);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: TARGET_ORIGIN }), TARGET_ORIGIN);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: "https://untrusted.example" }), SOURCE_ORIGIN);
  assert.equal(resolveAuthWorkerOrigin({ STARTING9_AUTH_ORIGIN: `${TARGET_ORIGIN}/` }), TARGET_ORIGIN);
});

test("Pages proxy preserves response and normalizes same-origin cookies for SOURCE rollback", async () => {
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
