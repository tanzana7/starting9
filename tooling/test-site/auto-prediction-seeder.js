import { TEST_TEAMS, testPredictionPlayerId } from "./teams.js";

const POSITION_SEQUENCE = Object.freeze(["捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);

function createRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pickDistinct(random, size, excluded = -1) {
  if (size < 2) throw new Error("Synthetic prediction variation requires at least two choices");
  let value = Math.floor(random() * size);
  if (value === excluded) value = (value + 1 + Math.floor(random() * (size - 1))) % size;
  return value;
}

function normalizeRoster(roster, targetTeam) {
  if (!Array.isArray(roster) || roster.length < 15 || !Object.hasOwn(TEST_TEAMS, targetTeam)) {
    throw new Error("Synthetic predictions require the selected Test Site roster");
  }
  const expectedTeamId = TEST_TEAMS[targetTeam].playerTeamId;
  const normalized = roster.map((player) => ({
    playerId: String(player?.playerId || "").trim(),
    name: String(player?.name || player?.playerName || "").trim(),
    uniformNumber: String(player?.uniformNumber ?? player?.number ?? "").trim(),
    teamCode: String(player?.teamCode || ""),
    teamId: String(player?.teamId || "")
  }));
  if (normalized.some((player) => !player.playerId || !player.name
      || !/^\d{1,3}$/.test(player.uniformNumber)
      || player.teamCode !== targetTeam || player.teamId !== expectedTeamId)
      || new Set(normalized.map((player) => player.playerId)).size !== normalized.length
      || new Set(normalized.map((player) => player.uniformNumber)).size !== normalized.length) {
    throw new Error("Synthetic prediction roster contains invalid or cross-team players");
  }
  return normalized;
}

/**
 * Generate reproducible, API-shaped predictions from the selected team's
 * captured Test roster. The first entry intentionally mirrors the simulator's
 * default official lineup; later entries introduce only valid lineup changes
 * so scoring/ranking exercises the real prediction and scoring paths.
 */
export function buildSyntheticPredictions({ contestId, targetTeam, roster, userCount = 10, seed } = {}) {
  if (!String(contestId || "").trim()) throw new Error("A canonical contestId is required");
  if (!Number.isInteger(userCount) || userCount < 1 || userCount > 20) {
    throw new Error("Synthetic userCount must be between 1 and 20");
  }
  if (!Number.isSafeInteger(Number(seed))) throw new Error("Synthetic prediction seed must be an integer");

  const players = normalizeRoster(roster, targetTeam);
  const random = createRandom(seed);
  const predictions = [];

  for (let userIndex = 0; userIndex < userCount; userIndex += 1) {
    const lineup = players.slice(0, 9).map((player, index) => ({
      // Source roster IDs are provider-scoped (`npb:*`); predictions use the
      // product's canonical team-number identity, resolved from this exact
      // roster row rather than inventing a player or accepting an unknown ID.
      playerId: testPredictionPlayerId(targetTeam, player.uniformNumber),
      playerName: player.name,
      uniformNumber: player.uniformNumber,
      teamCode: targetTeam,
      teamId: player.teamId,
      battingOrder: index + 1,
      position: POSITION_SEQUENCE[index]
    }));

    if (userIndex > 0) {
      const mode = (userIndex - 1) % 3;
      if (mode === 0) {
        const left = Math.floor(random() * 9);
        const right = pickDistinct(random, 9, left);
        [lineup[left].battingOrder, lineup[right].battingOrder] = [lineup[right].battingOrder, lineup[left].battingOrder];
      } else {
        const replacements = mode === 1 ? 1 : 2;
        const bench = players.slice(9);
        const selectedBench = new Set();
        const selectedSlots = new Set();
        for (let replacement = 0; replacement < replacements; replacement += 1) {
          let slot = Math.floor(random() * 9);
          while (selectedSlots.has(slot)) slot = (slot + 1) % 9;
          let benchIndex = Math.floor(random() * bench.length);
          while (selectedBench.has(benchIndex)) benchIndex = (benchIndex + 1) % bench.length;
          selectedSlots.add(slot);
          selectedBench.add(benchIndex);
          const player = bench[benchIndex];
          lineup[slot] = {
            ...lineup[slot],
            playerId: testPredictionPlayerId(targetTeam, player.uniformNumber),
            playerName: player.name,
            uniformNumber: player.uniformNumber,
            teamId: player.teamId
          };
        }
      }
    }

    lineup.sort((left, right) => left.battingOrder - right.battingOrder);
    if (lineup.length !== 9 || new Set(lineup.map((player) => player.playerId)).size !== 9
        || lineup.some((player) => player.teamCode !== targetTeam || player.teamId !== TEST_TEAMS[targetTeam].playerTeamId)) {
      throw new Error("Generated synthetic prediction failed lineup identity validation");
    }
    predictions.push({
      label: `test-user-${String(userIndex + 1).padStart(2, "0")}`,
      prediction: { schemaVersion: 1, lineup }
    });
  }

  return predictions;
}
