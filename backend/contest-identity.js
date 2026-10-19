const CANONICAL_CONTEST_TEAMS = new Set(["fighters", "marines"]);

/**
 * Produces the persisted A-series contest identity used by migration backfill.
 * Hex-encoding each component with a separator is deterministic and injective
 * for arbitrary UTF-8 game IDs; provider codes and display names never enter it.
 */
export function createContestId(internalGameId, targetTeamKey) {
  const gameId = String(internalGameId ?? "");
  const teamKey = String(targetTeamKey ?? "");
  if (!gameId.trim()) throw new TypeError("internalGameId is required");
  if (!CANONICAL_CONTEST_TEAMS.has(teamKey)) throw new TypeError("Unknown canonical contest team");
  return `contest_${Buffer.from(gameId, "utf8").toString("hex")}_${Buffer.from(teamKey, "utf8").toString("hex")}`;
}
