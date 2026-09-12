const STAGE_DEFINITIONS = Object.freeze([
  ["schedule", "日程"],
  ["probable_starter", "予告先発"],
  ["prediction_close", "予想締切"],
  ["roster", "ロースター"],
  ["lineup_finalize", "正式スタメン"],
  ["score", "採点"],
  ["ranking", "ランキング"],
  ["publish", "公開"]
]);

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function stageStatus(key, label, reason, details = {}) {
  return { key, label, reason, ...details };
}

function asTime(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function phaseDueAt(phase, schedule = null) {
  return {
    probable_starter: schedule?.probableStarterNextAt,
    prediction_close: schedule?.predictionDeadline,
    score: schedule?.scoringEarliestAt,
    ranking: schedule?.rankingEarliestAt,
    publish: schedule?.publicationAt
  }[phase] || null;
}

function isFutureGame(game, schedule, now) {
  const startAt = asTime(game?.startAt || game?.start_at || schedule?.startAt);
  const current = asTime(now);
  return startAt !== null && current !== null && startAt > current;
}

function isBeforePhaseDue(phase, schedule, now) {
  const dueAt = asTime(phaseDueAt(phase, schedule));
  const current = asTime(now);
  return dueAt !== null && current !== null && dueAt > current;
}

function phaseScheduleDetails(phase, schedule) {
  const scheduledAt = phaseDueAt(phase, schedule);
  return scheduledAt ? { scheduledAt } : {};
}

const PHASE_JOB_TYPES = Object.freeze({
  probable_starter: ["probable_starter_fetch"],
  prediction_close: ["prediction_close"],
  lineup_finalize: ["lineup_finalize"],
  score: ["score", "scoring"],
  ranking: ["ranking_rebuild", "ranking_update"],
  publish: ["publish", "publication"]
});

function latestCompletedJob(jobs, phase) {
  const types = PHASE_JOB_TYPES[phase] || [];
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => types.includes(String(job?.job_type || job?.jobType || ""))
      && normalized(job?.status) === "completed")
    .sort((left, right) => String(right?.completed_at || right?.updated_at || "")
      .localeCompare(String(left?.completed_at || left?.updated_at || "")))[0] || null;
}

function stageCompletedAt(phase, { game = {}, canonical = null, jobs = [] } = {}) {
  if (phase === "schedule") return game?.createdAt || game?.created_at || null;
  if (phase === "lineup_finalize") return canonical?.lineup?.finalizedAt || latestCompletedJob(jobs, phase)?.completed_at || null;
  if (phase === "score") return canonical?.scoring?.completedAt || latestCompletedJob(jobs, phase)?.completed_at || null;
  if (phase === "ranking") return canonical?.ranking?.reflectedAt || latestCompletedJob(jobs, phase)?.completed_at || null;
  // The game list exposes the persisted publication timestamp from the formal
  // artifact tables. Keep this as a read-only fallback for legacy/partial
  // canonical payloads; never synthesize a time from the schedule or state.
  if (phase === "publish") {
    return canonical?.publication?.publishedAt
      || game?.publishedAt
      || game?.published_at
      || latestCompletedJob(jobs, phase)?.completed_at
      || null;
  }
  return latestCompletedJob(jobs, phase)?.completed_at || null;
}

function stageJobScheduledAt(phase, jobs) {
  const types = PHASE_JOB_TYPES[phase] || [];
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => types.includes(String(job?.job_type || job?.jobType || "")))
    .sort((left, right) => String(right?.updated_at || right?.scheduled_at || "")
      .localeCompare(String(left?.updated_at || left?.scheduled_at || "")))[0]?.scheduled_at || null;
}

function formalStageStatus(phase, phaseStatuses = {}, schedule = null) {
  const status = phaseStatuses?.[phase] || {};
  const severity = normalized(status.severity);
  const details = { reasonCode: status.reasonCode || null, ...phaseScheduleDetails(phase, schedule) };
  if (severity === "attention") return stageStatus("attention", "要対応", status.message || status.reasonCode || "正式処理の確認が必要です。", details);
  if (severity === "ok") return stageStatus("complete", "完了", status.message || status.reasonCode || "正式処理が完了しています。", details);
  return stageStatus("wait", "待機", status.message || status.reasonCode || "正式jobの処理を待っています。", details);
}

