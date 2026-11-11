import { pathToFileURL } from "node:url";
import { evaluateUnattendedCheckpoint } from "./unattended-observer.mjs";

const TEST_AUTH_ORIGIN = "https://starting9-test-auth.starting9.workers.dev";
const AUDIENCE = "starting9-fighters-scheduled-driver";
const WORKFLOW_FILE = "fighters-unattended-driver.yml";
const TICK_INTERVAL_MS = 60_000;
const CHAIN_BUDGET_MS = 240 * 60_000;
const STALL_TICKS = 45;
const MAX_CONSECUTIVE_FAILURES = 30;

export function evaluateDriverInvocation({ eventName, mode = "", now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return { action: "reject", reason: "invalid_time" };
  if (eventName === "workflow_dispatch" && mode === "auth-check") {
    return { action: "auth-check" };
  }
  if (eventName === "workflow_dispatch" && mode && mode !== "chain") {
    return { action: "reject", reason: "dispatch_mode_not_allowed" };
  }
  if (eventName !== "schedule" && eventName !== "workflow_dispatch") {
    return { action: "reject", reason: "event_not_allowed" };
  }
  // The Test Worker owns the wall-clock window (it answers 409 outside it), so
  // the driver only needs to chain ticks; it never derives a scenario date.
  return { action: "chain" };
}

async function requestOidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error("OIDC_UNAVAILABLE");
  const url = new URL(requestUrl);
  url.searchParams.set("audience", AUDIENCE);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${requestToken}`, Accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) throw new Error("OIDC_TOKEN_REQUEST_FAILED");
  const payload = await response.json();
  if (typeof payload?.value !== "string" || !payload.value) throw new Error("OIDC_TOKEN_MISSING");
  return payload.value;
}

async function sendScheduledTick() {
  const token = await requestOidcToken();
  const response = await fetch(`${TEST_AUTH_ORIGIN}/api/test/admin/scheduled-tick`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store"
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function readObservation() {
  const response = await fetch(`${TEST_AUTH_ORIGIN}/api/test/rehearsal/observer?testTeam=fighters`, {
    method: "GET", cache: "no-store", headers: { Accept: "application/json" }
  });
  return response.ok ? response.json() : null;
}

async function dispatchContinuationRun() {
  const repository = String(process.env.GITHUB_REPOSITORY || "tanzana7/starting9");
  const token = String(process.env.GITHUB_TOKEN || "");
  if (!token) throw new Error("CHAIN_DISPATCH_TOKEN_MISSING");
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ref: "main", inputs: { mode: "chain" } }),
      cache: "no-store"
    }
  );
  if (!response.ok) throw new Error(`CHAIN_DISPATCH_FAILED_${response.status}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runChainLoop() {
  const startedAt = Date.now();
  let consecutiveFailures = 0;
  let lastSignature = "";
  let stalledTicks = 0;
  while (Date.now() - startedAt < CHAIN_BUDGET_MS) {
    try {
      const { response, payload } = await sendScheduledTick();
      if (response.status === 409 && payload?.skipped === true) {
        console.log(`FIGHTERS_DRIVER_CHAIN_STOP reason=${payload.reason}`);
        return;
      }
      if (response.status !== 202 || payload?.ok !== true || payload?.accepted !== true) {
        throw new Error(`scheduled_tick_rejected_${response.status}_${String(payload?.code || "UNKNOWN")}`);
      }
      consecutiveFailures = 0;
      const observation = await readObservation();
      const fighters = observation?.fighters || {};
      console.log(`FIGHTERS_CHAIN_TICK state=${fighters.state || "unknown"}`
        + ` predictions=${fighters.predictions ?? "?"} lineup=${fighters.officialLineupRows ?? "?"}`
        + ` scored=${fighters.scoredPredictions ?? "?"} jobs_completed=${fighters.jobs?.completed ?? "?"}`);
      if (fighters.state === "published") {
        const verdict = evaluateUnattendedCheckpoint("final", observation);
        if (!verdict.ok) throw new Error(`final_checkpoint_failed:${verdict.code}`);
        console.log("FIGHTERS UNATTENDED AUTOMATION PASS");
        console.log("FIGHTERS_DRIVER_CHAIN_COMPLETE reason=published");
        return;
      }
      const signature = `${fighters.state}:${fighters.predictions}:${fighters.officialLineupRows}:${fighters.scoredPredictions}`;
      stalledTicks = signature === lastSignature ? stalledTicks + 1 : 0;
      lastSignature = signature;
      if (stalledTicks >= STALL_TICKS) {
        console.log(`FIGHTERS_DRIVER_CHAIN_STALLED signature=${signature}`);
        return;
      }
    } catch (error) {
      consecutiveFailures += 1;
      const safe = /^[a-z0-9:_-]{1,100}$/i.test(String(error?.message || "")) ? error.message : "chain_tick_failed";
      console.error(`FIGHTERS_DRIVER_CHAIN_ERROR ${safe} consecutive=${consecutiveFailures}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw new Error("chain_tick_persistent_failure");
    }
    await sleep(TICK_INTERVAL_MS);
  }
  console.log("FIGHTERS_DRIVER_CHAIN_BUDGET_EXHAUSTED");
  await dispatchContinuationRun();
  console.log("FIGHTERS_DRIVER_CHAIN_CONTINUED");
}

async function run() {
  const action = evaluateDriverInvocation({
    eventName: process.env.GITHUB_EVENT_NAME,
    mode: process.env.S9SIMU_DRIVER_MODE || "",
    now: new Date()
  });
  if (action.action === "noop") {
    console.log(`FIGHTERS_DRIVER_NOOP reason=${action.reason}`);
    return;
  }
  if (action.action === "reject") throw new Error(`driver_event_rejected:${action.reason}`);
  if (action.action === "auth-check") {
    const token = await requestOidcToken();
    const response = await fetch(`${TEST_AUTH_ORIGIN}/api/test/admin/scheduled-tick/health`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store"
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true || payload?.environment !== "test") {
      throw new Error(`driver_auth_check_failed_${response.status}`);
    }
    console.log("FIGHTERS_DRIVER_AUTH_CHECK_PASS");
    return;
  }
  await runChainLoop();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run().catch((error) => {
    const safe = /^[a-z0-9:_-]{1,100}$/i.test(String(error?.message || "")) ? error.message : "driver_failed";
    console.error(`FIGHTERS_DRIVER_FAIL ${safe}`);
    process.exitCode = 1;
  });
}
