import test from "node:test";
import assert from "node:assert/strict";
import {
  OFFSEASON_ENVIRONMENT,
  createSyntheticScenario,
  predictionPhase
} from "../tooling/offseason/synthetic-scenario.js";

test("off-season fixture is isolated from production and supports deadline phases", () => {
  assert.equal(OFFSEASON_ENVIRONMENT.productionAccess, false);
  assert.equal(OFFSEASON_ENVIRONMENT.productionCredentials, false);
  assert.match(OFFSEASON_ENVIRONMENT.pagesProject, /-test$/);
  assert.match(OFFSEASON_ENVIRONMENT.databaseName, /-test$/);

  const scenario = createSyntheticScenario({ usersPerGame: 2, jobCount: 200 });
  const game = scenario.games[0];
  assert.equal(predictionPhase(game, "2026-10-01T08:00:00.000Z"), "open");
  assert.equal(predictionPhase(game, "2026-10-01T08:31:00.000Z"), "closed");
  assert.equal(predictionPhase(game, "2026-10-01T09:01:00.000Z"), "in_progress");
});

test("synthetic fixture models six games and twelve teams without production IDs", () => {
  const scenario = createSyntheticScenario({ usersPerGame: 2, jobCount: 200 });
  assert.equal(scenario.games.length, 6);
  assert.equal(scenario.teams.length, 12);
  assert.equal(scenario.players.length, 324);
  assert.equal(scenario.jobs.length, 200);
  assert.ok(scenario.predictions.every((row) => row.internalGameId.startsWith("offseason-")));
  assert.ok(scenario.players.every((row) => row.playerId.startsWith("offseason:")));
});
