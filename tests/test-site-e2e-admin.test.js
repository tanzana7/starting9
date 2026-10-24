import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import testSiteWorker, { createTestTeamWorker } from "../tooling/test-site/worker.js";
import { classifyE2ECleanupResult } from "../tooling/test-site/cleanup-contract.js";
import { handleSimulatedNpbRequest, simulatorGameDate } from "../tooling/test-site/simu-npb/source.js";
import { TEST_TEAM_GROUPS, TEST_TEAMS, testPredictionPlayerId } from "../tooling/test-site/teams.js";
import { transitionV3State } from "../backend/automation-v3/repository.js";
import { buildSyntheticPredictions } from "../tooling/test-site/auto-prediction-seeder.js";
import { V3_TIMING } from "../backend/automation-v3/constants.js";
import { verifyFightersDriverAuthCheckToken, verifyFightersScheduledDriverToken } from "../tooling/test-site/github-oidc.js";

let requestNumber = 0;
const GITHUB_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const oidcKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const oidcJwk = { ...oidcKey.publicKey.export({ format: "jwk" }), kid: "s9simu-unit-test", use: "sig", alg: "RS256" };

function createOidcToken(overrides = {}) {
  const runNumber = ++requestNumber;
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "starting9-simu-e2e",
    sub: "repo:tanzana7/starting9:ref:refs/heads/main",
    repository: "tanzana7/starting9",
    repository_id: "1293016764",
    repository_owner: "tanzana7",
    ref: "refs/heads/main",
    event_name: "workflow_dispatch",
    workflow_ref: "tanzana7/starting9/.github/workflows/s9simu-remote-e2e.yml@refs/heads/main",
    run_id: String(900000 + runNumber),
    run_attempt: "1",
    jti: `unit-test-jti-${runNumber}`,
    iat: now,
    nbf: now - 1,
    exp: now + 300,
    ...overrides
  };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "RS256", typ: "JWT", kid: oidcJwk.kid })}.${encode(claims)}`;
  const token = `${input}.${sign("RSA-SHA256", Buffer.from(input), oidcKey.privateKey).toString("base64url")}`;
  return { token, claims, runId: `${claims.run_id}:${claims.run_attempt}` };
}

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bind = (...args) => ({
        all: async () => ({ results: statement.all(...args) }),
        first: async () => statement.get(...args),
        run: async () => {
          try {
            return { meta: { changes: Number(statement.run(...args).changes || 0) } };
          } catch (error) {
            throw new Error(`${error.message}; SQL=${sql}`);
          }
        }
      });
      return { ...bind(), bind };
    },
    async batch(statements) {
      return statements.map((statement) => {
        try {
          return statement.run();
        } catch (error) {
          throw new Error(`${error.message}; failed SQL=${statement.sql}`);
        }
      });
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
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GITHUB_JWKS_URL) return Response.json({ keys: [oidcJwk] });
    return originalFetch(input, init);
  };
  const config = JSON.parse(fs.readFileSync(new URL("../wrangler.test-auth.jsonc", import.meta.url)));
  const env = { ...config.vars, AUTH_DB: d1(database), AUDIT_DB: d1(audit) };
  async function request(path, { method = "GET", body, authorization = undefined, cookie = "" } = {}) {
    let oidcProof = null;
    requestNumber += 1;
    if (body?.action === "provision" && authorization === undefined) {
      oidcProof = createOidcToken();
      authorization = oidcProof.token;
      if (!body.runId) body = { ...body, runId: oidcProof.runId };
    }
    const headers = {
      Origin: "https://s9simu.pages.dev",
      "Content-Type": "application/json",
      Cookie: "s9_test_team=fighters; s9_test_source=simu-npb",
      "CF-Connecting-IP": `198.51.100.${10 + (requestNumber % 200)}`
    };
    if (authorization) headers.Authorization = `Bearer ${authorization}`;
    if (cookie) headers.Cookie = cookie;
    const worker = new URL(path, "https://starting9-test-auth.internal").searchParams.has("simuNpb")
      ? testSiteWorker
      : createTestTeamWorker("fighters");
    const response = await worker.fetch(new Request(`https://starting9-test-auth.internal${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    }), env, { waitUntil() {} });
    return { response, payload: await response.json(),
      authorizationToken: oidcProof?.token || authorization || "",
      runId: oidcProof?.runId || body?.runId || "" };
  }
  return { database, audit, env, request, createOidcToken,
    restoreFetch() { globalThis.fetch = originalFetch; }, originalFetch,
    setFetch(handler) { globalThis.fetch = handler; } };
}

test("E2E admin provisioning uses ordinary registration/login and revokes its session on cleanup", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });

  const denied = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision" }, authorization: ""
  });
  assert.equal(denied.response.status, 404);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);

  const provisioned = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(provisioned.response.status, 201);
  assert.equal(provisioned.payload.runId, provisioned.runId);
  assert.ok(Date.parse(provisioned.payload.sessionExpiresAt) - Date.now() <= 30 * 60 * 1000);
  assert.match(provisioned.payload.username, /^e2e-[a-f0-9]{12}$/);
  const setCookie = provisioned.response.headers.get("Set-Cookie") || "";
  const cookie = setCookie.split(";", 1)[0];
  assert.match(cookie, /^s9_session=/);
  assert.match(setCookie, /Max-Age=(?:[0-9]{1,4})/i);

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
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(temporary.id).count, 1);

  const cleaned = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "cleanup" }, cookie });
  assert.equal(cleaned.response.status, 200);
  assert.equal(cleaned.payload.removed, false);
  assert.ok(Date.parse(cleaned.payload.replayMarkerRetainedUntil) > Date.now());
  assert.equal(f.database.prepare("SELECT status, role FROM users WHERE id = ?").get(temporary.id).status, "disabled");
  assert.equal(f.database.prepare("SELECT role FROM users WHERE id = ?").get(temporary.id).role, "user");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  const staleSession = await f.request("/api/auth/me", { cookie });
  assert.equal(staleSession.payload.authenticated, false);
});

test("Fighters scheduled OIDC is bound to the exact schedule workflow and auth-check cannot tick", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const workflowRef = "tanzana7/starting9/.github/workflows/fighters-unattended-driver.yml@refs/heads/main";
  const scheduledToken = f.createOidcToken({
    aud: "starting9-fighters-scheduled-driver",
    event_name: "schedule",
    workflow_ref: workflowRef
  });
  const authToken = f.createOidcToken({
    aud: "starting9-fighters-scheduled-driver",
    event_name: "workflow_dispatch",
    workflow_ref: workflowRef
  });
  assert.equal((await verifyFightersScheduledDriverToken(scheduledToken.token)).runId, scheduledToken.runId);
  assert.equal((await verifyFightersDriverAuthCheckToken(authToken.token)).runId, authToken.runId);
  await assert.rejects(verifyFightersScheduledDriverToken(authToken.token));
  await assert.rejects(verifyFightersDriverAuthCheckToken(scheduledToken.token));

  const anonymous = await f.request("/api/test/admin/scheduled-tick/health", { method: "POST" });
  assert.equal(anonymous.response.status, 404);
  const regularCookie = await f.request("/api/test/admin/scheduled-tick/health", {
    method: "POST", cookie: "s9_session=ordinary-user-session"
  });
  assert.equal(regularCookie.response.status, 404);
  const wrongWorkflow = f.createOidcToken({ aud: "starting9-fighters-scheduled-driver", event_name: "schedule" });
  const wrong = await f.request("/api/test/admin/scheduled-tick/health", {
    method: "POST", authorization: wrongWorkflow.token
  });
  assert.equal(wrong.response.status, 404);

  const health = await f.request("/api/test/admin/scheduled-tick/health", {
    method: "POST", authorization: authToken.token
  });
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.environment, "test");
  assert.equal(health.payload.service, "starting9-test-auth");

  const authCheckCannotTick = await f.request("/api/test/admin/scheduled-tick", {
    method: "POST", authorization: authToken.token, body: { now: "2026-10-25T06:00:00.000Z" }
  });
  assert.equal(authCheckCannotTick.response.status, 404);
  const outsideWindow = await f.request("/api/test/admin/scheduled-tick", {
    method: "POST", authorization: scheduledToken.token, body: { now: "2026-10-25T06:00:00.000Z" }
  });
  assert.equal(outsideWindow.response.status, 409,
    "the endpoint must use the server wall clock instead of the caller-supplied test date");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games").get().count, 0,
    "a rejected out-of-window clock pulse must not invoke the scheduled core");

  const productionResponse = await testSiteWorker.fetch(new Request(
    "https://starting9-test-auth.internal/api/test/admin/scheduled-tick", {
      method: "POST", headers: { Authorization: `Bearer ${scheduledToken.token}` }
    }), { ...f.env, ENVIRONMENT: "production" }, { waitUntil() {} });
  assert.equal(productionResponse.status, 404, "scheduled bridge is unavailable outside isolated Test identity");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games").get().count, 0,
    "authentication smoke must not create games or invoke the scheduled core");
});

