export const TEST_SITE_ID = "starting9-isolated-v1";
export const TEST_AUTH_WORKER = "starting9-test-auth";
export const TEST_PAGES_PROJECT = "s9simu";
export const TEST_AUTH_DB_NAME = "starting9-test-auth-db";
export const TEST_AUDIT_DB_NAME = "starting9-test-audit-db";
export const TEST_AUTH_DB_ID = "7ea1fa14-ffc0-4404-8a65-5dbb8218f368";
export const TEST_AUDIT_DB_ID = "a18c6cf9-a238-4059-a5ef-784f248e225e";

export const PRODUCTION_RESOURCE_IDS = Object.freeze({
  authDatabase: "326f97c3-768d-4df6-ada2-129fdb1865a1",
  auditDatabase: "acfac47d-1963-433a-b16b-36cd3afe9db4",
  authWorker: "starting9-auth",
  pagesProject: "starting9-app"
});

export function isIsolatedTestEnvironment(env = {}) {
  const authDbId = String(env.TEST_AUTH_DB_ID || "").trim();
  const auditDbId = String(env.TEST_AUDIT_DB_ID || "").trim();
  return env.ENVIRONMENT === "test"
    && env.TEST_SITE_ID === TEST_SITE_ID
    && env.TEST_WORKER_NAME === TEST_AUTH_WORKER
    && authDbId === TEST_AUTH_DB_ID
    && auditDbId === TEST_AUDIT_DB_ID
    && authDbId !== PRODUCTION_RESOURCE_IDS.authDatabase
    && auditDbId !== PRODUCTION_RESOURCE_IDS.auditDatabase
    && env.NPB_FETCH_DISABLED === "true"
    && Boolean(env.AUTH_DB)
    && Boolean(env.AUDIT_DB);
}

export function assertTestAuthConfig(config) {
  const databases = new Map((config.d1_databases || []).map((row) => [row.binding, row]));
  if (config.name !== TEST_AUTH_WORKER) throw new Error("test Worker name must be isolated");
  if (config.account_id !== "02580fab1c09e144db7da89478e252c8") throw new Error("test Worker account must be TARGET");
  if (config.main !== "tooling/test-site/worker.js") throw new Error("test Worker must use the test-only entrypoint");
  if ((config.triggers?.crons || []).length !== 0) throw new Error("test Worker must have no Cron triggers");
  if ((config.services || []).length !== 0) throw new Error("test Worker must not have service bindings");
  if (config.vars?.ENVIRONMENT !== "test" || config.vars?.TEST_SITE_ID !== TEST_SITE_ID) {
    throw new Error("test Worker environment identity is required");
  }
  if (config.vars?.NPB_FETCH_DISABLED !== "true") throw new Error("test Worker must disable external NPB fetches");
  const auth = databases.get("AUTH_DB");
  const audit = databases.get("AUDIT_DB");
  if (auth?.database_name !== TEST_AUTH_DB_NAME || audit?.database_name !== TEST_AUDIT_DB_NAME) {
    throw new Error("test Worker D1 names must be test-only");
  }
  const productionIds = new Set(Object.values(PRODUCTION_RESOURCE_IDS).filter((value) => /^[0-9a-f-]{36}$/i.test(value)));
  if (!auth?.database_id || productionIds.has(auth.database_id)) {
    throw new Error("test AUTH_DB must not use the production D1 ID");
  }
  if (!audit?.database_id || productionIds.has(audit.database_id) || audit.database_id === auth.database_id) {
    throw new Error("test AUDIT_DB must not use the production D1 ID");
  }
  if (config.vars?.TEST_WORKER_NAME !== TEST_AUTH_WORKER
      || config.vars?.TEST_AUTH_DB_ID !== auth.database_id
      || config.vars?.TEST_AUDIT_DB_ID !== audit.database_id) {
    throw new Error("test environment identity must match the bound resources");
  }
  return true;
}

export function assertTestPagesConfig(config) {
  if (config.name !== TEST_PAGES_PROJECT || config.name === PRODUCTION_RESOURCE_IDS.pagesProject) {
    throw new Error("test Pages project must be isolated");
  }
  // Pages config does not support account_id. Every remote Pages command must
  // therefore pass --profile starting9-target explicitly (documented below).
  if (Object.hasOwn(config, "account_id")) throw new Error("Pages account selection must come from the explicit target profile");
  if (config.vars?.SITE_ENVIRONMENT !== "test") throw new Error("test Pages environment identity is required");
  if (config.vars?.STARTING9_AUTH_ORIGIN !== "https://starting9-test-auth.starting9.workers.dev") {
    throw new Error("test Pages must use only the test Auth Worker");
  }
  if ((config.kv_namespaces || []).find((binding) => binding.binding === "SIMU_NPB_STATE")?.id !== "436a24c73a8b4c238040eb4a697bb4d4") {
    throw new Error("S9simu Pages must use only its isolated simulator-state KV namespace");
  }
  if (/starting9-auth\.starting9\.workers\.dev/i.test(config.vars.STARTING9_AUTH_ORIGIN)) {
    throw new Error("test Pages cannot point to the production Auth Worker");
  }
  return true;
}

export function validatePublishedScenario({ state, lineupReady, scoringReady, rankingReady, publicationReady }) {
  return state === "published" && lineupReady === true && scoringReady === true
    && rankingReady === true && publicationReady === true;
}
