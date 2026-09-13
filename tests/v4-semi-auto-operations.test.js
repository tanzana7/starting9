import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")));
const orchestratorSource = fs.readFileSync(path.join(root, "backend", "automation-v3", "orchestrator.js"), "utf8");
const adminSource = fs.readFileSync(path.join(root, "admin-v3.js"), "utf8");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const executorSource = fs.readFileSync(path.join(root, "backend", "automation-v3", "executor.js"), "utf8");
const wranglerSource = fs.readFileSync(path.join(root, "wrangler.auth.production.jsonc"), "utf8");

const GAME_ID = "f8015d4d-dc96-4e53-8b5a-b6ce71b2fcb5";
const START_AT = "2026-09-02T09:00:00.000Z";

function game() {
  return {
    internalGameId: GAME_ID,
    gameDate: "2026-09-02",
    startAt: START_AT,
    gameStatus: "scheduled",
    isActive: 1,
    deletedAt: null,
    npbGameCode: "f-h-22",
    npbIdentityStatus: "resolved"
  };
}

function validLineup() {
  return Array.from({ length: 9 }, (_, index) => ({
    battingOrder: index + 1,
    position: index === 0 ? "捕" : "内野",
    playerId: `fighters-${index + 1}`,
    playerName: `Fighters ${index + 1}`,
    uniformNumber: String(index + 1)
  }));
}

function planningState(persistedState, artifacts = {}, now = new Date("2026-09-02T10:05:00.000Z")) {
  return v3.buildV3PlanningState({
    game: game(),
    persistedState,
    effectiveState: persistedState,
    artifacts,
    now
  });
}

function v4PlanningState(persistedState, artifacts = {}, now = new Date("2026-09-02T10:05:00.000Z")) {
  return v3.buildV3PlanningState({
    game: game(),
    persistedState,
    effectiveState: persistedState,
    artifacts,
    now,
    v4SemiAuto: true
  });
}

function d1(database) {
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        all: async () => ({ results: statement.all() }),
        first: async () => statement.get(),
        run: async () => ({ meta: { changes: Number(statement.run().changes || 0) } }),
        bind(...params) {
          return {
            all: async () => ({ results: statement.all(...params) }),
            first: async () => statement.get(...params),
            run: async () => ({ meta: { changes: Number(statement.run(...params).changes || 0) } })
          };
        }
      };
    }
  };
}

