import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TEST_TEAM_GROUPS, TEST_TEAMS, testPredictionPlayerId } from "./teams.js";
import { buildSyntheticPredictions } from "./auto-prediction-seeder.js";
import { assertTestAuthConfig, TEST_AUTH_DB_ID, TEST_AUDIT_DB_ID } from "./isolation.js";
import { classifyE2ECleanupResult } from "./cleanup-contract.js";
import { readScenarioState } from "./scenario-state.js";
import { FIGHTERS_REHEARSAL } from "./rehearsal-clock.js";
import { V3_TIMING } from "../../backend/automation-v3/constants.js";
import fs from "node:fs";

const SITE_ORIGIN = "https://s9simu.pages.dev";
const TARGET_ACCOUNT_ID = "02580fab1c09e144db7da89478e252c8";
const RUN_MODE = String(process.env.S9SIMU_MODE || "full").trim().toLowerCase();
assert.ok(["full", "schedule-check", "roster-only", "job-only", "sibling-check", "fighters-rehearsal", "prepare-unattended", "admin-diagnose", "admin-check"].includes(RUN_MODE), "S9SIMU_MODE must be full, schedule-check, roster-only, job-only, sibling-check, fighters-rehearsal, prepare-unattended, admin-diagnose, or admin-check");

const config = JSON.parse(fs.readFileSync(new URL("../../wrangler.test-auth.jsonc", import.meta.url), "utf8"));
assertTestAuthConfig(config);
assert.equal(config.d1_databases.find((binding) => binding.binding === "AUTH_DB")?.database_id, TEST_AUTH_DB_ID);
assert.equal(config.d1_databases.find((binding) => binding.binding === "AUDIT_DB")?.database_id, TEST_AUDIT_DB_ID);
// Account access is verified by the explicit TARGET-only deployment command.
// The remote workflow needs no Cloudflare credential; it receives only a
// short-lived GitHub OIDC token for this repository's manual main-branch run.
assert.equal(config.account_id, TARGET_ACCOUNT_ID);

let runId = "";
let temporaryAdminUsername = "";
const positions = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
let cookie = "";
let githubOidcToken = "";
let temporaryAdminCreated = false;
let temporaryUserRetained = false;
let primaryError = null;
let cleanupError = null;
let publishedContests = 0;
let lastScheduleDiagnostics = null;
const syntheticSessions = [];

async function call(path, { method = "GET", body, admin = false, authorizationToken = "", sessionCookie = "", expectedStatus = 200 } = {}) {
  const team = new URL(`https://local.invalid${path}`).searchParams.get("testTeam") || "fighters";
  const headers = {
    Origin: SITE_ORIGIN,
    Accept: "application/json",
    Cookie: `s9_test_team=${encodeURIComponent(team)}; s9_test_source=simu-npb`
  };
  if (new URL(`https://local.invalid${path}`).pathname === "/simu-npb/control") {
    headers["X-Simu-NPB-Write"] = "1";
  }
  if (admin && cookie) headers.Cookie += `; ${cookie}`;
  else if (sessionCookie) headers.Cookie += `; ${sessionCookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authorizationToken) headers.Authorization = `Bearer ${authorizationToken}`;
  const response = await fetch(`${SITE_ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual"
  });
  const payload = await response.json().catch(() => null);
  if (response.status !== expectedStatus) {
    const safeDetails = [payload?.reasonCode, payload?.stage, payload?.errorClass, payload?.databaseCode, payload?.constraint]
      .filter((value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value))
      .join("/");
    const reason = [payload?.code || payload?.error || "unexpected-response", safeDetails].filter(Boolean).join(":");
    throw new Error(`${method} ${new URL(path, SITE_ORIGIN).pathname} returned ${response.status} (${reason.slice(0, 180)})`);
  }
  return { response, payload };
}

async function provisionAdmin() {
  const unauthorized = await call("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision" }, expectedStatus: 404
  });
  assert.equal(unauthorized.payload.code, "NOT_FOUND");
  githubOidcToken = await requestGitHubOidcToken();
  const claims = decodeJwtPayload(githubOidcToken);
  runId = `${claims.run_id}:${claims.run_attempt}`;
  temporaryAdminUsername = deriveRunUsername(claims);
  temporaryAdminCreated = true;
  const response = await call("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision", runId },
    authorizationToken: githubOidcToken, expectedStatus: 201
  });
  assert.equal(response.payload.username, temporaryAdminUsername);
  cookie = response.response.headers.get("Set-Cookie")?.split(";", 1)[0] || "";
  assert.match(cookie, /^s9_session=/);
  const auth = await call("/api/auth/me?testTeam=fighters", { admin: true });
  assert.equal(auth.payload.authenticated, true);
  const isAdmin = await call("/api/admin/me?testTeam=fighters", { admin: true });
  assert.equal(isAdmin.payload.admin, true);
}

async function cleanupTemporaryAdmin() {
  if (!temporaryAdminCreated) return;
  const cleanup = await call("/api/test/e2e-admin", {
    method: "POST", body: {
      action: "cleanup",
      username: temporaryAdminUsername,
      preserveUser: primaryError === null && publishedContests === 12,
      runId
    },
    admin: Boolean(cookie), authorizationToken: cookie ? "" : githubOidcToken
  });
  const cleanupKind = classifyE2ECleanupResult(cleanup.payload);
  if (cleanupKind === "retained-user") {
    assert.equal(cleanup.payload.removed, false);
    temporaryUserRetained = true;
  } else if (cleanupKind === "deleted" || cleanupKind === "replay-blocked" || cleanupKind === "already-absent") {
    temporaryUserRetained = false;
  } else {
    assert.fail("E2E cleanup returned an unknown or contradictory outcome");
  }
  cookie = "";
  githubOidcToken = "";
  temporaryAdminCreated = false;
}

async function provisionSyntheticUsers(count, seed) {
  assert.equal(count, 10, "the rehearsal provisions one bounded batch of ten identities");
  const provisioning = await call("/api/test/admin/synthetic-users/provision?testTeam=fighters", {
    method: "POST", admin: true,
    body: { rehearsalId: "fighters-2026-10-25-1500", seed, count },
    expectedStatus: 200
  });
  assert.equal(provisioning.payload.ok, true);
  assert.equal(provisioning.payload.requested, count);
  assert.equal(provisioning.payload.created + provisioning.payload.reused, count);
  assert.equal(provisioning.payload.users.length, count);
  const sessions = provisioning.payload.users.map((user) => {
    assert.match(user.username, /^r[a-f0-9]{12}\d{2}$/);
    assert.match(user.userId, /^synthetic-[a-f0-9]{64}-\d{2}$/);
    assert.match(user.sessionCookie, /^s9_session=[A-Za-z0-9._~-]{16,256}$/);
    syntheticSessions.push(user.sessionCookie);
    return { username: user.username, userId: user.userId, session: user.sessionCookie };
  });
  assert.equal(new Set(sessions.map((user) => user.userId)).size, count);
  return { users: sessions, created: provisioning.payload.created, reused: provisioning.payload.reused };
}

