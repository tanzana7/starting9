import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagesSource = fs.readFileSync(path.join(root, "functions", "api", "[[path]].js"), "utf8");
const asiaSource = fs.readFileSync(path.join(root, "asia-cs", "worker.js"), "utf8");

function captureInfo() {
  const original = console.info;
  const entries = [];
  console.info = (...args) => entries.push(args.join(" "));
  return {
    entries,
    restore() { console.info = original; }
  };
}

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

test("production diagnosticsはPagesでCookie値を記録せず、0/1/複数を区別する", async () => {
  const { onRequest } = await import(pathToFileURL(path.join(root, "functions", "api", "[[path]].js")).href);
  const originalFetch = globalThis.fetch;
  const captured = captureInfo();
  const requests = [];
  globalThis.fetch = async (request) => {
    requests.push(request);
    return new Response(JSON.stringify({ ok: true, authenticated: false, user: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    for (const cookie of ["", "s9_session=probe-one", "s9_session=probe-one; s9_session=probe-two"]) {
      await onRequest({
        request: new Request("https://starting9.pages.dev/api/asia-cs/auth/me", { headers: cookie ? { Cookie: cookie } : {} }),
        env: { ASIA_CS_API_ORIGIN: "https://starting9-asia-cs-api.starting9.workers.dev" }
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    captured.restore();
  }

  assert.equal(requests.length, 3);
  const diagnostics = captured.entries.map((entry) => JSON.parse(entry));
  assert.deepEqual(diagnostics.map((entry) => entry.sessionCookieCount), [0, 1, 2]);
  assert.deepEqual(diagnostics.map((entry) => entry.hasSessionCookie), [false, true, true]);
  assert.ok(diagnostics.every((entry) => entry.phase === "pages"));
  const logText = captured.entries.join("\n");
  assert.doesNotMatch(logText, /probe-one|probe-two|Cookie:/);
  assert.match(pagesSource, /sessionCookieCount/);
  assert.match(pagesSource, /hasSessionCookie/);
});

test("production diagnosticsはAsia CSでupstream到達・応答・最終認証を値なしで記録する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs", "worker.js")).href);
  const originalFetch = globalThis.fetch;
  const captured = captureInfo();
  const responses = [
    new Response(JSON.stringify({ ok: true, authenticated: true, user: { id: "external-user", username: "alice" } }), { status: 200 }),
    new Response(JSON.stringify({ ok: true, authenticated: false, user: null }), { status: 200 })
  ];
  globalThis.fetch = async () => responses.shift();
  const env = {
    DB: fakeDatabase(),
    ASIA_CS_ENV: "production",
    ASIA_CS_LOCAL_AUTH: "false",
    STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev",
    ASIA_CS_ADMIN_USER_IDS: "external-user"
  };

  try {
    const authenticated = await worker.default.fetch(new Request("https://asia-cs.test/api/auth/me", {
      headers: {
        Cookie: "s9_session=probe-one",
        "X-S9-Auth-Diagnostic-Id": "diagnostic-one"
      }
    }), env, {});
    const anonymous = await worker.default.fetch(new Request("https://asia-cs.test/api/auth/me", {
      headers: {
        Cookie: "s9_session=probe-one; s9_session=probe-two",
        "X-S9-Auth-Diagnostic-Id": "diagnostic-two"
      }
    }), env, {});
    assert.deepEqual(await authenticated.json(), { ok: true, authenticated: true, isAdmin: true, user: { id: "external-user", username: "alice", role: "user" } });
    assert.deepEqual(await anonymous.json(), { ok: true, authenticated: false, isAdmin: false, user: null });
  } finally {
    globalThis.fetch = originalFetch;
    captured.restore();
  }

  const diagnostics = captured.entries.map((entry) => JSON.parse(entry));
  assert.deepEqual(diagnostics.map((entry) => entry.sessionCookieCount), [1, 2]);
  assert.deepEqual(diagnostics.map((entry) => entry.authUpstreamReached), [true, true]);
  assert.deepEqual(diagnostics.map((entry) => entry.authUpstreamStatus), [200, 200]);
  assert.deepEqual(diagnostics.map((entry) => entry.authUpstreamAuthenticated), [true, false]);
  assert.deepEqual(diagnostics.map((entry) => entry.authUpstreamUserPresent), [true, false]);
  assert.deepEqual(diagnostics.map((entry) => entry.authUpstreamUserIdTypeValid), [true, false]);
  assert.deepEqual(diagnostics.map((entry) => entry.finalAuthenticated), [true, false]);
  assert.deepEqual(diagnostics.map((entry) => entry.finalIsAdmin), [true, false]);
  const logText = captured.entries.join("\n");
  assert.doesNotMatch(logText, /probe-one|probe-two|external-user|alice|Cookie:/);
  assert.match(asiaSource, /authUpstreamUserIdTypeValid/);
  assert.match(asiaSource, /finalIsAdmin/);
});
