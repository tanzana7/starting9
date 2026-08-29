import assert from "node:assert/strict";
import test from "node:test";
import { buildShadowRecoveryPlan, planShadowRecovery } from "../backend/automation-v3/shadow-recovery-planner.js";

const NOW = "2026-08-24T06:00:00.000Z";
const GAME_ID = "33333333-3333-4333-8333-333333333333";

function stage(healthStatus, overrides = {}) {
  return { healthStatus, ...overrides };
}

function input(stages, overrides = {}) {
  return {
    game: { internalGameId: GAME_ID, gameStatus: "scheduled", persistedWorkflowState: "scheduled", ...overrides.game },
    derivedDiagnostics: { effectiveState: "scheduled", persistedState: "scheduled", stages, ...overrides.derivedDiagnostics },
    now: NOW,
    flags: { ...overrides.flags }
  };
}

test("prediction_close terminal failure produces a high-priority recovery intent", () => {
  const plan = planShadowRecovery(input({
    prediction_close: stage("TERMINAL_FAILED", { recoveryRecommended: true, recoveryReason: "TERMINAL_FAILED", dueAt: NOW })
  }));
  assert.equal(plan.mode, "shadow_read_only");
  assert.equal(plan.canExecute, false);
  assert.equal(plan.hasRecommendedActions, true);
  assert.equal(plan.recommendations[0].stage, "prediction_close");
  assert.equal(plan.recommendations[0].actionType, "would_schedule_recovery_job");
  assert.equal(plan.recommendations[0].jobType, "prediction_close");
  assert.equal(plan.recommendations[0].priority, "high");
  assert.equal(plan.recommendations[0].blocked, false);
});

test("lineup_fetch waits behind a failed prediction_close prerequisite", () => {
  const plan = planShadowRecovery(input({
    prediction_close: stage("TERMINAL_FAILED", { recoveryRecommended: true, dueAt: NOW }),
    lineup_fetch: stage("BLOCKED_BY_PREREQUISITE", { blockingReason: "PREDICTION_CLOSE_STATE_GATE", dueAt: NOW })
  }));
  assert.equal(plan.recommendations[0].stage, "prediction_close");
  assert.equal(plan.blockedRecommendations[0].stage, "lineup_fetch");
  assert.equal(plan.blockedRecommendations[0].blocked, true);
  assert.equal(plan.blockedRecommendations[0].blockedReason, "PREDICTION_CLOSE_STATE_GATE");
});

test("missing roster snapshot produces a roster recovery intent", () => {
  const plan = planShadowRecovery(input({
    roster_fetch: stage("COMPLETED_ARTIFACT_MISSING", {
      recoveryRecommended: true,
      blockingReason: "ROSTER_SNAPSHOT_MISSING",
      artifactHealth: { reason: "ROSTER_SNAPSHOT_MISSING" },
      dueAt: NOW
    })
  }));
  assert.equal(plan.recommendations[0].stage, "roster_fetch");
  assert.equal(plan.recommendations[0].reason, "ROSTER_SNAPSHOT_MISSING");
});

test("published roster no-changes does not produce a roster recovery intent", () => {
  const plan = planShadowRecovery(input({
    roster_fetch: stage("COMPLETED_ARTIFACT_READY", {
      artifactHealth: { available: true, valid: true, reason: "ROSTER_NO_CHANGES" },
      recoveryRecommended: false,
      nextSafeAction: "no_op"
    })
  }, {
    game: { gameStatus: "finished" },
    derivedDiagnostics: { effectiveState: "published", persistedState: "published" }
  }));
  assert.equal(plan.canExecute, false);
  assert.equal(plan.hasRecommendedActions, false);
  assert.equal(plan.recommendations.some(({ stage }) => stage === "roster_fetch"), false);
});

