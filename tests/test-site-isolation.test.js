const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));

test("test Worker and Pages configs are pinned to isolated TARGET resources", async () => {
  const isolation = await import("../tooling/test-site/isolation.js");
  assert.equal(isolation.assertTestAuthConfig(readJson("wrangler.test-auth.jsonc")), true);
  assert.equal(isolation.assertTestPagesConfig(readJson("tooling/test-site/pages-project/wrangler.jsonc")), true);
  assert.equal(readJson("tooling/test-site/pages-project/wrangler.jsonc").account_id, undefined);
});

test("production D1 IDs are rejected even if placed in the opposite test binding", async () => {
  const isolation = await import("../tooling/test-site/isolation.js");
  const config = readJson("wrangler.test-auth.jsonc");
  config.d1_databases.find((row) => row.binding === "AUTH_DB").database_id = isolation.PRODUCTION_RESOURCE_IDS.auditDatabase;
  assert.throws(() => isolation.assertTestAuthConfig(config), /production D1 ID/);
});

test("production environment cannot enable the test scenario controller", async () => {
  const isolation = await import("../tooling/test-site/isolation.js");
  const env = {
    ...readJson("wrangler.test-auth.jsonc").vars,
    ENVIRONMENT: "production",
    AUTH_DB: {},
    AUDIT_DB: {}
  };
  assert.equal(isolation.isIsolatedTestEnvironment(env), false);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "auth-worker.js"), "utf8"), /\/api\/test\/reset/);
});

test("test controller fails closed when any resource identity is missing or production-bound", async () => {
  const isolation = await import("../tooling/test-site/isolation.js");
  const valid = {
    ...readJson("wrangler.test-auth.jsonc").vars,
    AUTH_DB: {}, AUDIT_DB: {}
  };
  assert.equal(isolation.isIsolatedTestEnvironment(valid), true);
  assert.equal(isolation.isAuthorizedFightersRehearsalResetEnvironment(valid), true);
  assert.equal(isolation.isAuthorizedFightersRehearsalResetEnvironment({ ...valid, TEST_EXPECTED_ACCOUNT_ID: "wrong-account" }), false);
  assert.equal(isolation.isIsolatedTestEnvironment({ ...valid, TEST_AUTH_DB_ID: "" }), false);
  assert.equal(isolation.isIsolatedTestEnvironment({ ...valid, TEST_AUTH_DB_ID: "synthetic-but-unknown-db" }), false);
  assert.equal(isolation.isIsolatedTestEnvironment({ ...valid, TEST_WORKER_NAME: "starting9-auth" }), false);
  assert.equal(isolation.isIsolatedTestEnvironment({ ...valid, TEST_AUDIT_DB_ID: isolation.PRODUCTION_RESOURCE_IDS.auditDatabase }), false);
  assert.equal(isolation.isIsolatedTestEnvironment({ ...valid, TEST_AUDIT_DB_ID: "synthetic-but-unknown-db" }), false);
  const wrongAccountConfig = readJson("wrangler.test-auth.jsonc");
  wrongAccountConfig.vars.TEST_EXPECTED_ACCOUNT_ID = "wrong-account";
  assert.throws(() => isolation.assertTestAuthConfig(wrongAccountConfig), /runtime account identity/);
});

test("published scenario validation requires every canonical artifact", async () => {
  const { validatePublishedScenario } = await import("../tooling/test-site/isolation.js");
  const complete = { state: "published", lineupReady: true, scoringReady: true, rankingReady: true, publicationReady: true };
  assert.equal(validatePublishedScenario(complete), true);
  for (const field of ["lineupReady", "scoringReady", "rankingReady", "publicationReady"]) {
    assert.equal(validatePublishedScenario({ ...complete, [field]: false }), false, `${field} must be required`);
  }
});

test("production Pages proxy keeps its exact origin and rejects test-worker crossover", async () => {
  const { resolveAuthWorkerOrigin } = await import("../functions/api/[[path]].js");
  const testConfig = readJson("tooling/test-site/pages-project/wrangler.jsonc");
  const prodConfig = readJson("wrangler.auth.target.production.jsonc");
  assert.equal(resolveAuthWorkerOrigin(testConfig.vars), testConfig.vars.STARTING9_AUTH_ORIGIN);
  assert.equal(resolveAuthWorkerOrigin({}), null);
  assert.equal(resolveAuthWorkerOrigin({ SITE_ENVIRONMENT: "production", STARTING9_AUTH_ORIGIN: "https://starting9-auth.starting9.workers.dev" }), "https://starting9-auth.starting9.workers.dev");
  assert.equal(resolveAuthWorkerOrigin({ SITE_ENVIRONMENT: "production", STARTING9_AUTH_ORIGIN: testConfig.vars.STARTING9_AUTH_ORIGIN }), null);
  assert.equal(resolveAuthWorkerOrigin({ SITE_ENVIRONMENT: "test", STARTING9_AUTH_ORIGIN: prodConfig.name }), null);
});

test("scenario worker uses real wall-clock-relative fixtures, not a global Date override", () => {
  const source = fs.readFileSync(path.join(ROOT, "tooling/test-site/worker.js"), "utf8");
  assert.match(source, /new Date\(\)/);
  assert.doesNotMatch(source, /Date\.now\s*=|globalThis\.Date\s*=|Date\s*=\s*class/);
  assert.equal(readJson("wrangler.test-auth.jsonc").triggers?.crons?.length || 0, 0);
});

test("closed scenario advances through the formal planner to prediction_closed", () => {
  const source = fs.readFileSync(path.join(ROOT, "tooling/test-site/worker.js"), "utf8");
  assert.match(source, /await runPipeline\(env, \{ target: "closed",\s*stageOnly: scenario === "retry" \|\| \(stageOnly && scenario === "closed"\) \}\);[\s\S]*if \(!existingLineup\?\.final_lineup_revision_id\)/);
});

test("lineup-ready scenario creates a due score job but leaves it unclaimed for inspection", () => {
  const source = fs.readFileSync(path.join(ROOT, "tooling/test-site/worker.js"), "utf8");
  assert.match(source, /import \{ transitionV3State \} from "\.\.\/\.\.\/backend\/automation-v3\/repository\.js"/);
  assert.match(source, /state\?\.state !== "prediction_closed" \|\| !String\(lineup\?\.final_lineup_revision_id \|\| ""\)\.trim\(\) \|\| !predictionClose\?\.id/);
  assert.match(source, /from: "prediction_closed",\s*to: "lineup_ready"/);
  assert.match(source, /target === "lineup-ready"\s*\? \["lineup_finalize", "ranking_rebuild", "publish"\]/);
  assert.match(source, /disabledJobTypes: \[\s*\.\.\.\(target === "lineup-ready" \? \["score"\] : \[\]\),\s*\.\.\.stageOnlyJobTypes\s*\]/);
  assert.match(source, /if \(scenario === "lineup-ready"\) \{\s*await markManualLineupReadyScenario\(env\.AUTH_DB\);\s*await runPipeline\(env, \{ target: "lineup-ready" \}\);/);
});
