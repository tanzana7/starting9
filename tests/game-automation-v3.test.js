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

test("finalLineupAt後はverified candidateからlineup_finalizeを計画する", () => {
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
  assert.equal(plans[0].blockedReason, "LINEUP_FETCH_WINDOW_CLOSED_NO_FINALIZE");
  assert.equal(plans[1].shouldCreateJob, true);
  assert.equal(plans[1].reasonCode, "DUE_JOB_MISSING");
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
    assert.equal(v3.getV3DuePlan(games[0], "prediction_closed", "2026-08-11T09:02:00.000Z").jobType, "lineup_finalize");
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
  assert.deepEqual(v3.getV3DuePlans(target, "prediction_closed", "2026-08-04T09:03:00.000Z").map((plan) => plan.jobType), ["lineup_finalize"]);
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

test("V3 runnerは同じDB行をprediction closeからpublishまで一度ずつ進める", async () => {
  const database = new DatabaseSync(":memory:");
  try {
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
      INSERT INTO games VALUES ('${GAME_ID}', '2026-08-04', '${START}', 'hawks', 'fighters', 'h-f-15', 'scheduled', 1, NULL);
    `);
    const env = { AUTH_DB: d1(database), ENABLE_GAME_AUTOMATION_V3: "true" };
    const executed = [];
    const executeJob = async ({ job }) => {
      executed.push(job.job_type);
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
    assert.equal(freshPlan.created, 1);
    assert.equal(freshPlan.planned[0].reasonCode, "ROSTER_REVALIDATION_JOB_CREATED");
    assert.equal(freshPlan.planned[0].plan.scheduledSlotAt.toISOString(), "2026-08-07T07:50:00.000Z");
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

test("切断されたroster auditでもcompact summaryのOK判定で再検証jobを増殖させない", async () => {
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
      CREATE TABLE game_automation_v3_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, internal_game_id TEXT,
        job_id INTEGER, job_type TEXT, event_type TEXT, failure_message TEXT, occurred_at TEXT);
      INSERT INTO game_roster_snapshots VALUES ('canonical', '${GAME_ID}', '2026-08-07', 'npb-roster', 'captured', 31,
        '2026-08-07T07:40:00.000Z', '2026-08-07T07:40:00.000Z', '[]');
      INSERT INTO game_jobs_v3 (internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, completed_at)
        VALUES ('${GAME_ID}', 'roster_fetch', '2026-08-07T07:10:00.000Z', '2026-08-07T07:10:00.000Z', 'completed', 1, '2026-08-07T07:40:00.000Z');
    `);
    const audit = v3.buildV3CronJobAuditInsert({
      job: { id: 1, internal_game_id: GAME_ID, job_type: "roster_fetch", status: "completed", attempt_count: 1 },
      execution: {
        status: "captured",
        reasonCode: "ROSTER_NO_CHANGES",
        sourceSnapshotComparison: { status: "OK", mismatch: false, remainingMismatch: false, stale: false },
        largeDetail: "x".repeat(12000)
      }
    });
    database.prepare("INSERT INTO game_automation_v3_audit (internal_game_id, job_id, job_type, event_type, failure_message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(GAME_ID, 1, "roster_fetch", "job", audit.values[audit.columns.indexOf("failure_message")], "2026-08-07T07:40:00.000Z");

    const result = await v3.planV3RosterJobs(
      d1(database),
      [{ ...game(), gameDate: "2026-08-07", startAt: "2026-08-07T09:00:00.000Z" }],
      new Date("2026-08-07T07:50:00.000Z")
    );

    assert.equal(result.created, 0);
    assert.equal(result.planned[0].reasonCode, "ROSTER_SLOT_ALREADY_PROCESSED");
    assert.equal(result.diagnostics[0].sourceSnapshotComparison.status, "OK");
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