function planningDb(state) {
  const lineupJson = JSON.stringify(validLineup());
  return {
    prepare(sql) {
      const query = String(sql).replace(/\s+/g, " ").toLowerCase();
      return {
        bind(...params) {
          return {
            async first() {
              if (query.includes("select state from game_automation_v3_state")) {
                return { state: state.persistedState || "scheduled" };
              }
              if (query.includes("select scoring_revision_id from game_automation_v3_state")) {
                return { scoring_revision_id: state.scoringRevisionId || null };
              }
              if (query.includes("select * from game_jobs_v3") && query.includes("where internal_game_id")) {
                const job = (state.jobs || []).find((entry) => String(entry.internal_game_id) === String(params[0])
                  && String(entry.job_type) === String(params[1])
                  && String(entry.scheduled_slot_at) === String(params[2]));
                return job || null;
              }
              if (query.includes("select game_id, internal_game_id") && query.includes("from game_roster_snapshots")) {
                return {
                  game_id: "fighters-game",
                  internal_game_id: GAME_ID,
                  game_date: "2026-09-02",
                  source: "npb-roster",
                  status: "captured",
                  player_count: 30,
                  captured_at: "2026-09-02T00:00:00.000Z",
                  updated_at: "2026-09-02T00:00:00.000Z",
                  roster_json: "[]"
                };
              }
              if (query.includes("select actual_lineup_json") && query.includes("from game_lineups")) {
                return { actual_lineup_json: lineupJson };
              }
              if (query.includes("select final_lineup_revision_id") && query.includes("from game_lineups")) {
                return state.canonicalFinalRevisionId
                  ? { final_lineup_revision_id: state.canonicalFinalRevisionId }
                  : null;
              }
              if (query.includes("select scoring_status")) {
                return state.scoreReady
                  ? { scoring_status: "scored", scored_at: "2026-09-02T09:10:00.000Z", publication_status: state.publicationStatus || null, published_at: state.publishedAt || null }
                  : null;
              }
              if (query.includes("from ranking_reflection_revisions")) {
                return state.rankingReflected
                  ? { status: "reflected", scoring_revision_id: state.reflectionScoringRevisionId || state.scoringRevisionId || null }
                  : null;
              }
              return null;
            },
            async all() {
              if (query.includes("from game_jobs_v3")) return { results: state.jobs || [] };
              if (query.includes("from game_lineup_revisions")) {
                return { results: [{
                  game_id: "fighters-game",
                  version: state.finalizedRevisionAvailable === false ? 7 : 1,
                  is_final: state.finalizedRevisionAvailable === false ? 0 : 1,
                  actual_lineup_json: lineupJson
                }] };
              }
              return { results: [] };
            },
            async run() {
              if (query.includes("insert or ignore into game_jobs_v3")) {
                const [internalGameId, jobType, scheduledAt, scheduledSlotAt, maxAttempts] = params;
                if (!(state.jobs || []).some((entry) => String(entry.internal_game_id) === String(internalGameId)
                  && String(entry.job_type) === String(jobType)
                  && String(entry.scheduled_slot_at) === String(scheduledSlotAt))) {
                  state.jobs.push({
                    id: ++state.nextId,
                    internal_game_id: internalGameId,
                    job_type: jobType,
                    scheduled_at: scheduledAt,
                    scheduled_slot_at: scheduledSlotAt,
                    status: "pending",
                    attempt_count: 0,
                    max_attempts: maxAttempts
                  });
                  return { meta: { changes: 1 } };
                }
              }
              return { meta: { changes: 0 } };
            }
          };
        }
      };
    }
  };
}

test("V4 modeは予告先発だけ自動で、roster/lineup自動取得を正式経路から外す", () => {
  const mode = v3.getV3OperationalMode({
    ENABLE_SEMI_AUTO_LINEUP: "true",
    ENABLE_AUTO_PROBABLE_STARTER: "true",
    ENABLE_AUTO_ROSTER_FETCH: "true",
    ENABLE_AUTO_LINEUP_FETCH: "true"
  });
  assert.equal(mode.mode, "v4_semi_auto");
  assert.equal(mode.autoProbableStarter, true);
  assert.equal(mode.autoRosterFetch, false);
  assert.equal(mode.autoLineupFetch, false);
  assert.deepEqual(mode.disabledJobTypes, ["roster_fetch", "lineup_fetch"]);

  const plans = v3.buildStagePlans(planningState("prediction_closed"), undefined, {
    disabledStages: mode.disabledJobTypes,
    disabledReason: "V4_AUTO_FETCH_DISABLED"
  });
  for (const stage of ["roster_fetch", "lineup_fetch"]) {
    const plan = plans.find((entry) => entry.stage === stage);
    assert.equal(plan.shouldCreateJob, false);
    assert.equal(plan.insertAllowed, false);
    assert.equal(plan.reasonCode, "V4_AUTO_FETCH_DISABLED");
    assert.equal(plan.disabled, true);
  }
  assert.equal(plans.find((entry) => entry.stage === "prediction_close").disabled, false);
  assert.equal(plans.find((entry) => entry.stage === "scoring").disabled, false);
});

test("V5復帰用にsemi-autoを切れば既存V3自動取得フラグへ戻る", () => {
  const mode = v3.getV3OperationalMode({
    ENABLE_SEMI_AUTO_LINEUP: "false",
    ENABLE_AUTO_PROBABLE_STARTER: "true",
    ENABLE_AUTO_ROSTER_FETCH: "true",
    ENABLE_AUTO_LINEUP_FETCH: "true"
  });
  assert.equal(mode.mode, "v3_auto");
  assert.equal(mode.autoProbableStarter, true);
  assert.equal(mode.autoRosterFetch, true);
  assert.equal(mode.autoLineupFetch, true);
  assert.deepEqual(mode.disabledJobTypes, []);
});

