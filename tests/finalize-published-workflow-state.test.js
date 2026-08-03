import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  getPregameAuxiliaryStateReconciliation,
  getPublicationWorkflowReconciliationEligibility
} from "../auth-worker.js";
import {
  reconcilePersistedPublicationJob,
  recoverWorkflowJobForReevaluation
} from "../game-workflow-jobs.js";

const authWorker = fs.readFileSync(new URL("../auth-worker.js", import.meta.url), "utf8");

function createFakeDb(changes = 1) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...bindings) {
          calls.push({ sql, bindings });
          return { run: async () => ({ meta: { changes } }) };
        }
      };
    }
  };
}

test("公開済みデータがありworkflowだけ遅れている場合は再公開せず整合対象になる", () => {
  assert.deepEqual(
    getPublicationWorkflowReconciliationEligibility({
      workflowStatus: "scored_private",
      publicationStatus: "published",
      publishedAt: "2026-08-03T01:20:00.000Z",
      finalLineupScored: true,
      rankingReflected: true,
      internalGameIdMatches: true
    }),
    { eligible: true, reasonCode: "PUBLICATION_PERSISTED_WORKFLOW_BEHIND" }
  );
  const start = authWorker.indexOf("async function reconcilePersistedPublicationWorkflows");
  const end = authWorker.indexOf("async function reconcilePregameAutomationState", start);
  assert.doesNotMatch(authWorker.slice(start, end), /publishScoredGameResults/);
});

test("公開整合は未採点、競合、terminal workflowを対象外にする", () => {
  for (const input of [
    { finalLineupScored: false, rankingReflected: true, internalGameIdMatches: true, publicationStatus: "published", publishedAt: "x", workflowStatus: "scored_private", reasonCode: "PUBLICATION_SCORING_REQUIRED" },
    { finalLineupScored: true, rankingReflected: true, internalGameIdMatches: false, publicationStatus: "published", publishedAt: "x", workflowStatus: "scored_private", reasonCode: "PUBLICATION_INTERNAL_ID_MISMATCH" },
    { finalLineupScored: true, rankingReflected: true, internalGameIdMatches: true, identifierConflict: true, publicationStatus: "published", publishedAt: "x", workflowStatus: "scored_private", reasonCode: "PUBLICATION_IDENTIFIER_CONFLICT" },
    { finalLineupScored: true, rankingReflected: true, internalGameIdMatches: true, publicationStatus: "published", publishedAt: "x", workflowStatus: "manual_intervention_required", reasonCode: "PUBLICATION_WORKFLOW_STATE_NOT_RECONCILABLE" }
  ]) {
    const result = getPublicationWorkflowReconciliationEligibility(input);
    assert.equal(result.eligible, false);
    assert.equal(result.reasonCode, input.reasonCode);
  }
});

test("採点済みで補助テーブルだけpendingかつ古い日程エラーなら整合対象になる", () => {
  assert.equal(getPregameAuxiliaryStateReconciliation({
    internalGameId: "internal-1",
    rowInternalGameId: "internal-1",
    scoringStatus: "pending",
    workflowStatus: "scored_private",
    publicationStatus: "scored_private",
    rankingReflected: true,
    currentErrorCode: "SCHEDULE_UNAVAILABLE",
    activeErrorCodes: []
  }).eligible, true);
  assert.equal(getPregameAuxiliaryStateReconciliation({
    internalGameId: "internal-1",
    rowInternalGameId: "internal-1",
    scoringStatus: "pending",
    workflowStatus: "scored_private",
    rankingReflected: true,
    currentErrorCode: "SCHEDULE_UNAVAILABLE",
    activeErrorCodes: ["SCHEDULE_UNAVAILABLE"]
  }).reasonCode, "PREGAME_SCHEDULE_ERROR_STILL_ACTIVE");
});

test("公開済みjobの整合更新はpublication限定でattemptを変更しない", async () => {
  const db = createFakeDb(1);
  const result = await reconcilePersistedPublicationJob(db, {
    jobId: 539,
    expectedStatus: "claimed",
    now: new Date("2026-08-03T02:00:00.000Z")
  });
  assert.equal(result.reconciled, true);
  assert.match(db.calls[0].sql, /job_type = 'publication'/);
  assert.doesNotMatch(db.calls[0].sql, /attempt_count\s*=/);
});

test("期限切れpublication claimの回収はjob種別を限定しattemptを増やさない", async () => {
  const db = createFakeDb(1);
  const result = await recoverWorkflowJobForReevaluation(db, {
    jobId: 539,
    expectedStatus: "claimed",
    expectedJobType: "publication",
    now: new Date("2026-08-03T02:00:00.000Z")
  });
  assert.equal(result.recovered, true);
  assert.match(db.calls[0].sql, /\(\?8 = '' OR job_type = \?8\)/);
  assert.doesNotMatch(db.calls[0].sql, /attempt_count\s*=\s*attempt_count\s*\+/);
});

test("管理監査とreadinessは公開job・公開時刻・補助状態整合を返せる", () => {
  assert.match(authWorker, /publicationWorkflow/);
  assert.match(authWorker, /currentPublicationWorkflow/);
  assert.match(authWorker, /publicationWorkflowBehindCount/);
  assert.match(authWorker, /pregame_auxiliary_state_reconciled/);
  assert.match(authWorker, /PUBLICATION_PERSISTED_WORKFLOW_BEHIND/);
});

test("completion runnerは公開整合後に通常jobを二重実行しない", () => {
  assert.match(authWorker, /shouldSkipPublicationWorkflowJob/);
  assert.match(authWorker, /due\.job_type === "publication"/);
  assert.match(authWorker, /reconcilePersistedPublicationWorkflows\(env, now\)/);
});
