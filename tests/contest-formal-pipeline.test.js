import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import authWorker, { executeGameAutomationV3Job } from "../auth-worker.js";
import { createContestId } from "../backend/contest-identity.js";
import { getDailyBestNineForGame, getRankingForPeriod, getLatestPublishedRankingGame } from "../backend/repositories/ranking-repository.js";
import { evaluateCanonicalArtifactsFromDb } from "../backend/automation-v3/canonical-artifact-evaluator.js";
import { planMainWorkflowJobs } from "../backend/automation-v3/orchestrator.js";
import { runGameAutomationV3 } from "../backend/automation-v3/executor.js";
import teamContext from "../frontend/shared/team-context.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME_ID = "20270000-0000-4000-8000-000000000001";
const GAME_DATE = "2026-10-21";
const START_AT = "2026-10-21T09:00:00.000Z";
const NOW = new Date("2026-10-21T10:00:00.000Z");
const USER_ID = "same-synthetic-user";
const SESSION_TOKEN = "contest-formal-pipeline-session";
const CONTESTS = Object.freeze({ fighters: createContestId(GAME_ID, "fighters"), marines: createContestId(GAME_ID, "marines") });
const POSITIONS = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bound = (...values) => ({
        first: async () => statement.get(...values),
        all: async () => ({ results: statement.all(...values) }),
        run: async () => ({ meta: { changes: Number(statement.run(...values).changes || 0) } })
      });
      return {
        first: async () => statement.get(),
        all: async () => ({ results: statement.all() }),
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }),
        bind: (...values) => bound(...values)
      };
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function lineupFor(teamKey, offset = 0) {
  const team = teamKey === "fighters" ? teamContext.FIGHTERS : teamContext.MARINES;
  return Array.from({ length: 9 }, (_, index) => {
    const playerNumber = index + 1 + offset;
    return {
      playerId: `npb:${teamKey === "fighters" ? "9999" : "8888"}${String(playerNumber).padStart(4, "0")}`,
      playerName: `${team.shortName} synthetic ${playerNumber}`,
      uniformNumber: String(playerNumber),
      teamCode: team.key,
      teamId: team.playerTeamId,
      position: POSITIONS[index],
      battingOrder: index + 1
    };
  });
}

