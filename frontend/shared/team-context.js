(function registerTeamContext(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Starting9TeamContext = api;
})(typeof window === "object" ? window : globalThis, function createTeamContextApi() {
  "use strict";

  function defineTeamContext(value) {
    if (!value || !/^[a-z][a-z0-9-]*$/.test(value.key || "")
      || !/^[A-Za-z][A-Za-z0-9-]*$/.test(value.playerTeamId || "")
      || !value.displayName || !value.shortName || !value.providerTeamCode
      || !Array.isArray(value.aliases) || !value.branding) {
      throw new Error("Invalid target team context");
    }
    const branding = { ...value.branding };
    for (const key of ["primary", "secondary", "accent", "surface"]) {
      if (!/^#[0-9a-f]{6}$/i.test(branding[key] || "")) throw new Error("Invalid team branding");
    }
    return Object.freeze({ ...value, aliases: Object.freeze([...value.aliases]), branding: Object.freeze(branding) });
  }

  const NPB_TEAM_DEFINITIONS = [
    { key: "giants", slug: "giants", displayName: "読売ジャイアンツ", shortName: "巨人", league: "Central", playerTeamId: "G", providerTeamCode: "g", officialRosterCode: "g", aliases: ["G", "巨人", "ジャイアンツ"], branding: ["#f15a24", "#222222", "#ffffff", "#fff2eb"] },
    { key: "tigers", slug: "tigers", displayName: "阪神タイガース", shortName: "阪神", league: "Central", playerTeamId: "T", providerTeamCode: "t", officialRosterCode: "t", aliases: ["T", "タイガース"], branding: ["#f5c400", "#202020", "#ffffff", "#fffbe6"] },
    { key: "baystars", slug: "baystars", displayName: "横浜DeNAベイスターズ", shortName: "DeNA", league: "Central", playerTeamId: "DB", providerTeamCode: "db", officialRosterCode: "db", aliases: ["DB", "横浜DeNA", "DeNA", "ベイスターズ"], branding: ["#0054a6", "#092c5c", "#e6002d", "#edf5ff"] },
    { key: "carp", slug: "carp", displayName: "広島東洋カープ", shortName: "広島", league: "Central", playerTeamId: "C", providerTeamCode: "c", officialRosterCode: "c", aliases: ["C", "広島カープ", "カープ"], branding: ["#c8102e", "#7b0015", "#f4c542", "#fff0f2"] },
    { key: "swallows", slug: "swallows", displayName: "東京ヤクルトスワローズ", shortName: "ヤクルト", league: "Central", playerTeamId: "S", providerTeamCode: "s", officialRosterCode: "s", aliases: ["S", "ヤクルトスワローズ", "スワローズ"], branding: ["#004ea2", "#002d62", "#c8a45d", "#edf5ff"] },
    { key: "dragons", slug: "dragons", displayName: "中日ドラゴンズ", shortName: "中日", league: "Central", playerTeamId: "D", providerTeamCode: "d", officialRosterCode: "d", aliases: ["D", "ドラゴンズ"], branding: ["#004ea2", "#002d62", "#f4c542", "#edf5ff"] },
    { key: "hawks", slug: "hawks", displayName: "福岡ソフトバンクホークス", shortName: "ソフトバンク", league: "Pacific", playerTeamId: "H", providerTeamCode: "h", officialRosterCode: "h", aliases: ["H", "ソフトバンクホークス", "ソフトバンク", "ホークス"], branding: ["#fbc600", "#171717", "#ffffff", "#fffbea"] },
    { key: "fighters", slug: "fighters", displayName: "北海道日本ハムファイターズ", shortName: "日本ハム", league: "Pacific", playerTeamId: "F", providerTeamCode: "f", officialRosterCode: "f", shareHashtags: "#lovefighters #starting9", aliases: ["F", "北海道日本ハムファイターズ", "北海道日本ハム", "日本ハムファイターズ", "日本ハム", "ファイターズ"], branding: ["#005bac", "#003f7d", "#d5a11e", "#eaf4ff"] },
    { key: "marines", slug: "marines", displayName: "千葉ロッテマリーンズ", shortName: "ロッテ", league: "Pacific", playerTeamId: "M", providerTeamCode: "m", officialRosterCode: "m", shareHashtags: "#chibalotte #starting9", aliases: ["M", "千葉ロッテマリーンズ", "ロッテマリーンズ", "ロッテ", "マリーンズ"], branding: ["#092c5c", "#c8102e", "#ffffff", "#eef3f8"] },
    { key: "eagles", slug: "eagles", displayName: "東北楽天ゴールデンイーグルス", shortName: "楽天", league: "Pacific", playerTeamId: "E", providerTeamCode: "e", officialRosterCode: "e", aliases: ["E", "楽天ゴールデンイーグルス", "楽天", "イーグルス"], branding: ["#a71930", "#681020", "#d9b36c", "#fff0f2"] },
    { key: "buffaloes", slug: "buffaloes", displayName: "オリックス・バファローズ", shortName: "オリックス", league: "Pacific", playerTeamId: "B", providerTeamCode: "b", officialRosterCode: "b", aliases: ["B", "オリックスバファローズ", "オリックス", "バファローズ"], branding: ["#111111", "#000000", "#b89b5e", "#f3f3f3"] },
    { key: "lions", slug: "lions", displayName: "埼玉西武ライオンズ", shortName: "西武", league: "Pacific", playerTeamId: "L", providerTeamCode: "l", officialRosterCode: "l", aliases: ["L", "西武ライオンズ", "西武", "ライオンズ"], branding: ["#004ea2", "#002d62", "#d5a11e", "#edf5ff"] }
  ];
  const NPB_TEAMS = Object.freeze(Object.fromEntries(NPB_TEAM_DEFINITIONS.map((definition) => {
    const [primary, secondary, accent, surface] = definition.branding;
    return [definition.key, defineTeamContext({
      ...definition,
      aliases: [definition.key, definition.displayName, ...definition.aliases],
      shareHashtags: definition.shareHashtags || "#starting9",
      branding: { primary, secondary, accent, surface },
      logo: null,
      icon: null
    })];
  })));
  const FIGHTERS = NPB_TEAMS.fighters;
  const MARINES = NPB_TEAMS.marines;

  function requireTeamContext(team) {
    if (!team || typeof team !== "object") throw new Error("Target team context is required");
    return defineTeamContext(team);
  }

  function normalized(value) {
    return String(value || "").replace(/[\s\u3000]/g, "").replace(/[・.]/g, "").toLowerCase();
  }

  function matchesTeam(value, team) {
    const target = requireTeamContext(team);
    const candidate = normalized(value);
    return Boolean(candidate) && [target.key, target.playerTeamId, target.providerTeamCode, ...target.aliases]
      .some((alias) => normalized(alias) === candidate);
  }

  function gameSide(game, team) {
    requireTeamContext(team);
    if (!game) return null;
    if ([game.homeTeam, game.home_team, game.homeTeamId, game.homeCode].some((value) => matchesTeam(value, team))) return "home";
    if ([game.awayTeam, game.away_team, game.awayTeamId, game.awayCode].some((value) => matchesTeam(value, team))) return "away";
    return null;
  }

  function contestIdForGame(internalGameId, team) {
    const id = String(internalGameId || "").trim();
    const target = requireTeamContext(team);
    if (!id) throw new Error("Canonical game identity is required");
    const hex = (value) => Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `contest_${hex(id)}_${hex(target.key)}`;
  }

  function gameTeams(game, team) {
    const side = gameSide(game, team);
    if (!side) return null;
    const other = side === "home" ? "away" : "home";
    return { side, opponent: game[`${other}Team`] ?? game[`${other}_team`] ?? game[`${other}TeamId`],
      starter: game[`${side}Starter`], opponentStarter: game[`${other}Starter`], opponentName: game[`${other}TeamName`] };
  }

  function applyBranding(element, team) {
    const { branding } = requireTeamContext(team);
    // Preserve the shipped CSS names during C-1. Existing Fighters declarations are also the
    // no-JavaScript fallback; a context changes values without rewriting selectors or layout.
    for (const [token, key] of [["blue", "primary"], ["deep-blue", "secondary"], ["gold", "accent"], ["sky", "surface"]]) {
      element.style.setProperty(`--fighters-${token}`, branding[key]);
    }
  }

  return Object.freeze({ NPB_TEAMS, FIGHTERS, MARINES, defineTeamContext, requireTeamContext, matchesTeam, gameSide, gameTeams, contestIdForGame, applyBranding });
});