test("E2E provisioning rejects invalid, expired, wrong-workflow, and mismatched run proofs without writes", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const valid = f.createOidcToken();
  const [header, payload, signature] = valid.token.split(".");
  const invalidSignature = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  const invalid = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision", runId: valid.runId }, authorization: invalidSignature
  });
  assert.equal(invalid.response.status, 404);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);

  for (const claims of [
    { exp: Math.floor(Date.now() / 1000) - 1 },
    { workflow_ref: "attacker/repo/.github/workflows/other.yml@refs/heads/main" },
    { repository: "attacker/starting9", repository_id: "1" },
    { event_name: "push" }
  ]) {
    const proof = f.createOidcToken(claims);
    const rejected = await f.request("/api/test/e2e-admin", {
      method: "POST", body: { action: "provision", runId: proof.runId }, authorization: proof.token
    });
    assert.equal(rejected.response.status, 404);
  }

  const mismatch = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision", runId: `${valid.runId}:wrong` }, authorization: valid.token
  });
  assert.equal(mismatch.response.status, 403);
  assert.equal(mismatch.payload.code, "E2E_RUN_MISMATCH");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("GitHub JWKS outage fails closed without creating an identity", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  f.setFetch(async () => { throw new Error("network unavailable"); });
  const proof = f.createOidcToken();
  const result = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision", runId: proof.runId }, authorization: proof.token
  });
  assert.equal(result.response.status, 503);
  assert.equal(result.payload.code, "E2E_AUTH_UNAVAILABLE");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("an OIDC proof can provision exactly one identity and cleanup keeps its replay marker until expiry", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const proof = f.createOidcToken();
  const body = { action: "provision", runId: proof.runId };
  const first = await f.request("/api/test/e2e-admin", { method: "POST", body, authorization: proof.token });
  assert.equal(first.response.status, 201);
  const replay = await f.request("/api/test/e2e-admin", { method: "POST", body, authorization: proof.token });
  assert.equal(replay.response.status, 409);
  assert.equal(replay.payload.code, "E2E_RUN_REPLAYED");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);

  const cookie = (first.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const cleaned = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "cleanup" }, cookie });
  assert.equal(cleaned.response.status, 200);
  assert.equal(cleaned.payload.removed, false);
  const marker = f.database.prepare("SELECT role, status, updated_at FROM users WHERE username = ?").get(first.payload.username);
  assert.deepEqual({ role: marker.role, status: marker.status }, { role: "user", status: "disabled" });
  assert.equal(marker.updated_at, first.payload.capabilityExpiresAt);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
});

test("E2E provisioning failures expose only a stage and allowlisted database diagnostics", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const originalPrepare = f.env.AUTH_DB.prepare.bind(f.env.AUTH_DB);
  f.env.AUTH_DB.prepare = (sql) => {
    if (sql === "SELECT id FROM users WHERE username_normalized = ?1 LIMIT 1") {
      const error = new Error("constraint details must never be returned: secret-value");
      error.code = "SQLITE_ERROR";
      return { bind: () => ({ first: async () => {
        throw error;
      } }) };
    }
    return originalPrepare(sql);
  };
  const result = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(result.response.status, 500);
  assert.deepEqual(result.payload, {
    ok: false,
    code: "E2E_ADMIN_PROVISION_FAILED",
    reasonCode: "E2E_IDENTITY_LOOKUP_FAILED",
    stage: "existing_identity_lookup",
    errorClass: "Error",
    databaseCode: "SQLITE_ERROR"
  });
  assert.equal(JSON.stringify(result.payload).includes("secret-value"), false);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("cleanup invalidates one run and permits a distinct run while preserving the replay tombstone", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });

  const firstProof = f.createOidcToken();
  const first = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision", runId: firstProof.runId }, authorization: firstProof.token
  });
  assert.equal(first.response.status, 201);
  const firstCookie = (first.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const firstUsername = first.payload.username;
  const cleanFirst = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup", runId: firstProof.runId }, cookie: firstCookie
  });
  assert.equal(cleanFirst.response.status, 200);
  assert.equal(classifyE2ECleanupResult(cleanFirst.payload), "replay-blocked");
  const replay = await f.request("/api/auth/me", { cookie: firstCookie });
  assert.equal(replay.payload.authenticated, false);

  const secondProof = f.createOidcToken({
    run_id: firstProof.claims.run_id,
    run_attempt: firstProof.claims.run_attempt
  });
  assert.equal(secondProof.runId, firstProof.runId);
  const second = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision", runId: secondProof.runId }, authorization: secondProof.token
  });
  assert.equal(second.response.status, 201);
  assert.notEqual(second.payload.username, firstUsername);
  const cleanSecond = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup", runId: secondProof.runId },
    cookie: (second.response.headers.get("Set-Cookie") || "").split(";", 1)[0]
  });
  assert.equal(cleanSecond.response.status, 200);
  assert.equal(classifyE2ECleanupResult(cleanSecond.payload), "replay-blocked");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = ?").get(firstUsername).count, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
});

