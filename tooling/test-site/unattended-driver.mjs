import { pathToFileURL } from "node:url";

const TEST_AUTH_ORIGIN = "https://starting9-test-auth.starting9.workers.dev";
const AUDIENCE = "starting9-fighters-scheduled-driver";
const TARGET_DATE = "2026-10-25";

function tokyoParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map(({ type, value }) => [type, value]));
}

export function evaluateDriverInvocation({ eventName, mode = "", now = new Date() } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return { action: "reject", reason: "invalid_time" };
  if (eventName === "workflow_dispatch" && mode === "auth-check") {
    return { action: "auth-check" };
  }
  if (eventName !== "schedule") return { action: "reject", reason: "event_not_allowed" };
  const parts = tokyoParts(current);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minuteOfDay = Number(parts.hour) * 60 + Number(parts.minute);
  if (date !== TARGET_DATE) return { action: "noop", reason: "outside_test_date" };
  if (minuteOfDay < 12 * 60 || minuteOfDay > 20 * 60 + 30) {
    return { action: "noop", reason: "outside_driver_window" };
  }
  return { action: "tick" };
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

  const token = await requestOidcToken();
  const path = action.action === "auth-check"
    ? "/api/test/admin/scheduled-tick/health"
    : "/api/test/admin/scheduled-tick";
  const response = await fetch(`${TEST_AUTH_ORIGIN}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store"
  });
  const payload = await response.json().catch(() => null);
  if (action.action === "auth-check") {
    if (!response.ok || payload?.ok !== true || payload?.environment !== "test") {
      throw new Error(`driver_auth_check_failed_${response.status}`);
    }
    console.log("FIGHTERS_DRIVER_AUTH_CHECK_PASS");
    return;
  }
  if (response.status !== 202 || payload?.ok !== true || payload?.accepted !== true) {
    throw new Error(`scheduled_tick_rejected_${response.status}_${String(payload?.code || "UNKNOWN")}`);
  }
  console.log(`FIGHTERS_SCHEDULED_TICK_ACCEPTED at=${payload.scheduledTime}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    const code = /^[A-Z0-9_:-]{1,100}$/.test(String(error?.message || ""))
      ? error.message : "driver_failed";
    console.error(`FIGHTERS_SCHEDULED_DRIVER_FAIL ${code}`);
    process.exitCode = 1;
  });
}
