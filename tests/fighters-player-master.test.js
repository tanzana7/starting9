import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createFightersPlayerId,
  findFightersPlayerByName,
  inspectFightersRosterMaster,
  resolveFightersRosterEntry
} from "../fighters-player-master.js";

const root = path.join(import.meta.dirname, "..");
const publicPlayers = fs.readFileSync(path.join(root, "players.js"), "utf8");

test("常谷拓輝は公開players masterに公式登録区分とアプリ補完ポジションを持つ", () => {
  assert.match(publicPlayers, /name:\s*"常谷拓輝"[\s\S]*?uniformNumber:\s*"95"/);
  assert.match(publicPlayers, /name:\s*"常谷拓輝"[\s\S]*?registeredPosition:\s*"内野手"/);
  assert.match(publicPlayers, /name:\s*"常谷拓輝"[\s\S]*?positions:\s*\["二", "遊", "三"\]/);
});

test("常谷拓輝はスペース・カナを含む既存alias方式とF-背番号IDで解決できる", () => {
  for (const name of ["常谷 拓輝", "常谷拓輝", "常谷", "ツネヤ ヒロキ", "ツネヤヒロキ"]) {
    const player = findFightersPlayerByName(name);
    assert.equal(player?.name, "常谷拓輝", name);
    assert.equal(player?.uniformNumber, "95");
  }
  const resolved = resolveFightersRosterEntry({ number: "95", name: "常谷 拓輝" });
  assert.equal(resolved.player?.name, "常谷拓輝");
  assert.equal(createFightersPlayerId(resolved.player?.uniformNumber), "F-95");
});

test("source rosterの未解決選手は捨てずにreason code付きATTENTION情報へ変換する", () => {
  const result = inspectFightersRosterMaster([
    { number: "95", name: "常谷 拓輝", position: "内野手" },
    { number: "999", name: "未登録選手", position: "内野手" }
  ]);
  assert.equal(result.status, "attention");
  assert.equal(result.reasonCode, "ROSTER_PLAYER_MISSING_FROM_MASTER");
  assert.equal(result.unresolvedCount, 1);
  assert.equal(result.unresolvedPlayers[0].name, "未登録選手");
});

test("sourceの名前と背番号が別選手を指す場合は捏造せずunmappedにする", () => {
  const result = resolveFightersRosterEntry({ number: "95", name: "矢澤宏太" });
  assert.equal(result.player, null);
  assert.equal(result.reasonCode, "ROSTER_PLAYER_UNMAPPED_FROM_SOURCE");
});
