import assert from "node:assert/strict";
import test from "node:test";
import {
  getWorkflowJobErrorCode,
  isCompletionWorkflowErrorRetryable,
  validateWorkflowJobTarget
} from "../auth-worker.js";

const internalGameId = "12d554bb-ad25-44be-8159-0134c046dcee";
const gameRow = {
  game_date: "2026-08-02",
  start_time: "2026-08-02T04:00:00.000Z",
  home_team: "fighters",
  away_team: "marines",
  game_status: "scheduled"
};
const scheduleRow = {
  game_id: "2026-08-02-fighters-marines-1300",
  source_game_key: "2026-08-02:fighters:marines:13:00",
  game_date: "2026-08-02",
  start_at: "2026-08-02T04:00:00.000Z",
  home_team: "fighters",
  away_team: "marines",
  game_code: "",
  game_status: "scheduled",
  internal_game_id: internalGameId
};
const identifiers = [
  { identifier_type: "descriptive_game_id", identifier_value: "2026-08-02-fighters-marines-1300" },
  { identifier_type: "source_game_key", identifier_value: "2026-08-02:fighters:marines:13:00" }
];

test("8月2日の対象はNPB codeが空でもUUIDとschedule identityから有効になる", () => {
  const result = validateWorkflowJobTarget({
    internalGameId,
    gameRow,
    scheduleRows: [scheduleRow],
    identifiers,
    staticGameCode: "f-m-16"
  });
  assert.equal(result.valid, true);
  assert.equal(result.target.gameCode, "f-m-16");
  assert.equal(result.targetResolution.npbGameCodePresent, false);
  assert.equal(result.targetResolution.resolvedBy, "sourceGameKey");
  assert.equal(result.targetResolution.validationStage, "job_target_resolution");
  assert.deepEqual(result.targetResolution.missingFields, []);
});

test("NPB codeが空でも取得先補完なしの対象解決は有効のまま保持する", () => {
  const result = validateWorkflowJobTarget({
    internalGameId,
    gameRow,
    scheduleRows: [scheduleRow],
    identifiers
  });
  assert.equal(result.valid, true);
  assert.equal(result.target.gameCode, "");
});

test("schedule未リンク、識別子競合、逆カードは対象解決エラーになる", () => {
  const withoutSchedule = validateWorkflowJobTarget({ internalGameId, gameRow, identifiers });
  assert.equal(withoutSchedule.valid, false);
  assert.equal(withoutSchedule.code, "GAME_TARGET_INVALID");
  assert.deepEqual(withoutSchedule.targetResolution.missingFields, ["scheduleRow"]);

  const conflict = validateWorkflowJobTarget({
    internalGameId,
    gameRow,
    scheduleRows: [scheduleRow],
    identifiers,
    identifierConflicts: [{
      internal_game_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      provider: "starting9",
      identifier_type: "descriptive_game_id",
      identifier_value: scheduleRow.game_id
    }]
  });
  assert.equal(conflict.valid, false);
  assert.equal(conflict.code, "GAME_TARGET_IDENTIFIER_CONFLICT");

  const reverse = validateWorkflowJobTarget({
    internalGameId,
    gameRow,
    scheduleRows: [{ ...scheduleRow, home_team: "marines", away_team: "fighters" }],
    identifiers
  });
  assert.equal(reverse.valid, false);
  assert.equal(reverse.code, "GAME_TARGET_INVALID");
  assert.equal(reverse.targetResolution.targetValidityReason, "schedule_game_mismatch");
});

test("cancelled and test games are not valid completion targets", () => {
  const cancelled = validateWorkflowJobTarget({
    internalGameId,
    gameRow,
    scheduleRows: [{ ...scheduleRow, game_status: "cancelled" }],
    identifiers
  });
  assert.equal(cancelled.valid, false);
  assert.equal(cancelled.targetResolution.targetValidityReason, "cancelled_game");

  const testGame = validateWorkflowJobTarget({
    internalGameId,
    gameRow,
    scheduleRows: [scheduleRow],
    identifiers,
    isTestGame: true
  });
  assert.equal(testGame.valid, false);
  assert.equal(testGame.targetResolution.targetValidityReason, "test_game");
});

test("target validation is distinct from parser validation and transient upstream failures", () => {
  assert.equal(getWorkflowJobErrorCode({ code: "GAME_TARGET_INVALID" }), "GAME_TARGET_INVALID");
  assert.equal(getWorkflowJobErrorCode({ code: "LINEUP_INVALID_PLAYER_COUNT" }), "DATA_VALIDATION_FAILED");
  assert.equal(getWorkflowJobErrorCode({ code: "NPB_HTTP_ERROR" }), "EXTERNAL_HTTP_ERROR");
  assert.equal(getWorkflowJobErrorCode({ code: "LINEUP_NOT_ANNOUNCED" }), "DATA_NOT_ANNOUNCED");
  assert.equal(isCompletionWorkflowErrorRetryable({ code: "GAME_TARGET_INVALID", retryable: false }, "GAME_TARGET_INVALID"), false);
  assert.equal(isCompletionWorkflowErrorRetryable({ code: "NPB_HTTP_ERROR" }, "EXTERNAL_HTTP_ERROR"), true);
  assert.equal(isCompletionWorkflowErrorRetryable({ code: "LINEUP_INVALID_PLAYER_COUNT" }, "DATA_VALIDATION_FAILED"), false);
  assert.equal(isCompletionWorkflowErrorRetryable({ code: "NPB_GAME_CODE_UNAVAILABLE", retryable: true }, "NPB_GAME_CODE_UNAVAILABLE"), true);
});
