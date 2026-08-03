import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getHistoricalWorkflowRecoveryEligibility } from "../auth-worker.js";
import { recoverWorkflowJobForReevaluation } from "../game-workflow-jobs.js";

const internalGameId = "12d554bb-ad25-44be-8159-0134c046dcee";
const now = new Date("2026-08-03T00:30:00.000Z");
const targetValidationDetail = "試合進行ジョブの対象試合が無効です。";
const worker = await readFile(new URL("../auth-worker.js", import.meta.url), "utf8");

function createRecoveryDb(job) {
  return {
    job,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async run() {
              if (!sql.includes("SET status = 'pending'")) throw new Error("Unexpected write");
              const [timestamp, recoveryTime, metadata, jobId, expectedStatus, expectedErrorCode, expectedErrorDetail] = bindings;
              const matchesBase = job.id === jobId
                && job.status === expectedStatus
                && !job.completed_at
                && job.attempt_count < job.max_attempts;
              const matchesClaim = expectedStatus === "claimed"
                && job.lease_expires_at
                && job.lease_expires_at <= recoveryTime;
              const matchesLegacyRetry = expectedStatus === "retry_wait"
                && job.error_code === expectedErrorCode
                && job.error_detail === expectedErrorDetail;
              if (!matchesBase || (!matchesClaim && !matchesLegacyRetry)) return { meta: { changes: 0 } };
              Object.assign(job, {
                status: "pending",
                claim_token: null,
                claimed_at: null,
                started_at: null,
                lease_expires_at: null,
                next_attempt_at: null,
                completed_at: null,
                error_code: null,
                error_detail: null,
                result_metadata: metadata,
                updated_at: timestamp
              });
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
}

function finalJob(overrides = {}) {
  return {
    id: 51,
    internal_game_id: internalGameId,
    jobType: "final_lineup_fetch",
    status: "claimed",
    leaseExpiresAt: "2026-08-03T00:19:52.000Z",
    attemptCount: 56,
    maxAttempts: 72,
    ...overrides
  };
}

function recoveryInput(job, overrides = {}) {
  return {
    job,
    workflowStatus: "retrying",
    gameStatus: "scheduled",
    gameDate: "2026-08-02",
    startAt: "2026-08-02T04:00:00.000Z",
    lineupRows: [],
    now,
    ...overrides
  };
}

test("期限切れclaimed final jobだけを48時間のhistorical recovery対象にする", () => {
  const eligible = getHistoricalWorkflowRecoveryEligibility(recoveryInput(finalJob()));
  assert.equal(eligible.staleLeaseDetected, true);
  assert.equal(eligible.eligibleForRecovery, true);
  assert.equal(eligible.recoveryReasonCode, "STALE_CLAIM_RECOVERY");
  assert.equal(eligible.reconciliationScope.inWindow, true);

  const activeLease = getHistoricalWorkflowRecoveryEligibility(recoveryInput(finalJob({ leaseExpiresAt: "2026-08-03T00:35:00.000Z" })));
  assert.equal(activeLease.eligibleForRecovery, false);
  assert.equal(activeLease.recoveryBlockedReason, "LEASE_STILL_ACTIVE");

  const tooOld = getHistoricalWorkflowRecoveryEligibility(recoveryInput(finalJob(), {
    gameDate: "2026-07-31",
    startAt: "2026-07-31T04:00:00.000Z"
  }));
  assert.equal(tooOld.eligibleForRecovery, false);
  assert.equal(tooOld.recoveryBlockedReason, "OUTSIDE_HISTORICAL_RECOVERY_SCOPE");
});

test("回収はattemptCountを増やさず、同じstale claimを二重回収しない", async () => {
  const db = createRecoveryDb({
    id: 51,
    status: "claimed",
    lease_expires_at: "2026-08-03T00:19:52.000Z",
    attempt_count: 56,
    max_attempts: 72,
    completed_at: null
  });
  const [first, second] = await Promise.all([
    recoverWorkflowJobForReevaluation(db, { jobId: 51, expectedStatus: "claimed", now }),
    recoverWorkflowJobForReevaluation(db, { jobId: 51, expectedStatus: "claimed", now })
  ]);
  assert.equal(Number(first.recovered) + Number(second.recovered), 1);
  assert.equal(db.job.status, "pending");
  assert.equal(db.job.attempt_count, 56);
  assert.equal(db.job.lease_expires_at, null);
});

test("旧target validationだけをfinal jobとして一度再評価し、parser失敗とprovisionalは除外する", () => {
  const legacy = finalJob({
    status: "retry_wait",
    errorCode: "DATA_VALIDATION_FAILED",
    errorDetail: targetValidationDetail,
    retryable: false,
    validation: {}
  });
  const eligible = getHistoricalWorkflowRecoveryEligibility(recoveryInput(legacy));
  assert.equal(eligible.eligibleForRecovery, true);
  assert.equal(eligible.recoveryReasonCode, "LEGACY_TARGET_VALIDATION_REEVALUATION");

  const parserFailure = getHistoricalWorkflowRecoveryEligibility(recoveryInput(finalJob({
    status: "retry_wait",
    errorCode: "DATA_VALIDATION_FAILED",
    errorDetail: targetValidationDetail,
    retryable: false,
    parseStage: "official_lineup",
    validation: { parsedCount: 8 }
  })));
  assert.equal(parserFailure.eligibleForRecovery, false);
  assert.equal(parserFailure.recoveryBlockedReason, "LEGACY_ERROR_NOT_ELIGIBLE");

  const provisional = getHistoricalWorkflowRecoveryEligibility(recoveryInput(legacy, {
    job: { ...legacy, jobType: "provisional_lineup_fetch", id: 1 }
  }));
  assert.equal(provisional.eligibleForRecovery, false);
  assert.equal(provisional.recoveryBlockedReason, "FINAL_LINEUP_JOB_REQUIRED");
});

test("対象限定の旧retry_waitは同じエラー条件でだけpendingへ戻す", async () => {
  const db = createRecoveryDb({
    id: 51,
    status: "retry_wait",
    error_code: "DATA_VALIDATION_FAILED",
    error_detail: targetValidationDetail,
    attempt_count: 56,
    max_attempts: 72,
    completed_at: null
  });
  const recovered = await recoverWorkflowJobForReevaluation(db, {
    jobId: 51,
    expectedStatus: "retry_wait",
    expectedErrorCode: "DATA_VALIDATION_FAILED",
    expectedErrorDetail: targetValidationDetail,
    now
  });
  assert.equal(recovered.recovered, true);
  assert.equal(db.job.status, "pending");
  assert.equal(db.job.attempt_count, 56);
});

test("historical recoveryはfinalを優先し、provisionalを停止して既存のscoring連鎖へ渡す", () => {
  assert.match(worker, /async function reconcileHistoricalCompletionWorkflowJobs/);
  assert.match(worker, /job_type = 'final_lineup_fetch'/);
  assert.match(worker, /cancelSupersededLineupJobsWithDetails/);
  assert.match(worker, /recoveredJobIds/);
  assert.match(worker, /final_lineup_fetch: "scoring"/);
  assert.match(worker, /staleLeaseDetected: recoveryAudit\.staleLeaseDetected/);
  assert.match(worker, /recoveryBlockedReason: recoveryAudit\.recoveryBlockedReason/);
  assert.match(worker, /retryable,\s*nextAttemptAt,/);
});