test("a stale identity collision fails closed without modifying the existing account", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const proof = f.createOidcToken();
  const identity = await (await import("../tooling/test-site/github-oidc.js")).verifyS9SimuRunToken(proof.token);
  f.database.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at, status, role)
    VALUES ('stale-e2e-user', ?, ?, 'hash', 'salt', 1, '2026-01-01', '2026-01-01', 'active', 'admin')`)
    .run(identity.username, identity.username);

  const result = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision", runId: proof.runId }, authorization: proof.token
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.payload.code, "E2E_RUN_REPLAYED");
  const retained = f.database.prepare("SELECT id, role, status FROM users WHERE username = ?").get(identity.username);
  assert.equal(retained.id, "stale-e2e-user");
  assert.equal(retained.role, "admin");
  assert.equal(retained.status, "active");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
});

test("an expired replay tombstone with historical references is retained while a new proof provisions", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const first = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  const firstCookie = (first.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const clean = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup" }, cookie: firstCookie
  });
  assert.equal(clean.payload.removed, false);
  const marker = f.database.prepare("SELECT id FROM users WHERE username = ?").get(first.payload.username);
  f.database.prepare("UPDATE users SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(marker.id);
  f.database.prepare(`INSERT INTO test_games
    (game_id, title, game_date, start_at, prediction_deadline_at, home_team, away_team,
      created_by, created_at, updated_at)
    VALUES ('historical-e2e-fixture', 'Historical E2E', '2026-10-24', '2026-10-24T09:00:00.000Z',
      '2026-10-24T08:00:00.000Z', 'fighters', 'giants', ?, '2026-10-01', '2026-10-01')`)
    .run(marker.id);

  const next = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(next.response.status, 201);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = ?").get(first.payload.username).count, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM test_games WHERE game_id = 'historical-e2e-fixture'").get().count, 1);
  const nextCookie = (next.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const cleanupNext = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup" }, cookie: nextCookie
  });
  assert.equal(classifyE2ECleanupResult(cleanupNext.payload), "replay-blocked");
});

test("formal simulator schedule sync reads six games and reports each persistence stage", async (t) => {
  const f = await fixture();
  const upstreamRequests = [];
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  f.env.S9SIMU_ENABLED = "true";
  f.env.S9SIMU_BASE_URL = "https://s9simu.pages.dev";
  f.env.NPB_SOURCE = "simulator";
  f.env.ENABLE_GAME_AUTOMATION_V3 = "true";
  const fixtureFetch = globalThis.fetch;
  f.setFetch(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://s9simu.pages.dev") return fixtureFetch(input, init);
    upstreamRequests.push(`${url.pathname}${url.search}`);
    return handleSimulatedNpbRequest(new Request(url, init), {}, { TEST_TEAMS, TEST_TEAM_GROUPS });
  });

  const provisioned = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(provisioned.response.status, 201);
  const cookie = (provisioned.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const schedule = await f.request("/api/test/simu/schedule", { method: "POST", body: {}, cookie });
  assert.equal(schedule.response.status, 200);
  assert.equal(schedule.payload.date, simulatorGameDate());
  assert.equal(schedule.payload.physicalGames.length, 6);
  assert.equal(schedule.payload.contestCount, 12);
  assert.equal(upstreamRequests.some((path) => path === `/simu-npb/api/public/games?date=${schedule.payload.date}&team=all`), true);
  assert.deepEqual(schedule.payload.scheduleDiagnostics, {
    requestedDate: schedule.payload.date,
    requestedTeam: "all",
    upstreamPath: `/simu-npb/api/public/games?date=${schedule.payload.date}&team=all`,
    upstreamStatus: 200,
    contentType: "application/json",
    rawGamesCount: 6,
    parsedGamesCount: 6,
    filteredGamesCount: 6,
    normalizedGamesCount: 6,
    attemptedUpsertCount: 6,
    insertedCount: 6,
    updatedCount: 0,
    readBackCount: 6,
    internalGameIds: schedule.payload.physicalGames.map((game) => game.internal_game_id)
  });
  assert.equal(new Set(schedule.payload.physicalGames.flatMap((game) => [game.home_team, game.away_team])).size, 12);

  for (const game of schedule.payload.physicalGames) {
    const groupIndex = Number(String(game.game_code).match(/^g-t-(\d+)$/)?.[1]) - 1;
    const group = TEST_TEAM_GROUPS[groupIndex];
    assert.ok(group);
    const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${group.homeKey}&simuNpb=1`;
    const cleanupGame = await f.request(`/api/test/scenario${query}`, {
      method: "POST", body: { scenario: "no-game" }, cookie
    });
    assert.equal(cleanupGame.response.status, 200);
  }
  const rescheduled = await f.request("/api/test/simu/schedule", { method: "POST", body: {}, cookie });
  assert.equal(rescheduled.response.status, 200);
  assert.equal(rescheduled.payload.physicalGames.length, 6);
  assert.equal(rescheduled.payload.contestCount, 12);
  assert.equal(rescheduled.payload.scheduleDiagnostics.rawGamesCount, 6);
  assert.equal(rescheduled.payload.scheduleDiagnostics.readBackCount, 6);

  const cleanup = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup" }, cookie
  });
  assert.equal(cleanup.response.status, 200);
  assert.equal(cleanup.payload.removed, false);
});

test("simulator no-game cleanup removes only the requested internal game", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });

  const targetId = "11111111-2027-4000-8000-000000000001";
  const unrelatedId = "11111111-2027-4000-8000-000000000002";
  f.database.prepare("INSERT INTO contest_identity_teams (team_key) VALUES ('giants'), ('tigers')").run();
  for (const [internalGameId, homeTeam, awayTeam, teamKey] of [
    [targetId, "giants", "tigers", "giants"],
    [unrelatedId, "fighters", "giants", "fighters"]
  ]) {
    f.database.prepare(`INSERT INTO games
      (internal_game_id, game_date, start_time, home_team, away_team, created_at, updated_at)
      VALUES (?, '2027-03-01', '2027-03-01T18:00:00+09:00', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
      .run(internalGameId, homeTeam, awayTeam);
    f.database.prepare(`INSERT INTO game_contests (contest_id, internal_game_id, target_team_key)
      VALUES (?, ?, ?)`)
      .run(`contest-${internalGameId}`, internalGameId, teamKey);
  }
  f.database.prepare(`INSERT INTO detected_game_schedule
    (game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, venue,
     game_status, detected_at, schedule_checked_at, created_at, updated_at, internal_game_id)
    VALUES (?, ?, '2027-03-01', '2027-03-01T18:00:00+09:00', 'giants', 'tigers', 'g-t-91', 'simulator',
     'scheduled', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`)
    .run("simu-provider-row-91", "simu-run:2027-03-01:g-t-91", targetId);
  f.audit.prepare(`INSERT INTO game_automation_v3_audit
    (internal_game_id, job_type, occurred_at, source, contest_id)
    VALUES (?, 'lineup_fetch', CURRENT_TIMESTAMP, 'test', ?)`)
    .run(targetId, `contest-${targetId}`);

  const setup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(setup.response.status, 201);
  const cookie = (setup.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const query = `?internalGameId=${encodeURIComponent(targetId)}&testTeam=giants&simuNpb=1`;
  const cleaned = await f.request(`/api/test/scenario${query}`, {
    method: "POST", body: { scenario: "no-game" }, cookie
  });
  assert.equal(cleaned.response.status, 200);
  assert.equal(cleaned.payload.scenario, "no-game");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games WHERE internal_game_id = ?").get(targetId).count, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games WHERE internal_game_id = ?").get(unrelatedId).count, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM detected_game_schedule WHERE internal_game_id = ?").get(targetId).count, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM detected_game_schedule WHERE game_id = 'simu-provider-row-91'").get().count, 0);
  assert.equal(f.audit.prepare("SELECT COUNT(*) AS count FROM game_automation_v3_audit WHERE internal_game_id = ?").get(targetId).count, 0);

  const absentGroup = TEST_TEAM_GROUPS[2];
  const absentQuery = `?internalGameId=${encodeURIComponent(absentGroup.internalGameId)}&testTeam=${absentGroup.homeKey}&simuNpb=1`;
  const absentCleanup = await f.request(`/api/test/scenario${absentQuery}`, {
    method: "POST", body: { scenario: "no-game" }, cookie
  });
  assert.equal(absentCleanup.response.status, 200);
  assert.equal(absentCleanup.payload.scenario, "no-game");

  const unknownQuery = "?internalGameId=unknown-simulator-game&testTeam=giants&simuNpb=1";
  const unknownCleanup = await f.request(`/api/test/scenario${unknownQuery}`, {
    method: "POST", body: { scenario: "no-game" }, cookie
  });
  assert.equal(unknownCleanup.response.status, 404);
  assert.equal(unknownCleanup.payload.code, "SIMULATED_GAME_NOT_FOUND");

  const adminCleanup = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup" }, cookie
  });
  assert.equal(adminCleanup.response.status, 200);
  assert.equal(adminCleanup.payload.removed, false);
});

test("parsed simulator roster IDs are trusted by the same Test prediction save path", async (t) => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; f.restoreFetch(); f.database.close(); f.audit.close(); });
  f.env.S9SIMU_ENABLED = "true";
  f.env.S9SIMU_BASE_URL = "https://s9simu.pages.dev";
  f.env.NPB_SOURCE = "simulator";
  f.env.ENABLE_GAME_AUTOMATION_V3 = "true";
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://s9simu.pages.dev") return originalFetch(input, init);
    return handleSimulatedNpbRequest(new Request(url, init), {
      SIMU_NPB_STATE: { async get(key) { return key === "lineup-state" ? "pre-lineup" : null; } }
    }, { TEST_TEAMS, TEST_TEAM_GROUPS });
  };

  const setup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(setup.response.status, 201);
  const cookie = (setup.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const scheduled = await f.request("/api/test/simu/schedule?testTeam=fighters", {
    method: "POST", body: {}, cookie
  });
  assert.equal(scheduled.response.status, 200);
  const game = scheduled.payload.physicalGames.find((row) => row.game_code === "g-t-1");
  assert.ok(game);
  const team = TEST_TEAMS.giants;
  const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=giants&simuNpb=1`;
  const roster = await f.request(`/api/game-day-roster${query}`, { cookie });
  assert.equal(roster.response.status, 200);
  assert.equal(roster.payload.players.length, 15);
  const lineup = roster.payload.players.slice(0, 9).map((player, index) => ({
    playerId: player.playerId,
    playerName: player.name,
    uniformNumber: player.uniformNumber || player.number,
    teamCode: team.key,
    teamId: team.playerTeamId,
    battingOrder: index + 1,
    position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index]
  }));
  const saved = await f.request(`/api/predictions/current${query}`, {
    method: "PUT", cookie,
    body: { internalGameId: game.internal_game_id, prediction: { schemaVersion: 1, lineup } }
  });
  assert.equal(saved.response.status, 200, saved.payload.error);
  assert.equal(saved.payload.status, "submitted");

  const cleanup = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup" }, cookie
  });
  assert.equal(cleanup.response.status, 200);
  assert.equal(cleanup.payload.removed, false);
});

