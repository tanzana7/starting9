import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALERT_TYPES,
  evaluateAdminAlertCandidates
} from "../backend/admin-alerts/evaluator.js";
import {
  disablePushSubscriptions,
  getPushStatus,
  listRecentAlertIncidents,
  upsertAlertIncident,
  upsertPushSubscription
} from "../backend/admin-alerts/storage.js";
import { buildPushPayload, safeActionPath } from "../backend/admin-alerts/push.js";
import { sendAdminTestPush } from "../backend/admin-alerts/test-push.js";
import worker from "../auth-worker.js";
import { evaluateAndNotifyAdminAlerts } from "../backend/admin-alerts/runtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GAME = { internalGameId: "2026-09-29-fighters-buffaloes-1800", gameDate: "2026-09-29", homeTeam: "fighters", awayTeam: "buffaloes" };

function d1(database) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async first() { return database.prepare(sql).get(...params) || null; },
            async all() { return { results: database.prepare(sql).all(...params) }; },
            async run() { const result = database.prepare(sql).run(...params); return { meta: { changes: Number(result.changes || 0) } }; }
          };
        }
      };
    }
  };
}

function fixtureDb() {
  const database = new DatabaseSync(":memory:");
  database.exec(fs.readFileSync(path.join(ROOT, "migrations", "0001_auth.sql"), "utf8"));
  database.exec(fs.readFileSync(path.join(ROOT, "migrations", "0044_admin_push_alerts.sql"), "utf8"));
  database.prepare(`INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at)
                    VALUES ('admin-1', 'admin', 'admin', 'hash', 'salt', 1, '2026-01-01', '2026-01-01')`).run();
  database.prepare(`INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at)
                    VALUES ('admin-2', 'admin2', 'admin2', 'hash', 'salt', 1, '2026-01-01', '2026-01-01')`).run();
  return { database, db: d1(database) };
}

async function routeFixture(role) {
  const database = new DatabaseSync(":memory:");
  database.exec(fs.readFileSync(path.join(ROOT, "migrations", "0001_auth.sql"), "utf8"));
  database.exec(fs.readFileSync(path.join(ROOT, "migrations", "0004_admin_role.sql"), "utf8"));
  database.exec(fs.readFileSync(path.join(ROOT, "migrations", "0044_admin_push_alerts.sql"), "utf8"));
  const token = `admin-push-route-${role}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  const tokenHash = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  database.prepare(`INSERT INTO users
    (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at, role)
    VALUES ('route-user', 'route-user', 'route-user', 'hash', 'salt', 1, '2026-01-01', '2026-01-01', ?1)`).run(role);
  database.prepare(`INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
    VALUES ('route-session', 'route-user', ?1, '2026-01-01', '2099-01-01', '2026-01-01')`).run(tokenHash);
  return {
    db: d1(database),
    env: {
      AUTH_DB: d1(database),
      AUTH_ALLOWED_ORIGINS: "https://starting9.test",
      VAPID_PRIVATE_KEY: "private",
      VAPID_PUBLIC_KEY: "public",
      VAPID_SUBJECT: "https://starting9.pages.dev/contact.html"
    },
    token
  };
}

test("alert evaluator emits critical alerts only for explicit abnormal signals", () => {
  const alerts = evaluateAdminAlertCandidates({ game: GAME, signals: {
    predictionCloseOverdue: true,
    scoreFailure: true,
    rankingFailure: false,
    publishFailure: false,
    gameCodeAmbiguous: false
  } });
  assert.deepEqual(alerts.map((alert) => alert.alertType), [ALERT_TYPES.PREDICTION_CLOSE_OVERDUE, ALERT_TYPES.SCORE_FAILURE]);
  assert.ok(alerts.every((alert) => alert.severity === "critical"));
  assert.equal(alerts[0].actionPath, `/admin-v3.html#game=${encodeURIComponent(GAME.internalGameId)}`);
});

