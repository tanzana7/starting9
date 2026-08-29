import test from "node:test";
import assert from "node:assert/strict";
import { adaptV35Input } from "../backend/automation-v3/stage-health-adapter.js";
import { evaluateV35Automation, V35_EFFECTIVE_STATE, V35_STAGE_HEALTH } from "../backend/automation-v3/stage-health-evaluator.js";

const NOW = new Date("2026-08-23T06:00:00.000Z");
const GAME_ID = "22222222-2222-4222-8222-222222222222";

function evaluateAdapter(input) {
  const adapted = adaptV35Input({ ...input, now: input.now || NOW });
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
  assert.equal(evaluated.stages.lineup_fetch.healthStatus, V35_STAGE_HEALTH.NOT_DUE);
  assert.equal(evaluated.stages.lineup_fetch.nextSafeAction, "wait");
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

test("treats roster no-changes with a captured snapshot as a ready artifact", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "published" },
    jobs: [job("roster_fetch", "completed")],
    diagnostics: {
      roster: {
        dueAt: NOW.toISOString(),
        noticeState: "ROSTER_NO_CHANGES",
        rosterSnapshotExists: true,
        rosterSnapshotStatus: "captured",
        nextSafeAction: "roster_fetch"
      }
    }
  });
  const roster = adapted.evaluatorInput.artifacts.roster_fetch;
  assert.equal(roster.available, true);
  assert.equal(roster.valid, true);
  assert.equal(roster.reason, "ROSTER_NO_CHANGES");
  assert.equal(roster.nextSafeAction, "no_op");
  assert.equal(evaluated.stages.roster_fetch.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY);
  assert.equal(evaluated.stages.roster_fetch.recoveryRecommended, false);
});

test("treats a captured roster snapshot as ready even without a notice state", () => {
  const { evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "published" },
    jobs: [job("roster_fetch", "completed")],
    diagnostics: {
      roster: {
        dueAt: NOW.toISOString(),
        rosterSnapshotStatus: "captured",
        rosterSnapshotExists: true
      }
    }
  });
  assert.equal(evaluated.stages.roster_fetch.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY);
  assert.equal(evaluated.stages.roster_fetch.nextSafeAction, "no_op");
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

test("uses completed normal lineup overview data as a ready artifact without a lineup job", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "prediction_closed" },
    diagnostics: {
      lineupFetch: {
        dueAt: NOW.toISOString(),
        status: "completed",
        reasonCode: "LINEUP_FETCH_COMPLETED"
      }
    }
  });
  assert.equal(adapted.evaluatorInput.artifacts.lineup_fetch.reason, "LINEUP_FETCH_COMPLETED");
  assert.equal(evaluated.stages.lineup_fetch.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY);
  assert.equal(evaluated.stages.lineup_fetch.nextSafeAction, "no_op");
});

test("published downstream artifacts make lineup fetch ready without a recovery proposal", () => {
  const { evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "published", startAt: "2026-08-23T08:00:00.000Z" },
    now: new Date("2026-08-23T10:00:00.000Z"),
    artifacts: {
      lineup_finalize: { available: true, valid: true },
      scoring: { available: true, valid: true },
      ranking_reflect: { available: true, valid: true },
      publish: { available: true, valid: true }
    }
  });
  assert.equal(evaluated.stages.lineup_fetch.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY);
  assert.equal(evaluated.stages.lineup_fetch.recoveryRecommended, false);
});

test("after the lineup window, an existing finalize job supersedes lineup fetch", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: {
      internalGameId: GAME_ID,
      gameDate: "2026-08-29",
      startAt: "2026-08-29T05:00:00.000Z",
      gameStatus: "scheduled",
      workflowState: "prediction_closed"
    },
    now: new Date("2026-08-29T05:10:00.000Z"),
    jobs: [job("lineup_finalize", "retry_wait", {
      scheduled_slot_at: "2026-08-29T05:02:00.000Z",
      next_retry_at: "2026-08-29T05:20:00.000Z"
    })]
  });
  const lineupFetch = evaluated.stages.lineup_fetch;
  assert.equal(adapted.evaluatorInput.stageDefinitions.lineup_fetch.prerequisiteReason, "LINEUP_FETCH_SUPERSEDED_BY_LINEUP_FINALIZE");
  assert.equal(lineupFetch.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE);
  assert.equal(lineupFetch.recoveryRecommended, false);
  assert.equal(lineupFetch.nextSafeAction, "wait_for_prerequisite");
});