async function logoutSyntheticUsers() {
  const sessions = syntheticSessions.splice(0);
  const failures = [];
  for (const sessionCookie of sessions) {
    try {
      await call("/api/auth/logout?testTeam=fighters", {
        method: "POST", sessionCookie, expectedStatus: 200
      });
    } catch {
      failures.push("logout_failed");
    }
  }
  if (failures.length) throw new Error(`SYNTHETIC_SESSION_CLEANUP_FAILED:${failures.length}`);
}

async function runAdminReproducibilityCheck() {
  await provisionAdmin();
  const firstCookie = cookie;
  const firstUsername = temporaryAdminUsername;
  await cleanupTemporaryAdmin();
  const replay = await call("/api/auth/me?testTeam=fighters", { sessionCookie: firstCookie, expectedStatus: 200 });
  assert.equal(replay.payload.authenticated, false, "cleanup revokes the first session");

  // A second GitHub OIDC token has a distinct jti, producing a new disposable
  // identity while retaining the same workflow run/attempt for auditability.
  await provisionAdmin();
  assert.notEqual(temporaryAdminUsername, firstUsername, "new proof receives a distinct temporary identity");
  const secondCookie = cookie;
  await cleanupTemporaryAdmin();
  const secondReplay = await call("/api/auth/me?testTeam=fighters", { sessionCookie: secondCookie, expectedStatus: 200 });
  assert.equal(secondReplay.payload.authenticated, false, "second cleanup revokes its session");
  assert.ok(firstCookie.startsWith("s9_session=") && secondCookie.startsWith("s9_session="));
  console.log("S9SIMU_ADMIN_REPRODUCIBILITY: provision A → cleanup A → revoked replay → provision B → cleanup B → revoked replay");
}

