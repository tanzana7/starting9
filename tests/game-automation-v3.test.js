import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));

const GAME_ID = "12d554bb-ad25-44be-8159-0134c046dcee";
const START = "2026-08-04T09:00:00.000Z";

function game() {
  return { internalGameId: GAME_ID, startAt: START, gameStatus: "scheduled", isActive: 1, deletedAt: null };
}

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      const bound = (...params) => ({
        all: async () => ({ results: statement.all(...params) }),
        first: async () => statement.get(...params),
        run: async () => {
          const result = statement.run(...params);
          return { meta: { changes: Number(result.changes || 0) } };
        }
      });
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => {
          const result = statement.run();
          return { meta: { changes: Number(result.changes || 0) } };
        },
        bind(...params) {
          return bound(...params);
        }
      };
    }
  };
}

test("V3はfeature flagが明示的に有効なときだけ起動する", () => {
  assert.equal(v3.isGameAutomationV3Enabled({}), false);
  assert.equal(v3.isGameAutomationV3Enabled({ ENABLE_GAME_AUTOMATION_V3: "false" }), false);
  assert.equal(v3.isGameAutomationV3Enabled({ ENABLE_GAME_AUTOMATION_V3: "true" }), true);
});

test("V3の派生時刻はDB startAtから固定され、外部IDを要求しない", () => {
  const schedule = v3.deriveV3Schedule(game());
  assert.equal(schedule.predictionDeadline.toISOString(), "2026-08-04T08:00:00.000Z");
  assert.equal(schedule.lineupPollingStart.toISOString(), "2026-08-04T08:10:00.000Z");
  assert.equal(schedule.finalLineupAt.toISOString(), "2026-08-04T09:02:00.000Z");
  assert.equal(schedule.publicationAt.toISOString(), "2026-08-04T09:10:00.000Z");
  assert.equal(v3.getV3DuePlan(game(), "scheduled", "2026-08-04T08:00:00.000Z").jobType, "prediction_close");
});

test("roster slotは試合開始前だけを表示し、開始時刻と同時刻以後を除外する", () => {
  const afternoon = v3.getV3RosterSlots({
    gameDate: "2026-08-11",
    startAt: "2026-08-11T05:00:00.000Z"
  }).map((slot) => slot.toISOString());
  assert.deepEqual(afternoon, [
    "2026-08-11T03:00:00.000Z",
    "2026-08-11T03:10:00.000Z"
  ]);

  const earlyAfternoon = v3.getV3RosterSlots({
    gameDate: "2026-08-11",
    startAt: "2026-08-11T04:00:00.000Z"
  }).map((slot) => slot.toISOString());
  assert.deepEqual(earlyAfternoon, [
    "2026-08-11T02:00:00.000Z",
    "2026-08-11T02:10:00.000Z"
  ]);

  const noon = v3.getV3RosterSlots({
    gameDate: "2026-08-11",
    startAt: "2026-08-11T03:00:00.000Z"
  }).map((slot) => slot.toISOString());
  assert.deepEqual(noon, [
    "2026-08-11T01:00:00.000Z",
    "2026-08-11T01:10:00.000Z"
  ]);

  const evening = v3.getV3RosterSlots({
    gameDate: "2026-08-11",
    startAt: "2026-08-11T09:00:00.000Z"
  }).map((slot) => slot.toISOString());
  assert.deepEqual(evening, [
    "2026-08-11T07:00:00.000Z",
    "2026-08-11T07:02:00.000Z",
    "2026-08-11T07:10:00.000Z"
  ]);

  const boundary = v3.getV3RosterSlots({
    gameDate: "2026-08-11",
    startAt: "2026-08-11T07:02:00.000Z"
  }).map((slot) => slot.toISOString());
  assert.deepEqual(boundary, [
    "2026-08-11T05:02:00.000Z",
    "2026-08-11T05:12:00.000Z"
  ]);
});

test("NPB識別解決は前日18時・当日16時・10分スロットをJSTで計画する", () => {
  const target = { ...game(), gameDate: "2026-08-05", startAt: "2026-08-05T09:00:00.000Z", npbIdentityStatus: "unresolved" };
  const previousDay = v3.getV3IdentityResolvePlans(target, "2026-08-04T09:00:00.000Z");
  assert.deepEqual(previousDay.map((plan) => plan.scheduledSlotAt.toISOString()), ["2026-08-04T09:00:00.000Z"]);
  const polling = v3.getV3IdentityResolvePlans(target, "2026-08-05T08:20:00.000Z");
  assert.deepEqual(polling.map((plan) => plan.scheduledSlotAt.toISOString()), [
    "2026-08-04T09:00:00.000Z",
    "2026-08-05T07:00:00.000Z",
    "2026-08-05T08:10:00.000Z",
    "2026-08-05T08:20:00.000Z"
  ]);
  assert.equal(v3.getV3IdentityResolvePlans({ ...target, npbIdentityStatus: "resolved" }, "2026-08-05T08:20:00.000Z").length, 0);
});

test("NPB識別情報が未解決の間はlineup jobを計画しない", () => {
  const target = { ...game(), npbIdentityStatus: "unresolved" };
  assert.equal(v3.getV3DuePlan(target, "prediction_closed", "2026-08-04T08:20:00.000Z"), null);
  assert.equal(v3.getV3DuePlan({ ...target, npbGameCode: "f-l-18", npbIdentityStatus: "resolved" }, "prediction_closed", "2026-08-04T08:20:00.000Z").jobType, "lineup_fetch");
});

test("9/1型fixtureはV3 formal planでもV3.5と同じdue判断を返す", () => {
  const target = {
    internalGameId: "fixture-2026-09-01-fighters-hawks",
    gameDate: "2026-09-01",
    startAt: "2026-09-01T09:00:00.000Z",
    homeTeam: "fighters",
    awayTeam: "hawks",
    npbGameCode: "f-h-21",
    npbIdentityStatus: "resolved",
    gameStatus: "scheduled",
    isActive: 1,
    deletedAt: null,
    workflowState: "scheduled"
  };
  const now = new Date("2026-09-01T08:42:00.000Z");
  const plans = v3.buildStagePlans(v3.buildV3PlanningState({
    game: target,
    persistedState: "scheduled",
    effectiveState: "probable_starter_ready",
    jobs: [{ internal_game_id: target.internalGameId, job_type: "probable_starter_fetch", status: "completed" }],
    artifacts: {},
    now
  }));
  assert.equal(plans.find((plan) => plan.stage === "roster_fetch").shouldCreateJob, true);
  assert.equal(plans.find((plan) => plan.stage === "prediction_close").shouldCreateJob, true);
  assert.equal(plans.find((plan) => plan.stage === "lineup_fetch").blockedReason, "PREDICTION_CLOSE_STATE_GATE");
});

test("planning engineはread-onlyで、due plan結果だけを返す", () => {
  const target = { ...game(), npbGameCode: "f-l-18", npbIdentityStatus: "resolved" };
  const plans = v3.buildStagePlans(v3.buildV3PlanningState({
    game: target,
    persistedState: "scheduled",
    now: new Date("2026-08-04T08:00:00.000Z")
  }));
  assert.equal(plans.find((plan) => plan.stage === "prediction_close").insertAllowed, true);
  assert.equal(plans.find((plan) => plan.stage === "prediction_close").shouldCreateJob, true);
});

test("planning engineは別gameまたはgame IDなしのjobで既存job扱いしない", () => {
  const target = {
    ...game(),
    internalGameId: "target-game",
    npbGameCode: "f-l-18",
    npbIdentityStatus: "resolved"
  };
  const base = {
    game: target,
    persistedState: "scheduled",
    effectiveState: "probable_starter_ready",
    now: new Date("2026-08-04T08:00:00.000Z")
  };
  for (const status of ["pending", "claimed", "retry_wait", "completed"]) {
    const plans = v3.buildStagePlans(v3.buildV3PlanningState({
      ...base,
      jobs: [
        { internal_game_id: "other-game", job_type: "prediction_close", status },
        { job_type: "prediction_close", status }
      ]
    }), ["prediction_close"]);
    assert.equal(plans[0].shouldCreateJob, true, `status=${status}`);
    assert.equal(plans[0].existingJob, null, `status=${status}`);
  }
});

test("repository-derived effectiveStateを指定したformal planはjob配列の再推定に依存しない", () => {
  const target = {
    ...game(),
    internalGameId: "derived-state-game",
    npbGameCode: "f-h-21",
    npbIdentityStatus: "resolved"
  };
  const plans = v3.buildStagePlans(v3.buildV3PlanningState({
    game: target,
    persistedState: "scheduled",
    effectiveState: "probable_starter_ready",
    jobs: [],
    now: new Date("2026-09-01T08:42:00.000Z")
  }), ["roster_fetch", "prediction_close", "lineup_fetch"]);
  assert.equal(plans[0].shouldCreateJob, true);
  assert.equal(plans[1].shouldCreateJob, true);
  assert.equal(plans[2].blockedReason, "PREDICTION_CLOSE_STATE_GATE");
});

test("prediction_close完了後は古いstateでもlineup_fetchのgateを解除する", () => {
  const target = {
    ...game(),
    npbGameCode: "f-h-21",
    npbIdentityStatus: "resolved"
  };
  const planningState = v3.buildV3PlanningState({
    game: target,
    persistedState: "scheduled",
    jobs: [{
      internal_game_id: GAME_ID,
      job_type: "prediction_close:prediction_close",
      status: "completed"
    }],
    now: new Date("2026-08-04T08:20:00.000Z")
  });
  const plans = v3.buildStagePlans(planningState, ["prediction_close", "lineup_fetch"]);
  assert.equal(planningState.effectiveState, "prediction_closed");
  assert.equal(plans[0].shouldCreateJob, false);
  assert.equal(plans[1].shouldCreateJob, true);
  assert.notEqual(plans[1].blockedReason, "PREDICTION_CLOSE_STATE_GATE");
});

test("共有job判定は全composite表記を認識し、矛盾projectionを拒否する", () => {
  const cases = [
    ["prediction_close:prediction_close", "prediction_close"],
    ["lineup_fetch:lineup_fetch", "lineup_fetch"],
    ["lineup_finalize:lineup_finalize", "lineup_finalize"],
    ["scoring:scoring", "scoring"],
    ["ranking_reflect:ranking_reflect", "ranking_reflect"],
    ["publish:publish", "publish"]
  ];
  for (const [jobType, stage] of cases) {
    assert.equal(v3.isV3JobForStage({ internal_game_id: GAME_ID, job_type: jobType }, stage), true, jobType);
  }
  assert.equal(v3.isV3JobForStage({ job_type: "prediction_close", stage: "lineup_fetch" }, "prediction_close"), false);
  assert.equal(v3.isV3JobForStage({ jobType: "prediction_close", type: "scoring" }, "prediction_close"), false);
  assert.equal(v3.isV3JobForStage({ job_type: "lineup_fetch:lineup_fetch", stageName: "lineup_finalize" }, "lineup_fetch"), false);
});

test("finalLineupAt後もreadyなlineup_fetch artifactは再取得せずfinalizeを計画する", () => {
  const target = {
    ...game(),
    npbGameCode: "f-h-21",
    npbIdentityStatus: "resolved"
  };
  const plans = v3.buildStagePlans(v3.buildV3PlanningState({
    game: target,
    persistedState: "prediction_closed",
    artifacts: {
      lineup_fetch: {
        available: true,
        ready: true,
        artifactVerified: true,
        candidateExists: true,
        candidateValid: true,
        finalizedValid: false
      }
    },
    now: new Date("2026-08-04T09:03:00.000Z")
  }), ["lineup_fetch", "lineup_finalize"]);
  assert.equal(plans[0].shouldCreateJob, false);
  assert.equal(plans[0].reasonCode, "ARTIFACT_READY");
  assert.equal(plans[0].blocked, false);
  assert.equal(plans[1].shouldCreateJob, true);
  assert.equal(plans[1].reasonCode, "DUE_JOB_MISSING");
});