function waitingStageStatus(phase, phaseStatuses, schedule, reason, reasonCode = null, labelOverride = null) {
  const status = phaseStatuses?.[phase] || {};
  const labels = {
    lineup_finalize: "手動確定待ち",
    score: "正式スタメン確定待ち",
    ranking: "採点完了待ち",
    publish: "ランキング反映待ち"
  };
  return stageStatus("wait", labelOverride || labels[phase] || "待機", reason, {
    reasonCode: reasonCode || status.reasonCode || `${phase.toUpperCase()}_PREREQUISITE_PENDING`,
    ...phaseScheduleDetails(phase, schedule)
  });
}

function canonicalStageStatus(phase, canonicalArtifacts, phaseStatuses, { game = {}, schedule = null, now = new Date(), workflowState = "scheduled" } = {}) {
  const canonical = canonicalArtifacts?.available === true ? canonicalArtifacts : null;
  const phaseStatus = phaseStatuses?.[phase] || {};
  const beforeDue = isBeforePhaseDue(phase, schedule, now);
  const futureGame = isFutureGame(game, schedule, now);
  if (!canonical) {
    if (phase === "lineup_finalize" && (futureGame || beforeDue)) return waitingStageStatus(phase, phaseStatuses, schedule, "手動確定待ち / 試合当日の確認前");
    if (phase === "score" && (futureGame || beforeDue)) return waitingStageStatus(phase, phaseStatuses, schedule, "正式スタメン確定待ち");
    if (phase === "ranking" && futureGame) return waitingStageStatus(phase, phaseStatuses, schedule, "採点完了待ち");
    if (phase === "publish" && (futureGame || beforeDue)) return waitingStageStatus(phase, phaseStatuses, schedule, "ランキング反映待ち");
    return formalStageStatus(phase, phaseStatuses, schedule);
  }

  const aggregate = canonical.aggregate || {};
  const artifact = phase === "lineup_finalize"
    ? canonical.lineup
    : phase === "score"
      ? canonical.scoring
      : phase === "ranking"
        ? canonical.ranking
        : canonical.publication;
  const ready = phase === "lineup_finalize"
    ? aggregate.lineupReady
    : phase === "score"
      ? aggregate.scoringReady
      : phase === "ranking"
        ? aggregate.rankingReady
      : aggregate.publicationReady;
  const normalizedWorkflowState = normalized(workflowState);
  const predictionCloseReady = ["prediction_closed", "lineup_ready", "scored", "ranked", "published"].includes(normalizedWorkflowState)
    || normalized(phaseStatuses?.prediction_close?.severity) === "ok";
  if (ready === true) return stageStatus("complete", "完了", "canonical artifact evaluatorで確認済みです。", {
    reasonCode: artifact?.reason || "ARTIFACT_READY",
    ...phaseScheduleDetails(phase, schedule)
  });
  if (beforeDue || (futureGame && (phase !== "score" || aggregate.lineupReady !== true))) {
    if (phase === "lineup_finalize") return waitingStageStatus(phase, phaseStatuses, schedule, "手動確定待ち / 試合当日の確認前");
    if (phase === "score") return waitingStageStatus(
      phase,
      phaseStatuses,
      schedule,
      aggregate.lineupReady === true ? "採点時刻待ち" : "正式スタメン確定待ち",
      aggregate.lineupReady === true ? "SCORING_NOT_DUE" : null,
      aggregate.lineupReady === true ? "採点時刻待ち" : null
    );
    if (phase === "ranking") return waitingStageStatus(phase, phaseStatuses, schedule, "採点完了待ち");
    if (phase === "publish") return waitingStageStatus(phase, phaseStatuses, schedule, "ランキング反映待ち");
  }
  if (phase === "score" && aggregate.lineupReady === true && !predictionCloseReady) {
    return waitingStageStatus(phase, phaseStatuses, schedule, "予想締切処理待ち", "PREDICTION_CLOSE_PENDING", "採点待ち");
  }
  if (["score", "ranking", "publish"].includes(phase)
    && ["waiting", "pending"].includes(normalized(phaseStatus.severity))
    && artifact?.reason
    && /MISSING|NOT_FOUND|NOT_COMPLETED/.test(String(artifact.reason))) {
    const waitingReason = phase === "score"
      ? aggregate.lineupReady === true ? "採点job待ち" : "正式スタメン確定待ち"
      : phase === "ranking"
        ? "採点完了待ち"
        : "ランキング反映待ち";
    const waitingLabel = phase === "score" && aggregate.lineupReady === true ? "採点待ち" : null;
    return waitingStageStatus(phase, phaseStatuses, schedule, waitingReason, null, waitingLabel);
  }
  if (artifact?.reason && /MISSING|NOT_FOUND|NOT_COMPLETED/.test(String(artifact.reason))) {
    return stageStatus("attention", "要対応", artifact.reason, { reasonCode: artifact.reason, ...phaseScheduleDetails(phase, schedule) });
  }
  return formalStageStatus(phase, phaseStatuses, schedule);
}

