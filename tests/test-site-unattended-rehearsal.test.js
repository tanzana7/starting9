import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TEST_CRON_TRIGGERS } from "../tooling/test-site/isolation.js";
const config = JSON.parse(fs.readFileSync(path.resolve("wrangler.test-auth.jsonc"), "utf8"));
const productionConfig = JSON.parse(fs.readFileSync(path.resolve("wrangler.auth.production.jsonc"), "utf8"));
const remoteE2EWorkflow = fs.readFileSync(path.resolve(".github/workflows/s9simu-remote-e2e.yml"), "utf8");
const remoteE2ERunner = fs.readFileSync(path.resolve("tooling/test-site/simu-e2e.mjs"), "utf8");
const testWorkerSource = fs.readFileSync(path.resolve("tooling/test-site/worker.js"), "utf8");
const observerSource = fs.readFileSync(path.resolve("tooling/test-site/unattended-observer.mjs"), "utf8");
import { FIGHTERS_REHEARSAL, isArmedFightersTestEnvironment, isFightersRehearsalDay, isFightersRehearsalSeedWindow, shouldSeedFightersRehearsal,
  simulatorRehearsalLifecycle } from "../tooling/test-site/unattended-rehearsal.js";
import { evaluateUnattendedCheckpoint } from "../tooling/test-site/unattended-observer.mjs";

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

test("Test Cron cadence is bounded to the exact five Production-equivalent modes", () => {
  assert.deepEqual(config.triggers.crons, TEST_CRON_TRIGGERS);
  assert.deepEqual(config.triggers.crons, productionConfig.triggers.crons);
  assert.equal(new Set(TEST_CRON_TRIGGERS).size, 5);
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
  assert.match(testWorkerSource, /authWorker\.scheduled\(event, productEnv, ctx\)/);
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