test("finalLineupAt後にlineup artifactがなければbounded late lineup_fetchを計画する", () => {
  const target = {
    ...game(),
    npbGameCode: "f-h-21",
    npbIdentityStatus: "resolved"
  };
  const plan = v3.buildStagePlan(v3.buildV3PlanningState({
    game: target,
    persistedState: "prediction_closed",
    now: new Date("2026-08-04T09:03:00.000Z")
  }), "lineup_fetch");
  assert.equal(plan.shouldCreateJob, true);
  assert.equal(plan.blocked, false);
  assert.equal(plan.reasonCode, "LATE_LINEUP_FETCH_REQUIRED");
});

test("late lineup_fetchはstartAtから24時間を超えると明確にblockedになる", () => {
  const target = {
    ...game(),
    npbGameCode: "f-h-21",
    npbIdentityStatus: "resolved"
  };
  const plan = v3.buildStagePlan(v3.buildV3PlanningState({
    game: target,
    persistedState: "prediction_closed",
    now: new Date("2026-08-05T09:03:00.000Z")
  }), "lineup_fetch");
  assert.equal(plan.shouldCreateJob, false);
  assert.equal(plan.blocked, true);
  assert.equal(plan.blockedReason, "LINEUP_FETCH_LATE_WINDOW_EXPIRED");
  assert.equal(plan.diagnostics.lateWindowDeadline, "2026-08-05T09:00:00.000Z");
});

test("persistedStateがprediction_closedならeffectiveStateは前段へ巻き戻らない", () => {
  const state = v3.buildV3PlanningState({
    game: game(),
    persistedState: "prediction_closed",
    effectiveState: "probable_starter_ready",
    artifacts: {},
    now: new Date("2026-08-04T08:20:00.000Z")
  });
  assert.equal(state.effectiveState, "prediction_closed");
});

test("roster artifactまたはcompleted roster jobはeffectiveStateをroster_ready以上へ進める", () => {
  const withArtifact = v3.buildV3PlanningState({
    game: game(),
    persistedState: "scheduled",
    artifacts: { roster_fetch: { available: true, valid: true } },
    now: new Date("2026-08-04T07:20:00.000Z")
  });
  const withCompletedJob = v3.buildV3PlanningState({
    game: game(),
    persistedState: "scheduled",
    jobs: [{ internal_game_id: GAME_ID, job_type: "roster_fetch", status: "completed" }],
    now: new Date("2026-08-04T07:20:00.000Z")
  });
  assert.equal(withArtifact.effectiveState, "roster_ready");
  assert.equal(withCompletedJob.effectiveState, "roster_ready");
});

test("prediction_closed以降もscoringからpublishまでdue契約を維持する", () => {
  const target = { ...game(), npbGameCode: "f-h-21", npbIdentityStatus: "resolved" };
  const scorePlan = v3.buildStagePlan(v3.buildV3PlanningState({
    game: target,
    persistedState: "lineup_ready",
    now: new Date("2026-08-04T09:03:00.000Z")
  }), "scoring");
  assert.equal(scorePlan.shouldCreateJob, true);

  const beforePublication = v3.buildStagePlan(v3.buildV3PlanningState({
    game: target,
    persistedState: "scored",
    now: new Date("2026-08-04T09:09:00.000Z")
  }), "ranking_reflect");
  assert.equal(beforePublication.shouldCreateJob, false);
  assert.equal(beforePublication.reasonCode, "NOT_DUE");

  const ranking = v3.buildStagePlan(v3.buildV3PlanningState({
    game: target,
    persistedState: "scored",
    now: new Date("2026-08-04T09:10:00.000Z")
  }), "ranking_reflect");
  assert.equal(ranking.shouldCreateJob, true);

  const publish = v3.buildStagePlan(v3.buildV3PlanningState({
    game: target,
    persistedState: "ranked",
    now: new Date("2026-08-04T09:11:00.000Z")
  }), "publish");
  assert.equal(publish.shouldCreateJob, true);
});

test("保護状態は成果物の存在だけで自動進行しない", () => {
  const target = { ...game(), npbGameCode: "f-h-21", npbIdentityStatus: "resolved" };
  const artifacts = { publish: { available: true, valid: true } };
  assert.equal(v3.buildV3PlanningState({
    game: target,
    persistedState: "failed",
    artifacts
  }).effectiveState, "failed");
  assert.equal(v3.buildV3PlanningState({
    game: target,
    effectiveState: "manual_action_required",
    persistedState: "scheduled",
    artifacts
  }).effectiveState, "manual_action_required");
});

test("lineup_finalize completed時は古いstateを成果物付きでlineup_readyへ追随させる", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const lineup = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      battingOrder: index + 1,
      position: "P",
      playerId: `player-${index + 1}`,
      playerName: `Player ${index + 1}`
    })));
    database.exec(`
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, status TEXT, attempt_count INTEGER, max_attempts INTEGER,
        next_retry_at TEXT, lease_expires_at TEXT, claim_token TEXT, failure_code TEXT,
        failure_message TEXT, created_at TEXT, claimed_at TEXT, completed_at TEXT, updated_at TEXT);
      CREATE TABLE game_lineup_revisions (internal_game_id TEXT, is_final INTEGER,
        actual_lineup_json TEXT, version INTEGER);
      INSERT INTO game_automation_v3_state VALUES
        ('${GAME_ID}', 'scheduled', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
         '${START}', '${START}');
      INSERT INTO game_jobs_v3
        (internal_game_id, job_type, status, attempt_count, max_attempts, claim_token,
         created_at, claimed_at, updated_at)
        VALUES ('${GAME_ID}', 'prediction_close', 'completed', 1, 12, NULL,
          '${START}', '${START}', '${START}');
      INSERT INTO game_jobs_v3
        (internal_game_id, job_type, status, attempt_count, max_attempts, claim_token,
         created_at, claimed_at, updated_at)
        VALUES ('${GAME_ID}', 'lineup_finalize', 'claimed', 1, 12, 'claim-token',
          '${START}', '${START}', '${START}');
      INSERT INTO game_lineup_revisions VALUES ('${GAME_ID}', 1, '${lineup}', 1);
    `);
    const claimed = database.prepare("SELECT * FROM game_jobs_v3 WHERE job_type = 'lineup_finalize'").get();
    const result = await v3.executeClaimedJobs(
      { AUTH_DB: d1(database) },
      [{ job: claimed, claimed, entry: null, claimResult: "claimed" }],
      [{ internalGameId: GAME_ID }],
      new Date("2026-08-04T09:03:00.000Z"),
      { executeJob: async () => ({ status: "completed", stateBefore: "scheduled", stateAfter: "lineup_ready" }) }
    );
    assert.equal(result.processed, 1);
    assert.equal(result.failed, 0);
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE job_type = 'lineup_finalize'").get().status, "completed");
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(GAME_ID).state, "lineup_ready");
  } finally {
    database.close();
  }
});

test("executor reconciliationはcomposite completed jobを使い、先行stateを巻き戻さない", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const lineup = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      battingOrder: index + 1,
      position: "P",
      playerId: `player-${index + 1}`,
      playerName: `Player ${index + 1}`
    })));
    database.exec(`
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, status TEXT, attempt_count INTEGER, max_attempts INTEGER,
        next_retry_at TEXT, lease_expires_at TEXT, claim_token TEXT, failure_code TEXT,
        failure_message TEXT, created_at TEXT, claimed_at TEXT, completed_at TEXT, updated_at TEXT);
      CREATE TABLE game_lineup_revisions (internal_game_id TEXT, is_final INTEGER,
        actual_lineup_json TEXT, version INTEGER);
      INSERT INTO game_automation_v3_state VALUES
        ('${GAME_ID}', 'scheduled', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
         '${START}', '${START}');
      INSERT INTO game_jobs_v3
        (internal_game_id, job_type, status, attempt_count, max_attempts, created_at, completed_at, updated_at)
        VALUES ('${GAME_ID}', 'prediction_close:prediction_close', 'completed', 1, 12,
          '${START}', '${START}', '${START}');
      INSERT INTO game_jobs_v3
        (internal_game_id, job_type, status, attempt_count, max_attempts, claim_token,
         created_at, claimed_at, updated_at)
        VALUES ('${GAME_ID}', 'lineup_finalize:lineup_finalize', 'claimed', 1, 12, 'claim-token',
          '${START}', '${START}', '${START}');
      INSERT INTO game_lineup_revisions VALUES ('${GAME_ID}', 1, '${lineup}', 1);
    `);
    const claimed = database.prepare("SELECT * FROM game_jobs_v3 WHERE job_type LIKE 'lineup_finalize%' ").get();
    const result = await v3.executeClaimedJobs(
      { AUTH_DB: d1(database) },
      [{ job: claimed, claimed, entry: null, claimResult: "claimed" }],
      [{ internalGameId: GAME_ID }],
      new Date("2026-08-04T09:03:00.000Z"),
      { executeJob: async () => ({ status: "completed", stateBefore: "prediction_closed", stateAfter: "lineup_ready" }) }
    );
    assert.equal(result.failed, 0);
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(GAME_ID).state, "lineup_ready");

    database.prepare("UPDATE game_automation_v3_state SET state = 'published' WHERE internal_game_id = ?1").run(GAME_ID);
    await v3.executeClaimedJobs(
      { AUTH_DB: d1(database) },
      [],
      [{ internalGameId: GAME_ID }],
      new Date("2026-08-04T09:03:00.000Z"),
      { executeJob: async () => ({}) }
    );
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(GAME_ID).state, "published");
  } finally {
    database.close();
  }
});