export function buildAdminV4Status({
  game = {},
  persistedState = "scheduled",
  phaseStatuses = {},
  canonicalArtifacts = null,
  displayStatus = null,
  automationMode = null,
  schedule = null,
  jobs = [],
  now = new Date()
} = {}) {
  const canonical = canonicalArtifacts?.available === true ? canonicalArtifacts : null;
  const stages = {};
  stages.schedule = game?.gameDate || game?.game_date || schedule?.startAt
    ? stageStatus("complete", "完了", "試合日程が登録されています。", { reasonCode: "SCHEDULE_REGISTERED" })
    : stageStatus("attention", "要対応", "試合日程が未登録です。", { reasonCode: "SCHEDULE_MISSING" });
  stages.probable_starter = formalStageStatus("probable_starter", phaseStatuses, schedule);
  stages.prediction_close = formalStageStatus("prediction_close", phaseStatuses, schedule);
  stages.roster = stageStatus("manual", "手動運用", "V4ではロースターを手動確認します。自動取得jobは使用しません。", { reasonCode: "V4_MANUAL_ROSTER" });
  const v4Schedule = automationMode?.isV4SemiAuto === true || automationMode?.mode === "v4_semi_auto"
    ? {
      ...(schedule || {}),
      scoringEarliestAt: schedule?.predictionDeadline || schedule?.scoringEarliestAt,
      rankingEarliestAt: null,
      publicationAt: null
    }
    : schedule;
  stages.lineup_finalize = canonicalStageStatus("lineup_finalize", canonical, phaseStatuses, { game, schedule: v4Schedule, now, workflowState: persistedState });
  stages.score = canonicalStageStatus("score", canonical, phaseStatuses, { game, schedule: v4Schedule, now, workflowState: persistedState });
  stages.ranking = canonicalStageStatus("ranking", canonical, phaseStatuses, { game, schedule: v4Schedule, now, workflowState: persistedState });
  stages.publish = canonicalStageStatus("publish", canonical, phaseStatuses, { game, schedule: v4Schedule, now, workflowState: persistedState });

  for (const [phase] of STAGE_DEFINITIONS) {
    const completedAt = stageCompletedAt(phase, { game, canonical, jobs });
    const scheduledAt = stageJobScheduledAt(phase, jobs);
    if (completedAt || scheduledAt) {
      stages[phase] = {
        ...stages[phase],
        ...(completedAt ? { completedAt } : {}),
        ...(stages[phase]?.scheduledAt || !scheduledAt ? {} : { scheduledAt })
      };
    }
  }

  const status = displayStatus || stageStatus("wait", "待機", "正式状態を取得できません。", { stage: "workflow" });
  return {
    version: "v4",
    mode: automationMode?.mode || "v4_semi_auto",
    source: {
      currentStatus: "canonical_artifact_evaluator",
      jobs: "formal_job_repository",
      artifacts: "formal_artifact_repository",
      canonicalRevision: canonical?.lineup?.canonicalFinalRevisionId || null
    },
    currentStatus: status,
    persistedState: persistedState || "scheduled",
    stages,
    canonicalArtifacts: canonical,
    schedule: v4Schedule || null
  };
}

export { STAGE_DEFINITIONS };