async function requestGitHubOidcToken() {
  const endpoint = String(process.env.ACTIONS_ID_TOKEN_REQUEST_URL || "");
  const requestToken = String(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || "");
  if (!endpoint || !requestToken) throw new Error("GitHub Actions OIDC is unavailable; run this from the authorized main workflow");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("GitHub Actions OIDC endpoint is invalid");
  url.searchParams.set("audience", "starting9-simu-e2e");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${requestToken}` }, cache: "no-store" });
  if (!response.ok) throw new Error(`GitHub Actions OIDC request failed (${response.status})`);
  const payload = await response.json();
  if (typeof payload?.value !== "string" || payload.value.length < 100) throw new Error("GitHub Actions OIDC response is invalid");
  return payload.value;
}

function decodeJwtPayload(token) {
  const segments = String(token).split(".");
  if (segments.length !== 3) throw new Error("GitHub Actions OIDC token is malformed");
  try {
    return JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("GitHub Actions OIDC claims are malformed");
  }
}

function deriveRunUsername(claims) {
  assert.equal(claims.iss, "https://token.actions.githubusercontent.com");
  assert.equal(claims.aud, "starting9-simu-e2e");
  assert.equal(claims.sub, "repo:tanzana7/starting9:ref:refs/heads/main");
  assert.equal(claims.repository, "tanzana7/starting9");
  assert.equal(String(claims.repository_id), "1293016764");
  assert.equal(claims.ref, "refs/heads/main");
  assert.equal(claims.event_name, "workflow_dispatch");
  assert.equal(claims.workflow_ref,
    "tanzana7/starting9/.github/workflows/s9simu-remote-e2e.yml@refs/heads/main");
  assert.match(String(claims.run_id || ""), /^\d{1,20}$/);
  assert.match(String(claims.run_attempt || ""), /^[1-9]\d{0,5}$/);
  assert.ok(typeof claims.jti === "string" && claims.jti.length >= 8);
  const suffix = createHash("sha256")
    .update(`${claims.repository_id}:${claims.run_id}:${claims.run_attempt}:${claims.jti}`)
    .digest().subarray(0, 6).toString("hex");
  return `e2e-${suffix}`;
}

async function savePrediction(teamKey, internalGameId) {
  const query = `?internalGameId=${encodeURIComponent(internalGameId)}&testTeam=${teamKey}&simuNpb=1`;
  const roster = await call(`/api/game-day-roster${query}`, { admin: true });
  assert.equal(roster.payload.players?.length, 15, `${teamKey}: simulator roster should contain 15 parsed players`);
  assert.ok(roster.payload.players.every((player) => player.teamCode === teamKey), `${teamKey}: roster identity must stay scoped`);
  assert.ok(roster.payload.players.every((player) => /^npb:\d{8}$/.test(player.playerId)), `${teamKey}: parsed simulator NPB identities must remain intact`);
  const lineup = roster.payload.players.slice(0, 9).map((player, index) => ({
    // Keep fake NPB IDs observable in the parsed source above, but submit the
    // same team-number IDs accepted by the public prediction form. This avoids
    // coupling synthetic predictions to the separate live-roster trust cache.
    playerId: testPredictionPlayerId(teamKey, player.uniformNumber || player.number),
    playerName: player.name,
    uniformNumber: player.uniformNumber || player.number,
    teamCode: teamKey,
    teamId: TEST_TEAMS[teamKey].playerTeamId,
    battingOrder: index + 1,
    position: positions[index]
  }));
  const prediction = await call(`/api/predictions/current${query}`, {
    method: "PUT", admin: true,
    body: { internalGameId, prediction: { schemaVersion: 1, lineup } }
  });
  assert.equal(prediction.payload.ok, true, `${teamKey}: prediction save should succeed`);
  assert.equal(prediction.payload.status, "submitted");
}

async function advance(teamKey, internalGameId, scenario, now, expectedState) {
  const query = `?internalGameId=${encodeURIComponent(internalGameId)}&testTeam=${teamKey}&simuNpb=1`;
  let last;
  const pipelineDiagnosticsHistory = [];
  for (let pass = 0; pass < 6; pass += 1) {
    const result = await call(`/api/test/scenario${query}`, {
      method: "POST", admin: true,
      body: { scenario, stageOnly: true, now: now.toISOString() }
    });
    last = result.payload;
    if (last?.pipelineDiagnostics) pipelineDiagnosticsHistory.push(last.pipelineDiagnostics);
    if (last?.game?.state === expectedState) {
      return {
        ...last.game,
        pipelineDiagnostics: last.pipelineDiagnostics || null,
        pipelineDiagnosticsHistory
      };
    }
  }
  const jobs = await call(`/api/test/jobs${query}`, { admin: true });
  throw new Error(`${teamKey}/${scenario} did not reach ${expectedState}: ${JSON.stringify({
    actualState: last?.game?.state || "no-state",
    pipelineDiagnostics: last?.pipelineDiagnostics || null,
    jobs: jobs.payload.jobs
  })}`);
}

async function verifyPublished(teamKey, internalGameId) {
  const query = `?internalGameId=${encodeURIComponent(internalGameId)}&testTeam=${teamKey}&simuNpb=1`;
  const history = await call(`/api/results/games${query}`, { admin: true });
  assert.ok(history.payload.games?.some((game) => game.internalGameId === internalGameId), `${teamKey}: published history row missing`);
  const detail = await call(`/api/results/games/${encodeURIComponent(internalGameId)}${query}`, { admin: true });
  assert.equal(detail.payload.internalGameId, internalGameId);
  assert.equal(detail.payload.actualLineup?.length, 9);
  assert.ok(detail.payload.actualLineup.every((player) => player.teamCode === teamKey), `${teamKey}: published lineup crossed team boundary`);
  const jobs = await call(`/api/test/jobs${query}`, { admin: true });
  assert.ok(jobs.payload.jobs.length > 0);
  const required = new Set(["prediction_close", "lineup_finalize", "score", "ranking_rebuild", "publish"]);
  for (const type of required) {
    assert.ok(jobs.payload.jobs.some((job) => job.job_type === type && job.status === "completed"),
      `${teamKey}: required ${type} job did not complete`);
  }
  assert.ok(jobs.payload.jobs.some((job) => job.job_type === "lineup_fetch" && job.status === "completed"),
    `${teamKey}: official lineup fetch did not complete`);
  assert.ok(jobs.payload.jobs.every((job) => !["claimed", "retry_wait", "failed"].includes(job.status)),
    `${teamKey}: broken formal job state remains`);
}

async function fetchSimulatorSchedule({ requireFreshSync = false } = {}) {
  const response = await call("/api/test/simu/schedule?testTeam=fighters", {
    method: "POST", body: {}, admin: true
  });
  const physicalGames = response.payload.physicalGames || [];
  assert.equal(physicalGames.length, 6);
  assert.equal(response.payload.contestCount, 12);
  for (const game of physicalGames) {
    assert.ok(game.internal_game_id, `simulator ${game.game_code}: schedule internal identity`);
    assert.equal(game.persisted_internal_game_id, game.internal_game_id,
      `simulator ${game.game_code}: detected schedule must resolve to the persisted product game`);
    assert.equal(game.provider_game_id, game.game_code,
      `simulator ${game.game_code}: persisted provider identity must match the simulator source`);
    assert.equal(Number(game.persisted_contest_count), 2,
      `simulator ${game.game_code}: one physical game must have exactly two persisted contests`);
    const group = simulatorGroupForGame(game);
    assert.deepEqual(String(game.persisted_contest_teams || "").split(",").sort(), [group.homeKey, group.awayKey].sort(),
      `simulator ${game.game_code}: persisted contests must match both source teams`);
  }
  const diagnostics = response.payload.scheduleDiagnostics || {};
  assert.equal(diagnostics.requestedDate, response.payload.date);
  if (requireFreshSync || diagnostics.rawGamesCount !== null) {
    assert.match(String(diagnostics.upstreamPath || ""), /^\/simu-npb\/api\/public\/games\?date=\d{4}-\d{2}-\d{2}&team=all$/);
    assert.equal(diagnostics.upstreamStatus, 200);
    assert.match(String(diagnostics.contentType || ""), /application\/json/i);
    for (const key of ["rawGamesCount", "parsedGamesCount", "filteredGamesCount", "normalizedGamesCount", "attemptedUpsertCount"]) {
      assert.equal(diagnostics[key], 6, `schedule diagnostic ${key}`);
    }
    assert.equal(diagnostics.readBackCount, 6);
    assert.equal(new Set(diagnostics.internalGameIds).size, 6);
  }
  lastScheduleDiagnostics = diagnostics;
  return physicalGames;
}

async function runSiblingCheck() {
  let physicalGames = await fetchSimulatorSchedule();
  let game = physicalGames.find((item) => item.game_code === "g-t-1");
  assert.ok(game, "same-game sibling check requires the Giants/Tigers fixture");
  let group = simulatorGroupForGame(game);
  assert.equal(group.homeKey, "giants");
  assert.equal(group.awayKey, "tigers");

  // A previous failed sibling run may leave exactly Giants=published and
  // Tigers=prediction_closed. Only clean that known partial shape; never erase
  // an unrelated or otherwise advanced Test fixture on this shared game.
  const prior = new Map();
  for (const teamKey of [group.homeKey, group.awayKey]) {
    const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${teamKey}&simuNpb=1`;
    const [jobs, status, prediction] = await Promise.all([
      call(`/api/test/jobs${query}`, { admin: true }),
      call(`/api/test/status${query}`),
      call(`/api/predictions/current${query}`, { admin: true })
    ]);
    const state = readScenarioState(status.payload.game);
    prior.set(teamKey, {
      jobs: jobs.payload.jobs || [],
      ...state,
      prediction: Boolean(prediction.payload?.prediction)
    });
  }
  const hasPriorState = [...prior.values()].some((entry) => entry.jobs.length
    || entry.prediction || entry.effectiveState !== "scheduled");
  if (hasPriorState) {
    const giants = prior.get("giants");
    const tigers = prior.get("tigers");
    const giantsPublished = giants?.effectiveState === "published"
      && giants.jobs.some((job) => job.job_type === "publish" && job.status === "completed");
    const tigersClosed = tigers?.effectiveState === "prediction_closed"
      && tigers.jobs.some((job) => job.job_type === "prediction_close" && job.status === "completed")
      && !tigers.jobs.some((job) => job.job_type === "lineup_fetch" && ["claimed", "pending", "retry_wait"].includes(job.status));
    assert.ok(giantsPublished && tigersClosed,
      "SIBLING_FIXTURE_CLEANUP_UNSAFE: refusing to remove a Test fixture that is not the known partial Giants-published/Tigers-closed run");
    const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${group.homeKey}&simuNpb=1`;
    const cleared = await call(`/api/test/scenario${query}`, {
      method: "POST", body: { scenario: "no-game" }, admin: true
    });
    assert.equal(cleared.payload.scenario, "no-game");
    physicalGames = await fetchSimulatorSchedule();
    game = physicalGames.find((item) => item.game_code === "g-t-1");
    assert.ok(game);
    group = simulatorGroupForGame(game);
    for (const teamKey of [group.homeKey, group.awayKey]) {
      const teamQuery = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${teamKey}&simuNpb=1`;
      const [jobs, status, prediction] = await Promise.all([
        call(`/api/test/jobs${teamQuery}`, { admin: true }),
        call(`/api/test/status${teamQuery}`),
        call(`/api/predictions/current${teamQuery}`, { admin: true })
      ]);
      assert.equal(jobs.payload.jobs.length, 0, `${teamKey}: prior jobs removed`);
      const state = readScenarioState(status.payload.game);
      assert.equal(state.effectiveState, "scheduled", `${teamKey}: effective baseline state`);
      assert.ok(state.rawState === null || state.rawState === "scheduled",
        `${teamKey}: raw state is absent or explicitly scheduled`);
      assert.equal(Boolean(prediction.payload?.prediction), false, `${teamKey}: prediction removed`);
      console.log(`S9SIMU_CLEANUP_BASELINE: ${JSON.stringify({ team: teamKey, rawState: state.rawState, effectiveState: state.effectiveState })}`);
    }
    console.log(`S9SIMU_SIBLING_FIXTURE_CLEANUP: ${JSON.stringify({ gameCode: game.game_code, scopedTeams: [group.homeKey, group.awayKey], verified: true })}`);
  }

  for (const teamKey of [group.homeKey, group.awayKey]) await savePrediction(teamKey, game.internal_game_id);
  const startAt = new Date(game.start_at);
  assert.ok(Number.isFinite(startAt.getTime()));
  const closedAt = new Date(startAt.getTime() - 59 * 60_000);
  for (const teamKey of [group.homeKey, group.awayKey]) {
    const closed = await advance(teamKey, game.internal_game_id, "closed", closedAt, "prediction_closed");
    assert.equal(closed.state, "prediction_closed");
  }
  const control = await call("/simu-npb/control", { method: "POST", body: { lineupState: "available" }, admin: true });
  assert.equal(control.payload.lineupState, "available");
  const postGame = new Date(startAt.getTime() + 10 * 60_000);

  const first = await advance(group.homeKey, game.internal_game_id, "lineup-captured", postGame, "lineup_ready");
  assert.equal(first.state, "lineup_ready");
  const firstTeamStatus = await call(`/api/test/status?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${group.homeKey}`);
  assert.equal(firstTeamStatus.payload.game.state, "lineup_ready");
  await advance(group.homeKey, game.internal_game_id, "scored", postGame, "scored");
  await advance(group.homeKey, game.internal_game_id, "ranked", postGame, "ranked");
  await advance(group.homeKey, game.internal_game_id, "published", postGame, "published");
  await verifyPublished(group.homeKey, game.internal_game_id);

  const siblingBefore = await call(`/api/test/status?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${group.awayKey}`);
  assert.equal(siblingBefore.payload.game.state, "prediction_closed", "publishing one contest leaves sibling closed");
  const sibling = await advance(group.awayKey, game.internal_game_id, "lineup-captured", postGame, "lineup_ready");
  assert.equal(sibling.state, "lineup_ready");
  assert.equal(sibling.pipelineDiagnostics?.targetTeam, group.awayKey);
  assert.equal(sibling.pipelineDiagnostics?.stateBefore, "prediction_closed");
  assert.equal(sibling.pipelineDiagnostics?.lineupPersisted, true);

  console.log(`S9SIMU_SIBLING_CHECK: ${JSON.stringify({
    physicalGame: game.internal_game_id,
    gameCode: game.game_code,
    contests: [
      { team: group.homeKey, state: "published" },
      { team: group.awayKey, state: sibling.state }
    ],
    siblingIndependent: sibling.state === "lineup_ready"
  })}`);
}