test("canonical identity hydration後のformal plannerはlineup_finalizeをblockedにしない", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const candidate = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      battingOrder: index + 1,
      position: "P",
      playerId: `player-${index + 1}`,
      playerName: `Player ${index + 1}`
    })));
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_identifiers (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        provider TEXT, identifier_type TEXT, identifier_value TEXT, updated_at TEXT);
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, status TEXT, attempt_count INTEGER, max_attempts INTEGER,
        next_retry_at TEXT, lease_expires_at TEXT, claim_token TEXT, failure_code TEXT,
        failure_message TEXT, created_at TEXT, claimed_at TEXT, completed_at TEXT, updated_at TEXT,
        scheduled_at TEXT, scheduled_slot_at TEXT);
      CREATE TABLE game_lineup_revisions (internal_game_id TEXT, is_final INTEGER,
        actual_lineup_json TEXT, version INTEGER);
      CREATE TABLE game_lineups (internal_game_id TEXT, actual_lineup_json TEXT,
        scoring_status TEXT, scored_at TEXT, publication_status TEXT, published_at TEXT);
      CREATE TABLE ranking_reflection_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT,
        internal_game_id TEXT, ranking_update_revision INTEGER, status TEXT);
      INSERT INTO games VALUES
        ('${GAME_ID}', '2026-08-04', '${START}', 'fighters', 'hawks', 'f-h-20', 'unresolved', 'scheduled', 1, NULL);
      INSERT INTO game_identifiers (internal_game_id, provider, identifier_type, identifier_value, updated_at)
        VALUES ('${GAME_ID}', 'npb', 'npb_game_code', 'f-h-21', '${START}');
      INSERT INTO game_automation_v3_state VALUES ('${GAME_ID}', 'prediction_closed');
      INSERT INTO game_lineup_revisions VALUES ('${GAME_ID}', 0, '${candidate}', 1);
      INSERT INTO game_lineups VALUES ('${GAME_ID}', '${candidate}', 'pending', NULL, 'private', NULL);
    `);
    const [hydratedGame] = await v3.listV3Games(d1(database), new Date("2026-08-04T09:03:00.000Z"));
    assert.equal(hydratedGame.npbGameCode, "f-h-21");
    assert.equal(hydratedGame.npbIdentityStatus, "resolved");
    const result = await v3.planV3MainJobs(
      d1(database),
      [hydratedGame],
      new Date("2026-08-04T09:03:00.000Z")
    );
    const finalize = result.planned.find((entry) => entry.plan?.jobType === "lineup_finalize");
    assert.equal(finalize?.created, true);
    assert.notEqual(finalize?.sharedPlan?.blockedReason, "NPB_IDENTITY_UNRESOLVED");

    const unresolved = v3.buildStagePlan(v3.buildV3PlanningState({
      game: { ...hydratedGame, npbGameCode: null, npbIdentityStatus: "unresolved" },
      persistedState: "prediction_closed",
      artifacts: { lineup_fetch: { available: true, candidateExists: true, candidateValid: true } },
      now: new Date("2026-08-04T09:03:00.000Z")
    }), "lineup_finalize");
    assert.equal(unresolved.blockedReason, "NPB_IDENTITY_UNRESOLVED");
  } finally {
    database.close();
  }
});

test("stale scheduled stateはcompleted成果物からpublishまで進み、公開jobを重複作成しない", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const finalLineup = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      battingOrder: index + 1,
      position: "P",
      playerId: `player-${index + 1}`,
      playerName: `Player ${index + 1}`
    })));
    database.exec(`
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, status TEXT, attempt_count INTEGER, max_attempts INTEGER,
        next_retry_at TEXT, lease_expires_at TEXT, claim_token TEXT, failure_code TEXT,
        failure_message TEXT, created_at TEXT, claimed_at TEXT, completed_at TEXT, updated_at TEXT,
        scheduled_at TEXT, scheduled_slot_at TEXT);
      CREATE TABLE game_lineup_revisions (internal_game_id TEXT, is_final INTEGER,
        actual_lineup_json TEXT, version INTEGER);
      CREATE TABLE game_lineups (internal_game_id TEXT, actual_lineup_json TEXT,
        scoring_status TEXT, scored_at TEXT, publication_status TEXT, published_at TEXT);
      CREATE TABLE ranking_reflection_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT,
        internal_game_id TEXT, ranking_update_revision INTEGER, status TEXT);
      INSERT INTO game_automation_v3_state VALUES ('${GAME_ID}', 'scheduled');
      INSERT INTO game_jobs_v3 (internal_game_id, job_type, status, attempt_count, max_attempts,
        created_at, completed_at, updated_at, scheduled_at, scheduled_slot_at)
        VALUES
        ('${GAME_ID}', 'prediction_close', 'completed', 1, 12, '${START}', '${START}', '${START}', '${START}', '${START}'),
        ('${GAME_ID}', 'lineup_finalize', 'completed', 1, 12, '${START}', '${START}', '${START}', '${START}', '${START}'),
        ('${GAME_ID}', 'score', 'completed', 1, 12, '${START}', '${START}', '${START}', '${START}', '${START}'),
        ('${GAME_ID}', 'ranking_rebuild', 'completed', 1, 12, '${START}', '${START}', '${START}', '${START}', '${START}');
      INSERT INTO game_lineup_revisions VALUES ('${GAME_ID}', 1, '${finalLineup}', 1);
      INSERT INTO game_lineups VALUES ('${GAME_ID}', '${finalLineup}', 'scored', '${START}', 'private', NULL);
      INSERT INTO ranking_reflection_revisions (internal_game_id, ranking_update_revision, status)
        VALUES ('${GAME_ID}', 1, 'reflected');
    `);
    const target = { ...game(), npbGameCode: "f-h-21", npbIdentityStatus: "resolved" };
    const now = new Date("2026-08-04T09:10:00.000Z");
    const firstPlan = await v3.planV3MainJobs(d1(database), [target], now);
    assert.equal(firstPlan.created, 1);
    assert.equal(firstPlan.planned.find((entry) => entry.plan?.jobType === "publish")?.created, true);

    const secondPlan = await v3.planV3MainJobs(d1(database), [target], now);
    assert.equal(secondPlan.created, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE job_type = 'publish'").get().count, 1);

    database.prepare("UPDATE game_jobs_v3 SET status = 'completed', completed_at = ?1 WHERE job_type = 'publish'").run(now.toISOString());
    database.prepare("UPDATE game_lineups SET publication_status = 'published', published_at = ?1").run(now.toISOString());
    const publishedPlan = await v3.planV3MainJobs(d1(database), [target], now);
    assert.equal(publishedPlan.created, 0);
    assert.equal(publishedPlan.planned.length, 0);
  } finally {
    database.close();
  }
});

test("V3はgamesが空でもgame_identifiersのNPBコードをlineup対象へ補完する", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_identifiers (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        provider TEXT, identifier_type TEXT, identifier_value TEXT, updated_at TEXT);
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-11', '2026-08-11T05:00:00.000Z',
        'fighters', 'lions', NULL, 'unresolved', 'scheduled', 1, NULL);
      INSERT INTO game_identifiers (internal_game_id, provider, identifier_type, identifier_value, updated_at)
        VALUES ('${GAME_ID}', 'npb', 'npb_game_code', 'f-l-18', '2026-08-10T09:01:02.659Z');
    `);
    const games = await v3.listV3Games(d1(database), new Date("2026-08-11T00:00:00.000Z"));
    assert.equal(games.length, 1);
    assert.equal(games[0].npbGameCode, "f-l-18");
    assert.equal(games[0].npbGameUrl, "https://npb.jp/scores/2026/0811/f-l-18/");
    assert.equal(games[0].npbIdentityStatus, "resolved");
    assert.equal(games[0].npbIdentityState, "resolved");
    assert.equal(games[0].npbIdentitySource, "game_identifiers");
    assert.equal(v3.getV3DuePlan(games[0], "prediction_closed", "2026-08-11T04:10:00.000Z").jobType, "lineup_fetch");
  } finally {
    database.close();
  }
});

test("実repository discoveryは開始後の未公開gameを保持し、published gameを除外する", async () => {
  const database = new DatabaseSync(":memory:");
  const targetId = "0f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  const pastId = "1f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  const publishedId = "2f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  const currentUninitializedId = "3f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  const pastUninitializedId = "4f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  const cancelledId = "5f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  const serviceUnavailableId = "6f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  const excludedId = "7f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  const inactiveId = "8f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  const deletedId = "9f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE game_lineups (
        internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT
      );
      CREATE TABLE ranking_games (
        internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT
      );
      INSERT INTO games VALUES
        ('${targetId}', '2026-09-01', '2026-09-01T09:00:00.000Z', 'fighters', 'hawks', 'f-h-21', 'resolved', 'scheduled', 1, NULL),
        ('${pastId}', '2026-08-31', '2026-08-31T09:00:00.000Z', 'fighters', 'hawks', 'f-h-20', 'resolved', 'scheduled', 1, NULL),
        ('${publishedId}', '2026-09-01', '2026-09-01T09:00:00.000Z', 'fighters', 'hawks', 'f-h-22', 'resolved', 'scheduled', 1, NULL),
        ('${currentUninitializedId}', '2026-09-01', '2026-09-01T10:00:00.000Z', 'fighters', 'hawks', 'f-h-23', 'resolved', 'scheduled', 1, NULL),
        ('${pastUninitializedId}', '2026-08-30', '2026-08-30T09:00:00.000Z', 'fighters', 'hawks', 'f-h-19', 'resolved', 'scheduled', 1, NULL),
        ('${cancelledId}', '2026-09-01', '2026-09-01T11:00:00.000Z', 'fighters', 'hawks', 'f-h-24', 'resolved', 'cancelled', 1, NULL),
        ('${serviceUnavailableId}', '2026-09-01', '2026-09-01T12:00:00.000Z', 'fighters', 'hawks', 'f-h-25', 'resolved', 'service_unavailable', 1, NULL),
        ('${excludedId}', '2026-09-01', '2026-09-01T13:00:00.000Z', 'fighters', 'hawks', 'f-h-26', 'resolved', 'scheduled', 1, NULL),
        ('${inactiveId}', '2026-09-01', '2026-09-01T14:00:00.000Z', 'fighters', 'hawks', 'f-h-27', 'resolved', 'scheduled', 0, NULL),
        ('${deletedId}', '2026-09-01', '2026-09-01T15:00:00.000Z', 'fighters', 'hawks', 'f-h-28', 'resolved', 'scheduled', 1, '2026-09-01T00:00:00.000Z');
      INSERT INTO game_automation_v3_state VALUES
        ('${targetId}', 'prediction_closed'),
        ('${pastId}', 'ranked'),
        ('${publishedId}', 'published'),
        ('${excludedId}', 'excluded');
      INSERT INTO game_lineups VALUES
        ('${targetId}', 'pending', NULL),
        ('${pastId}', 'scored_private', NULL),
        ('${publishedId}', 'published', '2026-09-01T10:00:00.000Z');
    `);
    const games = await v3.listV3Games(
      d1(database),
      new Date("2026-09-01T12:40:00.000Z")
    );
    const ids = games.map((entry) => entry.internalGameId);
    assert.ok(ids.includes(targetId), "開始後でも未公開prediction_closed gameを候補に含めること");
    assert.ok(ids.includes(pastId), "前日でも未公開stateのgameを候補に保持すること");
    assert.ok(ids.includes(currentUninitializedId), "当日のstateなしgameは既存初期化対象として保持すること");
    assert.ok(!ids.includes(publishedId), "published gameを候補から除外すること");
    for (const excludedIdValue of [pastUninitializedId, cancelledId, serviceUnavailableId, excludedId, inactiveId, deletedId]) {
      assert.ok(!ids.includes(excludedIdValue), `除外対象gameを候補に含めないこと: ${excludedIdValue}`);
    }
    assert.equal(games.find((entry) => entry.internalGameId === targetId)?.workflowState, "prediction_closed");
    assert.equal(games.find((entry) => entry.internalGameId === targetId)?.isPublished, false);
  } finally {
    database.close();
  }
});

test("enriched discovery queryが失敗した場合はworkflow-aware fallbackを診断ログに残す", async () => {
  const database = new DatabaseSync(":memory:");
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (
        internal_game_id TEXT PRIMARY KEY, state TEXT
      );
      INSERT INTO games VALUES ('fallback-game', '2026-09-01', '2026-09-01T09:00:00.000Z',
        'fighters', 'hawks', 'f-h-21', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO games VALUES ('historical-fallback-game', '2026-08-31', '2026-08-31T09:00:00.000Z',
        'fighters', 'hawks', 'f-h-20', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES ('historical-fallback-game', 'scored');
    `);
    const games = await v3.listV3Games(d1(database), new Date("2026-09-01T12:40:00.000Z"));
    assert.equal(games.length, 2);
    assert.ok(games.some((game) => game.internalGameId === "historical-fallback-game"));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /V3_DISCOVERY_FALLBACK/);
    assert.match(warnings[0], /workflow_state_fallback/);
    assert.match(warnings[0], /historicalUnpublishedRetention":true/);
  } finally {
    console.warn = originalWarn;
    database.close();
  }
});

