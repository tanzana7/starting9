import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCanonicalArtifacts } from "../backend/automation-v3/canonical-artifact-evaluator.js";
import { deriveAdminV3GameProgressStatus } from "../backend/automation-v3/admin-progress-status.js";
import { buildStagePlans, buildV3PlanningState } from "../backend/automation-v3/planning-engine.js";
import { adaptV35Input } from "../backend/automation-v3/stage-health-adapter.js";

const GAME_ID = "99999999-9999-4999-8999-999999999999";

function lineupJson(seed = "player") {
  return JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
    battingOrder: index + 1,
    position: String(index + 1),
    playerId: `${seed}-${index + 1}`,
    playerName: `${seed}-${index + 1}`
  })));
}

function facts({
  canonicalRevisionId = `${GAME_ID}:2`,
  revisionId = canonicalRevisionId,
  lineupValid = true,
  validation = { ok: true },
  scoringRevisionId = null,
  scoringLineupRevisionId = canonicalRevisionId,
  scoringStatus = null,
  scoredAt = null,
  rankingRevisionId = null,
  rankingStatus = null,
  publicationStatus = null,
  publishedAt = null
} = {}) {
  const canonicalLineup = canonicalRevisionId === null
    ? { internal_game_id: GAME_ID, scoring_status: scoringStatus, scored_at: scoredAt, publication_status: publicationStatus, published_at: publishedAt }
    : {
        internal_game_id: GAME_ID,
        final_lineup_revision_id: canonicalRevisionId,
        scoring_status: scoringStatus,
        scored_at: scoredAt,
        publication_status: publicationStatus,
        published_at: publishedAt
      };
  const revisions = revisionId === null ? [] : [{
    game_id: GAME_ID,
    internal_game_id: GAME_ID,
    revision_id: revisionId,
    version: Number(String(revisionId).split(":").at(-1)) || 2,
    actual_lineup_json: lineupJson(lineupValid ? "valid" : "duplicate"),
    validation_json: JSON.stringify(validation)
  }];
  if (!lineupValid && revisions[0]) revisions[0].actual_lineup_json = JSON.stringify([{ battingOrder: 1, position: "1", playerId: "duplicate", playerName: "duplicate" }]);
  return {
    canonicalLineup,
    lineupRevisions: revisions,
    activeScoringRevision: scoringRevisionId === null ? null : {
      id: scoringRevisionId,
      internal_game_id: GAME_ID,
      lineup_revision_id: scoringLineupRevisionId,
      status: scoringStatus === "scored" ? "completed" : "pending"
    },
    rankingReflection: rankingRevisionId === null ? null : {
      internal_game_id: GAME_ID,
      scoring_revision_id: rankingRevisionId,
      status: rankingStatus || "reflected",
      ranking_update_revision: 2
    }
  };
}

function evaluate(options = {}) {
  return evaluateCanonicalArtifacts(facts(options));
}

test("通常試合・スタメン未確定はlineup未成立で注意不要", () => {
  const result = evaluate({ canonicalRevisionId: null });
  assert.equal(result.aggregate.lineupReady, false);
  assert.equal(result.aggregate.needsAttention, false);
});

test("manual lineup確定済みはcanonical revisionだけでlineupReady", () => {
  const result = evaluate();
  assert.equal(result.lineup.revisionExists, true);
  assert.equal(result.lineup.revisionValidated, true);
  assert.equal(result.lineup.lineupValid, true);
  assert.equal(result.aggregate.lineupReady, true);
  assert.equal(result.aggregate.scoringReady, false);
});

test("prediction_closed + canonical lineupありはscore待ち", () => {
  const result = evaluate();
  assert.equal(result.lineup.lineupReady, true);
  assert.equal(result.scoring.reason, "ACTIVE_SCORING_REVISION_MISSING");
  assert.equal(result.aggregate.reprocessingRequired, false);
});

test("score completedはactive scoring revisionとcanonical lineupの一致が必要", () => {
  const result = evaluate({ scoringRevisionId: "score-b", scoringStatus: "scored", scoredAt: "2026-09-08T01:00:00.000Z" });
  assert.equal(result.scoring.activeScoringRevisionId, "score-b");
  assert.equal(result.scoring.completed, true);
  assert.equal(result.scoring.lineupRevisionMatch, true);
  assert.equal(result.aggregate.scoringReady, true);
});