test("derived due missing job produces a read-only would action", () => {
  const plan = planShadowRecovery(input({
    npb_game_identify: stage("MISSING_JOB", {
      recoveryRecommended: true,
      recoveryReason: "MISSING_DUE_JOB",
      dueAt: "2026-08-24T09:00:00.000Z",
      dueAtSource: "derived_from_game_start"
    })
  }));
  assert.equal(plan.canExecute, false);
  assert.equal(plan.hasRecommendedActions, true);
  assert.equal(plan.recommendations[0].stage, "npb_game_identify");
  assert.equal(plan.recommendations[0].actionType, "would_schedule_recovery_job");
  assert.match(plan.recommendations[0].idempotencyKey, /npb_game_identify/);
});

test("completed lineup without artifact produces a lineup recovery intent", () => {
  const plan = planShadowRecovery(input({
    lineup_fetch: stage("COMPLETED_ARTIFACT_MISSING", {
      recoveryRecommended: true,
      blockingReason: "COMPLETED_ARTIFACT_MISSING",
      dueAt: NOW
    })
  }));
  assert.equal(plan.recommendations[0].stage, "lineup_fetch");
  assert.equal(plan.recommendations[0].reason, "COMPLETED_ARTIFACT_MISSING");
});

test("superseded lineup fetch produces no recovery recommendation while finalize retries", () => {
  const plan = planShadowRecovery(input({
    lineup_fetch: stage("BLOCKED_BY_PREREQUISITE", {
      blockingReason: "LINEUP_FETCH_SUPERSEDED_BY_LINEUP_FINALIZE",
      nextSafeAction: "wait_for_prerequisite",
      dueAt: NOW
    }),
    lineup_finalize: stage("RETRY_WAIT_NOT_DUE", {
      nextSafeAction: "wait_until_retry"
    })
  }));
  assert.equal(plan.recommendations.some(({ stage: stageName }) => stageName === "lineup_fetch"), false);
  assert.equal(plan.blockedRecommendations.some(({ stage: stageName }) => stageName === "lineup_fetch"), false);
  assert.ok(plan.noActionReasons.includes("lineup_fetch:window_closed"));
});

test("ready probable-starter artifact does not produce a recovery intent", () => {
  const plan = planShadowRecovery(input({
    probable_starter: stage("COMPLETED_ARTIFACT_READY", {
      recoveryRecommended: false,
      artifactHealth: { available: true, valid: true },
      dueAt: NOW
    })
  }));
  assert.equal(plan.canExecute, false);
  assert.equal(plan.hasRecommendedActions, false);
  assert.equal(plan.recommendations.some(({ stage: stageName }) => stageName === "probable_starter"), false);
  assert.ok(plan.noActionReasons.includes("probable_starter:no_action"));
});

test("retry_wait due proposes retry requeue and preserves a diagnostic idempotency key", () => {
  const plan = planShadowRecovery(input({
    roster_fetch: stage("RETRY_WAIT_DUE", { recoveryRecommended: true, dueAt: NOW })
  }));
  const recommendation = plan.recommendations[0];
  assert.equal(recommendation.actionType, "would_requeue_or_claim_retry");
  assert.match(recommendation.idempotencyKey, /^shadow:/);
  assert.equal(recommendation.idempotencyKey, planShadowRecovery(input({
    roster_fetch: stage("RETRY_WAIT_DUE", { recoveryRecommended: true, dueAt: NOW })
  })).recommendations[0].idempotencyKey);
});

test("retry_wait before due produces no recovery recommendation", () => {
  const plan = planShadowRecovery(input({
    roster_fetch: stage("RETRY_WAIT_NOT_DUE", { nextSafeAction: "wait_until_retry" })
  }));
  assert.equal(plan.recommendations.length, 0);
  assert.ok(plan.noActionReasons.includes("roster_fetch:wait"));
});