test("manual lineup確定前はprediction_close境界を越えてscoreへ進まない", () => {
  const manualFinal = {
    lineup_finalize: { available: true, ready: true, valid: true, finalizedValid: true }
  };
  const beforeClose = v3.buildStagePlan(
    planningState("scheduled", manualFinal, new Date("2026-09-02T07:55:00.000Z")),
    "scoring"
  );
  assert.equal(beforeClose.shouldCreateJob, false);
  assert.equal(beforeClose.reasonCode, "NOT_DUE");

  const scheduledAfterClose = v3.buildStagePlan(
    planningState("scheduled", manualFinal, new Date("2026-09-02T09:05:00.000Z")),
    "scoring"
  );
  assert.equal(scheduledAfterClose.shouldCreateJob, false);
  assert.equal(scheduledAfterClose.blockedReason, "SCORING_STATE_GATE");

  const afterClose = v3.buildStagePlan(
    planningState("prediction_closed", manualFinal, new Date("2026-09-02T09:05:00.000Z")),
    "scoring"
  );
  assert.equal(afterClose.shouldCreateJob, true);
  assert.equal(afterClose.insertAllowed, true);
});

test("V4実試合相当: manual lineup確定からformal Cronのclose/score/ranking/publishへ進む", async () => {
  const now = new Date("2026-09-02T10:05:00.000Z");
  const disabledStages = ["roster_fetch", "lineup_fetch"];
  const state = { persistedState: "scheduled", jobs: [], nextId: 100, scoreReady: false, rankingReflected: false };
  const beforeClose = await v3.planMainWorkflowJobs(planningDb(state), [game()], now, { disabledStages });
  const beforeStages = beforeClose.planned.map((entry) => entry.plan.jobType);
  assert.ok(beforeStages.includes("prediction_close"));
  assert.equal(beforeStages.includes("roster_fetch"), false);
  assert.equal(beforeStages.includes("lineup_fetch"), false);
  assert.equal(beforeStages.includes("score"), false);

  state.jobs = [{
    id: 100,
    internal_game_id: GAME_ID,
    job_type: "prediction_close",
    status: "completed",
    scheduled_at: "2026-09-02T08:00:00.000Z",
    scheduled_slot_at: "2026-09-02T08:00:00.000Z"
  }];
  const afterClose = await v3.planMainWorkflowJobs(planningDb(state), [game()], now, { disabledStages });
  assert.ok(afterClose.planned.some((entry) => entry.plan.jobType === "score"));
  assert.equal(afterClose.planned.some((entry) => entry.plan.jobType === "roster_fetch"), false);
  assert.equal(afterClose.planned.some((entry) => entry.plan.jobType === "lineup_fetch"), false);

  const manualFinal = { lineup_finalize: { available: true, ready: true, valid: true, finalizedValid: true } };
  const scoredPlans = v3.buildStagePlans(
    planningState("scored", { ...manualFinal, scoring: { available: true, ready: true, valid: true } }),
    undefined,
    { disabledStages }
  );
  assert.equal(scoredPlans.find((entry) => entry.stage === "ranking_reflect").shouldCreateJob, true);

  const rankedPlans = v3.buildStagePlans(
    planningState("ranked", { ...manualFinal, scoring: { available: true, ready: true, valid: true }, ranking_reflect: { available: true, ready: true, valid: true } }),
    undefined,
    { disabledStages }
  );
  assert.equal(rankedPlans.find((entry) => entry.stage === "publish").shouldCreateJob, true);
  assert.doesNotMatch(finalizeSourceForTest(), /createV3AdminActionJob/);
});