test("Fighters auto-seeder exercises normal prediction writes, exact cutoff, and the full isolated formal pipeline", async (t) => {
  const f = await fixture();
  let simulatorLineupState = "pre-lineup";
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  f.env.S9SIMU_ENABLED = "true";
  f.env.S9SIMU_BASE_URL = "https://s9simu.pages.dev";
  f.env.NPB_SOURCE = "simulator";
  f.env.ENABLE_GAME_AUTOMATION_V3 = "true";
  f.setFetch(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href === GITHUB_JWKS_URL) return Response.json({ keys: [oidcJwk] });
    if (url.origin !== "https://s9simu.pages.dev") return f.originalFetch(input, init);
    return handleSimulatedNpbRequest(new Request(url, init), {
      SIMU_NPB_STATE: {
        async get(key) { return key === "lineup-state" ? simulatorLineupState : null; },
        async put(_key, value) { simulatorLineupState = value; }
      }
    }, { TEST_TEAMS, TEST_TEAM_GROUPS });
  });

  const provision = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(provision.response.status, 201);
  const adminCookie = provision.response.headers.get("Set-Cookie").split(";", 1)[0];
  const schedule = await f.request("/api/test/simu/schedule?testTeam=fighters", {
    method: "POST", body: {}, cookie: adminCookie
  });
  assert.equal(schedule.response.status, 200);
  const game = schedule.payload.physicalGames.find((row) => row.game_code === "g-t-4");
  assert.ok(game);
  assert.equal(game.home_team, TEST_TEAMS.hawks.key);
  assert.equal(game.away_team, TEST_TEAMS.fighters.key);
  assert.equal(new Date(game.start_at).getUTCHours(), 6, "15:00 JST simulator start is preserved");
  const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=fighters&simuNpb=1`;
  const rosterResult = await f.request(`/api/game-day-roster${query}`, { cookie: adminCookie });
  assert.equal(rosterResult.response.status, 200);
  const roster = rosterResult.payload.players;
  assert.equal(roster.length, 15);
  assert.ok(roster.every((player) => player.teamCode === "fighters" && player.teamId === TEST_TEAMS.fighters.playerTeamId));
  const jobs = await f.request(`/api/test/jobs${query}`, { cookie: adminCookie });
  const contestId = jobs.payload.contestId;
  const seed = 20261025;
  const generated = buildSyntheticPredictions({ contestId, targetTeam: "fighters", roster, userCount: 10, seed });

  const createdAt = new Date().toISOString();
  const users = [];
  for (let index = 0; index < 10; index += 1) {
    const userId = `fighters-auto-user-${index + 1}`;
    const username = `fighters-auto-${String(index + 1).padStart(2, "0")}`;
    const sessionToken = `synthetic-session-20261025-${String(index + 1).padStart(2, "0")}`;
    const tokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken))).toString("base64url");
    f.database.prepare(`INSERT INTO users
      (id, username, username_normalized, password_hash, password_salt, password_iterations, status, role, created_at, updated_at)
      VALUES (?, ?, ?, 'test-only', 'test-only', 1, 'active', 'user', ?, ?)`).run(userId, username, username, createdAt, createdAt);
    f.database.prepare(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
      VALUES (?, ?, ?, ?, '2099-01-01T00:00:00.000Z', ?)`).run(`fighters-auto-session-${index + 1}`, userId, tokenHash, createdAt, createdAt);
    users.push({ username, session: `s9_session=${sessionToken}` });
  }

  const startAt = new Date(game.start_at);
  const cutoff = new Date(startAt.getTime() - V3_TIMING.predictionDeadlineMinutes * 60_000);
  const cutoffMinus1 = new Date(cutoff.getTime() - 1);
  const cutoffPlus1 = new Date(cutoff.getTime() + 1);
  const submitAt = async (user, prediction, logicalNow) => f.request(`/api/test/prediction-write${query}`, {
    method: "POST", cookie: adminCookie,
    body: { sessionCookie: user.session, prediction, logicalNow: logicalNow.toISOString() }
  });
  const unauthenticatedWrite = await f.request(`/api/test/prediction-write${query}`, {
    method: "POST", body: { sessionCookie: users[0].session, prediction: generated[0].prediction, logicalNow: cutoffMinus1.toISOString() }
  });
  assert.equal(unauthenticatedWrite.response.status, 401);
  assert.equal(unauthenticatedWrite.payload.code, "ADMIN_REQUIRED");
  const outOfWindowWrite = await submitAt(users[0], generated[0].prediction, new Date(cutoff.getTime() + 2 * 60_000));
  assert.equal(outOfWindowWrite.response.status, 400);
  assert.equal(outOfWindowWrite.payload.code, "TEST_CLOCK_OUT_OF_WINDOW");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM predictions WHERE internal_game_id = ? AND contest_id = ?")
    .get(game.internal_game_id, contestId).count, 0, "rejected test clocks must not reach the ordinary prediction writer");
  for (let index = 0; index < generated.length; index += 1) {
    const saved = await submitAt(users[index], generated[index].prediction, cutoffMinus1);
    assert.equal(saved.response.status, 200);
    assert.equal(saved.payload.ok, true, generated[index].label);
  }
  const cutoffWrite = await submitAt(users[0], generated[0].prediction, cutoff);
  const lateWrite = await submitAt(users[0], generated[0].prediction, cutoffPlus1);
  for (const rejected of [cutoffWrite, lateWrite]) {
    assert.equal(rejected.payload.ok, false);
    assert.equal(rejected.payload.status, 409);
    assert.equal(rejected.payload.code, "PREDICTION_DEADLINE_PASSED");
  }
  for (const user of users) {
    const read = await f.request(`/api/predictions/current${query}`, { cookie: user.session });
    assert.equal(read.response.status, 200);
    assert.equal(read.payload.prediction.lineup.length, 9);
  }

  const advanceTo = async (scenario, now, expectedState) => {
    let last;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await f.request(`/api/test/scenario${query}`, {
        method: "POST", cookie: adminCookie,
        body: { scenario, stageOnly: true, now: now.toISOString() }
      });
      if (last.payload.game?.state === expectedState) break;
    }
    assert.equal(last.response.status, 200, `${scenario}: ${JSON.stringify(last.payload)}`);
    assert.equal(last.payload.game.state, expectedState, `${scenario}: ${JSON.stringify(last.payload.pipelineDiagnostics || null)}`);
    return last.payload.game;
  };
  await advanceTo("closed", cutoff, "prediction_closed");
  simulatorLineupState = "available";
  const lineupAt = new Date(startAt.getTime() + 10 * 60_000);
  await advanceTo("lineup-captured", lineupAt, "lineup_ready");
  const scoringRun = await f.request(`/api/test/scenario${query}`, {
    method: "POST", cookie: adminCookie,
    body: { scenario: "scored", stageOnly: true, now: lineupAt.toISOString() }
  });
  assert.equal(scoringRun.response.status, 200, JSON.stringify(scoringRun.payload));
  assert.ok((await f.request(`/api/test/jobs${query}`, { cookie: adminCookie })).payload.jobs
    .some((job) => job.job_type === "score" && job.status === "completed"));
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM predictions WHERE internal_game_id = ? AND contest_id = ? AND status = 'scored'")
    .get(game.internal_game_id, contestId).count, 10);
  await advanceTo("ranked", lineupAt, "ranked");
  await advanceTo("published", lineupAt, "published");

  const scores = [];
  for (const user of users) {
    const result = await f.request(`/api/results/games/${encodeURIComponent(game.internal_game_id)}${query}`, { cookie: user.session });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.resultsPublished, true);
    assert.equal(result.payload.actualLineup.length, 9);
    scores.push(Number(result.payload.score));
  }
  assert.equal(scores.length, 10);
  assert.equal(scores[0], 99, "the perfect-like first prediction scores against the official default lineup");
  assert.ok(new Set(scores).size > 1, "normal scoring creates deterministic ranking-relevant variation");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM predictions WHERE internal_game_id = ? AND contest_id = ? AND status = 'scored'")
    .get(game.internal_game_id, contestId).count, 10);
  assert.equal(f.database.prepare("SELECT publication_status FROM contest_ranking_games WHERE internal_game_id = ? AND contest_id = ?")
    .get(game.internal_game_id, contestId).publication_status, "published");
  const finalJobs = (await f.request(`/api/test/jobs${query}`, { cookie: adminCookie })).payload.jobs;
  for (const type of ["prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]) {
    assert.ok(finalJobs.some((job) => job.job_type === type && job.status === "completed"), `${type}: formal job completed`);
  }
  assert.ok(finalJobs.every((job) => !["claimed", "retry_wait", "failed"].includes(job.status)));
  const sibling = await f.request(`/api/test/status?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=hawks&simuNpb=1`);
  assert.equal(sibling.payload.game.state || "scheduled", "scheduled");
  for (const user of users) {
    const logout = await f.request("/api/auth/logout?testTeam=fighters", { method: "POST", cookie: user.session });
    assert.equal(logout.response.status, 200);
  }
  const cleanup = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup" }, cookie: adminCookie
  });
  assert.equal(cleanup.response.status, 200);
  assert.ok(["deleted", "replay-blocked"].includes(classifyE2ECleanupResult(cleanup.payload)));
});

