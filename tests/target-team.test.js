import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCTION_TEAM, targetTeamForEnvironment } from "../backend/target-team.js";
import { TEST_TEAMS } from "../tooling/test-site/teams.js";

test("production defaults explicitly to Fighters and rejects non-Fighters overrides", () => {
  assert.equal(targetTeamForEnvironment().key, "fighters");
  assert.throws(() => targetTeamForEnvironment({ TARGET_TEAM_CONTEXT: TEST_TEAMS.foxes }), /isolated test bootstrap/);
  assert.equal(targetTeamForEnvironment({ TARGET_TEAM_CONTEXT: PRODUCTION_TEAM }).key, "fighters");
});

test("synthetic teams require every isolated Worker identity guard", () => {
  const safe = {
    ENVIRONMENT: "test", TEST_SITE_ID: "starting9-isolated-v1", TEST_WORKER_NAME: "starting9-test-auth",
    TARGET_TEAM_CONTEXT: TEST_TEAMS.foxes
  };
  assert.equal(targetTeamForEnvironment(safe).key, "test-foxes");
  for (const key of ["ENVIRONMENT", "TEST_SITE_ID", "TEST_WORKER_NAME"]) {
    assert.throws(() => targetTeamForEnvironment({ ...safe, [key]: "wrong" }), /isolated test bootstrap/);
  }
  assert.throws(() => targetTeamForEnvironment({ ...safe, TARGET_TEAM_CONTEXT: { key: "unknown" } }), /Invalid target team context/);
});
