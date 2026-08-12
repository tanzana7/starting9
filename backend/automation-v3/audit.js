import { normalizeV3DiagnosticJobType } from "./diagnostics.js";

// Pure V3 audit record builders. Persistence remains at the Worker boundary.
export function buildV3CronJobAuditInsert({
  auditColumns = new Set(),
  runId,
  correlationId,
  eventType = "job",
  job,
  internalGameId = null,
  claimToken = null,
  stateBefore = null,
  execution = null,
  failure = null,
  occurredAt = new Date(),
  now = new Date()
} = {}) {
  const columns = [
    ...(auditColumns.has("event_type") ? ["event_type"] : []),
    "internal_game_id", "job_id", "job_type", "scheduled_slot_at", "claim_id",
    "state_before", "state_after", "attempt_count", "failure_code", "failure_message",
    ...(auditColumns.has("data_status") ? ["data_status"] : []), "occurred_at", "source"
  ];
  const statusAfter = String(job?.status || (failure ? "retry_wait" : "completed"));
  const probableStarter = execution?.probableStarter || null;
  const dataStatus = execution?.dataStatus || probableStarter?.dataStatus || null;
  const noOpReason = execution?.noOpReason || null;
  const failureCode = failure?.code || execution?.failureCode || job?.failure_code || probableStarter?.errorCode || null;
  const resolvedEventType = eventType === "job" && noOpReason
    ? execution?.noOpEventType || "scoring_no_op"
    : eventType;
  const noOpMessage = resolvedEventType === "ranking_no_op" ? "ランキング対象なし" : "採点対象なし";
  const failureBaseMessage = failure?.message || execution?.failureMessage || job?.failure_message
    || (noOpReason ? `${noOpMessage}: ${noOpReason}` : null);
  const resolvedInternalGameId = job?.internal_game_id || internalGameId || null;
  const auditJobType = normalizeV3DiagnosticJobType({
    job,
    jobType: execution?.jobType,
    plannerDecision: execution?.plannerDecision
  });
  const structuredDetails = {
    schemaVersion: 1,
    runId,
    correlationId,
    eventType: resolvedEventType,
    stage: execution?.stage || execution?.executorStage || resolvedEventType,
    internalGameId: resolvedInternalGameId,
    jobId: job?.id || null,
    jobType: auditJobType,
    scheduledSlotAt: job?.scheduled_slot_at || null,
    status: statusAfter,
    stateBefore: execution?.stateBefore || stateBefore || null,
    stateAfter: execution?.stateAfter || null,
    attemptCount: Number(job?.attempt_count || 0),
    reasonCode: execution?.reasonCode || execution?.plannerDecision?.reasonCode || failureCode || null,
    failureCode,
    failureMessage: failureBaseMessage ? String(failureBaseMessage).slice(0, 1200) : null,
    ...execution
  };
  if (failure?.diagnostics && typeof failure.diagnostics === "object") {
    structuredDetails.diagnostics = failure.diagnostics;
  }
  let failureMessage = failureBaseMessage;
  try {
    failureMessage = `${failureBaseMessage || ""}${failureBaseMessage ? " " : ""}[v3_details=${JSON.stringify(structuredDetails)}]`.slice(0, 8000);
  } catch {
    failureMessage = failureBaseMessage;
  }
  const occurred = new Date(occurredAt || job?.completed_at || job?.updated_at || now).toISOString();
  const values = [
    ...(auditColumns.has("event_type") ? [resolvedEventType] : []),
    resolvedInternalGameId,
    job?.id || null,
    auditJobType,
    job?.scheduled_slot_at || null,
    job?.claim_token || claimToken || null,
    execution?.stateBefore || stateBefore || null,
    execution?.stateAfter || null,
    Number(job?.attempt_count || 0),
    failureCode,
    failureMessage ? String(failureMessage).slice(0, 8000) : null,
    ...(auditColumns.has("data_status") ? [dataStatus] : []),
    occurred,
    "cron"
  ];
  return { columns, values, eventType: resolvedEventType, structuredDetails };
}

export function buildV3ScheduleSyncAuditInsert({
  auditColumns = new Set(),
  internalGameId,
  diagnostics,
  runId,
  correlationId,
  now = new Date()
} = {}) {
  const columns = [
    ...(auditColumns.has("event_type") ? ["event_type"] : []),
    "internal_game_id", "job_type", "state_before", "state_after",
    "failure_code", "failure_message", "occurred_at", "source"
  ];
  const errorCode = diagnostics?.errorCode || null;
  const message = JSON.stringify({
    ...diagnostics,
    runId,
    correlationId,
    stage: "schedule_sync",
    lastScheduleSyncAt: diagnostics?.lastScheduleSyncAt || now.toISOString()
  });
  const values = [
    ...(auditColumns.has("event_type") ? ["schedule_sync"] : []),
    internalGameId,
    "schedule_sync",
    "scheduled",
    diagnostics?.status || "unknown",
    errorCode,
    message,
    diagnostics?.lastScheduleSyncAt || now.toISOString(),
    "cron"
  ];
  return { columns, values };
}
