import assert from "node:assert/strict";
import test from "node:test";
import { getPublicationJobRecoveryEligibility, resolvePublicationTarget } from "../auth-worker.js";
import { recoverWorkflowJobForReevaluation } from "../game-workflow-jobs.js";
import { readFile } from "node:fs/promises";

const internalGameId = "12d554bb-ad25-44be-8159-0134c046dcee";
const legacyGameId = "2026-08-02-fighters-marines-1300";

function createDb({ conflictRows = [], schedule = null } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push({ sql, bindings: [] });
      const call = calls[calls.length - 1];
      return {
        bind(...bindings) {
          call.bindings = bindings;
          return this;
        },
        async first() {
          if (sql.includes("FROM game_workflow_state")) return { legacy_game_id: legacyGameId, game_status: "completed", workflow_status: "manual_intervention_required" };
          if (sql.includes("FROM games")) return { internal_game_id: internalGameId, game_date: "2026-08-02", start_time: "2026-08-02T04:00:00.000Z", home_team: "fighters", away_team: "marines", game_status: "completed" };
          if (sql.includes("FROM detected_game_schedule")) return schedule;
          return null;
        },
        async all() {
          if (sql.includes("FROM game_identifiers") && sql.includes("internal_game_id = ?1")) {
            return { results: [
              { provider: "schedule", identifier_type: "descriptive_game_id", identifier_value: legacyGameId },
              { provider: "schedule", identifier_type: "source_game_key", identifier_value: "2026-08-02:fighters:marines:13:00" }
            ] };
          }
          if (sql.includes("FROM game_identifiers") && sql.includes("internal_game_id <> ?1")) return { results: conflictRows };
          return { results: [] };
        },
        async run() { return { meta: { changes: 1 } }; }
      };
    }
  };
}

test("publication target resolves from internal UUID and games/identifiers without external schedule", async () => {
  const db = createDb();
  const target = await resolvePublicationTarget(db, internalGameId, legacyGameId);
  assert.equal(target.internalGameId, internalGameId);
  assert.equal(target.gameId, legacyGameId);
  assert.equal(target.startAt, "2026-08-02T04:00:00.000Z");
  assert.equal(target.targetResolution.externalScheduleRequired, false);
  assert.equal(target.targetResolution.npbGameCodePresent, false);
  assert.equal(db.calls.some((call) => /fetch|npb/i.test(call.sql)), false);
});

test("publication target rejects identifier conflicts", async () => {
  const db = createDb({ conflictRows: [{ internal_game_id: "other-game", provider: "schedule", identifier_type: "descriptive_game_id", identifier_value: legacyGameId }] });
  await assert.rejects(
    () => resolvePublicationTarget(db, internalGameId, legacyGameId),
    (error) => error.code === "PUBLICATION_TARGET_IDENTIFIER_CONFLICT"
  );
});

test("only the known permanently failed legacy publication error is eligible once", () => {
  const base = {
    jobType: "publication",
    status: "permanently_failed",
    errorCode: "SCHEDULE_UNAVAILABLE",
    errorDetail: "試合日程を確認できません。",
    scoringPersisted: true,
    rankingReflected: true,
    internalGameIdMatches: true,
    identifierConflict: false,
    attemptCount: 5,
    maxAttempts: 5
  };
  assert.equal(getPublicationJobRecoveryEligibility(base).eligible, true);
  assert.equal(getPublicationJobRecoveryEligibility({ ...base, errorCode: "PUBLICATION_TARGET_INVALID" }).eligible, false);
  assert.equal(getPublicationJobRecoveryEligibility({ ...base, publishedAt: "2026-08-03T01:00:00.000Z" }).eligible, false);
  assert.equal(getPublicationJobRecoveryEligibility({ ...base, scoreResultCount: 2 }).eligible, false);
  assert.equal(getPublicationJobRecoveryEligibility({ ...base, identifierConflict: true }).eligible, false);
  assert.equal(getPublicationJobRecoveryEligibility({ ...base, attemptCount: 4 }).eligible, false);
});

test("permanently failed recovery keeps the attempt count and requires exact job type/error", async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      calls.push(sql);
      return {
        bind() { return this; },
        async run() { return { meta: { changes: 1 } }; }
      };
    }
  };
  const result = await recoverWorkflowJobForReevaluation(db, {
    jobId: 539,
    expectedStatus: "permanently_failed",
    expectedJobType: "publication",
    expectedErrorCode: "SCHEDULE_UNAVAILABLE",
    expectedErrorDetail: "試合日程を確認できません。"
  });
  assert.equal(result.recovered, true);
  assert.match(calls[0], /job_type = \?8/);
  assert.match(calls[0], /attempt_count = max_attempts/);
  assert.doesNotMatch(calls[0], /attempt_count\s*=\s*0/);
});

test("publication executor no longer treats static schedule as its target resolver", async () => {
  const worker = await readFile(new URL("../auth-worker.js", import.meta.url), "utf8");
  const start = worker.indexOf("async function publishGameResults");
  const end = worker.indexOf("async function markGameRankingIneligible", start);
  const publication = worker.slice(start, end);
  assert.match(publication, /resolvePublicationTarget/);
  assert.match(publication, /PUBLICATION_PREREQUISITE_MISSING/);
  assert.doesNotMatch(publication, /throw createPregameError\("SCHEDULE_UNAVAILABLE"/);
  assert.match(worker, /PUBLICATION_LEGACY_SCHEDULE_ERROR_REEVALUATION/);
  assert.match(worker, /publicationTargetResolution/);
  assert.match(worker, /stalePregameErrorIgnored/);
});
