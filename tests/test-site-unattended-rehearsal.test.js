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
import { FIGHTERS_REHEARSAL, isArmedFightersTestEnvironment, isFightersRehearsalDay, isFightersRehearsalSeedWindow, shouldSeedFightersRehearsal,
  simulatorRehearsalLifecycle } from "../tooling/test-site/unattended-rehearsal.js";
import { evaluateUnattendedCheckpoint } from "../tooling/test-site/unattended-observer.mjs";
import { runScheduledCoreToCompletion, runScheduledTick } from "../tooling/test-site/scheduled-runner.js";
import { evaluateDriverInvocation } from "../tooling/test-site/unattended-driver.mjs";

const env = { ...config.vars, AUTH_DB: {}, AUDIT_DB: {} };
const game = { game_date: FIGHTERS_REHEARSAL.date, provider_game_id: FIGHTERS_REHEARSAL.gameCode,
  target_team_key: "fighters", start_time: FIGHTERS_REHEARSAL.startAt, state: "scheduled" };

test("automatic seed requires exact isolated Test identity, fixture, open window and missing predictions", () => {
  assert.equal(isArmedFightersTestEnvironment(env), true);
  assert.deepEqual(shouldSeedFightersRehearsal({ env, now: "2026-10-25T04:00:00.000Z", game, predictionCount: 0 }),
    { allowed: true, reason: "seed" });
  assert.deepEqual(shouldSeedFightersRehearsal({ env, now: "2026-10-25T04:20:00.000Z", game, predictionCount: 4 }),
    { allowed: true, reason: "resume_partial_seed" });
  assert.equal(shouldSeedFightersRehearsal({ env: { ...env, ENVIRONMENT: "production" }, now: "2026-10-25T04:00:00Z", game }).allowed, false);
  assert.equal(shouldSeedFightersRehearsal({ env, now: "2026-10-26T04:00:00Z", game }).reason, "outside_seed_window");
  assert.equal(shouldSeedFightersRehearsal({ env, now: "2026-10-25T04:00:00Z", game: { ...game, target_team_key: "hawks" } }).reason, "target_identity_mismatch");
  assert.equal(shouldSeedFightersRehearsal({ env, now: "2026-10-25T04:00:00Z", game: { ...game, provider_game_id: "g-t-3" } }).reason, "target_identity_mismatch");
  assert.equal(shouldSeedFightersRehearsal({ env, now: "2026-10-25T04:00:00Z", game: { ...game, state: "prediction_closed" } }).reason, "prediction_window_not_open");
  assert.equal(shouldSeedFightersRehearsal({ env, now: "2026-10-25T04:00:00Z", game, predictionCount: 10 }).reason, "already_seeded");
  assert.equal(isArmedFightersTestEnvironment({ ...env, TEST_AUTH_DB_ID: "326f97c3-768d-4df6-ada2-129fdb1865a1" }), false);
  assert.equal(isFightersRehearsalSeedWindow("2026-10-25T03:59:59Z"), false);
  assert.equal(isFightersRehearsalSeedWindow("2026-10-25T04:00:00Z"), true);
  assert.equal(isFightersRehearsalSeedWindow("2026-10-25T05:00:00Z"), false);
  assert.equal(isFightersRehearsalSeedWindow("2026-10-26T04:30:00Z"), false);
});

test("Test Worker keeps all five production schedule modes but installs no Cloudflare Cron triggers", () => {
  assert.deepEqual(config.triggers.crons, []);
  assert.deepEqual(TEST_SCHEDULED_CRONS, productionConfig.triggers.crons);
  assert.equal(new Set(TEST_SCHEDULED_CRONS).size, 5);
});

