const LINEUP_SIZE = 9;

// A stored lineup is only usable when it has the minimum shape required by
// the next V3 stage. Lifecycle status and workflow state are intentionally
// excluded from this check.
export function assessV3LineupArtifact(value) {
  const diagnostics = {
    expectedPlayerCount: LINEUP_SIZE,
    playerCount: Array.isArray(value) ? value.length : 0,
    battingOrderCount: 0,
    validPositionCount: 0,
    unresolvedPlayerCount: 0,
    duplicateBattingOrderCount: 0,
    duplicatePlayerCount: 0,
    rejectionReasons: []
  };
  if (!Array.isArray(value) || value.length !== LINEUP_SIZE) {
    diagnostics.rejectionReasons.push("LINEUP_INVALID_PLAYER_COUNT");
    return { ok: false, diagnostics };
  }

  const orders = new Set();
  const players = new Set();
  for (const row of value) {
    const order = Number(row?.battingOrder ?? row?.batting_order ?? row?.order);
    const position = String(row?.position || "").trim();
    const playerId = String(row?.playerId || row?.player_id || "").trim();
    const playerName = String(row?.playerName || row?.player_name || row?.displayName || row?.display_name || "").trim();
    const uniformNumber = String(row?.uniformNumber ?? row?.uniform_number ?? "").trim();

    if (!Number.isInteger(order) || order < 1 || order > LINEUP_SIZE || orders.has(order)) {
      if (orders.has(order)) diagnostics.duplicateBattingOrderCount += 1;
      diagnostics.rejectionReasons.push("LINEUP_INVALID_BATTING_ORDER");
    } else {
      orders.add(order);
    }
    if (position) diagnostics.validPositionCount += 1;
    else diagnostics.rejectionReasons.push("LINEUP_INVALID_POSITION");
    if (!playerName && !playerId && !uniformNumber) diagnostics.rejectionReasons.push("LINEUP_PLAYER_MISSING");
    if (!playerId) diagnostics.unresolvedPlayerCount += 1;
    const identity = playerId || (uniformNumber && playerName ? `${uniformNumber}:${playerName}` : playerName);
    if (identity && players.has(identity)) {
      diagnostics.duplicatePlayerCount += 1;
      diagnostics.rejectionReasons.push("LINEUP_DUPLICATE_PLAYER");
    } else if (identity) {
      players.add(identity);
    }
  }
  diagnostics.battingOrderCount = orders.size;
  diagnostics.rejectionReasons = [...new Set(diagnostics.rejectionReasons)];
  return { ok: diagnostics.rejectionReasons.length === 0, diagnostics };
}