test("過去日の未公開workflow stateはpublishedまで候補に保持する", async () => {
  const database = new DatabaseSync(":memory:");
  const states = ["scheduled", "probable_starter_ready", "roster_ready", "prediction_closed", "lineup_ready", "scored", "ranked"];
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE game_lineups (internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT);
      CREATE TABLE ranking_games (internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT);
    `);
    const insertGame = database.prepare(
      "INSERT INTO games VALUES (?1, '2026-08-31', '2026-08-31T09:00:00.000Z', 'fighters', 'hawks', ?2, 'resolved', 'scheduled', 1, NULL)"
    );
    const insertState = database.prepare("INSERT INTO game_automation_v3_state VALUES (?1, ?2)");
    states.forEach((state, index) => {
      const id = `state-${index}`;
      insertGame.run(id, `f-h-${index + 1}`);
      insertState.run(id, state);
    });
    const games = await v3.listV3Games(d1(database), new Date("2026-09-01T12:40:00.000Z"));
    assert.deepEqual(new Set(games.map((game) => game.workflowState)), new Set(states));
    assert.equal(games.length, states.length);
  } finally {
    database.close();
  }
});

test("correction由来のpending score jobがあるmanual_action_required過去試合だけformal対象へ戻る", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT);
      CREATE TABLE game_lineups (internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT);
      CREATE TABLE ranking_games (internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT);
      CREATE TABLE game_jobs_v3 (internal_game_id TEXT, job_type TEXT, status TEXT);
      INSERT INTO games VALUES
        ('correction-pending', '2026-08-31', '2026-08-31T09:00:00.000Z', 'fighters', 'hawks', 'f-h-90', 'resolved', 'scheduled', 1, NULL),
        ('manual-without-job', '2026-08-30', '2026-08-30T09:00:00.000Z', 'fighters', 'hawks', 'f-h-91', 'resolved', 'scheduled', 1, NULL),
        ('published-history', '2026-08-29', '2026-08-29T09:00:00.000Z', 'fighters', 'hawks', 'f-h-92', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES
        ('correction-pending', 'manual_action_required'),
        ('manual-without-job', 'manual_action_required'),
        ('published-history', 'published');
      INSERT INTO game_lineups VALUES
        ('correction-pending', 'pending', NULL),
        ('manual-without-job', 'pending', NULL),
        ('published-history', 'published', '2026-08-29T10:00:00.000Z');
      INSERT INTO ranking_games VALUES
        ('correction-pending', 'pending', NULL),
        ('manual-without-job', 'pending', NULL),
        ('published-history', 'published', '2026-08-29T10:00:00.000Z');
      INSERT INTO game_jobs_v3 VALUES ('correction-pending', 'score', 'pending');
    `);
    const games = await v3.listV3Games(d1(database), new Date("2026-09-01T12:40:00.000Z"));
    const ids = new Set(games.map((game) => game.internalGameId));
    assert.equal(ids.has("correction-pending"), true);
    assert.equal(ids.has("manual-without-job"), false);
    assert.equal(ids.has("published-history"), false);
  } finally {
    database.close();
  }
});

for (const terminal of ["missing", "failed"]) test(`過去日の訂正Bでscore job ${terminal}からscore→ranking→publishへ復旧する`, async () => {
  const database = new DatabaseSync(":memory:");
  const internalGameId = "9f7e3bb2-55d2-4d6c-9a32-2f5d8d8b1c20";
  const lineupJson = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
    battingOrder: index + 1,
    position: index === 0 ? "捕" : "内野",
    playerId: `fighters-${index + 1}`,
    playerName: `Fighters ${index + 1}`,
    uniformNumber: String(index + 1)
  })));
  const firstRunAt = new Date("2026-09-01T00:00:00.000Z");
  const correctionSlot = firstRunAt.toISOString();
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (
        internal_game_id TEXT PRIMARY KEY, state TEXT, version INTEGER,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE game_lineups (
        internal_game_id TEXT PRIMARY KEY, game_id TEXT, actual_lineup_json TEXT,
        final_lineup_revision_id TEXT, scoring_status TEXT, scored_at TEXT,
        publication_status TEXT, published_at TEXT
      );
      CREATE TABLE game_lineup_revisions (
        internal_game_id TEXT, game_id TEXT, version INTEGER, revision_id TEXT,
        is_final INTEGER, actual_lineup_json TEXT
      );
      CREATE TABLE ranking_games (
        internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT,
        game_status TEXT
      );
      CREATE TABLE ranking_reflection_revisions (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, scoring_revision_id TEXT,
        ranking_update_revision INTEGER, status TEXT, reflected_at TEXT
      );
      CREATE TABLE game_scoring_revisions (
        id TEXT PRIMARY KEY, internal_game_id TEXT, lineup_revision_id TEXT,
        status TEXT, revision_number INTEGER, completed_at TEXT, is_active INTEGER
      );
      CREATE TABLE predictions (
        id TEXT PRIMARY KEY, user_id TEXT, game_id TEXT, score INTEGER,
        max_score INTEGER, status TEXT, scored_at TEXT, is_test_prediction INTEGER
      );
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT,
        scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT,
        UNIQUE(internal_game_id, job_type, scheduled_slot_at)
      );
      INSERT INTO games VALUES ('${internalGameId}', '2026-08-31', '2026-08-31T09:00:00.000Z', 'fighters', 'hawks', 'f-h-99', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES ('${internalGameId}', 'manual_action_required', 3, NULL, '2026-08-31T01:00:00.000Z', 'score-revision-a', '2026-08-31T02:00:00.000Z', '2026-08-31T03:00:00.000Z', NULL, NULL, NULL, '2026-08-01T00:00:00.000Z', '2026-08-31T03:00:00.000Z');
      INSERT INTO game_lineups VALUES ('${internalGameId}', '${internalGameId}', '${lineupJson}', '${internalGameId}:2', 'pending', NULL, 'pending', NULL);
      INSERT INTO game_lineup_revisions VALUES ('${internalGameId}', '${internalGameId}', 2, '${internalGameId}:2', 1, '${lineupJson}');
      INSERT INTO ranking_games VALUES ('${internalGameId}', 'pending', NULL, 'pending');
      INSERT INTO ranking_reflection_revisions VALUES (1, '${internalGameId}', 'score-revision-a', 1, 'reflected', NULL);
      INSERT INTO game_scoring_revisions VALUES ('score-revision-a', '${internalGameId}', '${internalGameId}:1', 'completed', 1, '2026-08-31T02:00:00.000Z', 1);
      INSERT INTO predictions VALUES ('prediction-1', 'user-1', '${internalGameId}', 80, 100, 'scored', '2026-08-31T09:20:00.000Z', 0);
      INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, max_attempts, created_at, updated_at)
        VALUES
          ('${internalGameId}', 'score', '2026-08-31T09:10:00.000Z', '2026-08-31T09:10:00.000Z', 'completed', 1, 12, '2026-08-31T09:10:00.000Z', '2026-08-31T09:10:00.000Z'),
          ('${internalGameId}', 'ranking_rebuild', '2026-08-31T09:10:00.000Z', '2026-08-31T09:10:00.000Z', 'completed', 1, 12, '2026-08-31T09:10:00.000Z', '2026-08-31T09:10:00.000Z'),
          ('${internalGameId}', 'publish', '2026-08-31T09:10:00.000Z', '2026-08-31T09:10:00.000Z', 'completed', 1, 12, '2026-08-31T09:10:00.000Z', '2026-08-31T09:10:00.000Z');
    `);
    if (terminal === "failed") database.prepare(
      `INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, max_attempts, created_at, updated_at)
       VALUES (?1, 'score', ?2, ?2, 'failed', 12, 12, ?2, ?2)`
    ).run(internalGameId, correctionSlot);
    const executionTypes = [];
    const errors = [];
    let optionalPromise = null;
    const run = async (now) => {
      optionalPromise = null;
      const result = await v3.runGameAutomationV3(
        { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" },
        now,
        {
        formalPlanner: (db, games, plannerNow) => v3.planMainWorkflowJobs(db, games, plannerNow, {
          disabledStages: ["roster_fetch", "lineup_fetch"]
        }),
        auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
        scheduleOptional: (promise) => { optionalPromise = promise; },
        onError: (error, context) => { errors.push({ code: error?.code || null, message: String(error?.message || ""), stage: context?.stage || null, jobType: context?.plan?.jobType || context?.job?.job_type || null, internalGameId: context?.game?.internalGameId || context?.job?.internal_game_id || null, jobId: context?.job?.id || null }); },
        executeJob: async ({ job }) => {
          executionTypes.push(job.job_type);
          if (job.job_type === "score") {
            database.prepare("UPDATE game_lineups SET scoring_status = 'scored', scored_at = ?1 WHERE internal_game_id = ?2").run(now.toISOString(), internalGameId);
            database.prepare("UPDATE game_automation_v3_state SET scoring_revision_id = 'score-revision-b' WHERE internal_game_id = ?1").run(internalGameId);
            database.prepare("UPDATE game_scoring_revisions SET is_active = 0 WHERE internal_game_id = ?1").run(internalGameId);
            database.prepare("INSERT INTO game_scoring_revisions VALUES ('score-revision-b', ?1, ?2, 'completed', 2, ?3, 1)")
              .run(internalGameId, `${internalGameId}:2`, now.toISOString());
            database.prepare("UPDATE predictions SET score = 90, scored_at = ?1 WHERE id = 'prediction-1'").run(now.toISOString());
            return { status: "scored", stateBefore: "manual_action_required", stateAfter: "scored" };
          }
          if (job.job_type === "ranking_rebuild") {
            database.prepare("INSERT INTO ranking_reflection_revisions VALUES (2, ?1, 'score-revision-b', 2, 'reflected', NULL)").run(internalGameId);
            database.prepare("UPDATE ranking_games SET publication_status = 'scored_private', game_status = 'scored' WHERE internal_game_id = ?1").run(internalGameId);
            return { status: "ranked", stateBefore: "scored", stateAfter: "ranked" };
          }
          database.prepare("UPDATE game_lineups SET publication_status = 'published', published_at = ?1 WHERE internal_game_id = ?2").run(now.toISOString(), internalGameId);
          database.prepare("UPDATE ranking_games SET publication_status = 'published', published_at = ?1 WHERE internal_game_id = ?2").run(now.toISOString(), internalGameId);
          return { status: "published", stateBefore: "ranked", stateAfter: "published" };
        }
      }
      );
      if (optionalPromise) await optionalPromise;
      return result;
    };

    const bootstrap = await run(firstRunAt);
    assert.equal(bootstrap.mainPlan.created, 1);
    assert.deepEqual(executionTypes, []);
    const first = await run(new Date(firstRunAt.getTime() + 2000));
    assert.equal(first.execution.failed, 0, JSON.stringify(errors));
    assert.deepEqual(executionTypes, ["score"], JSON.stringify({ mainPlan: first.mainPlan, errors }));
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(internalGameId).state, "scored");

    const second = await run(new Date(firstRunAt.getTime() + 4000));
    assert.equal(second.execution.failed, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'ranking_rebuild'").get(internalGameId).count, 2, JSON.stringify(second.mainPlan?.diagnostics || []));
    assert.deepEqual(executionTypes, ["score"]);

    const third = await run(new Date(firstRunAt.getTime() + 6000));
    assert.equal(third.execution.failed, 0);
    assert.deepEqual(executionTypes, ["score", "ranking_rebuild"]);
    assert.equal(database.prepare("SELECT scoring_revision_id FROM ranking_reflection_revisions WHERE id = 2").get().scoring_revision_id, "score-revision-b");
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(internalGameId).state, "ranked");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'ranking_rebuild'").get(internalGameId).count, 2, JSON.stringify(database.prepare("SELECT id, job_type, status, scheduled_slot_at FROM game_jobs_v3 WHERE internal_game_id = ?1 ORDER BY id").all(internalGameId)));

    const fourth = await run(new Date(firstRunAt.getTime() + 8000));
    assert.equal(fourth.execution.failed, 0, JSON.stringify(errors));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'publish'").get(internalGameId).count, 2);
    assert.deepEqual(executionTypes, ["score", "ranking_rebuild"]);

    const fifth = await run(new Date(firstRunAt.getTime() + 10000));
    assert.equal(fifth.execution.failed, 0);
    assert.deepEqual(executionTypes, ["score", "ranking_rebuild", "publish"]);
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(internalGameId).state, "published");
    assert.equal(database.prepare("SELECT publication_status FROM game_lineups WHERE internal_game_id = ?1").get(internalGameId).publication_status, "published");
    assert.equal(database.prepare("SELECT COUNT(*) AS count, SUM(score) AS total FROM predictions WHERE game_id = ?1 AND is_test_prediction = 0").get(internalGameId).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count, SUM(score) AS total FROM predictions WHERE game_id = ?1 AND is_test_prediction = 0").get(internalGameId).total, 90);

    const sixth = await run(new Date(firstRunAt.getTime() + 12000));
    assert.equal(sixth.execution.failed, 0);
    assert.deepEqual(executionTypes, ["score", "ranking_rebuild", "publish"]);
  } finally {
    database.close();
  }
});

test("途中状態のcorrectionはranked state gateを越え、既存publish retry_waitを再開する", async () => {
  const database = new DatabaseSync(":memory:");
  const internalGameId = "8e7d6c5b-4a39-4b28-9c17-2f6e5d4c3b20";
  const lineupJson = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
    battingOrder: index + 1,
    position: index === 0 ? "捕" : "内野",
    playerId: `fighters-midflight-${index + 1}`,
    playerName: `Fighters Midflight ${index + 1}`,
    uniformNumber: String(index + 1)
  })));
  const firstRunAt = new Date("2026-09-01T00:00:00.000Z");
  const publishRetryAt = new Date(firstRunAt.getTime() + 10_000).toISOString();
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (
        internal_game_id TEXT PRIMARY KEY, state TEXT, version INTEGER,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE game_lineups (
        internal_game_id TEXT PRIMARY KEY, game_id TEXT, actual_lineup_json TEXT,
        final_lineup_revision_id TEXT, scoring_status TEXT, scored_at TEXT,
        publication_status TEXT, published_at TEXT
      );
      CREATE TABLE game_lineup_revisions (
        internal_game_id TEXT, game_id TEXT, version INTEGER, revision_id TEXT,
        is_final INTEGER, actual_lineup_json TEXT
      );
      CREATE TABLE ranking_games (
        internal_game_id TEXT PRIMARY KEY, publication_status TEXT, published_at TEXT,
        game_status TEXT
      );
      CREATE TABLE ranking_reflection_revisions (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, scoring_revision_id TEXT,
        ranking_update_revision INTEGER, status TEXT
      );
      CREATE TABLE predictions (
        id TEXT PRIMARY KEY, user_id TEXT, game_id TEXT, score INTEGER,
        max_score INTEGER, status TEXT, scored_at TEXT, is_test_prediction INTEGER
      );
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT,
        scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT,
        UNIQUE(internal_game_id, job_type, scheduled_slot_at)
      );
      INSERT INTO games VALUES ('${internalGameId}', '2026-08-31', '2026-08-31T09:00:00.000Z', 'fighters', 'hawks', 'f-h-100', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES ('${internalGameId}', 'ranked', 8, '2026-08-31T00:00:00.000Z', '2026-08-31T01:00:00.000Z', 'score-revision-b', '2026-08-31T02:00:00.000Z', NULL, NULL, NULL, NULL, '2026-08-01T00:00:00.000Z', '2026-08-31T02:00:00.000Z');
      INSERT INTO game_lineups VALUES ('${internalGameId}', '${internalGameId}', '${lineupJson}', '${internalGameId}:2', 'scored', '2026-08-31T01:30:00.000Z', 'pending', NULL);
      INSERT INTO game_lineup_revisions VALUES ('${internalGameId}', '${internalGameId}', 2, '${internalGameId}:2', 1, '${lineupJson}');
      INSERT INTO ranking_games VALUES ('${internalGameId}', 'pending', NULL, 'scored');
      INSERT INTO ranking_reflection_revisions VALUES (1, '${internalGameId}', 'score-revision-a', 1, 'reflected');
      INSERT INTO predictions VALUES ('prediction-midflight-1', 'user-midflight', '${internalGameId}', 90, 100, 'scored', '2026-08-31T01:40:00.000Z', 0);
      INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, max_attempts, next_retry_at, failure_code, created_at, updated_at)
        VALUES
          ('${internalGameId}', 'score', '2026-08-31T01:10:00.000Z', '2026-08-31T01:10:00.000Z', 'completed', 1, 12, NULL, NULL, '2026-08-31T01:10:00.000Z', '2026-08-31T01:10:00.000Z'),
          ('${internalGameId}', 'ranking_rebuild', '2026-08-31T01:10:00.000Z', '2026-08-31T01:10:00.000Z', 'completed', 1, 12, NULL, NULL, '2026-08-31T01:10:00.000Z', '2026-08-31T01:10:00.000Z'),
          ('${internalGameId}', 'publish', '2026-08-31T01:10:00.000Z', '2026-08-31T01:10:00.000Z', 'completed', 1, 12, NULL, NULL, '2026-08-31T01:10:00.000Z', '2026-08-31T01:10:00.000Z'),
          ('${internalGameId}', 'score', '2026-08-31T01:11:00.000Z', '2026-08-31T01:11:00.000Z', 'completed', 1, 12, NULL, NULL, '2026-08-31T01:11:00.000Z', '2026-08-31T01:11:00.000Z'),
          ('${internalGameId}', 'publish', '2026-08-31T01:12:00.000Z', '2026-08-31T01:12:00.000Z', 'retry_wait', 1, 12, '${publishRetryAt}', 'V3_RANKING_REVISION_NOT_REFLECTED', '2026-08-31T01:12:00.000Z', '2026-08-31T01:12:00.000Z');
    `);

    const before = await v3.listV3Games(d1(database), firstRunAt);
    assert.equal(before.some((game) => game.internalGameId === internalGameId), true);

    const executionTypes = [];
    const errors = [];
    let optionalPromise = null;
    const run = async (now) => {
      optionalPromise = null;
      const result = await v3.runGameAutomationV3(
        { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" },
        now,
        {
          formalPlanner: (db, games, plannerNow) => v3.planMainWorkflowJobs(db, games, plannerNow, {
            disabledStages: ["roster_fetch", "lineup_fetch"]
          }),
          auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
          scheduleOptional: (promise) => { optionalPromise = promise; },
          onError: (error) => { errors.push({ code: error?.code || null, message: String(error?.message || "") }); },
          executeJob: async ({ job, now: executionNow }) => {
            executionTypes.push(job.job_type);
            if (job.job_type === "ranking_rebuild") {
              database.prepare("INSERT INTO ranking_reflection_revisions VALUES (2, ?1, 'score-revision-b', 2, 'reflected')").run(internalGameId);
              database.prepare("UPDATE ranking_games SET publication_status = 'scored_private', game_status = 'scored' WHERE internal_game_id = ?1").run(internalGameId);
              return { status: "ranked", stateBefore: "ranked", stateAfter: "ranked" };
            }
            database.prepare("UPDATE game_lineups SET publication_status = 'published', published_at = ?1 WHERE internal_game_id = ?2").run(executionNow.toISOString(), internalGameId);
            database.prepare("UPDATE ranking_games SET publication_status = 'published', published_at = ?1 WHERE internal_game_id = ?2").run(executionNow.toISOString(), internalGameId);
            return { status: "published", stateBefore: "ranked", stateAfter: "published" };
          }
        }
      );
      if (optionalPromise) await optionalPromise;
      return result;
    };

    const first = await run(firstRunAt);
    assert.equal(first.execution.failed, 0, JSON.stringify(errors));
    assert.equal(first.mainPlan.created, 1, JSON.stringify(first.mainPlan.diagnostics));
    assert.deepEqual(executionTypes, []);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'ranking_rebuild'").get(internalGameId).count, 2);

    const second = await run(new Date(firstRunAt.getTime() + 2_000));
    assert.equal(second.execution.failed, 0, JSON.stringify(errors));
    assert.deepEqual(executionTypes, ["ranking_rebuild"]);
    assert.equal(database.prepare("SELECT scoring_revision_id FROM ranking_reflection_revisions WHERE id = 2").get().scoring_revision_id, "score-revision-b");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ranking_reflection_revisions WHERE internal_game_id = ?1").get(internalGameId).count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count, SUM(score) AS total FROM predictions WHERE game_id = ?1 AND is_test_prediction = 0").get(internalGameId).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count, SUM(score) AS total FROM predictions WHERE game_id = ?1 AND is_test_prediction = 0").get(internalGameId).total, 90);

    const third = await run(new Date(firstRunAt.getTime() + 12_000));
    assert.equal(third.execution.failed, 0, JSON.stringify(errors));
    assert.deepEqual(executionTypes, ["ranking_rebuild", "publish"]);
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'publish' AND scheduled_slot_at = '2026-08-31T01:12:00.000Z'").get(internalGameId).status, "completed");
    assert.equal(database.prepare("SELECT publication_status FROM game_lineups WHERE internal_game_id = ?1").get(internalGameId).publication_status, "published");
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(internalGameId).state, "published");
    assert.equal((await v3.listV3Games(d1(database), new Date(firstRunAt.getTime() + 12_000))).some((game) => game.internalGameId === internalGameId), false);

    const jobCount = database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1").get(internalGameId).count;
    const fourth = await run(new Date(firstRunAt.getTime() + 14_000));
    assert.equal(fourth.execution.failed, 0, JSON.stringify(errors));
    assert.deepEqual(executionTypes, ["ranking_rebuild", "publish"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ranking_reflection_revisions WHERE internal_game_id = ?1").get(internalGameId).count, 2);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1").get(internalGameId).count, jobCount);
  } finally {
    database.close();
  }
});