test("V4は締切済みかつcanonical manual lineup確定なら開始前でも次回Cronでscoreを計画する", async () => {
  const now = new Date("2026-09-02T08:05:00.000Z");
  const state = {
    persistedState: "prediction_closed",
    jobs: [{
      id: 150,
      internal_game_id: GAME_ID,
      job_type: "prediction_close",
      status: "completed",
      scheduled_at: "2026-09-02T08:00:00.000Z",
      scheduled_slot_at: "2026-09-02T08:00:00.000Z"
    }],
    nextId: 150,
    scoreReady: false,
    rankingReflected: false,
    canonicalFinalRevisionId: `${GAME_ID}:1`
  };
  const result = await v3.planMainWorkflowJobs(
    planningDb(state),
    [game()],
    now,
    { disabledStages: ["roster_fetch", "lineup_fetch"], v4SemiAuto: true }
  );
  const score = result.planned.find((entry) => entry.plan?.jobType === "score");
  assert.ok(score, JSON.stringify(result, (_key, value) => value instanceof Date ? value.toISOString() : value));
  assert.equal(score.created, true);
  assert.equal(score?.plan?.scheduledSlotAt.toISOString(), "2026-09-02T08:00:00.000Z");
  assert.equal(state.jobs.filter((job) => job.job_type === "score").length, 1);
});

test("V4 identity follow-upはdisabled lineup_fetchを作らず、V3は既存計画を維持する", () => {
  const target = { ...game(), npbIdentityStatus: "resolved" };
  assert.equal(
    v3.getV3DuePlan(target, "prediction_closed", new Date("2026-09-02T10:05:00.000Z"), { v4SemiAuto: true }),
    null
  );
  assert.equal(
    v3.getV3DuePlan(target, "prediction_closed", new Date("2026-09-02T10:05:00.000Z"), { v4SemiAuto: false })?.jobType,
    "lineup_fetch"
  );
  assert.match(executorSource, /v4SemiAuto: Boolean\(v4SemiAuto\)/);
});

test("V4はcanonical lineupが先に確定していてもprediction_closeを次回Cronで作成する", async () => {
  const now = new Date("2026-09-02T08:05:00.000Z");
  const state = {
    persistedState: "scheduled",
    jobs: [],
    nextId: 160,
    scoreReady: false,
    rankingReflected: false,
    canonicalFinalRevisionId: `${GAME_ID}:1`
  };
  const result = await v3.planMainWorkflowJobs(
    planningDb(state),
    [game()],
    now,
    { disabledStages: ["roster_fetch", "lineup_fetch"], v4SemiAuto: true }
  );
  assert.equal(state.jobs.filter((job) => job.job_type === "prediction_close").length, 1);
  assert.equal(state.jobs.filter((job) => job.job_type === "score").length, 0);
  assert.equal(result.planned.find((entry) => entry.plan?.jobType === "prediction_close")?.created, true);
});

test("V4 formal plannerはcanonicalのmanual finalリンクをlineup_ready証跡としてscoringへ進める", async () => {
  const now = new Date("2026-09-02T10:05:00.000Z");
  const state = {
    persistedState: "prediction_closed",
    jobs: [],
    nextId: 200,
    scoreReady: false,
    rankingReflected: false,
    canonicalFinalRevisionId: "fighters-game:7",
    finalizedRevisionAvailable: false
  };
  const result = await v3.planMainWorkflowJobs(
    planningDb(state),
    [game()],
    now,
    { disabledStages: ["roster_fetch", "lineup_fetch"] }
  );
  const score = result.planned.find((entry) => entry.plan?.jobType === "score");
  assert.equal(score?.created, true);
  assert.equal(score?.plan?.sharedPlan?.blocked, false);
  assert.equal(score?.plan?.sharedPlan?.diagnostics?.stateMismatch, true);
  assert.equal(result.planned.some((entry) => entry.plan?.jobType === "lineup_finalize"), false);
  assert.equal(result.planned.some((entry) => entry.plan?.jobType === "lineup_fetch"), false);
  assert.equal(state.jobs.filter((job) => job.job_type === "score").length, 1);
});

