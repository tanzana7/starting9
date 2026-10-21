import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { TEST_TEAM_GROUPS, TEST_TEAMS, TEST_TEAM_KEYS } from "./teams.js";
import { assertTestAuthConfig, TEST_AUTH_DB_ID, TEST_AUDIT_DB_ID } from "./isolation.js";
import fs from "node:fs";

const SITE_ORIGIN = "https://s9simu.pages.dev";
const TARGET_ACCOUNT_ID = "02580fab1c09e144db7da89478e252c8";
const setupToken = String(process.env.S9_TEST_E2E_SETUP_TOKEN || "");
if (setupToken.length < 32) throw new Error("S9_TEST_E2E_SETUP_TOKEN is required");

const config = JSON.parse(fs.readFileSync(new URL("../../wrangler.test-auth.jsonc", import.meta.url), "utf8"));
assertTestAuthConfig(config);
assert.equal(config.d1_databases.find((binding) => binding.binding === "AUTH_DB")?.database_id, TEST_AUTH_DB_ID);
assert.equal(config.d1_databases.find((binding) => binding.binding === "AUDIT_DB")?.database_id, TEST_AUDIT_DB_ID);
const identity = spawnSync("npx", ["wrangler", "whoami", "--json", "--account", TARGET_ACCOUNT_ID], {
  encoding: "utf8", shell: process.platform === "win32", windowsHide: true
});
if (identity.status !== 0 || !JSON.parse(identity.stdout).accounts?.some((account) => account.id === TARGET_ACCOUNT_ID)) {
  throw new Error("TARGET Cloudflare account verification failed");
}

const runId = randomBytes(6).toString("hex");
const temporaryAdminUsername = `e2e-${runId}`;
const positions = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
let cookie = "";
let temporaryAdminCreated = false;
let temporaryUserRetained = false;
let primaryError = null;
let cleanupError = null;
let publishedContests = 0;

async function call(path, { method = "GET", body, admin = false, setup = false, expectedStatus = 200 } = {}) {
  const team = new URL(`https://local.invalid${path}`).searchParams.get("testTeam") || "fighters";
  const headers = {
    Origin: SITE_ORIGIN,
    Accept: "application/json",
    Cookie: `s9_test_team=${encodeURIComponent(team)}; s9_test_source=simu-npb`
  };
  if (admin && cookie) headers.Cookie += `; ${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (setup) headers["X-Test-E2E-Token"] = setupToken;
  const response = await fetch(`${SITE_ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual"
  });
  const payload = await response.json().catch(() => null);
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${new URL(path, SITE_ORIGIN).pathname} returned ${response.status} (${payload?.code || "unexpected-response"})`);
  }
  return { response, payload };
}

async function provisionAdmin() {
  const response = await call("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision", runId }, setup: true, expectedStatus: 201
  });
  assert.equal(response.payload.username, temporaryAdminUsername);
  temporaryAdminCreated = true;
  cookie = response.response.headers.get("Set-Cookie")?.split(";", 1)[0] || "";
  assert.match(cookie, /^s9_session=/);
  const auth = await call("/api/auth/me?testTeam=fighters", { admin: true });
  assert.equal(auth.payload.authenticated, true);
  const isAdmin = await call("/api/admin/me?testTeam=fighters", { admin: true });
  assert.equal(isAdmin.payload.admin, true);
}

async function savePrediction(teamKey, internalGameId) {
  const query = `?internalGameId=${encodeURIComponent(internalGameId)}&testTeam=${teamKey}&simuNpb=1`;
  const roster = await call(`/api/game-day-roster${query}`, { admin: true });
  assert.equal(roster.payload.players?.length, 15, `${teamKey}: simulator roster should contain 15 parsed players`);
  assert.ok(roster.payload.players.every((player) => player.teamCode === teamKey), `${teamKey}: roster identity must stay scoped`);
  const lineup = roster.payload.players.slice(0, 9).map((player, index) => ({
    playerId: player.playerId,
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
  assert.ok(jobs.payload.jobs.every((job) => job.status === "completed"), `${teamKey}: formal jobs did not all complete`);
}

try {
  await provisionAdmin();
  // Remove only the six fixed legacy E2E fixture rows before importing the
  // simulator schedule. The no-game route is the existing scoped Test cleanup
  // boundary; the newly fetched simulator games are retained after the run.
  const clearedLegacyFixture = await call("/api/test/scenario?testTeam=fighters", {
    method: "POST", body: { scenario: "no-game" }, admin: true
  });
  assert.equal(clearedLegacyFixture.payload.scenario, "no-game");
  const schedule = await call("/api/test/simu/schedule?testTeam=fighters", {
    method: "POST", body: {}, admin: true
  });
  const physicalGames = schedule.payload.physicalGames || [];
  assert.equal(physicalGames.length, 6);
  assert.equal(schedule.payload.contestCount, 12);
  const gamesByGroup = new Map();
  for (const game of physicalGames) {
    const match = String(game.game_code || "").match(/^g-t-(\d+)$/);
    assert.ok(match, "schedule parser should preserve each simulator game code");
    const index = Number(match[1]) - 1;
    const group = TEST_TEAM_GROUPS[index];
    assert.ok(group, "simulator game code must map to one of the six physical games");
    assert.equal(game.home_team, TEST_TEAMS[group.homeKey].key);
    assert.equal(game.away_team, TEST_TEAMS[group.awayKey].key);
    assert.ok(game.internal_game_id);
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
          preserveUser: primaryError === null && publishedContests === 12
        },
        admin: Boolean(cookie), setup: true
      });
      if (cleanup.payload.retainedAsUser === true) {
        assert.equal(cleanup.payload.removed, false);
        temporaryUserRetained = true;
      } else {
        assert.equal(cleanup.payload.removed, true);
      }
      cookie = "";
    } catch (error) {
      cleanupError = error;
    }
  }
}

if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], "S9simu run failed and temporary admin cleanup failed");
if (primaryError) throw primaryError;
if (cleanupError) throw cleanupError;
assert.equal(publishedContests, 12);
assert.equal(temporaryUserRetained, true);
console.log(`Completed ${publishedContests}/12 contests; simulation data and a non-admin ranking identity were retained without a reset.`);
