const test = require("node:test");
const assert = require("node:assert/strict");
const team = require("../frontend/shared/team-context.js");

const foxes = team.defineTeamContext({
  key: "test-foxes", slug: "test-foxes", displayName: "TEST Foxes", shortName: "TEST Foxes",
  playerTeamId: "TX", providerTeamCode: "tx", aliases: ["Test Foxes"],
  branding: { primary: "#774411", secondary: "#442211", accent: "#eebbaa", surface: "#fff5ee" }
});

test("target team resolves home/away and opponent without adopting Fighters", () => {
  for (const side of ["home", "away"]) {
    const other = side === "home" ? "away" : "home";
    const game = { [side + "Team"]: foxes.key, [other + "Team"]: "marines", [side + "Starter"]: { name: "TEST Pitcher" } };
    assert.equal(team.gameSide(game, foxes), side);
    assert.equal(team.gameTeams(game, foxes).opponent, "marines");
    assert.equal(team.gameTeams(game, foxes).starter.name, "TEST Pitcher");
    assert.equal(team.gameSide(game, team.FIGHTERS), null);
  }
});

test("Fighters aliases and deployed branding remain exact; unknown context fails closed", () => {
  for (const alias of ["fighters", "F", "北海道日本ハムファイターズ", "日本ハム"]) assert.equal(team.matchesTeam(alias, team.FIGHTERS), true);
  assert.throws(() => team.gameSide({}, null), /required/);
  assert.throws(() => team.defineTeamContext({ key: "unknown" }), /Invalid/);
  const values = new Map();
  team.applyBranding({ style: { setProperty: (key, value) => values.set(key, value) } }, team.FIGHTERS);
  assert.equal(values.get("--fighters-blue"), "#005bac");
  team.applyBranding({ style: { setProperty: (key, value) => values.set(key, value) } }, foxes);
  assert.equal(values.get("--fighters-blue"), foxes.branding.primary);
  assert.equal(Object.isFrozen(foxes.branding), true);
});
