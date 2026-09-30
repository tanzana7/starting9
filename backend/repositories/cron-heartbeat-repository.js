const CRON_HEARTBEAT_ID = 1;
const DEFAULT_CRON_INTERVAL_MINUTES = 1;
const DEFAULT_CRON_GRACE_MINUTES = 5;

function schemaError(error) {
  return /no such table|does not exist/i.test(String(error?.message || error));
}

function toIsoTimestamp(value, label = "timestamp") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`CRON_HEARTBEAT_${label.toUpperCase()}_INVALID`);
  return date.toISOString();
}

function nullableTimestamp(value) {
  return value ? toIsoTimestamp(value) : null;
}

export function normalizeCronHeartbeatRow(row = null) {
  return {
    schemaAvailable: true,
    lastInvocationAt: row?.last_invocation_at || row?.lastInvocationAt || null,
    lastCompletedAt: row?.last_completed_at || row?.lastCompletedAt || null,
    lastFailedAt: row?.last_failed_at || row?.lastFailedAt || null,
    lastOutcome: row?.last_outcome || row?.lastOutcome || null,
    updatedAt: row?.updated_at || row?.updatedAt || null
  };
}

export function emptyCronHeartbeat({ schemaAvailable = true } = {}) {
  return {
    schemaAvailable,
    lastInvocationAt: null,
    lastCompletedAt: null,
    lastFailedAt: null,
    lastOutcome: null,
    updatedAt: null
  };
}

export function deriveCronHeartbeatStatus(heartbeat = null, {
  now = new Date(),
  intervalMinutes = DEFAULT_CRON_INTERVAL_MINUTES,
  graceMinutes = DEFAULT_CRON_GRACE_MINUTES
} = {}) {
  const current = new Date(now);
  const invocationAt = heartbeat?.lastInvocationAt ? new Date(heartbeat.lastInvocationAt) : null;
  if (!invocationAt || Number.isNaN(invocationAt.getTime()) || Number.isNaN(current.getTime())) return "never_seen";
  const graceMs = Math.max(0, Number(graceMinutes) || 0) * 60 * 1000;
  if (current.getTime() - invocationAt.getTime() > graceMs) return "stale";
  const failedAt = heartbeat?.lastFailedAt ? new Date(heartbeat.lastFailedAt) : null;
  const completedAt = heartbeat?.lastCompletedAt ? new Date(heartbeat.lastCompletedAt) : null;
  if (failedAt && !Number.isNaN(failedAt.getTime()) && (!completedAt || failedAt.getTime() > completedAt.getTime())) return "failed_recently";
  return "healthy";
}

export function buildCronHeartbeatReadModel(heartbeat = null, {
  now = new Date(),
  intervalMinutes = DEFAULT_CRON_INTERVAL_MINUTES,
  graceMinutes = DEFAULT_CRON_GRACE_MINUTES
} = {}) {
  const normalized = heartbeat?.schemaAvailable === false ? emptyCronHeartbeat({ schemaAvailable: false }) : normalizeCronHeartbeatRow(heartbeat);
  const invocationAt = normalized.lastInvocationAt ? new Date(normalized.lastInvocationAt) : null;
  const intervalMs = Math.max(0, Number(intervalMinutes) || 0) * 60 * 1000;
  const nextInvocationAt = invocationAt && !Number.isNaN(invocationAt.getTime()) && intervalMs
    ? new Date(invocationAt.getTime() + intervalMs).toISOString()
    : null;
  return {
    ...normalized,
    nextInvocationAt,
    status: deriveCronHeartbeatStatus(normalized, { now, intervalMinutes, graceMinutes }),
    intervalMinutes: Number(intervalMinutes) || DEFAULT_CRON_INTERVAL_MINUTES,
    graceMinutes: Number.isFinite(Number(graceMinutes)) ? Number(graceMinutes) : DEFAULT_CRON_GRACE_MINUTES
  };
}

export async function getCronHeartbeat(db) {
  try {
    const row = await db.prepare(
      `SELECT last_invocation_at, last_completed_at, last_failed_at, last_outcome, updated_at
         FROM cron_heartbeat WHERE id = ?1 LIMIT 1`
    ).bind(CRON_HEARTBEAT_ID).first();
    return normalizeCronHeartbeatRow(row);
  } catch (error) {
    if (schemaError(error)) return emptyCronHeartbeat({ schemaAvailable: false });
    throw error;
  }
}

export async function recordCronInvocation(db, now = new Date()) {
  const timestamp = toIsoTimestamp(now, "invocation");
  return db.prepare(
    `INSERT INTO cron_heartbeat (id, last_invocation_at, updated_at)
     VALUES (?1, ?2, ?2)
     ON CONFLICT(id) DO UPDATE SET
       last_invocation_at = CASE
         WHEN cron_heartbeat.last_invocation_at IS NULL OR cron_heartbeat.last_invocation_at <= excluded.last_invocation_at
         THEN excluded.last_invocation_at ELSE cron_heartbeat.last_invocation_at END,
       updated_at = excluded.updated_at`
  ).bind(CRON_HEARTBEAT_ID, timestamp).run();
}

export async function recordCronCompleted(db, now = new Date()) {
  const timestamp = toIsoTimestamp(now, "completed");
  return db.prepare(
    `INSERT INTO cron_heartbeat (id, last_completed_at, last_outcome, updated_at)
     VALUES (?1, ?2, 'completed', ?2)
     ON CONFLICT(id) DO UPDATE SET
       last_completed_at = CASE
         WHEN cron_heartbeat.last_completed_at IS NULL OR cron_heartbeat.last_completed_at <= excluded.last_completed_at
         THEN excluded.last_completed_at ELSE cron_heartbeat.last_completed_at END,
       last_outcome = CASE
         WHEN cron_heartbeat.last_failed_at IS NOT NULL AND cron_heartbeat.last_failed_at > excluded.last_completed_at
         THEN 'failed' ELSE 'completed' END,
       updated_at = excluded.updated_at`
  ).bind(CRON_HEARTBEAT_ID, timestamp).run();
}

export async function recordCronFailed(db, now = new Date()) {
  const timestamp = toIsoTimestamp(now, "failed");
  return db.prepare(
    `INSERT INTO cron_heartbeat (id, last_failed_at, last_outcome, updated_at)
     VALUES (?1, ?2, 'failed', ?2)
     ON CONFLICT(id) DO UPDATE SET
       last_failed_at = CASE
         WHEN cron_heartbeat.last_failed_at IS NULL OR cron_heartbeat.last_failed_at <= excluded.last_failed_at
         THEN excluded.last_failed_at ELSE cron_heartbeat.last_failed_at END,
       last_outcome = CASE
         WHEN cron_heartbeat.last_completed_at IS NOT NULL AND cron_heartbeat.last_completed_at > excluded.last_failed_at
         THEN 'completed' ELSE 'failed' END,
       updated_at = excluded.updated_at`
  ).bind(CRON_HEARTBEAT_ID, timestamp).run();
}
