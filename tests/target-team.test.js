import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCTION_TEAM, targetTeamForEnvironment, teamContext } from "../backend/target-team.js";

const LEGACY_SYNTHETIC_TEAM = teamContext.defineTeamContext({
  key: "test-foxes", slug: "test-foxes", displayName: "Test Foxes", shortName: "Foxes",
  playerTeamId: "TF", providerTeamCode: "test-foxes", aliases: [],
  branding: { primary: "#112233", secondary: "#223344", accent: "#334455", surface: "#f0f0f0" }
});

test("production defaults explicitly to Fighters and rejects non-Fighters overrides", () => {
  assert.equal(targetTeamForEnvironment().key, "fighters");
  assert.throws(() => targetTeamForEnvironment({ TARGET_TEAM_CONTEXT: LEGACY_SYNTHETIC_TEAM }), /isolated test bootstrap/);
  assert.equal(targetTeamForEnvironment({ TARGET_TEAM_CONTEXT: PRODUCTION_TEAM }).key, "fighters");
});

test("synthetic teams require every isolated Worker identity guard", () => {
  const safe = {
    ENVIRONMENT: "test", TEST_SITE_ID: "starting9-isolated-v1", TEST_WORKER_NAME: "starting9-test-auth",
    TARGET_TEAM_CONTEXT: LEGACY_SYNTHETIC_TEAM
  };
  assert.equal(targetTeamForEnvironment(safe).key, "test-foxes");
  for (const key of ["ENVIRONMENT", "TEST_SITE_ID", "TEST_WORKER_NAME"]) {
    assert.throws(() => targetTeamForEnvironment({ ...safe, [key]: "wrong" }), /isolated test bootstrap/);
  }
  assert.throws(() => targetTeamForEnvironment({ ...safe, TARGET_TEAM_CONTEXT: { key: "unknown" } }), /Invalid target team context/);
});
