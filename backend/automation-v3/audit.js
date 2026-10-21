import { normalizeV3DiagnosticJobType } from "./diagnostics.js";

export function classifyV3AuditEvent({ eventType = "", jobType = "", failureCode = "", execution = null, source = "cron" } = {}) {
  const event = String(eventType || "").toLowerCase();
  const job = String(jobType || execution?.jobType || "").toLowerCase();
  const reason = String(failureCode || execution?.reasonCode || execution?.errorCode || "").toLowerCase();
  const isFailure = Boolean(failureCode || execution?.failureCode || execution?.errorCode)
    || /failed|error|mismatch|stale|retry|reclaim|invalid|malformed|empty|timeout|recovery/.test(`${event} ${reason}`)
    || ["failed", "error", "terminal_failed", "retry_wait", "reclaimed", "stale"].includes(String(execution?.status || "").toLowerCase());
  if (isFailure) return { severity: "ERROR", category: "ERROR" };
  if (String(source || "").toLowerCase() === "admin" || event.includes("admin") || job.startsWith("admin:")) return { severity: "INFO", category: "ADMIN" };
  if (event.includes("roster") || job.includes("roster")) return { severity: "INFO", category: "ROSTER" };
  if (event.includes("score") || job === "score" || job === "scoring") return { severity: "INFO", category: "SCORE" };
  if (event.includes("rank") || job.includes("rank")) return { severity: "INFO", category: "RANKING" };
  if (event.includes("publish") || job.includes("publish")) return { severity: "INFO", category: "PUBLISH" };
  return { severity: "INFO", category: "SYSTEM" };
}

function compactAuditMetadata(value) {
  if (!value || typeof value !== "object") return null;
  const source = value.metadata && typeof value.metadata === "object" ? value.metadata : value;
  const sanitized = {};
  for (const [key, entry] of Object.entries(source)) {
    if (/roster|response|payload|raw|html|body|lineup/i.test(key)) continue;
    if (entry === null || ["string", "number", "boolean"].includes(typeof entry)) sanitized[key] = typeof entry === "string" ? entry.slice(0, 240) : entry;
    else if (Array.isArray(entry)) sanitized[key] = entry.slice(0, 20).map((item) => typeof item === "string" ? item.slice(0, 120) : item);
  }
  try { return JSON.stringify(sanitized).slice(0, 4000) || null; } catch { return null; }
}

function buildV3RosterAuditSummary(details, jobType) {
  if (jobType !== "roster_fetch") return null;
  const comparison = details?.sourceSnapshotComparison || details?.diagnostics?.sourceSnapshotComparison || null;
  return {
    schemaVersion: 1,
    jobType,
    status: details?.status || null,
    reasonCode: details?.reasonCode || null,
    sourceSnapshotComparison: comparison
      ? {
        status: comparison.status || null,
        mismatch: comparison.mismatch === true,
        remainingMismatch: comparison.remainingMismatch === true,
        stale: comparison.stale === true,
        reasonCode: comparison.reasonCode || null
      }
      : null
  };
}

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
    "internal_game_id",
    ...(auditColumns.has("contest_id") ? ["contest_id"] : []),
    "job_id", "job_type", "scheduled_slot_at", "claim_id",
    "state_before", "state_after", "attempt_count", "failure_code", "failure_message",
    ...(auditColumns.has("data_status") ? ["data_status"] : []), "occurred_at", "source",
    ...(auditColumns.has("severity") ? ["severity"] : []),
    ...(auditColumns.has("category") ? ["category"] : []),
    ...(auditColumns.has("team_id") ? ["team_id"] : []),
    ...(auditColumns.has("revision_id") ? ["revision_id"] : []),
    ...(auditColumns.has("attempt_id") ? ["attempt_id"] : []),
    ...(auditColumns.has("reason_code") ? ["reason_code"] : []),
    ...(auditColumns.has("metadata_json") ? ["metadata_json"] : [])
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
  const auditSummary = buildV3RosterAuditSummary(structuredDetails, auditJobType);
  const classification = classifyV3AuditEvent({ eventType: resolvedEventType, jobType: auditJobType, failureCode, execution });
  const metadataJson = compactAuditMetadata(execution);
  let failureMessage = failureBaseMessage;
  try {
    const summaryMarker = auditSummary ? `[v3_summary=${JSON.stringify(auditSummary)}]` : "";
    const detailsMarker = `[v3_details=${JSON.stringify(structuredDetails)}]`;
    failureMessage = `${failureBaseMessage || ""}${failureBaseMessage ? " " : ""}${summaryMarker}${detailsMarker}`.slice(0, 8000);
  } catch {
    failureMessage = failureBaseMessage;
  }
  const occurred = new Date(occurredAt || job?.completed_at || job?.updated_at || now).toISOString();
  const values = [
    ...(auditColumns.has("event_type") ? [resolvedEventType] : []),
    resolvedInternalGameId,
    ...(auditColumns.has("contest_id") ? [job?.contest_id || execution?.contestId || null] : []),
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
    "cron",
    ...(auditColumns.has("severity") ? [classification.severity] : []),
    ...(auditColumns.has("category") ? [classification.category] : []),
    ...(auditColumns.has("team_id") ? [execution?.teamId || execution?.teamCode || null] : []),
    ...(auditColumns.has("revision_id") ? [execution?.revisionId || execution?.lineupRevisionId || execution?.scoringRevisionId || null] : []),
    ...(auditColumns.has("attempt_id") ? [execution?.attemptId || execution?.scoreAttemptId || null] : []),
    ...(auditColumns.has("reason_code") ? [execution?.reasonCode || execution?.plannerDecision?.reasonCode || failureCode || null] : []),
    ...(auditColumns.has("metadata_json") ? [metadataJson] : [])
  ];
  return { columns, values, eventType: resolvedEventType, structuredDetails, severity: classification.severity, category: classification.category };
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