async function runLineupJobOnlyCheck() {
  const physicalGames = await fetchSimulatorSchedule();
  const game = physicalGames.find((item) => item.game_code === "g-t-1");
  assert.ok(game, "job-only check requires the Giants/Tigers fixture");
  const group = simulatorGroupForGame(game);
  assert.equal(group.homeKey, "giants");
  assert.equal(group.awayKey, "tigers");
  const teams = [group.homeKey, group.awayKey];
  const queryFor = (teamKey) => `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${teamKey}&simuNpb=1`;

  // The one-game diagnostic must start from a known isolated fixture. Cleanup
  // is scoped to this canonical game and is repeated in finally on failure.
  for (const teamKey of teams) {
    const [jobs, status, prediction] = await Promise.all([
      call(`/api/test/jobs${queryFor(teamKey)}`, { admin: true }),
      call(`/api/test/status${queryFor(teamKey)}`),
      call(`/api/predictions/current${queryFor(teamKey)}`, { admin: true })
    ]);
    if (jobs.payload.jobs.length || prediction.payload?.prediction
      || (status.payload.game?.state && status.payload.game.state !== "scheduled")) {
      await call(`/api/test/scenario${queryFor(group.homeKey)}`, {
        method: "POST", body: { scenario: "no-game" }, admin: true
      });
      break;
    }
  }

  let checkError = null;
  try {
    for (const teamKey of teams) await savePrediction(teamKey, game.internal_game_id);
    const startAt = new Date(game.start_at);
    assert.ok(Number.isFinite(startAt.getTime()), "canonical game start time required");
    const closedAt = new Date(startAt.getTime() - 59 * 60_000);
    for (const teamKey of teams) {
      const closed = await advance(teamKey, game.internal_game_id, "closed", closedAt, "prediction_closed");
      assert.equal(closed.state, "prediction_closed");
    }
    const control = await call("/simu-npb/control", { method: "POST", body: { lineupState: "available" }, admin: true });
    assert.equal(control.payload.lineupState, "available");
    const postGame = new Date(startAt.getTime() + 10 * 60_000);
    const outcomes = [];

    for (const teamKey of teams) {
      const query = queryFor(teamKey);
      const before = await call(`/api/test/jobs${query}`, { admin: true });
      const contestId = before.payload.contestId;
      assert.ok(contestId, `${teamKey}: canonical contest ID read-back`);
      const lineupJobBefore = before.payload.jobs.find((job) => job.job_type === "lineup_fetch") || null;

      const result = await advance(teamKey, game.internal_game_id, "lineup-captured", postGame, "lineup_ready");
      assert.equal(result.state, "lineup_ready", `${teamKey}: workflow advances after execution`);
      assert.equal(result.pipelineDiagnostics?.targetTeam, teamKey);
      assert.equal(result.pipelineDiagnostics?.lineupPersisted, true);
      const teamDiagnostics = result.pipelineDiagnosticsHistory.filter((entry) => entry.targetTeam === teamKey);
      const lineupPlans = teamDiagnostics.flatMap((entry) => entry.lineupFetchPlans || [])
        .filter((plan) => plan.targetTeam === teamKey);
      assert.ok(lineupPlans.length, `${teamKey}: planner exposes the lineup_fetch decision`);
      assert.equal(lineupPlans.some((plan) => plan.due), true, `${teamKey}: lineup_fetch is due at the simulated post-game time`);
      assert.ok(lineupPlans.some((plan) => plan.shouldCreateJob) || lineupJobBefore,
        `${teamKey}: planner creates the contest job or a prior contest-scoped job already exists`);
      assert.ok(teamDiagnostics.some((entry) => entry.claimedJobTypes?.includes("lineup_fetch")), `${teamKey}: lineup job was claimed`);
      assert.ok(teamDiagnostics.some((entry) => entry.claimedContestIds?.includes(contestId)), `${teamKey}: claim is scoped to its own contest`);
      const after = await call(`/api/test/jobs${query}`, { admin: true });
      assert.ok(after.payload.jobs.some((job) => job.job_type === "lineup_fetch" && job.status === "completed"),
        `${teamKey}: lineup_fetch completed`);
      outcomes.push({ team: teamKey, contestId, claimedOnlyOwnContest: true, lineupReady: true });
    }
    assert.equal(outcomes.length, 2);
    console.log(`S9SIMU_LINEUP_JOB_ONLY: ${JSON.stringify({ physicalGame: game.internal_game_id, gameCode: game.game_code, outcomes })}`);
  } catch (error) {
    checkError = error;
  } finally {
    try {
      await call(`/api/test/scenario${queryFor(group.homeKey)}`, {
        method: "POST", body: { scenario: "no-game" }, admin: true
      });
    } catch (cleanupError) {
      if (checkError) throw new AggregateError([checkError, cleanupError], "lineup job-only check and fixture cleanup failed");
      throw cleanupError;
    }
  }
  if (checkError) throw checkError;
}

