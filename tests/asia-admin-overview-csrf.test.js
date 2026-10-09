import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAuthBridgeAssertion, sha256Base64Url, verifyAuthBridgeAssertion } from "../backend/auth-bridge.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = [
  "0001_asia_cs_mvp.sql",
  "0002_competition_and_formal_jobs.sql",
  "0003_review_hardening.sql",
  "0004_ranking-generation-snapshots.sql",
  "0005_publication-revision.sql",
  "0006_phase2-product.sql",
  "0007_phase2-roster-metadata.sql"
].map((file) => fs.readFileSync(path.join(root, "asia-cs/migrations", file), "utf8")).join("\n");

function createD1Adapter(database) {
  const wrap = (statement, values = []) => ({
    bind(...nextValues) { return wrap(statement, nextValues); },
    async first() { return statement.get(...values) || null; },
    async all() { return { results: statement.all(...values) }; },
    async run() { const result = statement.run(...values); return { meta: { changes: result.changes } }; },
    _execute() { statement.run(...values); }
  });
  return {
    prepare(sql) { return wrap(database.prepare(sql)); },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        statements.forEach((statement) => statement._execute());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
}

function createFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  database.prepare(`
    INSERT INTO competitions
      (id, competition_type, display_name, short_name, start_date, end_date, status, description, created_at, updated_at)
    VALUES ('apbc-2026', 'ASIA_CS', 'APBC 2026', 'APBC26', '2026-11-12', '2026-11-15', 'draft', 'test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  return {
    database,
    DB: createD1Adapter(database),
    ASIA_CS_ENV: "production",
    STARTING9_AUTH_BASE_URL: "https://starting9-auth.starting9.workers.dev",
    ASIA_CS_AUTH_BRIDGE_SECRET: "test-only-bridge-secret"
  };
}

async function signedRequest(worker, env, { method = "GET", pathName = "/api/admin/overview?competitionId=apbc-2026", role = "admin", csrfValidated = false, body = "" } = {}) {
  const [path, query = ""] = pathName.split("?");
  const queryString = query ? `?${query}` : "";
  const assertion = await createAuthBridgeAssertion({
    secret: env.ASIA_CS_AUTH_BRIDGE_SECRET,
    user: { id: role === "admin" ? "admin-1" : "user-1", username: role, role },
    method,
    path,
    query: queryString,
    bodyDigest: await sha256Base64Url(body),
    csrfValidated
  });
  if (csrfValidated || ["GET", "HEAD"].includes(method)) {
    assert.ok(await verifyAuthBridgeAssertion(assertion, {
      secret: env.ASIA_CS_AUTH_BRIDGE_SECRET,
      method,
      path,
      query: queryString,
      bodyDigest: await sha256Base64Url(["GET", "HEAD"].includes(method) ? new Uint8Array() : body),
      requireCsrf: !["GET", "HEAD"].includes(method)
    }));
  }
  const response = await worker.default.fetch(new Request(`https://asia-cs.test${pathName}`, {
    method,
    headers: { "X-S9-Auth-Bridge": assertion, "Content-Type": "application/json" },
    body: ["GET", "HEAD"].includes(method) ? undefined : body
  }), env, {});
  return { response, payload: await response.json() };
}

test("外部admin bridgeのread-only overview GETはCSRF contextなしで許可する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  const result = await signedRequest(worker, env);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.competition.id, "apbc-2026");
});

test("anonymousとnon-adminのoverview GETは引き続き拒否する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  const anonymous = await worker.default.fetch(new Request("https://asia-cs.test/api/admin/overview?competitionId=apbc-2026"), env, {});
  assert.equal(anonymous.status, 401);
  const nonAdmin = await signedRequest(worker, env, { role: "user" });
  assert.equal(nonAdmin.response.status, 403, JSON.stringify(nonAdmin.payload));
  assert.equal(nonAdmin.payload.code, "ADMIN_REQUIRED");
});

test("mutationはcsrf contextなしを拒否し、有効なcsrf付きadmin mutationは許可する", async () => {
  const worker = await import(pathToFileURL(path.join(root, "asia-cs/worker.js")).href);
  const env = createFixture();
  const blocked = await signedRequest(worker, env, {
    method: "POST",
    pathName: "/api/admin/teams",
    csrfValidated: false,
    body: JSON.stringify({ competitionId: "apbc-2026", teamKey: "jpn", displayName: "Japan", shortName: "JPN" })
  });
  assert.equal(blocked.response.status, 401);
  assert.equal(blocked.payload.code, "AUTH_REQUIRED");

  const allowed = await signedRequest(worker, env, {
    method: "POST",
    pathName: "/api/admin/teams",
    csrfValidated: true,
    body: JSON.stringify({ competitionId: "apbc-2026", teamKey: "jpn", displayName: "Japan", shortName: "JPN" })
  });
  assert.equal(allowed.response.status, 201);
  assert.equal(allowed.payload.team.team_key, "jpn");
});
