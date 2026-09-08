import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCanonicalArtifacts } from "../backend/automation-v3/canonical-artifact-evaluator.js";
import { buildStagePlan, buildStagePlans, buildV3PlanningState } from "../backend/automation-v3/planning-engine.js";

const GAME_ID = "formal-canonical-gate-game";
const START_AT = "2026-09-08T05:00:00.000Z";
const NOW = new Date("2026-09-09T00:00:00.000Z");
const FINAL_REVISION_ID = `${GAME_ID}:2`;

function lineupJson() {
  return JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
    battingOrder: index + 1,
    position: String(index + 1),
    playerId: `player-${index + 1}`,
    playerName: `Player ${index + 1}`
  })));
}

function canonical({
  lineupValid = true,
  scoring = false,
  ranking = false,
  publication = false,
  scoringRevisionId = "score-b",
  rankingRevisionId = scoringRevisionId
} = {}) {
  const revisionId = lineupValid ? FINAL_REVISION_ID : `${GAME_ID}:invalid`;
  const canonicalLineup = {
    internal_game_id: GAME_ID,
    final_lineup_revision_id: revisionId,
    scoring_status: scoring ? "scored" : "pending",
    scored_at: scoring ? "2026-09-08T06:00:00.000Z" : null,
    publication_status: publication ? "published" : "private",
    published_at: publication ? "2026-09-08T07:00:00.000Z" : null
  };
  return evaluateCanonicalArtifacts({
    canonicalLineup,
    lineupRevisions: [{
      internal_game_id: GAME_ID,
      revision_id: revisionId,
      version: 2,
      actual_lineup_json: lineupValid ? lineupJson() : JSON.stringify([{ battingOrder: 1, position: "1", playerId: "duplicate", playerName: "duplicate" }]),
      validation_json: JSON.stringify({ ok: lineupValid })
    }],
    activeScoringRevision: scoring ? {
      id: scoringRevisionId,
      lineup_revision_id: FINAL_REVISION_ID,
      status: "completed"
    } : null,
    rankingReflection: ranking ? {
      scoring_revision_id: rankingRevisionId,
      status: "reflected"
    } : null
  });
}

function planningState(persistedState, canonicalArtifacts, jobs = []) {
  return buildV3PlanningState({
    game: {
      internalGameId: GAME_ID,
      gameDate: "2026-09-08",
      startAt: START_AT,
      workflowState: persistedState
    },
    persistedState,
    canonicalArtifacts,
    jobs,
    now: NOW
  });
}

test("stale prediction_closed stateはcanonical lineup成立後にscoringを計画できる", () => {
  const plan = buildStagePlan(planningState("prediction_closed", canonical()), "scoring");
  assert.equal(plan.shouldCreateJob, true);
  assert.equal(plan.reasonCode, "DUE_JOB_MISSING");
  assert.equal(plan.blocked, false);
});

test("stale lineup_ready stateはcanonical score成立後にrankingを計画できる", () => {
  const plan = buildStagePlan(planningState("lineup_ready", canonical({ scoring: true })), "ranking_reflect");
  assert.equal(plan.shouldCreateJob, true);
  assert.equal(plan.reasonCode, "DUE_JOB_MISSING");
});

test("stale scoring stateはcanonical reflection成立後にpublishを計画できる", () => {
  const plan = buildStagePlan(planningState("scored", canonical({ scoring: true, ranking: true })), "publish");
  assert.equal(plan.shouldCreateJob, true);
  assert.equal(plan.reasonCode, "DUE_JOB_MISSING");
});

test("stateがrankedでもcanonical ranking reflection欠落時はpublishを禁止する", () => {
  const plan = buildStagePlan(planningState("ranked", canonical({ scoring: true })), "publish");
  assert.equal(plan.shouldCreateJob, false);
  assert.equal(plan.blockedReason, "PUBLISH_CANONICAL_RANKING_INVALID");
});

test("stateがpublishedでもpublication不整合は自動修復せずneeds attentionにする", () => {
  const artifacts = canonical({ scoring: true, ranking: false, publication: true });
  assert.equal(artifacts.aggregate.fullyPublished, false);
  assert.equal(artifacts.aggregate.needsAttention, true);
  const plans = buildStagePlans(planningState("published", artifacts));
  assert.equal(plans.some((plan) => plan.shouldCreateJob), false);
  assert.equal(plans.every((plan) => plan.reasonCode === "PUBLISHED_CANONICAL_ARTIFACT_MISMATCH_NEEDS_ATTENTION"), true);
});

test("stateがlineup_readyでもcanonical lineup invalidならscoringを禁止する", () => {
  const plan = buildStagePlan(planningState("lineup_ready", canonical({ lineupValid: false })), "scoring");
  assert.equal(plan.shouldCreateJob, false);
  assert.equal(plan.blockedReason, "SCORING_CANONICAL_LINEUP_INVALID");
});

test("correctionはscore B→rank B→publish Bを通し、完了後は新規jobを作らない", () => {
  const scoreB = canonical({ scoring: true, scoringRevisionId: "score-b" });
  const rankAOnly = canonical({ scoring: true, ranking: true, scoringRevisionId: "score-b", rankingRevisionId: "score-a" });
  const rankB = canonical({ scoring: true, ranking: true, scoringRevisionId: "score-b", rankingRevisionId: "score-b" });
  const publishedB = canonical({ scoring: true, ranking: true, publication: true, scoringRevisionId: "score-b", rankingRevisionId: "score-b" });

  assert.equal(buildStagePlan(planningState("lineup_ready", scoreB), "ranking_reflect").shouldCreateJob, true);
  assert.equal(buildStagePlan(planningState("ranked", rankAOnly), "ranking_reflect").shouldCreateJob, true);
  assert.equal(buildStagePlan(planningState("ranked", rankB), "publish").shouldCreateJob, true);
  assert.equal(buildStagePlans(planningState("published", publishedB)).some((plan) => plan.shouldCreateJob), false);
});

test("correctionのranking jobはopen jobがあれば二重作成しない", () => {
  const plan = buildStagePlan(planningState("ranked", canonical({ scoring: true }), [{
    internalGameId: GAME_ID,
    job_type: "ranking_rebuild",
    status: "pending",
    scheduled_slot_at: "2026-09-08T07:00:00.000Z"
  }]), "ranking_reflect");
  assert.equal(plan.shouldCreateJob, false);
  assert.equal(plan.reasonCode, "OPEN_JOB_EXISTS");
});

test("canonical artifactを渡さない通常formal pipelineのgateは従来どおり", () => {
  const state = planningState("prediction_closed", null);
  const score = buildStagePlan(state, "scoring");
  assert.equal(score.shouldCreateJob, false);
  assert.equal(score.blockedReason, "SCORING_STATE_GATE");
});