async function createFixture() {
  const database = new DatabaseSync(":memory:");
  for (const file of fs.readdirSync(path.join(ROOT, "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(fs.readFileSync(path.join(ROOT, "migrations", file), "utf8"));
  }
  const timestamp = NOW.toISOString();
  database.prepare(`INSERT INTO users
    (id,username,username_normalized,password_hash,password_salt,password_iterations,status,role,created_at,updated_at)
    VALUES(?, 'shared-user', 'shared-user', 'test', 'test', 1, 'active', 'user', ?, ?)`)
    .run(USER_ID, timestamp, timestamp);
  const tokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SESSION_TOKEN))).toString("base64url");
  database.prepare(`INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at,last_used_at)
    VALUES('formal-pipeline-session',?,?,?,'2099-01-01T00:00:00.000Z',?)`)
    .run(USER_ID, tokenHash, timestamp, timestamp);
  database.prepare(`INSERT INTO games
    (internal_game_id,game_date,start_time,home_team,away_team,game_status,is_active,deleted_at,created_at,updated_at)
    VALUES(?, ?, ?, 'fighters', 'marines', 'scheduled', 1, NULL, ?, ?)`)
    .run(GAME_ID, GAME_DATE, START_AT, timestamp, timestamp);
  for (const teamKey of ["fighters", "marines"]) {
    const contestId = CONTESTS[teamKey];
    const actual = lineupFor(teamKey);
    const predicted = teamKey === "fighters" ? actual : lineupFor(teamKey, 9);
    const revisionId = `${contestId}:lineup:1`;
    database.prepare(`INSERT INTO game_contests(contest_id,internal_game_id,target_team_key,created_at)
      VALUES(?,?,?,?)`).run(contestId, GAME_ID, teamKey, timestamp);
    database.prepare(`INSERT INTO contest_automation_v3_state
      (contest_id,internal_game_id,state,version,created_at,updated_at) VALUES(?,?,'scheduled',0,?,?)`)
      .run(contestId, GAME_ID, timestamp, timestamp);
    database.prepare(`INSERT INTO game_lineups
      (id,game_id,contest_id,actual_lineup_json,lineup_fingerprint,schema_version,lineup_detected_at,scoring_due_at,
       scoring_status,created_at,updated_at,lineup_source,publication_status,internal_game_id,final_lineup_revision_id,
       finalized_at,finalized_by,scoring_lineup_revision_id,scoring_revision)
      VALUES(?,?,?,?,'fingerprint-'||?,1,?,?,'pending',?,?,'manual','pending',?,?,?,'synthetic-admin',?,0)`)
      .run(`${teamKey}-lineup`, GAME_ID, contestId, JSON.stringify(actual), teamKey, timestamp, timestamp,
        timestamp, timestamp, GAME_ID, revisionId, timestamp, revisionId);
    database.prepare(`INSERT INTO contest_lineup_revisions
      (contest_id,internal_game_id,game_id,version,revision_id,actual_lineup_json,lineup_fingerprint,source,
       created_at,reason,is_current,validation_json,finalized_at,finalized_by,is_final)
      VALUES(?,?,?,1,?,?,?,'manual',?,'same-game formal fixture',1,'{"ok":true}',?,'synthetic-admin',1)`)
      .run(contestId, GAME_ID, GAME_ID, revisionId, JSON.stringify(actual), `fingerprint-${teamKey}`, timestamp, timestamp);
    database.prepare(`INSERT INTO contest_ranking_games
      (contest_id,internal_game_id,game_id,is_ranking_eligible,ranking_eligible_at,game_status,is_test_game,
       created_at,updated_at,game_date,publication_status,ranking_eligibility_status,ranking_eligibility_version,
       ranking_eligibility_updated_by,ranking_eligibility_updated_at)
      VALUES(?,?,?,1,?,'pending',0,?,?,?,'pending','eligible',1,'synthetic-fixture',?)`)
      .run(contestId, GAME_ID, GAME_ID, timestamp, timestamp, timestamp, GAME_DATE, timestamp);
    database.prepare(`INSERT INTO predictions
      (id,user_id,game_id,internal_game_id,contest_id,prediction_json,schema_version,game_date,home_team,away_team,
       opponent_code,is_home,submitted_at,updated_at,status,is_test_prediction,scoring_status)
      VALUES(?,?,?,?,?,?,1,?,'fighters','marines',?,?,?,?,'submitted',0,'pending')`)
      .run(`${teamKey}-prediction`, USER_ID, GAME_ID, GAME_ID, contestId,
        JSON.stringify({ schemaVersion: 1, lineup: predicted }), GAME_DATE,
        teamKey === "fighters" ? "marines" : "fighters", teamKey === "fighters" ? 1 : 0,
        timestamp, timestamp);
  }
  // The existing discovery projection is physical-game/Fighters-oriented by design.
  // One Marines-vs-Fighters physical row is therefore enough to test both trusted contests.
  database.prepare(`INSERT INTO game_automation_v3_state
    (internal_game_id,state,version,created_at,updated_at) VALUES(?,'scheduled',0,?,?)`).run(GAME_ID,timestamp,timestamp);
  database.prepare(`INSERT INTO ranking_games
    (game_id,internal_game_id,game_date,is_ranking_eligible,ranking_eligible_at,game_status,is_test_game,
     publication_status,created_at,updated_at) VALUES(?,?,?,1,?,'pending',0,'pending',?,?)`)
    .run(GAME_ID,GAME_ID,GAME_DATE,timestamp,timestamp,timestamp);
  const authDb = d1(database);
  return {
    database,
    envFor(teamKey) {
      return {
        AUTH_DB: authDb,
        ENABLE_GAME_AUTOMATION_V3: "true",
        ENABLE_SEMI_AUTO_LINEUP: "true",
        ENVIRONMENT: "test",
        TEST_SITE_ID: "starting9-isolated-v1",
        TEST_WORKER_NAME: "starting9-test-auth",
        AUTH_ALLOWED_ORIGINS: "https://starting9.test",
        TARGET_TEAM_CONTEXT: teamKey === "fighters" ? teamContext.FIGHTERS : teamContext.MARINES
      };
    },
    close() { database.close(); }
  };
}

