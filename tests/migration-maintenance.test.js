import test from "node:test";
import assert from "node:assert/strict";
import worker from "../auth-worker.js";

const maintenanceEnv = { MIGRATION_MAINTENANCE: "true" };

async function readJson(response) {
  return response.json();
}

test("migration maintenance blocks authentication and prediction mutations before D1 access", async () => {
  for (const [path, method] of [
    ["/api/auth/login", "POST"],
    ["/api/predictions/current", "PUT"],
    ["/api/admin/push/subscribe", "POST"],
    ["/api/admin/v3/manual-roster", "PUT"]
  ]) {
    const response = await worker.fetch(new Request(`https://starting9.test${path}`, { method }), maintenanceEnv, {});
    assert.equal(response.status, 503, path);
    assert.equal((await readJson(response)).code, "MIGRATION_MAINTENANCE", path);
  }
});

test("migration maintenance blocks auth/me because it updates session activity", async () => {
  const response = await worker.fetch(
    new Request("https://starting9.test/api/auth/me", {
      headers: { Cookie: "s9_session=opaque-token" }
    }),
    maintenanceEnv,
    { waitUntil() { throw new Error("maintenance must not schedule a write"); } }
  );

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).code, "MIGRATION_MAINTENANCE");
});

test("migration maintenance keeps health available without a database binding", async () => {
  const response = await worker.fetch(
    new Request("https://starting9.test/health"),
    maintenanceEnv,
    {}
  );

  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).ok, true);
});

test("migration maintenance scheduled handler exits before heartbeat or audit writes", async () => {
  let waitUntilCalls = 0;
  const result = await worker.scheduled(
    { cron: "* * * * *", scheduledTime: Date.parse("2026-10-01T00:00:00.000Z") },
    { ...maintenanceEnv, AUTH_DB: { prepare() { throw new Error("D1 must not be accessed"); } } },
    { waitUntil() { waitUntilCalls += 1; } }
  );

  assert.deepEqual(result, {
    ok: true,
    cronMode: "critical",
    skipped: true,
    reasonCode: "MIGRATION_MAINTENANCE"
  });
  assert.equal(waitUntilCalls, 0);
});
