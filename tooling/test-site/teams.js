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
  })
});

export function assertDistinctTestTeamIdentity(teams = TEST_TEAMS) {
  const fighters = teams.fighters;
  const foxes = teams.foxes;
  if (!fighters || !foxes || fighters.key === foxes.key
      || fighters.providerTeamCode.toLowerCase() === foxes.providerTeamCode.toLowerCase()
      || fighters.playerTeamId === foxes.playerTeamId) {
    throw new Error("Synthetic teams must have distinct team identities");
  }
  const sameBranding = Object.keys(fighters.branding).every((key) => fighters.branding[key] === foxes.branding[key]);
  if (sameBranding) throw new Error("Synthetic teams must have distinct branding");
  return true;
}

export function testTeamFixture(key = "fighters") {
  if (!Object.hasOwn(TEST_TEAMS, key)) throw new Error("Unknown test target team");
  return { team: TEST_TEAMS[key], internalGameId: key === "fighters"
    ? "11111111-2027-4000-8000-000000000001" : "11111111-2027-4000-8000-000000000002",
  playerPrefix: key === "fighters" ? "9999" : "9998" };
}
