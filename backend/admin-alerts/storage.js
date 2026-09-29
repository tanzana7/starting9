const ENDPOINT_MAX_LENGTH = 2048;
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

function clean(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function nowIso(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error("ADMIN_ALERT_INVALID_TIME");
  return date.toISOString();
}

function newId(createId = null, prefix = "id") {
  const value = typeof createId === "function" ? createId() : globalThis.crypto?.randomUUID?.();
  return clean(value || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`, 160);
}

export function validatePushSubscription(input = {}) {
  const endpoint = clean(input.endpoint, ENDPOINT_MAX_LENGTH);
  let parsed;
  try { parsed = new URL(endpoint); } catch { parsed = null; }
  const p256dh = clean(input.p256dh, 200);
  const auth = clean(input.auth, 100);
  if (!parsed || parsed.protocol !== "https:" || endpoint.includes("\r") || endpoint.includes("\n")) {
    return { ok: false, code: "ADMIN_PUSH_ENDPOINT_INVALID" };
  }
  if (!p256dh || !KEY_PATTERN.test(p256dh) || !auth || !KEY_PATTERN.test(auth)) {
    return { ok: false, code: "ADMIN_PUSH_KEYS_INVALID" };
  }
  return { ok: true, endpoint, p256dh, auth };
}

export async function upsertPushSubscription(db, { adminUserId, subscription, now = new Date(), createId } = {}) {
  const adminId = clean(adminUserId, 160);
  const validated = validatePushSubscription(subscription);
  if (!adminId || !validated.ok) return { ok: false, code: validated.code || "ADMIN_PUSH_ADMIN_REQUIRED" };
  const timestamp = nowIso(now);
  const existing = await db.prepare("SELECT id FROM admin_push_subscriptions WHERE endpoint = ?1 LIMIT 1").bind(validated.endpoint).first();
  const id = clean(existing?.id || newId(createId, "push"), 160);
  await db.prepare(
    `INSERT INTO admin_push_subscriptions
      (id, admin_user_id, endpoint, p256dh, auth, created_at, updated_at, disabled_at, last_error_code)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, NULL, NULL)
     ON CONFLICT(endpoint) DO UPDATE SET
       admin_user_id = excluded.admin_user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       updated_at = excluded.updated_at,
       disabled_at = NULL,
       last_error_code = NULL`
  ).bind(id, adminId, validated.endpoint, validated.p256dh, validated.auth, timestamp).run();
  return { ok: true, id };
}

export async function getPushStatus(db, adminUserId, { vapidPublicKey = "" } = {}) {
  const adminId = clean(adminUserId, 160);
  const row = adminId ? await db.prepare(
    "SELECT COUNT(*) AS count FROM admin_push_subscriptions WHERE admin_user_id = ?1 AND disabled_at IS NULL"
  ).bind(adminId).first() : null;
  return {
    configured: Boolean(clean(vapidPublicKey, 200)),
    publicKey: clean(vapidPublicKey, 200) || null,
    subscribed: Number(row?.count || 0) > 0,
    deviceCount: Math.min(99, Number(row?.count || 0))
  };
}

export async function disablePushSubscriptions(db, adminUserId, { endpoint = "", now = new Date() } = {}) {
  const adminId = clean(adminUserId, 160);
  const timestamp = nowIso(now);
  if (!adminId) return { ok: false, code: "ADMIN_PUSH_ADMIN_REQUIRED" };
  if (endpoint) {
    const validated = validatePushSubscription({ endpoint, p256dh: "x", auth: "x" });
    if (!validated.ok) return { ok: false, code: "ADMIN_PUSH_ENDPOINT_INVALID" };
    await db.prepare(
      "UPDATE admin_push_subscriptions SET disabled_at = ?1, updated_at = ?1 WHERE admin_user_id = ?2 AND endpoint = ?3"
    ).bind(timestamp, adminId, validated.endpoint).run();
  } else {
    await db.prepare(
      "UPDATE admin_push_subscriptions SET disabled_at = ?1, updated_at = ?1 WHERE admin_user_id = ?2 AND disabled_at IS NULL"
    ).bind(timestamp, adminId).run();
  }
  return { ok: true };
}

export async function listActivePushSubscriptions(db, { limit = 50 } = {}) {
  const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 50));
  const result = await db.prepare(
    `SELECT id, admin_user_id, endpoint, p256dh, auth
       FROM admin_push_subscriptions
      WHERE disabled_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ?1`
  ).bind(boundedLimit).all();
  return result.results || [];
}

export async function disablePushSubscription(db, id, errorCode, now = new Date()) {
  await db.prepare(
    "UPDATE admin_push_subscriptions SET disabled_at = ?1, updated_at = ?1, last_error_code = ?2 WHERE id = ?3"
  ).bind(nowIso(now), clean(errorCode, 120), clean(id, 160)).run();
}

export async function upsertAlertIncident(db, alert, { now = new Date(), createId } = {}) {
  const timestamp = nowIso(now);
  const existing = await db.prepare(
    "SELECT * FROM admin_alert_incidents WHERE dedupe_key = ?1 AND status = 'active' LIMIT 1"
  ).bind(clean(alert.dedupeKey, 240)).first();
  if (existing) {
    await db.prepare(
      `UPDATE admin_alert_incidents
          SET last_seen_at = ?1, title = ?2, body = ?3, action_path = ?4, severity = ?5
        WHERE id = ?6 AND status = 'active'`
    ).bind(timestamp, clean(alert.title, 120), clean(alert.body, 240), clean(alert.actionPath, 240), clean(alert.severity, 20), existing.id).run();
    return { incident: { ...existing, last_seen_at: timestamp }, created: false, notify: !existing.last_notified_at };
  }
  const id = newId(createId, "incident");
  try {
    await db.prepare(
      `INSERT INTO admin_alert_incidents
        (id, internal_game_id, alert_type, severity, dedupe_key, title, body, action_path, status, first_seen_at, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?9)`
    ).bind(id, clean(alert.gameId, 160), clean(alert.alertType, 80), clean(alert.severity, 20), clean(alert.dedupeKey, 240), clean(alert.title, 120), clean(alert.body, 240), clean(alert.actionPath, 240), timestamp).run();
    return { incident: { ...alert, id, status: "active", first_seen_at: timestamp, last_seen_at: timestamp }, created: true, notify: true };
  } catch (error) {
    const raced = await db.prepare(
      "SELECT * FROM admin_alert_incidents WHERE dedupe_key = ?1 AND status = 'active' LIMIT 1"
    ).bind(clean(alert.dedupeKey, 240)).first();
    if (raced) return { incident: raced, created: false, notify: !raced.last_notified_at };
    throw error;
  }
}

export async function listActiveIncidentsForGame(db, gameId) {
  const result = await db.prepare(
    "SELECT * FROM admin_alert_incidents WHERE internal_game_id = ?1 AND status = 'active' ORDER BY last_seen_at DESC LIMIT 30"
  ).bind(clean(gameId, 160)).all();
  return result.results || [];
}

export async function resolveAlertIncident(db, dedupeKey, now = new Date()) {
  await db.prepare(
    "UPDATE admin_alert_incidents SET status = 'resolved', resolved_at = ?1, last_seen_at = ?1 WHERE dedupe_key = ?2 AND status = 'active'"
  ).bind(nowIso(now), clean(dedupeKey, 240)).run();
}

export async function markIncidentNotified(db, id, { delivered = 0, errorCode = null, now = new Date() } = {}) {
  await db.prepare(
    `UPDATE admin_alert_incidents
        SET last_notified_at = ?1,
            notification_count = notification_count + ?2,
            last_error_code = ?3
      WHERE id = ?4 AND status = 'active'`
  ).bind(nowIso(now), Math.max(0, Number(delivered) || 0), clean(errorCode, 120) || null, clean(id, 160)).run();
}

export async function listRecentAlertIncidents(db, { limit = 30 } = {}) {
  const boundedLimit = Math.min(50, Math.max(1, Number(limit) || 30));
  const result = await db.prepare(
    `SELECT id, internal_game_id, alert_type, severity, title, body, action_path,
            status, first_seen_at, last_seen_at, resolved_at, last_notified_at, notification_count
       FROM admin_alert_incidents
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, last_seen_at DESC
      LIMIT ?1`
  ).bind(boundedLimit).all();
  return result.results || [];
}
