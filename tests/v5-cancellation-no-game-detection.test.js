import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isV3GameEligible } from "../backend/automation-v3/domain.js";
import { isScheduleUnavailable } from "../backend/automation-v3/schedule-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authWorker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

function game(gameStatus) {
  return {
    internalGameId: "game-v5-status",
    gameStatus,
    isActive: 1,
    deletedAt: null
  };
}

test("cancelled/no_gameは通常のscore・ranking・publish対象外だがpredictionは保持される", () => {
  for (const status of ["cancelled", "no_game"]) {
    assert.equal(isV3GameEligible(game(status)), false);
    assert.equal(isScheduleUnavailable(status), true);
  }
  assert.match(authWorker, /GAME_NO_GAME/);
  assert.match(authWorker, /no_game_after_start/);
  const statusHandlerStart = authWorker.indexOf("async function applyOfficialGameCancellation");
  const statusHandlerEnd = authWorker.indexOf("async function loadV3GameTarget");
  const statusHandler = authWorker.slice(statusHandlerStart, statusHandlerEnd);
  assert.doesNotMatch(statusHandler, /DELETE FROM predictions/);
});

test("旧式タイムラインと公開画面もno_gameを利用不可として扱う", () => {
  const pregame = fs.readFileSync(path.join(root, "pregame-automation.js"), "utf8");
  const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
  assert.match(pregame, /\["cancelled", "canceled", "postponed", "no_game"\]/);
  assert.match(script, /gameStatus === "no_game"/);
  assert.match(script, /shortLabel: "ノーゲーム"/);
});

test("no_gameはservice_unavailableへ変換されずcanonical除外へ進む", () => {
  assert.match(authWorker, /requestedStatus === "no_game"/);
  assert.match(authWorker, /status: requestedStatus/);
  assert.match(authWorker, /RANKING_ELIGIBILITY_STATUS\.EXCLUDED/);
  assert.match(authWorker, /transitionV3State\(env\.AUTH_DB, \{ internalGameId, from: stateBefore, to: "excluded"/);
});

test("外部statusの一時障害と未知値をno_game扱いしない", () => {
  assert.match(authWorker, /GAME_NO_GAME/);
  assert.match(authWorker, /NPB_HTTP_ERROR/);
  assert.match(authWorker, /unknown/);
});
