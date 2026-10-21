import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { assertTestAuthConfig, assertTestPagesConfig, TEST_AUTH_DB_ID, TEST_AUDIT_DB_ID } from "./isolation.js";
import { testTeamFixture, TEST_TEAMS, TEST_TEAM_GROUPS, TEST_TEAM_KEYS } from "./teams.js";
import { fetchReadWith503Retry, hasReachedFormalState, invokeFormalStageWithLeaseRetry } from "./formal-stage-retry.mjs";

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
  const request = () => fetch(`${SITE_ORIGIN}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual"
  });
  // Read-only GETs have no job lease or mutation to recover. A short bounded
  // retry absorbs isolated Cloudflare 503s without repeating any write path.
  const response = method === "GET" ? await fetchReadWith503Retry(request) : await request();
  const payload = await response.json().catch(() => null);
  if (response.status !== expectedStatus) {
    throw Object.assign(new Error(`${method} ${path} returned ${response.status} (${payload?.code || "unexpected-response"})`), {
      status: response.status,
      code: payload?.code || ""
    });
  }
  return { response, payload };
}

async function provisionTemporaryAdmin(runId) {
  // Wrangler secret changes create an immediate version, but propagation to
  // the Pages proxy can lag briefly. A rejected setup token is checked before
  // any account write, so retry only that 404 boundary for a short bounded
  // window instead of treating propagation latency as an operations failure.
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await call("/api/test/e2e-admin", {
        method: "POST", body: { action: "provision", runId }, setup: true, expectedStatus: 201
      });
    } catch (error) {
      lastError = error;
      if (!String(error?.message || "").includes("returned 404")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError || new Error("Temporary E2E admin provisioning did not become available");
}

async function prepareTeamPrediction(teamKey, group) {
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
}

async function advanceFormalStage(teamKey, scenario, expectedState) {
  const teamQuery = `?testTeam=${encodeURIComponent(teamKey)}`;
  let result;
  // One planner/claim/executor pass per request keeps the Test Worker under
  // its Free CPU ceiling. If planning schedules a job for the next pass, keep
  // advancing through the same formal path until its observable state lands.
  for (let pass = 0; pass < 6; pass += 1) {
    result = await invokeFormalStageWithLeaseRetry({
      invoke: () => call(`/api/test/scenario${teamQuery}`, {
        method: "POST", body: { scenario, stageOnly: true }, admin: true
      }),
      readGame: async () => (await call(`/api/test/status${teamQuery}`)).payload.game,
      expectedState
    });
    if (result.recoveredAfterWorkerLimit) {
      console.warn(`${teamKey} ${scenario}: recovered after a Worker 503 and formal job lease expiry`);
    }
    if (hasReachedFormalState(result.payload.game, expectedState)) return result;
  }
  throw new Error(`${teamKey} ${scenario} did not reach ${expectedState}: ${JSON.stringify(result?.payload?.game || null)}`);
}

async function completeTeamPipeline(teamKey, group) {
  const teamQuery = `?testTeam=${encodeURIComponent(teamKey)}`;
  const closed = await advanceFormalStage(teamKey, "closed", "prediction_closed");
  assert.equal(closed.payload.game?.state, "prediction_closed");

  // Keep each formal stage in its own Worker invocation. On the Free plan the
  // combined score→ranking→publish scenario can exceed the per-invocation CPU
  // ceiling even though each existing executor stage completes independently.
  // These remain the same production planner/executor paths; only the test
  // harness advances them one stage at a time so a retryable boundary is real.
  const scored = await advanceFormalStage(teamKey, "scored", "scored");
  assert.equal(scored.payload.game?.state, "scored");
  const ranked = await advanceFormalStage(teamKey, "ranked", "ranked");
  assert.equal(ranked.payload.game?.state, "ranked");
  const published = await advanceFormalStage(teamKey, "published", "published");
  assert.equal(published.payload.game?.state, "published");
  assert.equal(published.payload.game?.publication_status, "published");

  await verifyPublishedTeam(teamKey, group);
  counters.passed += 1;
  console.log(`${teamKey}: prediction → close → lineup → score → ranking → publish → result OK`);
}

async function verifyPublishedTeam(teamKey, group) {
  const team = TEST_TEAMS[teamKey];
  const fixture = testTeamFixture(teamKey);
  const teamQuery = `?testTeam=${encodeURIComponent(teamKey)}`;
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
  const jobs = await call(`/api/test/jobs?testTeam=${teamKey}`, { admin: true });
  assert.equal(jobs.payload.internalGameId, fixture.internalGameId);
  assert.ok(jobs.payload.jobs.length > 0 && jobs.payload.jobs.every((job) => job.status === "completed"));
}

async function exerciseRankingFailureRetry(teamKey, group) {
  await advanceFormalStage(teamKey, "closed", "prediction_closed");
  const teamQuery = `?testTeam=${encodeURIComponent(teamKey)}`;
  const failed = await invokeFormalStageWithLeaseRetry({
    invoke: () => call(`/api/test/scenario${teamQuery}`, {
      method: "POST", body: { scenario: "retry" }, admin: true
    }),
    readGame: async () => {
      const [status, jobReadback] = await Promise.all([
        call(`/api/test/status${teamQuery}`),
        call(`/api/test/jobs${teamQuery}`, { admin: true })
      ]);
      const rankingJob = jobReadback.payload.jobs.find((job) => job.job_type === "ranking_rebuild");
      return {
        ...status.payload.game,
        failureInjected: rankingJob?.status === "retry_wait"
          && rankingJob.failure_message?.includes("TEST_SCENARIO_INJECTED_FAILURE")
      };
    },
    expectedState: "scored",
    isComplete: (game) => game?.failureInjected === true
  });
  assert.equal(failed.payload.failureInjected, true);
  assert.equal(failed.payload.game?.state, "scored");

  const retryJobs = await call(`/api/test/jobs${teamQuery}`, { admin: true });
  const rankingJob = retryJobs.payload.jobs.find((job) => job.job_type === "ranking_rebuild");
  assert.equal(rankingJob?.status, "retry_wait");
  assert.ok(rankingJob?.attempt_count >= 1);
  assert.ok(rankingJob?.next_retry_at);
  const retryAt = Date.parse(rankingJob.next_retry_at);
  assert.ok(Number.isFinite(retryAt));

  // The sibling contest shares the physical schedule but must remain runnable
  // while this team's ranking job waits for its formal next_retry_at.
  const siblingKey = group.homeKey === teamKey ? group.awayKey : group.homeKey;
  await completeTeamPipeline(siblingKey, group);
  const stillWaiting = await call(`/api/test/jobs${teamQuery}`, { admin: true });
  const waitingJob = stillWaiting.payload.jobs.find((job) => job.job_type === "ranking_rebuild");
  assert.equal(waitingJob?.status, "retry_wait");
  assert.equal(waitingJob?.next_retry_at, rankingJob.next_retry_at);

  const delay = Math.max(0, retryAt - Date.now() + 1_000);
  console.log(`${teamKey}: waiting ${Math.ceil(delay / 1_000)}s for the formal ranking retry`);
  await new Promise((resolve) => setTimeout(resolve, delay));
  const ranked = await advanceFormalStage(teamKey, "ranked", "ranked");
  assert.equal(ranked.payload.game?.state, "ranked");
  const published = await advanceFormalStage(teamKey, "published", "published");
  assert.equal(published.payload.game?.publication_status, "published");
  await verifyPublishedTeam(teamKey, group);
  counters.passed += 1;
  console.log(`${teamKey}: failure → retry_wait → sibling progress → retry at next_retry_at → published OK`);
}

try {
  const runId = randomBytes(6).toString("hex");
  temporaryAdminCreated = true;
  temporaryAdminUsername = `e2e-${runId}`;
  const provisioned = await provisionTemporaryAdmin(runId);
  assert.equal(provisioned.payload.username, temporaryAdminUsername);
  cookie = provisioned.response.headers.get("Set-Cookie")?.split(";", 1)[0] || "";
  assert.match(cookie, /^s9_session=/);

  const auth = await call("/api/auth/me", { admin: true });
  assert.equal(auth.payload.authenticated, true);
  const admin = await call("/api/admin/me", { admin: true });
  assert.equal(admin.payload.admin, true);

  const runFailureRetry = process.env.S9_TEST_FAILURE_RETRY === "1";
  for (const [groupIndex, group] of TEST_TEAM_GROUPS.entries()) {
    const reset = await call(`/api/test/reset?testTeam=${group.homeKey}`, { method: "POST", body: {}, admin: true });
    assert.equal(reset.payload.game?.internalGameId, group.internalGameId);
    // A physical game has one shared prediction deadline across its two
    // team-scoped contests. Submit both predictions before either scenario
    // advances that shared game beyond its deadline; then verify each contest
    // independently through the same final pipeline.
    await prepareTeamPrediction(group.homeKey, group);
    await prepareTeamPrediction(group.awayKey, group);
    if (runFailureRetry && groupIndex === 0) {
      await exerciseRankingFailureRetry(group.homeKey, group);
    } else {
      await completeTeamPipeline(group.homeKey, group);
      await completeTeamPipeline(group.awayKey, group);
    }

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
