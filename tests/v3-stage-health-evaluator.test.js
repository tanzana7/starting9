import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateV35Automation,
  V35_EFFECTIVE_STATE,
  V35_STAGE_HEALTH
} from "../backend/automation-v3/stage-health-evaluator.js";

const NOW = new Date("2026-08-23T06:00:00.000Z");
const GAME_ID = "11111111-1111-4111-8111-111111111111";

function stage(stageName, overrides = {}) {
  return {
    [stageName]: {
      dueAt: NOW.toISOString(),
      ...overrides
    }
  };
}

function job(stageName, status, overrides = {}) {
  return {
    id: `${stageName}-${status}`,
    stageName,
    status,
    scheduledSlotAt: NOW.toISOString(),
    internalGameId: GAME_ID,
    ...overrides
  };
}

function artifact(overrides = {}) {
  return { available: true, valid: true, fresh: true, source: "test", ...overrides };
}

function evaluate(input = {}) {
  return evaluateV35Automation({
    internalGameId: GAME_ID,
    currentTime: NOW,
    persistedWorkflowState: "scheduled",
    ...input
  });
}

test("cancelled game has priority over every stage and cannot recover", () => {
  const result = evaluate({ gameStatus: "cancelled", stageDefinitions: stage("roster_fetch") });
  assert.equal(result.effectiveState, V35_EFFECTIVE_STATE.CANCELLED);
  for (const health of Object.values(result.stages)) {
    assert.equal(health.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_CANCELLED);
    assert.equal(health.recoveryRecommended, false);
  }
});

test("published artifact advances effective state over persisted scheduled", () => {
  const result = evaluate({
    artifacts: { publish: artifact() }
  });
  assert.equal(result.effectiveState, V35_EFFECTIVE_STATE.PUBLISHED);
  assert.equal(result.persistedState, "scheduled");
  assert.equal(result.stateMismatch, true);
});

test("completed prediction close with a valid marker exposes persisted state mismatch", () => {
  const result = evaluate({
    stageDefinitions: stage("prediction_close"),
    jobs: [job("prediction_close", "completed")],
    artifacts: { prediction_close: artifact({ reason: null }) }
  });
  assert.equal(result.stages.prediction_close.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY);
  assert.equal(result.effectiveState, V35_EFFECTIVE_STATE.PREDICTION_CLOSED);
  assert.equal(result.stateMismatch, true);
});

test("schedule_registered is equivalent to persisted scheduled and marks registration complete", () => {
  const result = evaluate({ scheduleRegistered: true });
  assert.equal(result.effectiveState, V35_EFFECTIVE_STATE.SCHEDULE_REGISTERED);
  assert.equal(result.persistedState, "scheduled");
  assert.equal(result.stateMismatch, false);
  assert.equal(result.stages.schedule_registration.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY);
});

test("future stages stay not due instead of reporting prerequisite blockers", () => {
  const future = "2026-08-23T07:00:00.000Z";
  const result = evaluate({
    stageDefinitions: {
      lineup_fetch: { dueAt: future, prerequisiteMet: false, prerequisiteReason: "PREDICTION_CLOSE_STATE_GATE" },
      scoring: { dueAt: future, prerequisiteMet: false, prerequisiteReason: "LINEUP_FINALIZE_ARTIFACT_MISSING" }
    }
  });
  assert.equal(result.stages.lineup_fetch.healthStatus, V35_STAGE_HEALTH.NOT_DUE);
  assert.equal(result.stages.lineup_fetch.blockingReason, null);
  assert.equal(result.stages.scoring.healthStatus, V35_STAGE_HEALTH.NOT_DUE);
  assert.equal(result.stages.scoring.blockingReason, null);
});

test("due stage still reports a missing prerequisite as blocked", () => {
  const result = evaluate({
    stageDefinitions: {
      scoring: { dueAt: NOW.toISOString(), prerequisiteMet: false, prerequisiteReason: "LINEUP_FINALIZE_ARTIFACT_MISSING" }
    }
  });
  assert.equal(result.stages.scoring.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE);
  assert.equal(result.stages.scoring.blockingReason, "LINEUP_FINALIZE_ARTIFACT_MISSING");
});

test("due slot without a job is a missing job and recommends recovery", () => {
  const result = evaluate({ stageDefinitions: stage("roster_fetch") });
  const health = result.stages.roster_fetch;
  assert.equal(health.healthStatus, V35_STAGE_HEALTH.MISSING_JOB);
  assert.equal(health.recoveryRecommended, true);
  assert.equal(health.recoveryReason, "MISSING_DUE_JOB");
});

test("terminal failed job recommends bounded recovery", () => {
  const result = evaluate({
    stageDefinitions: stage("roster_fetch"),
    jobs: [job("roster_fetch", "failed", { failureCode: "HTTP_ERROR" })]
  });
  const health = result.stages.roster_fetch;
  assert.equal(health.healthStatus, V35_STAGE_HEALTH.TERMINAL_FAILED);
  assert.equal(health.recoveryRecommended, true);
  assert.equal(health.recoveryReason, "TERMINAL_FAILED");
  assert.equal(health.blockingReason, "HTTP_ERROR");
});