test("実repository discoveryからformal plannerのlineup_fetch insertまで到達する", async () => {
  const database = new DatabaseSync(":memory:");
  const internalGameId = "3f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  const historicalUninitializedId = "4f30b9bb-c8b0-4dc4-a8c9-c47777851362";
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (
        internal_game_id TEXT PRIMARY KEY, state TEXT, version INTEGER,
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT,
        scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT,
        UNIQUE(internal_game_id, job_type, scheduled_slot_at)
      );
      CREATE TABLE game_lineups (
        internal_game_id TEXT PRIMARY KEY, actual_lineup_json TEXT,
        scoring_status TEXT, scored_at TEXT, publication_status TEXT, published_at TEXT
      );
      CREATE TABLE game_lineup_revisions (
        internal_game_id TEXT, is_final INTEGER, actual_lineup_json TEXT, version INTEGER
      );
      CREATE TABLE ranking_reflection_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        ranking_update_revision INTEGER, status TEXT
      );
      INSERT INTO games VALUES (
        '${internalGameId}', '2026-09-01', '2026-09-01T09:00:00.000Z',
        'fighters', 'hawks', 'f-h-21', 'resolved', 'scheduled', 1, NULL
      );
      INSERT INTO games VALUES (
        '${historicalUninitializedId}', '2026-08-30', '2026-08-30T09:00:00.000Z',
        'fighters', 'hawks', 'f-h-20', 'resolved', 'scheduled', 1, NULL
      );
      INSERT INTO game_automation_v3_state VALUES (
        '${internalGameId}', 'prediction_closed', 1,
        '2026-09-01T08:00:00.000Z', '2026-09-01T08:00:00.000Z'
      );
      INSERT INTO game_lineups VALUES ('${internalGameId}', NULL, NULL, NULL, 'private', NULL);
    `);
    let optionalPromise = null;
    const result = await v3.runGameAutomationV3(
      { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" },
      new Date("2026-09-01T08:10:00.000Z"),
      {
        scheduleOptional: (promise) => { optionalPromise = promise; },
        auxiliaryPlanner: async () => ({ created: 0, planned: [], diagnostics: [], errors: [] }),
        executeJob: async ({ job }) => ({
          status: "completed",
          stateBefore: job.job_type === "lineup_fetch" ? "prediction_closed" : "scheduled",
          stateAfter: "prediction_closed"
        })
      }
    );
    if (optionalPromise) await optionalPromise;
    const lineupJob = database.prepare(
      "SELECT * FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'lineup_fetch'"
    ).get(internalGameId);
    assert.equal(result.gameCount, 1);
    assert.equal(result.mainPlan.created, 1);
    assert.equal(result.mainPlan.planned[0]?.plan?.jobType, "lineup_fetch");
    assert.equal(lineupJob?.internal_game_id, internalGameId);
    assert.equal(lineupJob?.scheduled_slot_at, "2026-09-01T08:10:00.000Z");
    assert.equal(lineupJob?.status, "completed");
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM game_automation_v3_state WHERE internal_game_id = ?1"
    ).get(historicalUninitializedId).count, 0);
    assert.equal(database.prepare(
      "SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1"
    ).get(historicalUninitializedId).count, 0);
  } finally {
    database.close();
  }
});

test("古いgames側のNPB identityはcanonical game_identifiersで再評価する", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_identifiers (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        provider TEXT, identifier_type TEXT, identifier_value TEXT, updated_at TEXT);
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-11', '2026-08-11T05:00:00.000Z',
        'fighters', 'lions', 'f-l-17', 'unresolved', 'scheduled', 1, NULL);
      INSERT INTO game_identifiers (internal_game_id, provider, identifier_type, identifier_value, updated_at)
        VALUES ('${GAME_ID}', 'npb', 'npb_game_code', 'f-l-18', '2026-08-10T09:01:02.659Z');
    `);
    const games = await v3.listV3Games(d1(database), new Date("2026-08-11T00:00:00.000Z"));
    assert.equal(games[0].npbGameCode, "f-l-18");
    assert.equal(games[0].npbGameUrl, "https://npb.jp/scores/2026/0811/f-l-18/");
    assert.equal(games[0].npbIdentityStatus, "resolved");
    assert.equal(games[0].npbIdentityState, "resolved");
    assert.equal(v3.getV3DuePlan(games[0], "prediction_closed", "2026-08-11T09:02:00.000Z").jobType, "lineup_fetch");
  } finally {
    database.close();
  }
});

