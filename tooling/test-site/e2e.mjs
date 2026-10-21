import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { assertTestAuthConfig, assertTestPagesConfig, TEST_AUTH_DB_ID, TEST_AUDIT_DB_ID } from "./isolation.js";
import { testTeamFixture, TEST_TEAMS, TEST_TEAM_GROUPS, TEST_TEAM_KEYS } from "./teams.js";

const TARGET_ACCOUNT_ID = "02580fab1c09e144db7da89478e252c8";
const SITE_ORIGIN = "https://starting9-test.pages.dev";
const token = String(process.env.S9_TEST_E2E_SETUP_TOKEN || "");
if (token.length < 32) throw new Error("S9_TEST_E2E_SETUP_TOKEN must be supplied from the temporary secret source");

const config = JSON.parse(fs.readFileSync(new URL("../../wrangler.test-auth.jsonc", import.meta.url), "utf8"));
assertTestAuthConfig(config);
const pagesConfig = JSON.parse(fs.readFileSync(new URL("./pages-project/wrangler.jsonc", import.meta.url), "utf8"));
assertTestPagesConfig(pagesConfig);
assert.equal(config.d1_databases.find((binding) => binding.binding === "AUTH_DB")?.database_id, TEST_AUTH_DB_ID);
assert.equal(config.d1_databases.find((binding) => binding.binding === "AUDIT_DB")?.database_id, TEST_AUDIT_DB_ID);
const identity = spawnSync("npx", ["wrangler", "whoami", "--json", "--account", TARGET_ACCOUNT_ID], {
  encoding: "utf8", shell: process.platform === "win32", windowsHide: true
});
if (identity.status !== 0) throw new Error("Unable to verify the isolated TARGET Cloudflare account");
const identityBody = JSON.parse(identity.stdout);
if (!identityBody.accounts?.some((account) => account.id === TARGET_ACCOUNT_ID)) {
  throw new Error("The active Cloudflare identity does not include the expected TARGET account");
}

let cookie = "";
let temporaryAdminCreated = false;
let temporaryAdminUsername = "";
let cleanupFailed = false;
let primaryError = null;
const cleanupErrors = [];
const counters = { passed: 0, physicalGames: 0 };