async function formalTick(fixture, teamKey, now, { failMarinesScoreOnce = null } = {}) {
  const env = fixture.envFor(teamKey);
  const result = await runGameAutomationV3(env, now, {
    targetTeamKey: teamKey,
    v4SemiAuto: true,
    runAuxiliary: false,
    gameListOptions: { internalGameId: GAME_ID, includeRecentHistory: true },
    formalPlanner: (db, games, at) => planMainWorkflowJobs(db, games, at, {
      targetTeamKey: teamKey,
      v4SemiAuto: true,
      disabledStages: ["roster_fetch", "lineup_fetch"]
    }),
    auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
    executeJob: async (context) => {
      if (teamKey === "marines" && context.job.job_type === "score" && failMarinesScoreOnce && !failMarinesScoreOnce.failed) {
        failMarinesScoreOnce.failed = true;
        const error = new Error("injected Marines score failure");
        error.code = "TEST_MARINES_SCORE_FAILURE";
        throw error;
      }
      return executeGameAutomationV3Job({ ...context, v4SemiAuto: true });
    }
  });
  return result;
}

async function driveTeam(fixture, teamKey, baseTime, { failMarinesScoreOnce = null, interleave = null } = {}) {
  let last;
  for (let pass = 0; pass < 8; pass += 1) {
    const now = new Date(baseTime.getTime() + pass * 60_000);
    last = await formalTick(fixture, teamKey, now, { failMarinesScoreOnce });
    if (interleave) await interleave(pass, now, last);
    const state = fixture.database.prepare("SELECT state FROM contest_automation_v3_state WHERE contest_id=?").get(CONTESTS[teamKey]).state;
    if (state === "published") return last;
  }
  assert.fail(`${teamKey} formal pipeline did not publish; last=${JSON.stringify(last)}`);
}

async function assertPublishedContest(fixture, teamKey) {
  const contestId = CONTESTS[teamKey];
  const canonical = await evaluateCanonicalArtifactsFromDb(fixture.envFor(teamKey).AUTH_DB, GAME_ID, contestId);
  assert.equal(canonical.aggregate.fullyPublished, true);
  assert.equal(canonical.aggregate.artifactMismatch, false);
  const prediction = fixture.database.prepare("SELECT status,score FROM predictions WHERE id=?").get(`${teamKey}-prediction`);
  assert.equal(prediction.status, "scored");
  return { canonical, prediction };
}

