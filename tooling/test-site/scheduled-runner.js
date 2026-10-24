import { TEST_SCHEDULED_CRONS } from "./isolation.js";
import {
  isArmedFightersTestEnvironment,
  isFightersRehearsalDay,
  isFightersRehearsalDriverWindow,
  isFightersRehearsalSeedWindow
} from "./unattended-rehearsal.js";

const CRITICAL_CRON = "* * * * *";

/**
 * Keep the HTTP clock-pulse request open until the same scheduled handler's
 * waitUntil work settles. After an HTTP response, Cloudflare only extends the
 * invocation briefly; a scheduled invocation instead waits on these tasks.
 */
export async function runScheduledCoreToCompletion(runCore, event, env) {
  if (typeof runCore !== "function") throw new TypeError("Scheduled core is required");
  const pending = [];
  const ctx = {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise));
    }
  };
  const result = await runCore(event, env, ctx);
  await Promise.all(pending);
  return result;
}

/**
 * Shared boundary for the Test Worker's native scheduled entrypoint and its
 * authenticated GitHub clock bridge. The bridge provides only a trigger, not
 * a clock value or a second copy of the planner/executor pipeline.
 */
export async function runScheduledTick({
  source,
  event,
  env,
  ctx,
  now = new Date(),
  runCore,
  runSeed
} = {}) {
  if (!isArmedFightersTestEnvironment(env)) {
    return { ok: false, status: 404, code: "TEST_ENVIRONMENT_REQUIRED" };
  }
  if (typeof runCore !== "function" || typeof runSeed !== "function") {
    return { ok: false, status: 500, code: "SCHEDULED_RUNNER_NOT_CONFIGURED" };
  }

  const current = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(current.getTime())) {
    return { ok: false, status: 400, code: "SCHEDULED_TIME_INVALID" };
  }

  let cron;
  if (source === "github") {
    if (!isFightersRehearsalDay(current) || !isFightersRehearsalDriverWindow(current)) {
      return { ok: true, skipped: true, reason: "OUTSIDE_REHEARSAL_WINDOW" };
    }
    // Never take cron/time from the HTTP request. GitHub is only a clock pulse
    // for the regular bounded dispatcher path.
    cron = CRITICAL_CRON;
  } else if (source === "cloudflare") {
    cron = String(event?.cron || "").trim();
    if (!TEST_SCHEDULED_CRONS.includes(cron)) {
      return { ok: false, status: 400, code: "UNKNOWN_TEST_SCHEDULE" };
    }
  } else {
    return { ok: false, status: 400, code: "SCHEDULED_SOURCE_INVALID" };
  }

  const scheduledEvent = Object.freeze({ cron, scheduledTime: current.getTime() });
  if (cron === CRITICAL_CRON && isFightersRehearsalSeedWindow(current)) {
    await runSeed(current);
  }
  const execution = await runCore(scheduledEvent, env, ctx);
  return { ok: true, skipped: false, scheduledTime: current.toISOString(), execution };
}