test("ranking completedはcurrent scoring revisionに一致するreflectionだけを有効化", () => {
  const result = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-b"
  });
  assert.equal(result.ranking.reflected, true);
  assert.equal(result.ranking.scoringRevisionMatch, true);
  assert.equal(result.aggregate.rankingReady, true);
});

test("published completedはlineup/scoring/ranking/publication全てがcurrentならfullyPublished", () => {
  const result = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-b",
    publicationStatus: "published",
    publishedAt: "2026-09-08T02:00:00.000Z"
  });
  assert.equal(result.aggregate.fullyPublished, true);
  assert.equal(result.aggregate.needsAttention, false);
});

test("published + roster_fetch missing + V4 manual rosterでもpublicationをfalseにしない", () => {
  const result = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-b",
    publicationStatus: "published",
    publishedAt: "2026-09-08T02:00:00.000Z"
  });
  assert.equal(result.aggregate.fullyPublished, true);
});

test("correction freshはcanonical Bだけでは再処理済みとしない", () => {
  const result = evaluate({ canonicalRevisionId: `${GAME_ID}:3`, revisionId: `${GAME_ID}:3` });
  assert.equal(result.aggregate.lineupReady, true);
  assert.equal(result.aggregate.reprocessingRequired, false);
});

test("correction: score B completed + ranking A onlyはranking mismatch", () => {
  const result = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-a"
  });
  assert.equal(result.aggregate.rankingReady, false);
  assert.equal(result.aggregate.artifactMismatch, true);
  assert.equal(result.aggregate.reprocessingRequired, true);
});

test("correction: score B + ranking B + publication retry相当はpublication未成立", () => {
  const result = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-b",
    publicationStatus: "pending"
  });
  assert.equal(result.aggregate.rankingReady, true);
  assert.equal(result.aggregate.publicationReady, false);
  assert.equal(result.aggregate.reprocessingRequired, false);
});

test("correction fully republishedはcurrent lineageで完了", () => {
  const result = evaluate({
    canonicalRevisionId: `${GAME_ID}:3`,
    revisionId: `${GAME_ID}:3`,
    scoringRevisionId: "score-b",
    scoringLineupRevisionId: `${GAME_ID}:3`,
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-b",
    publicationStatus: "published",
    publishedAt: "2026-09-08T02:00:00.000Z"
  });
  assert.equal(result.aggregate.fullyPublished, true);
});

test("canonical final revision missingは明示理由を返す", () => {
  const result = evaluate({ canonicalRevisionId: null });
  assert.equal(result.lineup.reason, "CANONICAL_FINAL_REVISION_MISSING");
});

test("canonical revision invalidはlineupValid false", () => {
  const result = evaluate({ lineupValid: false });
  assert.equal(result.lineup.revisionExists, true);
  assert.equal(result.lineup.lineupValid, false);
  assert.equal(result.aggregate.artifactMismatch, true);
});

test("score revision mismatchはscoringReady false", () => {
  const result = evaluate({
    scoringRevisionId: "score-b",
    scoringLineupRevisionId: `${GAME_ID}:1`,
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z"
  });
  assert.equal(result.scoring.lineupRevisionMatch, false);
  assert.equal(result.aggregate.scoringReady, false);
});

test("ranking revision mismatchは旧reflectionだけで完了扱いしない", () => {
  const result = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-a"
  });
  assert.equal(result.ranking.reflectedRevisionId, "score-a");
  assert.equal(result.ranking.valid, false);
});

test("publication mismatchはpublished statusでもcurrent artifact invalid", () => {
  const result = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-a",
    publicationStatus: "published",
    publishedAt: "2026-09-08T02:00:00.000Z"
  });
  assert.equal(result.publication.rankingRevisionMatch, false);
  assert.equal(result.aggregate.publicationReady, false);
  assert.equal(result.aggregate.needsAttention, true);
});

