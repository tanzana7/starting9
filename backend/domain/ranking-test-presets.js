import {
  createFightersPlayerId,
  findFightersPlayerByName,
  FIGHTERS_TEAM_CODE,
  FIGHTERS_TEAM_ID
} from "../../fighters-player-master.js";

export const RANKING_TEST_PRESET_VERSION = 1;

const POSITION_LABELS = Object.freeze({
  0: "DH",
  1: "P",
  2: "C",
  3: "1B",
  4: "2B",
  5: "3B",
  6: "SS",
  7: "LF",
  8: "CF",
  9: "RF"
});

const POSITION_NAMES = Object.freeze({
  0: "指",
  1: "投",
  2: "捕",
  3: "一",
  4: "二",
  5: "三",
  6: "遊",
  7: "左",
  8: "中",
  9: "右"
});

const DEFINITIONS = Object.freeze({
  1: Object.freeze([
    ["水谷瞬", 7], ["水野達稀", 6], ["レイエス", 0], ["野村佑希", 9], ["清宮幸太郎", 3],
    ["有薗直輝", 5], ["奈良間大己", 4], ["田宮裕涼", 2], ["五十幡亮汰", 8]
  ]),
  2: Object.freeze([
    ["水野達稀", 6], ["水谷瞬", 7], ["レイエス", 0], ["清宮幸太郎", 3], ["吉田賢吾", 9],
    ["大塚瑠晏", 4], ["カストロ", 8], ["田宮裕涼", 2], ["奈良間大己", 5]
  ]),
  3: Object.freeze([
    ["郡司裕也", 3], ["水野達稀", 6], ["レイエス", 0], ["有薗直輝", 5], ["野村佑希", 7],
    ["万波中正", 9], ["カストロ", 8], ["山縣秀", 4], ["進藤勇也", 2]
  ]),
  4: Object.freeze([
    ["五十幡亮汰", 8], ["水野達稀", 6], ["レイエス", 0], ["野村佑希", 9], ["吉田賢吾", 7],
    ["清宮幸太郎", 3], ["大塚瑠晏", 4], ["郡司裕也", 2], ["山縣秀", 5]
  ]),
  5: Object.freeze([
    ["万波中正", 9], ["水野達稀", 6], ["レイエス", 0], ["野村佑希", 8], ["清宮幸太郎", 3],
    ["吉田賢吾", 7], ["郡司裕也", 2], ["有薗直輝", 5], ["カストロ", 4]
  ]),
  6: Object.freeze([
    ["水野達稀", 6], ["万波中正", 9], ["レイエス", 0], ["カストロ", 8], ["清宮幸太郎", 3],
    ["野村佑希", 5], ["奈良間大己", 4], ["田宮裕涼", 2], ["水谷瞬", 7]
  ]),
  7: Object.freeze([
    ["今川優馬", 7], ["山縣秀", 6], ["レイエス", 0], ["野村佑希", 9], ["カストロ", 8],
    ["吉田賢吾", 3], ["有薗直輝", 5], ["奈良間大己", 4], ["進藤勇也", 2]
  ]),
  8: Object.freeze([
    ["郡司裕也", 5], ["水野達稀", 6], ["レイエス", 0], ["万波中正", 9], ["大塚瑠晏", 4],
    ["野村佑希", 7], ["清宮幸太郎", 3], ["細川凌平", 8], ["田宮裕涼", 2]
  ]),
  9: Object.freeze([
    ["水野達稀", 6], ["郡司裕也", 2], ["レイエス", 0], ["万波中正", 9], ["野村佑希", 5],
    ["清宮幸太郎", 3], ["吉田賢吾", 7], ["細川凌平", 8], ["山縣秀", 4]
  ])
});

function definitionForSlot(slot) {
  return DEFINITIONS[Number(slot)] || null;
}

export function getRankingTestPresetDefinition(slot) {
  const definition = definitionForSlot(slot);
  return definition ? definition.map(([playerName, position], index) => ({
    battingOrder: index + 1,
    playerName,
    position,
    positionLabel: POSITION_LABELS[position]
  })) : [];
}

export function resolveRankingTestPreset(slot) {
  const normalizedSlot = Number(slot);
  const definition = definitionForSlot(normalizedSlot);
  if (!Number.isInteger(normalizedSlot) || !definition) {
    return { ok: false, slot: null, presetVersion: RANKING_TEST_PRESET_VERSION, definition: [], lineup: [], unresolvedPlayers: [], code: "RANKING_TEST_PRESET_SLOT_INVALID", error: "固定プリセットslotが不正です。" };
  }
  const unresolvedPlayers = [];
  const lineup = definition.map(([playerName, position], index) => {
    const player = findFightersPlayerByName(playerName);
    if (!player) {
      unresolvedPlayers.push({ battingOrder: index + 1, playerName });
      return null;
    }
    return {
      battingOrder: index + 1,
      playerId: createFightersPlayerId(player.uniformNumber),
      teamId: FIGHTERS_TEAM_ID,
      teamCode: FIGHTERS_TEAM_CODE,
      uniformNumber: player.uniformNumber,
      playerName: player.name,
      displayName: player.name,
      position: POSITION_NAMES[position],
      resolutionStatus: "resolved",
      rawPlayerName: playerName
    };
  });
  if (unresolvedPlayers.length) {
    return {
      ok: false,
      slot: normalizedSlot,
      presetVersion: RANKING_TEST_PRESET_VERSION,
      definition: getRankingTestPresetDefinition(normalizedSlot),
      lineup: [],
      unresolvedPlayers,
      code: "RANKING_TEST_PRESET_PLAYER_UNRESOLVED",
      error: `TEST ${normalizedSlot}の固定プリセットに未解決選手があります。`
    };
  }
  const resolvedIds = lineup.map((player) => player.playerId);
  const positions = lineup.map((player) => player.position).filter((position) => position !== "指");
  if (new Set(resolvedIds).size !== resolvedIds.length || new Set(positions).size !== positions.length) {
    return {
      ok: false,
      slot: normalizedSlot,
      presetVersion: RANKING_TEST_PRESET_VERSION,
      definition: getRankingTestPresetDefinition(normalizedSlot),
      lineup,
      unresolvedPlayers: [],
      code: "RANKING_TEST_PRESET_INVALID",
      error: `TEST ${normalizedSlot}の固定プリセットに重複があります。`
    };
  }
  return {
    ok: true,
    slot: normalizedSlot,
    presetVersion: RANKING_TEST_PRESET_VERSION,
    definition: getRankingTestPresetDefinition(normalizedSlot),
    lineup,
    unresolvedPlayers: [],
    code: "",
    error: ""
  };
}

export function getRankingTestPresetSummaries() {
  return Object.fromEntries(Object.keys(DEFINITIONS).map((slot) => {
    const preset = resolveRankingTestPreset(slot);
    return [slot, {
      slot: Number(slot),
      presetVersion: preset.presetVersion,
      ok: preset.ok,
      definition: preset.definition,
      lineup: preset.lineup,
      unresolvedPlayers: preset.unresolvedPlayers,
      code: preset.code,
      error: preset.error
    }];
  }));
}
