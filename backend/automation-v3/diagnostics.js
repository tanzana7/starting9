import { V3_JOB_TYPES } from "./constants.js";

// A missing planner shape must remain visible as a classification issue. It
// must never be presented as a made-up V3 job type.
export const V3_DIAGNOSTIC_UNCLASSIFIED_JOB_TYPE = "legacy_or_unclassified";
const V3_DIAGNOSTIC_JOB_TYPES = new Set([
  ...V3_JOB_TYPES,
  "schedule_sync",
  "expired_scoring_recovery",
  "score_recovery",
  "ranking_recovery",
  "service_unavailable",
  "terminal_recovery",
  "cron_run"
]);

export function normalizeV3DiagnosticJobType(entry, fallbackJobType = null) {
  const candidates = [
    entry?.plan?.jobType,
    entry?.plan?.job_type,
    entry?.job?.job_type,
    entry?.job?.jobType,
    entry?.jobType,
    entry?.job_type,
    entry?.plannerDecision?.jobType,
    entry?.diagnostic?.jobType,
    entry?.diagnosticJobType,
    fallbackJobType
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const knownJobType = candidates.find((candidate) => V3_DIAGNOSTIC_JOB_TYPES.has(candidate));
  return knownJobType
    || V3_DIAGNOSTIC_UNCLASSIFIED_JOB_TYPE;
}

function tagPlannedEntries(planResult, fallbackJobType) {
  return (planResult?.planned || []).map((entry) => ({
    ...entry,
    diagnosticJobType: fallbackJobType
  }));
}

// Pure Cron summary builder used by the Worker and operational diagnostics.
export function buildV3CronSummary({ runId, correlationId, startedAt, completedAt = new Date(), result = {}, scheduleSync = null } = {}) {
  const plannedEntries = [
    ...tagPlannedEntries(result?.probablePlan, "probable_starter_fetch"),
    ...tagPlannedEntries(result?.rosterPlan, "roster_fetch"),
    ...tagPlannedEntries(result?.identityPlan, "npb_identity_resolve"),
    ...tagPlannedEntries(result?.mainPlan, null)
  ];
  const countByJobType = (entries, predicate = () => true) => entries.reduce((counts, entry) => {
    const jobType = normalizeV3DiagnosticJobType(entry);
    if (predicate(entry)) counts[jobType] = (counts[jobType] || 0) + 1;
    return counts;
  }, {});
  const claimEntries = result?.claimReport?.claimed || [];
  return {
    runId,
    correlationId,
    stage: "cron_run",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    status: Number(result?.failed || 0) > 0 ? "completed_with_errors" : "completed",
    counts: {
      games: Number(result?.gameCount || 0),
      planned: plannedEntries.length,
      created: Number(result?.created || 0),
      plannerErrors: Number(result?.failed || 0),
      due: Number(result?.claimReport?.due?.length || 0),
      claimed: claimEntries.filter((entry) => entry?.claimResult === "claimed").length,
      claimConflicts: claimEntries.filter((entry) => entry?.claimResult === "claim_conflict").length,
      processed: Number(result?.processed || 0),
      failed: Number(result?.failed || 0)
    },
    plannedByJobType: countByJobType(plannedEntries),
    createdByJobType: countByJobType(plannedEntries, (entry) => entry?.created === true),
    failedByJobType: countByJobType(plannedEntries, (entry) => Boolean(entry?.error || entry?.reasonCode === "V3_JOB_FAILED")),
    stateReconciliation: result?.stateReconciliation ? {
      recovered: Number(result.stateReconciliation.recovered || 0),
      failed: Number(result.stateReconciliation.failed || 0),
      recoveredByJobType: result.stateReconciliation.recoveredByJobType || {},
      skipped: Array.isArray(result.stateReconciliation.skipped) ? result.stateReconciliation.skipped : []
    } : null,
    scheduleSync: scheduleSync ? {
      status: scheduleSync.status,
      futureGamesBefore: scheduleSync.futureGamesBefore,
      futureGamesAfter: scheduleSync.futureGamesAfter,
      gamesFetched: scheduleSync.gamesFetched,
      gamesInserted: scheduleSync.gamesInserted,
      gamesUpdated: scheduleSync.gamesUpdated,
      errorCode: scheduleSync.errorCode || null
    } : null
  };
}
