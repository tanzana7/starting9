import { normalizeV3InternalGameId } from "./constants.js";

// Canonical roster snapshot reads and freshness evaluation.
function getV3JstDate(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

export function getV3RosterSnapshotFreshness(snapshot, { internalGameId = "", gameDate = "" } = {}) {
  const expectedId = normalizeV3InternalGameId(internalGameId);
  const expectedDate = String(gameDate || "").slice(0, 10);
  if (!snapshot) return { isFresh: false, isStale: true, staleReason: "ROSTER_SNAPSHOT_MISSING" };
  if (String(snapshot.internal_game_id || snapshot.internalGameId || "") !== expectedId) {
    return { isFresh: false, isStale: true, staleReason: "ROSTER_SNAPSHOT_INTERNAL_GAME_ID_MISMATCH" };
  }
  if (String(snapshot.status || "") !== "captured") {
    return { isFresh: false, isStale: true, staleReason: "ROSTER_SNAPSHOT_STATUS_INVALID" };
  }
  if (Number(snapshot.player_count ?? snapshot.playerCount ?? 0) <= 0) {
    return { isFresh: false, isStale: true, staleReason: "ROSTER_SNAPSHOT_EMPTY" };
  }
  if (String(snapshot.source || "") !== "npb-roster") {
    return { isFresh: false, isStale: true, staleReason: "ROSTER_SNAPSHOT_SOURCE_UNKNOWN" };
  }
  if (!expectedDate || String(snapshot.game_date || snapshot.gameDate || "").slice(0, 10) !== expectedDate) {
    return { isFresh: false, isStale: true, staleReason: "ROSTER_SNAPSHOT_GAME_DATE_MISMATCH" };
  }
  const capturedDate = getV3JstDate(snapshot.captured_at || snapshot.capturedAt);
  if (!capturedDate) return { isFresh: false, isStale: true, staleReason: "ROSTER_SNAPSHOT_CAPTURE_TIME_INVALID" };
  if (capturedDate !== expectedDate) {
    return { isFresh: false, isStale: true, staleReason: "ROSTER_SNAPSHOT_CAPTURE_DATE_STALE" };
  }
  return { isFresh: true, isStale: false, staleReason: null };
}

export async function getV3CanonicalRosterSnapshot(db, internalGameId, { gameDate = "" } = {}) {
  const id = normalizeV3InternalGameId(internalGameId);
  try {
    const row = await db.prepare(
      `SELECT game_id, internal_game_id, game_date, source, status, player_count, captured_at, updated_at
         FROM game_roster_snapshots
        WHERE internal_game_id = ?1
        ORDER BY updated_at DESC, captured_at DESC
        LIMIT 1`
    ).bind(id).first();
    const freshness = getV3RosterSnapshotFreshness(row, { internalGameId: id, gameDate });
    return {
      schemaAvailable: true,
      exists: freshness.isFresh,
      isFresh: freshness.isFresh,
      isStale: freshness.isStale,
      staleReason: freshness.staleReason,
      gameId: row?.game_id || null,
      internalGameId: row?.internal_game_id || null,
      gameDate: row?.game_date || null,
      source: row?.source || null,
      status: row?.status || null,
      playerCount: Number(row?.player_count || 0),
      capturedAt: row?.captured_at || null,
      updatedAt: row?.updated_at || null
    };
  } catch {
    return {
      schemaAvailable: false,
      exists: false,
      isFresh: false,
      isStale: false,
      staleReason: "ROSTER_SNAPSHOT_SCHEMA_UNAVAILABLE",
      gameId: null,
      internalGameId: null,
      gameDate: null,
      source: null,
      status: null,
      playerCount: 0,
      capturedAt: null,
      updatedAt: null
    };
  }
}
