import assert from "node:assert/strict";
import test from "node:test";
import { adaptV35Input, resolveV35OperationalMode } from "../backend/automation-v3/stage-health-adapter.js";
import { evaluateV35Automation, V35_STAGE_HEALTH } from "../backend/automation-v3/stage-health-evaluator.js";
import { planShadowRecovery } from "../backend/automation-v3/shadow-recovery-planner.js";

const GAME_ID = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-09-06T10:00:00.000Z");

function publishedInput(overrides = {}) {
  const base = {
    game: {
      internalGameId: GAME_ID,
      gameDate: "2026-09-06",
      startAt: "2026-09-06T05:00:00.000Z",
      gameStatus: "scheduled",
      workflowState: "published",
    },
    automationMode: { mode: "v4_semi_auto", isV4SemiAuto: true },
    artifacts: {
      prediction_close: { available: true, valid: true },
      lineup_finalize: {
        available: true,
        valid: true,
        canonicalFinalRevisionId: `${GAME_ID}:3`,
        canonicalFinalRevisionValid: true
      },
      scoring: { available: true, valid: true, scoringRevisionId: "score-revision-3" },
      ranking_reflect: {
        available: true,
        valid: true,
        reflected: true,
        scoringRevisionId: "score-revision-3",
        reflectedScoringRevisionId: "score-revision-3",
        revisionMatches: true
      },
      publish: { available: true, valid: true, published: true }
    },
    jobs: [],
    now: NOW,
  };
  return {
    ...base,
    ...overrides,
    game: { ...base.game, ...overrides.game },
    artifacts: { ...base.artifacts, ...overrides.artifacts }
  };
}

function evaluate(input) {
  const adapted = adaptV35Input(input);
  const derived = evaluateV35Automation(adapted.evaluatorInput);
  const recovery = planShadowRecovery({
    game: input.game,
    derivedDiagnostics: { ...derived, automationMode: adapted.operationalMode },
    now: input.now
  });
  return { adapted, derived, recovery };
}

test("V4 modeはdiagnostic側でもroster/lineup/finalizeを手動stageとして認識する", () => {
  const mode = resolveV35OperationalMode({ automationMode: { mode: "v4_semi_auto" } });
  assert.equal(mode.mode, "v4_semi_auto");
  assert.equal(mode.autoRosterFetch, false);
  assert.equal(mode.autoLineupFetch, false);
  assert.deepEqual(mode.diagnosticManualStages, ["roster_fetch", "lineup_fetch", "lineup_finalize"]);
});

test("V4 roster_fetchのjob欠損はrecovery提案にならない", () => {
  const { derived, recovery } = evaluate(publishedInput());
  assert.equal(derived.stages.roster_fetch.healthStatus, V35_STAGE_HEALTH.MANUAL_MODE);
  assert.equal(derived.stages.roster_fetch.nextSafeAction, "no_action");
  assert.equal(recovery.recommendations.some(({ stage }) => stage === "roster_fetch"), false);
});

test("V4のroster snapshot欠損は補助情報へ下げる", () => {
  const input = publishedInput({
    artifacts: {
      roster_fetch: {
        source: "latest_official_live",
        verificationStatus: "verified",
        publicUsable: true,
        canonicalSnapshotAvailable: false,
        reason: "ROSTER_SNAPSHOT_MISSING"
      }
    }
  });
  const { adapted, recovery } = evaluate(input);
  assert.equal(adapted.warnings.some(({ code }) => code === "ROSTER_SNAPSHOT_MISSING"), false);
  assert.ok(adapted.informationalNotices.some(({ code }) => code === "V4_MANUAL_ROSTER_SNAPSHOT_NOT_REQUIRED"));
  assert.equal(recovery.hasRecommendedActions, false);
});

test("V4 canonical final lineupが有効ならlineup_finalize jobなしでも完了扱い", () => {
  const { derived, recovery } = evaluate(publishedInput());
  assert.equal(derived.stages.lineup_finalize.healthStatus, V35_STAGE_HEALTH.COMPLETED_ARTIFACT_READY);
  assert.equal(derived.stages.lineup_finalize.completionSource, "manual_lineup");
  assert.equal(derived.stages.lineup_finalize.recoveryRecommended, false);
  assert.equal(recovery.recommendations.some(({ stage }) => stage === "lineup_finalize"), false);
});

test("V4 canonical final lineupが不正でも自動repair提案を出さず要対応表示を維持", () => {
  const input = publishedInput({ artifacts: {
    lineup_finalize: {
      available: true,
      ready: true,
      canonicalFinalRevisionId: `${GAME_ID}:3`,
      canonicalFinalRevisionValid: false
    }
  }});
  const { derived, recovery } = evaluate(input);
  assert.equal(derived.stages.lineup_finalize.healthStatus, V35_STAGE_HEALTH.MANUAL_MODE);
  assert.equal(derived.stages.lineup_finalize.attentionLevel, "ATTENTION");
  assert.equal(recovery.recommendations.some(({ stage }) => stage === "lineup_finalize"), false);
});

test("publishedかつ現行score/ranking/publicationとcanonical lineupが正常ならalready_published", () => {
  const { derived, recovery } = evaluate(publishedInput());
  assert.equal(derived.publishedHealthy, true);
  assert.equal(recovery.hasRecommendedActions, false);
  assert.deepEqual(recovery.noActionReasons, ["already_published"]);
});

test("現行score/ranking revision mismatchはV4 manualでも要対応を隠さない", () => {
  const input = publishedInput({ artifacts: {
    ranking_reflect: {
      available: true,
      reflected: true,
      scoringRevisionId: "score-revision-2",
      reflectedScoringRevisionId: "score-revision-1",
      revisionMatches: false
    }
  }});
  const { derived } = evaluate(input);
  assert.equal(derived.stages.ranking_reflect.artifactHealth.valid, false);
  assert.equal(derived.publishedHealthy, false);
});