test("normal pending/retry and V4 disabled fetch stages stay silent", () => {
  const alerts = evaluateAdminAlertCandidates({ game: GAME, signals: {
    normalPending: true,
    normalRetry: true,
    rosterFetchMissing: true,
    lineupFetchMissing: true,
    predictionCloseOverdue: false,
    manualLineupOverdue: false
  } });
  assert.deepEqual(alerts, []);
});

test("canonical, revision, and publication integrity signals map to separate alert types", () => {
  const alerts = evaluateAdminAlertCandidates({ game: GAME, signals: {
    canonicalLineupInvalid: true,
    scoringArtifactInvalid: true,
    rankingRevisionMismatch: true,
    publicationInvalid: true
  } });
  assert.deepEqual(alerts.map((alert) => alert.alertType), [
    ALERT_TYPES.CANONICAL_LINEUP_INVALID,
    ALERT_TYPES.SCORING_ARTIFACT_INVALID,
    ALERT_TYPES.RANKING_REVISION_MISMATCH,
    ALERT_TYPES.PUBLICATION_INVALID
  ]);
});

test("subscription is admin-bound, endpoint-upserted, and status does not expose endpoint", async () => {
  const { db } = fixtureDb();
  const subscription = { endpoint: "https://push.example.test/a", p256dh: "B".repeat(87), auth: "A".repeat(22) };
  assert.equal((await upsertPushSubscription(db, { adminUserId: "admin-1", subscription, createId: () => "push-1" })).ok, true);
  assert.equal((await upsertPushSubscription(db, { adminUserId: "admin-1", subscription, createId: () => "push-2" })).id, "push-1");
  const status = await getPushStatus(db, "admin-1", { vapidPublicKey: "public-key" });
  assert.deepEqual(status, { configured: true, publicKey: "public-key", subscribed: true, deviceCount: 1 });
  assert.equal(JSON.stringify(status).includes("push.example"), false);
  assert.equal((await upsertPushSubscription(db, { adminUserId: "user-2", subscription: { ...subscription, endpoint: "http://insecure.example/a" } })).ok, false);
});

test("test push sends only to the authenticated admin's bounded active subscriptions with a fixed payload", async () => {
  const { db, database } = fixtureDb();
  const sent = [];
  const subscription = (suffix) => ({ endpoint: `https://push.example.test/${suffix}`, p256dh: "B".repeat(87), auth: "A".repeat(22) });
  await upsertPushSubscription(db, { adminUserId: "admin-1", subscription: subscription("one"), createId: () => "push-test-1" });
  await upsertPushSubscription(db, { adminUserId: "admin-1", subscription: subscription("two"), createId: () => "push-test-2" });
  await upsertPushSubscription(db, { adminUserId: "admin-2", subscription: subscription("other"), createId: () => "push-test-3" });
  const result = await sendAdminTestPush({
    db,
    env: { VAPID_PRIVATE_KEY: "private", VAPID_PUBLIC_KEY: "public", VAPID_SUBJECT: "https://starting9.pages.dev/contact.html" },
    adminUserId: "admin-1",
    body: {},
    now: new Date("2026-09-29T09:00:00Z"),
    sendPush: async (row, payload) => { sent.push({ row, payload }); return { ok: true, status: 201 }; }
  });
  assert.deepEqual(result, { ok: true, status: 200, sent: 2, failed: 0 });
  assert.equal(sent.length, 2);
  assert.ok(sent.every(({ row }) => row.admin_user_id === "admin-1"));
  assert.ok(sent.every(({ payload }) => payload.title === "Starting9 運営通知テスト"));
  assert.ok(sent.every(({ payload }) => payload.body === "Push通知を正常に受信できています。"));
  assert.ok(sent.every(({ payload }) => payload.actionPath === "/admin-v3.html"));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admin_alert_incidents").get().count, 0);
});

