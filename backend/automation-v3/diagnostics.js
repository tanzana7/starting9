// Pure Cron summary builder used by the Worker and operational diagnostics.
export function buildV3CronSummary({ runId, correlationId, startedAt, completedAt = new Date(), result = {}, scheduleSync = null } = {}) {
  const plannedEntries = [
    ...(result?.probablePlan?.planned || []),
    ...(result?.rosterPlan?.planned || []),
    ...(result?.identityPlan?.planned || []),
    ...(result?.mainPlan?.planned || [])
  ];
  const countByJobType = (entries, predicate = () => true) => entries.reduce((counts, entry) => {
    const jobType = String(entry?.plan?.jobType || entry?.job?.job_type || "unknown");
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