test("only the same game's active or completed finalize job supersedes lineup fetch", () => {
  const baseInput = {
    game: {
      internalGameId: GAME_ID,
      gameDate: "2026-08-29",
      startAt: "2026-08-29T05:00:00.000Z",
      gameStatus: "scheduled",
      workflowState: "prediction_closed"
    },
    now: new Date("2026-08-29T05:10:00.000Z")
  };
  for (const status of ["pending", "claimed", "retry_wait", "completed"]) {
    const { adapted } = evaluateAdapter({
      ...baseInput,
      jobs: [job("lineup_finalize", status)]
    });
    assert.equal(adapted.evaluatorInput.stageDefinitions.lineup_fetch.prerequisiteReason, "LINEUP_FETCH_SUPERSEDED_BY_LINEUP_FINALIZE", status);
  }
  for (const status of ["failed", "cancelled", "expired", "unknown"]) {
    const { adapted } = evaluateAdapter({
      ...baseInput,
      jobs: [job("lineup_finalize", status)]
    });
    assert.equal(adapted.evaluatorInput.stageDefinitions.lineup_fetch.prerequisiteReason, "LINEUP_FETCH_WINDOW_CLOSED_NO_FINALIZE", status);
  }
  const { adapted } = evaluateAdapter({
    ...baseInput,
    jobs: [job("lineup_finalize", "retry_wait", { internal_game_id: "44444444-4444-4444-8444-444444444444" })]
  });
  assert.equal(adapted.evaluatorInput.stageDefinitions.lineup_fetch.prerequisiteReason, "LINEUP_FETCH_WINDOW_CLOSED_NO_FINALIZE");
});

test("after the lineup window, missing finalize is reported without lineup fetch recovery", () => {
  const { evaluated } = evaluateAdapter({
    game: {
      internalGameId: GAME_ID,
      gameDate: "2026-08-29",
      startAt: "2026-08-29T05:00:00.000Z",
      gameStatus: "scheduled",
      workflowState: "prediction_closed"
    },
    now: new Date("2026-08-29T05:10:00.000Z"),
    jobs: []
  });
  assert.equal(evaluated.stages.lineup_fetch.healthStatus, V35_STAGE_HEALTH.BLOCKED_BY_PREREQUISITE);
  assert.equal(evaluated.stages.lineup_fetch.blockingReason, "LINEUP_FETCH_WINDOW_CLOSED_NO_FINALIZE");
  assert.equal(evaluated.stages.lineup_fetch.recoveryRecommended, false);
});

test("uses the normal admin probable-starter overview data as the formal V3.5 artifact", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "scheduled" },
    jobs: [job("probable_starter_fetch", "completed")],
    diagnostics: {
      probable_starter: {
        dataStatus: "announced",
        homePitcherName: "伊藤大海",
        awayPitcherName: "平良海馬",
        source: "npb",
        fetchedAt: NOW.toISOString(),
        internalGameId: GAME_ID
      }
    }
  });
  assert.equal(adapted.evaluatorInput.artifacts.probable_starter.available, true);
  assert.equal(adapted.evaluatorInput.artifacts.probable_starter.source, "npb");
  assert.equal(evaluated.stages.probable_starter.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY);
  assert.equal(evaluated.stages.probable_starter.recoveryRecommended, false);
});

test("announced reason code remains a normal ready result, not a missing-artifact reason", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "scheduled" },
    jobs: [job("probable_starter_fetch", "completed")],
    artifacts: {
      probable_starter: {
        dataStatus: "announced",
        reasonCode: "PROBABLE_STARTER_ANNOUNCED",
        homePitcherName: "伊藤大海",
        awayPitcherName: "平良海馬",
        source: "npb",
        internalGameId: GAME_ID
      }
    }
  });
  assert.equal(adapted.evaluatorInput.artifacts.probable_starter.available, true);
  assert.equal(adapted.evaluatorInput.artifacts.probable_starter.valid, true);
  assert.equal(adapted.evaluatorInput.artifacts.probable_starter.reason, null);
  assert.equal(evaluated.stages.probable_starter.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY);
  assert.equal(evaluated.stages.probable_starter.nextSafeAction, "no_op");
  assert.equal(evaluated.stages.probable_starter.recoveryRecommended, false);
});

