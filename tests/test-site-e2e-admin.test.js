import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import testSiteWorker, { createTestTeamWorker } from "../tooling/test-site/worker.js";
import { handleSimulatedNpbRequest, simulatorGameDate } from "../tooling/test-site/simu-npb/source.js";
import { TEST_TEAM_GROUPS } from "../tooling/test-site/teams.js";
import { TEST_TEAMS } from "../tooling/test-site/teams.js";

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
  assert.equal(f.database.prepare("SELECT status, role FROM users WHERE id = ?").get(temporary.id).status, "disabled");
  assert.equal(f.database.prepare("SELECT role FROM users WHERE id = ?").get(temporary.id).role, "user");
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 0);
});

test("E2E provisioning rejects invalid, expired, wrong-workflow, and mismatched run proofs without writes", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const valid = f.createOidcToken();
  const invalidSignature = `${valid.token.slice(0, -1)}${valid.token.endsWith("a") ? "b" : "a"}`;
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

test("an expired replay marker is deleted by the next authorized provisioning run", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
  const first = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  const firstCookie = (first.response.headers.get("Set-Cookie") || "").split(";", 1)[0];
  const clean = await f.request("/api/test/e2e-admin", {
    method: "POST", body: { action: "cleanup" }, cookie: firstCookie
  });
  assert.equal(clean.payload.removed, false);
  f.database.prepare("UPDATE users SET updated_at = '2000-01-01T00:00:00.000Z' WHERE username = ?")
    .run(first.payload.username);

  const next = await f.request("/api/test/e2e-admin", { method: "POST", body: { action: "provision" } });
  assert.equal(next.response.status, 201);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users WHERE username = ?").get(first.payload.username).count, 0);
});

test("simulator schedule control reports the shared NPB fixture date", async (t) => {
  const f = await fixture();
  t.after(() => { f.restoreFetch(); f.database.close(); f.audit.close(); });
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
      SIMU_NPB_STATE: { async get() { return "pre-lineup"; } }
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
