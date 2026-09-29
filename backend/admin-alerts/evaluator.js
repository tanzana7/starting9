const ALERT_TYPES = Object.freeze({
  MANUAL_LINEUP_OVERDUE: "manual_lineup_overdue",
  PREDICTION_CLOSE_OVERDUE: "prediction_close_overdue",
  MISSING_DUE_JOB: "missing_due_job",
  SCORE_FAILURE: "score_failure",
  RANKING_FAILURE: "ranking_failure",
  PUBLISH_FAILURE: "publish_failure",
  CANONICAL_LINEUP_INVALID: "canonical_lineup_invalid",
  SCORING_ARTIFACT_INVALID: "scoring_artifact_invalid",
  RANKING_REVISION_MISMATCH: "ranking_revision_mismatch",
  PUBLICATION_INVALID: "publication_invalid",
  GAME_CODE_AMBIGUOUS: "game_code_ambiguous",
  GAME_CODE_TEMPORARY_FAILURE: "game_code_temporary_failure",
  ADDITIONAL_SCHEDULE_REVIEW: "additional_schedule_review"
});

const ALERT_SEVERITIES = Object.freeze({ WARNING: "warning", CRITICAL: "critical" });

function text(value) {
  return String(value || "").trim();
}

function safeGameLabel(game) {
  const date = text(game?.gameDate || game?.game_date).slice(0, 10);
  const away = text(game?.awayTeam || game?.away_team) || "相手チーム";
  const home = text(game?.homeTeam || game?.home_team) || "Fighters";
  return `${date ? `${date} ` : ""}${away} vs ${home}`.slice(0, 100);
}

function actionPathForGame(game) {
  const internalGameId = text(game?.internalGameId || game?.internal_game_id);
  return internalGameId
    ? `/admin-v3.html#game=${encodeURIComponent(internalGameId)}`
    : "/admin-v3.html";
}

function candidate({ alertType, severity, game, title, body }) {
  const gameId = text(game?.internalGameId || game?.internal_game_id);
  if (!gameId || !Object.values(ALERT_TYPES).includes(alertType)) return null;
  const normalizedSeverity = severity === ALERT_SEVERITIES.CRITICAL
    ? ALERT_SEVERITIES.CRITICAL
    : ALERT_SEVERITIES.WARNING;
  return Object.freeze({
    alertType,
    severity: normalizedSeverity,
    gameId,
    title: text(title).slice(0, 120),
    body: text(body).slice(0, 240),
    dedupeKey: `${gameId}:${alertType}`,
    actionPath: actionPathForGame(game),
    createdAt: new Date().toISOString()
  });
}

// This evaluator consumes server-side diagnostics only.  It deliberately
// accepts explicit abnormal signals instead of inferring incidents from every
// pending job; normal waiting, bounded retries, and V4's disabled fetch stages
// must remain silent.
export function evaluateAdminAlertCandidates({ game = {}, signals = {} } = {}) {
  const label = safeGameLabel(game);
  const alerts = [];
  const add = (alertType, severity, title, reason) => {
    const item = candidate({
      alertType,
      severity,
      game,
      title,
      body: `${label} ${reason}`
    });
    if (item) alerts.push(item);
  };

  if (signals.manualLineupOverdue === true) add(
    ALERT_TYPES.MANUAL_LINEUP_OVERDUE,
    ALERT_SEVERITIES.CRITICAL,
    "正式スタメン確認が必要です",
    "正式スタメンが必要時刻を過ぎても確定していません。"
  );
  if (signals.predictionCloseOverdue === true) add(
    ALERT_TYPES.PREDICTION_CLOSE_OVERDUE,
    ALERT_SEVERITIES.CRITICAL,
    "予想締切を確認してください",
    "予想締切処理が猶予時間を超えて未完了です。"
  );
  if (signals.missingDueJob === true) add(
    ALERT_TYPES.MISSING_DUE_JOB,
    ALERT_SEVERITIES.CRITICAL,
    "期限到来jobが見つかりません",
    "期限到来の正式jobが生成されていません。"
  );
  if (signals.scoreFailure === true) add(
    ALERT_TYPES.SCORE_FAILURE,
    ALERT_SEVERITIES.CRITICAL,
    "採点処理を確認してください",
    "採点処理が失敗または再試行上限に達しています。"
  );
  if (signals.rankingFailure === true) add(
    ALERT_TYPES.RANKING_FAILURE,
    ALERT_SEVERITIES.CRITICAL,
    "ランキング反映を確認してください",
    "ランキング反映が失敗または再試行上限に達しています。"
  );
  if (signals.publishFailure === true) add(
    ALERT_TYPES.PUBLISH_FAILURE,
    ALERT_SEVERITIES.CRITICAL,
    "結果公開を確認してください",
    "結果公開が失敗または再試行上限に達しています。"
  );
  if (signals.canonicalLineupInvalid === true) add(
    ALERT_TYPES.CANONICAL_LINEUP_INVALID,
    ALERT_SEVERITIES.CRITICAL,
    "正式スタメン成果物を確認してください",
    "canonical正式スタメンが無効です。"
  );
  if (signals.scoringArtifactInvalid === true) add(
    ALERT_TYPES.SCORING_ARTIFACT_INVALID,
    ALERT_SEVERITIES.CRITICAL,
    "採点成果物を確認してください",
    "現在の採点成果物が有効ではありません。"
  );
  if (signals.rankingRevisionMismatch === true) add(
    ALERT_TYPES.RANKING_REVISION_MISMATCH,
    ALERT_SEVERITIES.CRITICAL,
    "ランキングrevisionを確認してください",
    "ランキングが現在の採点revisionと一致していません。"
  );
  if (signals.publicationInvalid === true) add(
    ALERT_TYPES.PUBLICATION_INVALID,
    ALERT_SEVERITIES.CRITICAL,
    "公開成果物を確認してください",
    "公開成果物が現在の確定状態と一致していません。"
  );
  if (signals.gameCodeAmbiguous === true) add(
    ALERT_TYPES.GAME_CODE_AMBIGUOUS,
    ALERT_SEVERITIES.WARNING,
    "試合コードの確認が必要です",
    "NPB試合コードの候補が一意に確定していません。"
  );
  if (signals.gameCodeTemporaryFailure === true) add(
    ALERT_TYPES.GAME_CODE_TEMPORARY_FAILURE,
    ALERT_SEVERITIES.WARNING,
    "試合コード取得を確認してください",
    "NPB試合コード取得の一時失敗が通常の再試行範囲を超えています。"
  );
  if (signals.additionalScheduleReview === true) add(
    ALERT_TYPES.ADDITIONAL_SCHEDULE_REVIEW,
    ALERT_SEVERITIES.WARNING,
    "追加日程候補を確認してください",
    "追加試合候補が管理者確認待ちです。"
  );

  return alerts;
}

export { ALERT_TYPES, ALERT_SEVERITIES, actionPathForGame, safeGameLabel };
