import teamContext from "./frontend/shared/team-context.js";

export const FIGHTERS_TEAM_CODE = teamContext.FIGHTERS.key;

export const TEAM_ALIASES = Object.freeze(Object.fromEntries(Object.values(teamContext.NPB_TEAMS).map((team) => [
  team.key,
  [...new Set([team.key, team.providerTeamCode, team.playerTeamId, team.displayName, ...team.aliases])]
])));

function normalizeText(value) {
  return String(value || "").replace(/[\s\u3000]/g, "").replace(/[・.]/g, "").toLowerCase();
}

export function normalizeScheduleTeamCode(value) {
  const normalized = normalizeText(value);
  if (Object.hasOwn(TEAM_ALIASES, normalized)) return normalized;
  for (const [code, aliases] of Object.entries(TEAM_ALIASES)) {
    if (aliases.some((alias) => normalizeText(alias) === normalized)) return code;
  }
  return "";
}

export function isFightersScheduleGame(game) {
  return isTargetTeamScheduleGame(game, teamContext.FIGHTERS);
}

export function isTargetTeamScheduleGame(game, targetTeam) {
  return teamContext.gameSide(game, targetTeam) !== null;
}

export function createDetectedGameId(game) {
  const date = String(game?.date || "");
  const homeTeam = normalizeScheduleTeamCode(game?.homeTeam || game?.homeTeamId);
  const awayTeam = normalizeScheduleTeamCode(game?.awayTeam || game?.awayTeamId);
  const gameCode = String(game?.gameCode || "").trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}-[a-z]{1,2}-[a-z]{1,2}-\d+$/i.test(`${date}-${gameCode}`)) return `${date}-${gameCode}`;
  const startTime = String(game?.startTime || "").replace(/[^0-9]/g, "");
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && homeTeam && awayTeam && /^\d{3,4}$/.test(startTime)
    ? `${date}-${homeTeam}-${awayTeam}-${startTime}`
    : "";
}

export function normalizeFightersScheduleGames(games, date) {
  return normalizeTargetTeamScheduleGames(games, date, teamContext.FIGHTERS);
}

export function normalizeTargetTeamScheduleGames(games, date, targetTeam) {
  const selectedTeam = teamContext.requireTeamContext(targetTeam);
  const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : "";
  const seen = new Set();
  return (Array.isArray(games) ? games : []).map((game) => {
    const homeTeam = normalizeScheduleTeamCode(game?.homeTeam || game?.homeTeamId);
    const awayTeam = normalizeScheduleTeamCode(game?.awayTeam || game?.awayTeamId);
    const startTime = /^\d{2}:\d{2}$/.test(String(game?.startTime || "")) ? String(game.startTime) : "";
    const gameId = createDetectedGameId({ ...game, date: normalizedDate, homeTeam, awayTeam, startTime });
    return { ...game, gameId, date: normalizedDate, homeTeam, awayTeam, startTime };
  }).filter((game) => game.gameId && game.homeTeam && game.awayTeam && game.startTime
    && isTargetTeamScheduleGame(game, selectedTeam) && !seen.has(game.gameId) && Boolean(seen.add(game.gameId)));
}