test("native scheduled and GitHub bridge use one bounded core with actual server time", async () => {
  const now = new Date("2026-10-25T04:15:00.000Z");
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

test("driver runs only on the 2026-10-25 JST window and manual dispatch is auth-check only", () => {
  assert.deepEqual(evaluateDriverInvocation({ eventName: "schedule", now: "2026-10-25T03:00:00Z" }), { action: "tick" });
  assert.deepEqual(evaluateDriverInvocation({ eventName: "schedule", now: "2026-10-25T11:30:00Z" }), { action: "tick" });
  for (const now of ["2026-10-24T03:00:00Z", "2026-10-26T03:00:00Z", "2027-10-25T03:00:00Z"]) {
    assert.equal(evaluateDriverInvocation({ eventName: "schedule", now }).action, "noop", now);
  }
  assert.equal(evaluateDriverInvocation({ eventName: "schedule", now: "2026-10-25T02:55:00Z" }).action, "noop");
  assert.equal(evaluateDriverInvocation({ eventName: "schedule", now: "2026-10-25T11:35:00Z" }).action, "noop");
  assert.deepEqual(evaluateDriverInvocation({ eventName: "workflow_dispatch", mode: "auth-check", now: "2026-10-24T00:00:00Z" }),
    { action: "auth-check" });
  assert.equal(evaluateDriverInvocation({ eventName: "workflow_dispatch", mode: "tick", now: "2026-10-25T04:00:00Z" }).action, "reject");
  assert.match(driverWorkflow, /\*\/5 3-10 25 10 \*/);
  assert.match(driverWorkflow, /0,5,10,15,20,25,30 11 25 10 \*/);
  assert.match(driverWorkflow, /id-token: write/);
  assert.match(driverSource, /GITHUB_EVENT_NAME/);
  assert.doesNotMatch(driverSource, /logicalNow|nowOverride|scheduledTime\s*:/);
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

test("simulated lineup and final-result availability use actual wall clock and fixed scenario date", () => {
  assert.equal(isFightersRehearsalDay("2026-10-24T23:59:59Z"), true, "Oct 25 starts at 09:00 UTC in Japan");
  assert.equal(isFightersRehearsalDay("2026-10-24T14:59:59Z"), false);
  assert.equal(isFightersRehearsalDay("2026-10-26T00:00:00Z"), false);
  assert.deepEqual(simulatorRehearsalLifecycle("2026-10-25T05:19:59Z"), { lineupAvailable: false, status: "scheduled", final: false });
  assert.deepEqual(simulatorRehearsalLifecycle("2026-10-25T05:20:00Z"), { lineupAvailable: true, status: "scheduled", final: false });
  assert.deepEqual(simulatorRehearsalLifecycle("2026-10-25T06:00:00Z"), { lineupAvailable: true, status: "live", final: false });
  assert.deepEqual(simulatorRehearsalLifecycle("2026-10-25T09:30:00Z"), { lineupAvailable: true, status: "final", final: true });
  assert.deepEqual(simulatorRehearsalLifecycle("2026-10-26T00:00:00Z"), { lineupAvailable: true, status: "final", final: true });
  assert.equal(simulatorRehearsalLifecycle("invalid").final, false);
});

test("observer checkpoints are read-only assertions and report exact pipeline failure stages", () => {
  assert.match(observerSource, /method:\s*["']GET["']/);
  assert.doesNotMatch(observerSource, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
  assert.doesNotMatch(testWorkerSource.match(/if \(url\.pathname === "\/api\/test\/rehearsal\/observer"[\s\S]*?\n  if \(url\.pathname === "\/api\/test\/rehearsal\/snapshot"/)[0], /authWorker\.fetch|\.put\(|\.delete\(/);
  const requiredJobTypes = Object.fromEntries(["prediction_close", "lineup_fetch", "lineup_finalize", "score", "ranking_rebuild", "publish"]
    .map((type) => [type, { completed: 1 }]));
  const ready = { ok: true, game: { providerGameId: "g-t-4", date: "2026-10-25", startAt: "2026-10-25T06:00:00.000Z" },
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
});