async function runRosterOnlyCheck() {
  const physicalGames = await fetchSimulatorSchedule();
  // Use a non-first physical game so the assertion cannot pass via a default
  // or first-fixture fallback. The provider code is the simulator namespace;
  // all application and cleanup calls continue to use the persisted internal ID.
  const game = physicalGames[1];
  assert.ok(game, "roster-only check requires a non-first physical game");
  const providerGameId = String(game.game_code || "");
  const group = simulatorGroupForGame(game);
  const queryFor = (teamKey) => `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${teamKey}&simuNpb=1`;
  let checkError = null;
  try {
    for (const teamKey of [group.homeKey, group.awayKey]) {
      const roster = await call(`/api/game-day-roster${queryFor(teamKey)}`, { admin: true });
      assert.equal(roster.payload.players?.length, 15, `${teamKey}: simulator roster should contain 15 players`);
      assert.ok(roster.payload.players.every((player) => player.teamCode === teamKey), `${teamKey}: roster must match the persisted contest`);
      console.log(`S9SIMU_ROSTER_IDENTITY: ${JSON.stringify({
        providerGameId, internalGameId: game.internal_game_id, contestTeam: teamKey,
        lookupNamespace: "internalGameId->persisted npb_game_code", found: true, playerCount: roster.payload.players.length
      })}`);
    }
  } catch (error) {
    checkError = error;
  } finally {
    try {
      const cleanup = await call(`/api/test/scenario${queryFor(group.homeKey)}`, {
        method: "POST", admin: true, body: { scenario: "no-game" }
      });
      assert.equal(cleanup.payload.scenario, "no-game");
    } catch (cleanupError) {
      if (checkError) throw new AggregateError([checkError, cleanupError], "roster-only check and dynamic fixture cleanup failed");
      throw cleanupError;
    }
  }
  if (checkError) throw checkError;
  console.log(`S9SIMU_ROSTER_ONLY_COMPLETE: ${JSON.stringify({ providerGameId, internalGameId: game.internal_game_id, teams: [group.homeKey, group.awayKey], cleanup: "completed" })}`);
}

