const OPEN_JOB_STATUSES = new Set(["pending", "claimed", "retry_wait"]);
const TERMINAL_WORKFLOW_STATES = new Set(["published", "cancelled", "canceled", "postponed", "no_game", "service_unavailable", "excluded"]);
const REPROCESS_JOB_TYPES = new Set(["score", "scoring", "ranking_rebuild", "publish", "publication"]);

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function jstDate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : "";
}

function statusResult(key, label, reason, stage, details = {}) {
  return { key, label, reason, stage, ...details };
}

function latestRelevantJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => REPROCESS_JOB_TYPES.has(normalized(job?.job_type)));
}

function hasTerminalFailure(job) {
  const status = normalized(job?.status);
  if (status === "failed" || status === "manual_action_required") return true;
  if (status !== "retry_wait") return false;
  const maxAttempts = Number(job?.max_attempts);
  const attempts = Number(job?.attempt_count);
  return Number.isFinite(maxAttempts) && maxAttempts > 0 && Number.isFinite(attempts) && attempts >= maxAttempts;
}

export function deriveAdminV3GameProgressStatus({
  game = {},
  now = new Date(),
  workflowState = "scheduled",
  jobs = [],
  lineup = {},
  scoring = {},
  ranking = {},
  publication = {},
  currentScoringRevisionId = null,
  reflectedScoringRevisionId = null,
  canonicalArtifacts = null
} = {}) {
  const state = normalized(workflowState || game?.state?.state || game?.workflowState || "scheduled");
  const gameStatus = normalized(game?.gameStatus || game?.game_status || "scheduled");
  const date = String(game?.gameDate || game?.game_date || game?.startAt || game?.start_time || "").slice(0, 10);
  const currentDate = jstDate(now);
  const relevantJobs = latestRelevantJobs(jobs);
  const terminalFailure = relevantJobs.find((job) => hasTerminalFailure(job));
  const openJob = relevantJobs.find((job) => OPEN_JOB_STATUSES.has(normalized(job?.status)));
  const canonical = canonicalArtifacts?.available === true ? canonicalArtifacts : null;
  const scoringRevisionId = String(canonical?.scoring?.activeScoringRevisionId || currentScoringRevisionId || scoring?.scoringRevisionId || "").trim();
  const reflectedRevisionId = String(canonical?.ranking?.reflectedRevisionId || reflectedScoringRevisionId || "").trim();
  const hasCurrentRevision = Boolean(scoringRevisionId && scoringRevisionId !== "legacy");
  const revisionMatches = hasCurrentRevision && reflectedRevisionId === scoringRevisionId;
  const lineupRequired = hasCurrentRevision
    || ["lineup_ready", "scored", "ranked", "published", "manual_action_required"].includes(state)
    || relevantJobs.length > 0;
  const canonicalFinalRevisionValid = canonical
    ? canonical.lineup.lineupValid === true
    : lineup?.canonicalFinalRevisionValid === true;
  const canonicalInvalid = lineupRequired && (
    lineup?.canonicalFinalRevisionValid === false
    || lineup?.canonicalValid === false
    || (!canonicalFinalRevisionValid && lineup?.available === false)
    || (!canonicalFinalRevisionValid && lineup?.finalizedValid === false
      && ["lineup_ready", "scored", "ranked", "published", "manual_action_required"].includes(state))
  );
  const rankingReady = canonical
    ? canonical.aggregate.rankingReady === true
    : scoring?.ready === true && ranking?.reflected === true && revisionMatches;
  const publicationReady = canonical
    ? canonical.aggregate.publicationReady === true
    : rankingReady && publication?.published === true;
  const scoringReady = canonical
    ? canonical.aggregate.scoringReady === true
    : scoring?.ready === true;
  const completionReady = canonical
    ? canonical.aggregate.fullyPublished === true
    : hasCurrentRevision && scoring?.ready === true && !canonicalInvalid && publicationReady;
  const publishedState = state === "published" || (canonical
    ? canonical.publication.publicationStatus === "published"
    : publication?.published === true);

  // A completed current artifact is stronger evidence than an old terminal
  // job kept for history.  Correction creates a new revision, so an active
  // correction still fails completionReady and remains reprocessing/actionable.
  if (completionReady) {
    return statusResult("completed", "完了", "現在の採点revisionがランキング反映・公開成果物まで一致しています。", "publish", {
      currentScoringRevisionId: scoringRevisionId,
      reflectedScoringRevisionId: reflectedRevisionId,
      revisionMatches: true,
      readOnly: true
    });
  }
  if (terminalFailure) {
    return statusResult("needs_attention", "要対応", `再処理jobが失敗しています（${terminalFailure.failure_code || terminalFailure.job_type || "原因不明"}）。`, normalized(terminalFailure.job_type) || "score", {
      currentScoringRevisionId: scoringRevisionId || null,
      reflectedScoringRevisionId: reflectedRevisionId || null,
      revisionMatches,
      readOnly: true
    });
  }
  if (canonicalInvalid || canonical?.aggregate?.needsAttention === true) {
    return statusResult("needs_attention", "要対応", "canonical正式スタメンまたは検証済みrevisionを確認できません。", "lineup", {
      currentScoringRevisionId: scoringRevisionId || null,
      reflectedScoringRevisionId: reflectedRevisionId || null,
      revisionMatches,
      readOnly: true
    });
  }
  if (openJob || (hasCurrentRevision && (!scoringReady || !rankingReady || (canonical ? !publicationReady : publication?.published !== true)))) {
    if (!openJob && publishedState) {
      return statusResult("needs_attention", "要対応", "公開済み試合の現在の採点・ランキング・公開成果物が一致していません。", !scoringReady ? "score" : !rankingReady ? "ranking_reflect" : "publish", {
        currentScoringRevisionId: scoringRevisionId || null,
        reflectedScoringRevisionId: reflectedRevisionId || null,
        revisionMatches,
        readOnly: true
      });
    }
    const stage = openJob?.job_type || (!scoringReady ? "score" : !rankingReady ? "ranking_reflect" : "publish");
    const reason = stage === "score"
      ? "現在のスタメンrevisionの採点を処理中です。"
      : stage === "ranking_reflect"
        ? (revisionMatches ? "現在の採点revisionのランキング反映を待っています。" : "旧revisionではなく現在の採点revisionのランキング反映を待っています。")
        : "現在の採点revisionの公開を待っています。";
    return statusResult("reprocessing", "再処理中", reason, stage, {
      currentScoringRevisionId: scoringRevisionId || null,
      reflectedScoringRevisionId: reflectedRevisionId || null,
      revisionMatches,
      readOnly: true
    });
  }
  if (TERMINAL_WORKFLOW_STATES.has(state) || gameStatus === "completed") {
    return statusResult("needs_attention", "要対応", hasCurrentRevision
      ? "完了済みのworkflowですが、現在の採点revisionに対応する反映または公開成果物を確認できません。"
      : "完了済みのworkflowですが、現在の採点revisionを確認できません。", "workflow", {
      currentScoringRevisionId: scoringRevisionId || null,
      reflectedScoringRevisionId: reflectedRevisionId || null,
      revisionMatches,
      readOnly: true
    });
  }
  if (date && currentDate && date > currentDate) {
    return statusResult("scheduled", "予定", "未来試合のため、正式処理前です。", "schedule", {
      currentScoringRevisionId: scoringRevisionId || null,
      reflectedScoringRevisionId: reflectedRevisionId || null,
      revisionMatches,
      readOnly: true
    });
  }
  return statusResult("in_progress", "進行中", "通常のV3処理対象です。", normalized(state) || "workflow", {
    currentScoringRevisionId: scoringRevisionId || null,
    reflectedScoringRevisionId: reflectedRevisionId || null,
    revisionMatches,
    readOnly: date < currentDate || state === "manual_action_required"
  });
}

export const ADMIN_V3_PROGRESS_REPROCESS_JOB_TYPES = Object.freeze([...REPROCESS_JOB_TYPES]);
