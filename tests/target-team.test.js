import test from "node:test";
import assert from "node:assert/strict";
import { PRODUCTION_TEAM, resolveRequestTeamContext, targetTeamForEnvironment, teamContext } from "../backend/target-team.js";

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

test("production request team scope resolves only canonical keys when explicitly enabled", () => {
  const enabled = { ENABLE_PRODUCTION_TEAM_ROUTING: "true" };
  for (const team of Object.values(teamContext.NPB_TEAMS)) {
    const result = resolveRequestTeamContext(new Request(`https://starting9-app.pages.dev/api/public/games?team=${team.key}`), enabled);
    assert.equal(result.ok, true);
    assert.equal(result.team.key, team.key);
    assert.equal(targetTeamForEnvironment(result.env).key, team.key);
  }
  assert.equal(resolveRequestTeamContext(new Request("https://starting9-app.pages.dev/api/public/games"), enabled).team.key, "fighters");
  assert.equal(resolveRequestTeamContext(new Request("https://starting9-app.pages.dev/api/public/games?team=not-a-team"), enabled).code, "UNKNOWN_TEAM");
  assert.equal(resolveRequestTeamContext(new Request("https://starting9-app.pages.dev/api/public/games?team=marines"), {}).code, "TEAM_ROUTING_DISABLED");
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