test("test push rejects arbitrary body, handles no subscription, cooldown, partial failure, and stale endpoints", async () => {
  const { db } = fixtureDb();
  const configured = { VAPID_PRIVATE_KEY: "private", VAPID_PUBLIC_KEY: "public", VAPID_SUBJECT: "https://starting9.pages.dev/contact.html" };
  assert.equal((await sendAdminTestPush({ db, env: configured, adminUserId: "admin-none", body: {}, now: new Date("2026-09-29T09:01:00Z") })).code, "NO_ACTIVE_PUSH_SUBSCRIPTION");
  assert.equal((await sendAdminTestPush({ db, env: configured, adminUserId: "admin-1", body: { endpoint: "https://evil.example" }, now: new Date("2026-09-29T09:02:00Z") })).code, "ADMIN_PUSH_TEST_BODY_INVALID");
  const subscription = (suffix) => ({ endpoint: `https://push.example.test/${suffix}`, p256dh: "B".repeat(87), auth: "A".repeat(22) });
  await upsertPushSubscription(db, { adminUserId: "admin-1", subscription: subscription("cooldown"), createId: () => "push-cooldown" });
  await upsertPushSubscription(db, { adminUserId: "admin-2", subscription: subscription("stale"), createId: () => "push-stale" });
  const first = await sendAdminTestPush({ db, env: configured, adminUserId: "admin-1", body: {}, now: new Date("2026-09-29T09:03:00Z"), sendPush: async () => ({ ok: true, status: 201 }) });
  assert.equal(first.ok, true);
  const limited = await sendAdminTestPush({ db, env: configured, adminUserId: "admin-1", body: {}, now: new Date("2026-09-29T09:03:10Z"), sendPush: async () => ({ ok: true, status: 201 }) });
  assert.equal(limited.code, "ADMIN_PUSH_TEST_COOLDOWN");
  const stale = await sendAdminTestPush({ db, env: configured, adminUserId: "admin-2", body: {}, now: new Date("2026-09-29T09:04:00Z"), sendPush: async () => ({ ok: false, stale: true, code: "PUSH_HTTP_410" }) });
  assert.equal(stale.status, 502);
  assert.equal((await getPushStatus(db, "admin-2", { vapidPublicKey: "public" })).subscribed, false);
});

test("unsubscribe is scoped to the authenticated admin and can disable one endpoint", async () => {
  const { db } = fixtureDb();
  const subscription = { endpoint: "https://push.example.test/a", p256dh: "B".repeat(87), auth: "A".repeat(22) };
  await upsertPushSubscription(db, { adminUserId: "admin-1", subscription, createId: () => "push-1" });
  await disablePushSubscriptions(db, "admin-1", { endpoint: subscription.endpoint });
  assert.equal((await getPushStatus(db, "admin-1", { vapidPublicKey: "public-key" })).subscribed, false);
});

test("same active incident is deduplicated and resolved incidents can re-notify", async () => {
  const { db } = fixtureDb();
  const alert = evaluateAdminAlertCandidates({ game: GAME, signals: { scoreFailure: true } })[0];
  const first = await upsertAlertIncident(db, alert, { createId: () => "incident-1", now: new Date("2026-09-29T09:00:00Z") });
  const second = await upsertAlertIncident(db, alert, { createId: () => "incident-2", now: new Date("2026-09-29T09:01:00Z") });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.notify, true);
  const rows = await listRecentAlertIncidents(db);
  assert.equal(rows.length, 1);
  await db.prepare("UPDATE admin_alert_incidents SET last_notified_at = ?1 WHERE id = ?2").bind("2026-09-29T09:00:10Z", "incident-1").run();
  await db.prepare("UPDATE admin_alert_incidents SET status = 'resolved', resolved_at = ?1 WHERE id = ?2").bind("2026-09-29T09:02:00Z", "incident-1").run();
  const third = await upsertAlertIncident(db, alert, { createId: () => "incident-3", now: new Date("2026-09-29T09:03:00Z") });
  assert.equal(third.created, true);
  assert.equal(third.incident.id, "incident-3");
});

