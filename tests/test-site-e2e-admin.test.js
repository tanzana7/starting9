import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createTestTeamWorker } from "../tooling/test-site/worker.js";
import { simulatorGameDate } from "../tooling/test-site/simu-npb/source.js";

let requestNumber = 0;

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bind = (...args) => ({
        all: async () => ({ results: statement.all(...args) }),
        first: async () => statement.get(...args),
        run: async () => ({ meta: { changes: Number(statement.run(...args).changes || 0) } })
      });
      return { ...bind(), bind };
    },
    async batch(statements) {
      return statements.map((statement) => statement.run());
    }
  };
}

async function fixture() {
  const database = new DatabaseSync(":memory:");
  const audit = new DatabaseSync(":memory:");
  for (const [directory, target] of [["migrations", database], ["migrations-audit", audit]]) {
    const root = new URL(`../${directory}/`, import.meta.url);
    for (const name of fs.readdirSync(root).filter((entry) => entry.endsWith(".sql")).sort()) {
      target.exec(fs.readFileSync(new URL(name, root), "utf8"));
    }
  }
  const config = JSON.parse(fs.readFileSync(new URL("../wrangler.test-auth.jsonc", import.meta.url)));
  const env = { ...config.vars, TEST_E2E_SETUP_TOKEN: "test-only-random-token-for-unit-tests", AUTH_DB: d1(database), AUDIT_DB: d1(audit) };
  async function request(path, { method = "GET", body, token = env.TEST_E2E_SETUP_TOKEN, cookie = "" } = {}) {
    requestNumber += 1;
    if (body?.action === "provision" && !body.runId) {
      body = { ...body, runId: requestNumber.toString(16).padStart(12, "0") };
    }
    const headers = {
      Origin: "https://s9simu.pages.dev",
      "Content-Type": "application/json",
      "CF-Connecting-IP": `198.51.100.${10 + (requestNumber % 200)}`
    };
    if (token) headers["X-Test-E2E-Token"] = token;
    if (cookie) headers.Cookie = cookie;
    const response = await createTestTeamWorker("fighters").fetch(new Request(`https://starting9-test-auth.internal${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    }), env, { waitUntil() {} });
    return { response, payload: await response.json() };
  }
  return { database, audit, env, request };
}

test("E2E admin provisioning uses ordinary registration/login, then cleanup removes only its disposable identity", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });

  const denied = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" }, token: "wrong-token" });
  assert.equal(denied.response.status, 404);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);

  const provisioned = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(provisioned.response.status, 201);
  assert.match(provisioned.payload.username, /^e2e-[a-f0-9]{12}$/);
  const cookie = (provisioned.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  assert.match(cookie, /^s9_session=/);

  const auth = await f.request("/api/auth/me", { cookie });
  assert.equal(auth.payload.authenticated, true);
  assert.equal(auth.payload.user.username, provisioned.payload.username);
  const admin = await f.request("/api/admin/me", { cookie });
  assert.equal(admin.response.status, 200);
  assert.equal(admin.payload.admin, true);
  const operation = await f.request("/api/test/scenario", { method: "POST", body: { scenario: "no-game" }, cookie });
  assert.equal(operation.response.status, 200);

  const temporary = f.database.prepare("SELECT id, role FROM users WHERE username = ?").get(provisioned.payload.username);
  assert.equal(temporary.role, "admin");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(temporary.id).count, 2);

  const cleaned = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "cleanup" }, cookie });
  assert.equal(cleaned.response.status, 200);
  assert.equal(cleaned.payload.removed, true);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
});

test("simulator schedule control reports the shared NPB fixture date", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });
  f.env.ENABLE_GAME_AUTOMATION_V3 = "false";

  const provisioned = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(provisioned.response.status, 201);
  const cookie = (provisioned.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const schedule = await f.request("/api/test/simu/schedule", { method: "POST", body: {}, cookie });
  assert.equal(schedule.response.status, 200);
  assert.equal(schedule.payload.date, simulatorGameDate());
  assert.equal(schedule.payload.physicalGames.length, 0);

  const cleanup = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup" }, cookie
  });
  assert.equal(cleanup.response.status, 200);
  assert.equal(cleanup.payload.removed, true);
});

test("normal synthetic user cannot operate scenario controls", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });
  const register = await f.request("/api/auth/register", {
    method: "POST", body: { username: "e2e-normal", password: "Synthetic-Password-2026", passwordConfirmation: "Synthetic-Password-2026" }, token: ""
  });
  assert.equal(register.response.status, 201);
  const cookie = (register.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const before = f.database.prepare("SELECT COUNT(*) AS count FROM games").get().count;
  const result = await f.request("/api/test/scenario", { method: "POST", body: { scenario: "no-game" }, token: "", cookie });
  assert.equal(result.response.status, 401);
  assert.equal(result.payload.code, "ADMIN_REQUIRED");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games").get().count, before);
});

test("successful simulator cleanup can revoke admin access while retaining its ranking identity", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });

  const provisioned = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(provisioned.response.status, 201);
  const cookie = (provisioned.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const identity = f.database.prepare("SELECT id FROM users WHERE username = ?").get(provisioned.payload.username);
  assert.ok(identity?.id);

  const retained = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup", preserveUser: true }, cookie
  });
  assert.equal(retained.response.status, 200);
  assert.equal(retained.payload.retainedAsUser, true);
  const user = f.database.prepare("SELECT role FROM users WHERE id = ?").get(identity.id);
  assert.equal(user.role, "user");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(identity.id).count, 0);
});

test("E2E admin endpoint is disabled when the trusted test database identity is wrong", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });
  f.env.TEST_AUTH_DB_ID = "unknown-db-id";
  const result = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(result.response.status, 404);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("E2E admin endpoint is unavailable in production runtime", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });
  f.env.ENVIRONMENT = "production";
  const result = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(result.response.status, 404);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("a session whose disposable admin role is missing cannot clean up as an admin", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });
  const setup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  const cookie = (setup.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const username = setup.payload.username;
  f.database.prepare("UPDATE users SET role = 'user' WHERE username = ?").run(username);
  const cleanup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "cleanup" }, cookie });
  assert.equal(cleanup.response.status, 403);
  assert.equal(cleanup.payload.code, "E2E_ADMIN_REQUIRED");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = ?").get(username).count, 1);
});

test("token-only cleanup is limited to the route's reserved random E2E identity", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });
  const setup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  const username = setup.payload.username;
  const cleaned = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup", username }, cookie: ""
  });
  assert.equal(cleaned.response.status, 200);
  assert.equal(cleaned.payload.removed, true);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);

  const ordinary = await f.request("/api/auth/register", {
    method: "POST", body: { username: "e2e-normal", password: "Synthetic-Password-2026", passwordConfirmation: "Synthetic-Password-2026" }, token: ""
  });
  assert.equal(ordinary.response.status, 201);
  const denied = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup", username: "e2e-normal" }
  });
  assert.equal(denied.response.status, 403);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = 'e2e-normal'").get().count, 1);
});

test("token-only cleanup is idempotent when a provision response was lost before account creation", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });
  const cleaned = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup", username: "e2e-abcdef012345" }
  });
  assert.equal(cleaned.response.status, 200);
  assert.equal(cleaned.payload.alreadyAbsent, true);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("cleanup rejects a non-E2E admin before revoking or deleting its session", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });
  const setup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(setup.response.status, 201);
  assert.match(setup.payload.username, /^e2e-[a-f0-9]{12}$/);
  const cookie = (setup.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const row = f.database.prepare("SELECT id FROM users WHERE username = ?").get(setup.payload.username);
  assert.ok(row);
  const id = row.id;
  f.database.prepare("UPDATE users SET username = 'test-existing-admin', username_normalized = 'test-existing-admin' WHERE id = ?").run(id);
  const sessionsBefore = f.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(id).count;

  const cleanup = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup", username: "test-existing-admin" }, cookie
  });
  assert.equal(cleanup.response.status, 403);
  assert.equal(cleanup.payload.code, "E2E_ADMIN_REQUIRED");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users WHERE id = ?").get(id).count, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(id).count, sessionsBefore);
});

test("public test registration cannot claim the disposable E2E admin namespace", async (t) => {
  const f = await fixture();
  t.after(() => { f.database.close(); f.audit.close(); });
  const result = await f.request("/api/auth/register", {
    method: "POST", token: "",
    body: { username: "e2e-0123456789ab", password: "Synthetic-Password-2026", passwordConfirmation: "Synthetic-Password-2026" }
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.code, "TEST_USERNAME_RESERVED");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("Team B fixture absence is rejected instead of falling back to Team A", async () => {
  assert.throws(() => createTestTeamWorker("missing-team"), /Unknown test target team/);
});