test("formal same-game pipeline is contest-isolated in serial, interleaved, and Marines retry runs", async () => {
  // Each round starts from a newly migrated in-memory DB, equivalent to the Test Site's
  // documented clean baseline without deleting/resetting shared or production state.
  for (const mode of ["serial", "interleaved", "marines-retry"]) {
    const fixture = await createFixture();
    try {
      assert.equal(fixture.database.prepare("SELECT COUNT(*) AS n FROM games WHERE internal_game_id=?").get(GAME_ID).n, 1);
      assert.deepEqual(fixture.database.prepare("SELECT user_id,contest_id FROM predictions ORDER BY contest_id").all().map((row) => ({ ...row })), [
        { user_id: USER_ID, contest_id: CONTESTS.fighters },
        { user_id: USER_ID, contest_id: CONTESTS.marines }
      ]);
      const injected = { failed: false };
      if (mode === "serial") {
        await driveTeam(fixture, "fighters", NOW);
        const f = await assertPublishedContest(fixture, "fighters");
        assert.equal(fixture.database.prepare("SELECT publication_status FROM contest_ranking_games WHERE contest_id=?").get(CONTESTS.marines).publication_status, "pending");
        await driveTeam(fixture, "marines", new Date(NOW.getTime() + 10 * 60_000));
      } else if (mode === "interleaved") {
        for (let pass = 0; pass < 8; pass += 1) {
          await formalTick(fixture, "marines", new Date(NOW.getTime() + pass * 60_000));
          await formalTick(fixture, "fighters", new Date(NOW.getTime() + pass * 60_000));
          const states = fixture.database.prepare("SELECT contest_id,state FROM contest_automation_v3_state ORDER BY contest_id").all();
          if (states.every((row) => row.state === "published")) break;
        }
      } else {
        let firstMarines;
        for (let pass = 0; pass < 5 && !injected.failed; pass += 1) {
          firstMarines = await formalTick(fixture, "marines", new Date(NOW.getTime() + pass * 60_000), { failMarinesScoreOnce: injected });
        }
        assert.equal(injected.failed, true);
        assert.equal(firstMarines.execution.retryWait, 1);
        assert.equal(fixture.database.prepare("SELECT status FROM game_jobs_v3 WHERE contest_id=? AND job_type='score'").get(CONTESTS.marines).status, "retry_wait");
        await driveTeam(fixture, "fighters", new Date(NOW.getTime() + 1_000));
        assert.equal(fixture.database.prepare("SELECT attempt_count,status FROM game_jobs_v3 WHERE contest_id=? AND job_type='score'").get(CONTESTS.fighters).status, "completed");
        await driveTeam(fixture, "marines", new Date(NOW.getTime() + 11 * 60_000), { failMarinesScoreOnce: injected });
      }
      const fighters = await assertPublishedContest(fixture, "fighters");
      const marines = await assertPublishedContest(fixture, "marines");
      assert.notEqual(fighters.prediction.score, marines.prediction.score, `${mode} should demonstrate distinct contest scoring`);
      assert.deepEqual(fixture.database.prepare("SELECT contest_id,publication_status FROM contest_ranking_games ORDER BY contest_id").all().map((row) => ({ ...row })), [
        { contest_id: CONTESTS.fighters, publication_status: "published" },
        { contest_id: CONTESTS.marines, publication_status: "published" }
      ]);
      for (const teamKey of ["fighters", "marines"]) {
        const contestId = CONTESTS[teamKey];
        const jobRows = fixture.database.prepare("SELECT job_type,status,contest_id FROM game_jobs_v3 WHERE contest_id=? ORDER BY id").all(contestId);
        for (const type of ["prediction_close", "score", "ranking_rebuild", "publish"]) {
          assert.ok(jobRows.some((row) => row.job_type === type && row.status === "completed" && row.contest_id === contestId), `${teamKey} ${type} completed`);
        }
        assert.equal((await getDailyBestNineForGame(fixture.envFor(teamKey).AUTH_DB, { internalGameId: GAME_ID, contestId })).rows.length, 9);
        assert.equal((await getLatestPublishedRankingGame(fixture.envFor(teamKey).AUTH_DB, { contestId })).contestId, contestId);
        const ranking = await getRankingForPeriod(fixture.envFor(teamKey).AUTH_DB, {
          limit: 10, offset: 0, qualifiedOnly: false, startAt: GAME_DATE, endAt: GAME_DATE,
          publishedOnly: true, targetTeamKey: teamKey
        });
        assert.ok(ranking.rows.every((row) => row.username === "shared-user"), `${teamKey} ranking contains no sibling/unknown user`);
      }
      const publishedResponse = await authWorker.fetch(new Request(`https://starting9.test/api/results/games/${GAME_ID}`, {
        headers: { Origin: "https://starting9.test", Cookie: `s9_session=${SESSION_TOKEN}` }
      }), fixture.envFor("marines"), {});
      assert.equal(publishedResponse.status, 200);
      const publishedBody = await publishedResponse.json();
      assert.equal(publishedBody.internalGameId, GAME_ID);
      assert.equal(publishedBody.status, "scored");
      assert.equal(publishedBody.prediction.lineup[0].playerId, lineupFor("marines", 9)[0].playerId,
        "authenticated result read resolves this user's Marines contest prediction without changing the API contract");
      assert.equal(fixture.database.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally {
      fixture.close();
    }
  }
});

test("production contest-driven Cron discovers and executes both same-game contests without a team loop", async () => {
  const fixture = await createFixture();
  try {
    for (let pass = 0; pass < 8; pass += 1) {
      const now = new Date(NOW.getTime() + pass * 60_000);
      const result = await runGameAutomationV3(fixture.envFor("fighters"), now, {
        contestDriven: true,
        targetTeamKey: "",
        v4SemiAuto: true,
        runAuxiliary: false,
        gameListOptions: { limit: 50 },
        formalPlanner: (db, contests, at) => planMainWorkflowJobs(db, contests, at, {
          v4SemiAuto: true,
          disabledStages: ["roster_fetch", "lineup_fetch"]
        }),
        executeJob: async (context) => {
          assert.equal(context.job.target_team_key, context.env.TARGET_TEAM_CONTEXT.key,
            "claimed contest identity selects the executor's canonical Team Context");
          return executeGameAutomationV3Job({ ...context, v4SemiAuto: true });
        }
      });
      assert.ok(result.gameCount <= 50, "contest discovery remains bounded");
      if (fixture.database.prepare("SELECT COUNT(*) AS count FROM contest_automation_v3_state WHERE state='published'").get().count === 2) break;
    }
    for (const teamKey of ["fighters", "marines"]) {
      await assertPublishedContest(fixture, teamKey);
      assert.ok(fixture.database.prepare("SELECT 1 FROM game_jobs_v3 WHERE contest_id=? AND status='completed' AND job_type='publish'").get(CONTESTS[teamKey]));
    }
  } finally {
    fixture.close();
  }
});
