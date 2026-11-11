import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TEST_SCHEDULED_CRONS } from "../tooling/test-site/isolation.js";
const config = JSON.parse(fs.readFileSync(path.resolve("wrangler.test-auth.jsonc"), "utf8"));
const productionConfig = JSON.parse(fs.readFileSync(path.resolve("wrangler.auth.production.jsonc"), "utf8"));
const remoteE2EWorkflow = fs.readFileSync(path.resolve(".github/workflows/s9simu-remote-e2e.yml"), "utf8");
const remoteE2ERunner = fs.readFileSync(path.resolve("tooling/test-site/simu-e2e.mjs"), "utf8");
const testWorkerSource = fs.readFileSync(path.resolve("tooling/test-site/worker.js"), "utf8");
const observerSource = fs.readFileSync(path.resolve("tooling/test-site/unattended-observer.mjs"), "utf8");
const driverWorkflow = fs.readFileSync(path.resolve(".github/workflows/fighters-unattended-driver.yml"), "utf8");
const driverSource = fs.readFileSync(path.resolve("tooling/test-site/unattended-driver.mjs"), "utf8");
import { FIGHTERS_REHEARSAL, fightersRehearsal, isArmedFightersTestEnvironment, isFightersRehearsalDay,
  isFightersRehearsalDriverWindow, isFightersRehearsalSeedWindow, shouldSeedFightersRehearsal,
  simulatorRehearsalLifecycle } from "../tooling/test-site/unattended-rehearsal.js";
import { evaluateUnattendedCheckpoint } from "../tooling/test-site/unattended-observer.mjs";
import { runScheduledCoreToCompletion, runScheduledTick } from "../tooling/test-site/scheduled-runner.js";
import { evaluateDriverInvocation } from "../tooling/test-site/unattended-driver.mjs";

// The rehearsal is anchored to the current JST day; capture one scenario view
// so a run that straddles midnight still asserts one coherent fixture.
const SCENARIO = Object.freeze({ ...fightersRehearsal() });
const startMs = Date.parse(SCENARIO.startAt);
const atOffset = (minutes) => new Date(startMs + minutes * 60_000).toISOString();
const env = { ...config.vars, AUTH_DB: {}, AUDIT_DB: {} };
const game = { game_date: SCENARIO.date, provider_game_id: SCENARIO.gameCode,
  target_team_key: "fighters", start_time: SCENARIO.startAt, state: "scheduled" };

test("automatic seed requires exact isolated Test identity, fixture, open window and missing predictions", () => {
  assert.equal(isArmedFightersTestEnvironment(env), true);
  assert.deepEqual(shouldSeedFightersRehearsal({ env, now: atOffset(-120), game, predictionCount: 0 }),
    { allowed: true, reason: "seed" });
  assert.deepEqual(shouldSeedFightersRehearsal({ env, now: atOffset(-100), game, predictionCount: 4 }),
    { allowed: true, reason: "resume_partial_seed" });
  assert.equal(shouldSeedFightersRehearsal({ env: { ...env, ENVIRONMENT: "production" }, now: atOffset(-120), game }).allowed, false);
  assert.equal(shouldSeedFightersRehearsal({ env, now: atOffset(0), game }).reason, "outside_seed_window");
  assert.equal(shouldSeedFightersRehearsal({ env, now: atOffset(-120), game: { ...game, target_team_key: "hawks" } }).reason, "target_identity_mismatch");
  assert.equal(shouldSeedFightersRehearsal({ env, now: atOffset(-120), game: { ...game, provider_game_id: "g-t-3" } }).reason, "target_identity_mismatch");
  assert.equal(shouldSeedFightersRehearsal({ env, now: atOffset(-120), game: { ...game, start_time: atOffset(-180) } }).reason, "target_identity_mismatch");
  assert.equal(shouldSeedFightersRehearsal({ env, now: atOffset(-120), game: { ...game, state: "prediction_closed" } }).reason, "prediction_window_not_open");
  assert.equal(shouldSeedFightersRehearsal({ env, now: atOffset(-120), game, predictionCount: 10 }).reason, "already_seeded");
  assert.equal(isArmedFightersTestEnvironment({ ...env, TEST_AUTH_DB_ID: "326f97c3-768d-4df6-ada2-129fdb1865a1" }), false);
  assert.equal(isFightersRehearsalSeedWindow(atOffset(-121)), false, "seed opens two hours before first pitch");
  assert.equal(isFightersRehearsalSeedWindow(atOffset(-120)), true);
  assert.equal(isFightersRehearsalSeedWindow(atOffset(-61)), true);
  assert.equal(isFightersRehearsalSeedWindow(atOffset(-60)), false, "predictions close one hour before first pitch");
});

