import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  compareV3RosterSourceSnapshot,
  getV3RosterStatusDecision
} from "../game-automation-v3.js";

const game = {
  internalGameId: "2e052ab5-17d3-4e7d-be57-e0b9adc51ec4",
  gameDate: "2026-08-14",
  startAt: "2026-08-14T09:00:00.000Z"
};

const sourceRoster = [
  { number: "61", name: "今川優馬", position: "外野手" },
  { number: "25", name: "宮西尚生", position: "投手" }
];

const oldSnapshot = [
  { number: "12", name: "矢澤宏太", position: "外野手" }
];

const adminWorker = fs.readFileSync(new URL("../auth-worker.js", import.meta.url), "utf8");
const rosterRenderer = fs.readFileSync(new URL("../frontend/admin-v3/render-roster.js", import.meta.url), "utf8");

test("sourceに今川がいてsnapshotにいない場合はATTENTION理由を返す", () => {
  const result = compareV3RosterSourceSnapshot({
    sourceRoster,
    snapshotRoster: oldSnapshot,
    sourceDate: "2026-08-14",
    sourceFetchedAt: "2026-08-14T08:00:00.000Z",
    snapshotCapturedAt: "2026-08-14T07:11:22.741Z"
  });

  assert.equal(result.status, "ATTENTION");
  assert.equal(result.mismatch, true);
  assert.equal(result.stale, true);
  assert.ok(result.reasonCodes.includes("ROSTER_EXPECTED_PLAYER_MISSING"));
  assert.ok(result.reasonCodes.includes("ROSTER_SOURCE_SNAPSHOT_MISMATCH"));
  assert.ok(result.reasonCodes.includes("ROSTER_SNAPSHOT_STALE"));
  assert.deepEqual(result.expectedMissing.map((player) => player.name), ["今川優馬", "宮西尚生"]);
  assert.deepEqual(result.removedStillPresent.map((player) => player.name), ["矢澤宏太"]);
  assert.equal(result.playerCountDelta, 1);
  assert.equal(result.fingerprintMatched, false);
  assert.deepEqual(result.officialOnly.map((player) => player.name), ["今川優馬", "宮西尚生"]);
  assert.deepEqual(result.snapshotOnly.map((player) => player.name), ["矢澤宏太"]);
});

test("sourceから消えた矢澤がsnapshotに残る場合は専用理由を返す", () => {
  const result = compareV3RosterSourceSnapshot({
    sourceRoster: [{ number: "61", name: "今川優馬" }],
    snapshotRoster: [{ number: "61", name: "今川優馬" }, { number: "12", name: "矢澤宏太" }]
  });

  assert.equal(result.reasonCode, "ROSTER_REMOVED_PLAYER_STILL_PRESENT");
  assert.ok(result.reasonCodes.includes("ROSTER_REMOVED_PLAYER_STILL_PRESENT"));
  assert.equal(result.removedStillPresent[0].name, "矢澤宏太");
});

test("sourceとsnapshotが一致する場合はATTENTIONにしない", () => {
  const fingerprint = "same-fingerprint";
  const result = compareV3RosterSourceSnapshot({
    sourceRoster,
    snapshotRoster: sourceRoster,
    sourceFetchedAt: "2026-08-14T08:00:00.000Z",
    snapshotCapturedAt: "2026-08-14T08:00:00.000Z",
    sourceFingerprint: fingerprint,
    snapshotFingerprint: fingerprint
  });

  assert.equal(result.status, "OK");
  assert.equal(result.mismatch, false);
  assert.deepEqual(result.reasonCodes, []);
  assert.equal(result.fingerprintMatched, true);
  assert.equal(result.verifiedAt, "2026-08-14T08:00:00.000Z");
});

test("同じ背番号でも登録区分が変わったsource/snapshotは一致扱いしない", () => {
  const result = compareV3RosterSourceSnapshot({
    sourceRoster: [{ number: "8", name: "淺間大基", position: "外野手" }],
    snapshotRoster: [{ number: "8", name: "淺間大基", position: "投手" }]
  });

  assert.equal(result.mismatch, true);
  assert.ok(result.reasonCodes.includes("ROSTER_EXPECTED_PLAYER_MISSING"));
  assert.ok(result.reasonCodes.includes("ROSTER_REMOVED_PLAYER_STILL_PRESENT"));
});

test("fresh snapshotでもsource/snapshot差分が残ればroster判定はATTENTION", () => {
  const result = getV3RosterStatusDecision({
    game,
    now: "2026-08-14T09:30:00.000Z",
    snapshot: { exists: true, isFresh: true },
    sourceSnapshotComparison: {
      status: "ATTENTION",
      remainingMismatch: true,
      reasonCode: "ROSTER_REMOVED_PLAYER_STILL_PRESENT",
      reasonCodes: ["ROSTER_REMOVED_PLAYER_STILL_PRESENT", "ROSTER_SOURCE_SNAPSHOT_MISMATCH"]
    }
  });

  assert.equal(result.severity, "ATTENTION");
  assert.equal(result.reasonCode, "ROSTER_REMOVED_PLAYER_STILL_PRESENT");
});

test("fresh snapshotでも公式liveとの照合前は成功扱いしない", () => {
  const result = getV3RosterStatusDecision({
    game,
    now: "2026-08-14T09:30:00.000Z",
    snapshot: { exists: true, isFresh: true }
  });

  assert.equal(result.severity, "ATTENTION");
  assert.equal(result.reasonCode, "ROSTER_SNAPSHOT_LIVE_CHECK_REQUIRED");
  assert.equal(result.snapshotVerificationRequired, true);
});

test("source/snapshot比較はauditとadmin roster表示へ接続される", () => {
  assert.match(adminWorker, /sourceSnapshotComparison/);
  assert.match(adminWorker, /previousSnapshotComparison/);
  assert.match(rosterRenderer, /sourceに存在・snapshot欠落/);
  assert.match(rosterRenderer, /snapshot残存選手/);
});
