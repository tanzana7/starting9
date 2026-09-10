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

function formalStageStatus(phase, phaseStatuses = {}) {
  const status = phaseStatuses?.[phase] || {};
  const severity = normalized(status.severity);
  if (severity === "attention") return stageStatus("attention", "要対応", status.message || status.reasonCode || "正式処理の確認が必要です。", { reasonCode: status.reasonCode || null });
  if (severity === "ok") return stageStatus("complete", "完了", status.message || status.reasonCode || "正式処理が完了しています。", { reasonCode: status.reasonCode || null });
  return stageStatus("wait", "待機", status.message || status.reasonCode || "正式jobの処理を待っています。", { reasonCode: status.reasonCode || null });
}

function canonicalStageStatus(phase, canonicalArtifacts, phaseStatuses) {
  const canonical = canonicalArtifacts?.available === true ? canonicalArtifacts : null;
  const phaseStatus = phaseStatuses?.[phase] || {};
  if (!canonical) return formalStageStatus(phase, phaseStatuses);

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
    reasonCode: artifact?.reason || "ARTIFACT_READY"
  });
  if (artifact?.reason && /MISSING|INVALID|MISMATCH|NOT_FOUND|NOT_COMPLETED/.test(String(artifact.reason))) {
    return stageStatus("attention", "要対応", artifact.reason, { reasonCode: artifact.reason });
  }
  return formalStageStatus(phase, phaseStatuses);
}

export function buildAdminV4Status({
  game = {},
  persistedState = "scheduled",
  phaseStatuses = {},
  canonicalArtifacts = null,
  displayStatus = null,
  automationMode = null,
  schedule = null
} = {}) {
  const canonical = canonicalArtifacts?.available === true ? canonicalArtifacts : null;
  const stages = {};
  stages.schedule = game?.gameDate || game?.game_date || schedule?.startAt
    ? stageStatus("complete", "完了", "試合日程が登録されています。", { reasonCode: "SCHEDULE_REGISTERED" })
    : stageStatus("attention", "要対応", "試合日程が未登録です。", { reasonCode: "SCHEDULE_MISSING" });
  stages.probable_starter = formalStageStatus("probable_starter", phaseStatuses);
  stages.prediction_close = formalStageStatus("prediction_close", phaseStatuses);
  stages.roster = stageStatus("manual", "手動運用", "V4ではroster_fetch自動jobを使用しません。", { reasonCode: "V4_MANUAL_ROSTER" });
  stages.lineup_finalize = canonicalStageStatus("lineup_finalize", canonical, phaseStatuses);
  stages.score = canonicalStageStatus("score", canonical, phaseStatuses);
  stages.ranking = canonicalStageStatus("ranking", canonical, phaseStatuses);
  stages.publish = canonicalStageStatus("publish", canonical, phaseStatuses);

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
