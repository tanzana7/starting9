import test from "node:test";
import assert from "node:assert/strict";
import { deriveV3DisplaySchedule, deriveV3PhaseStatus, getV3WorkflowDiagnostics as v3WorkflowDiagnostics } from "../game-automation-v3.js";

const game = { internalGameId: "9b0e9956-9565-474e-96e9-33b1e5ef6ae0", gameDate: "2026-08-09", startAt: "2026-08-09T06:00:00.000Z" };
const missingSnapshot = { exists: false, isFresh: false, isStale: true, staleReason: "ROSTER_SNAPSHOT_MISSING" };

test("共通phase判定はrosterのslot前・slot後・staleを正規化する", () => {
  const before = deriveV3PhaseStatus({ phase: "roster", game, now: "2026-08-08T23:32:00.000Z", snapshot: missingSnapshot });
  assert.deepEqual({ severity: before.severity, reasonCode: before.reasonCode, category: before.normalizedCategory }, { severity: "WAITING", reasonCode: "ROSTER_SNAPSHOT_MISSING_BEFORE_DUE", category: "WAITING" });
  assert.equal(before.diagnosticFacts.freshSnapshotExists, false);
  const after = deriveV3PhaseStatus({ phase: "roster", game, now: "2026-08-09T04:20:00.000Z", snapshot: missingSnapshot });
  assert.equal(after.severity, "ATTENTION");
  assert.equal(after.reasonCode, "ROSTER_SNAPSHOT_MISSING_AFTER_DUE");
  const stale = deriveV3PhaseStatus({ phase: "roster", game, now: "2026-08-08T23:32:00.000Z", snapshot: { ...missingSnapshot, staleReason: "ROSTER_SNAPSHOT_CAPTURE_DATE_STALE" } });
  assert.equal(stale.reasonCode, "ROSTER_SNAPSHOT_STALE_REFETCH_SCHEDULED");
});

test("共通phase判定はlineupの待機・異常とscore/ranking no-op、publish前提待ちを保持する", () => {
  const lineupBefore = deriveV3PhaseStatus({ phase: "lineup_fetch", game, now: "2026-08-09T04:00:00.000Z" });
  assert.equal(lineupBefore.reasonCode, "LINEUP_NOT_YET_AVAILABLE");
  assert.equal(lineupBefore.severity, "WAITING");
  const lineupParser = deriveV3PhaseStatus({ phase: "lineup_fetch", game, now: "2026-08-09T05:15:00.000Z", jobs: [{ job_type: "lineup_fetch", status: "retry_wait", failure_code: "LINEUP_PARSE_FAILED" }] });
  assert.equal(lineupParser.severity, "ATTENTION");
  assert.equal(lineupParser.normalizedCategory, "DATA_INTEGRITY");
  const score = deriveV3PhaseStatus({ phase: "score", game, noOpReason: "V3_SCORING_NO_PREDICTIONS" });
  assert.deepEqual({ severity: score.severity, reasonCode: score.reasonCode }, { severity: "OK", reasonCode: "V3_SCORING_NO_PREDICTIONS" });
  const ranking = deriveV3PhaseStatus({ phase: "ranking", game, noOpReason: "V3_RANKING_NO_ELIGIBLE_ENTRIES" });
  assert.equal(ranking.severity, "OK");
  const publish = deriveV3PhaseStatus({ phase: "publish", game, workflowState: "ranked" });
  assert.equal(publish.severity, "WAITING");
  assert.equal(publish.reasonCode, "PUBLISH_PREREQUISITE_PENDING");
});

test("completed lineup_fetch without candidate is attention", () => {
  const status = deriveV3PhaseStatus({
    phase: "lineup_fetch",
    workflowState: "prediction_closed",
    now: "2026-08-19T05:01:00.000Z",
    game,
    jobs: [{ job_type: "lineup_fetch", status: "completed", completed_at: "2026-08-19T05:00:02.000Z" }],
    lineupDataHealth: {
      available: true,
      candidateExists: false,
      canonicalDataReady: false,
      finalizedLineupExists: false,
      workflowStateAtLeastLineupReady: false,
      ready: false
    }
  });
  assert.equal(status.severity, "ATTENTION");
  assert.equal(status.reasonCode, "LINEUP_FETCH_COMPLETED_WITHOUT_CANDIDATE");
  assert.match(status.message, /candidate\/canonical lineup/);
});

test("completed後の成果物不足はlineup_finalize/score/ranking/publishを成功扱いにしない", () => {
  const baseJob = (job_type) => ({ job_type, status: "completed", id: 99, completed_at: "2026-08-19T05:02:00.000Z" });
  const artifactHealth = {
    available: true,
    lineup: { available: true, candidateExists: true, finalizedLineupExists: false, ready: true },
    scoring: { available: true, ready: false },
    ranking: { available: true, reflected: false },
    publication: { available: true, published: false }
  };
  const cases = [
    ["lineup_finalize", "prediction_closed", "LINEUP_FINALIZE_COMPLETED_WITHOUT_FINALIZED_LINEUP"],
    ["score", "lineup_ready", "SCORING_COMPLETED_WITHOUT_SCORE"],
    ["ranking", "scored", "RANKING_COMPLETED_WITHOUT_REFLECTION"],
    ["publish", "ranked", "PUBLISH_COMPLETED_WITHOUT_PUBLICATION"]
  ];
  for (const [phase, workflowState, reasonCode] of cases) {
    const jobType = phase === "ranking" ? "ranking_rebuild" : phase;
    const status = deriveV3PhaseStatus({ phase, game, workflowState, jobs: [baseJob(jobType)], workflowArtifactHealth: artifactHealth });
    assert.equal(status.severity, "ATTENTION");
    assert.equal(status.reasonCode, reasonCode);
  }
});

