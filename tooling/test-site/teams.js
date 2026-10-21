import teamContext from "../../frontend/shared/team-context.js";

// All real canonical NPB identities are exercised only against the isolated
// Test Site D1s. Production target-team resolution remains hard-pinned to F.
export const TEST_TEAMS = teamContext.NPB_TEAMS;
export const TEST_TEAM_KEYS = Object.freeze(Object.keys(TEST_TEAMS));

const GAME_PAIRS = Object.freeze([
  Object.freeze(["giants", "tigers"]),
  Object.freeze(["baystars", "carp"]),
  Object.freeze(["swallows", "dragons"]),
  Object.freeze(["hawks", "fighters"]),
  Object.freeze(["eagles", "marines"]),
  Object.freeze(["buffaloes", "lions"])
]);

export const TEST_TEAM_GROUPS = Object.freeze(GAME_PAIRS.map(([homeKey, awayKey], index) => Object.freeze({
  internalGameId: `11111111-2027-4000-8000-${String(index + 1).padStart(12, "0")}`,
  homeKey,
  awayKey
})));

export function assertDistinctTestTeamIdentity(teams = TEST_TEAMS) {
  const values = Object.values(teams);
  if (values.length !== 12 || TEST_TEAM_KEYS.some((key) => !teams[key])) {
    throw new Error("Test Site must contain exactly the twelve NPB team contexts");
  }
  const unique = (value) => new Set(values.map((team) => String(value(team)).toLowerCase())).size === values.length;
  if (!unique((team) => team.key) || !unique((team) => team.providerTeamCode)
      || !unique((team) => team.playerTeamId) || !unique((team) => team.slug)
      || !unique((team) => team.officialRosterCode)) {
    throw new Error("Test teams must have distinct canonical and provider identities");
  }
  return true;
}

export function testTeamGroups() {
  return TEST_TEAM_GROUPS;
}

export function testTeamFixture(key = "fighters") {
  if (!Object.hasOwn(TEST_TEAMS, key)) throw new Error("Unknown test target team");
  const team = TEST_TEAMS[key];
  const groupIndex = TEST_TEAM_GROUPS.findIndex(({ homeKey, awayKey }) => homeKey === key || awayKey === key);
  const group = TEST_TEAM_GROUPS[groupIndex];
  const playerPrefix = `9${String(TEST_TEAM_KEYS.indexOf(key) + 1).padStart(3, "0")}`;
  return {
    team,
    internalGameId: group.internalGameId,
    playerPrefix,
    homeTeam: TEST_TEAMS[group.homeKey].key,
    awayTeam: TEST_TEAMS[group.awayKey].key,
    opponentKey: group.homeKey === key ? group.awayKey : group.homeKey,
    gameIndex: groupIndex
  };
}