test("V3は複数のNPBコードを推測採用せずidentity conflictとして扱う", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_identifiers (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        provider TEXT, identifier_type TEXT, identifier_value TEXT, updated_at TEXT);
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-11', '2026-08-11T05:00:00.000Z',
        'fighters', 'lions', NULL, 'unresolved', 'scheduled', 1, NULL);
      INSERT INTO game_identifiers (internal_game_id, provider, identifier_type, identifier_value, updated_at)
        VALUES ('${GAME_ID}', 'npb', 'npb_game_code', 'f-l-18', '2026-08-10T09:01:02.659Z');
      INSERT INTO game_identifiers (internal_game_id, provider, identifier_type, identifier_value, updated_at)
        VALUES ('${GAME_ID}', 'npb', 'npb_game_code', 'f-l-19', '2026-08-10T09:01:03.659Z');
    `);
    const games = await v3.listV3Games(d1(database), new Date("2026-08-11T00:00:00.000Z"));
    assert.equal(games[0].npbGameCode, null);
    assert.equal(games[0].npbIdentityStatus, "conflict");
    assert.equal(v3.getV3DuePlan(games[0], "prediction_closed", "2026-08-11T04:10:00.000Z"), null);
  } finally {
    database.close();
  }
});

test("V3の状態機械は正常遷移だけを受け入れ、旧状態名を含めない", () => {
  assert.equal(v3.getV3AllowedTransitions("scheduled", "prediction_closed"), true);
  assert.equal(v3.getV3AllowedTransitions("prediction_closed", "lineup_ready"), true);
  assert.equal(v3.getV3AllowedTransitions("lineup_ready", "scored"), true);
  assert.equal(v3.getV3AllowedTransitions("scored", "ranked"), true);
  assert.equal(v3.getV3AllowedTransitions("ranked", "published"), true);
  assert.equal(v3.getV3AllowedTransitions("published", "scored"), false);
  assert.equal(v3.getV3AllowedTransitions("scheduled", "retrying"), false);
});

test("V3全job typeはstate gateから各plannerへ到達できる", () => {
  const target = { ...game(), npbGameCode: "f-l-18", npbIdentityStatus: "resolved" };
  assert.deepEqual(v3.V3_JOB_TYPES, [
    "npb_identity_resolve", "prediction_close", "lineup_fetch", "lineup_finalize",
    "score", "ranking_rebuild", "publish", "probable_starter_fetch", "roster_fetch"
  ]);
  assert.deepEqual(v3.getV3DuePlans(target, "scheduled", "2026-08-04T08:00:00.000Z").map((plan) => plan.jobType), ["prediction_close"]);
  assert.deepEqual(v3.getV3DuePlans(target, "prediction_closed", "2026-08-04T08:20:00.000Z").map((plan) => plan.jobType), ["lineup_fetch"]);
  assert.deepEqual(v3.getV3DuePlans(target, "prediction_closed", "2026-08-04T09:03:00.000Z").map((plan) => plan.jobType), ["lineup_fetch"]);
  assert.deepEqual(v3.getV3DuePlans(target, "lineup_ready", "2026-08-04T09:03:00.000Z").map((plan) => plan.jobType), ["score"]);
  assert.deepEqual(v3.getV3DuePlans(target, "scored", "2026-08-04T09:09:00.000Z").map((plan) => plan.jobType), []);
  assert.deepEqual(v3.getV3DuePlans(target, "scored", "2026-08-04T09:10:00.000Z").map((plan) => plan.jobType), ["ranking_rebuild"]);
  assert.deepEqual(v3.getV3DuePlans(target, "ranked", "2026-08-04T09:11:00.000Z").map((plan) => plan.jobType), ["publish"]);
});

test("formal plannerはstate表記を正規化してdue後のprediction_closeを正式job候補にする", () => {
  const target = { ...game(), startAt: "2026-08-04T09:00:00.000Z" };
  assert.deepEqual(
    v3.getV3FormalDuePlans(target, "  SCHEDULED ", "2026-08-04T08:00:00.000Z").map((plan) => plan.jobType),
    ["prediction_close"]
  );
});

test("V3 job slot is unique and claim is atomic", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return { bind(...args) { statements.push({ sql, args }); return { async run() { return { meta: { changes: 1 } }; }, async first() { return { id: 1, ...Object.fromEntries(args.map((value, index) => [`arg${index}`, value])) }; } }; } };
    }
  };
  const created = await v3.createV3Job(db, { internalGameId: GAME_ID, jobType: "lineup_fetch", scheduledSlotAt: START });
  assert.equal(created.created, true);
  assert.match(statements[0].sql, /INSERT OR IGNORE/);
  assert.match(statements[0].sql, /UNIQUE|game_jobs_v3/);
});

test("一つのjobのexecutor失敗でも次のjobを処理し、失敗jobをretryへ送る", async () => {
  const database = new DatabaseSync(":memory:");
  const firstId = "6e4f2f3b-2de9-49fb-89b1-5e3f3ac9b001";
  const secondId = "6e4f2f3b-2de9-49fb-89b1-5e3f3ac9b002";
  try {
    database.exec(`
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, job_type TEXT, status TEXT,
        scheduled_at TEXT,
        attempt_count INTEGER, max_attempts INTEGER, next_retry_at TEXT,
        lease_expires_at TEXT, claim_token TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, claimed_at TEXT, completed_at TEXT, updated_at TEXT
      );
      INSERT INTO game_jobs_v3
        (id, internal_game_id, job_type, status, attempt_count, max_attempts,
         claim_token, created_at, claimed_at, updated_at)
      VALUES
        (1, '${firstId}', 'publish', 'claimed', 1, 12, 'token-1',
         '2026-08-04T09:00:00.000Z', '2026-08-04T09:00:00.000Z', '2026-08-04T09:00:00.000Z'),
        (2, '${secondId}', 'publish', 'claimed', 1, 12, 'token-2',
         '2026-08-04T09:00:00.000Z', '2026-08-04T09:00:00.000Z', '2026-08-04T09:00:00.000Z');
    `);
    const executed = [];
    const result = await v3.executeClaimedJobs(
      { AUTH_DB: d1(database) },
      [1, 2].map((id) => {
        const job = database.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1").get(id);
        return { job, claimed: job, entry: null, claimResult: "claimed" };
      }),
      [],
      new Date("2026-08-04T09:03:00.000Z"),
      {
        executeJob: async ({ job }) => {
          executed.push(job.id);
          if (job.id === 1) throw new Error("publish stalled");
          return { status: "completed", stateBefore: "scheduled", stateAfter: "scheduled" };
        }
      }
    );
    assert.deepEqual(executed, [1, 2]);
    assert.equal(result.processed, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.retryWait, 1);
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE id = 1").get().status, "retry_wait");
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE id = 2").get().status, "completed");
  } finally {
    database.close();
  }
});

test("lease期限切れのclaimed jobは次回claim対象になる", async () => {
  const database = new DatabaseSync(":memory:");
  const jobId = 7;
  try {
    database.exec(`
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, job_type TEXT, status TEXT,
        scheduled_at TEXT, attempt_count INTEGER, max_attempts INTEGER, next_retry_at TEXT,
        lease_expires_at TEXT, claim_token TEXT, created_at TEXT, claimed_at TEXT,
        completed_at TEXT, updated_at TEXT
      );
      INSERT INTO game_jobs_v3
        (id, internal_game_id, job_type, status, scheduled_at, attempt_count, max_attempts,
        lease_expires_at, created_at, claimed_at, updated_at)
      VALUES (${jobId}, '${GAME_ID}', 'publish', 'claimed', '2026-08-04T08:00:00.000Z', 4, 12,
        '2026-08-04T08:59:00.000Z', '2026-08-04T08:00:00.000Z',
        '2026-08-04T08:54:00.000Z', '2026-08-04T08:54:00.000Z');
    `);
    const now = new Date("2026-08-04T09:00:00.000Z");
    const due = await v3.listDueV3Jobs(d1(database), now);
    assert.equal(due.some((job) => job.id === jobId), true);
    const reclaimed = await v3.claimV3Job(d1(database), { jobId, now });
    assert.equal(reclaimed.status, "claimed");
    assert.equal(reclaimed.attempt_count, 5);
    assert.ok(reclaimed.lease_expires_at > now.toISOString());
  } finally {
    database.close();
  }
});

test("一件のclaim例外でも同じbatchの後続jobをclaimする", async () => {
  const jobs = [
    { id: 1, internal_game_id: GAME_ID, job_type: "publish", status: "pending", scheduled_at: START },
    { id: 2, internal_game_id: GAME_ID, job_type: "publish", status: "pending", scheduled_at: START }
  ];
  const db = {
    prepare(sql) {
      return {
        bind(...parameters) {
          return {
            all: async () => ({ results: sql.includes("LIMIT ?2") ? jobs : [] }),
            first: async () => {
              if (sql.includes("SELECT created_at")) return { created_at: START };
              const job = jobs.find((row) => row.id === Number(parameters[0]));
              return job ? { ...job, status: "claimed", claim_token: "new-token" } : null;
            },
            run: async () => {
              if (sql.startsWith("UPDATE game_jobs_v3") && Number(parameters[3]) === 1) {
                throw new Error("transient claim failure");
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  const report = await v3.claimDueJobs(db, new Date("2026-08-04T09:00:00.000Z"));
  assert.equal(report.due.length, 2);
  assert.equal(report.claimed[0].claimResult, "claim_error");
  assert.equal(report.claimed[0].claimed, null);
  assert.equal(report.claimed[1].claimResult, "claimed");
  assert.equal(report.claimed[1].claimed.id, 2);
});

test("先頭batchのclaim例外を越えて101件目以降のdue jobをclaimする", async () => {
  const database = new DatabaseSync(":memory:");
  let listCalls = 0;
  try {
    database.exec(`
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, job_type TEXT,
        scheduled_at TEXT NOT NULL, scheduled_slot_at TEXT NOT NULL, status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL, max_attempts INTEGER NOT NULL, next_retry_at TEXT,
        claimed_at TEXT, claim_token TEXT, lease_expires_at TEXT, completed_at TEXT,
        failure_code TEXT, failure_message TEXT, created_at TEXT, updated_at TEXT
      );
    `);
    const insert = database.prepare(`
      INSERT INTO game_jobs_v3
        (id, internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
         attempt_count, max_attempts, created_at, updated_at)
      VALUES (?, ?, 'publish', '2026-08-04T08:00:00.000Z', '2026-08-04T08:00:00.000Z', 'pending', 0, 12,
              '2026-08-04T07:00:00.000Z', '2026-08-04T07:00:00.000Z')
    `);
    for (let id = 1; id <= 101; id += 1) insert.run(id, `game-${id}`);

    const base = d1(database);
    const db = {
      prepare(sql) {
        if (sql.includes("ORDER BY scheduled_at")) listCalls += 1;
        const prepared = base.prepare(sql);
        return {
          ...prepared,
          bind(...parameters) {
            const bound = prepared.bind(...parameters);
            return {
              ...bound,
              run: async () => {
                if (sql.startsWith("UPDATE game_jobs_v3") && Number(parameters[3]) === 1) {
                  throw new Error("transient claim failure");
                }
                return bound.run();
              }
            };
          }
        };
      }
    };

    const report = await v3.claimDueJobs(db, new Date("2026-08-04T09:00:00.000Z"));
    assert.equal(report.due.length, 101);
    assert.equal(report.claimed[0].claimResult, "claim_error");
    assert.equal(report.claimed[0].claimed, null);
    assert.equal(report.claimed.at(-1).claimed.id, 101);
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE id = 1").get().status, "pending");
    assert.equal(database.prepare("SELECT status FROM game_jobs_v3 WHERE id = 101").get().status, "claimed");
    assert.equal(listCalls, 3);
  } finally {
    database.close();
  }
});

test("orchestratorは開始後のprediction_closed gameをlineup_fetchのformal jobへ接続する", async () => {
  const database = new DatabaseSync(":memory:");
  const internalGameId = "8b6f5d0a-7ad5-4dc1-a541-0d5ca6c4c9a2";
  try {
    database.exec(`
      CREATE TABLE games (
        internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT
      );
      CREATE TABLE game_automation_v3_state (
        internal_game_id TEXT PRIMARY KEY, state TEXT, version INTEGER,
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT, job_type TEXT,
        scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT,
        UNIQUE(internal_game_id, job_type, scheduled_slot_at)
      );
      INSERT INTO games VALUES (
        '${internalGameId}', '2026-08-04', '2026-08-04T09:00:00.000Z',
        'fighters', 'hawks', 'f-h-21', 'resolved', 'scheduled', 1, NULL
      );
      INSERT INTO game_automation_v3_state VALUES (
        '${internalGameId}', 'prediction_closed', 1,
        '2026-08-04T08:00:00.000Z', '2026-08-04T08:00:00.000Z'
      );
      INSERT INTO game_jobs_v3 (
        internal_game_id, job_type, scheduled_at, scheduled_slot_at, status,
        attempt_count, max_attempts, completed_at, created_at, updated_at
      ) VALUES (
        '${internalGameId}', 'prediction_close', '2026-08-04T08:00:00.000Z',
        '2026-08-04T08:00:00.000Z', 'completed', 1, 12,
        '2026-08-04T08:00:01.000Z', '2026-08-04T08:00:00.000Z', '2026-08-04T08:00:01.000Z'
      );
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    let optionalPromise = null;
    const now = new Date("2026-08-04T09:03:00.000Z");
    const result = await v3.runGameAutomationV3(env, now, {
      scheduleOptional: (promise) => { optionalPromise = promise; },
      executeJob: async ({ job }) => ({
        status: "completed",
        stateBefore: job.job_type === "lineup_fetch" ? "prediction_closed" : "scheduled",
        stateAfter: "prediction_closed"
      })
    });
    const lineupPlan = result.mainPlan.planned.find((entry) => entry.plan?.jobType === "lineup_fetch");
    const lineupDiagnostic = result.mainPlan.diagnostics.find((entry) =>
      entry.internalGameId === internalGameId && entry.stage === "lineup_fetch"
    );
    const lineupJob = database.prepare(
      "SELECT * FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'lineup_fetch'"
    ).get(internalGameId);
    const expectedLineupSlot = v3.deriveV3DisplaySchedule({
      gameDate: "2026-08-04",
      startAt: "2026-08-04T09:00:00.000Z"
    }).lineupPollingSlots
      .filter((slot) => new Date(slot).getTime() <= now.getTime())
      .at(-1);

    assert.equal(result.gameCount, 1, "startAt後でも未公開gameはeligibleであること");
    assert.ok(lineupPlan, JSON.stringify(result.mainPlan));
    assert.equal(lineupPlan?.created, true, "formal planがlineup_fetchのinsertへ接続されること");
    assert.equal(lineupPlan?.plan?.jobType, "lineup_fetch");
    assert.equal(lineupDiagnostic?.shouldCreateJob, true, "stage判定をdiagnosticsから検出できること");
    assert.equal(lineupDiagnostic?.blocked, false);
    assert.equal(lineupDiagnostic?.reasonCode, "V3_JOB_CREATED");
    assert.equal(lineupJob?.internal_game_id, internalGameId);
    assert.equal(lineupJob?.scheduled_at, expectedLineupSlot);
    assert.equal(lineupJob?.scheduled_slot_at, expectedLineupSlot);
    assert.equal(lineupJob?.status, "completed");
    assert.equal(typeof optionalPromise?.then, "function");
  } finally {
    database.close();
  }
});

