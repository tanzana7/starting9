const TEST_ENVIRONMENT = Object.freeze({
  environment: "test",
  siteId: "starting9-isolated-v1",
  workerName: "starting9-test-auth"
});

/**
 * Only the isolated Test Worker may inject prediction-write time. The value is
 * an internal environment property supplied by its admin-only rehearsal
 * bridge, never an HTTP header or query parameter. Production keeps wall time.
 */
export function getPredictionWriteNow(env = {}) {
  const testClockEnabled = env.ENVIRONMENT === TEST_ENVIRONMENT.environment
    && env.TEST_SITE_ID === TEST_ENVIRONMENT.siteId
    && env.TEST_WORKER_NAME === TEST_ENVIRONMENT.workerName;
  if (!testClockEnabled || typeof env.TEST_CLOCK_NOW !== "string") return new Date();
  return new Date(env.TEST_CLOCK_NOW);
}
