const test = require("node:test");
const assert = require("node:assert/strict");

const {
  mergeDiagnosticEvents,
  parseTailRecord
} = require("../tooling/auth-diagnostic-tail-parser.cjs");

const pagesEvent = {
  scope: "asia-cs-auth-diagnostic",
  phase: "pages",
  diagnosticId: "ray-1",
  requestPath: "/api/asia-cs/auth/me",
  hasSessionCookie: false,
  sessionCookieCount: 0,
  cookie: "must-not-escape"
};

test("decodes the double-encoded Cloudflare tail event and projects safe fields", () => {
  const event = parseTailRecord(JSON.stringify(JSON.stringify(pagesEvent)));
  assert.deepEqual(event, {
    scope: "asia-cs-auth-diagnostic",
    phase: "pages",
    diagnosticId: "ray-1",
    requestPath: "/api/asia-cs/auth/me",
    hasSessionCookie: false,
    sessionCookieCount: 0
  });
});

test("supports direct, SSE, and nested log envelopes", () => {
  const direct = parseTailRecord(JSON.stringify(pagesEvent));
  const sse = parseTailRecord(`data: ${JSON.stringify(pagesEvent)}`);
  const nested = parseTailRecord(JSON.stringify({ logs: [JSON.stringify(pagesEvent)] }));
  assert.equal(direct.diagnosticId, "ray-1");
  assert.equal(sse.diagnosticId, "ray-1");
  assert.equal(nested.diagnosticId, "ray-1");
});

test("ignores unrelated, malformed, and unsafe field values", () => {
  assert.equal(parseTailRecord(JSON.stringify({ scope: "other", username: "alice" })), null);
  assert.equal(parseTailRecord("not-json"), null);
  const event = parseTailRecord(JSON.stringify({
    ...pagesEvent,
    hasSessionCookie: "true",
    sessionCookieCount: 100,
    authUpstreamStatus: "200",
    username: "alice",
    userId: "secret-user-id",
    authorization: "Bearer secret"
  }));
  assert.deepEqual(event, {
    scope: "asia-cs-auth-diagnostic",
    phase: "pages",
    diagnosticId: "ray-1",
    requestPath: "/api/asia-cs/auth/me"
  });
  assert.equal(JSON.stringify(event).includes("secret"), false);
});

test("merges Pages and Asia CS events by correlation id without mixing requests", () => {
  const events = mergeDiagnosticEvents([
    parseTailRecord(JSON.stringify({ ...pagesEvent, diagnosticId: "ray-1" })),
    parseTailRecord(JSON.stringify({
      scope: "asia-cs-auth-diagnostic",
      phase: "asia_cs_worker",
      diagnosticId: "ray-1",
      hasSessionCookie: false,
      sessionCookieCount: 0,
      authUpstreamReached: false,
      finalAuthenticated: false,
      finalIsAdmin: false
    })),
    parseTailRecord(JSON.stringify({ ...pagesEvent, diagnosticId: "ray-2" }))
  ]);
  assert.equal(events.length, 2);
  const first = events.find((event) => event.diagnosticId === "ray-1");
  assert.equal(first.phase, "asia_cs_worker");
  assert.equal(first.authUpstreamReached, false);
  assert.equal(events.find((event) => event.diagnosticId === "ray-2").phase, "pages");
});
