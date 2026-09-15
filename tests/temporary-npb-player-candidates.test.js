import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyLiveRosterToManualLineupCatalog,
  normalizeOfficialNpbPlayerId
} from "../backend/automation-v3/manual-roster-repository.js";
import { getManualLineupPlayerCatalog, normalizeManualLineupInput } from "../auth-worker.js";
import { parseRosterTableEntries } from "../cloudflare-worker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const publicSource = fs.readFileSync(path.join(root, "script.js"), "utf8");

test("NPB公式選手リンクからだけ恒久的な一時IDを抽出する", () => {
  const entries = parseRosterTableEntries(`
    <table><tr><td>外野手</td><td>201</td><td><a href="/bis/players/63165155.html">新規 野手</a></td></tr>
    <tr><td>投手</td><td>202</td><td><a href="https://npb.jp/bis/players/51755155.html">新規 投手</a></td></tr>
    <tr><td>外野手</td><td>203</td><td>リンクなし</td></tr></table>
  `);
  assert.equal(entries[0].playerId, "npb:63165155");
  assert.equal(entries[0].officialPlayerUrl, "https://npb.jp/bis/players/63165155.html");
  assert.equal(entries[1].playerId, "npb:51755155");
  assert.equal(entries[2].playerId, undefined);
  assert.equal(normalizeOfficialNpbPlayerId("npb:63165155"), "npb:63165155");
  assert.equal(normalizeOfficialNpbPlayerId("F-201"), "");
});

test("master既知選手のF-IDを維持し、公式ID付きunknownだけを一時候補へ追加する", () => {
  const catalog = [
    { playerId: "F-53", playerName: "水谷瞬", uniformNumber: "53", candidateVisibility: "auto" }
  ];
  const result = applyLiveRosterToManualLineupCatalog(catalog, {
    sourceOfTruth: "official_live",
    capturedAt: "2026-09-15T00:00:00.000Z",
    players: [
      { playerId: "npb:oldknown", name: "水谷瞬", number: "53", position: "外野手" },
      { playerId: "npb:63165155", name: "新規野手", number: "201", position: "外野手" },
      { playerId: "npb:51755155", name: "新規投手", number: "202", position: "投手" },
      { name: "IDなし野手", number: "203", position: "外野手" },
      { playerId: "npb:63165156", name: "同名", number: "204", position: "外野手" },
      { playerId: "npb:63165157", name: "同名", number: "205", position: "外野手" }
    ]
  });
  assert.equal(result.find((player) => player.playerName === "水谷瞬").playerId, "F-53");
  const temporary = result.filter((player) => player.isTemporaryCandidate);
  assert.deepEqual(temporary.map((player) => player.playerId), [
    "npb:63165155", "npb:51755155", "npb:63165156", "npb:63165157"
  ]);
  assert.equal(temporary.find((player) => player.playerId === "npb:63165155").candidateVisibility, "auto");
  assert.equal(temporary.find((player) => player.playerId === "npb:51755155").candidateVisibility, "hide");
  assert.equal(temporary.find((player) => player.playerId === "npb:63165155").identitySource, "npb-live");
  assert.equal(result.unknownOfficialPlayers.length, 4);
});

test("同じ名前でも公式IDが違えば一時候補を分離し、背番号変更後もIDを維持する", () => {
  const first = applyLiveRosterToManualLineupCatalog([], { players: [
    { playerId: "npb:63165155", name: "同名選手", number: "201", position: "外野手" }
  ] });
  const changed = applyLiveRosterToManualLineupCatalog([], { players: [
    { playerId: "npb:63165155", name: "同名選手", number: "99", position: "外野手" }
  ] });
  assert.equal(first[0].playerId, changed[0].playerId);
  assert.equal(changed[0].uniformNumber, "99");
});

test("正式lineupは同一公式rosterで三点一致した一時野手だけ受け入れ、任意IDは拒否する", () => {
  const base = getManualLineupPlayerCatalog().slice(0, 8).map((player, index) => ({
    playerName: player.playerName,
    uniformNumber: player.uniformNumber,
    position: ["捕", "一", "二", "三", "遊", "左", "中", "右"][index],
    battingOrder: index + 1
  }));
  const temporary = {
    playerId: "npb:63165155",
    playerName: "新規野手",
    uniformNumber: "201",
    position: "指",
    battingOrder: 9
  };
  const trusted = normalizeManualLineupInput([...base, temporary], {
    trustedTemporaryPlayers: [{ playerId: "npb:63165155", name: "新規野手", number: "201", position: "外野手" }]
  });
  assert.equal(trusted.ok, true, trusted.error);
  assert.equal(trusted.lineup[8].playerId, "npb:63165155");
  assert.equal(trusted.lineup[8].resolutionStatus, "temporary_npb");
  assert.equal(normalizeManualLineupInput([...base, temporary]).ok, false);
  assert.equal(normalizeManualLineupInput([...base, { ...temporary, playerName: "別名" }], {
    trustedTemporaryPlayers: [{ playerId: "npb:63165155", name: "新規野手", number: "201", position: "外野手" }]
  }).ok, false);
});

test("public/adminはlive temporary fielderを同じ候補IDで扱い、pitcherは非表示にする", () => {
  assert.match(authSource, /masterUnregisteredCount/);
  assert.match(authSource, /normalizeOfficialNpbPlayerId/);
  assert.match(publicSource, /getPredictionCandidatePlayers/);
  assert.match(publicSource, /isTemporaryCandidate: true/);
  assert.match(publicSource, /temporaryPublicPlayerCategory/);
  assert.match(publicSource, /teamId: "F"/);
  assert.match(publicSource, /isBatterCandidate: true/);
});

test("保存済みtemporary predictionは採点時に再検証できるが、通常入力はtrusted rosterなしで受け入れない", () => {
  assert.match(authSource, /allowTemporaryPlayerIds: true/);
  assert.match(authSource, /getTrustedTemporaryPlayersForPrediction/);
  assert.match(authSource, /sanitizePredictionPayload\(requestedPrediction, \{ trustedTemporaryPlayers \}\)/);
});