test("Test Worker keeps all five production schedule modes but installs no Cloudflare Cron triggers", () => {
  assert.deepEqual(config.triggers.crons, []);
  assert.deepEqual(TEST_SCHEDULED_CRONS, productionConfig.triggers.crons);
  assert.equal(new Set(TEST_SCHEDULED_CRONS).size, 5);
});

test("native scheduled and GitHub bridge use one bounded core with actual server time", async () => {
  const now = new Date(atOffset(-105));
  const observations = [];
  const callbacks = {
    env,
    ctx: { waitUntil() {} },
    now,
    runSeed: async (at) => observations.push({ type: "seed", at: at.toISOString() }),
    runCore: async (event) => observations.push({ type: "core", event })
  };
  const native = await runScheduledTick({ source: "cloudflare", event: { cron: "* * * * *" }, ...callbacks });
  const github = await runScheduledTick({ source: "github", event: { cron: "malicious", scheduledTime: 0 }, ...callbacks });
  assert.equal(native.ok, true);
  assert.equal(github.ok, true);
  assert.deepEqual(observations.filter((item) => item.type === "core").map((item) => item.event), [
    { cron: "* * * * *", scheduledTime: now.getTime() },
    { cron: "* * * * *", scheduledTime: now.getTime() }
  ]);
  assert.equal(observations.filter((item) => item.type === "seed").length, 2);
  assert.equal(github.scheduledTime, now.toISOString(), "the bridge uses server time, never a caller-supplied clock");
  assert.match(testWorkerSource, /runFightersScheduledTick\(\{ source: "github"/);
  assert.match(testWorkerSource, /runFightersScheduledTick\(\{ source: "cloudflare"/);
});

test("GitHub HTTP pulse waits for the same scheduled handler's waitUntil work before responding", async () => {
  let completed = false;
  const result = await runScheduledCoreToCompletion(async (_event, _env, ctx) => {
    ctx.waitUntil(new Promise((resolve) => setTimeout(() => {
      completed = true;
      resolve();
    }, 5)));
    return "scheduled-handler-returned";
  }, { cron: "* * * * *", scheduledTime: Date.now() }, env);
  assert.equal(result, "scheduled-handler-returned");
  assert.equal(completed, true);
});

test("driver chains ticks from ignition or continuation and never derives its own clock", () => {
  assert.deepEqual(evaluateDriverInvocation({ eventName: "schedule", now: atOffset(-120) }), { action: "chain" });
  assert.deepEqual(evaluateDriverInvocation({ eventName: "schedule", now: atOffset(120) }), { action: "chain" });
  assert.deepEqual(evaluateDriverInvocation({ eventName: "workflow_dispatch", mode: "auth-check", now: atOffset(-120) }),
    { action: "auth-check" });
  assert.deepEqual(evaluateDriverInvocation({ eventName: "workflow_dispatch", mode: "chain", now: atOffset(-120) }),
    { action: "chain" });
  assert.equal(evaluateDriverInvocation({ eventName: "workflow_dispatch", mode: "tick", now: atOffset(-120) }).action, "reject");
  assert.equal(evaluateDriverInvocation({ eventName: "push", now: atOffset(-120) }).action, "reject");
  assert.equal(evaluateDriverInvocation({ eventName: "schedule", now: "invalid" }).reason, "invalid_time");
  assert.match(driverWorkflow, /0,30 3 \* \* \*/);
  assert.match(driverWorkflow, /0 6,9,12 \* \* \*/);
  assert.match(driverWorkflow, /id-token: write/);
  assert.match(driverWorkflow, /actions: write/);
  assert.match(driverSource, /GITHUB_EVENT_NAME/);
  assert.match(driverSource, /actions\/workflows/);
  assert.match(driverSource, /evaluateUnattendedCheckpoint\("final", observation\)/);
  assert.match(driverSource, /sibling_contest_changed/);
  assert.doesNotMatch(driverSource, /logicalNow|nowOverride|scheduledTime\s*:/);
});

test("Test Worker accepts chained ticks across the whole active rehearsal day", () => {
  assert.equal(isFightersRehearsalDriverWindow(atOffset(-181)), false);
  assert.equal(isFightersRehearsalDriverWindow(atOffset(-180)), true);
  assert.equal(isFightersRehearsalDriverWindow(atOffset(0)), true);
  assert.equal(isFightersRehearsalDriverWindow(atOffset(419)), true);
  assert.equal(isFightersRehearsalDriverWindow(atOffset(420)), false);
  assert.equal(isFightersRehearsalDriverWindow(atOffset(420 + 24 * 60)), false);
});

test("remote preparation mode is explicitly selectable and exits before any rehearsal pipeline advancement", () => {
  assert.match(remoteE2EWorkflow, /- prepare-unattended/);
  assert.match(remoteE2ERunner, /RUN_MODE === "prepare-unattended"[\s\S]*?runFightersOperationalRehearsal\(\{ prepareOnly: true \}\)/);
  const preparationBranch = remoteE2ERunner.match(/if \(prepareOnly\) \{([\s\S]*?)\r?\n  \}\r?\n\r?\n  const contestId/);
  assert.ok(preparationBranch, "preparation-only branch must be bounded before the normal rehearsal path");
  assert.doesNotMatch(preparationBranch[1], /\badvance\(|\/api\/test\/scenario|prediction-write|method:\s*["']POST/);
  assert.match(preparationBranch[1], /formalJobCount, 0/);
});

test("automatic lineup settings are scoped to scheduled Test execution, not the existing manual Test fixture", () => {
  assert.equal(config.vars.ENABLE_AUTO_LINEUP_FETCH, "false");
  assert.equal(config.vars.ENABLE_SEMI_AUTO_LINEUP, "true");
  assert.match(testWorkerSource, /function createScheduledTestProductEnvironment[\s\S]*?ENABLE_AUTO_LINEUP_FETCH:\s*"true"[\s\S]*ENABLE_SEMI_AUTO_LINEUP:\s*"false"/);
  assert.match(testWorkerSource, /runCore:\s*\(scheduledEvent, scheduledEnv, scheduledContext\)\s*=>\s*\{[\s\S]*?return source === "github"[\s\S]*?runScheduledCoreToCompletion\(invoke, scheduledEvent, productEnv\)/);
  assert.match(testWorkerSource, /const invoke = \(event, workerEnv, workerContext\) => authWorker\.scheduled\(event, workerEnv, workerContext\)/);
  assert.match(testWorkerSource, /runFightersScheduledTick\(\{ source: "cloudflare", event, env, ctx, now: scheduledAt \}\)/);
  assert.match(testWorkerSource, /runFightersScheduledTick\(\{ source: "github", event: null, env, ctx, now \}\)/);
});

test("simulated lineup and final-result availability follow the wall clock around the 15:00 first pitch", () => {
  // The scenario is always the current JST day, so every parseable instant is
  // on the rehearsal day and an unparseable one is never.
  assert.equal(isFightersRehearsalDay(atOffset(-600)), true);
  assert.equal(isFightersRehearsalDay(new Date(startMs)), true);
  assert.equal(isFightersRehearsalDay("invalid"), false);
  assert.deepEqual(simulatorRehearsalLifecycle(atOffset(-41)), { lineupAvailable: false, status: "scheduled", final: false });
  assert.deepEqual(simulatorRehearsalLifecycle(atOffset(-40)), { lineupAvailable: true, status: "scheduled", final: false });
  assert.deepEqual(simulatorRehearsalLifecycle(atOffset(0)), { lineupAvailable: true, status: "live", final: false });
  assert.deepEqual(simulatorRehearsalLifecycle(atOffset(209)), { lineupAvailable: true, status: "live", final: false });
  assert.deepEqual(simulatorRehearsalLifecycle(atOffset(210)), { lineupAvailable: true, status: "final", final: true });
  assert.equal(simulatorRehearsalLifecycle("invalid").final, false);
});

test("observer checkpoints are read-only assertions and report exact pipeline failure stages", () => {
  assert.match(observerSource, /method:\s*["']GET["']/);
  assert.doesNotMatch(observerSource, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
  assert.doesNotMatch(testWorkerSource.match(/if \(url\.pathname === "\/api\/test\/rehearsal\/observer"[\s\S]*?\n  if \(url\.pathname === "\/api\/test\/rehearsal\/snapshot"/)[0], /authWorker\.fetch|\.put\(|\.delete\(/);
  const requiredJobTypes = Object.fromEntries(["prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]
    .map((type) => [type, { completed: 1 }]));
  const ready = { ok: true, game: { providerGameId: SCENARIO.gameCode, date: SCENARIO.date, startAt: SCENARIO.startAt },
    fighters: { state: "published", predictions: 10, distinctPredictionUsers: 10, finalLineupRevisionPresent: true,
      officialLineupRows: 9, scoredPredictions: 10, rankingReflected: true, publicationStatus: "published",
      publicationArtifacts: 1, jobs: { completed: 6 }, jobTypes: requiredJobTypes }, rosterCount: 15,
    hawks: { state: "published", publicationStatus: "published", publicationCount: 1 } };
  for (const checkpoint of ["before_cutoff", "after_cutoff", "after_lineup", "final"]) {
    assert.deepEqual(evaluateUnattendedCheckpoint(checkpoint, ready), { ok: true });
  }
  assert.equal(evaluateUnattendedCheckpoint("before_cutoff", { ...ready, fighters: { ...ready.fighters, predictions: 0 } }).code,
    "predictions_not_seeded");
  assert.equal(evaluateUnattendedCheckpoint("after_cutoff", { ...ready, fighters: { ...ready.fighters, state: "scheduled" } }).code,
    "prediction_not_closed");
  assert.equal(evaluateUnattendedCheckpoint("after_lineup", { ...ready, fighters: { ...ready.fighters, officialLineupRows: 8 } }).code,
    "lineup_missing");
  assert.equal(evaluateUnattendedCheckpoint("final", { ...ready, fighters: { ...ready.fighters, jobs: { claimed: 1 } } }).code,
    "stuck_job");
  assert.equal(evaluateUnattendedCheckpoint("final", { ...ready, fighters: { ...ready.fighters,
    jobTypes: { ...requiredJobTypes, score: { pending: 1 } } } }).code, "job_incomplete_score");
  assert.equal(evaluateUnattendedCheckpoint("final", { ...ready, game: { ...ready.game, startAt: atOffset(-60) } }).code,
    "schedule_not_discovered");
  // A scheduled sibling is a valid baseline for the rolling fixture; only a
  // second publication proves this run advanced it.
  assert.deepEqual(evaluateUnattendedCheckpoint("final", { ...ready,
    hawks: { state: "scheduled", publicationStatus: null, publicationCount: 0 } }), { ok: true });
  assert.equal(evaluateUnattendedCheckpoint("final", { ...ready,
    hawks: { state: "published", publicationStatus: "published", publicationCount: 2 } }).code, "hawks_sibling_changed");
});
