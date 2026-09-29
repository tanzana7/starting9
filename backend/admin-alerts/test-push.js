import { disablePushSubscription, listActivePushSubscriptions } from "./storage.js";
import { sendWebPushSubscription } from "./push.js";

const MAX_TEST_PUSH_DEVICES = 10;
const TEST_PUSH_COOLDOWN_MS = 30 * 1000;
const testPushLastSentAt = new Map();

export const ADMIN_TEST_PUSH_PAYLOAD = Object.freeze({
  title: "Starting9 運営通知テスト",
  body: "Push通知を正常に受信できています。",
  actionPath: "/admin-v3.html",
  severity: "warning",
  dedupeKey: "admin-push-test"
});

function isEmptyJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function boundedAdminId(value) {
  return String(value || "").trim().slice(0, 160);
}

export function validateAdminTestPushBody(input) {
  return isEmptyJsonObject(input)
    ? { ok: true }
    : { ok: false, code: "ADMIN_PUSH_TEST_BODY_INVALID" };
}

function configured(env) {
  return Boolean(
    String(env?.VAPID_PRIVATE_KEY || "").trim()
    && String(env?.VAPID_PUBLIC_KEY || "").trim()
    && String(env?.VAPID_SUBJECT || "").trim()
  );
}

function cooldownResult(adminId, nowMs) {
  const previous = testPushLastSentAt.get(adminId) || 0;
  if (previous && nowMs - previous < TEST_PUSH_COOLDOWN_MS) {
    return {
      ok: false,
      status: 429,
      code: "ADMIN_PUSH_TEST_COOLDOWN",
      retryAfter: Math.max(1, Math.ceil((TEST_PUSH_COOLDOWN_MS - (nowMs - previous)) / 1000))
    };
  }
  testPushLastSentAt.set(adminId, nowMs);
  if (testPushLastSentAt.size > 1000) {
    for (const [key, timestamp] of testPushLastSentAt) {
      if (nowMs - timestamp >= TEST_PUSH_COOLDOWN_MS) testPushLastSentAt.delete(key);
    }
  }
  return null;
}

export async function sendAdminTestPush({
  db,
  env,
  adminUserId,
  body,
  now = new Date(),
  sendPush = sendWebPushSubscription
} = {}) {
  const validation = validateAdminTestPushBody(body);
  if (!validation.ok) return { ...validation, status: 400 };
  const adminId = boundedAdminId(adminUserId);
  if (!adminId) return { ok: false, status: 403, code: "ADMIN_PUSH_ADMIN_REQUIRED" };
  if (!configured(env)) return { ok: false, status: 503, code: "ADMIN_PUSH_NOT_CONFIGURED" };

  const subscriptions = await listActivePushSubscriptions(db, {
    adminUserId: adminId,
    limit: MAX_TEST_PUSH_DEVICES
  });
  if (!subscriptions.length) {
    return { ok: false, status: 409, code: "NO_ACTIVE_PUSH_SUBSCRIPTION" };
  }

  const timestamp = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(timestamp)) return { ok: false, status: 400, code: "ADMIN_PUSH_INVALID_TIME" };
  const limited = cooldownResult(adminId, timestamp);
  if (limited) return limited;

  let sent = 0;
  let failed = 0;
  for (const subscription of subscriptions) {
    try {
      const result = await sendPush(subscription, ADMIN_TEST_PUSH_PAYLOAD, env, { now });
      if (result?.ok) sent += 1;
      else failed += 1;
      if (result?.stale) {
        await disablePushSubscription(db, subscription.id, result.code || "PUSH_SUBSCRIPTION_GONE", now);
      }
    } catch {
      failed += 1;
    }
  }

  if (sent > 0) return { ok: true, status: 200, sent, failed };
  return { ok: false, status: 502, code: "ADMIN_PUSH_TEST_FAILED", sent, failed };
}

export { MAX_TEST_PUSH_DEVICES, TEST_PUSH_COOLDOWN_MS };
