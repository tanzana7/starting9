import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getScoringPersistenceReconciliationEligibility,
  getWorkflowJobErrorCode,
  isCompletionWorkflowErrorRetryable
} from "../auth-worker.js";
import { reconcilePersistedScoringJob } from "../game-workflow-jobs.js";

const worker = await readFile(new URL("../auth-worker.js", import.meta.url), "utf8");
const transitionErrorDetail = "試合進行状態を final_lineup_captured から scored_private へ変更できません。";

test("状態遷移失敗は採点データ検証失敗と区別される", () => {
  assert.equal(getWorkflowJobErrorCode({ code: "WORKFLOW_TRANSITION_INVALID", message: transitionErrorDetail }), "WORKFLOW_STATE_TRANSITION_FAILED");
  assert.equal(getWorkflowJobErrorCode({ code: "prediction_validation_failed" }), "DATA_VALIDATION_FAILED");
  assert.equal(isCompletionWorkflowErrorRetryable({ code: "WORKFLOW_STATE_TRANSITION_FAILED" }, "WORKFLOW_STATE_TRANSITION_FAILED"), false);
});

test("採点済み結果がありworkflowだけ遅れている場合だけ整合対象になる", () => {
  const eligible = getScoringPersistenceReconciliationEligibility({
    workflowStatus: "manual_intervention_required",
    workflowErrorCode: "DATA_VALIDATION_FAILED",
    workflowErrorDetail: transitionErrorDetail,
    scoringStatus: "scored",
    scoredAt: "2026-08-03T00:14:52.000Z",
    finalLineupExists: true,
    scoreResultExists: true,
    scoreResultCount: 1,
    publicationStatus: "pending",
    internalGameIdMatches: true
  });
  assert.equal(eligible.reconciliationEligible, true);
  assert.equal(eligible.reasonCode, "SCORING_PERSISTED_WORKFLOW_BEHIND");
  assert.equal(eligible.scoringJobRecoveryMode, "persisted_result_adoption");

  const ordinaryManualFailure = getScoringPersistenceReconciliationEligibility({
    workflowStatus: "manual_intervention_required",
    workflowErrorCode: "DATA_VALIDATION_FAILED",
    workflowErrorDetail: "stored predictions include validation errors",
    scoringStatus: "scored",
    scoredAt: "2026-08-03T00:14:52.000Z",
    finalLineupExists: true,
    scoreResultExists: true,
    scoreResultCount: 1
  });
  assert.equal(ordinaryManualFailure.reconciliationEligible, false);
  assert.equal(ordinaryManualFailure.reconciliationBlockedReason, "MANUAL_INTERVENTION_NOT_STATE_TRANSITION");
});

test("採点結果・スタメン・識別子が安全条件を満たさない場合は復旧しない", () => {
  const noLineup = getScoringPersistenceReconciliationEligibility({
    workflowStatus: "final_lineup_captured",
    scoringStatus: "scored",
    scoredAt: "2026-08-03T00:14:52.000Z",
    scoreResultExists: true,
    scoreResultCount: 1,
    finalLineupExists: false
  });
  assert.equal(noLineup.reconciliationEligible, false);
  assert.equal(noLineup.reconciliationBlockedReason, "FINAL_LINEUP_REQUIRED");

  const duplicateResults = getScoringPersistenceReconciliationEligibility({
    workflowStatus: "final_lineup_captured",
    scoringStatus: "scored",
    scoredAt: "2026-08-03T00:14:52.000Z",
    finalLineupExists: true,
    scoreResultExists: true,
    scoreResultCount: 2
  });
  assert.equal(duplicateResults.reconciliationEligible, false);
  assert.equal(duplicateResults.reconciliationBlockedReason, "SCORING_RESULT_COUNT_INVALID");

  const conflictingIdentifier = getScoringPersistenceReconciliationEligibility({
    workflowStatus: "final_lineup_captured",
    scoringStatus: "scored",
    scoredAt: "2026-08-03T00:14:52.000Z",
    finalLineupExists: true,
    scoreResultExists: true,
    scoreResultCount: 1,
    identifierConflict: true
  });
  assert.equal(conflictingIdentifier.reconciliationEligible, false);
  assert.equal(conflictingIdentifier.reconciliationBlockedReason, "GAME_IDENTIFIER_CONFLICT");
});

function createJobDb(job) {
  return {
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async run() {
              assert.match(sql, /SET status = 'succeeded'/);
              const [completedAt, metadata, jobId, expectedStatus, expectedCode, expectedDetail] = bindings;
              const matches = job.id === jobId
                && job.job_type === "scoring"
                && job.status === expectedStatus
                && job.error_code === expectedCode
                && job.error_detail === expectedDetail
                && job.completed_at !== null;
              if (!matches) return { meta: { changes: 0 } };
              Object.assign(job, {
                status: "succeeded",
                completed_at: completedAt,
                error_code: null,
                error_detail: null,
                result_metadata: metadata
              });
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
}

test("永久失敗のscoring jobは結果を再計算せず成功相当へ一度だけ整合できる", async () => {
  const job = {
    id: 411,
    job_type: "scoring",
    status: "permanently_failed",
    error_code: "DATA_VALIDATION_FAILED",
    error_detail: transitionErrorDetail,
    completed_at: "2026-08-03T00:15:00.000Z"
  };
  const db = createJobDb(job);
  const first = await reconcilePersistedScoringJob(db, {
    jobId: 411,
    expectedErrorCode: job.error_code,
    expectedErrorDetail: job.error_detail,
    resultMetadata: { recoveryMode: "persisted_result_adoption" },
    now: new Date("2026-08-03T00:30:00.000Z")
  });
  const second = await reconcilePersistedScoringJob(db, {
    jobId: 411,
    expectedErrorCode: "DATA_VALIDATION_FAILED",
    expectedErrorDetail: transitionErrorDetail,
    now: new Date("2026-08-03T00:31:00.000Z")
  });
  assert.equal(first.reconciled, true);
  assert.equal(second.reconciled, false);
  assert.equal(job.status, "succeeded");
});

test("reconciliationは採点executorを呼ばず、ranking反映済みならpublicationへ進める", () => {
  const start = worker.indexOf("async function reconcilePersistedScoringWorkflows");
  const end = worker.indexOf("async function reconcileCompletionWorkflowJobs", start);
  const source = worker.slice(start, end);
  assert.doesNotMatch(source, /scoreClaimedGameLineup|prepareGamePredictionScoring/);
  assert.match(source, /reconcilePersistedScoringJob/);
  assert.match(source, /ranking\.reflected/);
  assert.match(source, /publication/);
  assert.match(worker, /await ensureWorkflowScoringPending\(env\.AUTH_DB, job\.internal_game_id, now\)/);
  assert.match(worker, /scoringPersistenceState/);
  assert.match(worker, /rankingJobExists/);
  assert.match(worker, /publicationJobExists/);
});
