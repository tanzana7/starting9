import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessV3LineupArtifact } from "../game-automation-v3.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function lineup(overrides = {}) {
  const positions = ["遊", "二", "三", "一", "左", "中", "右", "捕", "指"];
  return positions.map((position, index) => ({
    battingOrder: index + 1,
    position,
    playerId: `F-${index + 1}`,
    playerName: `選手${index + 1}`,
    uniformNumber: String(index + 1),
    ...overrides[index]
  }));
}

test("lineup artifactは9人・打順・守備・選手識別が揃った場合だけverifiedになる", () => {
  const result = assessV3LineupArtifact(lineup());
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.playerCount, 9);
  assert.equal(result.diagnostics.battingOrderCount, 9);
  assert.equal(result.diagnostics.validPositionCount, 9);
});

test("workflow stateやcompleted jobだけでは不完全なlineup artifactをverifiedにしない", () => {
  const short = assessV3LineupArtifact(lineup().slice(0, 8));
  const duplicateOrder = assessV3LineupArtifact(lineup({ 8: { battingOrder: 1 } }));
  const missingPlayer = assessV3LineupArtifact(lineup({ 3: { playerId: "", playerName: "", uniformNumber: "" } }));
  assert.equal(short.ok, false);
  assert.equal(duplicateOrder.ok, false);
  assert.equal(missingPlayer.ok, false);
  assert.match(short.diagnostics.rejectionReasons.join(","), /LINEUP_INVALID_PLAYER_COUNT/);
  assert.match(duplicateOrder.diagnostics.rejectionReasons.join(","), /LINEUP_INVALID_BATTING_ORDER/);
  assert.match(missingPlayer.diagnostics.rejectionReasons.join(","), /LINEUP_PLAYER_MISSING/);
});

test("不正な既存canonical lineupは再取得を妨げるreuse対象にしない", () => {
  const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.match(worker, /const existingArtifact = assessV3LineupArtifact\(existingLineup\)/);
  assert.match(worker, /if \(existing && existingArtifact\.ok\)/);
});