test("push delivery failure or missing VAPID config does not fail alert evaluation", async () => {
  const { db, database } = fixtureDb();
  await upsertPushSubscription(db, {
    adminUserId: "admin-1",
    subscription: { endpoint: "https://push.example.test/a", p256dh: "B".repeat(87), auth: "A".repeat(22) },
    createId: () => "push-1"
  });
  const result = await evaluateAndNotifyAdminAlerts({
    db,
    env: {},
    games: [GAME],
    getSignals: async () => ({ scoreFailure: true }),
    createId: () => "incident-1"
  });
  assert.equal(result.ok, true);
  assert.equal(result.deliveryFailures, 0);
  assert.equal(database.prepare("SELECT last_notified_at FROM admin_alert_incidents WHERE id = 'incident-1'").get().last_notified_at, null);
});

test("payload is short and never includes VAPID private key or stack details", () => {
  const payload = buildPushPayload({ title: "x".repeat(500), body: "trace secret", action_path: "https://evil.example", severity: "critical" });
  assert.equal(payload.title.length, 120);
  assert.equal(payload.body, "trace secret");
  assert.equal(payload.actionPath, "/admin-v3.html");
  assert.equal(safeActionPath("/admin-v3.html#game=game-1"), "/admin-v3.html#game=game-1");
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "privateKey"), false);
});

test("migration is additive and creates both admin-only tables", () => {
  const { database } = fixtureDb();
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('admin_push_subscriptions', 'admin_alert_incidents') ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ["admin_alert_incidents", "admin_push_subscriptions"]);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'admin_push_%'").all().length, 1);
});

test("admin push routes and service worker preserve auth and safe navigation boundaries", () => {
  const worker = fs.readFileSync(path.join(ROOT, "auth-worker.js"), "utf8");
  const serviceWorker = fs.readFileSync(path.join(ROOT, "admin-push-sw.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "admin-v3.html"), "utf8");
  const controls = fs.readFileSync(path.join(ROOT, "frontend", "admin-v3", "push-controls.js"), "utf8");
  assert.match(worker, /\/api\/admin\/push\/subscribe/);
  assert.match(worker, /\/api\/admin\/push\/test/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
  assert.match(serviceWorker, /origin !== self\.location\.origin/);
  assert.match(serviceWorker, /openWindow/);
  assert.match(html, /push-controls\.js\?v=v5-phase6-2/);
  assert.match(html, /adminPushTest/);
  assert.match(controls, /api\.sendPushTest\(\)/);
  assert.match(controls, /testButton\.disabled/);
});

test("unauthenticated clients cannot register an admin push subscription", async () => {
  const response = await worker.fetch(new Request("https://starting9-auth.example/api/admin/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: "https://push.example.test/a", p256dh: "B", auth: "A" })
  }), { AUTH_DB: {}, AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev" });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, undefined);
});

test("unauthenticated test push cannot be invoked", async () => {
  const response = await worker.fetch(new Request("https://starting9-auth.example/api/admin/push/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  }), { AUTH_DB: {}, AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev" });
  assert.equal(response.status, 401);
});

test("test push requires admin role and returns a safe 4xx when the admin has no device", async () => {
  const nonAdmin = await routeFixture("user");
  const nonAdminResponse = await worker.fetch(new Request("https://starting9.test/api/admin/push/test", {
    method: "POST",
    headers: {
      Origin: "https://starting9.test",
      Cookie: `s9_session=${encodeURIComponent(nonAdmin.token)}`,
      "Content-Type": "application/json"
    },
    body: "{}"
  }), nonAdmin.env, {});
  assert.equal(nonAdminResponse.status, 403);

  const admin = await routeFixture("admin");
  const adminResponse = await worker.fetch(new Request("https://starting9.test/api/admin/push/test", {
    method: "POST",
    headers: {
      Origin: "https://starting9.test",
      Cookie: `s9_session=${encodeURIComponent(admin.token)}`,
      "Content-Type": "application/json"
    },
    body: "{}"
  }), admin.env, {});
  assert.equal(adminResponse.status, 409);
  assert.equal((await adminResponse.json()).code, "NO_ACTIVE_PUSH_SUBSCRIPTION");
});