test("V3 runnerは同じDB行をprediction closeからpublishまで一度ずつ進める", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const lineupCandidate = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      battingOrder: index + 1,
      position: "P",
      playerId: `player-${index + 1}`,
      playerName: `Player ${index + 1}`
    })));
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      CREATE TABLE game_lineup_revisions (internal_game_id TEXT, is_final INTEGER,
        actual_lineup_json TEXT, version INTEGER);
      CREATE TABLE game_lineups (internal_game_id TEXT PRIMARY KEY, actual_lineup_json TEXT,
        scoring_status TEXT, scored_at TEXT, publication_status TEXT, published_at TEXT);
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-04', '${START}', 'hawks', 'fighters', 'h-f-15', 'scheduled', 1, NULL);
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const executed = [];
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
      if (job.job_type === "lineup_fetch") {
        database.prepare("INSERT INTO game_lineup_revisions VALUES (?1, 0, ?2, 1)").run(GAME_ID, lineupCandidate);
        database.prepare("INSERT OR REPLACE INTO game_lineups (internal_game_id, actual_lineup_json, scoring_status, scored_at, publication_status, published_at) VALUES (?1, ?2, 'pending', NULL, 'private', NULL)").run(GAME_ID, lineupCandidate);
      }
      const next = { prediction_close: "prediction_closed", lineup_finalize: "lineup_ready", score: "scored", ranking_rebuild: "ranked", publish: "published" }[job.job_type];
      const current = { prediction_close: "scheduled", lineup_finalize: "prediction_closed", score: "lineup_ready", ranking_rebuild: "scored", publish: "ranked" }[job.job_type];
      return { stateBefore: current, stateAfter: next || current, status: "completed" };
    };
    for (const at of ["2026-08-04T08:00:00.000Z", "2026-08-04T08:10:00.000Z", "2026-08-04T09:02:00.000Z", "2026-08-04T09:03:00.000Z", "2026-08-04T09:10:00.000Z", "2026-08-04T09:11:00.000Z"]) {
      await v3.runGameAutomationV3(env, new Date(at), { executeJob });
    }
    assert.deepEqual(executed, ["prediction_close", "roster_fetch", "probable_starter_fetch", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]);
    assert.equal(database.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1").get(GAME_ID).state, "published");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1").get(GAME_ID).count, 8);
  } finally {
    database.close();
  }
});

test("lineup未発表の戻り値は成功完了にせず次slotのretry_waitへ戻す", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-04', '${START}', 'hawks', 'fighters', 'h-f-15', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO game_automation_v3_state VALUES ('${GAME_ID}', 'prediction_closed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, '${START}', '${START}');
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const at = new Date("2026-08-04T08:20:00.000Z");
    await v3.runGameAutomationV3(env, at, {
      executeJob: async () => ({ status: "retry_wait", failureCode: "LINEUP_NOT_ANNOUNCED", failureMessage: "未発表" })
    });
    const row = database.prepare(
      "SELECT job_type, status, failure_code, attempt_count FROM game_jobs_v3 WHERE job_type = 'lineup_fetch'"
    ).get();
    assert.equal(row.job_type, "lineup_fetch");
    assert.equal(row.status, "retry_wait");
    assert.equal(row.failure_code, "LINEUP_NOT_ANNOUNCED");
    assert.equal(row.attempt_count, 1);
  } finally {
    database.close();
  }
});

test("予告先発announcedでもロースターの期限到達slotは独立して1件だけ救済される", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE probable_starters (game_id TEXT PRIMARY KEY, internal_game_id TEXT,
        status TEXT, data_status TEXT, error_code TEXT, home_pitcher_name TEXT,
        away_pitcher_name TEXT, fetched_at TEXT, updated_at TEXT);
      CREATE TABLE game_roster_snapshots (game_id TEXT PRIMARY KEY, internal_game_id TEXT,
        status TEXT, player_count INTEGER, captured_at TEXT, updated_at TEXT);
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-07', '2026-08-07T09:00:00.000Z',
        'fighters', 'eagles', 'f-e-17', 'resolved', 'scheduled', 1, NULL);
      INSERT INTO probable_starters VALUES ('${GAME_ID}', '${GAME_ID}', 'announced', 'announced', NULL,
        '投手A', '投手B', '2026-08-07T03:00:00.000Z', '2026-08-07T03:00:00.000Z');
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const executed = [];
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
      return { status: "captured", stateBefore: "scheduled", stateAfter: "scheduled" };
    };
    const now = new Date("2026-08-07T07:50:00.000Z");
    const first = await v3.runGameAutomationV3(env, now, { executeJob });
    const second = await v3.runGameAutomationV3(env, now, { executeJob });
    const rosterJobs = database.prepare(
      "SELECT job_type, scheduled_slot_at, status, attempt_count FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = 'roster_fetch'"
    ).all(GAME_ID);
    assert.equal(first.rosterPlan.created, 1);
    assert.equal(second.rosterPlan.created, 0);
    assert.equal(rosterJobs.length, 1);
    assert.equal(rosterJobs[0].job_type, "roster_fetch");
    assert.equal(rosterJobs[0].scheduled_slot_at, "2026-08-07T07:10:00.000Z");
    assert.equal(rosterJobs[0].status, "completed");
    assert.equal(rosterJobs[0].attempt_count, 1);
    assert.deepEqual(executed, ["roster_fetch"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE job_type = 'probable_starter_fetch'").get().count, 0);
    assert.deepEqual(v3.getV3RosterSlots({ ...game(), gameDate: "2026-08-07", startAt: "2026-08-07T09:00:00.000Z" }).map((slot) => slot.toISOString()), [
      "2026-08-07T07:00:00.000Z",
      "2026-08-07T07:02:00.000Z",
      "2026-08-07T07:10:00.000Z"
    ]);
  } finally {
    database.close();
  }
});