test("completed jobでも成果物ヘルス取得不能なら現在状態を未検証にする", () => {
  const baseJob = (job_type) => ({ job_type, status: "completed", id: 100, completed_at: "2026-08-19T05:02:00.000Z" });
  const cases = [
    ["lineup_fetch", "prediction_closed", "V3_LINEUP_DATA_HEALTH_UNAVAILABLE"],
    ["lineup_finalize", "prediction_closed", "V3_LINEUP_DATA_HEALTH_UNAVAILABLE"],
    ["score", "lineup_ready", "V3_SCORING_DATA_HEALTH_UNAVAILABLE"],
    ["ranking", "scored", "V3_RANKING_DATA_HEALTH_UNAVAILABLE"],
    ["publish", "ranked", "V3_PUBLICATION_DATA_HEALTH_UNAVAILABLE"]
  ];
  for (const [phase, workflowState, reasonCode] of cases) {
    const jobType = phase === "ranking" ? "ranking_rebuild" : phase;
    const status = deriveV3PhaseStatus({ phase, game, workflowState, jobs: [baseJob(jobType)] });
    assert.equal(status.severity, "ATTENTION");
    assert.equal(status.reasonCode, reasonCode);
    assert.match(status.message, /成果物ヘルス/);
  }
});

test("artifact mismatch diagnostics expose all completed jobs requiring recovery", () => {
  const diagnostics = v3WorkflowDiagnostics({
    state: "lineup_ready",
    jobs: [{ job_type: "score", status: "completed", id: 3 }],
    workflowArtifactHealth: {
      available: true,
      lineup: { available: true, candidateExists: true, finalizedLineupExists: true, ready: true },
      scoring: { available: true, ready: false },
      ranking: { available: true, reflected: false },
      publication: { available: true, published: false }
    }
  });
  assert.equal(diagnostics.artifactBlockingReasons[0]?.code, "SCORING_COMPLETED_WITHOUT_SCORE");
});

test("下流成果物がある場合は古いlineup state gateを現在状態にしない", () => {
  const diagnostics = v3WorkflowDiagnostics({
    state: "scored",
    game: { npbGameCode: "f-h-20", npbIdentityState: "resolved" },
    jobs: [
      { id: 12, job_type: "prediction_close", status: "completed" },
      { id: 13, job_type: "lineup_fetch", status: "retry_wait", failure_code: "PREDICTION_CLOSE_STATE_GATE" },
      { id: 14, job_type: "lineup_finalize", status: "completed", completed_at: "2026-08-20T05:00:00.000Z" }
    ],
    lineupDataHealth: {
      available: true,
      candidateExists: true,
      canonicalDataReady: true,
      finalizedLineupExists: true,
      workflowStateAtLeastLineupReady: true,
      ready: true
    }
  });
  assert.equal(diagnostics.lineupFetch.currentStageStatus, "completed");
  assert.equal(diagnostics.lineupFetch.blockingReasonCode, null);
  assert.equal(diagnostics.lineupFetch.blockingReasons.length, 0);
  assert.equal(diagnostics.lineupFetch.overriddenByDownstreamArtifact, true);
  assert.equal(diagnostics.lineupFetch.historicalWarnings[0]?.code, "PREDICTION_CLOSE_STATE_GATE");
  assert.equal(diagnostics.lineupFetch.staleBlockingReason.code, "PREDICTION_CLOSE_STATE_GATE");
});

test("下流成果物があり過去の締切gateを検出できる場合は履歴へ分離する", () => {
  const schedule = deriveV3DisplaySchedule({ gameDate: "2026-08-06", startAt: "2026-08-06T09:00:00.000Z" });
  const diagnostics = v3WorkflowDiagnostics({
    schedule,
    state: "scored",
    game: { npbGameCode: "f-h-06", npbIdentityState: "resolved" },
    now: "2026-08-06T09:05:00.000Z",
    jobs: [{ id: 12, job_type: "prediction_close", status: "completed" }],
    lineupDataHealth: { available: true, candidateExists: true, canonicalDataReady: true, finalizedLineupExists: true, workflowStateAtLeastLineupReady: true, ready: true }
  });
  assert.equal(diagnostics.lineupFetch.currentStageStatus, "completed");
  assert.equal(diagnostics.lineupFetch.blockingReasonCode, null);
  assert.equal(diagnostics.lineupFetch.historicalWarnings[0]?.code, "PREDICTION_CLOSE_STATE_GATE");
  assert.equal(diagnostics.lineupFetch.staleBlockingReason.code, "PREDICTION_CLOSE_STATE_GATE");
});

test("excluded試合は古い工程警告より対象外表示を優先する", () => {
  const status = deriveV3PhaseStatus({
    phase: "lineup_fetch",
    workflowState: "excluded",
    jobs: [{ job_type: "lineup_fetch", status: "retry_wait", failure_code: "PREDICTION_CLOSE_STATE_GATE" }]
  });
  assert.equal(status.severity, "OK");
  assert.equal(status.label, "対象外");
  assert.equal(status.reasonCode, "V3_GAME_EXCLUDED");
});

test("共通phase判定はstructured logs用の共通factsを返す", () => {
  const status = deriveV3PhaseStatus({ phase: "roster", game, now: "2026-08-08T23:32:00.000Z", snapshot: missingSnapshot });
  for (const key of ["severity", "label", "reasonCode", "normalizedCategory", "nextCheckAt", "isBeforeDue", "isAfterDue", "openJobExists", "retryWaitJobExists", "failedJobExists", "completedJobExists", "attentionReasons"]) {
    assert.ok(Object.hasOwn(status.structuredLogFacts, key), `${key} is present`);
  }
});
