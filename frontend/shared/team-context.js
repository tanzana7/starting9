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

  const FIGHTERS = defineTeamContext({
    key: "fighters", slug: "fighters", displayName: "北海道日本ハムファイターズ", shortName: "日本ハム",
    playerTeamId: "F", providerTeamCode: "f", shareHashtags: "#lovefighters #starting9",
    aliases: ["F", "北海道日本ハムファイターズ", "北海道日本ハム", "日本ハムファイターズ", "日本ハム", "ファイターズ"],
    branding: { primary: "#005bac", secondary: "#003f7d", accent: "#d5a11e", surface: "#eaf4ff" },
    logo: null, icon: null
  });

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

  return Object.freeze({ FIGHTERS, defineTeamContext, requireTeamContext, matchesTeam, gameSide, gameTeams, applyBranding });
});
