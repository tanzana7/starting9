(function attachAsiaAdminActionGuardrails(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.Starting9AsiaAdminActionGuardrails = api;
})(typeof globalThis === "undefined" ? this : globalThis, function createAsiaAdminActionGuardrails() {
  // These checks only prevent avoidable operator mistakes. The Asia Worker
  // remains the security and state-transition boundary for every mutation.
  const pipelineActions = ["score", "rescore", "ranking", "publish"];

  function job(detail, type) {
    return (detail?.formalJobs || []).find((item) => item.job_type === type) || null;
  }

  function currentRevision(detail) {
    const revision = Number(detail?.game?.currentLineupRevision);
    return Number.isInteger(revision) && revision > 0 ? revision : null;
  }

  function currentJob(detail, type) {
    const revision = currentRevision(detail);
    const item = job(detail, type);
    return { item, revision, matches: Boolean(item && revision !== null && Number(item.revision_number) === revision) };
  }

  function eligibleGame(game, summary) {
    if (summary && typeof summary.predictionEligible === "boolean") return summary.predictionEligible;
    if (game && typeof game.predictionEligible === "boolean") return game.predictionEligible;
    return false;
  }

  function disabled(reason) {
    return { enabled: false, reason };
  }

  function actionState(detail, summary, action, now = Date.now()) {
    const game = detail?.game || summary || null;
    if (!game) return disabled("対象試合を読み込んでください。");
    if (!eligibleGame(game, summary)) return disabled("この試合は予想対象外です。");
    if (detail?.competition?.status !== "active") return disabled("大会をactiveにしてから実行できます。");

    const status = String(game.status || "");
    const lineupReady = Boolean(detail?.currentLineup && currentRevision(detail) !== null);
    const scoreJob = currentJob(detail, "score");
    const rankingJob = currentJob(detail, "ranking_rebuild");
    const publishJob = currentJob(detail, "publish");

    if (action === "score") {
      if (["scored", "published"].includes(status)) return disabled("すでに採点済みです。");
      if (status !== "lineup_confirmed" || !lineupReady) return disabled("正式スタメン未登録です。");
      const deadline = new Date(game.predictionDeadlineAt || "");
      if (Number.isNaN(deadline.getTime()) || now < deadline.getTime()) return disabled("予想締切前です。");
      if (!scoreJob.item) return disabled("採点jobが未登録です。");
      if (scoreJob.item.status === "completed" && scoreJob.matches) return disabled("採点済みです。");
      return { enabled: true, reason: "" };
    }

    if (action === "rescore") {
      if (!["scored", "published"].includes(status)) return disabled("採点済みの試合だけ再採点できます。");
      if (!lineupReady) return disabled("現行の正式スタメンがありません。");
      return { enabled: true, reason: "" };
    }

    if (action === "ranking") {
      if (!["scored", "published"].includes(status)) return disabled("採点完了後にランキングを更新できます。");
      if (!scoreJob.matches || scoreJob.item.status !== "completed") return disabled("採点処理が完了していません。");
      if (rankingJob.matches && rankingJob.item.status === "completed" && rankingJob.item.artifact_generation) return disabled("ランキング更新済みです。");
      return { enabled: true, reason: "" };
    }

    if (action === "publish") {
      if (status === "published" && game.publicationStatus === "published") return disabled("公開済みです。");
      if (status !== "scored") return disabled("採点完了後に公開できます。");
      if (!scoreJob.matches || scoreJob.item.status !== "completed") return disabled("採点処理が完了していません。");
      if (!rankingJob.matches || rankingJob.item.status !== "completed" || !rankingJob.item.artifact_generation) return disabled("ランキング更新が完了していません。");
      if (!publishJob.item) return disabled("公開jobが未登録です。");
      return { enabled: true, reason: "" };
    }

    return disabled("この操作は利用できません。");
  }

  function competitionState(competition, action) {
    if (!competition) return disabled("大会情報を読み込んでください。");
    const status = String(competition?.status || "");
    if (action === "activate") {
      if (status === "draft") return { enabled: true, reason: "" };
      if (status === "active") return disabled("大会はすでにactiveです。");
      return disabled("完了した大会は変更できません。");
    }
    if (action === "complete") {
      if (status === "active") return { enabled: true, reason: "" };
      if (status === "draft") return disabled("activeにしてから完了できます。");
      return disabled("大会はすでに完了しています。");
    }
    return disabled("この操作は利用できません。");
  }

  function confirmationText(action, context = {}) {
    const name = String(context.name || context.id || "対象").trim();
    if (action === "activate") return `大会「${name}」をactiveにします。締切前の日本戦で予想受付が開始されます。よろしいですか？`;
    if (action === "complete") return `大会「${name}」を完了します。以後の大会設定変更ができなくなります。よろしいですか？`;
    if (action === "score") return `「${name}」を採点します。予想結果を確定します。よろしいですか？`;
    if (action === "rescore") return `「${name}」を再採点します。正式スタメン修正後の結果でランキング・公開状態が更新されます。よろしいですか？`;
    if (action === "ranking") return `「${name}」のランキングを再集計します。公開前のランキング成果物を更新します。よろしいですか？`;
    if (action === "publish") return `「${name}」の結果とランキングを公開します。よろしいですか？`;
    return `${name}を実行します。よろしいですか？`;
  }

  function errorMessage(error) {
    const messages = {
      PREDICTION_NOT_OPEN: "予想受付が開始されていません。",
      PREDICTION_NOT_ELIGIBLE: "この試合は予想対象外です。",
      LINEUP_REQUIRED: "正式スタメンを先に確定してください。",
      INITIAL_SCORING_NOT_ALLOWED: "初回採点は正式スタメン確定後に実行できます。",
      PREDICTION_OPEN: "予想締切前は採点できません。",
      SCORING_REQUIRED: "採点完了後に実行できます。",
      SCORING_INCOMPLETE: "採点処理が完了していません。",
      RANKING_INCOMPLETE: "ランキング更新が完了していません。",
      COMPETITION_COMPLETED: "完了した大会は変更できません。",
      CSRF_CONTEXT_REQUIRED: "操作元を確認できません。ページを開き直してください。"
    };
    return messages[error?.code] || error?.message || "処理に失敗しました。";
  }

  return Object.freeze({ actionState, competitionState, confirmationText, errorMessage, pipelineActions });
});
