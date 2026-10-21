import test from "node:test";
import assert from "node:assert/strict";
import { fetchNpbWorkerJson } from "../auth-worker.js";
import teamContext from "../frontend/shared/team-context.js";
import { TEST_TEAMS, TEST_TEAM_GROUPS } from "../tooling/test-site/teams.js";
import { handleSimulatedNpbRequest, simulatorGameDate } from "../tooling/test-site/simu-npb/source.js";

function simulatorFetch(requests) {
  return async (input) => {
    const url = new URL(input);
    requests.push(url);
    const response = await handleSimulatedNpbRequest(new Request(url), {
      SIMU_NPB_STATE: { async get() { return "available"; } }
    }, { TEST_TEAMS, TEST_TEAM_GROUPS });
    return response;
  };
}

const baseEnv = (teamKey) => ({
  ENVIRONMENT: "test",
  TEST_SITE_ID: "starting9-isolated-v1",
  TEST_WORKER_NAME: "starting9-test-auth",
  ENABLE_DEVELOPMENT_MODE: "true",
  NPB_SOURCE: "simulator",
  NPB_FETCH_DISABLED: "false",
  S9SIMU_BASE_URL: "https://s9simu.pages.dev",
  TARGET_TEAM_CONTEXT: teamContext.NPB_TEAMS[teamKey]
});

test("Auth Worker's simulator fetch binds roster and lineup parsing to the selected contest team", async () => {
  const requests = [];
  const marinesRoster = await fetchNpbWorkerJson(baseEnv("marines"), { mode: "roster" }, { fetchImpl: simulatorFetch(requests) });
  assert.equal(marinesRoster.players.length, 15);
  assert.ok(marinesRoster.players.every((player) => player.name.includes(TEST_TEAMS.marines.shortName)));
  assert.match(requests[0].pathname, /\/roster\/marines\/$/);

  const date = simulatorGameDate();
  const code = "g-t-5";
  const lineup = await fetchNpbWorkerJson(baseEnv("marines"), {
    mode: "lineup", date, gameCode: code, homeTeam: "eagles", awayTeam: "marines"
  }, { fetchImpl: simulatorFetch(requests) });
  assert.equal(lineup.lineup.length, 9);
  assert.ok(lineup.lineup.every((player) => player.playerName.includes(TEST_TEAMS.marines.shortName)));
  assert.equal(requests[1].searchParams.get("team"), "marines");

  const eagles = await fetchNpbWorkerJson(baseEnv("eagles"), {
    mode: "lineup", date, gameCode: code, homeTeam: "eagles", awayTeam: "marines"
  }, { fetchImpl: simulatorFetch(requests) });
  assert.ok(eagles.lineup.every((player) => player.playerName.includes(TEST_TEAMS.eagles.shortName)));
  assert.notEqual(lineup.lineup[0].playerName, eagles.lineup[0].playerName);
});
