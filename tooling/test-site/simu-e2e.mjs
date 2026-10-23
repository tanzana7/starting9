import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TEST_TEAM_GROUPS, TEST_TEAMS, testPredictionPlayerId } from "./teams.js";
import { assertTestAuthConfig, TEST_AUTH_DB_ID, TEST_AUDIT_DB_ID } from "./isolation.js";
import { classifyE2ECleanupResult } from "./cleanup-contract.js";
import fs from "node:fs";

const SITE_ORIGIN = "https://s9simu.pages.dev";
const TARGET_ACCOUNT_ID = "02580fab1c09e144db7da89478e252c8";
const RUN_MODE = String(process.env.S9SIMU_MODE || "full").trim().toLowerCase();
assert.ok(["full", "schedule-check", "job-only", "sibling-check", "admin-diagnose", "admin-check"].includes(RUN_MODE), "S9SIMU_MODE must be full, schedule-check, job-only, sibling-check, admin-diagnose, or admin-check");

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

async function call(path, { method = "GET", body, admin = false, authorizationToken = "", sessionCookie = "", expectedStatus = 200 } = {}) {
  const team = new URL(`https://local.invalid${path}`).searchParams.get("testTeam") || "fighters";
  const headers = {
    Origin: SITE_ORIGIN,
    Accept: "application/json",
    Cookie: `s9_test_team=${encodeURIComponent(team)}; s9_test_source=simu-npb`
  };
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
      return { ...last.game, pipelineDiagnosticsHistory };
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

  // Reset only the one physical game under test, and only when its own contest
  // jobs show that an earlier authorized run left state behind.
  let hasPriorState = false;
  for (const teamKey of [group.homeKey, group.awayKey]) {
    const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${teamKey}&simuNpb=1`;
    const jobs = await call(`/api/test/jobs${query}`, { admin: true });
    const status = await call(`/api/test/status${query}`);
    const prediction = await call(`/api/predictions/current${query}`, { admin: true });
    hasPriorState ||= jobs.payload.jobs.length > 0
      || Boolean(prediction.payload?.prediction)
      || (status.payload.game?.state && status.payload.game.state !== "scheduled");
  }
  if (hasPriorState) {
    const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${group.homeKey}&simuNpb=1`;
    const cleared = await call(`/api/test/scenario${query}`, {
      method: "POST", body: { scenario: "no-game" }, admin: true
    });
    assert.equal(cleared.payload.scenario, "no-game");
    physicalGames = await fetchSimulatorSchedule();
    game = physicalGames.find((item) => item.game_code === "g-t-1");
    assert.ok(game);
    group = simulatorGroupForGame(game);
  }

  for (const teamKey of [group.homeKey, group.awayKey]) await savePrediction(teamKey, game.internal_game_id);
  const startAt = new Date(game.start_at);
  assert.ok(Number.isFinite(startAt.getTime()));
  const closedAt = new Date(startAt.getTime() - 59 * 60_000);
  for (const teamKey of [group.homeKey, group.awayKey]) {
    const closed = await advance(teamKey, game.internal_game_id, "closed", closedAt, "prediction_closed");
    assert.equal(closed.state, "prediction_closed");
  }
  const control = await call("/simu-npb/control", { method: "POST", body: { lineupState: "available" } });
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
    const control = await call("/simu-npb/control", { method: "POST", body: { lineupState: "available" } });
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
  } else if (RUN_MODE === "sibling-check") {
    await runSiblingCheck();
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

    const control = await call("/simu-npb/control", { method: "POST", body: { lineupState: "available" } });
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
  if (temporaryAdminCreated) {
    try {
      await cleanupTemporaryAdmin();
    } catch (error) {
      cleanupError = error;
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
} else {
  assert.equal(publishedContests, 0);
  assert.equal(temporaryUserRetained, false);
  if (RUN_MODE === "schedule-check") console.log("Completed one schedule-only diagnostic; temporary admin access was revoked.");
  else if (RUN_MODE === "sibling-check") console.log("Completed one same-game sibling check; temporary admin access was revoked.");
  else if (RUN_MODE === "job-only") console.log("Completed one lineup-job lifecycle check; the bounded fixture and temporary admin access were cleaned up.");
  else if (RUN_MODE === "admin-check") console.log("Completed two bounded admin provision/cleanup cycles; no game scenario was run.");
  else console.log("Completed one E2E admin provision diagnostic; temporary access was revoked.");
}