for (const status of ["cancelled", "postponed", "excluded"]) {
  test(`${status} game produces no recovery recommendation`, () => {
    const plan = planShadowRecovery(input({ prediction_close: stage("TERMINAL_FAILED", { recoveryRecommended: true }) }, {
      game: { gameStatus: status }
    }));
    assert.equal(plan.recommendations.length, 0);
    assert.equal(plan.blockedRecommendations.length, 0);
    assert.equal(plan.hasRecommendedActions, false);
    assert.equal(plan.noActionReasons[0], status === "excluded" ? "game_excluded" : `game_${status === "cancelled" ? "cancelled" : "postponed"}`);
  });
}

test("external fetch disabled blocks fetch recovery without executing it", () => {
  const plan = planShadowRecovery(input({
    roster_fetch: stage("MISSING_JOB", { recoveryRecommended: true, dueAt: NOW })
  }, { flags: { externalFetchDisabled: true } }));
  assert.equal(plan.recommendations.length, 0);
  assert.equal(plan.blockedRecommendations[0].stage, "roster_fetch");
  assert.equal(plan.blockedRecommendations[0].blockedReason, "external_fetch_disabled");
});

test("manual attention blocks automatic recovery intents", () => {
  const plan = planShadowRecovery(input({
    prediction_close: stage("TERMINAL_FAILED", { recoveryRecommended: true, dueAt: NOW })
  }, { flags: { manualAttention: true } }));
  assert.equal(plan.recommendations.length, 0);
  assert.equal(plan.blockedRecommendations[0].blockedReason, "manual_attention");
  assert.ok(plan.noActionReasons.includes("manual_attention"));
});

test("published games produce an already_published no-op", () => {
  const plan = planShadowRecovery(input({
    scoring: stage("TERMINAL_FAILED", { recoveryRecommended: true })
  }, { derivedDiagnostics: { effectiveState: "published" } }));
  assert.equal(plan.recommendations.length, 0);
  assert.deepEqual(plan.noActionReasons, ["already_published"]);
});

test("ranking exclusion suppresses ranking recovery only", () => {
  const plan = planShadowRecovery(input({
    scoring: stage("TERMINAL_FAILED", { recoveryRecommended: true, dueAt: NOW }),
    ranking_reflect: stage("TERMINAL_FAILED", { recoveryRecommended: true, dueAt: NOW }),
    publish: stage("TERMINAL_FAILED", { recoveryRecommended: true, dueAt: NOW })
  }, { game: { rankingExcluded: true } }));
  assert.equal(plan.recommendations[0].stage, "scoring");
  assert.equal(plan.recommendations.some(({ stage: stageName }) => stageName === "ranking_reflect"), false);
  assert.equal(plan.recommendations.some(({ stage: stageName }) => stageName === "publish"), false);
  assert.ok(plan.noActionReasons.includes("ranking_excluded"));
});

test("future scheduled stages wait without a recommendation", () => {
  const plan = planShadowRecovery(input({
    prediction_close: stage("NOT_DUE", { dueAt: "2026-08-24T07:00:00.000Z" }),
    lineup_fetch: stage("BLOCKED_BY_PREREQUISITE", { blockingReason: "PREDICTION_CLOSE_STATE_GATE", dueAt: "2026-08-24T08:00:00.000Z" })
  }));
  assert.equal(plan.recommendations.length, 0);
  assert.equal(plan.blockedRecommendations.length, 1);
  assert.equal(plan.blockedRecommendations[0].stage, "lineup_fetch");
});

test("planner is pure and never calls supplied runtime-like functions", () => {
  const fail = () => { throw new Error("side effect called"); };
  const plan = buildShadowRecoveryPlan({
    ...input({ prediction_close: stage("TERMINAL_FAILED", { recoveryRecommended: true, dueAt: NOW }) }),
    db: { prepare: fail },
    createJob: fail,
    writeState: fail,
    transitionState: fail
  });
  assert.equal(plan.canExecute, false);
  assert.equal(plan.recommendations.length, 1);
});
