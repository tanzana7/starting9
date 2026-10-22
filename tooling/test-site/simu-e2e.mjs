import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { TEST_TEAM_GROUPS, TEST_TEAMS, testPredictionPlayerId } from "./teams.js";
import { assertTestAuthConfig, TEST_AUTH_DB_ID, TEST_AUDIT_DB_ID } from "./isolation.js";
import { classifyE2ECleanupResult } from "./cleanup-contract.js";
import fs from "node:fs";

const SITE_ORIGIN = "https://s9simu.pages.dev";
const TARGET_ACCOUNT_ID = "02580fab1c09e144db7da89478e252c8";

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

async function call(path, { method = "GET", body, admin = false, authorizationToken = "", expectedStatus = 200 } = {}) {
  const team = new URL(`https://local.invalid${path}`).searchParams.get("testTeam") || "fighters";
  const headers = {
    Origin: SITE_ORIGIN,
    Accept: "application/json",
    Cookie: `s9_test_team=${encodeURIComponent(team)}; s9_test_source=simu-npb`
  };
  if (admin && cookie) headers.Cookie += `; ${cookie}`;
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
    const reason = payload?.code || payload?.error || "unexpected-response";
    throw new Error(`${method} ${new URL(path, SITE_ORIGIN).pathname} returned ${response.status} (${String(reason).slice(0, 180)})`);
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
  for (let pass = 0; pass < 6; pass += 1) {
    const result = await call(`/api/test/scenario${query}`, {
      method: "POST", admin: true,
      body: { scenario, stageOnly: true, now: now.toISOString() }
    });
    last = result.payload;
    if (last?.game?.state === expectedState) return last.game;
  }
  throw new Error(`${teamKey}/${scenario} did not reach ${expectedState}: ${last?.game?.state || "no-state"}`);
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

async function fetchSimulatorSchedule() {
  const response = await call("/api/test/simu/schedule?testTeam=fighters", {
    method: "POST", body: {}, admin: true
  });
  const physicalGames = response.payload.physicalGames || [];
  assert.equal(physicalGames.length, 6);
  assert.equal(response.payload.contestCount, 12);
  return physicalGames;
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
  await provisionAdmin();
  // Discover the simulator's actual canonical IDs first. Cleanup is then
  // bounded to those read-back IDs and participant contexts; never send a
  // legacy fixture ID or invoke an unscoped no-game reset from this runner.
  const previousRunGames = await fetchSimulatorSchedule();
  assert.equal(new Set(previousRunGames.map((game) => game.internal_game_id)).size, previousRunGames.length);
  for (const game of previousRunGames) {
    const { homeKey } = simulatorGroupForGame(game);
    const query = `?internalGameId=${encodeURIComponent(game.internal_game_id)}&testTeam=${homeKey}&simuNpb=1`;
    const clearedSimulatorFixture = await call(`/api/test/scenario${query}`, {
      method: "POST", body: { scenario: "no-game" }, admin: true
    });
    assert.equal(clearedSimulatorFixture.payload.scenario, "no-game", `${homeKey}: stale run cleanup`);
  }
  const physicalGames = await fetchSimulatorSchedule();
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
} catch (error) {
  primaryError = error;
} finally {
  if (temporaryAdminCreated) {
    try {
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
    } catch (error) {
      cleanupError = error;
    }
  }
  githubOidcToken = "";
}

if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], "S9simu run failed and temporary admin cleanup failed");
if (primaryError) throw primaryError;
if (cleanupError) throw cleanupError;
assert.equal(publishedContests, 12);
assert.equal(temporaryUserRetained, true);
console.log(`Completed ${publishedContests}/12 contests; simulation data and a non-admin ranking identity were retained without a reset.`);
