import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIGHTERS_PLAYER_MASTER,
  findFightersPlayerByName,
  resolveFightersRosterEntry
} from "../fighters-player-master.js";
import {
  applyLiveRosterToManualLineupCatalog
} from "../backend/automation-v3/manual-roster-repository.js";
import { getManualLineupPlayerCatalog, normalizeManualLineupInput } from "../auth-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
const playersSource = fs.readFileSync(path.join(root, "players.js"), "utf8");

test("legacy initial aliases resolve to the existing Fighters canonical identities", () => {
  assert.equal(findFightersPlayerByName("Fレイエス")?.uniformNumber, "99");
  assert.equal(findFightersPlayerByName("Rカストロ")?.uniformNumber, "6");
  assert.deepEqual(resolveFightersRosterEntry({ name: "Fレイエス", number: "99" }).player, {
    name: "レイエス",
    uniformNumber: "99",
    aliases: ["レイエス", "F.レイエス", "Ｆ．レイエス", "Fレイエス"]
  });
  assert.deepEqual(resolveFightersRosterEntry({ name: "Rカストロ", number: "6" }).player, {
    name: "カストロ",
    uniformNumber: "6",
    aliases: ["カストロ", "R.カストロ", "Ｒ．カストロ", "Rカストロ"]
  });
});

test("live legacy aliases do not create duplicate public/admin candidates", () => {
  const catalog = getManualLineupPlayerCatalog();
  const merged = applyLiveRosterToManualLineupCatalog(catalog, {
    sourceOfTruth: "official_live",
    capturedAt: "2026-09-15T00:00:00.000Z",
    players: [
      { playerId: "npb:12345678", name: "Fレイエス", number: "99", position: "外野手" },
      { playerId: "npb:87654321", name: "Rカストロ", number: "6", position: "内野手" }
    ]
  });

  assert.deepEqual(merged.filter((player) => player.uniformNumber === "99").map((player) => player.playerId), ["F-99"]);
  assert.deepEqual(merged.filter((player) => player.uniformNumber === "6").map((player) => player.playerId), ["F-6"]);
  assert.equal(merged.filter((player) => player.isTemporaryCandidate).length, 0);
});

test("alias入力の正式スタメンはcanonical playerIdへ正規化される", () => {
  const positions = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
  const ids = ["F-2", "F-3", "F-10", "F-33", "F-38", "F-57", "F-60", "F-64", "F-99"];
  const masterById = new Map(FIGHTERS_PLAYER_MASTER.map((player) => [`F-${player.uniformNumber}`, player]));
  const lineup = ids.map((playerId, index) => {
    const player = masterById.get(playerId);
    return {
      battingOrder: index + 1,
      position: positions[index],
      playerId,
      uniformNumber: player.uniformNumber,
      playerName: index === 8 ? "Fレイエス" : player.name
    };
  });

  const result = normalizeManualLineupInput(lineup);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.lineup[8].playerId, "F-99");
  assert.equal(result.lineup[8].playerName, "レイエス");
});

test("public candidate merge compares explicit aliases with the same uniform number", () => {
  assert.match(playersSource, /"Rカストロ"/);
  assert.match(playersSource, /"Fレイエス"/);
  assert.match(publicSource, /Array\.isArray\(player\?\.aliases\)/);
});