test("V4 formal plannerはscore完了後にranking_reflect、publishまで連鎖する", async () => {
  const now = new Date("2026-09-02T10:05:00.000Z");
  const state = {
    persistedState: "prediction_closed",
    jobs: [],
    nextId: 300,
    scoreReady: false,
    rankingReflected: false,
    scoringRevisionId: null,
    reflectionScoringRevisionId: null,
    canonicalFinalRevisionId: `${GAME_ID}:8`
  };
  const disabledStages = ["roster_fetch", "lineup_fetch"];
  const first = await v3.planMainWorkflowJobs(planningDb(state), [game()], now, { disabledStages });
  const score = state.jobs.find((job) => job.job_type === "score");
  assert.equal(first.created, 1);
  assert.ok(score);

  score.status = "completed";
  state.scoreReady = true;
  state.scoringRevisionId = "score-revision-1";
  const second = await v3.planMainWorkflowJobs(planningDb(state), [game()], now, { disabledStages });
  const ranking = state.jobs.find((job) => job.job_type === "ranking_rebuild");
  assert.equal(second.created, 1);
  assert.ok(ranking);
  assert.equal(second.planned.some((entry) => entry.plan?.jobType === "score"), false);

  ranking.status = "completed";
  state.rankingReflected = true;
  state.reflectionScoringRevisionId = state.scoringRevisionId;
  const third = await v3.planMainWorkflowJobs(planningDb(state), [game()], now, { disabledStages });
  assert.equal(third.created, 1);
  assert.equal(state.jobs.filter((job) => job.job_type === "publish").length, 1);
  assert.equal(third.planned.find((entry) => entry.plan?.jobType === "publish")?.plan?.sharedPlan?.blocked, false);
});

test("V4はscore完了後の次回Cronでstart+10前でもrankingを計画する", () => {
  const now = new Date("2026-09-02T09:07:00.000Z");
  const plans = v3.buildStagePlans(v4PlanningState("scored", {
    lineup_finalize: { available: true, ready: true, valid: true },
    scoring: { available: true, ready: true, valid: true }
  }, now));
  const ranking = plans.find((entry) => entry.stage === "ranking_reflect");
  assert.equal(ranking.shouldCreateJob, true);
  assert.equal(ranking.reasonCode, "DUE_JOB_MISSING");
  assert.notEqual(ranking.reasonCode, "PUBLICATION_NOT_DUE");
});

test("V4はranking反映後の次回Cronでstart+10前でもpublishを計画する", () => {
  const now = new Date("2026-09-02T09:07:00.000Z");
  const plans = v3.buildStagePlans(v4PlanningState("ranked", {
    lineup_finalize: { available: true, ready: true, valid: true },
    scoring: { available: true, ready: true, valid: true },
    ranking_reflect: { available: true, ready: true, valid: true }
  }, now));
  const publish = plans.find((entry) => entry.stage === "publish");
  assert.equal(publish.shouldCreateJob, true);
  assert.equal(publish.reasonCode, "DUE_JOB_MISSING");
});

test("V3は従来どおりstart+10前のrankingをdueにしない", () => {
  const now = new Date("2026-09-02T09:07:00.000Z");
  const plans = v3.buildStagePlans(planningState("scored", {
    lineup_finalize: { available: true, ready: true, valid: true },
    scoring: { available: true, ready: true, valid: true }
  }, now));
  const ranking = plans.find((entry) => entry.stage === "ranking_reflect");
  assert.equal(ranking.shouldCreateJob, false);
  assert.equal(ranking.reasonCode, "NOT_DUE");
  assert.equal(ranking.due, false);
});

