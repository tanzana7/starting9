import test from "node:test";
import assert from "node:assert/strict";
import { createTestSiteMultiTeamFixture } from "./helpers/test-site-multi-team-fixture.js";
import { buildSyntheticPredictions } from "../tooling/test-site/auto-prediction-seeder.js";
import { TEST_TEAMS, testTeamFixture } from "../tooling/test-site/teams.js";
import { V3_TIMING } from "../backend/automation-v3/constants.js";

const REHEARSAL = Object.freeze({ rehearsalId: "fighters-2026-10-25-1500", seed: 20261025, count: 10 });

async function insertOrdinaryUserSession(database) {
  const now = new Date().toISOString();
  const token = "ordinary-test-user-session-token";
  const tokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("base64url");
  database.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, password_salt, password_iterations,
     status, role, created_at, updated_at)
    VALUES ('ordinary-test-user', 'ordinarytest', 'ordinarytest', 'unused', 'unused', 100000,
            'active', 'user', ?, ?)`).run(now, now);
  database.prepare(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
    VALUES ('ordinary-test-session', 'ordinary-test-user', ?, ?, '2099-01-01T00:00:00.000Z', ?)`)
    .run(tokenHash, now, now);
  return `s9_session=${token}`;
}

async function provision(fixture, { sessionCookie, envOverrides } = {}) {
  return fixture.request("fighters", "/api/test/admin/synthetic-users/provision?testTeam=fighters", REHEARSAL, "POST", {
    sessionCookie,
    envOverrides,
    expectedStatus: 200
  });
}

test("Test-only synthetic provisioning is admin-gated, production-denied, bounded, and idempotent", async () => {
  const f = await createTestSiteMultiTeamFixture();
  try {
    const before = f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    const anonymous = await f.request("fighters", "/api/test/admin/synthetic-users/provision?testTeam=fighters",
      REHEARSAL, "POST", { expectedStatus: 401, sessionCookie: "" });
    assert.equal(anonymous.code, "ADMIN_REQUIRED");
    const ordinarySession = await insertOrdinaryUserSession(f.database);
    const ordinary = await f.request("fighters", "/api/test/admin/synthetic-users/provision?testTeam=fighters",
      REHEARSAL, "POST", { expectedStatus: 401, sessionCookie: ordinarySession });
    assert.equal(ordinary.code, "ADMIN_REQUIRED");
    const production = await f.request("fighters", "/api/test/admin/synthetic-users/provision?testTeam=fighters",
      REHEARSAL, "POST", { expectedStatus: 404, envOverrides: { ENVIRONMENT: "production" } });
    assert.equal(production.code, "TEST_ENVIRONMENT_REQUIRED");
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, before + 1,
      "rejected calls must not create synthetic identities");

    const first = await provision(f);
    assert.equal(first.ok, true);
    assert.equal(first.requested, 10);
    assert.equal(first.created, 10);
    assert.equal(first.reused, 0);
    assert.equal(first.users.length, 10);
    assert.equal(new Set(first.users.map((user) => user.userId)).size, 10);
    assert.equal(new Set(first.users.map((user) => user.username)).size, 10);
    assert.ok(first.users.every((user) => /^r[a-f0-9]{12}\d{2}$/.test(user.username)));
    assert.ok(first.users.every((user) => /^s9_session=[A-Za-z0-9._~-]{16,256}$/.test(user.sessionCookie)));
    const countAfterFirst = f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count;
    assert.equal(countAfterFirst, before + 11);

    const second = await provision(f);
    assert.equal(second.ok, true);
    assert.equal(second.created, 0);
    assert.equal(second.reused, 10);
    assert.deepEqual(second.users.map(({ username, userId }) => ({ username, userId })),
      first.users.map(({ username, userId }) => ({ username, userId })),
      "same rehearsal identity must reuse the same stable accounts");
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, countAfterFirst,
      "repeat provisioning must not grow the user table");
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id LIKE 'synthetic-%'").get().count, 10,
      "reprovisioning rotates only the one active session per synthetic account");

    const currentSessions = f.database.prepare(`SELECT users.id, sessions.token_hash FROM users
      JOIN sessions ON sessions.user_id = users.id WHERE users.id LIKE 'synthetic-%' ORDER BY users.id`).all();
    const conflictingUserId = first.users[5].userId;
    f.database.prepare("UPDATE users SET role='admin' WHERE id=?").run(conflictingUserId);
    const conflict = await f.request("fighters", "/api/test/admin/synthetic-users/provision?testTeam=fighters",
      REHEARSAL, "POST", { expectedStatus: 409 });
    assert.equal(conflict.code, "SYNTHETIC_IDENTITY_CONFLICT");
    assert.deepEqual(f.database.prepare(`SELECT users.id, sessions.token_hash FROM users
      JOIN sessions ON sessions.user_id = users.id WHERE users.id LIKE 'synthetic-%' ORDER BY users.id`).all(),
    currentSessions, "identity conflict must reject before rotating any of the batch's sessions");

    const malformed = await f.request("fighters", "/api/test/admin/synthetic-users/provision?testTeam=fighters",
      { ...REHEARSAL, count: 100 }, "POST", { expectedStatus: 400 });
    assert.equal(malformed.code, "INVALID_SYNTHETIC_REHEARSAL");
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM users").get().count, countAfterFirst);
  } finally {
    f.close();
  }
});

