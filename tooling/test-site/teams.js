import teamContext from "../../frontend/shared/team-context.js";

export const TEST_TEAMS = Object.freeze({
  fighters: teamContext.defineTeamContext({
    ...teamContext.FIGHTERS, key: "test-fighters", slug: "test-fighters",
    displayName: "TEST Fighters", shortName: "TEST Fighters", playerTeamId: "TF", providerTeamCode: "tf",
    aliases: ["TEST Fighters", "Test F"]
  }),
  foxes: teamContext.defineTeamContext({
    key: "test-foxes", slug: "test-foxes", displayName: "TEST Foxes", shortName: "TEST Foxes",
    playerTeamId: "TX", providerTeamCode: "tx", aliases: ["TEST Foxes"], shareHashtags: "#starting9test",
    branding: { primary: "#774411", secondary: "#442211", accent: "#eebbaa", surface: "#fff5ee" },
    logo: null, icon: null
  }),
  marines: teamContext.MARINES
});

export function assertDistinctTestTeamIdentity(teams = TEST_TEAMS) {
  const values = Object.values(teams);
  if (!teams.fighters || !teams.foxes || !teams.marines || values.length !== 3) {
    throw new Error("Test Site must contain the two synthetic teams and exactly one real-team pilot");
  }
  const unique = (value) => new Set(values.map((team) => value(team).toLowerCase())).size === values.length;
  if (!unique((team) => team.key) || !unique((team) => team.providerTeamCode) || !unique((team) => team.playerTeamId)) {
    throw new Error("Test teams must have distinct team identities");
  }
  if (Object.keys(teams).filter((key) => !["fighters", "foxes", "marines"].includes(key)).length) {
    throw new Error("Only the approved second-team pilot may be added to Test Site");
  }
  return true;
}

export function testTeamFixture(key = "fighters") {
  if (!Object.hasOwn(TEST_TEAMS, key)) throw new Error("Unknown test target team");
  const fixtures = {
    fighters: { internalGameId: "11111111-2027-4000-8000-000000000001", playerPrefix: "9999" },
    foxes: { internalGameId: "11111111-2027-4000-8000-000000000002", playerPrefix: "9998" },
    marines: { internalGameId: "11111111-2027-4000-8000-000000000003", playerPrefix: "9997" }
  };
  return { team: TEST_TEAMS[key], ...fixtures[key] };
}