test("published済みcorrectionの二周目は旧reflection/jobを保持したままranking Bとpublish Bへ進む", async () => {
  const now = new Date("2026-09-02T10:05:00.000Z");
  const oldRankingSlot = "2026-09-02T09:10:00.000Z";
  const state = {
    persistedState: "scored",
    jobs: [
      { id: 401, internal_game_id: GAME_ID, job_type: "score", status: "completed", scheduled_slot_at: "2026-09-02T09:05:00.000Z" },
      { id: 402, internal_game_id: GAME_ID, job_type: "ranking_rebuild", status: "completed", scheduled_slot_at: oldRankingSlot },
      { id: 403, internal_game_id: GAME_ID, job_type: "publish", status: "completed", scheduled_slot_at: "2026-09-02T09:10:00.000Z" }
    ],
    nextId: 403,
    scoreReady: true,
    rankingReflected: true,
    scoringRevisionId: "score-revision-b",
    reflectionScoringRevisionId: "score-revision-a",
    canonicalFinalRevisionId: `${GAME_ID}:2`,
    publicationStatus: "pending",
    publishedAt: null
  };
  const disabledStages = ["roster_fetch", "lineup_fetch"];
  const rankingPlan = await v3.planMainWorkflowJobs(
    planningDb(state),
    [game()],
    now,
    { disabledStages }
  );
  const rankingB = state.jobs.find((job) => job.job_type === "ranking_rebuild" && job.id !== 402);
  assert.equal(rankingPlan.created, 1);
  assert.ok(rankingB, "旧completed ranking jobとは別の新jobを生成すること");
  assert.notEqual(rankingB.scheduled_slot_at, oldRankingSlot);
  assert.equal(rankingPlan.planned.find((entry) => entry.plan?.jobType === "ranking_rebuild")?.plan?.sharedPlan?.reasonCode, "COMPLETED_ARTIFACT_REVISION_MISMATCH");

  rankingB.status = "completed";
  state.reflectionScoringRevisionId = state.scoringRevisionId;
  const publishPlan = await v3.planMainWorkflowJobs(
    planningDb(state),
    [game()],
    now,
    { disabledStages }
  );
  const publishB = state.jobs.find((job) => job.job_type === "publish" && job.id !== 403);
  assert.equal(publishPlan.created, 1);
  assert.ok(publishB, "current scoring revisionのreflection後にpublish jobを生成すること");
  assert.notEqual(publishB.id, 403);
  assert.notEqual(publishB.scheduled_slot_at, "2026-09-02T09:10:00.000Z");

  publishB.status = "completed";
  state.persistedState = "published";
  state.publicationStatus = "published";
  state.publishedAt = "2026-09-02T10:06:00.000Z";
  const completed = await v3.planMainWorkflowJobs(
    planningDb(state),
    [game()],
    now,
    { disabledStages }
  );
  assert.equal(completed.created, 0);
  assert.equal(completed.planned.length, 0, "二周目完了後に不要なjobを増やさないこと");
});

function finalizeSourceForTest() {
  const start = workerSource.indexOf("async function handleAdminV3LineupFinalize");
  const end = workerSource.indexOf("function v3RescoreBody", start);
  return workerSource.slice(start, end);
}

test("manual finalizeは自動roster/lineup取得を呼ばず、正式Cronへ委譲する契約を維持する", () => {
  const finalizeStart = workerSource.indexOf("async function handleAdminV3LineupFinalize");
  const finalizeEnd = workerSource.indexOf("function v3RescoreBody", finalizeStart);
  const finalizeSource = workerSource.slice(finalizeStart, finalizeEnd);
  assert.doesNotMatch(finalizeSource, /createV3AdminActionJob/);
  assert.match(finalizeSource, /scoreJob: null/);
  assert.match(finalizeSource, /nextAction: "formal_cron_score"/);
  assert.match(orchestratorSource, /V4_AUTO_ROSTER_FETCH_DISABLED/);
  assert.match(orchestratorSource, /disabledStages/);
});

test("formal plannerはV4のdisabled stageを診断へ残すが、作成対象へ出さない", async () => {
  const unavailableDb = { prepare() { throw new Error("test read unavailable"); } };
  const result = await v3.planMainWorkflowJobs(
    unavailableDb,
    [game()],
    new Date("2026-09-02T07:00:00.000Z"),
    { disabledStages: ["roster_fetch", "lineup_fetch"] }
  );
  assert.equal(result.planned.some((entry) => ["roster_fetch", "lineup_fetch"].includes(entry.plan?.stage)), false);
  for (const stage of ["roster_fetch", "lineup_fetch"]) {
    const diagnostic = result.diagnostics.find((entry) => entry.stage === stage);
    assert.equal(diagnostic.reasonCode, "V4_AUTO_FETCH_DISABLED");
    assert.equal(diagnostic.shouldCreateJob, false);
  }
});

