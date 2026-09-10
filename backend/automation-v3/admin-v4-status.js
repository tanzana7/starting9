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

function formalStageStatus(phase, phaseStatuses = {}, schedule = null) {
  const status = phaseStatuses?.[phase] || {};
  const severity = normalized(status.severity);
  const details = { reasonCode: status.reasonCode || null, ...phaseScheduleDetails(phase, schedule) };
  if (severity === "attention") return stageStatus("attention", "要対応", status.message || status.reasonCode || "正式処理の確認が必要です。", details);
  if (severity === "ok") return stageStatus("complete", "完了", status.message || status.reasonCode || "正式処理が完了しています。", details);
  return stageStatus("wait", "待機", status.message || status.reasonCode || "正式jobの処理を待っています。", details);
}

function waitingStageStatus(phase, phaseStatuses, schedule, reason) {
  const status = phaseStatuses?.[phase] || {};
  const labels = {
    lineup_finalize: "手動確定待ち",
    score: "正式スタメン確定待ち",
    ranking: "採点完了待ち",
    publish: "ランキング反映待ち"
  };
  return stageStatus("wait", labels[phase] || "待機", reason, {
    reasonCode: status.reasonCode || `${phase.toUpperCase()}_PREREQUISITE_PENDING`,
    ...phaseScheduleDetails(phase, schedule)
  });
}

function canonicalStageStatus(phase, canonicalArtifacts, phaseStatuses, { game = {}, schedule = null, now = new Date() } = {}) {
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
  if (ready === true) return stageStatus("complete", "完了", "canonical artifact evaluatorで確認済みです。", {
    reasonCode: artifact?.reason || "ARTIFACT_READY",
    ...phaseScheduleDetails(phase, schedule)
  });
  if (futureGame || beforeDue) {
    if (phase === "lineup_finalize") return waitingStageStatus(phase, phaseStatuses, schedule, "手動確定待ち / 試合当日の確認前");
    if (phase === "score") return waitingStageStatus(phase, phaseStatuses, schedule, "正式スタメン確定待ち");
    if (phase === "ranking") return waitingStageStatus(phase, phaseStatuses, schedule, "採点完了待ち");
    if (phase === "publish") return waitingStageStatus(phase, phaseStatuses, schedule, "ランキング反映待ち");
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
  stages.lineup_finalize = canonicalStageStatus("lineup_finalize", canonical, phaseStatuses, { game, schedule, now });
  stages.score = canonicalStageStatus("score", canonical, phaseStatuses, { game, schedule, now });
  stages.ranking = canonicalStageStatus("ranking", canonical, phaseStatuses, { game, schedule, now });
  stages.publish = canonicalStageStatus("publish", canonical, phaseStatuses, { game, schedule, now });

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
    schedule: schedule || null
  };
}

export { STAGE_DEFINITIONS };
