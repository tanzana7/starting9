import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fakeDatabase() {
  return {
    prepare() {
      return {
        bind() {
          return { async run() { return { meta: { changes: 1 } }; } };
        }
      };
    }
  };
}

function captureDiagnostics() {
  const originalInfo = console.info;
  const entries = [];
  console.info = (...args) => entries.push(args.join(" "));
  return {
    entries,
    restore() { console.info = originalInfo; }
  };
}

async function runAuth(worker, env, cookie, fetchImpl) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const captured = captureDiagnostics();
  try {
    const response = await worker.default.fetch(new Request("https://asia-cs.test/api/auth/me", {
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        "X-S9-Auth-Diagnostic-Id": "reason-test"
      }
    }), env, {});
    return {
      response,
      diagnostic: captured.entries.map((entry) => JSON.parse(entry)).at(-1)
    };
  } finally {
    captured.restore();
    globalThis.fetch = originalFetch;
  }
}

test("auth diagnosticsはsession tokenなしをfetch前に分類する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs", "worker.js")).href);
  let fetchCalls = 0;
  const result = await runAuth(worker, {
    DB: fakeDatabase(),
    ASIA_CS_ENV: "production",
    STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev"
  }, "", async () => {
    fetchCalls += 1;
    return new Response("unused");
  });

  assert.equal(result.response.status, 200);
  assert.equal(fetchCalls, 0);
  assert.equal(result.diagnostic.authFailureReason, "EMPTY_SESSION_TOKEN");
  assert.equal(result.diagnostic.authFetchAttempted, false);
  assert.equal(result.diagnostic.authUpstreamReached, false);
  assert.equal(result.diagnostic.finalAuthenticated, false);
});

test("auth diagnosticsは許可外originをfetch前に分類する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs", "worker.js")).href);
  let fetchCalls = 0;
  const result = await runAuth(worker, {
    DB: fakeDatabase(),
    ASIA_CS_ENV: "production",
    STARTING9_AUTH_BASE_URL: "https://auth.attacker.example"
  }, "s9_session=opaque-token", async () => {
    fetchCalls += 1;
    return new Response("unused");
  });

  assert.equal(result.response.status, 200);
  assert.equal(fetchCalls, 0);
  assert.equal(result.diagnostic.authFailureReason, "AUTH_ORIGIN_REJECTED");
  assert.equal(result.diagnostic.authFetchAttempted, false);
  assert.equal(result.diagnostic.authUpstreamReached, false);
});

test("auth diagnosticsはfetch失敗とtimeoutを区別し、Response未取得を記録する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs", "worker.js")).href);
  const env = {
    DB: fakeDatabase(),
    ASIA_CS_ENV: "test",
    AUTH_UPSTREAM_TIMEOUT_MS: "5",
    STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev"
  };
  const failed = await runAuth(worker, env, "s9_session=opaque-token", async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(failed.diagnostic.authFailureReason, "AUTH_FETCH_FAILED");
  assert.equal(failed.diagnostic.authFetchAttempted, true);
  assert.equal(failed.diagnostic.authUpstreamReached, false);

  const timedOut = await runAuth(worker, env, "s9_session=opaque-token", async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  assert.equal(timedOut.diagnostic.authFailureReason, "AUTH_UPSTREAM_TIMEOUT");
  assert.equal(timedOut.diagnostic.authFetchAttempted, true);
  assert.equal(timedOut.diagnostic.authUpstreamReached, false);
});

test("auth diagnosticsはanonymous responseとvalid identity responseを区別する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs", "worker.js")).href);
  const env = {
    DB: fakeDatabase(),
    ASIA_CS_ENV: "production",
    STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev",
    ASIA_CS_ADMIN_USER_IDS: "external-user"
  };
  const anonymous = await runAuth(worker, env, "s9_session=opaque-token", async () => new Response(
    JSON.stringify({ ok: true, authenticated: false, user: null }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  ));
  assert.equal(anonymous.diagnostic.authFailureReason, "AUTH_UPSTREAM_ANONYMOUS");
  assert.equal(anonymous.diagnostic.authFetchAttempted, true);
  assert.equal(anonymous.diagnostic.authUpstreamReached, true);
  assert.equal(anonymous.diagnostic.authUpstreamStatus, 200);
  assert.equal(anonymous.diagnostic.finalAuthenticated, false);

  const authenticated = await runAuth(worker, env, "s9_session=opaque-token", async () => new Response(
    JSON.stringify({ ok: true, authenticated: true, user: { id: "external-user", username: "alice" } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  ));
  assert.equal(authenticated.diagnostic.authFailureReason, "NONE");
  assert.equal(authenticated.diagnostic.authFetchAttempted, true);
  assert.equal(authenticated.diagnostic.authUpstreamReached, true);
  assert.equal(authenticated.diagnostic.authUpstreamStatus, 200);
  assert.equal(authenticated.diagnostic.authUpstreamAuthenticated, true);
  assert.equal(authenticated.diagnostic.authUpstreamUserPresent, true);
  assert.equal(authenticated.diagnostic.authUpstreamUserIdTypeValid, true);
  assert.equal(authenticated.diagnostic.finalAuthenticated, true);
  assert.equal(authenticated.diagnostic.finalIsAdmin, true);
});

test("auth diagnosticsのreason logにはtoken・identity・response bodyを含めない", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs", "worker.js")).href);
  const originalInfo = console.info;
  const entries = [];
  console.info = (...args) => entries.push(args.join(" "));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    authenticated: true,
    user: { id: "secret-user-id", username: "secret-user" },
    token: "secret-response-token"
  }), { status: 200 });
  try {
    await worker.default.fetch(new Request("https://asia-cs.test/api/auth/me", {
      headers: { Cookie: "s9_session=secret-cookie-token", "X-S9-Auth-Diagnostic-Id": "safe-reason" }
    }), {
      DB: fakeDatabase(),
      ASIA_CS_ENV: "production",
      STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev"
    }, {});
  } finally {
    console.info = originalInfo;
    globalThis.fetch = originalFetch;
  }
  const logText = entries.join("\n");
  assert.doesNotMatch(logText, /secret-cookie-token|secret-user-id|secret-user|secret-response-token/);
  assert.match(logText, /authFailureReason/);
  assert.match(logText, /authFetchAttempted/);
});