test("V4では切替前に残ったdue roster/lineup jobもclaimしない", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE game_jobs_v3 (
        id INTEGER PRIMARY KEY, internal_game_id TEXT, job_type TEXT,
        scheduled_at TEXT, scheduled_slot_at TEXT, status TEXT,
        attempt_count INTEGER, max_attempts INTEGER, next_retry_at TEXT,
        claimed_at TEXT, lease_expires_at TEXT, claim_token TEXT
      );
      INSERT INTO game_jobs_v3
        (id, internal_game_id, job_type, scheduled_at, scheduled_slot_at, status, attempt_count, max_attempts)
        VALUES (1, '${GAME_ID}', 'roster_fetch', '2026-09-02T07:00:00.000Z', '2026-09-02T07:00:00.000Z', 'pending', 0, 3),
               (2, '${GAME_ID}', 'lineup_fetch', '2026-09-02T09:00:00.000Z', '2026-09-02T09:00:00.000Z', 'retry_wait', 1, 3),
               (3, '${GAME_ID}', 'roster_fetch', '2026-09-02T07:01:00.000Z', '2026-09-02T07:01:00.000Z', 'claimed', 1, 3),
               (4, '${GAME_ID}', 'lineup_fetch', '2026-09-02T09:01:00.000Z', '2026-09-02T09:01:00.000Z', 'claimed', 1, 3);
    `);
    database.prepare("UPDATE game_jobs_v3 SET next_retry_at = ?, lease_expires_at = ? WHERE id = 2").run("2026-09-02T09:00:00.000Z", null);
    database.prepare("UPDATE game_jobs_v3 SET lease_expires_at = ? WHERE id IN (3, 4)").run("2026-09-02T09:00:00.000Z");
    const report = await v3.claimDueJobs(d1(database), new Date("2026-09-02T09:05:00.000Z"), [], {
      disabledJobTypes: ["roster_fetch", "lineup_fetch"]
    });
    assert.equal(report.claimed.length, 0);
    assert.deepEqual(report.skipped.map((entry) => entry.job.id), [1, 3, 2, 4]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM game_jobs_v3 WHERE status IN ('pending', 'retry_wait', 'claimed')").get().count, 4);
  } finally {
    database.close();
  }
});

test("V4 admin表示は自動/手動の責務と次の運営操作を明示する", () => {
  assert.match(workerSource, /automationMode: getV3OperationalMode\(env\)/);
  assert.match(adminSource, /data-v3-v4-mode/);
  assert.match(adminSource, /V4半自動運営/);
  assert.match(adminSource, /ロースター: Fightersロースターを手動管理/);
  assert.match(adminSource, /スタメン: 自動取得OFF/);
  assert.match(adminSource, /ロースター管理とスタメン確定をそれぞれ確認/);
  assert.match(wranglerSource, /"ENABLE_AUTO_PROBABLE_STARTER": "true"/);
  assert.match(wranglerSource, /"ENABLE_AUTO_ROSTER_FETCH": "false"/);
  assert.match(wranglerSource, /"ENABLE_AUTO_LINEUP_FETCH": "false"/);
  assert.match(wranglerSource, /"ENABLE_SEMI_AUTO_LINEUP": "true"/);
});

test("manual rosterは今回のP0でlineupと混ぜず、既存catalog入力を維持する", () => {
  assert.match(workerSource, /getManualLineupPlayerCatalog/);
  assert.match(workerSource, /source: "manual"/);
  assert.doesNotMatch(workerSource.slice(workerSource.indexOf("async function handleAdminV3LineupFinalize"), workerSource.indexOf("function v3RescoreBody")), /roster/i);
});
