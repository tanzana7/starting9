import teamContext from "../frontend/shared/team-context.js";

const CANONICAL_CONTEST_TEAMS = new Set(["fighters", "marines", "test-fighters", "test-foxes", "test-marines"]);

function utf8Hex(value) {
  return Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
  return `contest_${utf8Hex(gameId)}_${utf8Hex(teamKey)}`;
}

/**
 * A test bootstrap may register synthetic team contexts in its isolated D1.
 * Registry membership and a physical-game participant match are both required;
 * a request-supplied key alone is never evidence of ownership.
 */
export async function getGameContest(db, internalGameId, targetTeam, requestedContestId = "") {
  const gameId = String(internalGameId || "").trim();
  const teamKey = String(targetTeam?.key || "").trim();
  if (!gameId || !CANONICAL_CONTEST_TEAMS.has(teamKey)) {
    return { ok: false, code: "CONTEST_IDENTITY_REQUIRED" };
  }

  const [team, game] = await Promise.all([
    db.prepare("SELECT team_key FROM contest_identity_teams WHERE team_key = ?1 LIMIT 1").bind(teamKey).first(),
    db.prepare("SELECT internal_game_id, home_team, away_team FROM games WHERE internal_game_id = ?1 LIMIT 1").bind(gameId).first()
  ]);
  if (!team) return { ok: false, code: "CONTEST_TEAM_NOT_REGISTERED" };
  if (!game) return { ok: false, code: "GAME_SCHEDULE_NOT_FOUND" };

  const side = teamContext.gameSide(game, targetTeam);
  if (!side) return { ok: false, code: "CONTEST_TARGET_NOT_A_GAME_PARTICIPANT" };

  const contestId = createContestId(gameId, teamKey);
  if (requestedContestId && String(requestedContestId) !== contestId) {
    return { ok: false, code: "CONTEST_GAME_MISMATCH" };
  }

  const persisted = await db.prepare(
    `SELECT contest_id, internal_game_id, target_team_key
       FROM game_contests
      WHERE contest_id = ?1 AND internal_game_id = ?2 AND target_team_key = ?3
      LIMIT 1`
  ).bind(contestId, gameId, teamKey).first();
  return { ok: true, contestId, internalGameId: gameId, targetTeamKey: teamKey, side, persisted: Boolean(persisted) };
}

export async function ensureGameContest(db, internalGameId, targetTeam, requestedContestId = "") {
  const resolved = await getGameContest(db, internalGameId, targetTeam, requestedContestId);
  if (!resolved.ok) return resolved;
  if (!resolved.persisted) await db.prepare(
    `INSERT INTO game_contests (contest_id, internal_game_id, target_team_key)
     VALUES (?1, ?2, ?3) ON CONFLICT(internal_game_id, target_team_key) DO NOTHING`
  ).bind(resolved.contestId, resolved.internalGameId, resolved.targetTeamKey).run();
  const persisted = await db.prepare(
    `SELECT contest_id, internal_game_id, target_team_key
       FROM game_contests
      WHERE contest_id = ?1 AND internal_game_id = ?2 AND target_team_key = ?3
      LIMIT 1`
  ).bind(resolved.contestId, resolved.internalGameId, resolved.targetTeamKey).first();
  if (!persisted) return { ok: false, code: "CONTEST_GAME_MISMATCH" };
  return { ...resolved, persisted: true };
}
