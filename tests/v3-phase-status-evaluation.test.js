import test from "node:test";
import assert from "node:assert/strict";
import { deriveV3PhaseStatus } from "../game-automation-v3.js";

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

test("共通phase判定はstructured logs用の共通factsを返す", () => {
  const status = deriveV3PhaseStatus({ phase: "roster", game, now: "2026-08-08T23:32:00.000Z", snapshot: missingSnapshot });
  for (const key of ["severity", "label", "reasonCode", "normalizedCategory", "nextCheckAt", "isBeforeDue", "isAfterDue", "openJobExists", "retryWaitJobExists", "failedJobExists", "completedJobExists", "attentionReasons"]) {
    assert.ok(Object.hasOwn(status.structuredLogFacts, key), `${key} is present`);
  }
});