test("expired retry wait is due for recovery", () => {
  const result = evaluate({
    stageDefinitions: stage("roster_fetch"),
    jobs: [job("roster_fetch", "retry_wait", { nextRetryAt: "2026-08-23T05:59:00.000Z" })]
  });
  assert.equal(result.stages.roster_fetch.healthStatus, V35_STAGE_HEALTH.RETRY_WAIT_DUE);
  assert.equal(result.stages.roster_fetch.recoveryRecommended, true);
});

test("completed job without an artifact is not successful", () => {
  const result = evaluate({
    stageDefinitions: stage("roster_fetch"),
    jobs: [job("roster_fetch", "completed")]
  });
  const health = result.stages.roster_fetch;
  assert.equal(health.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_MISSING);
  assert.equal(health.recoveryRecommended, true);
});

test("completed job with a valid artifact is ready and has no recovery", () => {
  const result = evaluate({
    stageDefinitions: stage("roster_fetch"),
    jobs: [job("roster_fetch", "completed")],
    artifacts: { roster_fetch: artifact() }
  });
  const health = result.stages.roster_fetch;
  assert.equal(health.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY);
  assert.equal(health.recoveryRecommended, false);
  assert.deepEqual(health.artifactHealth, {
    available: true,
    valid: true,
    fresh: true,
    source: "test",
    capturedAt: null,
    fingerprint: null,
    verificationStatus: "verified",
    internalGameId: GAME_ID,
    rowCount: null,
    reason: null,
    blockingReason: null,
    nextSafeAction: "no_op"
  });
});

test("a missing selected roster slot does not fall back to another slot", () => {
  const result = evaluate({
    stageDefinitions: {
      roster_fetch: {
        dueAt: NOW.toISOString(),
        selectedSlot: "2026-08-23T06:10:00.000Z"
      }
    },
    jobs: [job("roster_fetch", "completed", {
      scheduledSlotAt: "2026-08-23T06:00:00.000Z"
    })],
    artifacts: { roster_fetch: artifact() }
  });
  assert.equal(result.stages.roster_fetch.job, null);
  assert.equal(result.stages.roster_fetch.healthStatus, V35_STAGE_HEALTH.MISSING_JOB);
  assert.equal(result.stages.roster_fetch.recoveryReason, "MISSING_DUE_JOB");
});

test("lineup candidate/canonical health is represented before finalization", () => {
  const result = evaluate({
    stageDefinitions: stage("lineup_fetch"),
    jobs: [job("lineup_fetch", "completed")],
    artifacts: { lineup_fetch: artifact({ source: "official" }) }
  });
  assert.equal(result.effectiveState, V35_EFFECTIVE_STATE.LINEUP_DATA_READY);
});

test("external fetch disabled blocks a stage without planning recovery", () => {
  const result = evaluate({
    stageDefinitions: stage("roster_fetch", { externalFetchDisabled: true })
  });
  const health = result.stages.roster_fetch;
  assert.equal(health.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_EXTERNAL_FETCH_DISABLED);
  assert.equal(health.recoveryRecommended, false);
});

test("missing roster snapshot is visible in artifact health", () => {
  const result = evaluate({
    stageDefinitions: stage("roster_fetch"),
    jobs: [job("roster_fetch", "completed")],
    artifacts: {
      roster_fetch: {
        available: false,
        valid: false,
        reason: "ROSTER_SNAPSHOT_MISSING"
      }
    }
  });
  assert.equal(result.stages.roster_fetch.artifactHealth.reason, "ROSTER_SNAPSHOT_MISSING");
  assert.equal(result.stages.roster_fetch.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_MISSING);
});

test("scoring is blocked when finalized lineup artifact is missing", () => {
  const result = evaluate({
    stageDefinitions: stage("scoring"),
    artifacts: { lineup_finalize: { available: false, valid: false } }
  });
  const health = result.stages.scoring;
  assert.equal(health.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE);
  assert.equal(health.blockingReason, "LINEUP_FINALIZE_ARTIFACT_MISSING");
  assert.equal(health.recoveryRecommended, false);
});

test("ranking excluded games block ranking and publication as no-ops", () => {
  const result = evaluate({
    rankingExcluded: true,
    stageDefinitions: { ...stage("ranking_reflect"), ...stage("publish") }
  });
  assert.equal(result.effectiveState, V35_EFFECTIVE_STATE.SCHEDULED);
  assert.equal(result.stages.ranking_reflect.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE);
  assert.equal(result.stages.publish.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE);
  assert.equal(result.stages.ranking_reflect.blockingReason, "RANKING_EXCLUDED");
  assert.equal(result.stages.publish.nextSafeAction, "no_op");
});

test("state mismatch is detected without rewriting persisted state", () => {
  const input = {
    persistedWorkflowState: "scheduled",
    stageDefinitions: stage("publish"),
    jobs: [job("publish", "completed")],
    artifacts: { publish: artifact() }
  };
  const result = evaluate(input);
  assert.equal(result.persistedState, "scheduled");
  assert.equal(result.effectiveState, "published");
  assert.equal(result.stateMismatch, true);
  assert.equal(input.persistedWorkflowState, "scheduled");
});

test("the evaluator does not call injected write or job creation functions", () => {
  const failIfCalled = () => { throw new Error("side effect called"); };
  const result = evaluate({
    createJob: failIfCalled,
    writeState: failIfCalled,
    db: { prepare: failIfCalled },
    stageDefinitions: stage("roster_fetch")
  });
  assert.equal(result.stages.roster_fetch.healthStatus, V35_STAGE_HEALTH.MISSING_JOB);
});