async function call(path, { method = "GET", body, admin = false, setup = false, expectedStatus = 200 } = {}) {
  const headers = { Origin: SITE_ORIGIN, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (admin && cookie) headers.Cookie = cookie;
  if (setup) headers["X-Test-E2E-Token"] = token;
  const response = await fetch(`${SITE_ORIGIN}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual"
  });
  const payload = await response.json().catch(() => null);
  if (response.status !== expectedStatus) {
    throw new Error(`${method} ${path} returned ${response.status} (${payload?.code || "unexpected-response"})`);
  }
  return { response, payload };
}

async function exerciseTeam(teamKey, group) {
  const team = TEST_TEAMS[teamKey];
  const fixture = testTeamFixture(teamKey);
  const teamQuery = `?testTeam=${encodeURIComponent(teamKey)}`;

  const status = await call(`/api/test/status${teamQuery}`);
  assert.equal(status.payload.game?.internal_game_id, group.internalGameId);
  assert.equal(status.payload.game?.state, "scheduled");

  const games = await call(`/api/public/games${teamQuery}`);
  const game = games.payload.games?.find((item) => item.internalGameId === fixture.internalGameId);
  assert.ok(game, `${teamKey}: canonical synthetic game must be visible`);
  assert.equal(game.homeTeam, fixture.homeTeam);
  assert.equal(game.awayTeam, fixture.awayTeam);
  assert.ok(game.displayLabel.includes(TEST_TEAMS[group.homeKey].shortName));
  assert.ok(game.displayLabel.includes(TEST_TEAMS[group.awayKey].shortName));

  const roster = await call(`/api/game-day-roster?internalGameId=${fixture.internalGameId}&testTeam=${teamKey}`);
  assert.equal(roster.payload.players?.length, 15);
  assert.ok(roster.payload.players.every((player) => player.teamCode === team.key && player.teamId === team.playerTeamId));
  const lineup = roster.payload.players.slice(0, 9).map((player, index) => ({
    playerId: player.playerId, playerName: player.name, uniformNumber: player.uniformNumber,
    teamCode: team.key, teamId: team.playerTeamId, battingOrder: index + 1,
    position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index]
  }));

  const prediction = await call(`/api/predictions/current${teamQuery}`, {
    method: "PUT", admin: true,
    body: { internalGameId: fixture.internalGameId, prediction: { schemaVersion: 1, lineup } }
  });
  assert.equal(prediction.payload.ok, true);
  assert.equal(prediction.payload.status, "submitted");

  const closed = await call(`/api/test/scenario${teamQuery}`, {
    method: "POST", body: { scenario: "closed" }, admin: true
  });
  assert.equal(closed.payload.game?.state, "prediction_closed");
  const published = await call(`/api/test/scenario${teamQuery}`, {
    method: "POST", body: { scenario: "published" }, admin: true
  });
  assert.equal(published.payload.game?.state, "published");
  assert.equal(published.payload.game?.publication_status, "published");

  const ownPrediction = await call(`/api/predictions/current?internalGameId=${fixture.internalGameId}&testTeam=${teamKey}`, { admin: true });
  assert.equal(ownPrediction.payload.internalGameId, fixture.internalGameId);
  assert.ok(ownPrediction.payload.prediction?.lineup?.length >= 9);
  assert.equal(ownPrediction.payload.score, 99);
  assert.ok(ownPrediction.payload.prediction.lineup.every((player) => player.teamCode === team.key));

  const history = await call(`/api/results/games${teamQuery}`, { admin: true });
  const historyRow = history.payload.games?.find((item) => item.internalGameId === fixture.internalGameId);
  assert.ok(historyRow, `${teamKey}: published result must appear in history`);
  assert.ok(historyRow.displayLabel.includes(team.shortName));
  const detail = await call(`/api/results/games/${fixture.internalGameId}${teamQuery}`, { admin: true });
  assert.equal(detail.payload.internalGameId, fixture.internalGameId);
  assert.equal(detail.payload.totalScore, 99);
  assert.equal(detail.payload.actualLineup?.length, 9);
  assert.ok(detail.payload.actualLineup.every((player) => player.teamCode === team.key));
  counters.passed += 1;
  console.log(`${teamKey}: prediction → close → lineup → score → ranking → publish → result OK`);
}

try {
  const runId = randomBytes(6).toString("hex");
  temporaryAdminCreated = true;
  temporaryAdminUsername = `e2e-${runId}`;
  const provisioned = await call("/api/test/e2e-admin", {
    method: "POST", body: { action: "provision", runId }, setup: true, expectedStatus: 201
  });
  assert.equal(provisioned.payload.username, temporaryAdminUsername);
  cookie = provisioned.response.headers.get("Set-Cookie")?.split(";", 1)[0] || "";
  assert.match(cookie, /^s9_session=/);

  const auth = await call("/api/auth/me", { admin: true });
  assert.equal(auth.payload.authenticated, true);
  const admin = await call("/api/admin/me", { admin: true });
  assert.equal(admin.payload.admin, true);

  for (const group of TEST_TEAM_GROUPS) {
    const reset = await call(`/api/test/reset?testTeam=${group.homeKey}`, { method: "POST", body: {}, admin: true });
    assert.equal(reset.payload.game?.internalGameId, group.internalGameId);
    await exerciseTeam(group.homeKey, group);
    await exerciseTeam(group.awayKey, group);

    const homeHistory = await call(`/api/results/games?testTeam=${group.homeKey}`, { admin: true });
    const awayHistory = await call(`/api/results/games?testTeam=${group.awayKey}`, { admin: true });
    assert.ok(homeHistory.payload.games.some((item) => item.internalGameId === group.internalGameId));
    assert.ok(awayHistory.payload.games.some((item) => item.internalGameId === group.internalGameId));
    counters.physicalGames += 1;
  }
} catch (error) {
  primaryError = error;
} finally {
  if (temporaryAdminCreated && temporaryAdminUsername) {
    for (const group of TEST_TEAM_GROUPS) {
      try {
        await call(`/api/test/reset?testTeam=${group.homeKey}`, { method: "POST", body: {}, admin: true });
        for (const teamKey of [group.homeKey, group.awayKey]) {
          const status = await call(`/api/test/status?testTeam=${teamKey}`);
          if (status.payload.game?.state !== "scheduled") cleanupFailed = true;
          const history = await call(`/api/results/games?testTeam=${teamKey}`, { admin: true });
          if (history.payload.games?.some((game) => game.internalGameId === group.internalGameId)) cleanupFailed = true;
        }
      } catch (error) {
        cleanupFailed = true;
        cleanupErrors.push(error.message);
        console.error(`baseline reset failed for ${group.internalGameId}: ${error.message}`);
      }
    }
    await call("/api/test/e2e-admin", {
      method: "POST", body: { action: "cleanup", username: temporaryAdminUsername }, admin: Boolean(cookie), setup: true
    }).then(({ payload }) => {
      if (payload?.removed !== true) throw new Error("temporary E2E admin cleanup was not confirmed");
      cookie = "";
      temporaryAdminCreated = false;
    }).catch((error) => {
      cleanupFailed = true;
      cleanupErrors.push(error.message);
      console.error(`temporary E2E admin cleanup failed: ${error.message}`);
    });
  }
}

if (primaryError && cleanupFailed) {
  throw new AggregateError([primaryError, ...cleanupErrors.map((message) => new Error(message))],
    `E2E failed (${primaryError.message}) and cleanup was incomplete`);
}
if (primaryError) throw primaryError;
if (temporaryAdminCreated) throw new Error("Temporary E2E admin remains; do not consider the Test Site at baseline");
if (cleanupFailed) throw new Error("Test Site cleanup did not verify the open unpublished baseline");
assert.equal(counters.passed, TEST_TEAM_KEYS.length);
assert.equal(counters.physicalGames, 6);
console.log(`E2E complete: ${counters.passed}/12 team contests across ${counters.physicalGames} physical games; baseline restored.`);