test("ten provisioned users save predictions through the normal API and complete the Fighters rehearsal pipeline", async () => {
  const f = await createTestSiteMultiTeamFixture();
  try {
    const { internalGameId } = testTeamFixture("fighters");
    const query = `?internalGameId=${encodeURIComponent(internalGameId)}&testTeam=fighters`;
    await f.request("fighters", `/api/test/reset?testTeam=fighters`, {});
    const jobs = await f.request("fighters", `/api/test/jobs${query}`);
    const contestId = jobs.contestId;
    assert.ok(contestId);

    const startAt = new Date("2026-10-25T06:00:00.000Z");
    f.database.prepare(`UPDATE games SET game_date='2026-10-25', start_time=?, game_status='scheduled'
      WHERE internal_game_id=?`).run(startAt.toISOString(), internalGameId);
    const rosterResponse = await f.request("fighters", `/api/game-day-roster?internalGameId=${internalGameId}&testTeam=fighters`);
    assert.equal(rosterResponse.players.length, 15);
    assert.ok(rosterResponse.players.every((player) => player.teamCode === "fighters"
      && player.teamId === TEST_TEAMS.fighters.playerTeamId));
    const predictions = buildSyntheticPredictions({ contestId, targetTeam: "fighters", roster: rosterResponse.players,
      userCount: 10, seed: REHEARSAL.seed });

    const first = await provision(f);
    const second = await provision(f);
    assert.equal(first.created + first.reused, 10);
    assert.equal(second.created, 0);
    assert.equal(second.reused, 10);
    const users = second.users;
    const cutoff = new Date(startAt.getTime() - V3_TIMING.predictionDeadlineMinutes * 60_000);
    const logicalNow = new Date(cutoff.getTime() - 1).toISOString();
    let saved = 0;
    for (const [index, entry] of predictions.entries()) {
      const result = await f.request("fighters", `/api/test/prediction-write${query}`, {
        sessionCookie: users[index].sessionCookie,
        prediction: entry.prediction,
        logicalNow
      });
      assert.equal(result.ok, true, `${entry.label}: normal prediction endpoint accepts before cutoff`);
      assert.equal(result.status, 200);
      assert.equal(result.predictionStatus, "submitted");
      saved += 1;
    }
    assert.equal(saved, 10);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM predictions WHERE contest_id=?").get(contestId).count, 10);

    const cutoffAttempt = await f.request("fighters", `/api/test/prediction-write${query}`, {
      sessionCookie: users[0].sessionCookie,
      prediction: predictions[0].prediction,
      logicalNow: cutoff.toISOString()
    });
    assert.equal(cutoffAttempt.status, 409);
    assert.equal(cutoffAttempt.code, "PREDICTION_DEADLINE_PASSED");
    const afterCutoffAttempt = await f.request("fighters", `/api/test/prediction-write${query}`, {
      sessionCookie: users[0].sessionCookie,
      prediction: predictions[0].prediction,
      logicalNow: new Date(cutoff.getTime() + 1).toISOString()
    });
    assert.equal(afterCutoffAttempt.status, 409);
    assert.equal(afterCutoffAttempt.code, "PREDICTION_DEADLINE_PASSED");
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM predictions WHERE contest_id=?").get(contestId).count, 10,
      "rejected cutoff writes must not add prediction rows");

    const published = await f.request("fighters", `/api/test/scenario?testTeam=fighters`, { scenario: "published" });
    assert.equal(published.game.state, "published", JSON.stringify(published));
    assert.equal(published.game.publication_status, "published");
    const scoreRows = f.database.prepare("SELECT score FROM predictions WHERE contest_id=?").all(contestId);
    assert.equal(scoreRows.length, 10);
    assert.ok(scoreRows.every((row) => Number.isFinite(Number(row.score))));
    const finalJobs = await f.request("fighters", `/api/test/jobs${query}`);
    for (const type of ["prediction_close", "score", "ranking_rebuild", "publish"]) {
      assert.ok(finalJobs.jobs.some((job) => job.job_type === type && job.status === "completed"), `${type} completed`);
    }
    assert.ok(finalJobs.jobs.every((job) => !["failed", "retry_wait", "claimed"].includes(job.status)));
    const resultReadbacks = [];
    for (const user of users) {
      const detail = await f.request("fighters", `/api/results/games/${encodeURIComponent(internalGameId)}${query}`,
        undefined, "GET", { sessionCookie: user.sessionCookie });
      assert.equal(detail.resultsPublished, true);
      assert.equal(detail.actualLineup.length, 9);
      resultReadbacks.push(detail.score);
    }
    assert.equal(resultReadbacks.length, 10);
    assert.ok(resultReadbacks.every(Number.isFinite));

    for (const user of users) {
      const logout = await f.request("fighters", "/api/auth/logout?testTeam=fighters", undefined, "POST", {
        sessionCookie: user.sessionCookie
      });
      assert.equal(logout.ok, true);
    }
  } finally {
    f.close();
  }
});

