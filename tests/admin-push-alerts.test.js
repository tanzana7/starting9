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
  return { database, db: d1(database) };
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
  assert.match(worker, /\/api\/admin\/push\/subscribe/);
  assert.match(worker, /requireAdminUser\(request, env, cors\)/);
  assert.match(serviceWorker, /origin !== self\.location\.origin/);
  assert.match(serviceWorker, /openWindow/);
  assert.match(html, /push-controls\.js\?v=v5-phase6-1/);
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