test("does not treat an unannounced probable-starter overview as a ready artifact", () => {
  const { evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "scheduled" },
    jobs: [job("probable_starter_fetch", "completed")],
    diagnostics: {
      probable_starter: {
        dataStatus: "unannounced",
        homePitcherName: "",
        awayPitcherName: ""
      }
    }
  });
  assert.equal(evaluated.stages.probable_starter.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_MISSING);
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

test("adapter exposes stages in operational order", () => {
  const { evaluated } = evaluateAdapter({
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", workflowState: "scheduled" }
  });
  assert.deepEqual(Object.keys(evaluated.stages), [
    "schedule_registration",
    "npb_game_identify",
    "probable_starter",
    "roster_fetch",
    "prediction_close",
    "lineup_fetch",
    "lineup_finalize",
    "scoring",
    "ranking_reflect",
    "publish"
  ]);
});

test("derives due slots when no job or diagnostic slot exists", () => {
  const { adapted, evaluated } = evaluateAdapter({
    game: {
      internalGameId: GAME_ID,
      gameDate: "2026-08-25",
      startAt: "2026-08-25T09:00:00.000Z",
      gameStatus: "scheduled",
      workflowState: "scheduled"
    },
    jobs: [],
    diagnostics: {}
  });
  assert.equal(adapted.sourceSummary.derivedStageSchedule.source, "derived_from_game_start");
  assert.equal(adapted.evaluatorInput.stageDefinitions.npb_game_identify.dueAtSource, "derived_from_game_start");
  assert.equal(evaluated.stages.npb_game_identify.dueAt, "2026-08-24T09:00:00.000Z");
  assert.equal(evaluated.stages.npb_game_identify.dueAtSource, "derived_from_game_start");
  assert.deepEqual(evaluated.stages.roster_fetch.dueSlots, [
    "2026-08-25T07:00:00.000Z",
    "2026-08-25T07:02:00.000Z",
    "2026-08-25T07:10:00.000Z"
  ]);
});

test("job and explicit diagnostic due times take precedence over derived schedule", () => {
  const adapted = adaptV35Input({
    game: {
      internalGameId: GAME_ID,
      gameDate: "2026-08-25",
      startAt: "2026-08-25T09:00:00.000Z",
      workflowState: "scheduled"
    },
    jobs: [job("prediction_close", "pending", { scheduled_at: "2026-08-25T08:55:00.000Z", scheduled_slot_at: "2026-08-25T08:55:00.000Z" })],
    diagnostics: { roster: { dueAt: "2026-08-25T07:05:00.000Z" } },
    now: NOW
  });
  assert.equal(adapted.evaluatorInput.stageDefinitions.prediction_close.dueAt, "2026-08-25T08:55:00.000Z");
  assert.equal(adapted.evaluatorInput.stageDefinitions.prediction_close.dueAtSource, "job");
  assert.equal(adapted.evaluatorInput.stageDefinitions.roster_fetch.dueAt, "2026-08-25T07:05:00.000Z");
  assert.equal(adapted.evaluatorInput.stageDefinitions.roster_fetch.dueAtSource, "diagnostic");
});

test("derived due time turns a missing due job into a recovery diagnostic", () => {
  const { evaluated } = evaluateAdapter({
    game: {
      internalGameId: GAME_ID,
      gameDate: "2026-08-25",
      startAt: "2026-08-25T09:00:00.000Z",
      gameStatus: "scheduled",
      workflowState: "scheduled"
    },
    now: new Date("2026-08-25T08:05:00.000Z"),
    jobs: [],
    diagnostics: {}
  });
  assert.equal(evaluated.stages.prediction_close.healthStatus, "MISSING_JOB");
  assert.equal(evaluated.stages.prediction_close.recoveryRecommended, true);
  assert.equal(evaluated.stages.prediction_close.recoveryReason, "MISSING_DUE_JOB");
});

test("derived due time never recommends recovery for cancelled games", () => {
  const { evaluated } = evaluateAdapter({
    game: {
      internalGameId: GAME_ID,
      gameDate: "2026-08-25",
      startAt: "2026-08-25T09:00:00.000Z",
      gameStatus: "cancelled",
      workflowState: "excluded"
    },
    now: new Date("2026-08-25T08:05:00.000Z"),
    jobs: [],
    diagnostics: {}
  });
  assert.equal(evaluated.stages.prediction_close.healthStatus, "BLOCKED_BY_CANCELLED");
  assert.equal(evaluated.stages.prediction_close.recoveryRecommended, false);
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