test("simulator provider identity resolves every persisted game, both contests, and game-scoped cleanup", async (t) => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; f.restoreFetch(); f.database.close(); f.audit.close(); });
  f.env.S9SIMU_ENABLED = "true";
  f.env.S9SIMU_BASE_URL = "https://s9simu.pages.dev";
  f.env.NPB_SOURCE = "simulator";
  f.env.ENABLE_GAME_AUTOMATION_V3 = "true";
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://s9simu.pages.dev") return originalFetch(input, init);
    return handleSimulatedNpbRequest(new Request(url, init), {
      SIMU_NPB_STATE: { async get(key) { return key === "lineup-state" ? "pre-lineup" : null; } }
    }, { TEST_TEAMS, TEST_TEAM_GROUPS });
  };

  const setup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(setup.response.status, 201);
  const cookie = (setup.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const scheduled = await f.request("/api/test/simu/schedule?testTeam=fighters", {
    method: "POST", body: {}, cookie
  });
  assert.equal(scheduled.response.status, 200);
  const games = scheduled.payload.physicalGames;
  assert.equal(games.length, 6);
  assert.equal(scheduled.payload.contestCount, 12);

  const seenProviderIds = new Set();
  const seenInternalIds = new Set();
  for (const game of games) {
    const providerGameId = String(game.game_code || "");
    assert.match(providerGameId, /^g-t-[1-6]$/);
    assert.ok(game.internal_game_id);
    assert.equal(game.persisted_internal_game_id, game.internal_game_id);
    assert.equal(game.provider_game_id, providerGameId);
    assert.equal(game.persisted_contest_count, 2);
    assert.notEqual(game.internal_game_id, providerGameId);
    assert.equal(seenProviderIds.has(providerGameId), false);
    assert.equal(seenInternalIds.has(game.internal_game_id), false);
    seenProviderIds.add(providerGameId);
    seenInternalIds.add(game.internal_game_id);

    const index = Number(providerGameId.slice("g-t-".length)) - 1;
    const group = TEST_TEAM_GROUPS[index];
    const stored = f.database.prepare(`SELECT games.internal_game_id, games.npb_game_code,
        (SELECT identifier_value FROM game_identifiers WHERE internal_game_id=games.internal_game_id
          AND provider='npb' AND identifier_type='npb_game_code' ORDER BY updated_at DESC,id DESC LIMIT 1) AS provider_game_id,
        COUNT(game_contests.contest_id) AS contest_count
      FROM games LEFT JOIN game_contests USING (internal_game_id)
      WHERE games.internal_game_id=? GROUP BY games.internal_game_id`).get(game.internal_game_id);
    assert.equal(stored?.internal_game_id, game.internal_game_id);
    assert.equal(stored?.provider_game_id || stored?.npb_game_code, providerGameId);
    assert.equal(stored?.contest_count, 2);

    for (const teamKey of [group.homeKey, group.awayKey]) {
      const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${teamKey}&simuNpb=1`;
      const roster = await f.request(`/api/game-day-roster${query}`, { cookie });
      assert.equal(roster.response.status, 200, `${providerGameId}/${teamKey}: ${JSON.stringify(roster.payload)}`);
      assert.equal(roster.payload.players.length, 15);
      assert.ok(roster.payload.players.every((player) => player.teamCode === teamKey));
    }
  }
  assert.equal(seenProviderIds.size, 6);
  assert.equal(seenInternalIds.size, 6);

  const first = games[0];
  const otherTeam = TEST_TEAM_GROUPS[1].homeKey;
  const crossed = await f.request(`/api/game-day-roster?internalGameId=${encodeURIComponent(first.internal_game_id)}&testTeam=${otherTeam}&simuNpb=1`, { cookie });
  assert.equal(crossed.response.status, 404);
  assert.equal(crossed.payload.code, "SIMULATED_GAME_NOT_FOUND");

  const cleanupGame = games[1];
  const cleanupGroup = TEST_TEAM_GROUPS[Number(cleanupGame.game_code.slice("g-t-".length)) - 1];
  const cleanupQuery = `?internalGameId=${encodeURIComponent(cleanupGame.internal_game_id)}&testTeam=${cleanupGroup.homeKey}&simuNpb=1`;
  const cleanup = await f.request(`/api/test/scenario${cleanupQuery}`, {
    method: "POST", body: { scenario: "no-game" }, cookie
  });
  assert.equal(cleanup.response.status, 200);
  assert.equal(cleanup.payload.scenario, "no-game");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games WHERE internal_game_id=?").get(cleanupGame.internal_game_id).count, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games WHERE internal_game_id=?").get(games[0].internal_game_id).count, 1);
});

test("a published same-game sibling does not block the other contest's official lineup transition", async (t) => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const simulatorState = { value: "pre-lineup" };
  t.after(() => { globalThis.fetch = originalFetch; f.restoreFetch(); f.database.close(); f.audit.close(); });
  f.env.S9SIMU_ENABLED = "true";
  f.env.S9SIMU_BASE_URL = "https://s9simu.pages.dev";
  f.env.NPB_SOURCE = "simulator";
  f.env.ENABLE_GAME_AUTOMATION_V3 = "true";
  f.env.ENABLE_SEMI_AUTO_LINEUP = "true";
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://s9simu.pages.dev") return originalFetch(input, init);
    return handleSimulatedNpbRequest(new Request(url, init), {
      SIMU_NPB_STATE: {
        async get(key) { return key === "lineup-state" ? simulatorState.value : null; },
        async put(_key, value) { simulatorState.value = value; }
      }
    }, { TEST_TEAMS, TEST_TEAM_GROUPS });
  };

  const setup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(setup.response.status, 201);
  const cookie = (setup.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const scheduled = await f.request("/api/test/simu/schedule?testTeam=fighters", {
    method: "POST", body: {}, cookie
  });
  assert.equal(scheduled.response.status, 200);
  const game = scheduled.payload.physicalGames.find((row) => row.game_code === "g-t-1");
  assert.ok(game);
  const contexts = [];
  for (const teamKey of ["giants", "tigers"]) {
    const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${teamKey}&simuNpb=1`;
    const roster = await f.request(`/api/game-day-roster${query}`, { cookie });
    assert.equal(roster.response.status, 200, `${teamKey}: roster`);
    const lineup = roster.payload.players.slice(0, 9).map((player, index) => ({
      playerId: testPredictionPlayerId(teamKey, player.uniformNumber || player.number),
      playerName: player.name,
      uniformNumber: player.uniformNumber || player.number,
      teamCode: teamKey,
      teamId: TEST_TEAMS[teamKey].playerTeamId,
      battingOrder: index + 1,
      position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index]
    }));
    const saved = await f.request(`/api/predictions/current${query}`, {
      method: "PUT", cookie,
      body: { internalGameId: game.internal_game_id, prediction: { schemaVersion: 1, lineup } }
    });
    assert.equal(saved.response.status, 200, `${teamKey}: prediction`);
    contexts.push({ teamKey, query });
  }

  const startAt = new Date(game.start_at);
  const closedAt = new Date(startAt.getTime() - 59 * 60_000);
  for (const context of contexts) {
    const closed = await f.request(`/api/test/scenario${context.query}`, {
      method: "POST", cookie,
      body: { scenario: "closed", stageOnly: true, now: closedAt.toISOString() }
    });
    assert.equal(closed.response.status, 200, `${context.teamKey}: close`);
    assert.equal(closed.payload.game.state, "prediction_closed");
    const contestId = f.database.prepare("SELECT contest_id FROM game_contests WHERE internal_game_id = ? AND target_team_key = ?")
      .get(game.internal_game_id, context.teamKey).contest_id;
    assert.ok(closed.payload.pipelineDiagnostics.claimedContestIds.every((claimed) => claimed === contestId),
      `${context.teamKey}: close claims no sibling contest`);
    assert.ok(f.database.prepare("SELECT 1 FROM game_jobs_v3 WHERE internal_game_id = ? AND contest_id = ? AND job_type = 'prediction_close' AND status = 'completed'")
      .get(game.internal_game_id, contestId), `${context.teamKey}: close job is persisted to its own contest`);
  }

  simulatorState.value = "available";
  const postGame = new Date(startAt.getTime() + 10 * 60_000);
  async function captureUntilReady(context) {
    let last;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await f.request(`/api/test/scenario${context.query}`, {
        method: "POST", cookie,
        body: { scenario: "lineup-captured", stageOnly: true, now: postGame.toISOString() }
      });
      if (last.payload.game?.state === "lineup_ready") break;
    }
    assert.equal(last.response.status, 200, `${context.teamKey}: lineup capture`);
    assert.equal(last.payload.game.state, "lineup_ready", `${context.teamKey}: formal transition`);
    assert.equal(last.payload.pipelineDiagnostics.targetTeam, context.teamKey);
    assert.equal(last.payload.pipelineDiagnostics.stateAfter, "lineup_ready");
    assert.equal(last.payload.pipelineDiagnostics.lineupPersisted, true);
    const contestId = f.database.prepare("SELECT contest_id FROM game_contests WHERE internal_game_id = ? AND target_team_key = ?")
      .get(game.internal_game_id, context.teamKey).contest_id;
    assert.ok(last.payload.pipelineDiagnostics.claimedContestIds.every((claimed) => claimed === contestId),
      `${context.teamKey}: lineup pipeline claims no sibling contest`);
    assert.ok(last.payload.pipelineDiagnostics.jobs.some((job) => job.jobType === "lineup_finalize" && job.status === "completed"));
    return last.payload;
  }

  await captureUntilReady(contexts[0]);
  const giantsContest = f.database.prepare("SELECT contest_id FROM game_contests WHERE internal_game_id = ? AND target_team_key = 'giants'")
    .get(game.internal_game_id).contest_id;
  // Arrange the terminal sibling through the canonical transition primitive
  // and published contest artifact. The Tigers request below still exercises
  // the real planner, job insertion, claim and executor path.
  for (const [from, to] of [["lineup_ready", "scored"], ["scored", "ranked"], ["ranked", "published"]]) {
    await transitionV3State(f.env.AUTH_DB, {
      internalGameId: game.internal_game_id, contestId: giantsContest, from, to, now: postGame
    });
  }
  f.database.prepare(`UPDATE contest_ranking_games SET publication_status = 'published', published_at = ?
    WHERE internal_game_id = ? AND contest_id = ?`).run(postGame.toISOString(), game.internal_game_id, giantsContest);
  assert.ok(f.database.prepare(`SELECT 1 FROM contest_ranking_games
    WHERE internal_game_id = ? AND contest_id = ? AND publication_status = 'published'`)
    .get(game.internal_game_id, giantsContest), "Giants publication is persisted only on its contest artifact");
  const siblingBefore = f.database.prepare(`SELECT state FROM contest_automation_v3_state
    WHERE internal_game_id = ? AND contest_id = (SELECT contest_id FROM game_contests
      WHERE internal_game_id = ? AND target_team_key = 'tigers')`).get(game.internal_game_id, game.internal_game_id);
  assert.equal(siblingBefore?.state, "prediction_closed");

  const tigersCapture = await captureUntilReady(contexts[1]);
  assert.ok(Array.isArray(tigersCapture.pipelineDiagnostics.claimedJobTypes));
  assert.equal(f.database.prepare(`SELECT state FROM contest_automation_v3_state
    WHERE internal_game_id = ? AND contest_id = (SELECT contest_id FROM game_contests
      WHERE internal_game_id = ? AND target_team_key = 'giants')`).get(game.internal_game_id, game.internal_game_id)?.state, "published");
  const tigersLineup = f.database.prepare(`SELECT revision.actual_lineup_json
    FROM game_lineups AS current JOIN contest_lineup_revisions AS revision
      ON revision.contest_id = current.contest_id AND revision.revision_id = current.final_lineup_revision_id
    WHERE current.internal_game_id = ? AND current.contest_id = (SELECT contest_id FROM game_contests
      WHERE internal_game_id = ? AND target_team_key = 'tigers')`).get(game.internal_game_id, game.internal_game_id);
  assert.ok(JSON.parse(tigersLineup.actual_lineup_json).every((player) => player.teamCode === "tigers"));

  const tigersContest = f.database.prepare("SELECT contest_id FROM game_contests WHERE internal_game_id = ? AND target_team_key = 'tigers'")
    .get(game.internal_game_id).contest_id;
  const beforeRetry = {
    revisions: f.database.prepare("SELECT COUNT(*) AS count FROM contest_lineup_revisions WHERE internal_game_id = ? AND contest_id = ?")
      .get(game.internal_game_id, tigersContest).count,
    lineupJobs: f.database.prepare("SELECT job_type,COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ? AND contest_id = ? AND job_type IN ('lineup_fetch','lineup_finalize') GROUP BY job_type ORDER BY job_type")
      .all(game.internal_game_id, tigersContest)
  };
  await captureUntilReady(contexts[1]);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM contest_lineup_revisions WHERE internal_game_id = ? AND contest_id = ?")
    .get(game.internal_game_id, tigersContest).count, beforeRetry.revisions, "same official lineup retry does not create a revision");
  assert.deepEqual(f.database.prepare("SELECT job_type,COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ? AND contest_id = ? AND job_type IN ('lineup_fetch','lineup_finalize') GROUP BY job_type ORDER BY job_type")
    .all(game.internal_game_id, tigersContest), beforeRetry.lineupJobs, "same official lineup retry does not duplicate lineup jobs");
});

