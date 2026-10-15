import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createDb() {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() { return null; },
            async all() { return { results: [] }; },
            async run() { return { meta: { changes: 1 } }; }
          };
        }
      };
    }
  };
}

function request(worker, env, path, options = {}) {
  return worker.default.fetch(new Request(`https://asia-cs.test${path}`, options), env, {});
}

function authEnv(users, adminIds) {
  return {
    DB: createDb(),
    ASIA_CS_LOCAL_AUTH: "false",
    ASIA_CS_ENV: "test",
    ASIA_CS_ALLOW_LEGACY_AUTH: "true",
    ALLOWED_ORIGIN: "https://asia-cs.test",
    ...(adminIds === undefined ? {} : { ASIA_CS_ADMIN_USER_IDS: adminIds }),
    AUTH_VERIFY: async (request) => users[request.headers.get("Cookie")] || null
  };
}

test("Asia CS admin authorization uses a trimmed, duplicate-safe user ID allowlist", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const users = {
    "s9_session=admin": { id: "test-admin-user", username: "renamed-admin", role: "user" },
    "s9_session=normal": { id: "test-normal-user", username: "renamed-admin", role: "admin" }
  };
  const env = authEnv(users, " test-admin-user, test-admin-user ");

  const admin = await request(worker, env, "/api/admin/teams?competitionId=asia-cs", { headers: { Cookie: "s9_session=admin" } });
  assert.equal(admin.status, 200);

  const normal = await request(worker, env, "/api/admin/teams?userId=test-admin-user", { headers: { Cookie: "s9_session=normal" } });
  assert.equal(normal.status, 403);
  assert.equal((await normal.json()).code, "ADMIN_REQUIRED");
});

test("unauthenticated, missing allowlist, and malformed allowlist values fail closed", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const users = { "s9_session=admin": { id: "test-admin-user", username: "admin", role: "admin" } };

  const unauthenticated = await request(worker, authEnv(users, "test-admin-user"), "/api/admin/teams?competitionId=asia-cs");
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).code, "AUTH_REQUIRED");

  const missing = await request(worker, authEnv(users), "/api/admin/teams?competitionId=asia-cs", { headers: { Cookie: "s9_session=admin" } });
  assert.equal(missing.status, 403);

  const empty = await request(worker, authEnv(users, ""), "/api/admin/teams?competitionId=asia-cs", { headers: { Cookie: "s9_session=admin" } });
  assert.equal(empty.status, 403);

  const malformed = await request(worker, authEnv(users, "[not-json"), "/api/admin/teams?competitionId=asia-cs", { headers: { Cookie: "s9_session=admin" } });
  assert.equal(malformed.status, 403);
});

test("auth/me exposes only the server-derived admin flag", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const users = { "s9_session=admin": { id: "test-admin-user", username: "admin", role: "user" } };
  const env = authEnv(users, '["test-admin-user"]');
  const response = await request(worker, env, "/api/auth/me", {
    headers: { Cookie: "s9_session=admin", "X-User-Id": "attacker" }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    authenticated: true,
    isAdmin: true,
    user: { id: "test-admin-user", username: "admin", role: "user" }
  });
});

test("allowlist parser supports JSON arrays and rejects empty or invalid IDs", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  assert.deepEqual([...worker.parseAsiaCsAdminUserIds('["admin-a", 123, null, {}, ["admin-b"], "admin-c"]')], ["admin-a", "admin-c"]);
  assert.deepEqual([...worker.parseAsiaCsAdminUserIds('["test-admin-user", "", "test-admin-user", "bad id"]')], ["test-admin-user"]);
  assert.deepEqual([...worker.parseAsiaCsAdminUserIds(" , ")], []);
  assert.equal(worker.isAsiaCsAdmin({ id: "test-admin-user", role: "admin" }, { ASIA_CS_ENV: "production" }), false);
  assert.equal(worker.isAsiaCsAdmin({ id: "test-admin-user", role: "admin" }, { ASIA_CS_ENV: "test", ASIA_CS_LOCAL_AUTH: "true" }), true);
  assert.equal(worker.isAsiaCsAdmin({ id: "test-admin-user", role: "admin" }, { ASIA_CS_ENV: "production", ASIA_CS_LOCAL_AUTH: "true" }), false);
  assert.equal(worker.isAsiaCsAdmin({ id: "test-admin-user", role: "admin" }, { ASIA_CS_LOCAL_AUTH: "true" }), false);
});

test("only primitive string identities can pass the management API allowlist", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const invalidIds = [
    ["test-admin-user"],
    { 0: "test-admin-user" },
    { id: "test-admin-user" },
    123,
    true,
    null,
    undefined,
    new String("test-admin-user")
  ];

  for (const id of invalidIds) {
    const env = authEnv({ "s9_session=spoof": { id, username: "admin", role: "admin" } }, "test-admin-user");
    const response = await request(worker, env, "/api/admin/teams?competitionId=asia-cs", { headers: { Cookie: "s9_session=spoof" } });
    assert.ok([401, 403].includes(response.status), `non-string id must be denied: ${Object.prototype.toString.call(id)}`);
  }

  const valid = await request(worker, authEnv({ "s9_session=valid": { id: "test-admin-user", username: "renamed", role: "user" } }, "test-admin-user"), "/api/admin/teams?competitionId=asia-cs", { headers: { Cookie: "s9_session=valid" } });
  assert.equal(valid.status, 200);

  const nonAdmin = await request(worker, authEnv({ "s9_session=user": { id: "test-normal-user", username: "admin", role: "admin" } }, "test-admin-user"), "/api/admin/teams?competitionId=asia-cs", { headers: { Cookie: "s9_session=user" } });
  assert.equal(nonAdmin.status, 403);
});