async function runFightersOperationalRehearsal({ prepareOnly = false } = {}) {
  const physicalGames = await fetchSimulatorSchedule({ requireFreshSync: true });
  const game = physicalGames.find((item) => item.game_code === "g-t-4");
  assert.ok(game, "Fighters rehearsal requires the Hawks/Fighters physical game");
  const group = simulatorGroupForGame(game);
  assert.equal(group.homeKey, "hawks");
  assert.equal(group.awayKey, "fighters");
  const startAt = new Date(game.start_at);
  assert.equal(startAt.toISOString(), "2026-10-25T06:00:00.000Z", "fixture must be 2026-10-25 15:00 JST");
  const queryFor = (teamKey) => `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${teamKey}&simuNpb=1`;

  const fightersQuery = queryFor("fighters");
  const hawksQuery = queryFor("hawks");
  const [fightersBeforeJobs, fightersBeforeStatus, hawksBeforeJobs, hawksBeforeStatus] = await Promise.all([
    call(`/api/test/jobs${fightersQuery}`, { admin: true }),
    call(`/api/test/status${fightersQuery}`),
    call(`/api/test/jobs${hawksQuery}`, { admin: true }),
    call(`/api/test/status${hawksQuery}`)
  ]);
  const fightersContestId = String(fightersBeforeJobs.payload.contestId || "");
  const hawksContestId = String(hawksBeforeJobs.payload.contestId || "");
  assert.ok(fightersContestId && hawksContestId && fightersContestId !== hawksContestId);
  const fightersSnapshot = await call(`/api/test/rehearsal/snapshot${fightersQuery}`, { admin: true });
  const hawksSnapshot = await call(`/api/test/rehearsal/snapshot${hawksQuery}`, { admin: true });
  for (const [teamKey, identity] of [["fighters", fightersSnapshot.payload], ["hawks", hawksSnapshot.payload]]) {
    assert.equal(identity.environment, "test");
    assert.equal(identity.expectedAccountId, "02580fab1c09e144db7da89478e252c8");
    assert.equal(identity.workerName, "starting9-test-auth");
    assert.equal(identity.authDatabaseId, "7ea1fa14-ffc0-4404-8a65-5dbb8218f368");
    assert.equal(identity.siteId, "starting9-isolated-v1");
    assert.equal(identity.targetTeam, teamKey);
  }
  assert.equal(fightersSnapshot.payload.snapshot.contestId, fightersContestId);
  const fightersState = readScenarioState(fightersBeforeStatus.payload.game).effectiveState;
  assert.equal(readScenarioState(hawksBeforeStatus.payload.game).effectiveState, "published",
    "the prior Hawks sibling publication must be preserved");
  assert.equal(hawksBeforeStatus.payload.game.publication_status, "published");
  let resetResult;
  const resetPerformed = fightersState === "published";
  if (resetPerformed) {
    assert.equal(fightersBeforeStatus.payload.game.publication_status, "published");
    const reset = await call(`/api/test/rehearsal/reset-fighters${fightersQuery}`, {
      method: "POST", admin: true,
      body: { expectedContestId: fightersContestId, expectedSiblingContestId: hawksContestId }
    });
    resetResult = reset.payload;
  } else {
    // The prior authorized rehearsal already reset Fighters before it stopped
    // at public registration throttling. Accept only a verified empty baseline
    // instead of repeating that Test-only destructive reset.
    assert.equal(fightersState, "scheduled", "only published or freshly reset Fighters state is valid");
    const target = fightersSnapshot.payload.snapshot;
    assert.equal(target.predictionCount, 0);
    assert.equal(target.lineupCount, 0);
    assert.equal(target.scoringCount, 0);
    assert.equal(target.rankingCount, 0);
    assert.equal(target.publicationCount, 0);
    assert.equal(target.formalJobCount, 0);
    assert.equal(fightersBeforeJobs.payload.jobs.length, 0);
    resetResult = { ok: true, targetAfter: target,
      siblingBefore: hawksSnapshot.payload.snapshot, siblingAfter: hawksSnapshot.payload.snapshot };
  }
  assert.equal(resetResult.ok, true, `Fighters-only contest reset/baseline: ${JSON.stringify(resetResult)}`);
  assert.equal(resetResult.targetAfter.state, "scheduled");
  assert.equal(resetResult.targetAfter.predictionCount, 0);
  assert.equal(resetResult.targetAfter.lineupCount, 0);
  assert.equal(resetResult.targetAfter.scoringCount, 0);
  assert.equal(resetResult.targetAfter.rankingCount, 0);
  assert.equal(resetResult.targetAfter.publicationCount, 0);
  assert.equal(resetResult.targetAfter.formalJobCount, 0);
  assert.deepEqual(resetResult.siblingAfter, resetResult.siblingBefore,
    "contest-only reset must preserve published Hawks state and result fingerprint");
  const preservedHawksSnapshot = resetResult.siblingBefore;
  const assertHawksPreserved = async (phase) => {
    const response = await call(`/api/test/rehearsal/snapshot${hawksQuery}`, { admin: true });
    assert.equal(response.payload.ok, true, `${phase}: Hawks read-only snapshot`);
    assert.deepEqual(response.payload.snapshot, preservedHawksSnapshot,
      `${phase}: published Hawks contest must remain byte-equivalent at the scoped data boundary`);
  };
  const [fightersAfterJobs, fightersAfterPrediction, baselineStatus] = await Promise.all([
    call(`/api/test/jobs${fightersQuery}`, { admin: true }),
    call(`/api/predictions/current${fightersQuery}`, { admin: true }),
    call(`/api/test/status${fightersQuery}`)
  ]);
  assert.equal(readScenarioState(baselineStatus.payload.game).effectiveState, "scheduled");
  assert.equal(Boolean(fightersAfterPrediction.payload?.prediction), false,
    "Fighters predictions must be absent after the scoped reset");
  assert.equal(fightersAfterJobs.payload.jobs.length, 0, "Fighters formal jobs must be absent after reset");
  await assertHawksPreserved("after-reset");

  const rosterResponse = await call(`/api/game-day-roster${fightersQuery}`, { admin: true });
  const roster = rosterResponse.payload.players || [];
  assert.equal(roster.length, 15, "Fighters roster must contain 15 source players");
  assert.ok(roster.every((player) => player.teamCode === "fighters"
    && player.teamId === TEST_TEAMS.fighters.playerTeamId), "roster identity must remain Fighters-scoped");
  assert.equal(new Set(roster.map((player) => player.playerId)).size, 15);

  if (prepareOnly) {
    const [baselineJobs, baselineStatus, baselinePrediction, finalFightersSnapshot, finalHawksSnapshot] = await Promise.all([
      call(`/api/test/jobs${fightersQuery}`, { admin: true }),
      call(`/api/test/status${fightersQuery}`),
      call(`/api/predictions/current${fightersQuery}`, { admin: true }),
      call(`/api/test/rehearsal/snapshot${fightersQuery}`, { admin: true }),
      call(`/api/test/rehearsal/snapshot${hawksQuery}`, { admin: true })
    ]);
    const baseline = finalFightersSnapshot.payload.snapshot;
    assert.equal(readScenarioState(baselineStatus.payload.game).effectiveState, "scheduled");
    assert.ok([null, "pending"].includes(baselineStatus.payload.game.publication_status),
      "an unpublished baseline may have no persisted status or an explicit pending status");
    assert.ok([null, undefined].includes(baselinePrediction.payload?.prediction),
      "an empty prediction baseline may be represented as null or omitted");
    assert.equal(baseline.predictionCount, 0);
    assert.equal(baseline.lineupCount, 0);
    assert.equal(baseline.scoringCount, 0);
    assert.equal(baseline.rankingCount, 0);
    assert.equal(baseline.publicationCount, 0);
    assert.equal(baseline.formalJobCount, 0);
    assert.equal(baselineJobs.payload.jobs.length, 0);
    assert.deepEqual(finalHawksSnapshot.payload.snapshot, preservedHawksSnapshot,
      "Fighters preparation must leave the published Hawks contest fingerprint unchanged");
    console.log(`FIGHTERS_UNATTENDED_BASELINE_ARMED: ${JSON.stringify({
      scenario: "fighters-2026-10-25-1500", date: FIGHTERS_REHEARSAL.date,
      startAt: game.start_at, providerGameId: game.game_code, internalGameId: game.internal_game_id,
      contestId: fightersContestId, fightersState: "scheduled", predictions: 0,
      formalJobs: 0, rosterCount: roster.length, hawksState: "published",
      hawksFingerprint: preservedHawksSnapshot.fingerprint, resetPerformed
    })}`);
    return;
  }

  const contestId = fightersContestId;
  const seed = 20261025;
  const predictions = buildSyntheticPredictions({ contestId, targetTeam: "fighters", roster, userCount: 10, seed });
  const syntheticUserProvisioning = await provisionSyntheticUsers(predictions.length, seed);
  const users = syntheticUserProvisioning.users;
  const cutoff = new Date(startAt.getTime() - V3_TIMING.predictionDeadlineMinutes * 60_000);
  const beforeCutoff = new Date(cutoff.getTime() - 1);
  const testWrite = async (user, prediction, logicalNow) => call(`/api/test/prediction-write${fightersQuery}`, {
    method: "POST", admin: true,
    body: { sessionCookie: user.session, prediction, logicalNow: logicalNow.toISOString() }
  });

  let saved = 0;
  for (const [index, entry] of predictions.entries()) {
    const result = await testWrite(users[index], entry.prediction, beforeCutoff);
    assert.equal(result.payload.ok, true, `${entry.label}: normal prediction path should accept before cutoff`);
    assert.equal(result.payload.status, 200);
    assert.equal(result.payload.predictionStatus, "submitted");
    saved += 1;
  }
  assert.equal(saved, 10);
  await assertHawksPreserved("after-prediction-seeding");

  for (const [index, user] of users.entries()) {
    const readBack = await call(`/api/predictions/current${fightersQuery}`, { sessionCookie: user.session });
    assert.equal(readBack.payload.prediction?.lineup?.length, 9, `synthetic user ${index + 1}: prediction read-back`);
  }

  const cutoffResult = await testWrite(users[0], predictions[0].prediction, cutoff);
  assert.equal(cutoffResult.payload.ok, false);
  assert.equal(cutoffResult.payload.status, 409);
  assert.equal(cutoffResult.payload.code, "PREDICTION_DEADLINE_PASSED");
  const afterCutoff = new Date(cutoff.getTime() + 1);
  const afterResult = await testWrite(users[0], predictions[0].prediction, afterCutoff);
  assert.equal(afterResult.payload.ok, false);
  assert.equal(afterResult.payload.status, 409);
  assert.equal(afterResult.payload.code, "PREDICTION_DEADLINE_PASSED");

  const closed = await advance("fighters", game.internal_game_id, "closed", cutoff, "prediction_closed");
  assert.equal(closed.state, "prediction_closed");
  await assertHawksPreserved("after-prediction-close");
  const control = await call("/simu-npb/control", { method: "POST", body: { lineupState: "available" }, admin: true });
  assert.equal(control.payload.lineupState, "available");
  const lineupAt = new Date(startAt.getTime() + 10 * 60_000);
  const captured = await advance("fighters", game.internal_game_id, "lineup-captured", lineupAt, "lineup_ready");
  assert.equal(captured.state, "lineup_ready");
  assert.equal(captured.pipelineDiagnostics?.lineupPersisted, true);
  await assertHawksPreserved("after-lineup-capture");
  const scoring = await call(`/api/test/scenario${fightersQuery}`, {
    method: "POST", admin: true,
    body: { scenario: "scored", stageOnly: true, now: lineupAt.toISOString() }
  });
  assert.ok(scoring.payload.ok, "formal score stage should complete");
  await assertHawksPreserved("after-scoring");
  const scoringJobs = await call(`/api/test/jobs${fightersQuery}`, { admin: true });
  assert.ok(scoringJobs.payload.jobs.some((job) => job.job_type === "score" && job.status === "completed"),
    "formal score job must be completed before ranking");
  const ranked = await advance("fighters", game.internal_game_id, "ranked", lineupAt, "ranked");
  assert.equal(ranked.state, "ranked");
  await assertHawksPreserved("after-ranking");
  const published = await advance("fighters", game.internal_game_id, "published", lineupAt, "published");
  assert.equal(published.publication_status, "published");
  await assertHawksPreserved("after-publication");

  const detailReadbacks = [];
  for (const user of users) {
    const detail = await call(`/api/results/games/${encodeURIComponent(game.internal_game_id)}${fightersQuery}`, {
      sessionCookie: user.session
    });
    assert.equal(detail.payload.resultsPublished, true);
    assert.equal(detail.payload.actualLineup?.length, 9);
    assert.equal(detail.payload.status, "scored");
    detailReadbacks.push(Number(detail.payload.score));
  }
  assert.equal(detailReadbacks.length, 10);
  assert.ok(detailReadbacks.every(Number.isFinite));
  assert.ok(new Set(detailReadbacks).size > 1, "scoring must produce ranking-relevant score variation");
  const finalJobs = await call(`/api/test/jobs${fightersQuery}`, { admin: true });
  const required = new Set(["prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]);
  for (const type of required) {
    assert.ok(finalJobs.payload.jobs.some((job) => job.job_type === type && job.status === "completed"), `${type}: completed`);
  }
  assert.ok(finalJobs.payload.jobs.every((job) => !["claimed", "retry_wait", "failed"].includes(job.status)),
    "no failed, retry_wait, or leased job may remain");

  const sibling = await call(`/api/test/status${hawksQuery}`);
  assert.equal(readScenarioState(sibling.payload.game).effectiveState, "published");
  await assertHawksPreserved("final-readback");

  await logoutSyntheticUsers();
  for (const user of users) {
    const auth = await call("/api/auth/me?testTeam=fighters", { sessionCookie: user.session });
    assert.equal(auth.payload.authenticated, false, "synthetic sessions are revoked after the run");
  }
  publishedContests = 1;
  console.log(`FIGHTERS_REHEARSAL_COMPLETE: ${JSON.stringify({
    date: "2026-10-25", startAt: game.start_at, opponent: "hawks", providerGameId: game.game_code,
    internalGameId: game.internal_game_id, contestId, seed, users: 10,
    usersCreated: syntheticUserProvisioning.created, usersReused: syntheticUserProvisioning.reused,
    publicRegisterRequests: 0, fightersResetPerformed: resetPerformed, saved,
    cutoffMinus1: beforeCutoff.toISOString(), cutoff: cutoff.toISOString(), cutoffPlus1: afterCutoff.toISOString(),
    lineupAt: lineupAt.toISOString(), lineupPlayers: 9, scores: detailReadbacks,
    completedJobs: finalJobs.payload.jobs.filter((job) => job.status === "completed").length,
    siblingState: "published", siblingFingerprint: preservedHawksSnapshot.fingerprint,
    sessionsRevoked: users.length
  })}`);
}

function simulatorGroupForGame(game) {
  const match = String(game.game_code || "").match(/^g-t-(\d+)$/);
  assert.ok(match, "schedule parser should preserve each simulator game code");
  const group = TEST_TEAM_GROUPS[Number(match[1]) - 1];
  assert.ok(group, "simulator game code must map to one of the six physical games");
  assert.ok(game.internal_game_id, "simulator schedule must return its canonical internal game ID");
  assert.equal(game.home_team, TEST_TEAMS[group.homeKey].key);
  assert.equal(game.away_team, TEST_TEAMS[group.awayKey].key);
  return group;
}

try {
  if (RUN_MODE === "admin-diagnose") {
    await provisionAdmin();
    console.log("S9SIMU_ADMIN_DIAGNOSTIC: provision succeeded; temporary session will be cleaned up.");
  } else if (RUN_MODE === "admin-check") {
    await runAdminReproducibilityCheck();
  } else {
  await provisionAdmin();
  if (RUN_MODE === "schedule-check") {
    const games = await fetchSimulatorSchedule({ requireFreshSync: true });
    console.log(`S9SIMU_SCHEDULE_CHECK: ${JSON.stringify({
      date: lastScheduleDiagnostics.requestedDate,
      diagnostics: lastScheduleDiagnostics,
      physicalGames: games.map(({ game_code, internal_game_id, home_team, away_team }) => ({ game_code, internal_game_id, home_team, away_team }))
    })}`);
  } else if (RUN_MODE === "job-only") {
    await runLineupJobOnlyCheck();
  } else if (RUN_MODE === "roster-only") {
    await runRosterOnlyCheck();
  } else if (RUN_MODE === "sibling-check") {
    await runSiblingCheck();
  } else if (RUN_MODE === "prepare-unattended") {
    await runFightersOperationalRehearsal({ prepareOnly: true });
  } else if (RUN_MODE === "fighters-rehearsal") {
    await runFightersOperationalRehearsal();
  } else {
  // Discover the simulator's actual canonical IDs first. Cleanup is then
  // bounded to those read-back IDs and participant contexts; never send a
  // legacy fixture ID or invoke an unscoped no-game reset from this runner.
  const previousRunGames = await fetchSimulatorSchedule();
  assert.equal(new Set(previousRunGames.map((game) => game.internal_game_id)).size, previousRunGames.length);
  let staleFixtureRemoved = false;
  for (const game of previousRunGames) {
    const { homeKey } = simulatorGroupForGame(game);
    const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${homeKey}&simuNpb=1`;
    const jobResponse = await call(`/api/test/jobs${query}`, { admin: true });
    if (!jobResponse.payload.jobs.length) continue;
    const clearedSimulatorFixture = await call(`/api/test/scenario${query}`, {
      method: "POST", body: { scenario: "no-game" }, admin: true
    });
    assert.equal(clearedSimulatorFixture.payload.scenario, "no-game", `${homeKey}: stale run cleanup`);
    staleFixtureRemoved = true;
  }
  const physicalGames = staleFixtureRemoved ? await fetchSimulatorSchedule() : previousRunGames;
  const gamesByGroup = new Map();
  for (const game of physicalGames) {
    const group = simulatorGroupForGame(game);
    const index = TEST_TEAM_GROUPS.indexOf(group);
    gamesByGroup.set(index, { ...group, game });
  }
  assert.equal(gamesByGroup.size, 6);

  for (const [index, entry] of [...gamesByGroup.entries()].sort(([a], [b]) => a - b)) {
    const { homeKey, awayKey, game } = entry;
    for (const teamKey of [homeKey, awayKey]) await savePrediction(teamKey, game.internal_game_id);

    const startAt = new Date(game.start_at);
    assert.ok(Number.isFinite(startAt.getTime()), `game ${index + 1}: canonical start time required`);
    const closedAt = new Date(startAt.getTime() - 60 * 60_000 + 60_000);
    for (const teamKey of [homeKey, awayKey]) {
      const closed = await advance(teamKey, game.internal_game_id, "closed", closedAt, "prediction_closed");
      assert.equal(closed.state, "prediction_closed");
    }

    const control = await call("/simu-npb/control", { method: "POST", body: { lineupState: "available" }, admin: true });
    assert.equal(control.payload.lineupState, "available");
    const postGame = new Date(startAt.getTime() + 10 * 60_000);
    for (const teamKey of [homeKey, awayKey]) {
      const captured = await advance(teamKey, game.internal_game_id, "lineup-captured", postGame, "lineup_ready");
      assert.equal(captured.state, "lineup_ready");
      const scored = await advance(teamKey, game.internal_game_id, "scored", postGame, "scored");
      assert.equal(scored.state, "scored");
      const ranked = await advance(teamKey, game.internal_game_id, "ranked", postGame, "ranked");
      assert.equal(ranked.state, "ranked");
      const published = await advance(teamKey, game.internal_game_id, "published", postGame, "published");
      assert.equal(published.publication_status, "published");
      await verifyPublished(teamKey, game.internal_game_id);
      publishedContests += 1;
      console.log(`${teamKey}: parsed roster → prediction → close → fetched lineup → score → ranking → publish`);
    }
  }
  assert.equal(publishedContests, 12);
  console.log("S9SIMU_PIPELINE_COMPLETE: 6 physical games, 12 published contests; fixture retained.");
  }
  }
} catch (error) {
  primaryError = error;
} finally {
  try {
    await logoutSyntheticUsers();
  } catch (error) {
    cleanupError = error;
  }
  if (temporaryAdminCreated) {
    try {
      await cleanupTemporaryAdmin();
    } catch (error) {
      cleanupError = cleanupError ? new AggregateError([cleanupError, error], "Test credentials cleanup failed") : error;
    }
  }
  githubOidcToken = "";
}

if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], "S9simu run failed and temporary admin cleanup failed");
if (primaryError) throw primaryError;
if (cleanupError) throw cleanupError;
if (RUN_MODE === "full") {
  assert.equal(publishedContests, 12);
  assert.equal(temporaryUserRetained, true);
  console.log(`Completed ${publishedContests}/12 contests; simulation data and a non-admin ranking identity were retained without a reset.`);
} else if (RUN_MODE === "fighters-rehearsal") {
  assert.equal(publishedContests, 1);
  assert.equal(temporaryUserRetained, false);
  console.log("Completed the Fighters-only 2026-10-25 15:00 rehearsal; prediction data is retained and all temporary sessions/admin access were revoked.");
} else if (RUN_MODE === "prepare-unattended") {
  assert.equal(publishedContests, 0);
  assert.equal(temporaryUserRetained, false);
  console.log("Completed the bounded Fighters-only unattended baseline preparation; no pipeline stage was advanced and temporary admin access was revoked.");
} else {
  assert.equal(publishedContests, 0);
  assert.equal(temporaryUserRetained, false);
  if (RUN_MODE === "schedule-check") console.log("Completed one schedule-only diagnostic; temporary admin access was revoked.");
  else if (RUN_MODE === "roster-only") console.log("Completed one non-first-game roster identity check; dynamic fixture and temporary admin access were cleaned up.");
  else if (RUN_MODE === "sibling-check") console.log("Completed one same-game sibling check; temporary admin access was revoked.");
  else if (RUN_MODE === "job-only") console.log("Completed one lineup-job lifecycle check; the bounded fixture and temporary admin access were cleaned up.");
  else if (RUN_MODE === "admin-check") console.log("Completed two bounded admin provision/cleanup cycles; no game scenario was run.");
  else console.log("Completed one E2E admin provision diagnostic; temporary access was revoked.");
}