test("official simulator lineups finalize through the formal pipeline for all twelve contest contexts", async (t) => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const simulatorState = { value: "available" };
  t.after(() => { globalThis.fetch = originalFetch; f.restoreFetch(); f.database.close(); f.audit.close(); });
  f.env.S9SIMU_ENABLED = "true";
  f.env.S9SIMU_BASE_URL = "https://s9simu.pages.dev";
  f.env.NPB_SOURCE = "simulator";
  f.env.ENABLE_GAME_AUTOMATION_V3 = "true";
  // Match the inherited Test config so this test proves its per-request
  // product environment explicitly selects the automated official path.
  f.env.ENABLE_SEMI_AUTO_LINEUP = "true";
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://s9simu.pages.dev") return originalFetch(input, init);
    return handleSimulatedNpbRequest(new Request(url, init), {
      SIMU_NPB_STATE: {
        async get(key) { return key === "lineup-state" ? simulatorState.value : null; },
        async put(_key, value) { simulatorState.value = value; }
      }
    }, { TEST_TEAMS, TEST_TEAM_GROUPS });
  };

  const setup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(setup.response.status, 201);
  const cookie = (setup.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const scheduled = await f.request("/api/test/simu/schedule?testTeam=fighters", {
    method: "POST", body: {}, cookie
  });
  assert.equal(scheduled.response.status, 200);
  const physicalGames = scheduled.payload.physicalGames;
  assert.equal(physicalGames.length, 6);

  const teamsByKey = new Map(Object.entries(TEST_TEAMS));
  const contexts = [];
  for (const game of physicalGames) {
    const groupIndex = Number(String(game.game_code).match(/^g-t-(\d+)$/)?.[1]) - 1;
    const group = TEST_TEAM_GROUPS[groupIndex];
    assert.ok(group, `unexpected simulator game code ${game.game_code}`);
    assert.equal(game.home_team, TEST_TEAMS[group.homeKey].key);
    assert.equal(game.away_team, TEST_TEAMS[group.awayKey].key);
    for (const teamKey of [group.homeKey, group.awayKey]) {
      const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${teamKey}&simuNpb=1`;
      const roster = await f.request(`/api/game-day-roster${query}`, { cookie });
      assert.equal(roster.response.status, 200, `${teamKey}: roster fetch`);
      assert.equal(roster.payload.players.length, 15);
      assert.ok(roster.payload.players.every((player) => player.teamCode === teamKey));
      assert.ok(roster.payload.players.every((player) => player.teamId === teamsByKey.get(teamKey).playerTeamId));
      const lineup = roster.payload.players.slice(0, 9).map((player, index) => ({
        playerId: testPredictionPlayerId(teamKey, player.uniformNumber || player.number),
        playerName: player.name,
        uniformNumber: player.uniformNumber || player.number,
        teamCode: teamKey,
        teamId: teamsByKey.get(teamKey).playerTeamId,
        battingOrder: index + 1,
        position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index]
      }));
      const prediction = await f.request(`/api/predictions/current${query}`, {
        method: "PUT", cookie,
        body: { internalGameId: game.internal_game_id, prediction: { schemaVersion: 1, lineup } }
      });
      assert.equal(prediction.response.status, 200, `${teamKey}: prediction save ${JSON.stringify(prediction.payload)}`);
      contexts.push({ game, group, teamKey, query });
    }
  }
  assert.equal(contexts.length, 12);

  for (const context of contexts) {
    const startAt = new Date(context.game.start_at);
    const closedAt = new Date(startAt.getTime() - 59 * 60_000);
    const closed = await f.request(`/api/test/scenario${context.query}`, {
      method: "POST", cookie,
      body: { scenario: "closed", stageOnly: true, now: closedAt.toISOString() }
    });
    assert.equal(closed.response.status, 200, `${context.teamKey}: prediction close`);
    assert.equal(closed.payload.game.state, "prediction_closed");
  }

  simulatorState.value = "available";
  let firstContestPublished = false;
  for (const context of contexts) {
    const postGame = new Date(new Date(context.game.start_at).getTime() + 10 * 60_000);
    let captured;
    const pipelineDiagnosticsHistory = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const executionAt = new Date(postGame.getTime() + attempt * 60_000);
      captured = await f.request(`/api/test/scenario${context.query}`, {
        method: "POST", cookie,
        body: { scenario: "lineup-captured", stageOnly: true, now: executionAt.toISOString() }
      });
      if (captured.payload.pipelineDiagnostics) pipelineDiagnosticsHistory.push(captured.payload.pipelineDiagnostics);
      if (captured.payload.game?.state === "lineup_ready") break;
    }
    assert.equal(captured.response.status, 200, `${context.teamKey}: official lineup fetch`);
    const capturedJobs = f.database.prepare(`SELECT job_type, status, scheduled_at, scheduled_slot_at, failure_code, failure_message, attempt_count
      FROM game_jobs_v3 WHERE internal_game_id = ? AND contest_id = (
        SELECT contest_id FROM game_contests WHERE internal_game_id = ? AND target_team_key = ?
      ) ORDER BY job_type`).all(context.game.internal_game_id, context.game.internal_game_id, context.teamKey);
    assert.equal(captured.payload.game.state, "lineup_ready",
      `${context.teamKey}: formal transition ${JSON.stringify({ game: captured.payload.game, jobs: capturedJobs })}`);
    const contestId = f.database.prepare(`SELECT contest_id FROM game_contests
      WHERE internal_game_id=? AND target_team_key=?`).get(context.game.internal_game_id, context.teamKey)?.contest_id;
    assert.ok(contestId, `${context.teamKey}: canonical contest identity`);
    const teamDiagnostics = pipelineDiagnosticsHistory.filter((entry) => entry.targetTeam === context.teamKey);
    assert.ok(teamDiagnostics.some((entry) => entry.lineupPersisted === true));
    assert.ok(teamDiagnostics.some((entry) => entry.claimedJobTypes?.includes("lineup_fetch")));
    assert.ok(teamDiagnostics.some((entry) => entry.claimedContestIds?.includes(contestId)));
    assert.ok(teamDiagnostics.flatMap((entry) => entry.lineupFetchPlans || []).some((plan) =>
      plan.targetTeam === context.teamKey && plan.due === true));
    const lineup = f.database.prepare(`SELECT revision.actual_lineup_json, current.final_lineup_revision_id
      FROM game_lineups AS current
      JOIN contest_lineup_revisions AS revision
        ON revision.contest_id = current.contest_id AND revision.revision_id = current.final_lineup_revision_id
      WHERE current.internal_game_id = ? AND current.contest_id = (
        SELECT contest_id FROM game_contests WHERE internal_game_id = ? AND target_team_key = ?
      )`).get(context.game.internal_game_id, context.game.internal_game_id, context.teamKey);
    assert.ok(lineup?.final_lineup_revision_id, `${context.teamKey}: canonical final lineup missing`);
    const actual = JSON.parse(lineup.actual_lineup_json);
    assert.equal(actual.length, 9);
    assert.ok(actual.every((player) => player.teamCode === context.teamKey), `${context.teamKey}: lineup identity crossed contests`);
    const jobs = f.database.prepare(`SELECT job_type, status FROM game_jobs_v3
      WHERE internal_game_id = ? AND contest_id = (
        SELECT contest_id FROM game_contests WHERE internal_game_id = ? AND target_team_key = ?
      ) AND job_type IN ('lineup_fetch', 'lineup_finalize') ORDER BY job_type`).all(
      context.game.internal_game_id, context.game.internal_game_id, context.teamKey
    );
    assert.equal(jobs.some((job) => job.job_type === "lineup_fetch" && job.status === "completed"), true);
    assert.equal(jobs.some((job) => job.job_type === "lineup_finalize" && job.status === "completed"), true);
    assert.equal(jobs.every((job) => job.job_type === "lineup_fetch" || job.status === "completed"), true);

    // Keep one sibling in a terminal contest state before processing the next
    // team. The production pipeline tests separately verify real publish
    // artifacts; this isolated case focuses on whether a terminal sibling's
    // state can suppress the selected contest's formal lineup job.
    if (!firstContestPublished && context.group.homeKey === context.teamKey) {
      const contestId = f.database.prepare(`SELECT contest_id FROM game_contests
        WHERE internal_game_id=? AND target_team_key=?`).get(context.game.internal_game_id, context.teamKey)?.contest_id;
      for (const [from, to] of [["lineup_ready", "scored"], ["scored", "ranked"], ["ranked", "published"]]) {
        await transitionV3State(f.env.AUTH_DB, {
          internalGameId: context.game.internal_game_id,
          contestId,
          from,
          to,
          now: postGame
        });
      }
      firstContestPublished = true;
    }
  }

  // Cleanup uses the exact six canonical IDs returned by this schedule run;
  // a separate game remains as a guard against any cross-run/global delete.
  const unrelatedId = "22222222-2027-4000-8000-000000000099";
  f.database.prepare(`INSERT INTO games
    (internal_game_id, game_date, start_time, home_team, away_team, created_at, updated_at)
    VALUES (?, '2027-03-01', '2027-03-01T18:00:00+09:00', 'fighters', 'hawks', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .run(unrelatedId);
  f.database.prepare(`INSERT INTO game_contests (contest_id, internal_game_id, target_team_key)
    VALUES ('contest-unrelated-s9simu', ?, 'fighters')`).run(unrelatedId);
  for (const game of physicalGames) {
    const group = TEST_TEAM_GROUPS[Number(String(game.game_code).match(/^g-t-(\d+)$/)?.[1]) - 1];
    const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${group.homeKey}&simuNpb=1`;
    const cleaned = await f.request(`/api/test/scenario${query}`, {
      method: "POST", body: { scenario: "no-game" }, cookie
    });
    assert.equal(cleaned.response.status, 200);
  }
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games WHERE internal_game_id = ?").get(unrelatedId).count, 1);
  for (const game of physicalGames) {
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games WHERE internal_game_id = ?").get(game.internal_game_id).count, 0);
  }

  const cleanup = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup" }, cookie
  });
  assert.equal(cleanup.response.status, 200);
  assert.ok(["replay-blocked", "deleted"].includes(classifyE2ECleanupResult(cleanup.payload)));
});

test("normal synthetic user cannot operate scenario controls", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const register = await f.request("/api/auth/register", {
    method: "POST", body: { username: "e2e-normal", password: "Synthetic-Password-2026", passwordConfirmation: "Synthetic-Password-2026" }
  });
  assert.equal(register.response.status, 201);
  const cookie = (register.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const before = f.database.prepare("SELECT COUNT(*) AS count FROM games").get().count;
  const result = await f.request("/api/test/scenario", { method: "POST", body: { scenario: "no-game" }, cookie });
  assert.equal(result.response.status, 401);
  assert.equal(result.payload.code, "ADMIN_REQUIRED");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM games").get().count, before);
});

test("successful simulator cleanup can revoke admin access while retaining its ranking identity", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });

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
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  f.env.TEST_AUTH_DB_ID = "unknown-db-id";
  const result = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(result.response.status, 404);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("E2E admin endpoint is unavailable in production runtime", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  f.env.ENVIRONMENT = "production";
  const result = await testSiteWorker.fetch(new Request("https://starting9-auth.internal/api/test/e2e-admin", {
    method: "POST", headers: { Origin: "https://s9simu.pages.dev", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "provision" })
  }), f.env, { waitUntil() {} });
  assert.equal(result.status, 404);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("a session whose disposable admin role is missing cannot clean up as an admin", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const setup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  const cookie = (setup.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const username = setup.payload.username;
  f.database.prepare("UPDATE users SET role = 'user' WHERE username = ?").run(username);
  const cleanup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "cleanup" }, cookie });
  assert.equal(cleanup.response.status, 403);
  assert.equal(cleanup.payload.code, "E2E_ADMIN_REQUIRED");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = ?").get(username).count, 1);
});

test("OIDC cleanup is limited to the current run's reserved E2E identity", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const setup = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  const username = setup.payload.username;
  const cleaned = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup", runId: setup.runId },
    authorization: setup.authorizationToken, cookie: ""
  });
  assert.equal(cleaned.response.status, 200);
  assert.equal(cleaned.payload.removed, false);
  assert.ok(cleaned.payload.replayMarkerRetainedUntil);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = ?").get(username).count, 1);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
  const replay = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision", runId: setup.runId },
    authorization: setup.authorizationToken
  });
  assert.equal(replay.response.status, 409);
  assert.equal(replay.payload.code, "E2E_RUN_REPLAYED");
  assert.equal(f.database.prepare("SELECT role, status FROM users WHERE username = ?").get(username).role, "user");
  assert.equal(f.database.prepare("SELECT status FROM users WHERE username = ?").get(username).status, "disabled");

  const ordinary = await f.request("/api/auth/register", {
    method: "POST", body: { username: "e2e-normal", password: "Synthetic-Password-2026", passwordConfirmation: "Synthetic-Password-2026" }
  });
  assert.equal(ordinary.response.status, 201);
  const denied = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup", username: "e2e-normal" }, authorization: ""
  });
  assert.equal(denied.response.status, 404);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = 'e2e-normal'").get().count, 1);
});

test("OIDC cleanup is idempotent when a provision response was lost before account creation", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const proof = f.createOidcToken();
  const cleaned = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup", runId: proof.runId }, authorization: proof.token
  });
  assert.equal(cleaned.response.status, 200);
  assert.equal(cleaned.payload.alreadyAbsent, true);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("cleanup rejects a non-E2E admin before revoking or deleting its session", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
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
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const result = await f.request("/api/auth/register", {
    method: "POST",
    body: { username: "e2e-0123456789ab", password: "Synthetic-Password-2026", passwordConfirmation: "Synthetic-Password-2026" }
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.code, "TEST_USERNAME_RESERVED");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);
});

test("Team B fixture absence is rejected instead of falling back to Team A", async () => {
  assert.throws(() => createTestTeamWorker("missing-team"), /Unknown test target team/);
});
