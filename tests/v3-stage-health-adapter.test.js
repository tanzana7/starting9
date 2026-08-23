import test from "node:test";
import assert from "node:assert/strict";
import { adaptV35Input } from "../backend/automation-v3/stage-health-adapter.js";
import { evaluateV35Automation, V35_EFFECTIVE_STATE, V35_STAGE_HEALTH } from "../backend/automation-v3/stage-health-evaluator.js";

const NOW = new Date("2026-08-23T06:00:00.000Z");
const GAME_ID = "22222222-2222-4222-8222-222222222222";

function evaluateAdapter(input) {
  const adapted = adaptV35Input({ ...input, now: NOW });
  return { adapted, evaluated: evaluateV35Automation(adapted.evaluatorInput) };
}

function job(jobType, status, overrides = {}) {
  return {
    id: `${jobType}-${status}`,
    internal_game_id: GAME_ID,
    job_type: jobType,
    scheduled_slot_at: NOW.toISOString(),
    status,
    ...overrides
  };
}

test("adapts a prediction-close gate incident without changing runtime state", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: {
      internalGameId: GAME_ID,
      gameStatus: "scheduled",
      workflowState: "scheduled",
      startAt: "2026-08-23T08:00:00.000Z"
    },
    jobs: [
      job("prediction_close", "failed", {
        scheduled_slot_at: "2026-08-23T05:00:00.000Z",
        failure_code: "V3_JOB_FAILED",
        failed_at: NOW.toISOString()
      }),
      job("lineup_fetch", "pending", { scheduled_slot_at: "2026-08-23T06:10:00.000Z" })
    ],
    diagnostics: {
      predictionClose: { deadlineAt: "2026-08-23T05:00:00.000Z" },
      lineupFetch: {
        dueAt: "2026-08-23T06:10:00.000Z",
        blockingReasonCode: "PREDICTION_CLOSE_STATE_GATE"
      }
    }
  });
  assert.equal(adapted.evaluatorInput.persistedWorkflowState, "scheduled");
  assert.equal(adapted.evaluatorInput.jobs[0].failureCode, "V3_JOB_FAILED");
  assert.equal(evaluated.stages.prediction_close.healthStatus, V35_STAGE_HEALTH.TERMINAL_FAILED);
  assert.equal(evaluated.stages.prediction_close.recoveryRecommended, true);
  assert.equal(evaluated.stages.lineup_fetch.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE);
  assert.equal(evaluated.stages.lineup_fetch.nextSafeAction, "wait_for_prerequisite");
});

test("adapts cancelled game priority and suppresses recovery for open jobs", () => {
  const { evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "cancelled", workflowState: "excluded" },
    jobs: [
      job("prediction_close", "pending"),
      job("lineup_fetch", "pending")
    ],
    diagnostics: {}
  });
  assert.equal(evaluated.effectiveState, V35_EFFECTIVE_STATE.CANCELLED);
  for (const stage of Object.values(evaluated.stages)) {
    assert.equal(stage.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_CANCELLED);
    assert.equal(stage.recoveryRecommended, false);
  }
});

test("keeps public official-live usability separate from a missing formal roster snapshot", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "scheduled" },
    artifacts: {
      roster_fetch: {
        source: "latest_official_live",
        verificationStatus: "verified",
        canonicalSnapshotAvailable: false
      }
    },
    diagnostics: { roster: { dueAt: NOW.toISOString() } }
  });
  const roster = adapted.evaluatorInput.artifacts.roster_fetch;
  assert.equal(roster.publicUsable, true);
  assert.equal(roster.publicSource, "latest_official_live");
  assert.equal(roster.canonicalSnapshotAvailable, false);
  assert.equal(evaluated.stages.roster_fetch.artifactHealth.reason, "ROSTER_SNAPSHOT_MISSING");
  assert.equal(evaluated.stages.roster_fetch.artifactHealth.nextSafeAction, "roster_fetch");
  assert.ok(adapted.warnings.some(({ code }) => code === "PUBLIC_ROSTER_WITHOUT_FORMAL_SNAPSHOT"));
});

test("adapts completed lineup fetch without candidate as missing artifact", () => {
  const { evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "prediction_closed" },
    jobs: [job("lineup_fetch", "completed")],
    diagnostics: {
      lineupFetch: {
        dueAt: NOW.toISOString(),
        artifactStatus: {
          available: true,
          ready: false,
          candidateExists: false,
          canonicalDataReady: false,
          reason: "LINEUP_FETCH_COMPLETED_WITHOUT_CANDIDATE"
        }
      }
    }
  });
  assert.equal(evaluated.stages.lineup_fetch.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_MISSING);
  assert.equal(evaluated.stages.lineup_fetch.recoveryRecommended, true);
});

test("adapts external fetch disabled into a blocked roster stage", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "scheduled" },
    externalFlags: { NPB_FETCH_DISABLED: true },
    diagnostics: { roster: { dueAt: NOW.toISOString() } }
  });
  assert.equal(adapted.evaluatorInput.externalFlags.NPB_FETCH_DISABLED, true);
  assert.equal(adapted.evaluatorInput.stageDefinitions.roster_fetch.externalFetchDisabled, true);
  assert.equal(evaluated.stages.roster_fetch.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_EXTERNAL_FETCH_DISABLED);
  assert.equal(evaluated.stages.roster_fetch.recoveryRecommended, false);
});

test("adapts ranking exclusion into ranking and publication no-ops", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: {
      internalGameId: GAME_ID,
      gameStatus: "scheduled",
      workflowState: "scheduled",
      rankingExcluded: true
    },
    diagnostics: {
      ranking_reflect: { dueAt: NOW.toISOString() },
      publish: { dueAt: NOW.toISOString() }
    }
  });
  assert.equal(adapted.evaluatorInput.rankingExcluded, true);
  assert.equal(evaluated.stages.ranking_reflect.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE);
  assert.equal(evaluated.stages.ranking_reflect.blockingReason, "RANKING_EXCLUDED");
  assert.equal(evaluated.stages.publish.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE);
  assert.equal(evaluated.stages.publish.nextSafeAction, "no_op");
});

test("adapts a normal completed flow through publication", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "prediction_closed", gameDate: "2026-08-23" },
    jobs: [
      job("prediction_close", "completed"),
      job("lineup_finalize", "completed"),
      job("score", "completed"),
      job("ranking_rebuild", "completed"),
      job("publish", "completed")
    ],
    artifacts: {
      prediction_close: { available: true, valid: true },
      lineup_finalize: { available: true, finalizedValid: true },
      scoring: { available: true, ready: true },
      ranking_reflect: { available: true, reflected: true },
      publish: { available: true, published: true }
    }
  });
  assert.equal(adapted.evaluatorInput.jobs.length, 5);
  assert.equal(evaluated.effectiveState, V35_EFFECTIVE_STATE.PUBLISHED);
  for (const stageName of ["prediction_close", "lineup_finalize", "scoring", "ranking_reflect", "publish"]) {
    assert.equal(evaluated.stages[stageName].healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY, stageName);
  }
});

test("adapter is pure and does not call database or job functions supplied as unknown input", () => {
  const failIfCalled = () => { throw new Error("side effect called"); };
  const adapted = adaptV35Input({
    game: { internalGameId: GAME_ID },
    jobs: [],
    diagnostics: {},
    db: { prepare: failIfCalled },
    createJob: failIfCalled,
    writeState: failIfCalled,
    now: NOW
  });
  assert.equal(adapted.evaluatorInput.internalGameId, GAME_ID);
  assert.equal(adapted.evaluatorInput.jobs.length, 0);
});
