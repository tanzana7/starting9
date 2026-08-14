import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveV3PhaseStatus,
  getV3ProbableStarterHealthDecision,
  getV3ProbableStarterPollingSlots
} from "../game-automation-v3.js";

const game = {
  internalGameId: "2e052ab5-17d3-4e7d-be57-e0b9adc51ec4",
  gameDate: "2026-08-14",
  startAt: "2026-08-14T09:00:00.000Z",
  gameStatus: "scheduled",
  isActive: 1,
  deletedAt: null
};

const beforeGame = "2026-08-14T03:12:00.000Z";

test("試合開始24時間以内の未発表はATTENTIONとして理由を明示する", () => {
  const result = getV3ProbableStarterHealthDecision({ game, now: beforeGame, dataStatus: "unannounced" });
  assert.equal(result.severity, "ATTENTION");
  assert.equal(result.reasonCode, "PROBABLE_STARTER_MISSING_WITHIN_24H");
  assert.equal(new Date(result.nextCheckAt).getTime() - new Date(beforeGame).getTime() <= 60 * 60 * 1000, true);
});

test("24時間より前の未発表は通常の待機表示を維持する", () => {
  const result = deriveV3PhaseStatus({
    phase: "probable_starter",
    game,
    now: "2026-08-12T08:00:00.000Z",
    sourceStatus: "unannounced"
  });
  assert.equal(result.severity, "WAITING");
});

test("試合開始後は未発表の24時間アラートより開始後異常を優先する", () => {
  const result = getV3ProbableStarterHealthDecision({
    game,
    now: "2026-08-14T09:01:00.000Z",
    dataStatus: "unannounced"
  });
  assert.equal(result.severity, "ATTENTION");
  assert.equal(result.reasonCode, "PROBABLE_STARTER_GAME_STARTED");
});

test("identity不整合と取得失敗は別の理由コードでATTENTIONになる", () => {
  const identity = getV3ProbableStarterHealthDecision({
    game,
    now: beforeGame,
    dataStatus: "transient_error",
    errorCode: "PROBABLE_STARTER_INTERNAL_GAME_ID_MISMATCH"
  });
  const source = getV3ProbableStarterHealthDecision({
    game,
    now: beforeGame,
    dataStatus: "transient_error",
    errorCode: "NPB_HTTP_ERROR"
  });
  assert.equal(identity.reasonCode, "PROBABLE_STARTER_IDENTITY_UNRESOLVED_WITHIN_24H");
  assert.equal(source.reasonCode, "PROBABLE_STARTER_SOURCE_UNAVAILABLE_WITHIN_24H");
});

test("発表済みはATTENTIONにせず、24時間以内の再確認slotを1時間以内に返す", () => {
  const announced = getV3ProbableStarterHealthDecision({
    game,
    now: beforeGame,
    dataStatus: "announced",
    homePitcherName: "投手A",
    awayPitcherName: "投手B"
  });
  const slots = getV3ProbableStarterPollingSlots(game);
  const next = slots.find((slot) => slot.getTime() > new Date(beforeGame).getTime());
  assert.equal(announced.severity, "OK");
  assert.equal(announced.reasonCode, "PROBABLE_STARTER_ANNOUNCED");
  assert.equal(next.toISOString(), "2026-08-14T04:00:00.000Z");
});