test("persisted/effective mismatchでもevaluatorはstateを扱わずartifactだけを返す", () => {
  const result = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z"
  });
  assert.equal(Object.hasOwn(result, "workflowState"), false);
  assert.equal(result.aggregate.scoringReady, true);
});

test("future gameの日時を与えなくてもartifact evaluatorは副作用なく未成立を返す", () => {
  const result = evaluate({ canonicalRevisionId: null });
  assert.equal(result.aggregate.fullyPublished, false);
  assert.equal(result.aggregate.needsAttention, false);
});

test("historical published gameもcurrent lineageが成立すれば同じfullyPublished", () => {
  const result = evaluate({
    scoringRevisionId: "score-a",
    scoringStatus: "scored",
    scoredAt: "2026-08-01T01:00:00.000Z",
    rankingRevisionId: "score-a",
    publicationStatus: "published",
    publishedAt: "2026-08-01T02:00:00.000Z"
  });
  assert.equal(result.aggregate.fullyPublished, true);
});

test("admin progressはcanonical evaluatorのfullyPublishedを完了表示へ反映する", () => {
  const canonicalArtifacts = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-b",
    publicationStatus: "published",
    publishedAt: "2026-09-08T02:00:00.000Z"
  });
  const status = deriveAdminV3GameProgressStatus({
    game: { gameDate: "2026-09-08", gameStatus: "completed" },
    workflowState: "published",
    canonicalArtifacts,
    now: new Date("2026-09-09T00:00:00.000Z"),
    jobs: []
  });
  assert.equal(status.key, "completed");
});

test("formal planner parity modeはcanonical evaluatorをtelemetryとして使い、既存planを変更しない", () => {
  const originalArtifacts = {
    lineup_finalize: { available: true, valid: true, ready: true },
    scoring: { available: true, valid: true, ready: true },
    ranking_reflect: { available: true, valid: true, ready: true },
    publish: { available: true, valid: true, ready: true }
  };
  const planningState = buildV3PlanningState({
    game: { internalGameId: GAME_ID, gameDate: "2026-09-08", startAt: "2026-09-08T05:00:00.000Z", workflowState: "published" },
    persistedState: "published",
    artifacts: originalArtifacts,
    jobs: [],
    now: new Date("2026-09-09T00:00:00.000Z")
  });
  const before = buildStagePlans(planningState).map(({ stage, jobType, shouldCreateJob, selectedSlotAt, blockedReason, reasonCode }) => ({ stage, jobType, shouldCreateJob, selectedSlotAt, blockedReason, reasonCode }));
  const canonical = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-b",
    publicationStatus: "published",
    publishedAt: "2026-09-08T02:00:00.000Z"
  });
  const after = buildStagePlans(planningState).map(({ stage, jobType, shouldCreateJob, selectedSlotAt, blockedReason, reasonCode }) => ({ stage, jobType, shouldCreateJob, selectedSlotAt, blockedReason, reasonCode }));
  assert.equal(canonical.aggregate.fullyPublished, true);
  assert.deepEqual(after, before);
});

test("V3.5 adapterはcanonical evaluator結果をlineup/scoring/ranking/publishへ渡す", () => {
  const canonical = evaluate({
    scoringRevisionId: "score-b",
    scoringStatus: "scored",
    scoredAt: "2026-09-08T01:00:00.000Z",
    rankingRevisionId: "score-b",
    publicationStatus: "published",
    publishedAt: "2026-09-08T02:00:00.000Z"
  });
  const adapted = adaptV35Input({
    game: { internalGameId: GAME_ID, gameDate: "2026-09-08", startAt: "2026-09-08T05:00:00.000Z", workflowState: "published" },
    canonicalArtifacts: canonical,
    now: new Date("2026-09-09T00:00:00.000Z")
  });
  assert.equal(adapted.evaluatorInput.artifacts.lineup_finalize.valid, true);
  assert.equal(adapted.evaluatorInput.artifacts.scoring.scoringRevisionId, "score-b");
  assert.equal(adapted.evaluatorInput.artifacts.ranking_reflect.revisionMatches, true);
  assert.equal(adapted.evaluatorInput.artifacts.publish.valid, true);
});