test("V3ロースターsnapshotはslot処理済みの場合だけ同じjobを再生成しない", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_roster_snapshots (game_id TEXT PRIMARY KEY, internal_game_id TEXT,
        game_date TEXT, source TEXT, status TEXT, player_count INTEGER, captured_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO game_roster_snapshots VALUES ('legacy-row', '${GAME_ID}', '2026-08-07', 'npb-roster', 'captured', 30,
        '2026-08-05T01:57:30.027Z', '2026-08-05T01:57:30.027Z');
    `);
    const target = { ...game(), gameDate: "2026-08-07", startAt: "2026-08-07T09:00:00.000Z" };
    const stale = await v3.getV3CanonicalRosterSnapshot(d1(database), GAME_ID, { gameDate: target.gameDate });
    assert.equal(stale.exists, false);
    assert.equal(stale.isStale, true);
    assert.equal(stale.staleReason, "ROSTER_SNAPSHOT_CAPTURE_DATE_STALE");
    const firstPlan = await v3.planV3RosterJobs(d1(database), [target], new Date("2026-08-07T07:50:00.000Z"));
    assert.equal(firstPlan.created, 1);
    assert.equal(firstPlan.planned[0].plan.scheduledSlotAt.toISOString(), "2026-08-07T07:10:00.000Z");
    assert.equal(firstPlan.diagnostics[0].rosterSnapshotStale, true);
    assert.equal(firstPlan.diagnostics[0].staleReason, "ROSTER_SNAPSHOT_CAPTURE_DATE_STALE");
    const secondPlan = await v3.planV3RosterJobs(d1(database), [target], new Date("2026-08-07T07:50:00.000Z"));
    assert.equal(secondPlan.created, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3").get().count, 1);

    database.prepare("UPDATE game_roster_snapshots SET game_date = ?1, captured_at = ?2, updated_at = ?2 WHERE game_id = 'legacy-row'")
      .run("2026-08-07", "2026-08-07T07:50:00.000Z");
    database.prepare("UPDATE game_jobs_v3 SET status = 'completed', completed_at = ?1 WHERE internal_game_id = ?2")
      .run("2026-08-07T07:50:00.000Z", GAME_ID);
    const fresh = await v3.getV3CanonicalRosterSnapshot(d1(database), GAME_ID, { gameDate: target.gameDate });
    assert.equal(fresh.exists, true);
    assert.equal(fresh.isFresh, true);
    const freshPlan = await v3.planV3RosterJobs(d1(database), [target], new Date("2026-08-07T07:50:00.000Z"));
    assert.equal(freshPlan.created, 0);
    assert.equal(freshPlan.planned[0].reasonCode, "ROSTER_SLOT_ALREADY_PROCESSED");
    assert.equal(freshPlan.diagnostics[0].sourceSnapshotComparison, null);
  } finally {
    database.close();
  }
});

test("fresh snapshotがあっても未処理の最新roster slotは公式再取得jobを計画する", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_roster_snapshots (game_id TEXT PRIMARY KEY, internal_game_id TEXT,
        game_date TEXT, source TEXT, status TEXT, player_count INTEGER, captured_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO game_roster_snapshots VALUES ('canonical', '${GAME_ID}', '2026-08-07', 'npb-roster', 'captured', 31,
        '2026-08-07T07:40:00.000Z', '2026-08-07T07:40:00.000Z');
    `);
    const target = { ...game(), gameDate: "2026-08-07", startAt: "2026-08-07T09:00:00.000Z" };
    const result = await v3.planV3RosterJobs(d1(database), [target], new Date("2026-08-07T07:50:00.000Z"));
    assert.equal(result.created, 1);
    assert.equal(result.planned[0].reasonCode, "ROSTER_JOB_CREATED");
    assert.equal(result.planned[0].plan.scheduledSlotAt.toISOString(), "2026-08-07T07:10:00.000Z");
  } finally {
    database.close();
  }
});

test("roster auditがなくてもformal snapshotだけで再検証jobを増殖させない", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_roster_snapshots (game_id TEXT PRIMARY KEY, internal_game_id TEXT,
        game_date TEXT, source TEXT, status TEXT, player_count INTEGER, captured_at TEXT, updated_at TEXT, roster_json TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO game_roster_snapshots VALUES ('canonical', '${GAME_ID}', '2026-08-07', 'npb-roster', 'captured', 31,
        '2026-08-07T07:40:00.000Z', '2026-08-07T07:40:00.000Z', '[]');
      INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, completed_at)
        VALUES ('${GAME_ID}', 'roster_fetch', '2026-08-07T07:10:00.000Z', '2026-08-07T07:10:00.000Z', 'completed', 1, '2026-08-07T07:40:00.000Z');
    `);
    const result = await v3.planV3RosterJobs(
      d1(database),
      [{ ...game(), gameDate: "2026-08-07", startAt: "2026-08-07T09:00:00.000Z" }],
      new Date("2026-08-07T07:50:00.000Z")
    );

    assert.equal(result.created, 0);
    assert.equal(result.planned[0].reasonCode, "ROSTER_SLOT_ALREADY_PROCESSED");
    assert.equal(result.diagnostics[0].sourceSnapshotComparison, null);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1").get(GAME_ID).count, 1);
  } finally {
    database.close();
  }
});

test("V3ロースターplannerはslot前missingを待機監査し、slot後だけjobを計画する", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_roster_snapshots (game_id TEXT PRIMARY KEY, internal_game_id TEXT,
        game_date TEXT, source TEXT, status TEXT, player_count INTEGER, captured_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
    `);
    const target = { ...game(), gameDate: "2026-08-09", startAt: "2026-08-09T06:00:00.000Z" };
    const beforeDue = await v3.planV3RosterJobs(d1(database), [target], new Date("2026-08-08T23:32:00.000Z"));
    assert.equal(beforeDue.created, 0);
    assert.equal(beforeDue.planned[0].reasonCode, "ROSTER_SNAPSHOT_MISSING_BEFORE_DUE");
    assert.deepEqual(Object.fromEntries([
      ["currentJstTime", beforeDue.diagnostics[0].currentJstTime],
      ["nextCheckAt", beforeDue.diagnostics[0].nextCheckAt],
      ["isBeforeFirstRosterSlot", beforeDue.diagnostics[0].isBeforeFirstRosterSlot],
      ["freshSnapshotExists", beforeDue.diagnostics[0].freshSnapshotExists],
      ["staleSnapshotExists", beforeDue.diagnostics[0].staleSnapshotExists],
      ["openRosterJobExists", beforeDue.diagnostics[0].openJobExists],
      ["terminalRosterJobExists", beforeDue.diagnostics[0].terminalRosterJobExists],
      ["reasonCode", beforeDue.diagnostics[0].reasonCode],
      ["severity", beforeDue.diagnostics[0].severity]
    ]), {
      currentJstTime: "2026-08-09T08:32:00+09:00",
      nextCheckAt: "2026-08-09T04:00:00.000Z",
      isBeforeFirstRosterSlot: true,
      freshSnapshotExists: false,
      staleSnapshotExists: false,
      openRosterJobExists: false,
      terminalRosterJobExists: false,
      reasonCode: "ROSTER_SNAPSHOT_MISSING_BEFORE_DUE",
      severity: "WAITING"
    });
    const afterDue = await v3.planV3RosterJobs(d1(database), [target], new Date("2026-08-09T04:20:00.000Z"));
    assert.equal(afterDue.created, 1);
    assert.equal(afterDue.diagnostics[0].reasonCode, "ROSTER_SNAPSHOT_MISSING_AFTER_DUE");
    assert.equal(afterDue.diagnostics[0].severity, "ATTENTION");
  } finally {
    database.close();
  }
});

test("試合開始後でもsnapshotが無ければ最新のroster slotを救済する", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_roster_snapshots (game_id TEXT PRIMARY KEY, internal_game_id TEXT,
        game_date TEXT, source TEXT, status TEXT, player_count INTEGER, captured_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
    `);
    const target = { ...game(), gameDate: "2026-08-11", startAt: "2026-08-11T05:00:00.000Z" };
    const result = await v3.planV3RosterJobs(d1(database), [target], new Date("2026-08-11T07:10:00.000Z"));
    assert.equal(result.created, 1);
    assert.equal(result.planned[0].reasonCode, "ROSTER_JOB_CREATED");
    assert.equal(result.diagnostics[0].selectedDueSlot, "2026-08-11T03:10:00.000Z");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3").get().count, 1);
  } finally {
    database.close();
  }
});

test("V3 Cronは未解決試合のNPB識別jobを固定slotで一度だけ投入する", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE games (internal_game_id TEXT PRIMARY KEY, game_date TEXT, start_time TEXT,
        home_team TEXT, away_team TEXT, npb_game_code TEXT, npb_identity_status TEXT,
        game_status TEXT, is_active INTEGER, deleted_at TEXT);
      CREATE TABLE game_automation_v3_state (internal_game_id TEXT PRIMARY KEY, state TEXT,
        prediction_closed_at TEXT, lineup_finalized_at TEXT, scoring_revision_id TEXT,
        ranked_at TEXT, published_at TEXT, excluded_at TEXT, failure_code TEXT,
        failure_message TEXT, version INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE game_jobs_v3 (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_type TEXT, scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT, attempt_count INTEGER,
        max_attempts INTEGER, next_retry_at TEXT, claimed_at TEXT, claim_token TEXT,
        lease_expires_at TEXT, completed_at TEXT, failure_code TEXT, failure_message TEXT,
        created_at TEXT, updated_at TEXT, UNIQUE(internal_game_id, job_type, scheduled_slot_at));
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-05', '2026-08-05T09:00:00.000Z', 'hawks', 'fighters', NULL, 'unresolved', 'scheduled', 1, NULL);
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const executed = [];
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
      return { status: "pending", stateBefore: "scheduled", stateAfter: "scheduled" };
    };
    const at = new Date("2026-08-04T09:00:00.000Z");
    await v3.runGameAutomationV3(env, at, { executeJob });
    await v3.runGameAutomationV3(env, at, { executeJob });
    const row = database.prepare("SELECT job_type, scheduled_slot_at, status, attempt_count FROM game_jobs_v3 WHERE internal_game_id = ?1").get(GAME_ID);
    assert.equal(row.job_type, "npb_identity_resolve");
    assert.equal(row.scheduled_slot_at, "2026-08-04T09:00:00.000Z");
    assert.equal(row.status, "completed");
    assert.equal(row.attempt_count, 1);
    assert.deepEqual(executed, ["probable_starter_fetch", "npb_identity_resolve"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE internal_game_id = ?1").get(GAME_ID).count, 2);
  } finally {
    database.close();
  }
});

test("0029 is additive, has no backfill, and applies to an existing migration chain", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const files = fs.readdirSync(path.join(root, "migrations"))
      .filter((file) => /^00(?:0[1-9]|1[0-9]|2[0-8])_.*\.sql$/.test(file))
      .sort();
    for (const file of files) database.exec(fs.readFileSync(path.join(root, "migrations", file), "utf8"));
    database.exec(`INSERT INTO games (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
      VALUES ('${GAME_ID}', '2026-08-04', '${START}', 'hawks', 'fighters', 'completed', '${START}', '${START}')`);
    database.exec(fs.readFileSync(path.join(root, "migrations", "0029_game_automation_v3.sql"), "utf8"));
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('game_jobs_v3', 'game_automation_v3_state') ORDER BY name").all();
    assert.deepEqual(table.map((row) => row.name), ["game_automation_v3_state", "game_jobs_v3"]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3").get().count, 0);
    assert.equal(database.prepare("SELECT start_time FROM games WHERE internal_game_id = ?1").get(GAME_ID).start_time, START);
    database.exec(fs.readFileSync(path.join(root, "migrations", "0030_game_automation_v3_npb_code_audit.sql"), "utf8"));
    database.exec(fs.readFileSync(path.join(root, "migrations", "0031_game_npb_identity_registry.sql"), "utf8"));
    database.exec(`INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, created_at, updated_at)
      VALUES ('${GAME_ID}', 'prediction_close', '${START}', '${START}', '${START}', '${START}')`);
    database.exec(`INSERT INTO game_automation_v3_audit (internal_game_id, job_id, job_type, occurred_at)
      VALUES ('${GAME_ID}', 1, 'prediction_close', '${START}')`);
    database.exec(fs.readFileSync(path.join(root, "migrations", "0032_game_automation_v3_npb_identity_job.sql"), "utf8"));
    const jobSchema = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'game_jobs_v3'").get().sql;
    assert.match(jobSchema, /npb_identity_resolve/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE job_type = 'prediction_close'").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_automation_v3_audit").get().count, 1);
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    database.prepare("INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(GAME_ID, "npb_identity_resolve", START, "2026-08-04T09:00:00.000Z", START, START);
  } finally {
    database.close();
  }
});
