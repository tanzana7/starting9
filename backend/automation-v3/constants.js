// Immutable V3 contracts: timing, states, job types, and transition metadata.
const INTERNAL_GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// V3 owns its timing contract. Keeping these values here prevents the
// production scheduler from depending on the retired V1/V2 module.
export const V3_TIMING = Object.freeze({
  predictionDeadlineMinutes: 60,
  lineupPollingStartMinutes: 50,
  finalLineupMinutesAfterStart: 2,
  publicationMinutesAfterStart: 10,
  lineupPollingIntervalMinutes: 10,
  rosterPregameMinutes: 120,
  rosterSecondPregameMinutes: 110,
  rosterRegularIntervalMinutes: 24 * 60,
  rosterDailySlotsJst: Object.freeze(["16:02", "16:10"])
});

export const V3_FEATURE_FLAG = "ENABLE_GAME_AUTOMATION_V3";

function readBooleanFlag(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

// Operational mode is resolved from environment flags so V3's automatic
// fetch implementation remains available for a future V5 rollout. V4 only
// changes which stages the formal runner plans and claims.
export function getV3OperationalMode(env = {}) {
  const semiAuto = readBooleanFlag(env.ENABLE_SEMI_AUTO_LINEUP, false);
  const autoProbableStarter = readBooleanFlag(env.ENABLE_AUTO_PROBABLE_STARTER, true);
  const autoRosterFetch = semiAuto
    ? false
    : readBooleanFlag(env.ENABLE_AUTO_ROSTER_FETCH, true);
  const autoLineupFetch = semiAuto
    ? false
    : readBooleanFlag(env.ENABLE_AUTO_LINEUP_FETCH, true);
  const disabledJobTypes = [
    ...(!autoRosterFetch ? [V3_JOB_TYPE.ROSTER_FETCH] : []),
    ...(!autoLineupFetch ? [V3_JOB_TYPE.LINEUP_FETCH] : [])
  ];
  return Object.freeze({
    mode: semiAuto ? "v4_semi_auto" : "v3_auto",
    isV4SemiAuto: semiAuto,
    autoProbableStarter,
    autoRosterFetch,
    autoLineupFetch,
    disabledJobTypes: Object.freeze(disabledJobTypes)
  });
}
export const V3_STATE = Object.freeze({
  SCHEDULED: "scheduled",
  PREDICTION_CLOSED: "prediction_closed",
  LINEUP_READY: "lineup_ready",
  SCORED: "scored",
  RANKED: "ranked",
  PUBLISHED: "published",
  EXCLUDED: "excluded",
  FAILED: "failed",
  MANUAL_ACTION_REQUIRED: "manual_action_required"
});
export const V3_STATES = Object.freeze(Object.values(V3_STATE));
export const V3_JOB_TYPE = Object.freeze({
  NPB_IDENTITY_RESOLVE: "npb_identity_resolve",
  PREDICTION_CLOSE: "prediction_close",
  PROBABLE_STARTER_FETCH: "probable_starter_fetch",
  ROSTER_FETCH: "roster_fetch",
  LINEUP_FETCH: "lineup_fetch",
  LINEUP_FINALIZE: "lineup_finalize",
  SCORE: "score",
  RANKING_REBUILD: "ranking_rebuild",
  PUBLISH: "publish"
});
export const V3_AUXILIARY_JOB_TYPES = Object.freeze([
  V3_JOB_TYPE.PROBABLE_STARTER_FETCH,
  V3_JOB_TYPE.ROSTER_FETCH,
  V3_JOB_TYPE.NPB_IDENTITY_RESOLVE
]);
export const V3_MAIN_JOB_TYPES = Object.freeze([
  V3_JOB_TYPE.PREDICTION_CLOSE,
  V3_JOB_TYPE.LINEUP_FETCH,
  V3_JOB_TYPE.LINEUP_FINALIZE,
  V3_JOB_TYPE.SCORE,
  V3_JOB_TYPE.RANKING_REBUILD,
  V3_JOB_TYPE.PUBLISH
]);
export const V3_JOB_TYPES = Object.freeze([
  V3_JOB_TYPE.NPB_IDENTITY_RESOLVE,
  ...V3_MAIN_JOB_TYPES,
  V3_JOB_TYPE.PROBABLE_STARTER_FETCH,
  V3_JOB_TYPE.ROSTER_FETCH
]);
export const V3_JOB_STATUS = Object.freeze({
  PENDING: "pending",
  CLAIMED: "claimed",
  RETRY_WAIT: "retry_wait",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
});
export const V3_JOB_STATUSES = Object.freeze(Object.values(V3_JOB_STATUS));
export const V3_OPEN_JOB_STATUSES = Object.freeze([
  V3_JOB_STATUS.PENDING,
  V3_JOB_STATUS.CLAIMED,
  V3_JOB_STATUS.RETRY_WAIT
]);
export const V3_TERMINAL_JOB_STATUSES = Object.freeze([
  V3_JOB_STATUS.COMPLETED,
  V3_JOB_STATUS.FAILED,
  V3_JOB_STATUS.CANCELLED
]);
export const V3_OPEN_JOB_STATUS_SQL = V3_OPEN_JOB_STATUSES.map((status) => `'${status}'`).join(", ");
export const V3_POLLING_RESULTS = Object.freeze({
  LINEUP_ANNOUNCED: "LINEUP_ANNOUNCED",
  LINEUP_NOT_ANNOUNCED: "LINEUP_NOT_ANNOUNCED",
  LINEUP_TRANSIENT_ERROR: "LINEUP_TRANSIENT_ERROR",
  LINEUP_INTEGRITY_ERROR: "LINEUP_INTEGRITY_ERROR"
});
export const V3_ERROR_CLASSES = Object.freeze({
  RETRYABLE: "RETRYABLE",
  DATA_INTEGRITY: "DATA_INTEGRITY",
  WORKFLOW: "WORKFLOW",
  SYSTEM: "SYSTEM"
});

const V3_TRANSITION_LIST = Object.freeze([
  { from: V3_STATE.SCHEDULED, to: V3_STATE.PREDICTION_CLOSED, triggeringJob: V3_JOB_TYPE.PREDICTION_CLOSE, prerequisite: "prediction deadline reached" },
  { from: V3_STATE.PREDICTION_CLOSED, to: V3_STATE.LINEUP_READY, triggeringJob: V3_JOB_TYPE.LINEUP_FINALIZE, prerequisite: "canonical finalized lineup" },
  { from: V3_STATE.LINEUP_READY, to: V3_STATE.SCORED, triggeringJob: V3_JOB_TYPE.SCORE, prerequisite: "finalized lineup and predictions" },
  { from: V3_STATE.SCORED, to: V3_STATE.RANKED, triggeringJob: V3_JOB_TYPE.RANKING_REBUILD, prerequisite: "completed scoring revision" },
  // A historic score state can exist without a completed canonical revision.
  // Reopen only that incomplete scoring phase; ranking and publication remain blocked.
  { from: V3_STATE.SCORED, to: V3_STATE.LINEUP_READY, triggeringJob: V3_JOB_TYPE.RANKING_REBUILD, prerequisite: "incomplete scoring recovery" },
  { from: V3_STATE.RANKED, to: V3_STATE.PUBLISHED, triggeringJob: V3_JOB_TYPE.PUBLISH, prerequisite: "reflected ranking and publication time" },
  { from: V3_STATE.SCHEDULED, to: V3_STATE.EXCLUDED, triggeringJob: "admin", prerequisite: "game is excluded" },
  { from: V3_STATE.PREDICTION_CLOSED, to: V3_STATE.EXCLUDED, triggeringJob: "admin", prerequisite: "game is excluded" },
  { from: V3_STATE.LINEUP_READY, to: V3_STATE.EXCLUDED, triggeringJob: "admin", prerequisite: "game is excluded" },
  { from: V3_STATE.SCORED, to: V3_STATE.EXCLUDED, triggeringJob: "admin", prerequisite: "game is excluded" },
  { from: V3_STATE.RANKED, to: V3_STATE.EXCLUDED, triggeringJob: "admin", prerequisite: "game is excluded" },
  { from: V3_STATE.PUBLISHED, to: V3_STATE.MANUAL_ACTION_REQUIRED, triggeringJob: "admin", prerequisite: "manual intervention" },
  { from: V3_STATE.EXCLUDED, to: V3_STATE.RANKED, triggeringJob: V3_JOB_TYPE.RANKING_REBUILD, prerequisite: "eligibility restored" },
  { from: V3_STATE.EXCLUDED, to: V3_STATE.MANUAL_ACTION_REQUIRED, triggeringJob: "admin", prerequisite: "manual intervention" },
  { from: V3_STATE.FAILED, to: V3_STATE.MANUAL_ACTION_REQUIRED, triggeringJob: "admin", prerequisite: "manual intervention" },
  ...[V3_STATE.SCHEDULED, V3_STATE.PREDICTION_CLOSED, V3_STATE.LINEUP_READY, V3_STATE.SCORED, V3_STATE.RANKED]
    .map((from) => ({ from, to: V3_STATE.FAILED, triggeringJob: "system", prerequisite: "non-retryable failure" })),
  ...[V3_STATE.SCHEDULED, V3_STATE.PREDICTION_CLOSED, V3_STATE.LINEUP_READY, V3_STATE.SCORED, V3_STATE.RANKED]
    .map((from) => ({ from, to: V3_STATE.MANUAL_ACTION_REQUIRED, triggeringJob: "admin", prerequisite: "manual intervention" }))
  ,...[V3_STATE.PREDICTION_CLOSED, V3_STATE.LINEUP_READY, V3_STATE.SCORED, V3_STATE.RANKED, V3_STATE.PUBLISHED]
    .map((to) => ({ from: V3_STATE.MANUAL_ACTION_REQUIRED, to, triggeringJob: "admin", prerequisite: "manual intervention resolved" }))
  ,{ from: V3_STATE.MANUAL_ACTION_REQUIRED, to: V3_STATE.EXCLUDED, triggeringJob: "admin", prerequisite: "game is excluded" }
]);
export const V3_TRANSITIONS = Object.freeze(Object.fromEntries(
  V3_TRANSITION_LIST.map((transition) => [`${transition.from}->${transition.to}`, Object.freeze(transition)])
));
export const V3_JOB_REGISTRY = Object.freeze({
  [V3_JOB_TYPE.NPB_IDENTITY_RESOLVE]: Object.freeze({ kind: "auxiliary", label: "NPB識別情報解決", transitionTo: null }),
  [V3_JOB_TYPE.PROBABLE_STARTER_FETCH]: Object.freeze({ kind: "auxiliary", label: "予告先発取得", transitionTo: null }),
  [V3_JOB_TYPE.ROSTER_FETCH]: Object.freeze({ kind: "auxiliary", label: "ロースター取得", transitionTo: null }),
  [V3_JOB_TYPE.PREDICTION_CLOSE]: Object.freeze({ kind: "main", label: "予想締切", transitionTo: V3_STATE.PREDICTION_CLOSED }),
  [V3_JOB_TYPE.LINEUP_FETCH]: Object.freeze({ kind: "main_polling", label: "スタメン取得", transitionTo: null }),
  [V3_JOB_TYPE.LINEUP_FINALIZE]: Object.freeze({ kind: "main", label: "正式スタメン確定", transitionTo: V3_STATE.LINEUP_READY }),
  [V3_JOB_TYPE.SCORE]: Object.freeze({ kind: "main", label: "採点", transitionTo: V3_STATE.SCORED }),
  [V3_JOB_TYPE.RANKING_REBUILD]: Object.freeze({ kind: "main", label: "ランキング反映", transitionTo: V3_STATE.RANKED }),
  [V3_JOB_TYPE.PUBLISH]: Object.freeze({ kind: "main", label: "結果公開", transitionTo: V3_STATE.PUBLISHED })
});

export function getV3JobDefinition(jobType) {
  return V3_JOB_REGISTRY[String(jobType || "")] || null;
}

export function isV3OpenJobStatus(status) {
  return V3_OPEN_JOB_STATUSES.includes(String(status || ""));
}

export function isV3TerminalJobStatus(status) {
  return V3_TERMINAL_JOB_STATUSES.includes(String(status || ""));
}

export function isV3ScoreRecoveryTerminalJob(job) {
  const status = String(job?.status || "");
  if (isV3TerminalJobStatus(status)) return true;
  return status === V3_JOB_STATUS.RETRY_WAIT
    && Number(job?.attempt_count ?? job?.attemptCount ?? 0) >= Number(job?.max_attempts ?? job?.maxAttempts ?? 0);
}

export function isV3RankingRecoveryTerminalJob(job) {
  return isV3ScoreRecoveryTerminalJob(job);
}

export function getV3TransitionDefinition(from, to) {
  return V3_TRANSITIONS[`${String(from || "")}->${String(to || "")}`] || null;
}

export function classifyV3ErrorCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (["MISSING_EXECUTOR", "MISSING_HELPER", "UNEXPECTED_EXCEPTION", "V3_JOB_TYPE_UNSUPPORTED"].includes(normalized)) return V3_ERROR_CLASSES.SYSTEM;
  if (["V3_STATE_TRANSITION_INVALID", "V3_STATE_VERSION_CONFLICT", "PREREQUISITE_NOT_MET", "V3_SCORING_INCOMPLETE", "V3_PUBLICATION_NOT_READY"].includes(normalized)) return V3_ERROR_CLASSES.WORKFLOW;
  if (["LINEUP_INCOMPLETE", "PLAYER_ID_UNRESOLVED", "INTERNAL_GAME_ID_MISMATCH", "DATA_INTEGRITY_ERROR", "NPB_IDENTITY_CONFLICT"].includes(normalized)) return V3_ERROR_CLASSES.DATA_INTEGRITY;
  return V3_ERROR_CLASSES.RETRYABLE;
}

export function isGameAutomationV3Enabled(env = {}) {
  return ["true", "1", "on", "enabled"].includes(String(env?.[V3_FEATURE_FLAG] || "").trim().toLowerCase());
}

export function normalizeV3InternalGameId(value) {
  const internalGameId = String(value || "").trim();
  if (!INTERNAL_GAME_ID_PATTERN.test(internalGameId)) {
    const error = new Error("V3ジョブにはinternal_game_idが必要です。");
    error.code = "V3_INTERNAL_GAME_ID_REQUIRED";
    throw error;
  }
  return internalGameId;
}

export function createV3Error(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.errorClass = details.errorClass || classifyV3ErrorCode(code);
  Object.assign(error, details);
  return error;
}
