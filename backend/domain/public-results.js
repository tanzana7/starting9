/**
 * Public result/game display rules.
 *
 * These helpers deliberately contain no database, request, or worker state so
 * the public API can keep its response contract while display semantics stay
 * independent from transport and persistence code.
 */

const PUBLIC_TEAM_LABELS = Object.freeze({
  fighters: "日本ハム",
  hawks: "ソフトバンク",
  buffaloes: "オリックス",
  marines: "ロッテ",
  eagles: "楽天",
  lions: "西武",
  giants: "巨人",
  tigers: "阪神",
  baystars: "DeNA",
  carp: "広島",
  dragons: "中日",
  swallows: "ヤクルト"
});

export const PUBLIC_RESULT_HISTORY_LIMIT = 5;

export function formatPublicResultTeamName(value) {
  const key = String(value || "").trim().toLowerCase();
  return PUBLIC_TEAM_LABELS[key] || String(value || "").trim();
}

export function createPublicGameDisplayLabel({ homeTeam = "", awayTeam = "" } = {}) {
  const home = formatPublicResultTeamName(homeTeam);
  const away = formatPublicResultTeamName(awayTeam);
  return home && away ? `${home} vs ${away}` : "対戦情報を確認中";
}

export function createPublicResultDisplayLabel({ gameDate = "", homeTeam = "", awayTeam = "" } = {}) {
  const home = formatPublicResultTeamName(homeTeam);
  const away = formatPublicResultTeamName(awayTeam);
  const matchup = home && away ? `${home} vs ${away}` : "対戦情報を確認中";
  return [String(gameDate || "").trim(), matchup].filter(Boolean).join(" ");
}
