export const FIGHTERS_TEAM_CODE = "fighters";

const TEAM_ALIASES = Object.freeze({
  fighters: ["北海道日本ハムファイターズ", "北海道日本ハム", "日本ハムファイターズ", "日本ハム", "ファイターズ", "F"],
  buffaloes: ["オリックス・バファローズ", "オリックスバファローズ", "オリックス"],
  hawks: ["福岡ソフトバンクホークス", "ソフトバンクホークス", "ソフトバンク", "H"],
  lions: ["埼玉西武ライオンズ", "西武ライオンズ", "西武"],
  eagles: ["東北楽天ゴールデンイーグルス", "楽天ゴールデンイーグルス", "楽天", "E"],
  marines: ["千葉ロッテマリーンズ", "ロッテマリーンズ", "ロッテ"],
  giants: ["読売ジャイアンツ", "巨人"],
  tigers: ["阪神タイガース", "阪神"],
  baystars: ["横浜DeNAベイスターズ", "横浜DeNA", "DeNA"],
  carp: ["広島東洋カープ", "広島カープ", "広島"],
  dragons: ["中日ドラゴンズ", "中日"],
  swallows: ["東京ヤクルトスワローズ", "ヤクルトスワローズ", "ヤクルト"]
});

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
  return normalizeScheduleTeamCode(game?.homeTeam || game?.homeTeamId) === FIGHTERS_TEAM_CODE
    || normalizeScheduleTeamCode(game?.awayTeam || game?.awayTeamId) === FIGHTERS_TEAM_CODE;
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
  const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? String(date) : "";
  const seen = new Set();
  return (Array.isArray(games) ? games : []).map((game) => {
    const homeTeam = normalizeScheduleTeamCode(game?.homeTeam || game?.homeTeamId);
    const awayTeam = normalizeScheduleTeamCode(game?.awayTeam || game?.awayTeamId);
    const startTime = /^\d{2}:\d{2}$/.test(String(game?.startTime || "")) ? String(game.startTime) : "";
    const gameId = createDetectedGameId({ ...game, date: normalizedDate, homeTeam, awayTeam, startTime });
    return { ...game, gameId, date: normalizedDate, homeTeam, awayTeam, startTime };
  }).filter((game) => game.gameId && game.homeTeam && game.awayTeam && game.startTime && isFightersScheduleGame(game) && !seen.has(game.gameId) && Boolean(seen.add(game.gameId)));
}
