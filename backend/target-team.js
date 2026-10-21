import teamContext from "../frontend/shared/team-context.js";

export const PRODUCTION_TEAM = teamContext.FIGHTERS;

// Context is supplied by a trusted bootstrap, never decoded from public input. Production
// remains fixed even if somebody accidentally adds a test context to deployment variables.
export function targetTeamForEnvironment(env = {}) {
  if (env.TARGET_TEAM_CONTEXT === undefined) return PRODUCTION_TEAM;
  const target = teamContext.requireTeamContext(env.TARGET_TEAM_CONTEXT);
  if (target.key !== PRODUCTION_TEAM.key && (env.ENVIRONMENT !== "test"
      || env.TEST_SITE_ID !== "starting9-isolated-v1" || env.TEST_WORKER_NAME !== "starting9-test-auth")
      && String(env.ENABLE_PRODUCTION_TEAM_ROUTING || "").toLowerCase() !== "true") {
    throw new Error("Non-production target team requires the isolated test bootstrap");
  }
  return target;
}

export function resolveRequestTeamContext(request, env = {}) {
  const current = targetTeamForEnvironment(env);
  const requestedKey = new URL(request.url).searchParams.get("team");
  if (requestedKey === null || requestedKey === "") return { ok: true, team: current, env };
  const requested = teamContext.NPB_TEAMS[requestedKey];
  if (!requested) return { ok: false, code: "UNKNOWN_TEAM", team: null, env };
  if (env.ENVIRONMENT !== "test" && String(env.ENABLE_PRODUCTION_TEAM_ROUTING || "").toLowerCase() !== "true") {
    return { ok: false, code: "TEAM_ROUTING_DISABLED", team: null, env };
  }
  return {
    ok: true,
    team: requested,
    env: { ...env, TARGET_TEAM_CONTEXT: requested }
  };
}

export { teamContext };
