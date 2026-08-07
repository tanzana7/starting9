import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const client = fs.readFileSync(path.join(root, "script.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("V1/V2 runtime modules are physically absent and V3 has no legacy dependency", () => {
  assert.equal(fs.existsSync(path.join(root, "game-automation-v2.js")), false);
  assert.equal(fs.existsSync(path.join(root, "game-workflow-jobs.js")), false);
  for (const file of ["auth-worker.js", "game-automation-v3.js", "pregame-automation.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /game-automation-v2|AUTOMATION_V2_TIMING|game-workflow-jobs/);
  }
  assert.doesNotMatch(worker, /runScheduledGameAutomation\(|runGameWorkflows\(|runDueCompletionWorkflowJobs\(|runDuePregameAutomationJobs\(/);
});

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = end ? source.indexOf(end, from) : source.length;
  return source.slice(from, to === -1 ? source.length : to);
}

test("production scheduled entrypoint runs V3 only and disabled V3 does not fall back", () => {
  const scheduled = section(worker, "async scheduled(event, env, ctx)", "async function runScheduledGameAutomationV3");
  assert.match(scheduled, /isGameAutomationV3Enabled\(env\)/);
  assert.match(scheduled, /runScheduledGameAutomationV3\(env, scheduledAt\)/);
  assert.doesNotMatch(scheduled, /runScheduledGameAutomation\(/);
  assert.doesNotMatch(scheduled, /runGameWorkflows\(/);
});

test("legacy mutation URLs remain an explicit 410 contract", () => {
  assert.match(worker, /LEGACY_AUTOMATION_RETIRED_CODE/);
  assert.match(worker, /LEGACY_ADMIN_OPERATION_RETIRED_CODE/);
  assert.match(worker, /return legacyAdminOperationRetiredResponse\(cors\);/);
});

test("legacy admin mutation paths return the explicit retirement contract", () => {
  assert.match(worker, /LEGACY_ADMIN_OPERATION_RETIRED_CODE = "LEGACY_ADMIN_OPERATION_RETIRED"/);
  assert.match(worker, /LEGACY_ADMIN_OPERATION_RETIRED_MESSAGE = "この操作はGame Automation V3へ移行されました。"/);
  assert.match(worker, /return legacyAdminOperationRetiredResponse\(cors\);/);
  assert.match(worker, /}, 410, cors\);/);
  assert.match(worker, /V3管理API/);
});

test("V3 target and probable starter reader are UUID-only", () => {
  const target = section(worker, "async function loadV3GameTarget", "function createV3LineupIdentity");
  const probable = section(worker, "async function readProbableStarterRow", "async function recordProbableStarterDecision");
  const context = section(worker, "async function loadV3AdminContext", "function v3AdminErrorResponse");
  assert.match(target, /WHERE internal_game_id = \?1/);
  assert.match(target, /gameId: id/);
  assert.doesNotMatch(target, /game_identifiers/);
  assert.match(probable, /WHERE internal_game_id = \?1/);
  assert.doesNotMatch(probable, /WHERE game_id = \?1/);
  assert.doesNotMatch(context, /V3_LEGACY_REFERENCE_MISSING/);
  assert.match(context, /gameId: id/);
});

test("overview isolates probable-starter auxiliary failures", () => {
  const overview = section(worker, "async function handleAdminV3Overview", "async function handleAdminV3IdentityResolve");
  assert.match(overview, /V3_OVERVIEW_INTERNAL_ERROR/);
  assert.match(overview, /V3_PROBABLE_STARTER_SCHEMA_UNAVAILABLE/);
  assert.match(overview, /DATA_INTEGRITY_ERROR/);
  assert.match(overview, /auxiliaryErrors/);
  assert.match(overview, /lineupSummary/);
  assert.match(overview, /scoringSummary/);
  assert.match(overview, /publicationSummary/);
  assert.doesNotMatch(overview, /game\.gameId/);
});

test("normal client uses internalGameId for prediction and probable-starter APIs", () => {
  const probable = section(client, "function buildProbableStarterApiUrl", "function applyStoredProbableStarter");
  const current = section(client, "function buildCurrentPredictionApiUrl", "function getPredictionAccountUser");
  const deadline = section(client, "function getPredictionDeadlineGameId", "function parseJstScheduleDateTime");
  assert.match(probable, /internalGameId/);
  assert.doesNotMatch(probable, /legacyGameId/);
  assert.match(current, /internalGameId/);
  assert.match(deadline, /getCurrentGameId\(\)/);
  assert.match(deadline, /: getCurrentGameId\(\)/);
});

test("legacy admin screen is visibly read-only and points to V3", () => {
  assert.match(index, /legacyAdminReadOnlyNotice/);
  assert.match(index, /admin-v3\.html/);
  assert.match(client, /applyLegacyAdminReadOnlyMode\(adminDetails\)/);
  assert.match(client, /LEGACY_ADMIN_READ_ONLY_EVENT_IDS/);
  assert.match(client, /element\.closest\("#adminDetails"\)/);
  assert.match(client, /legacyAdminReadOnlyNotice/);
  assert.match(client, /read-only/);
});
