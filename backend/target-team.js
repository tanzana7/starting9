import teamContext from "../frontend/shared/team-context.js";

export const PRODUCTION_TEAM = teamContext.FIGHTERS;

// Context is supplied by a trusted bootstrap, never decoded from public input. Production
// remains fixed even if somebody accidentally adds a test context to deployment variables.
export function targetTeamForEnvironment(env = {}) {
  if (env.TARGET_TEAM_CONTEXT === undefined) return PRODUCTION_TEAM;
  const target = teamContext.requireTeamContext(env.TARGET_TEAM_CONTEXT);
  if (target.key !== PRODUCTION_TEAM.key && (env.ENVIRONMENT !== "test"
      || env.TEST_SITE_ID !== "starting9-isolated-v1" || env.TEST_WORKER_NAME !== "starting9-test-auth")) {
    throw new Error("Non-production target team requires the isolated test bootstrap");
  }
  return target;
}

export { teamContext };
