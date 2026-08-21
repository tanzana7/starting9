import test from "node:test";
import assert from "node:assert/strict";
import { getV3RosterStatusDecision } from "../game-automation-v3.js";

const game = {
  internalGameId: "9b0e9956-9565-474e-96e9-33b1e5ef6ae0",
  gameDate: "2026-08-09",
  startAt: "2026-08-09T06:00:00.000Z"
};

const missingSnapshot = {
  exists: false,
  isFresh: false,
  isStale: true,
  staleReason: "ROSTER_SNAPSHOT_MISSING"
};

test("roster snapshotが最初の取得slot前にないことは取得予定として待機する", () => {
  const result = getV3RosterStatusDecision({
    game,
    now: "2026-08-08T23:32:00.000Z",
    snapshot: missingSnapshot,
    jobs: []
  });
  assert.equal(result.severity, "WAITING");
  assert.equal(result.reasonCode, "ROSTER_SNAPSHOT_MISSING_BEFORE_DUE");
  assert.equal(result.nextCheckAt, "2026-08-09T04:00:00.000Z");
  assert.equal(result.isBeforeFirstRosterSlot, true);
  assert.equal(result.isAfterDueSlot, false);
  assert.equal(result.freshSnapshotExists, false);
  assert.equal(result.staleSnapshotExists, false);
  assert.equal(result.openRosterJobExists, false);
  assert.equal(result.terminalRosterJobExists, false);
  assert.equal(result.currentJstTime, "2026-08-09T08:32:00+09:00");
});

test("stale snapshotは再取得slot前なら再取得予定として待機する", () => {
  const result = getV3RosterStatusDecision({
    game,
    now: "2026-08-08T23:32:00.000Z",
    snapshot: { ...missingSnapshot, internalGameId: game.internalGameId, staleReason: "ROSTER_SNAPSHOT_CAPTURE_DATE_STALE" },
    jobs: []
  });
  assert.equal(result.severity, "WAITING");
  assert.equal(result.reasonCode, "ROSTER_SNAPSHOT_STALE_REFETCH_SCHEDULED");
  assert.equal(result.staleSnapshotExists, true);
});

test("取得slot後にsnapshotもopen roster jobもなければ取得漏れとして注意する", () => {
  const result = getV3RosterStatusDecision({
    game,
    now: "2026-08-09T04:20:00.000Z",
    snapshot: missingSnapshot,
    jobs: []
  });
  assert.equal(result.severity, "ATTENTION");
  assert.equal(result.reasonCode, "ROSTER_SNAPSHOT_MISSING_AFTER_DUE");
  assert.equal(result.isAfterDueSlot, true);
});

test("取得slot後のopen roster jobは取得中として待機する", () => {
  const result = getV3RosterStatusDecision({
    game,
    now: "2026-08-09T04:20:00.000Z",
    snapshot: missingSnapshot,
    jobs: [{ job_type: "roster_fetch", status: "pending", scheduled_at: "2026-08-09T04:10:00.000Z", next_retry_at: null }]
  });
  assert.equal(result.severity, "WAITING");
  assert.equal(result.reasonCode, "ROSTER_FETCH_PENDING");
  assert.equal(result.openRosterJobExists, true);
});

test("取得成功は変更なしと変更ありをOKとして区別し、失敗はsnapshotを成功扱いにしない", () => {
  const fresh = { exists: true, isFresh: true, isStale: false, staleReason: null };
  assert.deepEqual(
    { severity: getV3RosterStatusDecision({ game, now: "2026-08-09T04:20:00.000Z", snapshot: fresh, noticeState: "ROSTER_NO_CHANGES", sourceSnapshotComparison: { status: "OK", remainingMismatch: false } }).severity,
      reasonCode: getV3RosterStatusDecision({ game, now: "2026-08-09T04:20:00.000Z", snapshot: fresh, noticeState: "ROSTER_NO_CHANGES", sourceSnapshotComparison: { status: "OK", remainingMismatch: false } }).reasonCode },
    { severity: "OK", reasonCode: "ROSTER_NO_CHANGES" }
  );
  assert.equal(getV3RosterStatusDecision({ game, now: "2026-08-09T04:20:00.000Z", snapshot: fresh, noticeState: "ROSTER_CHANGES_CAPTURED", sourceSnapshotComparison: { status: "OK", remainingMismatch: false } }).reasonCode, "ROSTER_CHANGES_CAPTURED");
  const failed = getV3RosterStatusDecision({
    game,
    now: "2026-08-09T04:20:00.000Z",
    snapshot: missingSnapshot,
    jobs: [{ job_type: "roster_fetch", status: "failed", failure_code: "ROSTER_PARSE_FAILED", scheduled_at: "2026-08-09T04:10:00.000Z" }]
  });
  assert.equal(failed.severity, "ATTENTION");
  assert.equal(failed.reasonCode, "ROSTER_PARSE_FAILED");
  assert.equal(failed.freshSnapshotExists, false);
});
