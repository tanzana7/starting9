import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v3 = await import(pathToFileURL(path.join(root, "game-automation-v3.js")).href);

test("V3 facade keeps the public automation contracts while implementation is modular", () => {
  for (const name of [
    "runGameAutomationV3",
    "planAuxiliaryJobs",
    "planMainWorkflowJobs",
    "claimDueJobs",
    "executeClaimedJobs",
    "listV3Games",
    "createV3Job",
    "deriveV3DisplaySchedule"
  ]) {
    assert.equal(typeof v3[name], "function", `${name} must remain available from the compatibility facade`);
  }
  const modules = ["constants", "domain", "planner", "probable-starter-planner", "repository", "roster-repository", "orchestrator", "executor", "audit", "diagnostics"];
  for (const name of modules) {
    assert.ok(fs.existsSync(path.join(root, `backend/automation-v3/${name}.js`)), `${name} module must exist`);
  }
});

test("V3 audit builders preserve structured data without performing D1 writes", () => {
  const record = v3.buildV3CronJobAuditInsert({
    auditColumns: new Set(["event_type", "data_status"]),
    runId: "run-1",
    correlationId: "run-1",
    job: {
      id: 42,
      internal_game_id: "8cd8869c-6ae5-47a5-8792-5bc89d20ef18",
      job_type: "roster_fetch",
      scheduled_slot_at: "2026-08-11T03:00:00.000Z",
      status: "completed",
      attempt_count: 1
    },
    execution: { stage: "executor_completed", dataStatus: "fresh" },
    occurredAt: new Date("2026-08-11T03:00:01.000Z")
  });

  assert.deepEqual(record.columns.slice(0, 2), ["event_type", "internal_game_id"]);
  assert.equal(record.values[0], "job");
  assert.equal(record.values[1], "8cd8869c-6ae5-47a5-8792-5bc89d20ef18");
  assert.equal(record.structuredDetails.stage, "executor_completed");
  assert.match(String(record.values.find((value) => typeof value === "string" && value.includes("v3_details="))), /run-1/);
});

test("V3 Cron diagnostics aggregate planner, claim, executor, and schedule-sync outcomes", () => {
  const summary = v3.buildV3CronSummary({
    runId: "run-2",
    correlationId: "run-2",
    startedAt: "2026-08-11T03:00:00.000Z",
    completedAt: "2026-08-11T03:00:03.000Z",
    result: {
      gameCount: 1,
      created: 1,
      failed: 0,
      probablePlan: { planned: [{ plan: { jobType: "probable_starter_fetch" }, created: true }] },
      rosterPlan: { planned: [{ plan: { jobType: "roster_fetch" }, created: false }] },
      identityPlan: { planned: [] },
      mainPlan: { planned: [] },
      claimReport: { due: [{}], claimed: [{ claimResult: "claimed" }] },
      processed: 1
    },
    scheduleSync: { status: "skipped", futureGamesBefore: 3, futureGamesAfter: 3, gamesFetched: 0, gamesInserted: 0, gamesUpdated: 0 }
  });

  assert.equal(summary.status, "completed");
  assert.equal(summary.counts.planned, 2);
  assert.equal(summary.counts.claimed, 1);
  assert.deepEqual(summary.createdByJobType, { probable_starter_fetch: 1 });
  assert.equal(summary.scheduleSync.futureGamesAfter, 3);
});

test("V3 automation modules have no V1/V2 runtime import", () => {
  const sources = fs.readdirSync(path.join(root, "backend/automation-v3"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => fs.readFileSync(path.join(root, "backend/automation-v3", file), "utf8"))
    .join("\n");
  assert.doesNotMatch(sources, /game-automation-v2|game-workflow-jobs|pregame-automation/);
});
