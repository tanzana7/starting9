import { getPredictionDeadlineStatus } from "./prediction-deadline.js";
import { PREDICTION_DEADLINE_MILLISECONDS } from "./prediction-deadline.js";
import {
  getDueFinalLineupAttemptAt,
  getFinalLineupRetryDeadline,
  getDueLineupAttemptAt,
  getJstDateString,
  getNoticePollingPlan,
  buildPregameTimeline,
  getPregameTimeline,
  getPregameTimelines,
  RESULT_RELEASE_MINUTES_AFTER_START,
  getScheduledGame,
  getScheduledGames,
  isFinalLineupRetryExpired,
  isScheduleGameUnavailable,
  parseJstScheduleStart,
  setDetectedScheduleGames
} from "./pregame-automation.js";
import {
  createFightersPlayerId,
  findFightersPlayerByName,
  FIGHTERS_TEAM_CODE,
  FIGHTERS_TEAM_ID
} from "./fighters-player-master.js";
import { normalizeScheduleTeamCode } from "./game-schedule-detection.js";
import {
  createScheduleGameIdentifiers,
  getOrCreateInternalGame,
  registerGameIdentifier,
  resolveInternalGameId,
  updateGameScheduleMetadata
} from "./game-identity-registry.js";
import {
  buildGameIdentityRepairPreview,
  hashGameIdentityRepairPlan,
  REPAIRABLE_TABLES
} from "./game-identity-repair.js";
import {
  RANKING_ELIGIBILITY_STATUS,
  normalizeRankingEligibilityReason,
  normalizeRankingEligibilityStatus,
  isRankingAggregationEligible,
  isScoringComplete
} from "./game-scoring-ranking-v2.js";
import {
  V3_FEATURE_FLAG,
  V3_TIMING,
  V3_JOB_TYPE,
  V3_JOB_TYPES,
  V3_JOB_REGISTRY,
  V3_MAIN_JOB_TYPES,
  createV3Error,
  isGameAutomationV3Enabled,
  normalizeV3InternalGameId,
  transitionV3State,
  listV3Games,
  getV3SchemaState,
  runGameAutomationV3,
  createV3Job,
  deriveV3Schedule,
  deriveV3DisplaySchedule,
  getV3RosterPlanningDiagnostics,
  getV3RosterStatusDecision,
  deriveV3PhaseStatus,
  getV3NextAction,
  getV3ProbableStarterSlots,
  getV3ProbableStarterSourceDate,
  getV3CanonicalRosterSnapshot,
  getV3RosterSnapshotFreshness,
  normalizeProbableStarterDataStatus,
  resolveCanonicalProbableStarterRow,
  shouldStopProbableStarterScheduling
} from "./game-automation-v3.js";

const SESSION_COOKIE_NAME = "s9_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_MAX_ITERATIONS = 100_000;
const PASSWORD_HASH_BITS = 256;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 16;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 72;
// 開発中は1試合につき先着3人。本番候補は30人です。
const PERFECT_ACHIEVERS_DEFAULT_DISPLAY_LIMIT = 3;
const RANKING_DEFAULT_LIMIT = 50;
const RANKING_MAX_LIMIT = 100;
const RANKING_MAX_OFFSET = 1_000_000;
const MONTHLY_RANKING_MIN_YEAR = 2020;
const YEARLY_RANKING_MIN_YEAR = 2020;
const RANKING_ACHIEVEMENT_DISPLAY_LIMIT = 3;
const PREDICTION_SCHEMA_VERSION = 1;
const PREDICTION_MAX_JSON_BYTES = 16 * 1024;
const PREDICTION_POSITIONS = new Set(["捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);
const PREDICTION_TEAM_CODES = new Set(["f", "b", "h", "l", "e", "m", "g", "t", "db", "c", "d", "s"]);
const PREDICTION_TEAM_SLUG_CODES = Object.freeze({
  fighters: "f",
  buffaloes: "b",
  hawks: "h",
  lions: "l",
  eagles: "e",
  marines: "m",
  giants: "g",
  tigers: "t",
  baystars: "db",
  carp: "c",
  dragons: "d",
  swallows: "s"
});
const INTERNAL_GAME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCORING_LINEUP_SIZE = 9;
const SCORING_MAX_SCORE = 100;
const AUTO_SCORING_DEFAULT_DELAY_SECONDS = 300;
const AUTO_SCORING_MAX_DELAY_SECONDS = 24 * 60 * 60;
const AUTO_SCORING_MAX_ATTEMPTS = 3;
const AUTO_SCORING_CRON_BATCH_SIZE = 10;
const AUTO_SCORING_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const MANUAL_RESCORE_RETENTION_DAYS = 7;
const MANUAL_RESCORE_PREVIEW_TTL_MS = 15 * 60 * 1000;
const AUTO_APPROVE_SETTING_KEY = "auto_approve_enabled";
const LEGACY_ADMIN_OPERATION_RETIRED_CODE = "LEGACY_ADMIN_OPERATION_RETIRED";
const LEGACY_ADMIN_OPERATION_RETIRED_MESSAGE = "この操作はGame Automation V3へ移行されました。";
const LEGACY_AUTOMATION_RETIRED_CODE = "LEGACY_AUTOMATION_RETIRED";

// V1/V2 automation and update paths are retired. Production automation uses
// V3 jobs only; old tables, jobs, logs, and audit rows remain historical
// read-only data. New mutations must use internal_game_id through V3 APIs.

function legacyAdminOperationRetiredResponse(cors) {
  return jsonResponse({
    ok: false,
    code: LEGACY_ADMIN_OPERATION_RETIRED_CODE,
    errorCode: LEGACY_ADMIN_OPERATION_RETIRED_CODE,
    error: LEGACY_ADMIN_OPERATION_RETIRED_MESSAGE,
    v3Path: "/admin-v3.html"
  }, 410, cors);
}

async function requireAndRetireLegacyAdminMutation(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  return legacyAdminOperationRetiredResponse(cors);
}
// The pregame runner must register the near-term schedule before it can create
// any downstream rows. Keep a small forward window so games such as the next
// three calendar days are registered before their pregame jobs become due.
// Keep the existing short window for legacy callers. The V3 future-game buffer
// uses its own range so repair and other historical readers keep their contract.
const AUTOMATION_SCHEDULE_LOOKAHEAD_DAYS = 3;
const AUTOMATION_FUTURE_SCHEDULE_LOOKAHEAD_DAYS = 14;
const AUTOMATION_SCHEDULE_MAX_LOOKAHEAD_DAYS = 30;
const AUTOMATION_MIN_FUTURE_GAMES = 3;
const AUTOMATION_SCHEDULE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const V3_CRON_SCHEDULE = "* * * * *";
const V3_CRON_INTERVAL_MINUTES = 1;
const V3_CRON_GRACE_MINUTES = 2;
const V3_CRON_DESCRIPTION = "毎分";
const WORKFLOW_LOG_RETENTION_HOURS = 48;
const WORKFLOW_LOG_DEFAULT_LIMIT = 50;
const WORKFLOW_LOG_MAX_LIMIT = 200;
const WORKFLOW_LOG_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const WORKFLOW_LOG_CLEANUP_KEY = "workflow_logs_48h";
const GAME_IDENTITY_AUDIT_DEFAULT_RANGE_DAYS = 30;
const GAME_IDENTITY_AUDIT_DEFAULT_LIMIT = 50;
const GAME_IDENTITY_AUDIT_MAX_LIMIT = 100;
const GAME_IDENTITY_AUDIT_MAX_SCHEDULE_ROWS = 1_000;
const GAME_IDENTITY_AUDIT_TABLES = Object.freeze([
  "detected_game_schedule",
  "probable_starters",
  "game_day_notice_games",
  "game_roster_snapshots",
  "game_pregame_automation",
  "game_lineups",
  "game_lineup_revisions",
  "predictions",
  "ranking_games",
  "perfect_achievers",
  "game_rescore_jobs",
  "game_workflow_logs",
  "game_workflow_controls"
]);
const NPB_SERVICE_BINDING_INTERNAL_ORIGIN = "https://npb-fetch.internal";
const NPB_FETCH_TIMEOUT_MS = 15_000;
const PROBABLE_STARTER_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const ROSTER_MINIMUM_PLAYER_COUNT = 20;
const ROSTER_AUTO_FETCH_RETRY_INTERVAL_MS = 30 * 60 * 1000;
const ROSTER_AUTO_FETCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TEST_GAME_DEFAULT_OPPONENT_CODE = "e";
const TEST_GAME_DEFAULT_REOPEN_MINUTES = 60;
const GAME_DAY_NOTICE_SOURCE = "https://npb.jp/announcement/roster/";
const GAME_DAY_NOTICE_STATUS = Object.freeze({
  WAITING: "waiting",
  DETECTED: "detected",
  CLOSED: "closed_without_notice",
  ERROR: "error"
});
const GAME_WORKFLOW_STEPS = Object.freeze([
  { id: "notice", offsetMinutes: -120, retryMinutes: 10 },
  { id: "close_predictions", offsetMinutes: -60 },
  { id: "lineup", offsetMinutes: -50, retryMinutes: 10 },
  { id: "final_lineup", offsetMinutes: V3_TIMING.finalLineupMinutesAfterStart, retryMinutes: 10 },
  { id: "score", offsetMinutes: 2 },
  { id: "publish", offsetMinutes: V3_TIMING.publicationMinutesAfterStart }
]);
const PREGAME_TOOL_ACTIONS = Object.freeze({
  "run-notice": { logAction: "notice_fetch", transport: "service-binding", upstreamMode: "notice", fetchCode: "NOTICE_FETCH_FAILED", parseCode: "NOTICE_PARSE_FAILED", failureCode: "NOTICE_FETCH_FAILED", schemaCode: "NOTICE_SCHEMA_NOT_READY" },
  "distribute-notice": { logAction: "notice_distribution", failureCode: "NOTICE_DISTRIBUTION_FAILED", schemaCode: "NOTICE_SCHEMA_NOT_READY" },
  "run-roster": { logAction: "roster_fetch", transport: "service-binding", upstreamMode: "roster", fetchCode: "ROSTER_FETCH_FAILED", parseCode: "ROSTER_PARSE_FAILED", failureCode: "ROSTER_FETCH_FAILED", schemaCode: "ROSTER_SCHEMA_NOT_READY" },
  "fix-roster": { logAction: "roster_fix", failureCode: "ROSTER_FIX_FAILED", schemaCode: "ROSTER_SCHEMA_NOT_READY" },
  "run-lineup": { logAction: "lineup_fetch", transport: "service-binding", upstreamMode: "lineup", fetchCode: "LINEUP_FETCH_FAILED", parseCode: "LINEUP_INVALID", failureCode: "LINEUP_FETCH_FAILED", schemaCode: "LINEUP_SCHEMA_NOT_READY" },
  publish: { logAction: "publish", failureCode: "PUBLISH_FAILED", schemaCode: "PUBLISH_SCHEMA_NOT_READY" },
  "auto-scoring/run-now": { logAction: "scoring", failureCode: "SCORING_FAILED", schemaCode: "SCORING_SCHEMA_NOT_READY" }
});
const PREGAME_TOOL_ERROR_MESSAGES = Object.freeze({
  NOTICE_FETCH_FAILED: "NPB公式の公示取得に失敗しました。",
  NOTICE_PARSE_FAILED: "NPB公式の公示を解析できませんでした。",
  NOTICE_RESPONSE_INVALID: "NPB公式の公示レスポンス形式が不正です。",
  NOTICE_DISTRIBUTION_FAILED: "公示結果の当日試合への配布に失敗しました。",
  NOTICE_NOT_FOUND: "保存済みの公示結果がありません。",
  NOTICE_SCHEMA_NOT_READY: "公示保存用データベースが準備されていません。",
  ROSTER_FETCH_FAILED: "NPB公式のロースター取得に失敗しました。",
  ROSTER_PARSE_FAILED: "NPB公式のロースターを解析できませんでした。",
  ROSTER_SCHEMA_NOT_READY: "ロースター保存用データベースが準備されていません。",
  ROSTER_FIX_FAILED: "ロースターの固定に失敗しました。",
  LINEUP_FETCH_FAILED: "NPB公式の正式スタメン取得に失敗しました。",
  LINEUP_GAME_NOT_FOUND: "対象試合のNPB公式スタメンページが見つかりません。",
  LINEUP_URL_BUILD_FAILED: "対象試合のNPB公式スタメンURLを生成できません。",
  LINEUP_HTTP_ERROR: "NPB公式スタメンページの取得に失敗しました。",
  LINEUP_NOT_ANNOUNCED: "NPB公式でスタメンがまだ発表されていません。",
  LINEUP_PARSE_FAILED: "NPB公式スタメンを解析できませんでした。",
  LINEUP_INVALID_PLAYER_COUNT: "NPB公式スタメンの選手人数が不正です。",
  LINEUP_INVALID_POSITION: "NPB公式スタメンの守備位置が不正です。",
  LINEUP_PLAYER_RESOLUTION_FAILED: "NPB公式スタメンの選手を選手マスタへ照合できません。",
  LINEUP_DUPLICATE_PLAYER: "NPB公式スタメンに同一選手が重複しています。",
  LINEUP_SAVE_FAILED: "正式スタメンの保存に失敗しました。",
  LINEUP_NOT_PUBLISHED: "NPB公式でスタメンがまだ発表されていません。",
  LINEUP_INVALID: "取得した正式スタメンの内容が不正です。",
  LINEUP_SCHEMA_NOT_READY: "正式スタメン保存用データベースが準備されていません。",
  PUBLISH_FAILED: "公開処理に失敗しました。",
  PUBLISH_SCHEMA_NOT_READY: "公開処理用データベースが準備されていません。",
  SCORING_LINEUP_REQUIRED: "正式スタメンが保存されていないため採点できません。",
  SCORING_IN_PROGRESS: "この試合は現在採点処理中です。",
  SCORING_FAILED: "採点に失敗しました。",
  SCORING_SCHEMA_NOT_READY: "採点用データベースが準備されていません。",
  GAME_NOT_FOUND: "対象試合が見つかりません。",
  NPB_SERVICE_BINDING_MISSING: "NPB取得WorkerのService Bindingが設定されていません。",
  NPB_SERVICE_BINDING_INVALID: "NPB取得WorkerのService Bindingが不正です。",
  NPB_WORKER_ROUTE_NOT_FOUND: "NPB取得WorkerのAPIルートが見つかりません。",
  NPB_WORKER_HTTP_ERROR: "NPB取得Workerへの接続に失敗しました。"
});
const SCORING_RULES = Object.freeze({
  player: { perHit: 5, bonus: 5 },
  order: { perHit: 3, bonus: 3 },
  position: { perHit: 2, bonus: 2 }
});
const POSITION_ALIASES = Object.freeze({
  "捕": "捕", C: "捕", "キャッチャー": "捕", "2": "捕",
  "一": "一", "1B": "一", "ファースト": "一", "3": "一",
  "二": "二", "2B": "二", "セカンド": "二", "4": "二",
  "三": "三", "3B": "三", "サード": "三", "5": "三",
  "遊": "遊", SS: "遊", "ショート": "遊", "6": "遊",
  "左": "左", LF: "左", "レフト": "左", "7": "左",
  "中": "中", CF: "中", "センター": "中", "8": "中",
  "右": "右", RF: "右", "ライト": "右", "9": "右",
  "指": "指", DH: "指", D: "指", "指名打者": "指", "0": "指"
});
// 既存の日程用コードとは別に、選手IDだけへ固定の球団IDを割り当てます。
const TEAM_PLAYER_ID_PREFIXES = Object.freeze({
  fighters: "F",
  hawks: "H",
  buffaloes: "Bs",
  marines: "M",
  eagles: "E",
  lions: "L",
  giants: "G",
  tigers: "T",
  baystars: "DB",
  carp: "C",
  dragons: "D",
  swallows: "S"
});
const PREDICTION_TEAM_IDS = new Set(Object.values(TEAM_PLAYER_ID_PREFIXES));

export default {
  async fetch(request, env, ctx) {
    const cors = createCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!env.AUTH_DB) {
      return jsonResponse({ ok: false, error: "認証サービスが現在利用できません。" }, 503, cors);
    }

    const origin = request.headers.get("Origin");
    if (origin && !isAllowedOrigin(origin, env)) {
      return jsonResponse({ ok: false, error: "許可されていないオリジンです。" }, 403, cors);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/api/auth/register" && request.method === "POST") {
        return await handleRegister(request, env, cors);
      }
      if (path === "/api/auth/login" && request.method === "POST") {
        return await handleLogin(request, env, cors);
      }
      if (path === "/api/auth/logout" && request.method === "POST") {
        return await handleLogout(request, env, cors);
      }
      if (path === "/api/auth/me" && request.method === "GET") {
        return await handleMe(request, env, ctx, cors);
      }
      if (path === "/api/me/achievements" && request.method === "GET") {
        return await handleMyAchievements(request, env, cors);
      }
      if (path === "/api/rankings/perfect" && request.method === "GET") {
        return await handleGetPerfectAchieversRanking(request, env, cors);
      }
      if (path === "/api/rankings/yearly" && request.method === "GET") {
        return await handleGetYearlyRanking(request, env, cors);
      }
      if (path === "/api/me/ranking/yearly" && request.method === "GET") {
        return await handleGetMyYearlyRanking(request, env, cors);
      }
      if (path === "/api/rankings/monthly" && request.method === "GET") {
        return await handleGetMonthlyRanking(request, env, cors);
      }
      if (path === "/api/me/ranking/monthly" && request.method === "GET") {
        return await handleGetMyMonthlyRanking(request, env, cors);
      }
      if (path === "/api/game-day-status" && request.method === "GET") {
        return await handleGetGameDayStatus(request, env, cors);
      }
      if (path === "/api/game-day-roster" && request.method === "GET") {
        return await handleGetGameDayRoster(request, env, cors);
      }
      if (path === "/api/prediction-target" && request.method === "GET") {
        return await handleGetPredictionTarget(request, env, cors);
      }
      if (path === "/api/public/games" && request.method === "GET") {
        return await handleGetPublicGames(request, env, cors);
      }
      if (path === "/api/probable-starter" && request.method === "GET") {
        return await handleGetProbableStarter(request, env, cors);
      }
      const resultGameRoute = parseResultGameRoute(path);
      if (resultGameRoute && request.method === "GET") {
        return await handleGetResultGame(request, env, cors, resultGameRoute.gameId);
      }
      if (path === "/api/results/games" && request.method === "GET") {
        return await handleGetResultGames(request, env, cors);
      }
      if (path === "/api/admin/me" && request.method === "GET") {
        return await handleAdminMe(request, env, cors);
      }
      if (path === "/api/admin/v3/overview" && request.method === "GET") {
        return await handleAdminV3Overview(request, env, cors);
      }
      if (path === "/api/admin/v3/automation-logs" && request.method === "GET") {
        return await handleAdminV3AutomationLogs(request, env, cors);
      }
      const adminV3IdentityResolveRoute = parseAdminV3IdentityResolveRoute(path);
      if (adminV3IdentityResolveRoute && request.method === "POST") {
        return await handleAdminV3IdentityResolve(request, env, cors, adminV3IdentityResolveRoute.internalGameId);
      }
      const adminV3NpbGameCodeRoute = parseAdminV3NpbGameCodeRoute(path);
      if (adminV3NpbGameCodeRoute && request.method === "PATCH") {
        return await handleAdminV3NpbGameCodeUpdate(request, env, cors, adminV3NpbGameCodeRoute.internalGameId);
      }
      const adminV3OrientationRoute = parseAdminV3OrientationRoute(path);
      if (adminV3OrientationRoute && request.method === "PATCH") {
        return await handleAdminV3OrientationUpdate(request, env, cors, adminV3OrientationRoute.internalGameId);
      }
      const adminV3Phase1Route = parseAdminV3Phase1Route(path);
      if (adminV3Phase1Route) {
        return await handleAdminV3Phase1Route(request, env, cors, adminV3Phase1Route);
      }
      const adminV3JobRoute = parseAdminV3JobRoute(path);
      if (adminV3JobRoute && request.method === "POST") {
        return await handleAdminV3JobCreate(request, env, cors, adminV3JobRoute.internalGameId);
      }
      if ([
        "/api/admin/mode-capabilities",
        "/api/admin/automation/health",
        "/api/admin/game-progress-status",
        "/api/admin/workflow-logs",
        "/api/admin/audit/game-identities"
      ].includes(path)) {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      const gameIdentityRepairAuditRoute = parseGameIdentityRepairAuditRoute(path);
      if (gameIdentityRepairAuditRoute) {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      if (path === "/api/admin/audit/game-identity-repairs") {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      if (path === "/api/admin/game-identities/repairs") {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      const gameIdentityRepairRollbackRoute = parseGameIdentityRepairRollbackRoute(path);
      if (gameIdentityRepairRollbackRoute) {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      if (path === "/api/admin/audit/game-workflows") {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      const historicalGameWorkflowAuditRoute = parseHistoricalGameWorkflowAuditRoute(path);
      if (historicalGameWorkflowAuditRoute) {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      if (path === "/api/admin/audit/current-game-workflow") {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      if (path === "/api/admin/audit/release-readiness") {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      const probableStarterRefreshRoute = parseProbableStarterRefreshRoute(path);
      if (probableStarterRefreshRoute && request.method === "POST") {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      if (path === "/api/admin/automation/settings") {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      const adminScoringRoute = parseAdminScoringRoute(path);
      if (adminScoringRoute) {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      const autoScoringTestRoute = parseAutoScoringTestRoute(path);
      if (autoScoringTestRoute) {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      const adminTestGameRoute = parseAdminTestGameRoute(path);
      if (adminTestGameRoute) {
        return await requireAndRetireLegacyAdminMutation(request, env, cors);
      }
      if (path === "/api/perfect-achievers" && request.method === "GET") {
        return await handleGetPerfectAchievers(request, env, cors);
      }
      if (path === "/api/perfect-achievers" && request.method === "POST") {
        return await handlePostPerfectAchiever(request, env, cors);
      }
      if (path === "/api/predictions/current" && request.method === "GET") {
        return await handleGetCurrentPrediction(request, env, cors);
      }
      if (path === "/api/predictions/current" && request.method === "PUT") {
        return await handlePutCurrentPrediction(request, env, cors);
      }
      if (path === "/api/predictions/current" && request.method === "DELETE") {
        return await handleDeleteCurrentPrediction(request, env, cors);
      }

      return jsonResponse({ ok: false, error: "認証APIのパスまたはHTTPメソッドが不正です。" }, 404, cors);
    } catch (error) {
      const endpoint = url.pathname;
      const failureCode = String(error?.code || "AUTH_API_INTERNAL_ERROR");
      const failureDetail = String(error?.message || "").replace(/[\r\n]+/g, " ").slice(0, 240);
      const predictionRoute = path === "/api/predictions/current";
      const routeFailureCode = predictionRoute
        ? (request.method === "GET" ? "PREDICTION_READ_FAILED" : request.method === "DELETE" ? "PREDICTION_DELETE_FAILED" : "PREDICTION_SAVE_FAILED")
        : failureCode;
      console.error(`[AUTH_API] endpoint=${endpoint} authenticated=unknown userId= resolvedRole= failureCode=${routeFailureCode} detail=${failureDetail}`);
      return jsonResponse({
        ok: false,
        code: routeFailureCode,
        error: predictionRoute ? "アカウント予想の保存処理に失敗しました。" : "認証処理に失敗しました。"
      }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.AUTH_DB) {
      console.error("auto scoring skipped: AUTH_DB binding is unavailable");
      return;
    }

    const scheduledAt = new Date(Number(event?.scheduledTime) || Date.now());
    if (!isGameAutomationV3Enabled(env)) {
      console.info(`[GAME_AUTOMATION_V3] enabled=false flag=${V3_FEATURE_FLAG} action=skip`);
      return;
    }
    ctx.waitUntil(runScheduledGameAutomationV3(env, scheduledAt));
  }
};

async function runScheduledGameAutomationV3(env, now) {
  const runId = globalThis.crypto?.randomUUID?.() || `v3-run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const correlationId = runId;
  const writeAudit = async ({ eventType = "job", job, internalGameId = null, claimToken = null, stateBefore = null, execution = null, failure = null, occurredAt = now } = {}) => {
    const auditColumns = await getTableColumnSet(env.AUTH_DB, "game_automation_v3_audit");
    const columns = [
      ...(auditColumns.has("event_type") ? ["event_type"] : []),
      "internal_game_id", "job_id", "job_type", "scheduled_slot_at", "claim_id",
      "state_before", "state_after", "attempt_count", "failure_code", "failure_message",
      ...(auditColumns.has("data_status") ? ["data_status"] : []), "occurred_at", "source"
    ];
    const statusAfter = String(job?.status || (failure ? "retry_wait" : "completed"));
    const probableStarter = execution?.probableStarter || null;
    const dataStatus = execution?.dataStatus || probableStarter?.dataStatus || null;
    const noOpReason = execution?.noOpReason || null;
    const failureCode = failure?.code || execution?.failureCode || job?.failure_code || probableStarter?.errorCode || null;
    if (eventType === "job" && noOpReason) eventType = execution?.noOpEventType || "scoring_no_op";
    const noOpMessage = eventType === "ranking_no_op" ? "ランキング対象なし" : "採点対象なし";
    const failureBaseMessage = failure?.message || execution?.failureMessage || job?.failure_message
      || (noOpReason ? `${noOpMessage}: ${noOpReason}` : null);
    const resolvedInternalGameId = job?.internal_game_id || internalGameId || null;
    const structuredDetails = {
      schemaVersion: 1,
      runId,
      correlationId,
      eventType,
      stage: execution?.stage || execution?.executorStage || eventType,
      internalGameId: resolvedInternalGameId,
      jobId: job?.id || null,
      jobType: job?.job_type || "plan",
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
    let failureMessage = failureBaseMessage;
    if (failure?.diagnostics && typeof failure.diagnostics === "object") {
      structuredDetails.diagnostics = failure.diagnostics;
    }
    try {
      failureMessage = `${failureBaseMessage || ""}${failureBaseMessage ? " " : ""}[v3_details=${JSON.stringify(structuredDetails)}]`.slice(0, 8000);
    } catch {
      failureMessage = failureBaseMessage;
    }
    const values = [
      ...(auditColumns.has("event_type") ? [eventType] : []),
      resolvedInternalGameId,
      job?.id || null,
      job?.job_type || "plan",
      job?.scheduled_slot_at || null,
      job?.claim_token || claimToken || null,
      execution?.stateBefore || stateBefore || null,
      execution?.stateAfter || null,
      Number(job?.attempt_count || 0),
      failureCode,
      failureMessage ? String(failureMessage).slice(0, 8000) : null,
      ...(auditColumns.has("data_status") ? [dataStatus] : []),
      new Date(occurredAt || job?.completed_at || job?.updated_at || now).toISOString(),
      "cron"
    ];
    await env.AUTH_DB.prepare(
      `INSERT INTO game_automation_v3_audit (${columns.join(", ")})
       VALUES (${columns.map((_, index) => `?${index + 1}`).join(", ")})`
    ).bind(...values).run();
  };

  const writeScheduleSyncAudit = async (diagnostics) => {
    const anchor = await env.AUTH_DB.prepare(
      `SELECT internal_game_id
         FROM games
        WHERE internal_game_id IS NOT NULL AND internal_game_id <> ''
        ORDER BY game_date, start_time, internal_game_id
        LIMIT 1`
    ).first();
    if (!anchor?.internal_game_id) return;
    const auditColumns = await getTableColumnSet(env.AUTH_DB, "game_automation_v3_audit");
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
      anchor.internal_game_id,
      "schedule_sync",
      "scheduled",
      diagnostics?.status || "unknown",
      errorCode,
      message,
      diagnostics?.lastScheduleSyncAt || now.toISOString(),
      "cron"
    ];
    await env.AUTH_DB.prepare(
      `INSERT INTO game_automation_v3_audit (${columns.join(", ")})
       VALUES (${columns.map((_, index) => `?${index + 1}`).join(", ")})`
    ).bind(...values).run();
  };

  let scheduleSync = null;
  try {
    scheduleSync = await ensureFutureFightersSchedule(env, now);
    console.log(`[GAME_SCHEDULE_BUFFER] before=${scheduleSync.futureGamesBefore} after=${scheduleSync.futureGamesAfter} fetched=${scheduleSync.gamesFetched} inserted=${scheduleSync.gamesInserted} updated=${scheduleSync.gamesUpdated} range=${scheduleSync.fetchRangeStart || ""}..${scheduleSync.fetchRangeEnd || ""} skip=${scheduleSync.skipReason || ""}`);
  } catch (error) {
    scheduleSync = {
      status: "failed",
      syncNeeded: true,
      futureGamesBefore: null,
      futureGamesAfter: null,
      futureGamesTarget: AUTOMATION_MIN_FUTURE_GAMES,
      gamesFetched: 0,
      gamesInserted: 0,
      gamesUpdated: 0,
      fetchRangeStart: "",
      fetchRangeEnd: "",
      expandedTo30Days: false,
      skipReason: error?.code || "SCHEDULE_SYNC_FAILED",
      errorCode: error?.code || "SCHEDULE_FETCH_FAILED",
      lastScheduleSyncAt: now.toISOString()
    };
    console.warn(`[GAME_SCHEDULE_BUFFER] status=failed code=${scheduleSync.skipReason}`);
  }
  try {
    await writeScheduleSyncAudit(scheduleSync);
  } catch (error) {
    console.error(`[GAME_SCHEDULE_BUFFER] audit_write_failed code=${error?.code || "SCHEDULE_SYNC_AUDIT_WRITE_FAILED"}`);
  }

  const result = await runGameAutomationV3(env, now, {
    executeJob: (context) => executeGameAutomationV3Job(context),
    onPlan: async ({ game, plan, job, created, reasonCode, insertedRowCount, existingJobId, existingScheduledSlotAt, existingStatus, diagnostic, plannerDecision = null, stage = "v3_plan", claimResult = null }) => {
      const jobType = String(plan?.jobType || job?.job_type || "");
      const phaseByJobType = {
        probable_starter_fetch: "probable_starter",
        roster_fetch: "roster",
        prediction_close: "prediction_close",
        lineup_fetch: "lineup_fetch",
        lineup_finalize: "lineup_finalize",
        score: "score",
        ranking_rebuild: "ranking",
        publish: "publish"
      };
      const phase = phaseByJobType[jobType] || "";
      const normalizedStatus = phase ? deriveV3PhaseStatus({
        phase,
        game,
        now,
        workflowState: "scheduled",
        jobs: job ? [job] : [],
        snapshot: phase === "roster" ? {
          exists: diagnostic?.freshSnapshotExists,
          isFresh: diagnostic?.freshSnapshotExists,
          isStale: diagnostic?.staleSnapshotExists,
          staleReason: diagnostic?.staleReason
        } : null,
        noticeState: diagnostic?.noticeState || null
      }) : null;
      const isClaimAudit = stage.endsWith("_claim");
      const isRoster = jobType === "roster_fetch";
      const isProbable = jobType === "probable_starter_fetch";
      const eventType = isClaimAudit
        ? (isRoster ? "roster_job_claimed" : isProbable ? "probable_starter_job_claimed" : "v3_job_claimed")
        : created
          ? (isRoster ? "roster_job_created" : isProbable ? "workflow_job_created" : "v3_job_created")
          : (isRoster ? "roster_job_plan_observed" : isProbable ? "probable_starter_job_plan_observed" : "v3_job_plan_observed");
      await writeAudit({
        eventType,
        job: {
          ...(job || {}),
          internal_game_id: job?.internal_game_id || game?.internalGameId || null,
          job_type: jobType,
          scheduled_slot_at: plan?.scheduledSlotAt?.toISOString?.() || job?.scheduled_slot_at || null,
          status: claimResult === "claimed" ? "claimed" : (created ? "pending" : existingStatus || job?.status || "observed")
        },
        execution: {
          status: isClaimAudit ? "claimed" : (created ? "created" : "observed"),
          reasonCode: created ? null : reasonCode,
          planningDiagnostics: diagnostic || null,
          insertedRowCount: Number(insertedRowCount || 0),
          actualJobExists: Boolean(job?.id),
          existingJobId: existingJobId || null,
          existingScheduledSlotAt: existingScheduledSlotAt || null,
          existingStatus: existingStatus || null,
          claimResult: claimResult || diagnostic?.claimResult || "not_attempted",
          uniqueKey: "internal_game_id|job_type|scheduled_slot_at",
          runId,
          correlationId,
          stage,
          plannerDecision,
          normalizedStatus: normalizedStatus?.structuredLogFacts || null
        },
        occurredAt: now
      });
    },
    onSuccess: async ({ job, claimToken, result: execution, now: completedAt }) => {
      try {
        await writeAudit({ job, claimToken, execution: { ...(execution || {}), runId, correlationId, stage: "executor_completed" }, occurredAt: job?.completed_at || job?.updated_at || completedAt });
      } catch (error) {
        console.error(`[GAME_AUTOMATION_V3] audit_write_failed code=${error?.code || "V3_AUDIT_WRITE_FAILED"}`);
      }
    },
    onError: async (error, context) => {
      const id = String(context?.job?.internal_game_id || context?.game?.internalGameId || "");
      console.error(`[GAME_AUTOMATION_V3] internalGameId=${id} stage=${context?.stage || "unknown"} code=${error?.code || "V3_JOB_FAILED"}`);
      if (env.AUTH_DB && id) {
        try {
          let execution = null;
          if (String(context?.job?.job_type || "") === "probable_starter_fetch") {
            const row = await readProbableStarterRow(env.AUTH_DB, { internalGameId: id }).catch(() => null);
            execution = { probableStarter: serializeProbableStarterRow(row) };
          }
          await writeAudit({
            job: context?.job || (id ? { internal_game_id: id, job_type: context?.plan?.jobType || "planner", status: "failed" } : null),
            internalGameId: id,
            claimToken: context?.claimToken,
            stateBefore: context?.stateBefore || "claimed",
            execution: { ...(execution || {}), runId, correlationId, stage: context?.stage || "execute", executorStage: context?.stage || "execute" },
            failure: error,
            occurredAt: context?.job?.updated_at || now
          });
        } catch (auditError) {
          console.error(`[GAME_AUTOMATION_V3] audit_write_failed code=${auditError?.code || "V3_AUDIT_WRITE_FAILED"}`);
        }
      }
    }
    }).catch(async (error) => {
    const anchor = await env.AUTH_DB.prepare(
      `SELECT internal_game_id FROM games WHERE internal_game_id IS NOT NULL AND internal_game_id <> '' ORDER BY game_date, start_time, internal_game_id LIMIT 1`
    ).first().catch(() => null);
    if (anchor?.internal_game_id) {
      await writeAudit({
        eventType: "cron_run_failed",
        internalGameId: anchor.internal_game_id,
        job: { internal_game_id: anchor.internal_game_id, job_type: "cron_run", status: "failed" },
        execution: { runId, correlationId, stage: "cron_run", errorCode: error?.code || "V3_CRON_RUN_FAILED", errorMessage: error?.message || "V3 Cron failed" },
        failure: error,
        occurredAt: now
      }).catch((auditError) => console.error(`[GAME_AUTOMATION_V3] stage=cron_run_failed_audit code=${auditError?.code || "V3_AUDIT_WRITE_FAILED"}`));
    }
    throw error;
  });
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
  const summary = {
    runId,
    correlationId,
    stage: "cron_run",
    startedAt: now.toISOString(),
    completedAt: new Date().toISOString(),
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
  const anchor = await env.AUTH_DB.prepare(
    `SELECT internal_game_id FROM games WHERE internal_game_id IS NOT NULL AND internal_game_id <> '' ORDER BY game_date, start_time, internal_game_id LIMIT 1`
  ).first().catch(() => null);
  if (anchor?.internal_game_id) {
    await writeAudit({
      eventType: "cron_run_summary",
      internalGameId: anchor.internal_game_id,
      job: { internal_game_id: anchor.internal_game_id, job_type: "cron_run", status: summary.status },
      execution: summary,
      occurredAt: new Date(summary.completedAt)
    }).catch((error) => console.error(`[GAME_AUTOMATION_V3] stage=cron_run_summary_audit code=${error?.code || "V3_AUDIT_WRITE_FAILED"}`));
  }
  if (result?.schemaReady === false) {
    console.error(`[GAME_AUTOMATION_V3] enabled=true code=${result.errorCode}`);
  }
  return { ...result, scheduleSync, runId, correlationId, summary };
}

async function loadV3GameTarget(db, internalGameId) {
  const id = normalizeV3InternalGameId(internalGameId);
  let gameColumns = new Set();
  try {
    gameColumns = await getTableColumnSet(db, "games");
  } catch {
    gameColumns = new Set();
  }
  const optionalGameColumns = ["stadium", "npb_game_url", "source_schedule_key", "npb_identity_status", "npb_identity_resolved_at", "npb_identity_source"]
    .filter((column) => gameColumns.has(column));
  const identityColumns = optionalGameColumns;
  const row = await db.prepare(
    `SELECT internal_game_id, game_date, start_time, home_team, away_team,
            npb_game_code${identityColumns.length ? `, ${identityColumns.join(", ")}` : ""},
            game_status, is_active, deleted_at
       FROM games WHERE internal_game_id = ?1 LIMIT 1`
  ).bind(id).first();
  if (!row) throw createV3Error("V3_GAME_NOT_REGISTERED", "V3対象試合が日程DBに登録されていません。");
  return {
    ...row,
    internalGameId: row.internal_game_id,
    startAt: row.start_time,
    gameStatus: row.game_status,
    isActive: row.is_active,
    deletedAt: row.deleted_at,
    // V3 operations use the canonical UUID as their only game reference.
    // Historical identifiers remain readable through the retired readers.
    gameId: id,
    legacyGameId: "",
    gameCode: row.npb_game_code || "",
    npbGameUrl: row.npb_game_url || "",
    sourceScheduleKey: row.source_schedule_key || "",
    npbIdentityStatus: row.npb_identity_status || (row.npb_game_code ? "resolved" : "unresolved"),
    npbIdentityResolvedAt: row.npb_identity_resolved_at || null,
    npbIdentitySource: row.npb_identity_source || "",
    targetResolution: "v3_games_internal_game_id"
  };
}

function createV3LineupIdentity(target) {
  const startAt = new Date(target?.startAt || target?.start_time || "");
  const gameCode = normalizeNpbGameCode(target?.gameCode || target?.npb_game_code);
  const sourceUrl = String(target?.npbGameUrl || "").trim() || buildNpbGameUrl(target?.game_date, gameCode);
  if (!INTERNAL_GAME_ID_PATTERN.test(String(target?.internalGameId || "")) || Number.isNaN(startAt.getTime()) || !gameCode || !sourceUrl) return null;
  return {
    internalGameId: target.internalGameId,
    gameId: target.internalGameId,
    gameCode,
    sourceUrl,
    startAt,
    finalLineupFetchAt: new Date(startAt.getTime() + 2 * 60 * 1000),
    game: {
      gameId: target.internalGameId,
      internalGameId: target.internalGameId,
      gameCode,
      npbScoreUrl: sourceUrl,
      date: target.game_date,
      startAt,
      homeTeam: target.home_team,
      awayTeam: target.away_team,
      status: target.game_status
    },
    resolvedBy: "v3_games_npb_identity"
  };
}

function getNextV3IdentityRetryAt(now) {
  const timestamp = new Date(now).getTime();
  if (Number.isNaN(timestamp)) return new Date(Date.now() + 10 * 60 * 1000);
  return new Date(Math.floor(timestamp / (10 * 60 * 1000)) * (10 * 60 * 1000) + 10 * 60 * 1000);
}

async function executeV3IdentityResolutionJob(env, internalGameId, now) {
  const response = await handleAdminV3IdentityResolve(null, env, {}, internalGameId, { skipAuth: true, source: "cron" });
  const payload = await response.json().catch(() => ({}));
  if (payload?.ok) {
    return {
      status: payload.noOp ? "already_resolved" : "resolved",
      identityResolved: true,
      failureCode: null,
      failureMessage: null
    };
  }
  const identityState = String(payload?.identityState || "");
  if (identityState === "pending" || identityState === "manual_action_required") {
    const requiresManualAction = identityState === "manual_action_required";
    return {
      status: identityState,
      identityResolved: false,
      failureCode: requiresManualAction ? payload?.code || null : null,
      failureMessage: requiresManualAction ? payload?.error || null : null
    };
  }
  if (identityState === "retry_wait") {
    const error = createV3Error(payload?.code || "NPB_IDENTITY_RETRY_WAIT", payload?.error || "NPB識別情報の掲載を待っています。", {
      retryAt: getNextV3IdentityRetryAt(now)
    });
    throw error;
  }
  throw createV3Error(payload?.code || "NPB_IDENTITY_RESOLUTION_FAILED", payload?.error || "NPB試合識別情報を解決できませんでした。");
}

async function executeV3IdentityExecutor({ env, internalGameId, now, stateBefore }) {
  const result = await executeV3IdentityResolutionJob(env, internalGameId, now);
  return { ...result, stateBefore, stateAfter: stateBefore };
}

async function executeV3ProbableStarterExecutor({ env, internalGameId, now, target, stateBefore }) {
  const result = await runProbableStarterFetch(env, {
    gameId: internalGameId,
    internalGameId,
    startAt: new Date(target.startAt),
    date: target.game_date,
    homeTeam: target.home_team,
    awayTeam: target.away_team,
    nextGameDate: target.game_date
  }, now, { source: "v3" });
  return {
    status: result.status,
    stateBefore,
    stateAfter: stateBefore,
    dataStatus: result.probableStarter?.dataStatus || null,
    probableStarter: result.probableStarter || null,
    failureCode: result.probableStarter?.errorCode || null,
    nextCheckAt: result.probableStarter?.nextCheckAt || null
  };
}

async function executeV3RosterExecutor({ env, internalGameId, now, target, stateBefore, job }) {
  const result = await captureGameRosterSnapshot(env, internalGameId, now, {
    source: "v3",
    target: {
      gameId: internalGameId,
      internalGameId,
      startAt: target.startAt,
      date: target.game_date,
      homeTeam: target.home_team,
      awayTeam: target.away_team
    }
  });
  return {
    ...result,
    status: result?.status || "captured",
    stateBefore,
    stateAfter: stateBefore,
    executorStage: "capture_roster_snapshot",
    plannerDecision: getV3RosterPlanningDiagnostics({
      gameDate: target.game_date,
      startAt: target.startAt,
      homeTeam: target.home_team,
      awayTeam: target.away_team
    }, now, job?.scheduled_slot_at || "")
  };
}

async function executeV3PredictionCloseExecutor({ env, internalGameId, stateBefore }) {
  await env.AUTH_DB.prepare(
    `UPDATE predictions SET status = CASE WHEN status = 'pending' THEN 'locked' ELSE status END
      WHERE internal_game_id = ?1 AND is_test_prediction = 0`
  ).bind(internalGameId).run();
  return { status: "prediction_closed", stateBefore, stateAfter: "prediction_closed" };
}

function enrichV3LineupExecutorError(error, { internalGameId, now, target, job, lineupIdentity, stage = "capture_official_lineup" } = {}) {
  const diagnostics = {
    ...(error?.diagnostics && typeof error.diagnostics === "object" ? error.diagnostics : {}),
    executorStage: stage,
    sourceUrl: lineupIdentity?.sourceUrl || target?.npbGameUrl || null,
    httpStatus: Number(error?.httpStatus || error?.upstreamStatus || 0) || null,
    selectedSlot: job?.scheduled_slot_at || null,
    internalGameId,
    npbGameCode: lineupIdentity?.gameCode || target?.gameCode || target?.npb_game_code || null,
    homeTeam: target?.home_team || target?.homeTeam || null,
    awayTeam: target?.away_team || target?.awayTeam || null
  };
  const code = String(error?.code || "").trim().toUpperCase();
  if (code && code !== "V3_JOB_FAILED") {
    error.diagnostics = diagnostics;
    return error;
  }
  return createV3Error("UNEXPECTED_EXCEPTION", String(error?.message || "V3スタメン取得で予期しない例外が発生しました。"), {
    errorClass: "SYSTEM",
    exceptionName: String(error?.name || "Error"),
    exceptionMessage: String(error?.message || ""),
    diagnostics: {
      ...diagnostics,
      exceptionName: String(error?.name || "Error"),
      exceptionMessage: String(error?.message || "")
    }
  });
}

async function executeV3LineupExecutor({ env, internalGameId, now, target, stateBefore, jobType, job }) {
  const lineupIdentity = createV3LineupIdentity(target);
  if (!lineupIdentity) {
    const startAt = new Date(target?.startAt || target?.start_time || "");
    const hasCanonicalSchedule = INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || ""))
      && !Number.isNaN(startAt.getTime());
    const missingCode = !normalizeNpbGameCode(target?.gameCode || target?.npb_game_code);
    throw createV3Error(
      hasCanonicalSchedule && missingCode ? "NPB_GAME_CODE_NOT_AVAILABLE" : "NPB_IDENTITY_UNRESOLVED",
      hasCanonicalSchedule && missingCode ? "NPB試合コードが未掲載のため、次回slotで再確認します。" : "NPB試合識別情報が日程DBにありません。",
      {
        retryable: true,
        retryAt: new Date(new Date(now).getTime() + 10 * 60 * 1000),
        diagnostics: {
          executorStage: "resolve_lineup_identity",
          selectedSlot: job?.scheduled_slot_at || null,
          internalGameId,
          npbGameCode: target?.gameCode || target?.npb_game_code || null,
          homeTeam: target?.home_team || null,
          awayTeam: target?.away_team || null,
          reasonCode: hasCanonicalSchedule && missingCode ? "NPB_GAME_CODE_NOT_AVAILABLE" : "NPB_IDENTITY_UNRESOLVED"
        }
      }
    );
  }
  let result;
  try {
    result = await captureOfficialLineup(env, internalGameId, now, {
      phase: jobType === V3_JOB_TYPE.LINEUP_FINALIZE ? "final" : "provisional",
      internalGameId,
      source: "v3",
      target: {
        ...target,
        game: {
          gameId: internalGameId,
          internalGameId,
          gameCode: target.gameCode,
          date: target.game_date,
          homeTeam: target.home_team,
          awayTeam: target.away_team,
          status: target.game_status
        }
      },
      identityOverride: lineupIdentity
    });
  } catch (error) {
    if (jobType === V3_JOB_TYPE.LINEUP_FETCH) {
      throw enrichV3LineupExecutorError(normalizeV3LineupFetchError(error, now), {
        internalGameId, now, target, job, lineupIdentity
      });
    }
    throw enrichV3LineupExecutorError(normalizeV3LineupFinalizeError(error, {
      internalGameId,
      jobType,
      executorReached: true,
      stateBefore,
      provisionalLookup: "game_lineup_revisions.internal_game_id"
    }), { internalGameId, now, target, job, lineupIdentity, stage: "finalize_official_lineup" });
  }
  if (jobType === V3_JOB_TYPE.LINEUP_FETCH) return { status: result.status, stateBefore, stateAfter: stateBefore };
  return { status: result.status, stateBefore, stateAfter: "lineup_ready" };
}

async function executeV3ScoreExecutor({ env, internalGameId, now, stateBefore }) {
  const revisions = await getV3LineupRevisionRows(env.AUTH_DB, internalGameId, internalGameId);
  if (!revisions.some((row) => Number(row.is_final) === 1)) {
    throw createV3Error("V3_FINAL_LINEUP_REQUIRED", "正式スタメン確定済みの採点対象がありません。", { retryable: false });
  }
  // A terminal score job can leave the canonical lineup in processing. The
  // recovery job owns the next attempt, so release that stale marker before
  // claiming the lineup again; no prediction or revision history is changed.
  try {
    const columns = await getTableColumnSet(env.AUTH_DB, "game_lineups");
    const scopeColumn = columns.has("internal_game_id") ? "internal_game_id" : "game_id";
    await env.AUTH_DB.prepare(
      `UPDATE game_lineups
          SET scoring_status = 'pending', scoring_started_at = NULL,
              last_error = NULL, updated_at = ?1
        WHERE ${scopeColumn} = ?2 AND scoring_status = 'processing'`
    ).bind(now.toISOString(), internalGameId).run();
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  const claimed = await claimGameLineupForScoring(env.AUTH_DB, internalGameId, now);
  const result = claimed ? await scoreClaimedGameLineup(env.AUTH_DB, claimed, now) : null;
  const lineup = await getGameLineup(env.AUTH_DB, { gameId: internalGameId, internalGameId });
  if (!lineup || lineup.scoring_status !== "scored") throw createV3Error("V3_SCORING_NOT_COMPLETE", "V3採点が完了していません。");
  if (result?.scoringRevisionId) {
    try {
      await env.AUTH_DB.prepare(
        "UPDATE game_automation_v3_state SET scoring_revision_id = ?1, updated_at = ?2 WHERE internal_game_id = ?3"
      ).bind(result.scoringRevisionId, now.toISOString(), internalGameId).run();
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
    }
  }
  return {
    status: result?.status || "scored",
    stateBefore,
    stateAfter: "scored",
    noOpReason: result?.noOpReason || null,
    scoringRevisionId: result?.scoringRevisionId || null,
    scoring: result ? {
      processed: Number(result.processed || 0),
      scored: Number(result.scored || 0),
      excluded: Number(result.excluded || 0)
    } : null
  };
}

async function executeV3RankingExecutor({ env, internalGameId, now, stateBefore }) {
  const eligibility = await getRankingEligibilityState(env.AUTH_DB, internalGameId);
  if (eligibility && eligibility.rankingEligibilityStatus !== RANKING_ELIGIBILITY_STATUS.ELIGIBLE) {
    await recordRankingReflectionRevision(env.AUTH_DB, {
      internalGameId,
      scoringRevisionId: "excluded",
      eligibilityVersion: eligibility.rankingEligibilityVersion || 1,
      status: "excluded",
      now
    });
    return { status: "excluded", stateBefore, stateAfter: stateBefore };
  }
  const completion = await getScoringCompletionState(env.AUTH_DB, { gameId: internalGameId, internalGameId });
  if (!completion.complete) throw createV3Error("V3_SCORING_INCOMPLETE", "全予想の採点が完了していません。");
  let activeRevision = await getActiveScoringRevision(env.AUTH_DB, internalGameId);
  const isNoOpScoring = completion.eligiblePredictionCount === 0 && completion.failedPredictionCount === 0;
  let noOpReason = isNoOpScoring ? "V3_RANKING_NO_ENTRIES" : null;
  if (!activeRevision?.id && isNoOpScoring) {
    const lineup = await getGameLineup(env.AUTH_DB, { gameId: internalGameId, internalGameId });
    if (lineup?.scoring_status === "scored") {
      const scoringNoOpReason = completion.excludedPredictionCount > 0
        ? "V3_SCORING_NO_ELIGIBLE_PREDICTIONS"
        : "V3_SCORING_NO_PREDICTIONS";
      noOpReason = "V3_RANKING_NO_ENTRIES";
      activeRevision = await ensurePersistedScoringRevision(env.AUTH_DB, {
        gameId: internalGameId,
        internalGameId,
        lineupRevisionId: lineup.scoring_lineup_revision_id || "",
        reason: scoringNoOpReason,
        now
      });
      try {
        await env.AUTH_DB.prepare(
          "UPDATE game_automation_v3_state SET scoring_revision_id = ?1, updated_at = ?2 WHERE internal_game_id = ?3"
        ).bind(activeRevision.id, now.toISOString(), internalGameId).run();
      } catch (error) {
        if (!isPregameSchemaError(error)) throw error;
      }
    }
  }
  if (!activeRevision?.id) throw createV3Error("V3_SCORING_REVISION_REQUIRED", "有効な採点revisionがありません。", { retryable: false });
  await markGameRankingScoredPrivate(env.AUTH_DB, internalGameId, now.toISOString(), env, 0, internalGameId);
  await recordRankingReflectionRevision(env.AUTH_DB, {
    internalGameId,
    scoringRevisionId: activeRevision.id,
    eligibilityVersion: eligibility?.rankingEligibilityVersion || 1,
    status: "reflected",
    now
  });
  return {
    status: "ranked",
    stateBefore,
    stateAfter: "ranked",
    noOpReason,
    noOpEventType: noOpReason ? "ranking_no_op" : null
  };
}

async function executeV3PublishExecutor({ env, internalGameId, now, target, stateBefore }) {
  const activeRevision = await getActiveScoringRevision(env.AUTH_DB, internalGameId);
  const reflectedRevision = await env.AUTH_DB.prepare(
    `SELECT scoring_revision_id FROM ranking_reflection_revisions
      WHERE internal_game_id = ?1 AND status = 'reflected' ORDER BY ranking_update_revision DESC LIMIT 1`
  ).bind(internalGameId).first();
  if (!activeRevision?.id || reflectedRevision?.scoring_revision_id !== activeRevision.id) {
    throw createV3Error("V3_RANKING_REVISION_NOT_REFLECTED", "現在の採点revisionがランキングへ反映されていません。", { retryable: false });
  }
  const result = await publishScoredGameResults(env, internalGameId, now, { internalGameId, target, source: "v3" });
  if (!result.published && result.status !== "already_published") throw createV3Error("V3_PUBLICATION_NOT_READY", "V3公開条件を満たしていません。");
  return { status: result.status, stateBefore, stateAfter: "published" };
}

// The registry is the executable contract. Every V3 job type has one named
// handler, and dispatch never falls through to a legacy executor.
export const V3_JOB_EXECUTORS = Object.freeze({
  [V3_JOB_TYPE.NPB_IDENTITY_RESOLVE]: executeV3IdentityExecutor,
  [V3_JOB_TYPE.PROBABLE_STARTER_FETCH]: executeV3ProbableStarterExecutor,
  [V3_JOB_TYPE.ROSTER_FETCH]: executeV3RosterExecutor,
  [V3_JOB_TYPE.PREDICTION_CLOSE]: executeV3PredictionCloseExecutor,
  [V3_JOB_TYPE.LINEUP_FETCH]: (context) => executeV3LineupExecutor({ ...context, jobType: V3_JOB_TYPE.LINEUP_FETCH }),
  [V3_JOB_TYPE.LINEUP_FINALIZE]: (context) => executeV3LineupExecutor({ ...context, jobType: V3_JOB_TYPE.LINEUP_FINALIZE }),
  [V3_JOB_TYPE.SCORE]: executeV3ScoreExecutor,
  [V3_JOB_TYPE.RANKING_REBUILD]: executeV3RankingExecutor,
  [V3_JOB_TYPE.PUBLISH]: executeV3PublishExecutor
});

export async function executeGameAutomationV3Job({ env, job, internalGameId, now }) {
  const jobType = String(job?.job_type || "");
  // The registered handlers retain the canonical contracts for each branch:
  // jobType === "probable_starter_fetch" is UUID scoped, and lineup targets
  // carry gameCode: target.gameCode from the canonical games row; the
  // handlers pass gameId: internalGameId, date: target.game_date,
  // homeTeam: target.home_team, awayTeam: target.away_team,
  // identityOverride: lineupIdentity, source: "v3", and reject NPB_IDENTITY_UNRESOLVED.
  const executor = V3_JOB_EXECUTORS[jobType];
  if (!V3_JOB_REGISTRY[jobType] || typeof executor !== "function") {
    throw createV3Error("MISSING_EXECUTOR", `V3ジョブexecutorが未登録です: ${jobType}`, {
      jobType,
      errorClass: "SYSTEM"
    });
  }
  const target = await loadV3GameTarget(env.AUTH_DB, internalGameId);
  const state = await env.AUTH_DB.prepare(
    "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
  ).bind(internalGameId).first();
  return executor({
    env,
    job,
    internalGameId,
    now,
    target,
    stateBefore: String(state?.state || "scheduled")
  });
}

export function normalizeV3LineupFetchError(error, now = new Date()) {
  const rawCode = String(error?.code || "LINEUP_FETCH_FAILED").trim().toUpperCase();
  const validation = error?.validation || {};
  const unannounced = ["LINEUP_NOT_ANNOUNCED", "LINEUP_NOT_PUBLISHED"].includes(rawCode)
    || (rawCode === "LINEUP_INVALID_PLAYER_COUNT" && Number(validation.parsedCount || 0) === 0);
  if (!unannounced) return error;
  const normalized = createV3Error("LINEUP_NOT_ANNOUNCED", "NPB公式でスタメンがまだ発表されていません。", {
    retryable: true,
    retryAt: new Date(new Date(now).getTime() + 10 * 60 * 1000),
    reasonCode: "LINEUP_DATA_NOT_ANNOUNCED",
    originalErrorCode: rawCode,
    parseStage: error?.parseStage || validation.parseStage || "official_lineup"
  });
  normalized.validation = validation;
  normalized.upstreamUrl = error?.upstreamUrl || null;
  return normalized;
}

async function cleanupExpiredManualRescorePreviews(db, now) {
  try {
    await db.batch([
      db.prepare(
        `UPDATE game_rescore_jobs SET status = 'failed', error_code = 'RESCORE_PREVIEW_EXPIRED', updated_at = ?1
          WHERE status = 'previewed' AND updated_at <= ?2`
      ).bind(now.toISOString(), new Date(now.getTime() - MANUAL_RESCORE_PREVIEW_TTL_MS).toISOString()),
      db.prepare("DELETE FROM game_rescore_previews WHERE expires_at <= ?1").bind(now.toISOString())
    ]);
  } catch (error) {
    if (!isPregameSchemaError(error)) {
      console.warn(`[GAME_AUTOMATION] step=rescore_preview_cleanup status=failed code=${error?.code || "RESCORE_PREVIEW_CLEANUP_FAILED"}`);
    }
  }
}

async function isManualRescoreLocked(db, gameId) {
  try {
    const row = await db.prepare(
      `SELECT revisions.lineup_fingerprint AS revision_fingerprint, lineups.lineup_fingerprint AS active_fingerprint
         FROM game_lineup_revisions AS revisions
         JOIN game_lineups AS lineups ON lineups.game_id = revisions.game_id
        WHERE revisions.game_id = ?1
          AND revisions.is_current = 1
          AND revisions.source IN ('manual-revision', 'restore')
        LIMIT 1`
    ).bind(gameId).first();
    return Boolean(row?.revision_fingerprint && row.revision_fingerprint !== row.active_fingerprint);
  } catch (error) {
    if (isPregameSchemaError(error)) return false;
    throw error;
  }
}

async function recordCronStepFailure(db, processName, now, error) {
  const occurredAt = now instanceof Date ? now : new Date(now);
  try {
    await recordWorkflowLog(db, {
      eventType: "cron_step_failed",
      status: "error",
      occurredAt,
      message: `${String(processName || "workflow")}の自動処理に失敗しました。`,
      errorCode: String(error?.code || "CRON_STEP_FAILED"),
      metadata: {
        processName: String(processName || "workflow"),
        attemptedAt: Number.isNaN(occurredAt.getTime()) ? null : occurredAt.toISOString(),
        source: "cron"
      },
      source: "cron"
    });
  } catch (logError) {
    console.error(`[GAME_WORKFLOW_LOG] action=cron_step_failure status=failed code=${logError?.code || "WORKFLOW_LOG_WRITE_FAILED"}`);
  }
}

async function getCronPregameTimelines(db, now, fallbackGames = []) {
  try {
    const dates = getAutomationScheduleDates(now);
    const detected = await loadDetectedScheduleGames(db, dates);
    setDetectedScheduleGames(detected);
  } catch (error) {
    setDetectedScheduleGames(Array.isArray(fallbackGames) ? fallbackGames : []);
    console.warn(`[GAME_WORKFLOW] action=load_schedule status=failed code=${error?.code || "SCHEDULE_STATE_READ_FAILED"}`);
  }
  return getPregameTimelines();
}

function normalizeProbableStarterTeam(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["fighters", "buffaloes", "hawks", "lions", "eagles", "marines", "giants", "tigers", "baystars", "carp", "dragons", "swallows"].includes(normalized)
    ? normalized
    : "";
}

function findProbableStarterGame(target, games) {
  const expectedDate = String(target?.date || "");
  const expectedHome = normalizeProbableStarterTeam(target?.homeTeam);
  const expectedAway = normalizeProbableStarterTeam(target?.awayTeam);
  if (!expectedHome || !expectedAway) return null;
  const exact = (Array.isArray(games) ? games : []).find((game) => {
    return (!expectedDate || String(game?.date || "") === expectedDate)
      && normalizeProbableStarterTeam(game?.homeTeam) === expectedHome
      && normalizeProbableStarterTeam(game?.awayTeam) === expectedAway;
  });
  return exact || null;
}

export function serializeProbableStarterRow(row) {
  if (!row) return null;
  const status = String(row.status || "error");
  const errorCode = row.error_code || (status === "error" ? "PROBABLE_STARTER_FETCH_FAILED" : null);
  const homePitcherName = row.home_pitcher_name || "";
  const awayPitcherName = row.away_pitcher_name || "";
  const homePitcherId = row.home_pitcher_id || null;
  const awayPitcherId = row.away_pitcher_id || null;
  const partial = Boolean(homePitcherName) !== Boolean(awayPitcherName);
  const dataStatus = status === "error"
    ? normalizeProbableStarterDataStatus({ status: "error", errorCode, homePitcherName, awayPitcherName })
    : normalizeProbableStarterDataStatus({ status, errorCode, homePitcherName, awayPitcherName });
  return {
    gameId: String(row.game_id || ""),
    internalGameId: String(row.internal_game_id || ""),
    status,
    homePitcherName,
    awayPitcherName,
    homeProbableStarter: { name: homePitcherName, playerId: homePitcherId },
    awayProbableStarter: { name: awayPitcherName, playerId: awayPitcherId },
    partial,
    dataStatus,
    fullyAnnounced: dataStatus === "announced",
    fetchedAt: row.fetched_at || null,
    announcedAt: row.announced_at || null,
    nextCheckAt: row.next_check_at || null,
    sourceUrl: row.source_url || "",
    source: row.source || (row.source_url ? "npb" : ""),
    errorCode,
    lastFailureCode: errorCode,
    isConfirmed: dataStatus === "announced",
    updatedAt: row.updated_at || null
  };
}

async function isProbableStarterTestGame(db, gameId) {
  try {
    const testGame = await db.prepare(
      "SELECT game_id FROM test_games WHERE game_id = ?1 AND status <> 'deleted' LIMIT 1"
    ).bind(gameId).first();
    if (testGame) return true;
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  try {
    return await isTestRankingGame(db, gameId);
  } catch (error) {
    if (isPregameSchemaError(error)) return false;
    throw error;
  }
}

async function saveProbableStarterRow(db, {
  gameId,
  internalGameId = "",
  source = "cron",
  status,
  homePitcherName = "",
  awayPitcherName = "",
  fetchedAt = null,
  announcedAt = null,
  nextCheckAt = null,
  sourceUrl = "",
  errorCode = "",
  updatedAt
}) {
  const storageGameId = source === "v3" ? String(internalGameId || "").trim() : gameId;
  const storage = await requireInternalGameIdForWrite(db, { table: "probable_starters", gameId: storageGameId, internalGameId });
  if (source === "v3" && !storage.schemaReady) {
    throw createV3Error("V3_PROBABLE_STARTER_SCHEMA_UNAVAILABLE", "V3予告先発のUUID保存先が準備されていません。", { httpStatus: 503 });
  }
  const internalColumn = storage.schemaReady ? ", internal_game_id" : "";
  const internalValue = storage.schemaReady ? ", ?2" : "";
  const normalizedHomePitcherName = homePitcherName == null ? null : String(homePitcherName).trim() || null;
  const normalizedAwayPitcherName = awayPitcherName == null ? null : String(awayPitcherName).trim() || null;
  const bindValues = storage.schemaReady
    ? [storageGameId, storage.internalGameId || null, status, normalizedHomePitcherName, normalizedAwayPitcherName, fetchedAt, announcedAt, nextCheckAt, sourceUrl || null, errorCode || null, updatedAt]
    : [storageGameId, status, normalizedHomePitcherName, normalizedAwayPitcherName, fetchedAt, announcedAt, nextCheckAt, sourceUrl || null, errorCode || null, updatedAt];
  await db.prepare(
    `INSERT INTO probable_starters
       (game_id${internalColumn}, status, home_pitcher_name, away_pitcher_name, fetched_at, announced_at, next_check_at, source_url, error_code, updated_at)
     VALUES (?1${internalValue}, ?${storage.schemaReady ? 3 : 2}, ?${storage.schemaReady ? 4 : 3}, ?${storage.schemaReady ? 5 : 4}, ?${storage.schemaReady ? 6 : 5}, ?${storage.schemaReady ? 7 : 6}, ?${storage.schemaReady ? 8 : 7}, ?${storage.schemaReady ? 9 : 8}, ?${storage.schemaReady ? 10 : 9}, ?${storage.schemaReady ? 11 : 10})
     ON CONFLICT(game_id) DO UPDATE SET
       ${storage.schemaReady ? "internal_game_id = CASE WHEN excluded.internal_game_id IS NULL OR excluded.internal_game_id = '' THEN probable_starters.internal_game_id ELSE excluded.internal_game_id END," : ""}
       status = excluded.status,
       home_pitcher_name = COALESCE(excluded.home_pitcher_name, probable_starters.home_pitcher_name),
       away_pitcher_name = COALESCE(excluded.away_pitcher_name, probable_starters.away_pitcher_name),
       fetched_at = CASE WHEN probable_starters.fetched_at IS NULL OR excluded.fetched_at IS NULL OR excluded.fetched_at >= probable_starters.fetched_at THEN excluded.fetched_at ELSE probable_starters.fetched_at END,
       announced_at = COALESCE(excluded.announced_at, probable_starters.announced_at),
       next_check_at = excluded.next_check_at,
       source_url = excluded.source_url,
       error_code = excluded.error_code,
       updated_at = excluded.updated_at`
  ).bind(...bindValues).run();
}

async function readProbableStarterRow(db, { internalGameId = "" } = {}) {
  if (!INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || "").trim())) {
    throw createV3Error("V3_INTERNAL_GAME_ID_REQUIRED", "予告先発の読み取りにはinternal_game_idが必要です。", { httpStatus: 400 });
  }
  const columns = await getTableColumnSet(db, "probable_starters");
  if (!columns.has("internal_game_id")) {
    throw createV3Error("V3_PROBABLE_STARTER_SCHEMA_UNAVAILABLE", "予告先発のUUID保存先が準備されていません。", { httpStatus: 503 });
  }
  const rows = await db.prepare(
    `SELECT * FROM probable_starters
      WHERE internal_game_id = ?1
      ORDER BY COALESCE(fetched_at, updated_at) DESC
      LIMIT 3`
  ).bind(internalGameId).all();
  const canonical = resolveCanonicalProbableStarterRow(rows.results, internalGameId);
  if (canonical.integrityErrorReason) {
    throw createV3Error("DATA_INTEGRITY_ERROR", "UUID正規の予告先発データが複数存在します。", {
      httpStatus: 409,
      integrityErrorReason: canonical.integrityErrorReason,
      canonicalRowId: canonical.canonicalRowId,
      conflictingRowId: canonical.conflictingRowId,
      legacyRowDetected: canonical.legacyRowDetected,
      mismatchedRowId: canonical.mismatchedRowId,
      mismatchedInternalGameId: canonical.mismatchedInternalGameId
    });
  }
  return canonical.canonicalRow;
}

async function recordProbableStarterDecision(db, {
  eventType = "probable_starter_fetch_skipped",
  status = "info",
  gameId = "",
  occurredAt,
  message,
  errorCode = "",
  metadata = {},
  source = "cron"
} = {}) {
  if (source === "v3") return false;
  return recordWorkflowLog(db, {
    eventType,
    status,
    gameId,
    occurredAt,
    message,
    errorCode,
    metadata: { ...metadata, source },
    source
  });
}

export function isProbableStarterComplete(row) {
  return normalizeProbableStarterDataStatus(row) === "announced";
}

export function isProbableStarterTerminal(row) {
  const normalized = normalizeProbableStarterDataStatus(row);
  if (normalized === "announced") return true;
  // The retired V1/V2 selector historically treated a partial announced row
  // as terminal. V3 scheduling uses shouldStopProbableStarterScheduling, so
  // partial data remains eligible for the next V3 slot.
  const homePitcherName = String(row?.home_pitcher_name || row?.homePitcherName || "").trim();
  const awayPitcherName = String(row?.away_pitcher_name || row?.awayPitcherName || "").trim();
  const hasAnyPitcher = Boolean(homePitcherName || awayPitcherName);
  return String(row?.status || "").toLowerCase() === "announced" && hasAnyPitcher;
}

async function runProbableStarterFetch(env, target, now, { source = "cron" } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const gameId = String(target?.gameId || "");
  const sourceDate = getV3ProbableStarterSourceDate({
    now: current,
    currentGameStartAt: target?.startAt,
    nextGameDate: target?.nextGameDate || ""
  });
  if (!gameId || !target?.startAt || !Number.isFinite(new Date(target.startAt).getTime())) {
    await recordProbableStarterDecision(env.AUTH_DB, {
      eventType: "probable_starter_no_target",
      status: "warning",
      occurredAt: current,
      message: "予告先発の取得対象試合がありません。",
      errorCode: "PROBABLE_STARTER_NO_TARGET",
      metadata: { source },
      source
    });
    throw createPregameError("SCHEDULE_UNAVAILABLE", "予告先発の対象試合を確認できません。", { httpStatus: 409 });
  }
  if (source !== "v3" && await isProbableStarterTestGame(env.AUTH_DB, gameId)) {
    return { status: "skipped", reason: "test_game", gameId };
  }

  const fetchedAt = current.toISOString();
  if (source !== "v3") {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "probable_starter_fetch_started",
      status: "info",
      gameId,
      occurredAt: current,
      message: "予告先発の取得を開始しました。",
      metadata: { source, sourceDate },
      source
    });
  }

  let previous = null;
  let terminalLogged = false;
  const diagnostics = {
    httpStatus: null,
    responseType: null,
    parserResult: "not_started",
    candidateCount: 0,
    homePitcherName: null,
    awayPitcherName: null,
    rawStatus: null,
    rawDataStatus: null,
    fetchedNpbGameCode: null,
    dataStatus: null,
    errorCode: null,
    integrityErrorReason: null,
    canonicalRowId: null,
    conflictingRowId: null,
    legacyRowDetected: false,
    nextCheckAt: null
  };
  const recordTerminal = async (details) => {
    const result = await recordProbableStarterDecision(env.AUTH_DB, details);
    // null means the equivalent terminal log was deduplicated; it is still a recorded outcome.
    terminalLogged = result !== false;
    return result;
  };
  try {
    previous = await readProbableStarterRow(env.AUTH_DB, {
      internalGameId: target?.internalGameId || ""
    });
    const payload = await fetchNpbWorkerJson(env, { mode: "starter" });
    diagnostics.httpStatus = payload?.__fetchMeta?.httpStatus ?? null;
    diagnostics.responseType = payload?.__fetchMeta?.contentType || "application/json";
    if (!Array.isArray(payload?.games)) {
      diagnostics.parserResult = "invalid_games_shape";
      throw createPregameError("PROBABLE_STARTER_RESPONSE_INVALID", "予告先発レスポンスの試合一覧が不正です。", {
        httpStatus: diagnostics.httpStatus,
        responseType: diagnostics.responseType
      });
    }
    diagnostics.candidateCount = payload.games.length;
    const matched = findProbableStarterGame(target, payload.games);
    diagnostics.parserResult = matched ? "matched" : "unannounced";
    diagnostics.fetchedGameDate = matched?.date || null;
    diagnostics.fetchedHomeTeam = matched?.homeTeam || null;
    diagnostics.fetchedAwayTeam = matched?.awayTeam || null;
    diagnostics.fetchedNpbGameCode = matched?.npbGameCode || matched?.gameCode || matched?.npb_game_code || null;
    diagnostics.rawStatus = matched ? "announced" : "unannounced";
    diagnostics.rawDataStatus = diagnostics.rawStatus;
    const freshHomePitcherName = String(matched?.homeStarter?.name || "").trim();
    const freshAwayPitcherName = String(matched?.awayStarter?.name || "").trim();
    const homePitcherName = freshHomePitcherName || String(previous?.home_pitcher_name || "").trim();
    const awayPitcherName = freshAwayPitcherName || String(previous?.away_pitcher_name || "").trim();
    diagnostics.homePitcherName = homePitcherName || null;
    diagnostics.awayPitcherName = awayPitcherName || null;
    const dataStatus = normalizeProbableStarterDataStatus({
      dataStatus: matched ? "announced" : "unannounced",
      status: matched ? "announced" : "unannounced",
      errorCode: matched ? null : previous?.error_code,
      homePitcherName: freshHomePitcherName,
      awayPitcherName: freshAwayPitcherName
    });
    const fullyAnnounced = Boolean(homePitcherName && awayPitcherName);
    const freshFullyAnnounced = Boolean(freshHomePitcherName && freshAwayPitcherName);
    const hasAnyPitcher = Boolean(freshHomePitcherName || freshAwayPitcherName);
    const partial = hasAnyPitcher && !freshFullyAnnounced;
    const announced = dataStatus === "announced" || dataStatus === "partial";
    const normalizedFetchedAt = String(payload.fetchedAt || fetchedAt);
    const announcedAt = freshFullyAnnounced ? (previous?.announced_at || normalizedFetchedAt) : (previous?.announced_at || null);
    const nextFixedSlot = source === "v3"
      ? getV3ProbableStarterSlots({ gameDate: target?.nextGameDate, startAt: target?.startAt })
        .find((slot) => slot.getTime() > current.getTime())
      : null;
    const nextCheckAt = announced
      ? null
      : nextFixedSlot?.toISOString() || new Date(current.getTime() + PROBABLE_STARTER_RETRY_INTERVAL_MS).toISOString();
    const status = announced ? "announced" : "unannounced";
    diagnostics.dataStatus = dataStatus;
    diagnostics.nextCheckAt = nextCheckAt;
    await saveProbableStarterRow(env.AUTH_DB, {
        gameId,
        internalGameId: target?.internalGameId || "",
        source,
        status,
      homePitcherName,
      awayPitcherName,
      fetchedAt: normalizedFetchedAt,
      announcedAt,
      nextCheckAt,
      sourceUrl: payload.sourceUrl || "https://npb.jp/announcement/starter/",
      errorCode: "",
      updatedAt: fetchedAt
    });
    // Legacy compatibility only; V3 does not execute this update: linkLegacyGameRowsToInternalGameId(env.AUTH_DB, target?.internalGameId, gameId)
    if (source !== "v3") await linkLegacyGameRowsToInternalGameId(env.AUTH_DB, target?.internalGameId, gameId);
    await recordTerminal({
      eventType: announced ? "probable_starter_announced" : "probable_starter_unannounced",
      status: announced ? "success" : "warning",
      gameId,
      occurredAt: current,
      message: announced ? (freshFullyAnnounced ? "予告先発を保存しました。" : "予告先発を一部保存しました。") : "予告先発はまだ発表されていません。",
      errorCode: "",
      metadata: { source, sourceDate, matched: Boolean(matched), nextCheckAt, partial, decisionCode: announced ? null : "PROBABLE_STARTER_UNANNOUNCED", ...diagnostics },
      source
    });
    return {
      ok: true,
      status: announced ? "success" : "notPublished",
      gameId,
      probableStarter: serializeProbableStarterRow({
        game_id: gameId,
        status,
        home_pitcher_name: homePitcherName,
        away_pitcher_name: awayPitcherName,
        fetched_at: normalizedFetchedAt,
        announced_at: announcedAt,
        next_check_at: nextCheckAt,
        source_url: payload.sourceUrl || "https://npb.jp/announcement/starter/",
        error_code: "",
        internal_game_id: target?.internalGameId || "",
        updated_at: fetchedAt
      })
    };
  } catch (error) {
    const errorCode = String(error?.code || "PROBABLE_STARTER_FETCH_FAILED").slice(0, 80);
    const nextFixedSlot = source === "v3"
      ? getV3ProbableStarterSlots({ gameDate: target?.nextGameDate, startAt: target?.startAt })
        .find((slot) => slot.getTime() > current.getTime())
      : null;
    let nextCheckAt = new Date(current.getTime() + PROBABLE_STARTER_RETRY_INTERVAL_MS);
    if (nextFixedSlot) nextCheckAt = nextFixedSlot;
    const nextCheckAtIso = nextCheckAt.toISOString();
    diagnostics.dataStatus = normalizeProbableStarterDataStatus({ status: "error", errorCode });
    diagnostics.errorCode = errorCode;
    diagnostics.integrityErrorReason = error?.integrityErrorReason || null;
    diagnostics.canonicalRowId = error?.canonicalRowId || null;
    diagnostics.conflictingRowId = error?.conflictingRowId || null;
    diagnostics.legacyRowDetected = error?.legacyRowDetected === true;
    diagnostics.rawStatus = "error";
    diagnostics.rawDataStatus = "error";
    diagnostics.nextCheckAt = nextCheckAtIso;
    diagnostics.httpStatus = diagnostics.httpStatus ?? error?.httpStatus ?? error?.upstreamStatus ?? null;
    diagnostics.responseType = diagnostics.responseType || error?.contentType || null;
    diagnostics.parserResult = diagnostics.parserResult === "not_started" ? "fetch_failed" : diagnostics.parserResult;
    try {
      await saveProbableStarterRow(env.AUTH_DB, {
        gameId,
        internalGameId: target?.internalGameId || "",
        source,
        status: "error",
        homePitcherName: previous?.home_pitcher_name || "",
        awayPitcherName: previous?.away_pitcher_name || "",
        fetchedAt,
        announcedAt: previous?.announced_at || null,
        nextCheckAt: nextCheckAtIso,
        sourceUrl: previous?.source_url || "https://npb.jp/announcement/starter/",
        errorCode,
        updatedAt: fetchedAt
      });
      // Legacy compatibility only; V3 does not execute this update: linkLegacyGameRowsToInternalGameId(env.AUTH_DB, target?.internalGameId, gameId)
      if (source !== "v3") await linkLegacyGameRowsToInternalGameId(env.AUTH_DB, target?.internalGameId, gameId);
    } catch (saveError) {
      console.warn(`[PROBABLE_STARTER] action=save status=failed code=${saveError?.code || "PROBABLE_STARTER_SAVE_FAILED"}`);
    }
    await recordTerminal({
      eventType: "probable_starter_fetch_failed",
      status: "error",
      gameId,
      occurredAt: current,
      message: "予告先発を取得できませんでした。",
      errorCode,
      metadata: { source, sourceDate, nextCheckAt: nextCheckAtIso, ...diagnostics },
      source
    });
    throw error;
  } finally {
    if (!terminalLogged) {
      await recordProbableStarterDecision(env.AUTH_DB, {
        eventType: "probable_starter_fetch_failed",
        status: "error",
        gameId,
        occurredAt: current,
        message: "予告先発の取得処理が完了状態を記録できませんでした。",
        errorCode: "PROBABLE_STARTER_TERMINAL_STATE_MISSING",
        metadata: { source, sourceDate, ...diagnostics },
        source
      });
    }
  }
}

export async function selectProbableStarterCronTarget(db, now = new Date()) {
  const target = await getServerPredictionTarget(db, now);
  if (!target?.internalGameId || !INTERNAL_GAME_ID_PATTERN.test(String(target.internalGameId))) {
    return { target: null, row: null, reason: "internal_id_missing", gameId: "" };
  }
  const row = await readProbableStarterRow(db, { internalGameId: target.internalGameId });
  if (isProbableStarterTerminal(row)) {
    return { target: null, row, reason: "already_announced", gameId: target.gameId };
  }
  return { target, row, reason: "candidate", gameId: target.gameId };
}

function getProbableStarterJobMaxAttempts(startAt, now) {
  const remainingMilliseconds = Math.max(0, new Date(startAt).getTime() - new Date(now).getTime());
  return Math.max(1, Math.ceil(remainingMilliseconds / PROBABLE_STARTER_RETRY_INTERVAL_MS) + 1);
}

export function getWorkflowJobErrorCode(error) {
  const code = String(error?.code || "").toUpperCase();
  if (["WORKFLOW_TRANSITION_INVALID", "WORKFLOW_STATE_CONFLICT"].includes(code)
    || String(error?.message || "") === "試合進行状態を final_lineup_captured から scored_private へ変更できません。") {
    return "WORKFLOW_STATE_TRANSITION_FAILED";
  }
  if ([
    "GAME_TARGET_INVALID",
    "GAME_TARGET_IDENTIFIER_CONFLICT",
    "NPB_GAME_CODE_CONFLICT",
    "NPB_GAME_CODE_UNAVAILABLE",
    "LINEUP_SOURCE_UNRESOLVED",
    "PUBLICATION_TARGET_INVALID",
    "PUBLICATION_TARGET_IDENTIFIER_CONFLICT",
    "PUBLICATION_PREREQUISITE_MISSING",
    "PUBLICATION_RESULT_PERSIST_FAILED",
    "PUBLICATION_ALREADY_COMPLETED",
    "PUBLICATION_RECOVERY_ELIGIBLE"
  ].includes(code)) return code;
  if (code.includes("NOT_ANNOUNCED") || code.includes("UNANNOUNCED")) return "DATA_NOT_ANNOUNCED";
  if (code.includes("RATE") || code.includes("429")) return "EXTERNAL_RATE_LIMITED";
  if (code.includes("HTTP") || code.includes("FETCH") || code.includes("TIMEOUT")) return "EXTERNAL_HTTP_ERROR";
  if (code.includes("PARSE")) return "DATA_PARSE_FAILED";
  if (code.includes("INVALID") || code.includes("VALIDATION")) return "DATA_VALIDATION_FAILED";
  if (code.includes("DATABASE") || code.includes("SAVE")) return "DATABASE_WRITE_FAILED";
  return code || "JOB_FAILED";
}

export function getCompletionWorkflowErrorCode(error, jobType = "") {
  if (String(jobType || "") === "publication"
    && String(error?.name || "") === "ReferenceError"
    && String(error?.message || "") === PUBLICATION_REFERENCE_ERROR_DETAIL) {
    return PUBLICATION_REFERENCE_ERROR_REASON;
  }
  return getWorkflowJobErrorCode(error);
}

export function isCompletionWorkflowErrorRetryable(error, errorCode, { expired = false } = {}) {
  if (expired || typeof error?.retryable === "boolean" && error.retryable === false) return false;
  const code = String(errorCode || error?.code || "").toUpperCase();
  if ([
    "GAME_TARGET_INVALID",
    "GAME_TARGET_IDENTIFIER_CONFLICT",
    "NPB_GAME_CODE_CONFLICT",
    "JOB_INPUT_INVALID",
    "INTERNAL_GAME_ID_MISSING",
    "GAME_IDENTIFIER_NOT_FOUND",
    "GAME_IDENTIFIER_AMBIGUOUS",
    "LINEUP_SOURCE_UNRESOLVED",
    "WORKFLOW_STATE_TRANSITION_FAILED",
    "SCORING_RETRY_EXPIRED",
    "DATA_VALIDATION_FAILED",
    PUBLICATION_REFERENCE_ERROR_REASON
  ].includes(code)) return false;
  return true;
}

function sanitizeLineupValidationDetails(details = {}) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const numericKeys = [
    "expectedCount", "parsedCount", "resolvedPlayerCount", "validPositionCount",
    "missingPositionCount", "duplicateBattingOrderCount", "duplicatePlayerCount",
    "battingOrderMin", "battingOrderMax", "parsedHomeCount", "parsedAwayCount",
    "expectedHomeCount", "expectedAwayCount", "httpStatus"
  ];
  const stringKeys = ["parseStage", "reason", "validationReason", "sourceUrlHost"];
  const result = {};
  for (const key of numericKeys) {
    result[key] = Number.isFinite(Number(details[key])) ? Number(details[key]) : null;
  }
  for (const key of stringKeys) {
    if (typeof details[key] === "string" && details[key]) result[key] = details[key].slice(0, 80);
  }
  if (Array.isArray(details.detectedTeams)) result.detectedTeams = details.detectedTeams.filter((team) => typeof team === "string").map((team) => team.slice(0, 40)).slice(0, 4);
  if (Array.isArray(details.expectedTeams)) result.expectedTeams = details.expectedTeams.filter((team) => typeof team === "string").map((team) => team.slice(0, 40)).slice(0, 4);
  if (details.battingOrderRange && typeof details.battingOrderRange === "object") {
    result.battingOrderRange = {
      min: Number.isFinite(Number(details.battingOrderRange.min)) ? Number(details.battingOrderRange.min) : null,
      max: Number.isFinite(Number(details.battingOrderRange.max)) ? Number(details.battingOrderRange.max) : null
    };
  } else if ("battingOrderMin" in result || "battingOrderMax" in result) {
    result.battingOrderRange = { min: result.battingOrderMin ?? null, max: result.battingOrderMax ?? null };
  }
  if (typeof details.retryable === "boolean") result.retryable = details.retryable;
  if (typeof details.nextAttemptAt === "string" && details.nextAttemptAt) result.nextAttemptAt = details.nextAttemptAt.slice(0, 40);
  return Object.keys(result).length ? result : null;
}

function parseSafeWorkflowJobMetadata(value) {
  if (!value) return {};
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const result = {};
  const validation = sanitizeLineupValidationDetails(parsed.validation);
  if (validation) result.validation = validation;
  if (typeof parsed.parseStage === "string" && parsed.parseStage) result.parseStage = parsed.parseStage.slice(0, 80);
  if (typeof parsed.sourceUrlHost === "string" && parsed.sourceUrlHost) result.sourceUrlHost = parsed.sourceUrlHost.slice(0, 120);
  if (Number.isFinite(Number(parsed.httpStatus)) && Number(parsed.httpStatus) > 0) result.httpStatus = Number(parsed.httpStatus);
  if (typeof parsed.retryable === "boolean") result.retryable = parsed.retryable;
  if (typeof parsed.status === "string" && parsed.status) result.status = parsed.status.slice(0, 40);
  if (typeof parsed.recoveryMode === "string" && parsed.recoveryMode) result.recoveryMode = parsed.recoveryMode.slice(0, 80);
  if (typeof parsed.recoveryReasonCode === "string" && parsed.recoveryReasonCode) result.recoveryReasonCode = parsed.recoveryReasonCode.slice(0, 100);
  if (typeof parsed.recoveredAt === "string" && parsed.recoveredAt) result.recoveredAt = parsed.recoveredAt.slice(0, 40);
  if (typeof parsed.previousErrorCode === "string" && parsed.previousErrorCode) result.previousErrorCode = parsed.previousErrorCode.slice(0, 100);
  if (typeof parsed.previousErrorDetail === "string" && parsed.previousErrorDetail) result.previousErrorDetail = parsed.previousErrorDetail.slice(0, 500);
  if (Number.isFinite(Number(parsed.attemptCountBeforeRecovery))) result.attemptCountBeforeRecovery = Number(parsed.attemptCountBeforeRecovery);
  if (typeof parsed.attemptCountChanged === "boolean") result.attemptCountChanged = parsed.attemptCountChanged;
  if (typeof parsed.workflowTerminalOverrideApplied === "boolean") result.workflowTerminalOverrideApplied = parsed.workflowTerminalOverrideApplied;
  const executionDiagnostics = sanitizeWorkflowExecutionDiagnostics(parsed);
  if (executionDiagnostics) Object.assign(result, executionDiagnostics);
  const targetResolution = sanitizeWorkflowTargetDiagnostics(parsed.targetResolution);
  if (targetResolution) result.targetResolution = targetResolution;
  return result;
}

function sanitizeWorkflowExecutionDiagnostics(details = {}) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const result = {};
  const numericKeys = ["claimedJobId", "lineupHttpStatus"];
  const stringKeys = [
    "claimedJobType", "resolvedNpbGameCode", "lineupSourceUrl", "lineupParseStage",
    "lineupDataClassification", "dataNotAnnouncedReason", "rosterResolutionStage", "rosterResolvedBy"
  ];
  for (const key of numericKeys) {
    if (Number.isInteger(Number(details[key])) && Number(details[key]) > 0) result[key] = Number(details[key]);
  }
  for (const key of stringKeys) {
    if (typeof details[key] === "string" && details[key]) result[key] = details[key].slice(0, key === "lineupSourceUrl" ? 240 : 120);
  }
  if (typeof details.rosterStartAtFound === "boolean") result.rosterStartAtFound = details.rosterStartAtFound;
  return Object.keys(result).length ? result : null;
}

function getWorkflowExecutionDiagnostics({ job = null, target = null, result = null, error = null } = {}) {
  const jobType = String(job?.job_type || job?.jobType || "");
  const diagnostics = {
    claimedJobId: Number(job?.id || 0),
    claimedJobType: jobType
  };
  if (jobType.includes("lineup")) {
    const rawCode = String(error?.code || "").toUpperCase();
    const sourceUrl = String(error?.upstreamUrl || result?.sourceUrl || "");
    if (target?.gameCode) diagnostics.resolvedNpbGameCode = String(target.gameCode);
    if (/^https:\/\/npb\.jp\//i.test(sourceUrl)) diagnostics.lineupSourceUrl = sourceUrl;
    diagnostics.lineupHttpStatus = Number(error?.upstreamStatus || error?.httpStatus || error?.externalStatus || 0);
    diagnostics.lineupParseStage = String(error?.parseStage || (result ? "official_lineup" : ""));
    diagnostics.lineupDataClassification = result?.reused
      ? "stored"
      : result
        ? "announced"
        : /NOT_ANNOUNCED|NOT_PUBLISHED|UNANNOUNCED/.test(rawCode)
          ? "not_announced"
          : "fetch_failed";
    if (diagnostics.lineupDataClassification === "not_announced") {
      diagnostics.dataNotAnnouncedReason = rawCode || "LINEUP_NOT_ANNOUNCED";
    }
  }
  if (jobType === "roster_fetch" || jobType === "run-roster") {
    diagnostics.rosterResolutionStage = String(error?.rosterResolution?.resolutionStage || result?.rosterResolution?.resolutionStage || "resolvePregameIdentity");
    diagnostics.rosterResolvedBy = String(error?.rosterResolution?.resolvedBy || result?.rosterResolution?.resolvedBy || "");
    diagnostics.rosterStartAtFound = Boolean(error?.rosterResolution?.startAtFound ?? result?.rosterResolution?.startAtFound);
  }
  return sanitizeWorkflowExecutionDiagnostics(diagnostics) || {};
}

function sanitizeWorkflowTargetDiagnostics(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const result = {};
  const booleanKeys = [
    "internalGameIdFound", "gameRowFound", "scheduleRowFound", "npbGameCodePresent", "retryable", "externalScheduleRequired"
  ];
  const numberKeys = ["identifierCount"];
  const stringKeys = [
    "validationStage", "resolvedBy", "npbGameCodeResolvedBy", "sourceGameKey", "targetValidityReason", "gameDate", "startAt", "homeTeam", "awayTeam"
  ];
  for (const key of booleanKeys) {
    if (typeof details[key] === "boolean") result[key] = details[key];
  }
  for (const key of numberKeys) {
    if (Number.isFinite(Number(details[key]))) result[key] = Number(details[key]);
  }
  for (const key of stringKeys) {
    if (typeof details[key] === "string" && details[key]) result[key] = details[key].slice(0, 120);
  }
  if (Array.isArray(details.missingFields)) {
    result.missingFields = details.missingFields
      .filter((field) => typeof field === "string")
      .map((field) => field.slice(0, 60))
      .slice(0, 12);
  }
  if (Array.isArray(details.npbGameCodeCandidates)) {
    result.npbGameCodeCandidates = details.npbGameCodeCandidates
      .filter((value) => typeof value === "string")
      .map((value) => value.slice(0, 40))
      .slice(0, 4);
  }
  if (Array.isArray(details.identifierConflicts)) {
    result.identifierConflicts = details.identifierConflicts
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        provider: typeof item.provider === "string" ? item.provider.slice(0, 40) : "",
        identifierType: typeof item.identifierType === "string" ? item.identifierType.slice(0, 60) : "",
        identifierValue: typeof item.identifierValue === "string" ? item.identifierValue.slice(0, 120) : "",
        internalGameId: typeof item.internalGameId === "string" ? item.internalGameId.slice(0, 80) : ""
      }))
      .slice(0, 8);
  }
  return Object.keys(result).length ? result : null;
}

function getSafeWorkflowErrorMetadata(error) {
  const metadata = {};
  const validation = sanitizeLineupValidationDetails(error?.validation);
  if (validation) metadata.validation = validation;
  if (typeof error?.parseStage === "string" && error.parseStage) metadata.parseStage = error.parseStage.slice(0, 80);
  metadata.retryable = typeof error?.retryable === "boolean"
    ? error.retryable
    : !String(error?.code || "").toUpperCase().includes("INVALID")
      && !String(error?.code || "").toUpperCase().includes("VALIDATION");
  const targetResolution = sanitizeWorkflowTargetDiagnostics(error?.targetResolution);
  if (targetResolution) metadata.targetResolution = targetResolution;
  if (Number(error?.httpStatus || error?.upstreamStatus || error?.externalStatus) > 0) {
    metadata.httpStatus = Number(error.httpStatus || error.upstreamStatus || error.externalStatus);
  }
  if (typeof error?.upstreamUrl === "string") {
    try {
      const host = new URL(error.upstreamUrl).hostname;
      if (host === "npb.jp" || host.endsWith(".npb.jp")) metadata.sourceUrlHost = host;
    } catch {
      // URLの不正値は診断情報へ含めません。
    }
  }
  const executionDiagnostics = sanitizeWorkflowExecutionDiagnostics(error?.workflowDiagnostics || error);
  if (executionDiagnostics) Object.assign(metadata, executionDiagnostics);
  if (error?.rosterResolution && typeof error.rosterResolution === "object") {
    const rosterDiagnostics = sanitizeWorkflowExecutionDiagnostics({
      rosterResolutionStage: error.rosterResolution.resolutionStage,
      rosterResolvedBy: error.rosterResolution.resolvedBy,
      rosterStartAtFound: error.rosterResolution.startAtFound
    });
    if (rosterDiagnostics) Object.assign(metadata, rosterDiagnostics);
  }
  return metadata;
}

export function getWorkflowJobHealth(job, now = new Date()) {
  if (!job) return { status: "not_started", level: "info", reasonCode: "JOB_NOT_CREATED", message: "ジョブ未作成" };
  const status = String(job.status || "");
  if (status === "retry_wait") {
    const next = job.nextAttemptAt ? new Date(job.nextAttemptAt) : null;
    const overdue = !next || Number.isNaN(next.getTime()) || next <= now;
    return {
      status,
      level: overdue ? "error" : "warning",
      reasonCode: job.errorCode || "WORKFLOW_JOB_RETRY_WAIT",
      message: job.errorDetail || "再試行待ちです。",
      nextAttemptAt: job.nextAttemptAt || null,
      overdue
    };
  }
  if (status === "permanently_failed") {
    return { status, level: "error", reasonCode: job.errorCode || "WORKFLOW_JOB_FAILED", message: job.errorDetail || "ジョブが恒久失敗しました。" };
  }
  if (status === "succeeded") return { status, level: "success", reasonCode: "", message: "完了" };
  if (status === "cancelled") return { status, level: "info", reasonCode: "JOB_CANCELLED", message: "キャンセル済み" };
  return { status: status || "unknown", level: "waiting", reasonCode: "WORKFLOW_JOB_PENDING", message: "実行待ちです。" };
}

export function summarizeLineupWorkflowJobs(jobs = [], now = new Date()) {
  const lineupJobs = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => ["provisional_lineup_fetch", "final_lineup_fetch"].includes(job?.jobType))
    .sort((left, right) => String(right.updatedAt || right.startedAt || right.scheduledAt || "").localeCompare(String(left.updatedAt || left.startedAt || left.scheduledAt || "")));
  const finalJob = lineupJobs.find((job) => job.jobType === "final_lineup_fetch") || null;
  const relevantJobs = finalJob?.status === "succeeded"
    ? lineupJobs.filter((job) => job.jobType === "final_lineup_fetch")
    : lineupJobs.filter((job) => job.status !== "cancelled");
  const latest = relevantJobs[0] || null;
  const latestValidation = sanitizeLineupValidationDetails(latest?.validation);
  const health = getWorkflowJobHealth(latest, now);
  const byType = (jobType) => {
    const job = lineupJobs.find((candidate) => candidate.jobType === jobType && candidate.status !== "cancelled")
      || lineupJobs.find((candidate) => candidate.jobType === jobType)
      || null;
    if (!job) return null;
    const jobHealth = getWorkflowJobHealth(job, now);
    return {
      status: job.status,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      scheduledAt: job.scheduledAt || null,
      nextAttemptAt: job.nextAttemptAt || null,
      errorCode: job.errorCode || null,
      errorDetail: job.errorDetail || null,
      updatedAt: job.updatedAt || null,
      health: jobHealth,
      validation: sanitizeLineupValidationDetails(job.validation)
    };
  };
  const warnings = relevantJobs
    .map((job) => ({ job, health: getWorkflowJobHealth(job, now) }))
    .filter(({ health: item }) => item.level === "warning")
    .map(({ job, health: item }) => `${job.jobType}:${item.reasonCode}`);
  const errors = relevantJobs
    .map((job) => ({ job, health: getWorkflowJobHealth(job, now) }))
    .filter(({ health: item }) => item.level === "error")
    .map(({ job, health: item }) => `${job.jobType}:${item.reasonCode}`);
  return {
    status: finalJob?.status === "succeeded" ? "completed" : (latest ? health.status : "not_started"),
    lineupFetchStatus: {
      provisional: byType("provisional_lineup_fetch"),
      final: byType("final_lineup_fetch")
    },
    lineupJobs,
    lastFetchAttempt: latest ? {
      jobType: latest.jobType,
      status: latest.status,
      attemptCount: latest.attemptCount,
      maxAttempts: latest.maxAttempts,
      startedAt: latest.startedAt || null,
      updatedAt: latest.updatedAt || null,
      nextAttemptAt: latest.nextAttemptAt || null,
      errorCode: latest.errorCode || null,
      errorDetail: latest.errorDetail || null,
      health,
      validation: latestValidation
    } : null,
    validation: latestValidation,
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
    scoringEligibility: finalJob?.status === "succeeded"
      ? { eligible: true, status: "ready", reasonCode: "FINAL_LINEUP_JOB_SUCCEEDED" }
      : { eligible: false, status: health.level === "error" ? "blocked" : "waiting", reasonCode: finalJob?.errorCode || "FINAL_LINEUP_REQUIRED" }
  };
}

function getNpbGameCodeCandidate({ gameRow = null, identifiers = [], schedule = null, sourceMetadata = null, staticGameCode = "" } = {}) {
  const candidates = [];
  const add = (value, resolvedBy, persisted = true) => {
    const gameCode = normalizeNpbGameCode(value);
    if (gameCode) candidates.push({ gameCode, resolvedBy, persisted });
  };
  add(gameRow?.npb_game_code, "games.npb_game_code");
  for (const row of Array.isArray(identifiers) ? identifiers : []) {
    const provider = String(row?.provider || "").trim().toLowerCase();
    const type = String(row?.identifier_type || row?.identifierType || "").trim().toLowerCase();
    if ((provider === "npb" || !provider) && ["npb_game_code", "game_code"].includes(type)) {
      add(row?.identifier_value || row?.identifierValue, "game_identifiers");
    }
  }
  add(schedule?.game_code, "detected_game_schedule");
  add(sourceMetadata?.npbGameCode || sourceMetadata?.gameCode || sourceMetadata?.npb_game_code, "schedule_metadata", false);
  add(staticGameCode, "safe_schedule_resolver", false);
  const persisted = candidates.filter((candidate) => candidate.persisted);
  const persistedValues = [...new Set(persisted.map((candidate) => candidate.gameCode))];
  if (persistedValues.length > 1) {
    return {
      gameCode: "",
      storedGameCode: "",
      resolvedBy: "conflict",
      storedResolvedBy: "conflict",
      conflict: true,
      candidates: persistedValues
    };
  }
  const selected = candidates.find((candidate) => !candidate.persisted && persistedValues.length === 0)
    || persisted[0]
    || candidates[0]
    || null;
  return {
    gameCode: selected?.gameCode || "",
    storedGameCode: persisted[0]?.gameCode || "",
    resolvedBy: selected?.resolvedBy || "",
    storedResolvedBy: persisted[0]?.resolvedBy || "",
    conflict: false,
    candidates: [...new Set(candidates.map((candidate) => candidate.gameCode))]
  };
}

async function getWorkflowGameRow(db, internalGameId) {
  const baseQuery = `SELECT game_date, start_time, home_team, away_team, game_status
                       FROM games WHERE internal_game_id = ?1 LIMIT 1`;
  const base = await db.prepare(baseQuery).bind(internalGameId).first();
  try {
    const columns = await db.prepare("PRAGMA table_info(games)").bind().all();
    if (!(columns.results || []).some((column) => String(column.name || "") === "npb_game_code")) return base;
    return await db.prepare(
      `SELECT game_date, start_time, home_team, away_team, game_status, npb_game_code
         FROM games WHERE internal_game_id = ?1 LIMIT 1`
    ).bind(internalGameId).first() || base;
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
    return base;
  }
}

export function validateWorkflowJobTarget({
  internalGameId = "",
  gameRow = null,
  scheduleRows = [],
  identifiers = [],
  identifierConflicts = [],
  npbGameCodeConflict = false,
  npbGameCodeResolvedBy = "",
  isTestGame = false,
  staticGameCode = "",
  internalGameIdFound = Boolean(gameRow)
} = {}) {
  const normalizedInternalGameId = String(internalGameId || "").trim();
  const rows = Array.isArray(scheduleRows) ? scheduleRows.filter(Boolean) : [];
  const schedule = rows[0] || null;
  const getIdentifier = (type) => identifiers.find((row) => String(row?.identifier_type || row?.identifierType || "") === type);
  const descriptive = String(getIdentifier("descriptive_game_id")?.identifier_value || getIdentifier("descriptive_game_id")?.identifierValue || "").trim();
  const compact = String(getIdentifier("legacy_compact_game_id")?.identifier_value || getIdentifier("legacy_compact_game_id")?.identifierValue || "").trim();
  const legacyGameId = String(gameRow?.legacy_game_id || schedule?.game_id || descriptive || compact || "").trim();
  const sourceGameKey = String(schedule?.source_game_key || getIdentifier("source_game_key")?.identifier_value || getIdentifier("source_game_key")?.identifierValue || "").trim();
  const storedNpbGame = getNpbGameCodeCandidate({
    gameRow,
    identifiers,
    schedule,
    staticGameCode
  });
  const storedGameCode = storedNpbGame.storedGameCode;
  const gameCode = storedNpbGame.gameCode;
  const hasNpbGameCodeConflict = npbGameCodeConflict || storedNpbGame.conflict;
  const gameDate = String(schedule?.game_date || gameRow?.game_date || "").trim();
  const startValue = String(schedule?.start_at || gameRow?.start_time || "").trim();
  const parsedStart = new Date(startValue);
  const startAt = Number.isNaN(parsedStart.getTime()) ? "" : parsedStart.toISOString();
  const homeTeam = String(schedule?.home_team || gameRow?.home_team || "").trim().toLowerCase();
  const awayTeam = String(schedule?.away_team || gameRow?.away_team || "").trim().toLowerCase();
  const missingFields = [];
  if (!INTERNAL_GAME_ID_PATTERN.test(normalizedInternalGameId)) missingFields.push("internalGameId");
  if (!gameRow) missingFields.push("gamesRow");
  if (!rows.length) missingFields.push("scheduleRow");
  if (!gameDate) missingFields.push("gameDate");
  if (!startAt) missingFields.push("startAt");
  if (!homeTeam) missingFields.push("homeTeam");
  if (!awayTeam) missingFields.push("awayTeam");
  const scheduleMismatch = Boolean(gameRow && schedule && (
    String(gameRow.game_date || "") !== String(schedule.game_date || "")
    || String(gameRow.home_team || "").trim().toLowerCase() !== homeTeam
    || String(gameRow.away_team || "").trim().toLowerCase() !== awayTeam
    || (gameRow.start_time && schedule.start_at && new Date(gameRow.start_time).getTime() !== new Date(schedule.start_at).getTime())
  ));
  const cancelled = [gameRow?.game_status, schedule?.game_status, schedule?.status]
    .some((value) => ["cancelled", "canceled", "postponed"].includes(String(value || "").toLowerCase()));
  const sameTeams = Boolean(homeTeam && awayTeam && homeTeam !== awayTeam);
  const conflicts = Array.isArray(identifierConflicts) ? identifierConflicts.filter((row) => String(row?.internal_game_id || "") !== normalizedInternalGameId) : [];
  let code = "";
  let targetValidityReason = "valid";
  if (conflicts.length) {
    code = "GAME_TARGET_IDENTIFIER_CONFLICT";
    targetValidityReason = "identifier_conflict";
  } else if (hasNpbGameCodeConflict) {
    code = "NPB_GAME_CODE_CONFLICT";
    targetValidityReason = "npb_game_code_conflict";
  } else if (!sameTeams) {
    code = "GAME_TARGET_INVALID";
    targetValidityReason = "home_away_invalid";
  } else if (scheduleMismatch) {
    code = "GAME_TARGET_INVALID";
    targetValidityReason = "schedule_game_mismatch";
  } else if (cancelled) {
    code = "GAME_TARGET_INVALID";
    targetValidityReason = "cancelled_game";
  } else if (missingFields.length) {
    code = "GAME_TARGET_INVALID";
    targetValidityReason = "required_target_field_missing";
  } else if (isTestGame) {
    code = "GAME_TARGET_INVALID";
    targetValidityReason = "test_game";
  }
  const resolvedBy = storedGameCode
    ? (npbGameCodeResolvedBy || storedNpbGame.storedResolvedBy || "npbGameCode")
    : sourceGameKey
      ? "sourceGameKey"
      : descriptive
        ? "descriptiveGameId"
        : "scheduleIdentity";
  const targetResolution = {
    validationStage: "job_target_resolution",
    missingFields,
    resolvedBy,
    internalGameIdFound: Boolean(internalGameIdFound),
    gameRowFound: Boolean(gameRow),
    scheduleRowFound: rows.length > 0,
    identifierCount: Array.isArray(identifiers) ? identifiers.length : 0,
    sourceGameKey,
    npbGameCodePresent: Boolean(storedGameCode),
    npbGameCodeResolvedBy: storedNpbGame.resolvedBy || null,
    npbGameCodeCandidates: storedNpbGame.candidates,
    targetValidityReason,
    gameDate,
    startAt,
    homeTeam,
    awayTeam,
    retryable: false,
    identifierConflicts: conflicts.map((row) => ({
      provider: String(row.provider || ""),
      identifierType: String(row.identifier_type || ""),
      identifierValue: String(row.identifier_value || ""),
      internalGameId: String(row.internal_game_id || "")
    }))
  };
  return {
    valid: !code,
    code,
    message: code === "GAME_TARGET_IDENTIFIER_CONFLICT"
      ? "試合識別子が別の内部試合IDにも紐付いています。"
      : code === "NPB_GAME_CODE_CONFLICT"
        ? "NPB公式試合コードが複数存在するため、安全に取得先を決定できません。"
      : "試合進行ジョブの対象試合が無効です。",
    targetResolution,
    target: {
      gameId: legacyGameId,
      internalGameId: normalizedInternalGameId,
      date: gameDate,
      startAt,
      homeTeam,
      awayTeam,
      gameCode,
      status: gameRow?.game_status || schedule?.game_status || "scheduled",
      sourceGameKey,
      targetResolution
    }
  };
}

export async function resolveWorkflowJobTarget(db, internalGameId) {
  const normalizedInternalGameId = String(internalGameId || "").trim();
  if (!INTERNAL_GAME_ID_PATTERN.test(normalizedInternalGameId)) {
    throw createPregameError("GAME_TARGET_INVALID", "試合進行ジョブの対象試合が無効です。", {
      retryable: false,
      targetResolution: {
        validationStage: "job_target_resolution",
        missingFields: ["internalGameId"],
        internalGameIdFound: false,
        gameRowFound: false,
        scheduleRowFound: false,
        identifierCount: 0,
        npbGameCodePresent: false,
        targetValidityReason: "invalid_internal_game_id",
        retryable: false
      }
    });
  }
  const state = await db.prepare(
    "SELECT legacy_game_id, game_status, workflow_status FROM game_workflow_state WHERE internal_game_id = ?1 LIMIT 1"
  ).bind(normalizedInternalGameId).first();
  const gameRow = await getWorkflowGameRow(db, normalizedInternalGameId);
  const scheduleResult = await db.prepare(
    `SELECT game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, game_status, internal_game_id
       FROM detected_game_schedule
      WHERE internal_game_id = ?1
      ORDER BY game_date ASC, start_at ASC, game_id ASC`
  ).bind(normalizedInternalGameId).all();
  const identifierResult = await db.prepare(
    `SELECT internal_game_id, provider, identifier_type, identifier_value
       FROM game_identifiers
      WHERE internal_game_id = ?1
      ORDER BY id ASC`
  ).bind(normalizedInternalGameId).all();
  const identifiers = identifierResult.results || [];
  const identityValues = [...new Set(identifiers.map((row) => String(row.identifier_value || "").trim()).filter(Boolean))];
  let identifierConflicts = [];
  if (identityValues.length) {
    const placeholders = identityValues.map((_, index) => `?${index + 2}`).join(", ");
    const conflictResult = await db.prepare(
      `SELECT internal_game_id, provider, identifier_type, identifier_value
         FROM game_identifiers
        WHERE internal_game_id <> ?1 AND identifier_value IN (${placeholders})
        ORDER BY identifier_value ASC, internal_game_id ASC`
    ).bind(normalizedInternalGameId, ...identityValues).all();
    identifierConflicts = conflictResult.results || [];
  }
  const legacyGameId = String(state?.legacy_game_id || scheduleResult.results?.[0]?.game_id || "").trim();
  const scheduleIdentity = scheduleResult.results?.[0] || null;
  const staticGame = legacyGameId ? getScheduledGame(legacyGameId) : null;
  const staticIdentityGame = getScheduledGames().find((candidate) => {
    const candidateStart = candidate?.startAt instanceof Date ? candidate.startAt : parseJstScheduleStart(candidate);
    const targetStart = new Date(scheduleIdentity?.start_at || gameRow?.start_time || "");
    return String(candidate?.date || "") === String(scheduleIdentity?.game_date || gameRow?.game_date || "")
      && String(candidate?.homeTeam || "").trim().toLowerCase() === String(scheduleIdentity?.home_team || gameRow?.home_team || "").trim().toLowerCase()
      && String(candidate?.awayTeam || "").trim().toLowerCase() === String(scheduleIdentity?.away_team || gameRow?.away_team || "").trim().toLowerCase()
      && candidateStart && !Number.isNaN(targetStart.getTime())
      && candidateStart.getTime() === targetStart.getTime();
  });
  const sourceGame = staticGame || staticIdentityGame;
  const staticGameCode = normalizeNpbGameCode(sourceGame?.gameCode)
    || /\/scores\/\d{4}\/\d{4}\/([a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+)\//i.exec(String(sourceGame?.npbScoreUrl || ""))?.[1]?.toLowerCase()
    || "";
  const npbGameCodeCandidate = getNpbGameCodeCandidate({
    gameRow,
    identifiers,
    schedule: scheduleIdentity,
    staticGameCode
  });
  const isTestGame = legacyGameId ? await isProbableStarterTestGame(db, legacyGameId) : false;
  const validation = validateWorkflowJobTarget({
    internalGameId: normalizedInternalGameId,
    gameRow,
    scheduleRows: scheduleResult.results || [],
    identifiers,
    identifierConflicts,
    npbGameCodeConflict: npbGameCodeCandidate.conflict,
    npbGameCodeResolvedBy: npbGameCodeCandidate.resolvedBy,
    isTestGame,
    staticGameCode,
    internalGameIdFound: Boolean(state || gameRow)
  });
  if (!validation.valid) {
    throw createPregameError(validation.code, validation.message, {
      retryable: false,
      targetResolution: validation.targetResolution
    });
  }
  return {
    ...validation.target,
    gameId: String(state?.legacy_game_id || validation.target.gameId || "").trim(),
    internalGameId: normalizedInternalGameId,
    workflowStatus: state?.workflow_status || "waiting"
  };
}

export const resolveWorkflowJobGame = resolveWorkflowJobTarget;

const PUBLICATION_LEGACY_ERROR_CODE = "SCHEDULE_UNAVAILABLE";
const PUBLICATION_LEGACY_ERROR_DETAIL = "試合日程を確認できません。";
const PUBLICATION_REFERENCE_ERROR_CODE = "JOB_FAILED";
const PUBLICATION_REFERENCE_ERROR_DETAIL = "RESULT_RELEASE_MINUTES_AFTER_START is not defined";
const PUBLICATION_REFERENCE_ERROR_REASON = "PUBLICATION_EXECUTOR_REFERENCE_ERROR";

function getPublicationRecoveryProfile(errorCode, errorDetail) {
  const code = String(errorCode || "");
  const detail = String(errorDetail || "");
  if (code === PUBLICATION_LEGACY_ERROR_CODE && detail === PUBLICATION_LEGACY_ERROR_DETAIL) {
    return {
      recoveryMode: "publication_legacy_schedule_error",
      reasonCode: "PUBLICATION_LEGACY_SCHEDULE_ERROR_REEVALUATION",
      allowOneOverMaxAttempt: false,
      errorCode: PUBLICATION_LEGACY_ERROR_CODE,
      errorDetail: PUBLICATION_LEGACY_ERROR_DETAIL
    };
  }
  if (code === PUBLICATION_REFERENCE_ERROR_CODE && detail === PUBLICATION_REFERENCE_ERROR_DETAIL) {
    return {
      recoveryMode: "publication_executor_reference_error",
      reasonCode: `${PUBLICATION_REFERENCE_ERROR_REASON}_REEVALUATION`,
      allowOneOverMaxAttempt: true,
      errorCode: PUBLICATION_REFERENCE_ERROR_CODE,
      errorDetail: PUBLICATION_REFERENCE_ERROR_DETAIL
    };
  }
  return null;
}

function getPublicationIdentifierValue(identifiers, types) {
  const allowed = new Set(types);
  return (Array.isArray(identifiers) ? identifiers : [])
    .find((row) => allowed.has(String(row?.identifier_type || "")))?.identifier_value || "";
}

// Publication uses persisted registry data. It must not depend on the static
// schedule or an NPB fetch after scoring and ranking have already succeeded.
export async function resolvePublicationTarget(db, internalGameId, requestedLegacyGameId = "") {
  let id = String(internalGameId || "").trim();
  const requested = String(requestedLegacyGameId || "").trim();
  if (!id && requested) {
    const candidates = new Set();
    try {
      const state = await db.prepare(
        "SELECT internal_game_id FROM game_workflow_state WHERE legacy_game_id = ?1 LIMIT 2"
      ).bind(requested).all();
      for (const row of state.results || []) if (row.internal_game_id) candidates.add(String(row.internal_game_id));
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
    }
    try {
      const schedule = await db.prepare(
        "SELECT internal_game_id FROM detected_game_schedule WHERE game_id = ?1 AND internal_game_id IS NOT NULL LIMIT 2"
      ).bind(requested).all();
      for (const row of schedule.results || []) if (row.internal_game_id) candidates.add(String(row.internal_game_id));
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
    }
    try {
      const identifiers = await db.prepare(
        "SELECT internal_game_id FROM game_identifiers WHERE identifier_value = ?1 LIMIT 2"
      ).bind(requested).all();
      for (const row of identifiers.results || []) if (row.internal_game_id) candidates.add(String(row.internal_game_id));
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
    }
    if (candidates.size === 1) id = [...candidates][0];
    if (candidates.size > 1) {
      throw createPregameError("PUBLICATION_TARGET_IDENTIFIER_CONFLICT", "公開対象の試合識別子が複数の内部試合IDに紐付いています。", { retryable: false });
    }
  }
  if (!INTERNAL_GAME_ID_PATTERN.test(id)) {
    throw createPregameError("PUBLICATION_TARGET_INVALID", "公開対象の内部試合IDが不正です。", { retryable: false });
  }
  const [state, game] = await Promise.all([
    db.prepare(
      "SELECT legacy_game_id, game_status, workflow_status FROM game_workflow_state WHERE internal_game_id = ?1 LIMIT 1"
    ).bind(id).first(),
    db.prepare(
      "SELECT internal_game_id, game_date, start_time, home_team, away_team, game_status FROM games WHERE internal_game_id = ?1 LIMIT 1"
    ).bind(id).first()
  ]);
  let schedule = null;
  let identifiers = [];
  try {
    schedule = await db.prepare(
      `SELECT game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, game_status
         FROM detected_game_schedule
        WHERE internal_game_id = ?1
        ORDER BY updated_at DESC, game_id ASC LIMIT 1`
    ).bind(id).first();
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  try {
    const identifierResult = await db.prepare(
      `SELECT provider, identifier_type, identifier_value
         FROM game_identifiers
        WHERE internal_game_id = ?1
        ORDER BY identifier_type ASC, identifier_value ASC`
    ).bind(id).all();
    identifiers = identifierResult.results || [];
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  const identifierValues = [...new Set(identifiers.map((row) => String(row?.identifier_value || "").trim()).filter(Boolean))];
  let identifierConflicts = [];
  if (identifierValues.length) {
    try {
      const placeholders = identifierValues.map((_, index) => `?${index + 2}`).join(", ");
      const conflictResult = await db.prepare(
        `SELECT internal_game_id, provider, identifier_type, identifier_value
           FROM game_identifiers
          WHERE internal_game_id <> ?1 AND identifier_value IN (${placeholders})
          ORDER BY identifier_value ASC, internal_game_id ASC`
      ).bind(id, ...identifierValues).all();
      identifierConflicts = conflictResult.results || [];
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
    }
  }
  const legacyGameId = String(
    state?.legacy_game_id
      || requestedLegacyGameId
      || schedule?.game_id
      || getPublicationIdentifierValue(identifiers, ["descriptive_game_id", "legacy_compact_game_id", "source_game_key"])
      || ""
  ).trim();
  const gameDate = String(schedule?.game_date || game?.game_date || "").trim();
  const startValue = String(schedule?.start_at || game?.start_time || "").trim();
  const parsedStart = new Date(startValue);
  const startAt = Number.isNaN(parsedStart.getTime()) ? "" : parsedStart.toISOString();
  const homeTeam = String(schedule?.home_team || game?.home_team || "").trim().toLowerCase();
  const awayTeam = String(schedule?.away_team || game?.away_team || "").trim().toLowerCase();
  const gameCode = normalizeNpbGameCode(schedule?.game_code)
    || normalizeNpbGameCode(getPublicationIdentifierValue(identifiers, ["npb_game_code", "game_code"]));
  const missingFields = [];
  if (!game) missingFields.push("gamesRow");
  if (!legacyGameId) missingFields.push("legacyGameId");
  if (!gameDate) missingFields.push("gameDate");
  if (!startAt) missingFields.push("startAt");
  if (!homeTeam) missingFields.push("homeTeam");
  if (!awayTeam) missingFields.push("awayTeam");
  const targetResolution = {
    validationStage: "publication_target_resolution",
    resolvedBy: schedule ? "internal_game_id+schedule" : "internal_game_id+games+identifiers",
    internalGameIdFound: Boolean(game),
    gameRowFound: Boolean(game),
    scheduleRowFound: Boolean(schedule),
    identifierCount: identifiers.length,
    npbGameCodePresent: Boolean(gameCode),
    externalScheduleRequired: false,
    gameDate,
    startAt,
    homeTeam,
    awayTeam,
    sourceGameKey: String(schedule?.source_game_key || getPublicationIdentifierValue(identifiers, ["source_game_key"])).trim(),
    missingFields,
    identifierConflicts: identifierConflicts.map((row) => ({
      provider: String(row.provider || ""),
      identifierType: String(row.identifier_type || ""),
      identifierValue: String(row.identifier_value || ""),
      internalGameId: String(row.internal_game_id || "")
    }))
  };
  if (identifierConflicts.length) {
    throw createPregameError("PUBLICATION_TARGET_IDENTIFIER_CONFLICT", "公開対象の試合識別子が競合しています。", { retryable: false, targetResolution });
  }
  if (missingFields.length) {
    throw createPregameError("PUBLICATION_TARGET_INVALID", "公開対象の既存試合情報が不足しています。", { retryable: false, targetResolution });
  }
  const status = String(state?.game_status || game?.game_status || schedule?.game_status || "scheduled").toLowerCase();
  if (["cancelled", "canceled", "postponed", "service_unavailable"].includes(status)) {
    throw createPregameError("PUBLICATION_TARGET_INVALID", "公開対象の試合状態が不正です。", { retryable: false, targetResolution });
  }
  return {
    gameId: legacyGameId,
    internalGameId: id,
    date: gameDate,
    startAt,
    homeTeam,
    awayTeam,
    gameCode,
    status,
    sourceGameKey: targetResolution.sourceGameKey,
    targetResolution
  };
}

export function getPublicationJobRecoveryEligibility({
  jobType = "",
  status = "",
  errorCode = "",
  errorDetail = "",
  publishedAt = null,
  publicationStatus = "pending",
  scoringPersisted = false,
  scoreResultCount = null,
  rankingReflected = false,
  internalGameIdMatches = false,
  identifierConflict = false,
  attemptCount = 0,
  maxAttempts = 0,
  recoveryProfile = null
} = {}) {
  if (String(jobType) !== "publication") return { eligible: false, reasonCode: "PUBLICATION_JOB_REQUIRED" };
  if (String(status) !== "permanently_failed") return { eligible: false, reasonCode: "PUBLICATION_JOB_NOT_PERMANENTLY_FAILED" };
  const profile = recoveryProfile || getPublicationRecoveryProfile(errorCode, errorDetail);
  if (!profile) {
    return { eligible: false, reasonCode: "PUBLICATION_LEGACY_ERROR_NOT_MATCHED" };
  }
  if (publishedAt || String(publicationStatus) === "published") return { eligible: false, reasonCode: "PUBLICATION_ALREADY_COMPLETED" };
  if (!scoringPersisted) return { eligible: false, reasonCode: "PUBLICATION_SCORING_REQUIRED" };
  if (scoreResultCount !== null && Number(scoreResultCount) !== 1) return { eligible: false, reasonCode: "PUBLICATION_SCORE_RESULT_COUNT_INVALID" };
  if (!rankingReflected) return { eligible: false, reasonCode: "PUBLICATION_RANKING_REQUIRED" };
  if (!internalGameIdMatches) return { eligible: false, reasonCode: "PUBLICATION_INTERNAL_ID_MISMATCH" };
  if (identifierConflict) return { eligible: false, reasonCode: "PUBLICATION_TARGET_IDENTIFIER_CONFLICT" };
  const attemptsMatch = Number(attemptCount) === Number(maxAttempts)
    || (profile.allowOneOverMaxAttempt && Number(attemptCount) === Number(maxAttempts) + 1);
  if (!attemptsMatch || Number(maxAttempts) < 1) {
    return { eligible: false, reasonCode: "PUBLICATION_ATTEMPT_STATE_INVALID" };
  }
  return { eligible: true, reasonCode: profile.reasonCode, recoveryMode: profile.recoveryMode };
}

export function getPublicationTerminalRecoveryEligibility({
  workflowStatus = "",
  ...publicationRecovery
} = {}) {
  if (String(workflowStatus || "") !== "manual_intervention_required") {
    return { eligible: false, reasonCode: "PUBLICATION_TERMINAL_OVERRIDE_NOT_REQUIRED" };
  }
  const recovery = getPublicationJobRecoveryEligibility(publicationRecovery);
  if (!recovery.eligible) return recovery;
  return {
    eligible: true,
    reasonCode: "PUBLICATION_MANUAL_INTERVENTION_TERMINAL_OVERRIDE"
  };
}

function buildWorkflowJobTimeline(target) {
  return buildPregameTimeline({
    gameId: target.gameId,
    internalGameId: target.internalGameId,
    date: target.date,
    startAt: new Date(target.startAt),
    homeTeam: target.homeTeam,
    awayTeam: target.awayTeam,
    gameCode: target.gameCode,
    status: target.status
  });
}

async function recordWorkflowJobEvent(db, { eventType, status, internalGameId, job, now, errorCode = "", metadata = {}, source = "cron" }) {
  await recordWorkflowLog(db, {
    eventType,
    status,
    gameId: String(job?.legacyGameId || internalGameId || ""),
    occurredAt: now,
    message: {
      workflow_job_created: "試合進行ジョブを作成しました。",
      workflow_job_claimed: "試合進行ジョブを実行開始しました。",
      workflow_job_succeeded: "試合進行ジョブが完了しました。",
      workflow_job_retry: "試合進行ジョブを再試行待ちにしました。",
      workflow_job_permanently_failed: "試合進行ジョブが恒久失敗になりました。",
      workflow_job_recovered: "停止していた試合進行ジョブを再評価待ちに戻しました。",
      probable_starter_job_plan_observed: "予告先発jobのslot競合を検出しました。",
      probable_starter_job_claimed: "予告先発jobを実行開始しました。",
       roster_job_created: "ロースターjobを作成しました。",
       roster_job_plan_observed: "ロースターjobのslot状態を確認しました。",
       roster_job_claimed: "ロースターjobを実行開始しました。",
       v3_job_created: "V3自動処理jobを作成しました。",
       v3_job_plan_observed: "V3自動処理jobのslot状態を確認しました。",
       v3_job_claimed: "V3自動処理jobを実行開始しました。",
      scoring_workflow_reconciled: "保存済みの採点結果に試合進行状態を整合しました。",
      publication_workflow_reconciled: "保存済みの公開結果へ試合進行状態を整合しました。",
      workflow_internal_id_unresolved: "内部試合IDを解決できないためジョブを作成しませんでした。"
    }[eventType] || "試合進行ジョブの状態が更新されました。",
    errorCode,
    metadata: { internalGameId, jobType: job?.job_type || WORKFLOW_PROBABLE_STARTER_JOB_TYPE, jobId: job?.id || null, ...metadata },
    source
  });
}

async function getPausedWorkflowGameIds(db) {
  try {
    const result = await db.prepare(
      "SELECT game_id FROM game_workflow_controls WHERE automation_paused = 1"
    ).all();
    return new Set((result?.results || []).map((row) => String(row.game_id || "")).filter(Boolean));
  } catch (error) {
    // 新しい制御テーブルが未適用でも、既存のCron自動処理は止めません。
    console.warn(`[GAME_WORKFLOW] step=all action=control_read status=failed code=${isPregameSchemaError(error) ? "GAME_WORKFLOW_CONTROL_SCHEMA_NOT_READY" : "GAME_WORKFLOW_CONTROL_READ_FAILED"}`);
    return new Set();
  }
}

export function summarizeGameAutomationRun({ date = "", scheduleSync = "skipped", workflows = [], shared = {} } = {}) {
  const safeWorkflows = Array.isArray(workflows) ? workflows : [];
  const notice = shared.notice || {};
  const lineup = shared.lineup || {};
  const scoring = shared.scoring || {};
  const publishing = shared.publishing || {};
  const noticeExecuted = notice.due && !notice.skipped ? 1 : 0;
  const noticeFailed = notice.status === "error" ? 1 : 0;
  const rosterFixed = Number(shared.notice?.rosterFixed || 0);
  const rosterFailed = Number(shared.notice?.rosterFailed || 0);
  const lineupCaptured = Number(lineup.lineupCaptured || 0);
  const lineupFailed = Number(lineup.lineupFailed || 0);
  const scoringProcessed = Number(scoring.processed || 0);
  const scoringSucceeded = Number(scoring.succeeded || 0);
  const scoringFailed = Number(scoring.failed || 0);
  const published = Number(publishing.published || 0);
  const publishingFailed = Number(publishing.failed || 0);
  const cancelled = safeWorkflows.filter((workflow) => workflow?.gameStatus === "cancelled").length;
  const scheduleFailed = scheduleSync === "failed" ? 1 : 0;
  const failed = scheduleFailed + noticeFailed + rosterFailed + lineupFailed + scoringFailed + publishingFailed + Number(shared.errors || 0);
  const executed = noticeExecuted + rosterFixed + lineupCaptured + lineupFailed + scoringProcessed + published + publishingFailed;
  const succeeded = (noticeExecuted - noticeFailed) + rosterFixed + lineupCaptured + scoringSucceeded + published;
  const retryWait = Number(lineup.lineupRetryWait || 0);
  let status = "idle";
  if (failed > 0 && succeeded > 0) status = "partial_failure";
  else if (failed > 0) status = "failed";
  else if (safeWorkflows.length === 0) status = "no_games";
  else if (cancelled === safeWorkflows.length) status = "cancelled";
  else if (executed > 0) status = "success";

  return {
    date: String(date || ""),
    scheduleSync: ["success_changed", "success_no_change", "skipped", "failed"].includes(scheduleSync) ? scheduleSync : "failed",
    games: safeWorkflows.length,
    executed,
    succeeded: Math.max(0, succeeded),
    retryWait,
    failed,
    cancelled,
    status
  };
}

function shouldLogGameAutomationSummary(summary) {
  return !["skipped", "success_no_change"].includes(summary.scheduleSync)
    || summary.executed > 0
    || summary.retryWait > 0
    || summary.failed > 0
    || summary.cancelled > 0;
}

function logGameAutomationSummary(summary) {
  if (!shouldLogGameAutomationSummary(summary)) return;
  const message = `[GAME_AUTOMATION] date=${summary.date || "unknown"} scheduleSync=${summary.scheduleSync} games=${summary.games} executed=${summary.executed} succeeded=${summary.succeeded} retryWait=${summary.retryWait} failed=${summary.failed} cancelled=${summary.cancelled} status=${summary.status}`;
  if (summary.failed > 0) console.warn(message);
  else console.log(message);
}

function logCancelledGameWorkflows(workflows, scheduleSync) {
  if (["skipped", "success_no_change"].includes(scheduleSync)) return;
  for (const workflow of Array.isArray(workflows) ? workflows : []) {
    if (workflow?.gameStatus === "cancelled") {
      console.log(`[GAME_WORKFLOW] gameId=${workflow.gameId} step=all action=skipped status=cancelled`);
    }
  }
}

function runGameWorkflow(timeline, now, paused = false) {
  const cancelled = isScheduleGameUnavailable(timeline.game);
  const steps = GAME_WORKFLOW_STEPS.map((step) => {
    if (cancelled) return { id: step.id, status: "cancelled", action: "skipped" };
    if (paused) return { id: step.id, status: "paused", action: "skipped" };
    if (step.trigger === "lineup_confirmed") {
      return { id: step.id, status: "waiting_for_lineup", action: "evaluated" };
    }
    const dueAt = new Date(timeline.startAt.getTime() + step.offsetMinutes * 60 * 1000);
    return { id: step.id, status: now < dueAt ? "not_due" : "ready", action: now < dueAt ? "skipped" : "evaluated", dueAt: dueAt.toISOString() };
  });
  return { gameId: timeline.gameId, gameStatus: cancelled ? "cancelled" : paused ? "paused" : "scheduled", source: timeline.gameCode ? "auto-detected" : "static", steps };
}

export function getAutomationScheduleDates(now = new Date(), lookaheadDays = AUTOMATION_SCHEDULE_LOOKAHEAD_DAYS) {
  const date = getJstDateString(now);
  if (!date) return [];
  const base = new Date(`${date}T00:00:00+09:00`);
  const count = Math.max(0, Number.parseInt(lookaheadDays, 10) || 0);
  return Array.from({ length: count + 1 }, (_, offset) => getJstDateString(new Date(base.getTime() + offset * 24 * 60 * 60 * 1000)));
}

export function getFutureScheduleSyncPlan(now = new Date(), futureGames = 0) {
  const current = now instanceof Date ? now : new Date(now);
  const start = getJstDateString(current);
  const count = Math.max(0, Number(futureGames) || 0);
  if (!start) return { shouldFetch: false, dates: [], fetchRangeStart: "", fetchRangeEnd: "", skipReason: "INVALID_NOW" };
  if (count >= AUTOMATION_MIN_FUTURE_GAMES) {
    return {
      shouldFetch: false,
      dates: [],
      fetchRangeStart: start,
      fetchRangeEnd: start,
      skipReason: "FUTURE_GAMES_SUFFICIENT"
    };
  }
  const dates = getAutomationScheduleDates(current, AUTOMATION_FUTURE_SCHEDULE_LOOKAHEAD_DAYS);
  return {
    shouldFetch: true,
    dates,
    fetchRangeStart: dates[0] || start,
    fetchRangeEnd: dates[dates.length - 1] || start,
    skipReason: "FUTURE_GAMES_BELOW_MINIMUM"
  };
}

export function classifyScheduleSyncResults(results = []) {
  const statuses = (Array.isArray(results) ? results : []).map((result) => result?.status);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("success_changed")) return "success_changed";
  if (statuses.includes("success_no_change")) return "success_no_change";
  return "skipped";
}

async function syncTodayFightersSchedule(env, now) {
  const dates = getAutomationScheduleDates(now);
  if (!dates.length) return { status: "skipped", games: [] };
  const results = [];
  for (const date of dates) {
    try {
      results.push(await syncFightersScheduleForDate(env, date, now));
    } catch (error) {
      results.push({ status: "failed", date, errorCode: error?.code || "SCHEDULE_SYNC_FAILED" });
      try {
        await env.AUTH_DB.prepare(
          "UPDATE game_schedule_check_state SET last_error_code = ?1, updated_at = ?2 WHERE schedule_date = ?3"
        ).bind(error?.code || "SCHEDULE_SYNC_FAILED", now.toISOString(), date).run();
      } catch (stateError) {
        console.warn(`[GAME_DETECTION] date=${date} state=failed code=${stateError?.code || "SCHEDULE_SYNC_STATE_WRITE_FAILED"}`);
      }
      console.warn(`[GAME_DETECTION] date=${date} team=fighters status=failed code=${error?.code || "SCHEDULE_SYNC_FAILED"}`);
    }
  }
  const rows = await loadDetectedScheduleGames(env.AUTH_DB, dates);
  setDetectedScheduleGames(rows);
  return {
    status: classifyScheduleSyncResults(results),
    games: rows,
    dates,
    results,
    failedDates: results.filter((result) => result?.status === "failed").map((result) => result.date).filter(Boolean)
  };
}

async function syncFightersScheduleForDate(env, date, now) {
  const state = await env.AUTH_DB.prepare("SELECT next_check_at FROM game_schedule_check_state WHERE schedule_date = ?1 LIMIT 1").bind(date).first();
  if (!state?.next_check_at || new Date(state.next_check_at) <= now) {
    const payload = await fetchNpbWorkerJson(env, { mode: "schedule", date });
    if (!Array.isArray(payload.games)) throw createPregameError("SCHEDULE_RESPONSE_INVALID", "NPB日程レスポンスが不正です。");
    const registry = await getGameIdentityRegistryAvailability(env.AUTH_DB);
    const existingResult = await env.AUTH_DB.prepare(
      `SELECT game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, venue, game_status${registry.scheduleColumnAvailable ? ", internal_game_id" : ""}
         FROM detected_game_schedule WHERE game_date = ?1 ORDER BY updated_at DESC`
    ).bind(date).all();
    const existingByIdentity = new Map();
    const existingRowsByIdentity = new Map();
    for (const row of existingResult.results || []) {
      const key = createScheduleIdentityKey({
        date: row.game_date,
        startAt: row.start_at,
        homeTeam: row.home_team,
        awayTeam: row.away_team
      });
      if (key) existingRowsByIdentity.set(key, [...(existingRowsByIdentity.get(key) || []), row]);
      if (!key || !existingByIdentity.has(key) || shouldPreferDetectedScheduleRow(row, existingByIdentity.get(key))) {
        existingByIdentity.set(key, row);
      }
    }
    const normalizedGames = payload.games.map((game) => {
      const startAt = new Date(`${date}T${game?.startTime}:00+09:00`);
      if (!game?.gameId || !game?.homeTeam || !game?.awayTeam || Number.isNaN(startAt.getTime())) {
        throw createPregameError("SCHEDULE_RESPONSE_INVALID", "NPB日程レスポンスに必須項目がありません。");
      }
      const identityKey = createScheduleIdentityKey({ date, startAt, homeTeam: game.homeTeam, awayTeam: game.awayTeam });
      return {
        game,
        startAt,
        identityKey,
        existingRow: existingByIdentity.get(identityKey) || null,
        existingCandidates: existingRowsByIdentity.get(identityKey) || [],
        sourceGameKey: `${date}:${game.homeTeam}:${game.awayTeam}:${game.startTime}`,
        npbGameCode: normalizeNpbGameCode(game.gameCode),
        npbGameUrl: String(game.npbGameUrl || "").trim() || buildNpbGameUrl(date, game.gameCode),
        gameStatus: game.status === "cancelled" ? "cancelled" : "scheduled"
      };
    });
    const changed = await hasScheduleDataChanged(env.AUTH_DB, date, normalizedGames);
    const changedItems = normalizedGames.filter(({ game, startAt, identityKey, gameStatus, existingRow }) => {
      const current = existingByIdentity.get(identityKey);
      return !current
        || String(current.start_at || "") !== startAt.toISOString()
        || String(current.home_team || "") !== String(game.homeTeam || "")
        || String(current.away_team || "") !== String(game.awayTeam || "")
        || String(current.game_code || "") !== String(game.gameCode || "")
        || String(current.venue || "") !== String(game.venue || "")
        || String(current.game_status || "") !== gameStatus;
    });
    const statements = [];
    for (const item of normalizedGames) {
      const { game, startAt, sourceGameKey, npbGameCode, npbGameUrl, gameStatus, existingRow, existingCandidates } = item;
      const internalGameId = await resolveScheduleInternalGameId(env.AUTH_DB, registry, {
        date,
        startAt,
        game,
        sourceGameKey,
        npbGameCode,
        npbGameUrl,
        gameStatus,
        existingRow,
        existingCandidates,
        now
      });
      if (existingRow) {
        // 公式gameCodeが後から得られても、予想・採点に紐づく既存game_idは維持します。
        statements.push(env.AUTH_DB.prepare(
          `UPDATE detected_game_schedule
              SET source_game_key = ?1, start_at = ?2, home_team = ?3, away_team = ?4, game_code = ?5,
                  venue = ?6, game_status = ?7, schedule_checked_at = ?8, updated_at = ?8${registry.scheduleColumnAvailable ? ", internal_game_id = COALESCE(?9, internal_game_id)" : ""}
            WHERE game_id = ?${registry.scheduleColumnAvailable ? 10 : 9}`
        ).bind(...(registry.scheduleColumnAvailable
          ? [sourceGameKey, startAt.toISOString(), game.homeTeam, game.awayTeam, game.gameCode || null, game.venue || null, gameStatus, now.toISOString(), internalGameId, existingRow.game_id]
          : [sourceGameKey, startAt.toISOString(), game.homeTeam, game.awayTeam, game.gameCode || null, game.venue || null, gameStatus, now.toISOString(), existingRow.game_id])));
      } else {
        statements.push(env.AUTH_DB.prepare(
          `INSERT INTO detected_game_schedule (game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, venue, game_status, detected_at, schedule_checked_at, created_at, updated_at${registry.scheduleColumnAvailable ? ", internal_game_id" : ""})
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10, ?10${registry.scheduleColumnAvailable ? ", ?11" : ""})
           ON CONFLICT(source_game_key) DO UPDATE SET start_at=excluded.start_at, venue=excluded.venue, game_status=excluded.game_status, schedule_checked_at=excluded.schedule_checked_at, updated_at=excluded.updated_at${registry.scheduleColumnAvailable ? ", internal_game_id=COALESCE(excluded.internal_game_id, detected_game_schedule.internal_game_id)" : ""}`
        ).bind(...(registry.scheduleColumnAvailable
          ? [game.gameId, sourceGameKey, date, startAt.toISOString(), game.homeTeam, game.awayTeam, game.gameCode || null, game.venue || null, gameStatus, now.toISOString(), internalGameId]
          : [game.gameId, sourceGameKey, date, startAt.toISOString(), game.homeTeam, game.awayTeam, game.gameCode || null, game.venue || null, gameStatus, now.toISOString()])));
      }
    }
    const nextCheck = new Date(now.getTime() + AUTOMATION_SCHEDULE_SYNC_INTERVAL_MS).toISOString();
    statements.push(env.AUTH_DB.prepare(
      `INSERT INTO game_schedule_check_state (schedule_date, next_check_at, last_checked_at, last_error_code, updated_at)
       VALUES (?1, ?2, ?3, NULL, ?3)
       ON CONFLICT(schedule_date) DO UPDATE SET next_check_at=excluded.next_check_at, last_checked_at=excluded.last_checked_at, last_error_code=NULL, updated_at=excluded.updated_at`
    ).bind(date, nextCheck, now.toISOString()));
    if (statements.length) await env.AUTH_DB.batch(statements);
    await backfillUniqueDetectedScheduleInternalGames(env.AUTH_DB, date, registry, now);
    console.log(`[GAME_DETECTION] date=${date} team=fighters gamesFound=${payload.games.length} status=success`);
    return {
      status: changed ? "success_changed" : "success_no_change",
      date,
      gameCount: payload.games.length,
      gamesInserted: normalizedGames.filter(({ existingRow }) => !existingRow).length,
      gamesUpdated: changedItems.filter(({ existingRow }) => Boolean(existingRow)).length
    };
  }
  return { status: "skipped", date };
}

async function countFutureFightersGames(db, now) {
  const current = now instanceof Date ? now : new Date(now);
  const todayJst = getJstDateString(current);
  if (!todayJst) return 0;
  const result = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM games
      WHERE internal_game_id IS NOT NULL AND internal_game_id <> ''
        AND game_date > ?1
        AND (is_active IS NULL OR is_active = 1)
        AND (deleted_at IS NULL OR deleted_at = '')
        AND (game_status IS NULL OR game_status NOT IN ('cancelled', 'canceled', 'postponed', 'service_unavailable'))
        AND (LOWER(home_team) = 'fighters' OR LOWER(away_team) = 'fighters')`
  ).bind(todayJst).first();
  return Number(result?.count || 0);
}

async function ensureFutureFightersSchedule(env, now) {
  const futureGamesBefore = await countFutureFightersGames(env.AUTH_DB, now);
  const initialPlan = getFutureScheduleSyncPlan(now, futureGamesBefore);
  if (!initialPlan.shouldFetch) {
    return {
      status: "skipped",
      syncNeeded: false,
      futureGamesBefore,
      futureGamesAfter: futureGamesBefore,
      futureGamesTarget: AUTOMATION_MIN_FUTURE_GAMES,
      gamesFetched: 0,
      gamesInserted: 0,
      gamesUpdated: 0,
      fetchRangeStart: initialPlan.fetchRangeStart,
      fetchRangeEnd: initialPlan.fetchRangeEnd,
      expandedTo30Days: false,
      skipReason: initialPlan.skipReason,
      errorCode: null,
      lastScheduleSyncAt: now.toISOString(),
      results: []
    };
  }

  const dates = getAutomationScheduleDates(now, AUTOMATION_SCHEDULE_MAX_LOOKAHEAD_DAYS);
  const results = [];
  let futureGamesAfter = futureGamesBefore;
  let lastDate = "";
  for (const date of dates) {
    lastDate = date;
    try {
      const result = await syncFightersScheduleForDate(env, date, now);
      results.push(result);
      futureGamesAfter = await countFutureFightersGames(env.AUTH_DB, now);
      if (futureGamesAfter >= AUTOMATION_MIN_FUTURE_GAMES) break;
    } catch (error) {
      results.push({ status: "failed", date, errorCode: error?.code || "SCHEDULE_SYNC_FAILED" });
      console.warn(`[GAME_DETECTION] date=${date} team=fighters status=failed code=${error?.code || "SCHEDULE_SYNC_FAILED"}`);
    }
  }

  const gamesFetched = results.reduce((total, result) => total + Number(result?.gameCount || 0), 0);
  const gamesInserted = results.reduce((total, result) => total + Number(result?.gamesInserted || 0), 0);
  const gamesUpdated = results.reduce((total, result) => total + Number(result?.gamesUpdated || 0), 0);
  const failed = results.some((result) => result?.status === "failed");
  const firstError = results.find((result) => result?.status === "failed");
  return {
    status: failed ? "partial_failure" : futureGamesAfter >= AUTOMATION_MIN_FUTURE_GAMES ? "success" : "insufficient_future_games",
    syncNeeded: true,
    futureGamesBefore,
    futureGamesAfter,
    futureGamesTarget: AUTOMATION_MIN_FUTURE_GAMES,
    gamesFetched,
    gamesInserted,
    gamesUpdated,
    fetchRangeStart: dates[0] || "",
    fetchRangeEnd: lastDate || dates[dates.length - 1] || "",
    expandedTo30Days: Boolean(lastDate && initialPlan.fetchRangeEnd && lastDate > initialPlan.fetchRangeEnd),
    skipReason: futureGamesAfter >= AUTOMATION_MIN_FUTURE_GAMES ? "FUTURE_GAMES_BUFFER_FILLED" : "FUTURE_GAMES_BUFFER_NOT_REACHED",
    errorCode: firstError?.errorCode || null,
    lastScheduleSyncAt: now.toISOString(),
    results
  };
}

async function getGameIdentityRegistryAvailability(db) {
  try {
    const tables = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('games', 'game_identifiers', 'detected_game_schedule')"
    ).bind().all();
    const names = new Set((tables.results || []).map((row) => String(row.name || "")));
    if (!names.has("games") || !names.has("game_identifiers") || !names.has("detected_game_schedule")) {
      return { available: false, scheduleColumnAvailable: false };
    }
    const columns = await db.prepare("PRAGMA table_info(detected_game_schedule)").bind().all();
    const scheduleColumnAvailable = (columns.results || []).some((column) => String(column.name || "") === "internal_game_id");
    return { available: scheduleColumnAvailable, scheduleColumnAvailable };
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
    console.warn(`[GAME_IDENTITY_REGISTRY] status=unavailable code=${error?.code || "GAME_IDENTITY_REGISTRY_SCHEMA_NOT_READY"}`);
    return { available: false, scheduleColumnAvailable: false };
  }
}

async function getInternalGameIdStorageAvailability(db, tables) {
  try {
    const availability = {};
    for (const table of tables) {
      const columns = await db.prepare(`PRAGMA table_info(${table})`).bind().all();
      availability[table] = (columns.results || []).some((column) => String(column.name || "") === "internal_game_id");
    }
    return availability;
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
    return Object.fromEntries(tables.map((table) => [table, false]));
  }
}

async function requireInternalGameIdForWrite(db, { table, gameId, internalGameId = "" } = {}) {
  const storage = await getInternalGameIdStorageAvailability(db, [table]);
  if (!storage[table]) {
    if (["game_roster_snapshots", "game_pregame_automation"].includes(table)) {
      const error = createPregameError("INTERNAL_GAME_REGISTRY_NOT_READY", "内部試合IDを保存できるスキーマが利用できないため、自動処理を停止しました。", { httpStatus: 503 });
      error.gameId = String(gameId || "");
      error.table = table;
      throw error;
    }
    return { internalGameId: "", schemaReady: false };
  }
  const supplied = String(internalGameId || "").trim();
  if (INTERNAL_GAME_ID_PATTERN.test(supplied)) return { internalGameId: supplied, schemaReady: true };
  const reference = await resolveApiGameReference(db, gameId);
  const resolved = String(reference?.metadata?.internalGameId || "").trim();
  if (reference?.ok && INTERNAL_GAME_ID_PATTERN.test(resolved)) return { internalGameId: resolved, schemaReady: true };
  const error = createPregameError("INTERNAL_GAME_ID_REQUIRED", "内部試合IDを解決できないため保存を停止しました。", { httpStatus: 409 });
  error.gameId = String(gameId || "");
  error.table = table;
  throw error;
}

async function linkLegacyGameRowsToInternalGameId(db, internalGameId, legacyGameId) {
  const internal = String(internalGameId || "");
  const legacy = String(legacyGameId || "");
  if (!INTERNAL_GAME_ID_PATTERN.test(internal) || !legacy || legacy.startsWith("day-")) return;
  const tables = ["predictions", "probable_starters", "game_roster_snapshots", "game_pregame_automation", "game_lineups", "ranking_games", "game_rescore_jobs"];
  const availability = await getInternalGameIdStorageAvailability(db, tables);
  const statements = tables
    .filter((table) => availability[table])
    .map((table) => db.prepare(`UPDATE ${table} SET internal_game_id = ?1 WHERE game_id = ?2 AND (internal_game_id IS NULL OR internal_game_id = '')`).bind(internal, legacy));
  if (statements.length) await db.batch(statements);
}

async function resolveScheduleInternalGameId(db, registry, { date, startAt, game, sourceGameKey, npbGameCode = "", npbGameUrl = "", gameStatus, existingRow, existingCandidates, now }) {
  if (!registry.available) {
    throw createPregameError("INTERNAL_GAME_REGISTRY_NOT_READY", "内部試合IDレジストリが利用できないため、日程を登録できません。", { httpStatus: 503 });
  }
  if (existingCandidates.length > 1) {
    throw createPregameError("INTERNAL_GAME_IDENTITY_AMBIGUOUS", "同一日程に複数の試合候補があるため、内部試合IDを決定できません。", { httpStatus: 409 });
  }
  const gameIds = [existingRow?.game_id, game?.gameId].filter(Boolean);
  const identifiers = gameIds.flatMap((gameId) => createScheduleGameIdentifiers({
    gameId,
    gameCode: game?.gameCode || "",
    sourceGameKey
  }));
  try {
    const result = await getOrCreateInternalGame(db, {
      game: {
        gameDate: date,
        startTime: startAt.toISOString(),
        homeTeam: game?.homeTeam,
        awayTeam: game?.awayTeam,
        gameStatus,
        npbGameCode,
        npbGameUrl,
        sourceScheduleKey: sourceGameKey,
        npbIdentityStatus: npbGameCode ? "resolved" : "unresolved",
        npbIdentitySource: "npb_schedule_sync"
      },
      identifiers,
      allowCreate: true,
      now
    });
    if (result.status !== "resolved" || !INTERNAL_GAME_ID_PATTERN.test(String(result.internalGameId || ""))) {
      const error = createPregameError(
        result.code || "INTERNAL_GAME_REGISTRY_UNRESOLVED",
        "日程を内部試合IDへ解決できないため、自動処理対象へ登録できません。",
        { httpStatus: 409 }
      );
      error.gameId = String(existingRow?.game_id || game?.gameId || "");
      error.sourceGameKey = sourceGameKey;
      throw error;
    }
    return result.internalGameId;
  } catch (error) {
    console.warn(`[GAME_IDENTITY_REGISTRY] status=unresolved gameId=${String(existingRow?.game_id || game?.gameId || "")} code=${error?.code || "GAME_IDENTITY_REGISTRY_WRITE_FAILED"}`);
    throw error;
  }
}

async function backfillUniqueDetectedScheduleInternalGames(db, date, registry, now) {
  if (!registry.available || !registry.scheduleColumnAvailable) return;
  const result = await db.prepare(
    `SELECT game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, game_status, internal_game_id
       FROM detected_game_schedule
      WHERE game_date = ?1 AND (internal_game_id IS NULL OR internal_game_id = '')`
  ).bind(date).all();
  const rowsByIdentity = new Map();
  for (const row of result.results || []) {
    const identityKey = createScheduleIdentityKey({ date: row.game_date, startAt: row.start_at, homeTeam: row.home_team, awayTeam: row.away_team });
    if (!identityKey) continue;
    rowsByIdentity.set(identityKey, [...(rowsByIdentity.get(identityKey) || []), row]);
  }
  for (const rows of rowsByIdentity.values()) {
    if (rows.length !== 1) continue;
    const row = rows[0];
    try {
      const registration = await getOrCreateInternalGame(db, {
        game: {
          gameDate: row.game_date,
          startTime: row.start_at,
          homeTeam: row.home_team,
          awayTeam: row.away_team,
          gameStatus: row.game_status,
          npbGameCode: normalizeNpbGameCode(row.game_code),
          npbGameUrl: buildNpbGameUrl(row.game_date, row.game_code),
          sourceScheduleKey: row.source_game_key,
          npbIdentityStatus: normalizeNpbGameCode(row.game_code) ? "resolved" : "unresolved",
          npbIdentitySource: "npb_schedule_backfill"
        },
        identifiers: createScheduleGameIdentifiers({
          gameId: row.game_id,
          gameCode: row.game_code,
          sourceGameKey: row.source_game_key
        }),
        allowCreate: true,
        now
      });
      if (registration.status === "resolved") {
        await db.prepare(
          "UPDATE detected_game_schedule SET internal_game_id = ?1, updated_at = ?2 WHERE game_id = ?3 AND (internal_game_id IS NULL OR internal_game_id = '')"
        ).bind(registration.internalGameId, now.toISOString(), row.game_id).run();
      }
    } catch (error) {
      console.warn(`[GAME_IDENTITY_REGISTRY] status=backfill_skipped gameId=${String(row.game_id || "")} code=${error?.code || "GAME_IDENTITY_REGISTRY_BACKFILL_FAILED"}`);
    }
  }
}

function normalizeNpbGameCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+$/.test(normalized) ? normalized : "";
}

function buildNpbGameUrl(date, gameCode) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  const normalizedCode = normalizeNpbGameCode(gameCode);
  if (!match || !normalizedCode) return "";
  return `https://npb.jp/scores/${match[1]}/${match[2]}${match[3]}/${normalizedCode}/`;
}

function getScheduleGameCode(game) {
  return normalizeNpbGameCode(game?.gameCode || game?.game_code || game?.npbGameCode || game?.npb_game_code)
    || /\/scores\/\d{4}\/\d{4}\/([a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+)\//i.exec(String(game?.npbGameUrl || game?.npbScoreUrl || game?.gameUrl || ""))?.[1]?.toLowerCase()
    || "";
}

export function mergeNpbScheduleCandidates(scheduleGames, fallbackGames, date, target = null) {
  const merged = Array.isArray(scheduleGames) ? scheduleGames.map((game) => ({ ...game, resolutionSource: "npb_schedule" })) : [];
  const normalizedPrimary = merged.map((game) => normalizeNpbScheduleCandidate(game, date));
  const staticCandidates = target ? getStaticNpbTargetCandidates(fallbackGames, target) : (Array.isArray(fallbackGames) ? fallbackGames : []);
  for (const fallback of staticCandidates) {
    const gameCode = getScheduleGameCode(fallback);
    if (!gameCode) continue;
    const fallbackCandidate = normalizeNpbScheduleCandidate({
      ...fallback,
      gameCode,
      npbGameUrl: fallback.npbGameUrl || fallback.npbScoreUrl,
      resolutionSource: "static_schedule"
    }, date);
    if (fallbackCandidate.candidateDateJst !== String(date || "")) continue;
    const matchingIndex = normalizedPrimary.findIndex((candidate) => candidate.normalizedHomeTeam === fallbackCandidate.normalizedHomeTeam
      && candidate.normalizedAwayTeam === fallbackCandidate.normalizedAwayTeam
      && candidate.candidateStart.getTime() === fallbackCandidate.candidateStart.getTime());
    if (matchingIndex < 0) {
      merged.push({ ...fallback, gameCode, npbGameUrl: fallback.npbGameUrl || fallback.npbScoreUrl, resolutionSource: "static_schedule" });
      normalizedPrimary.push(fallbackCandidate);
      continue;
    }
    const existingCode = getScheduleGameCode(merged[matchingIndex]);
    if (!existingCode) {
      merged[matchingIndex] = {
        ...merged[matchingIndex],
        gameCode,
        npbGameUrl: fallback.npbGameUrl || fallback.npbScoreUrl || "",
        resolutionSource: fallback.resolutionSource === "static_schedule_enrichment"
          ? "static_schedule_enrichment"
          : "npb_schedule+static_schedule"
      };
      normalizedPrimary[matchingIndex] = normalizeNpbScheduleCandidate(merged[matchingIndex], date);
    } else if (existingCode !== gameCode) {
      merged.push({ ...fallback, gameCode, npbGameUrl: fallback.npbGameUrl || fallback.npbScoreUrl, resolutionSource: "static_schedule" });
      normalizedPrimary.push(fallbackCandidate);
    }
  }
  return merged;
}

function getStaticNpbTargetCandidates(fallbackGames, current) {
  const targetDate = String(current?.game_date || "");
  const targetStart = new Date(current?.start_time || "");
  const targetHome = normalizeScheduleTeamCode(current?.home_team);
  const targetAway = normalizeScheduleTeamCode(current?.away_team);
  if (!targetDate || Number.isNaN(targetStart.getTime()) || !targetHome || !targetAway) return [];
  return (Array.isArray(fallbackGames) ? fallbackGames : []).filter((game) => {
    const candidate = normalizeNpbScheduleCandidate(game, targetDate);
    return candidate.candidateDateJst === targetDate
      && ((candidate.normalizedHomeTeam === targetHome && candidate.normalizedAwayTeam === targetAway)
        || (candidate.normalizedHomeTeam === targetAway && candidate.normalizedAwayTeam === targetHome))
      && !Number.isNaN(candidate.candidateStart.getTime())
      && candidate.candidateStart.getTime() === targetStart.getTime();
  }).map((game) => ({
    ...game,
    // Static records expose explicit homeTeam/awayTeam fields. Preserve the DB target orientation when
    // a same-time candidate has the same teams in reverse order, and use the static row only for identity enrichment.
    homeTeam: normalizeScheduleTeamCode(game?.homeTeam) === targetAway && normalizeScheduleTeamCode(game?.awayTeam) === targetHome
      ? current.home_team
      : game.homeTeam,
    awayTeam: normalizeScheduleTeamCode(game?.homeTeam) === targetAway && normalizeScheduleTeamCode(game?.awayTeam) === targetHome
      ? current.away_team
      : game.awayTeam,
    gameCode: getScheduleGameCode(game),
    npbGameUrl: game.npbGameUrl || game.npbScoreUrl || "",
    resolutionSource: normalizeScheduleTeamCode(game?.homeTeam) === targetAway && normalizeScheduleTeamCode(game?.awayTeam) === targetHome
      ? "static_schedule_enrichment"
      : "static_schedule"
  }));
}

const NPB_SCHEDULE_TIME_TOLERANCE_MS = 30 * 60 * 1000;

function parseNpbScheduleStartAt(date, value) {
  const raw = String(value || "").trim();
  if (/^\d{2}:\d{2}(?::\d{2})?$/.test(raw)) {
    return new Date(`${date}T${raw.length === 5 ? `${raw}:00` : raw}+09:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(raw)) {
    return new Date(`${raw}+09:00`);
  }
  return new Date(raw);
}

function formatJstTime(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(date);
}

function firstNpbValue(game, keys) {
  for (const key of keys) {
    const value = game?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return "";
}

function normalizeNpbScheduleCandidate(game, fallbackDate) {
  const rawHomeTeam = String(firstNpbValue(game, ["homeTeam", "home_team", "home", "homeTeamId"]) || "").trim();
  const rawAwayTeam = String(firstNpbValue(game, ["awayTeam", "away_team", "away", "awayTeamId"]) || "").trim();
  const normalizedHomeTeam = normalizeScheduleTeamCode(rawHomeTeam);
  const normalizedAwayTeam = normalizeScheduleTeamCode(rawAwayTeam);
  const rawStartTime = firstNpbValue(game, ["startTime", "start_time", "startAt", "start_at", "time"]);
  const explicitDate = String(firstNpbValue(game, ["gameDate", "game_date", "date"]) || "").trim();
  const candidateDate = /^\d{4}-\d{2}-\d{2}$/.test(explicitDate) ? explicitDate : fallbackDate;
  const candidateStart = parseNpbScheduleStartAt(candidateDate, rawStartTime);
  const candidateDateJst = getJstDateString(candidateStart) || explicitDate;
  const gameCode = normalizeNpbGameCode(firstNpbValue(game, ["gameCode", "game_code", "npbGameCode", "npb_game_code"]));
  const candidateStadium = String(firstNpbValue(game, ["stadium", "venue"]) || "").trim();
  return {
    rawHomeTeam,
    normalizedHomeTeam,
    rawAwayTeam,
    normalizedAwayTeam,
    rawDate: explicitDate,
    rawStartTime: String(rawStartTime || "").trim(),
    normalizedStartTime: formatJstTime(candidateStart),
    candidateStart,
    candidateDateJst,
    candidateStadium,
    gameCode,
    gameUrl: String(firstNpbValue(game, ["npbGameUrl", "gameUrl", "game_url"]) || "").trim(),
    resolutionSource: String(game?.resolutionSource || "npb_schedule"),
    rejectionReasons: [],
    game
  };
}

function addRejectionReason(counts, reason) {
  counts[reason] = (counts[reason] || 0) + 1;
}

function serializeNpbCandidate(candidate) {
  return {
    source: candidate.resolutionSource,
    rawDate: candidate.rawDate,
    normalizedDate: candidate.candidateDateJst,
    rawHome: candidate.rawHomeTeam,
    rawHomeTeam: candidate.rawHomeTeam,
    normalizedHome: candidate.normalizedHomeTeam,
    normalizedHomeTeam: candidate.normalizedHomeTeam,
    rawAway: candidate.rawAwayTeam,
    rawAwayTeam: candidate.rawAwayTeam,
    normalizedAway: candidate.normalizedAwayTeam,
    normalizedAwayTeam: candidate.normalizedAwayTeam,
    rawStartTime: candidate.rawStartTime,
    startTime: candidate.rawStartTime,
    normalizedStartTime: candidate.normalizedStartTime,
    gameCodePresent: Boolean(candidate.gameCode),
    urlPresent: Boolean(candidate.gameUrl),
    rejectionReasons: candidate.rejectionReasons || []
  };
}

function buildNpbIdentityDiagnostics({ targetDate, expectedStart, expectedHome, expectedAway, candidates, normalizedCandidateCount, rejectionReasonCounts, finalFailureCode = "", resolvedBy = "", matchCount = 0, rawCandidateCount = null, staticCandidateCount = 0 }) {
  return {
    targetGameDateJst: targetDate,
    targetHomeTeam: expectedHome,
    targetAwayTeam: expectedAway,
    targetStartTimeJst: formatJstTime(expectedStart),
    rawCandidateCount: rawCandidateCount === null ? candidates.length : rawCandidateCount,
    parsedCandidateCount: normalizedCandidateCount,
    staticCandidateCount,
    mergedCandidateCount: candidates.length,
    matchCount,
    rejectionReasonCounts,
    finalFailureCode,
    resolvedBy,
    candidates: candidates.slice(0, 10).map(serializeNpbCandidate)
  };
}

function createNpbResolutionDiagnostics(current, overrides = {}) {
  return {
    internalGameId: String(current?.internal_game_id || ""),
    fetchEndpoint: null,
    fetchHttpStatus: null,
    responseContentType: null,
    rawCandidateCount: 0,
    parsedCandidateCount: 0,
    staticCandidateCount: 0,
    mergedCandidateCount: 0,
    targetGameDateJst: String(current?.game_date || "") || null,
    targetHomeTeam: normalizeScheduleTeamCode(current?.home_team) || String(current?.home_team || ""),
    targetAwayTeam: normalizeScheduleTeamCode(current?.away_team) || String(current?.away_team || ""),
    targetStartTimeJst: formatJstTime(current?.start_time),
    matchCount: 0,
    rejectionReasonCounts: {},
    finalFailureCode: "",
    resolvedBy: "",
    candidates: [],
    ...overrides
  };
}

function getNpbIdentityRuntimeState(startAt, now = new Date()) {
  const start = new Date(startAt || "");
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(start.getTime()) || Number.isNaN(current.getTime())) return "manual_action_required";
  if (current < new Date(start.getTime() - 50 * 60 * 1000)) return "pending";
  if (current <= new Date(start.getTime() + 2 * 60 * 1000)) return "retry_wait";
  return "manual_action_required";
}

export function resolveNpbScheduleIdentity({ date, startAt, homeTeam, awayTeam, stadium = "", games = [] } = {}) {
  const expectedStart = startAt instanceof Date ? startAt : new Date(startAt || "");
  const expectedHome = normalizeScheduleTeamCode(homeTeam);
  const expectedAway = normalizeScheduleTeamCode(awayTeam);
  const suppliedDate = String(date || "").trim();
  const derivedDate = getJstDateString(expectedStart);
  const targetDate = derivedDate || suppliedDate;
  const sourceGames = Array.isArray(games) ? games : [];
  const normalized = sourceGames.map((game) => normalizeNpbScheduleCandidate(game, targetDate));
  const rejectionReasonCounts = {};
  const diagnostics = () => buildNpbIdentityDiagnostics({
    targetDate,
    expectedStart,
    expectedHome,
    expectedAway,
    candidates: normalized,
    normalizedCandidateCount: normalized.filter((candidate) => candidate.normalizedHomeTeam && candidate.normalizedAwayTeam && !Number.isNaN(candidate.candidateStart.getTime())).length,
    rejectionReasonCounts,
    finalFailureCode: "NPB_IDENTITY_NO_MATCH"
  });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate) || Number.isNaN(expectedStart.getTime()) || !expectedHome || !expectedAway) {
    addRejectionReason(rejectionReasonCounts, "target_metadata_invalid");
    return { status: "unresolved", code: "NPB_IDENTITY_UNRESOLVED", candidates: [], diagnostics: diagnostics() };
  }
  if (suppliedDate && suppliedDate !== targetDate) {
    addRejectionReason(rejectionReasonCounts, "target_date_mismatch");
    return { status: "unresolved", code: "NPB_IDENTITY_UNRESOLVED", candidates: [], diagnostics: diagnostics() };
  }

  const expectedStadium = String(stadium || "").trim();
  const sameDateAndTeams = [];
  for (const candidate of normalized) {
    if (!candidate.normalizedHomeTeam || !candidate.normalizedAwayTeam || Number.isNaN(candidate.candidateStart.getTime())) {
      candidate.rejectionReasons.push("CANDIDATE_METADATA_INVALID");
      addRejectionReason(rejectionReasonCounts, "candidate_metadata_invalid");
      continue;
    }
    if (candidate.candidateDateJst !== targetDate) {
      candidate.rejectionReasons.push("DATE_MISMATCH");
      addRejectionReason(rejectionReasonCounts, "date_mismatch");
      continue;
    }
    if (candidate.normalizedHomeTeam !== expectedHome || candidate.normalizedAwayTeam !== expectedAway) {
      if (candidate.normalizedHomeTeam === expectedAway && candidate.normalizedAwayTeam === expectedHome) {
        candidate.rejectionReasons.push("HOME_AWAY_REVERSED");
        addRejectionReason(rejectionReasonCounts, "reverse_home_away");
      } else {
        if (candidate.normalizedHomeTeam !== expectedHome) candidate.rejectionReasons.push("HOME_TEAM_MISMATCH");
        if (candidate.normalizedAwayTeam !== expectedAway) candidate.rejectionReasons.push("AWAY_TEAM_MISMATCH");
        addRejectionReason(rejectionReasonCounts, "team_mismatch");
      }
      continue;
    }
    sameDateAndTeams.push(candidate);
  }

  const exactMatches = sameDateAndTeams.filter((candidate) => {
    const sameStart = candidate.candidateStart.getTime() === expectedStart.getTime();
    const sameStadium = !expectedStadium || !candidate.candidateStadium || expectedStadium === candidate.candidateStadium;
    if (!sameStart) {
      candidate.rejectionReasons.push("START_TIME_MISMATCH");
      addRejectionReason(rejectionReasonCounts, "start_time_mismatch");
    }
    if (!sameStadium) {
      candidate.rejectionReasons.push("STADIUM_MISMATCH");
      addRejectionReason(rejectionReasonCounts, "stadium_mismatch");
    }
    return sameStart && sameStadium;
  });
  let matches = exactMatches;
  if (!matches.length && sameDateAndTeams.length) {
    const closeMatches = sameDateAndTeams.filter((candidate) => {
      const difference = Math.abs(candidate.candidateStart.getTime() - expectedStart.getTime());
      const sameStadium = !expectedStadium || !candidate.candidateStadium || expectedStadium === candidate.candidateStadium;
      return difference <= NPB_SCHEDULE_TIME_TOLERANCE_MS && sameStadium;
    });
    if (closeMatches.length === 1) {
      matches = closeMatches;
      addRejectionReason(rejectionReasonCounts, "start_time_tolerance_used");
    } else if (closeMatches.length > 1) {
      matches = closeMatches;
    }
  }
  if (matches.length > 1) {
    return { status: "conflict", code: "NPB_IDENTITY_CONFLICT", candidates: matches.map((candidate) => candidate.game), diagnostics: buildNpbIdentityDiagnostics({ targetDate, expectedStart, expectedHome, expectedAway, candidates: normalized, normalizedCandidateCount: normalized.length, rejectionReasonCounts, finalFailureCode: "NPB_IDENTITY_CONFLICT", matchCount: matches.length }) };
  }
  const match = matches[0];
  if (!match) {
    return { status: "unresolved", code: "NPB_IDENTITY_NO_MATCH", candidates: [], diagnostics: diagnostics() };
  }
  if (!match.gameCode) {
    match.rejectionReasons.push("GAME_CODE_MISSING");
    addRejectionReason(rejectionReasonCounts, "game_code_missing");
    return { status: "unresolved", code: "NPB_STATIC_SCHEDULE_NO_IDENTITY", candidates: [match.game], diagnostics: buildNpbIdentityDiagnostics({ targetDate, expectedStart, expectedHome, expectedAway, candidates: normalized, normalizedCandidateCount: normalized.length, rejectionReasonCounts, finalFailureCode: "NPB_STATIC_SCHEDULE_NO_IDENTITY", matchCount: 1 }) };
  }
  return {
    status: "resolved",
    code: "",
    gameCode: match.gameCode,
    gameUrl: match.gameUrl || buildNpbGameUrl(targetDate, match.gameCode),
    sourceScheduleKey: `${targetDate}:${expectedHome}:${expectedAway}:${formatJstTime(match.candidateStart)}`,
    source: "npb_schedule_resolve",
    candidates: [match.game],
    diagnostics: buildNpbIdentityDiagnostics({ targetDate, expectedStart, expectedHome, expectedAway, candidates: normalized, normalizedCandidateCount: normalized.length, rejectionReasonCounts, finalFailureCode: "", resolvedBy: match.resolutionSource, matchCount: 1 })
  };
}

export function classifyNpbScheduleFetchError(error) {
  const code = String(error?.code || "");
  const status = Number(error?.httpStatus || error?.upstreamStatus || 0);
  if (["NPB_RESPONSE_INVALID", "SCHEDULE_PARSE_FAILED"].includes(code)) return "NPB_SCHEDULE_RESPONSE_INVALID";
  if (status >= 400) return "NPB_SCHEDULE_HTTP_ERROR";
  return "NPB_SCHEDULE_FETCH_FAILED";
}

function createScheduleIdentityKey({ date = "", startAt = "", homeTeam = "", awayTeam = "" } = {}) {
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(start.getTime())) return "";
  return `${date}|${start.toISOString()}|${String(homeTeam).trim().toLowerCase()}|${String(awayTeam).trim().toLowerCase()}`;
}

function shouldPreferDetectedScheduleRow(candidate, current) {
  return Boolean(normalizeNpbGameCode(candidate?.game_code) && !normalizeNpbGameCode(current?.game_code));
}

async function hasScheduleDataChanged(db, date, games) {
  const result = await db.prepare(
    `SELECT source_game_key, game_id, start_at, home_team, away_team, game_code, venue, game_status
       FROM detected_game_schedule WHERE game_date = ?1`
  ).bind(date).all();
  const existing = new Map();
  for (const row of result.results || []) {
    const key = createScheduleIdentityKey({ date: row.game_date || date, startAt: row.start_at, homeTeam: row.home_team, awayTeam: row.away_team });
    if (key && (!existing.has(key) || shouldPreferDetectedScheduleRow(row, existing.get(key)))) existing.set(key, row);
  }
  return (Array.isArray(games) ? games : []).some(({ game, startAt, identityKey, gameStatus }) => {
    const row = existing.get(identityKey);
    return !row
      || String(row.start_at || "") !== startAt.toISOString()
      || String(row.home_team || "") !== String(game.homeTeam || "")
      || String(row.away_team || "") !== String(game.awayTeam || "")
      || String(row.game_code || "") !== String(game.gameCode || "")
      || String(row.venue || "") !== String(game.venue || "")
      || String(row.game_status || "") !== gameStatus;
  });
}

async function recordScheduleSyncOutcome(db, result, now) {
  try {
    const status = String(result?.status || "failed");
    if (status === "success_no_change" || status === "skipped") return;
    const date = getJstDateString(now);
    const gameCount = Array.isArray(result?.games) ? result.games.length : Number(result?.gameCount || 0);
    const metadata = { date, gameCount };
    if (status === "success_changed") {
      await recordWorkflowLog(db, {
        eventType: "schedule_sync",
        status: "success",
        occurredAt: now,
        message: "試合予定を同期しました。",
        metadata,
        source: "cron"
      });
      return;
    }
    const since = new Date(new Date(now).getTime() - 30 * 60 * 1000).toISOString();
    const recent = await db.prepare(
      `SELECT metadata FROM game_workflow_logs
         WHERE event_type = 'schedule_sync' AND status IN ('warning', 'error')
           AND error_code = ?1 AND occurred_at >= ?2
         ORDER BY occurred_at DESC LIMIT 50`
    ).bind("SCHEDULE_SYNC_FAILED", since).all();
    const failedDates = [...new Set((Array.isArray(result?.failedDates) ? result.failedDates : []).filter(Boolean))];
    const states = await Promise.all(failedDates.map((failedDate) => db.prepare(
      "SELECT last_error_code FROM game_schedule_check_state WHERE schedule_date = ?1 LIMIT 1"
    ).bind(failedDate).first()));
    const recovered = failedDates.length > 0 && states.length === failedDates.length
      && states.every((state) => state && !state.last_error_code);
    const duplicate = !recovered && (recent.results || []).some((row) => parseJsonObject(row.metadata).date === date);
    if (duplicate) return;
    await recordWorkflowLog(db, {
      eventType: "schedule_sync",
      status: "error",
      occurredAt: now,
      message: "試合予定の同期に失敗しました。",
      errorCode: "SCHEDULE_SYNC_FAILED",
      metadata,
      source: "cron"
    });
  } catch (error) {
    console.warn(`[GAME_WORKFLOW_LOG] action=schedule_sync status=failed code=${error?.code || "SCHEDULE_SYNC_LOG_READ_FAILED"}`);
  }
}

async function loadDetectedScheduleGames(db, dates) {
  const sortedDates = [...new Set((Array.isArray(dates) ? dates : []).filter(isValidPregameDate))].sort();
  if (!sortedDates.length) return [];
  const registry = await getGameIdentityRegistryAvailability(db);
  const internalFilter = registry.scheduleColumnAvailable ? " AND internal_game_id IS NOT NULL AND internal_game_id <> ''" : "";
  const stored = await db.prepare(
    `SELECT * FROM detected_game_schedule WHERE game_date >= ?1 AND game_date <= ?2 AND game_status = 'scheduled'${internalFilter} ORDER BY start_at`
  ).bind(sortedDates[0], sortedDates[sortedDates.length - 1]).all();
  return (stored.results || []).map((row) => ({
    gameId: row.game_id,
    date: row.game_date,
    startTime: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(row.start_at)),
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    venue: row.venue || "",
    gameCode: row.game_code || "",
    internalGameId: row.internal_game_id || "",
    status: row.game_status
  }));
}

async function handleRegister(request, env, cors) {
  const input = await readJson(request);
  const validation = validateCredentials(input);
  if (!validation.ok) {
    return jsonResponse({ ok: false, error: validation.error }, 400, cors);
  }
  if (input.password !== input.passwordConfirmation) {
    return jsonResponse({ ok: false, error: "パスワード確認が一致しません。" }, 400, cors);
  }

  const username = String(input.username).trim();
  const usernameNormalized = normalizeUsername(username);
  const existing = await env.AUTH_DB.prepare(
    "SELECT id FROM users WHERE username_normalized = ?1 LIMIT 1"
  ).bind(usernameNormalized).first();
  if (existing) {
    return jsonResponse({ ok: false, error: "そのユーザー名はすでに使用されています。" }, 409, cors);
  }

  const salt = randomBytes(16);
  const passwordHash = await derivePasswordHash(input.password, salt, PBKDF2_ITERATIONS);
  const now = new Date().toISOString();
  const userId = randomToken(16);

  try {
    await env.AUTH_DB.prepare(
      `INSERT INTO users
        (id, username, username_normalized, password_hash, password_salt, password_iterations, created_at, updated_at, status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, 'active')`
    ).bind(
      userId,
      username,
      usernameNormalized,
      bytesToBase64Url(passwordHash),
      bytesToBase64Url(salt),
      PBKDF2_ITERATIONS,
      now
    ).run();
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("unique")) {
      return jsonResponse({ ok: false, error: "そのユーザー名はすでに使用されています。" }, 409, cors);
    }
    throw error;
  }

  const session = await createSession(env.AUTH_DB, userId, env);
  return jsonResponse(
    { ok: true, user: publicUser({ id: userId, username, status: "active" }) },
    201,
    withSetCookie(cors, session.cookie)
  );
}

async function handleLogin(request, env, cors) {
  const input = await readJson(request);
  if (!input || typeof input.username !== "string" || typeof input.password !== "string") {
    return jsonResponse({ ok: false, error: "ユーザー名とパスワードを入力してください。" }, 400, cors);
  }

  const usernameNormalized = normalizeUsername(input.username);
  const user = await env.AUTH_DB.prepare(
    `SELECT id, username, status, password_hash, password_salt, password_iterations
       FROM users WHERE username_normalized = ?1 LIMIT 1`
  ).bind(usernameNormalized).first();

  if (!user || user.status !== "active") {
    return jsonResponse({ ok: false, error: "ユーザー名またはパスワードが正しくありません。" }, 401, cors);
  }

  const iterations = Number(user.password_iterations);
  // 過去にWorker上限を超える値で作成されたレコードは書き換えず、再設定導線へ委ねます。
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) {
    return jsonResponse({ ok: false, error: "ユーザー名またはパスワードが正しくありません。" }, 401, cors);
  }

  const salt = base64UrlToBytes(user.password_salt);
  const expectedHash = base64UrlToBytes(user.password_hash);
  const actualHash = await derivePasswordHash(input.password, salt, iterations);
  if (!constantTimeEqual(actualHash, expectedHash)) {
    return jsonResponse({ ok: false, error: "ユーザー名またはパスワードが正しくありません。" }, 401, cors);
  }

  const session = await createSession(env.AUTH_DB, user.id, env);
  return jsonResponse(
    { ok: true, user: publicUser(user) },
    200,
    withSetCookie(cors, session.cookie)
  );
}

async function handleLogout(request, env, cors) {
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (token) {
    const tokenHash = await sha256Base64Url(token);
    await env.AUTH_DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(tokenHash).run();
  }

  return jsonResponse(
    { ok: true },
    200,
    withSetCookie(cors, clearSessionCookie(env))
  );
}

async function handleMe(request, env, ctx, cors) {
  const session = await getSessionUser(request, env);
  if (!session) {
    return jsonResponse({ ok: true, authenticated: false, user: null }, 200, cors);
  }

  if (ctx?.waitUntil) {
    ctx.waitUntil(env.AUTH_DB.prepare(
      "UPDATE sessions SET last_used_at = ?1 WHERE id = ?2"
    ).bind(new Date().toISOString(), session.sessionId).run());
  }

  return jsonResponse({ ok: true, authenticated: true, user: publicUser(session) }, 200, cors);
}

async function handleAdminMe(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) {
    return access.response;
  }

  return jsonResponse({
    ok: true,
    admin: true,
    user: publicUser(access.user)
  }, 200, cors);
}

async function handleAdminV3Overview(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  let schema;
  let games;
  try {
    schema = await getV3SchemaState(env.AUTH_DB);
    games = await listV3Games(env.AUTH_DB, new Date());
  } catch (error) {
    const code = String(error?.code || "V3_OVERVIEW_INTERNAL_ERROR");
    console.error(`[ADMIN_V3_OVERVIEW] stage=base_read failureCode=${code}`);
    return jsonResponse({ ok: false, code: "V3_OVERVIEW_INTERNAL_ERROR", error: "V3管理画面の概要を取得できませんでした。" }, 500, cors);
  }
  if (!schema.ready) return jsonResponse({ ok: false, code: "GAME_AUTOMATION_V3_SCHEMA_UNAVAILABLE", schema }, 503, cors);
  const overviewNow = new Date();
  let cronLastRunAt = null;
  try {
    const cronAudit = await env.AUTH_DB.prepare(
      "SELECT occurred_at FROM game_automation_v3_audit WHERE source = 'cron' ORDER BY occurred_at DESC LIMIT 1"
    ).first();
    cronLastRunAt = cronAudit?.occurred_at || null;
  } catch (error) {
    console.warn(`[ADMIN_V3_OVERVIEW] stage=cron_audit_read failureCode=${error?.code || "V3_CRON_AUDIT_READ_FAILED"}`);
  }
  let futureGamesCount = null;
  try {
    futureGamesCount = await countFutureFightersGames(env.AUTH_DB, overviewNow);
  } catch (error) {
    console.warn(`[ADMIN_V3_OVERVIEW] stage=future_games_count_read failureCode=${error?.code || "V3_FUTURE_GAMES_COUNT_READ_FAILED"}`);
  }
  let futureScheduleSync = null;
  try {
    const syncAudit = await env.AUTH_DB.prepare(
      `SELECT failure_code, failure_message, occurred_at
         FROM game_automation_v3_audit
        WHERE event_type = 'schedule_sync'
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`
    ).first();
    if (syncAudit) {
      let parsed = {};
      try {
        parsed = JSON.parse(syncAudit.failure_message || "{}");
      } catch {
        parsed = {};
      }
      futureScheduleSync = {
        ...parsed,
        errorCode: syncAudit.failure_code || parsed.errorCode || null,
        lastScheduleSyncAt: syncAudit.occurred_at || parsed.lastScheduleSyncAt || null
      };
    }
  } catch (error) {
    console.warn(`[ADMIN_V3_OVERVIEW] stage=schedule_sync_diagnostic_read failureCode=${error?.code || "V3_SCHEDULE_SYNC_DIAGNOSTIC_READ_FAILED"}`);
  }
  const rows = [];
  let probableStarterColumns = new Set();
  try {
    probableStarterColumns = await getTableColumnSet(env.AUTH_DB, "probable_starters");
  } catch {
    // 予告先発の旧スキーマでは、V3概要の付加情報だけを省略します。
  }
  for (const game of games) {
    let state = null;
    let jobs = { results: [] };
    try {
      state = await env.AUTH_DB.prepare(
        "SELECT state, version, failure_code, updated_at FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
      ).bind(game.internalGameId).first();
    } catch (error) {
      const code = String(error?.code || "V3_STATE_READ_FAILED");
      console.error(`[ADMIN_V3_OVERVIEW] internalGameId=${game.internalGameId} stage=state_read failureCode=${code}`);
      state = { state: "error", version: 0, errorCode: "V3_STATE_READ_FAILED" };
    }
    try {
      jobs = await env.AUTH_DB.prepare(
        `SELECT id, job_type, status, scheduled_at, scheduled_slot_at, attempt_count,
                max_attempts, next_retry_at, claimed_at, lease_expires_at, completed_at,
                failure_code, failure_message, updated_at
           FROM game_jobs_v3 WHERE internal_game_id = ?1 ORDER BY scheduled_at, id`
      ).bind(game.internalGameId).all();
    } catch (error) {
      const code = String(error?.code || "V3_JOBS_READ_FAILED");
      console.error(`[ADMIN_V3_OVERVIEW] internalGameId=${game.internalGameId} stage=jobs_read failureCode=${code}`);
      jobs = { results: [], errorCode: "V3_JOBS_READ_FAILED" };
    }
    let probableStarter = null;
    let probableStarterError = null;
    let probableStarterRowAudit = {
      integrityErrorReason: null,
      canonicalRowId: null,
      probableStarterRowInternalGameId: null,
      conflictingRowId: null,
      legacyRowDetected: false,
      mismatchedRowId: null,
      mismatchedInternalGameId: null
    };
    try {
      if (!probableStarterColumns.has("internal_game_id")) {
        probableStarterError = "V3_PROBABLE_STARTER_SCHEMA_UNAVAILABLE";
      } else {
        const probableRows = await env.AUTH_DB.prepare(
          `SELECT status, home_pitcher_name, away_pitcher_name, fetched_at, announced_at,
                  next_check_at, source_url, error_code, updated_at, game_id, internal_game_id
             FROM probable_starters
            WHERE internal_game_id = ?1 OR game_id = ?1
            ORDER BY COALESCE(fetched_at, updated_at) DESC
            LIMIT 3`
        ).bind(game.internalGameId).all();
        const canonical = resolveCanonicalProbableStarterRow(probableRows.results, game.internalGameId);
        probableStarterRowAudit = {
          integrityErrorReason: canonical.integrityErrorReason,
          canonicalRowId: canonical.canonicalRowId,
          probableStarterRowInternalGameId: canonical.probableStarterRowInternalGameId,
          conflictingRowId: canonical.conflictingRowId,
          legacyRowDetected: canonical.legacyRowDetected,
          mismatchedRowId: canonical.mismatchedRowId,
          mismatchedInternalGameId: canonical.mismatchedInternalGameId
        };
        if (canonical.integrityErrorReason) {
          probableStarterError = "DATA_INTEGRITY_ERROR";
        } else {
          probableStarter = canonical.canonicalRow;
        }
      }
    } catch (error) {
      probableStarterError = String(error?.code || "V3_PROBABLE_STARTER_READ_FAILED");
      console.error(`[ADMIN_V3_OVERVIEW] internalGameId=${game.internalGameId} stage=probable_starter_read failureCode=${probableStarterError}`);
    }
    const serializedProbableStarter = serializeProbableStarterRow(probableStarter);
    const probableStarterPayload = probableStarterError
      ? { status: "error", errorCode: probableStarterError }
      : serializedProbableStarter;
    const currentProbableStarterDataStatus = serializedProbableStarter?.dataStatus
      || normalizeProbableStarterDataStatus(probableStarterPayload || {});
    const currentProbableStarterErrorCode = serializedProbableStarter?.errorCode || probableStarterError || null;
    const currentProbableStarterDecision = shouldStopProbableStarterScheduling({
      dataStatus: currentProbableStarterDataStatus,
      integrityErrorReason: probableStarterRowAudit.integrityErrorReason,
      status: probableStarterPayload?.status,
      errorCode: currentProbableStarterErrorCode,
      homePitcherName: serializedProbableStarter?.homePitcherName,
      awayPitcherName: serializedProbableStarter?.awayPitcherName,
      startAt: game.startAt,
      gameStatus: game.gameStatus,
      now: overviewNow
    });
    let probableStarterDiagnostics = {
      internalGameId: game.internalGameId,
      probableStarterRowInternalGameId: probableStarterRowAudit.probableStarterRowInternalGameId,
      canonicalRowId: probableStarterRowAudit.canonicalRowId,
      conflictingRowId: probableStarterRowAudit.conflictingRowId,
      legacyRowDetected: probableStarterRowAudit.legacyRowDetected,
      mismatchedRowId: probableStarterRowAudit.mismatchedRowId,
      mismatchedInternalGameId: probableStarterRowAudit.mismatchedInternalGameId,
      integrityErrorReason: probableStarterRowAudit.integrityErrorReason,
      homeTeam: game.homeTeam || null,
      awayTeam: game.awayTeam || null,
      gameDate: game.gameDate || null,
      npbGameCode: game.npbGameCode || null,
      dataStatus: currentProbableStarterDataStatus,
      currentDataStatus: currentProbableStarterDecision.normalizedDataStatus,
      rawStatus: probableStarterPayload?.status || null,
      rawDataStatus: probableStarterPayload?.dataStatus || null,
      rawErrorCode: currentProbableStarterErrorCode,
      errorCode: currentProbableStarterErrorCode,
      shouldStopScheduling: currentProbableStarterDecision.shouldStopScheduling,
      reasonCode: currentProbableStarterDecision.reasonCode,
      nextCheckAt: serializedProbableStarter?.nextCheckAt || null,
      homePitcherPresent: Boolean(serializedProbableStarter?.homePitcherName),
      awayPitcherPresent: Boolean(serializedProbableStarter?.awayPitcherName),
      generatedSlots: [],
      dueSlots: []
    };
    let rosterDiagnostics = {
      internalGameId: game.internalGameId,
      generatedSlots: [],
      dueSlots: [],
      selectedDueSlot: null,
      actualJobExists: false,
      jobStatus: null,
      planningSkipped: false,
      skipReason: null,
      openJobExists: false,
      existingJobId: null,
      insertAttempted: false,
      insertedRowCount: 0,
      claimResult: "not_attempted",
      rosterSnapshotExists: false,
      rosterSnapshotInternalGameId: null,
      rosterSnapshotStatus: null,
      rosterSnapshotCapturedAt: null,
      rosterSnapshotGameDate: null,
      rosterSnapshotSource: null,
      isSnapshotFresh: false,
      isSnapshotStale: false,
      staleReason: null,
      sourceUrl: null,
      httpStatus: null,
      parserResult: null,
      registeredCountHome: null,
      deregisteredCountHome: null,
      registeredCountAway: null,
      deregisteredCountAway: null,
      totalRosterChanges: null,
      noticeState: null,
      executorStage: null,
      sourceDate: null,
      fetchedAt: null,
      registeredPlayersHome: [],
      deregisteredPlayersHome: [],
      registeredPlayersAway: [],
      deregisteredPlayersAway: [],
      selectedSlotReason: null,
      currentJstTime: null,
      plannedSlots: [],
      nextCheckAt: null,
      isBeforeFirstRosterSlot: false,
      isAfterDueSlot: false,
      freshSnapshotExists: false,
      staleSnapshotExists: false,
      terminalRosterJobExists: false,
      reasonCode: null,
      severity: null,
      label: null
    };
    const resolvedState = state || { state: "scheduled", version: 0 };
    const jobRows = jobs.results || [];
    const latestJob = (types) => jobRows
      .filter((job) => types.includes(String(job.job_type || "")))
      .sort((left, right) => String(right.updated_at || right.scheduled_at || "").localeCompare(String(left.updated_at || left.scheduled_at || "")))[0] || null;
    const summarizeJob = (types) => {
      const job = latestJob(types);
      return job
        ? { status: job.status || "pending", jobId: Number.isInteger(Number(job.id)) ? Number(job.id) : null, jobType: job.job_type || null, failureCode: job.failure_code || null, scheduledAt: job.scheduled_at || null, completedAt: job.completed_at || null }
        : { status: "not_started", jobId: null, jobType: null, failureCode: null, scheduledAt: null, completedAt: null };
    };
    const lineupSummary = jobs.errorCode
      ? { status: "error", errorCode: jobs.errorCode }
      : { fetch: summarizeJob(["lineup_fetch", "final_lineup_fetch"]), finalize: summarizeJob(["lineup_finalize"]), status: summarizeJob(["lineup_fetch", "final_lineup_fetch", "lineup_finalize"]).status };
    let scoringNoOpAudit = null;
    let rankingNoOpAudit = null;
    try {
      const noOpAudits = await env.AUTH_DB.prepare(
        `SELECT event_type, failure_message, occurred_at
           FROM game_automation_v3_audit
          WHERE internal_game_id = ?1 AND (event_type = 'scoring_no_op' OR event_type = 'ranking_no_op')
          ORDER BY occurred_at DESC, id DESC LIMIT 10`
      ).bind(game.internalGameId).all();
      scoringNoOpAudit = (noOpAudits.results || []).find((row) => row.event_type === "scoring_no_op") || null;
      rankingNoOpAudit = (noOpAudits.results || []).find((row) => row.event_type === "ranking_no_op") || null;
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
    }
    const extractNoOpReason = (audit) => String(audit?.failure_message || "").match(/V3_[A-Z0-9_]+/)?.[0] || null;
    const scoringSummary = jobs.errorCode
      ? { status: "error", errorCode: jobs.errorCode }
      : { ...summarizeJob(["score", "scoring"]), noOpReason: extractNoOpReason(scoringNoOpAudit), noOpAt: scoringNoOpAudit?.occurred_at || null };
    const rankingSummary = jobs.errorCode
      ? { status: "error", errorCode: jobs.errorCode }
      : { ...summarizeJob(["ranking_rebuild"]), noOpReason: extractNoOpReason(rankingNoOpAudit), noOpAt: rankingNoOpAudit?.occurred_at || null };
    const publicationSummary = jobs.errorCode ? { status: "error", errorCode: jobs.errorCode } : summarizeJob(["publish", "publication"]);
    const scheduleBase = deriveV3DisplaySchedule(game);
    const rosterSlots = scheduleBase.rosterFetchSlots || [];
    const dueRosterSlots = rosterSlots.filter((slot) => new Date(slot).getTime() <= overviewNow.getTime());
    const rosterJobRows = jobRows.filter((job) => String(job.job_type || "") === "roster_fetch");
    const rosterJobSlots = new Set(rosterJobRows.map((job) => String(job.scheduled_slot_at || "")));
    const selectedRosterSlot = rosterDiagnostics.selectedDueSlot
      || [...dueRosterSlots].reverse().find((slot) => !rosterJobSlots.has(slot))
      || dueRosterSlots[dueRosterSlots.length - 1]
      || null;
    const selectedRosterJob = selectedRosterSlot
      ? rosterJobRows.find((job) => String(job.scheduled_slot_at || "") === String(selectedRosterSlot)) || null
      : null;
    const canonicalRosterSnapshot = await getV3CanonicalRosterSnapshot(env.AUTH_DB, game.internalGameId, { gameDate: game.gameDate });
    let latestRosterAuditDetails = {};
    try {
      const rosterAudit = await env.AUTH_DB.prepare(
        `SELECT failure_message
           FROM game_automation_v3_audit
          WHERE internal_game_id = ?1 AND job_type = 'roster_fetch' AND event_type = 'job'
          ORDER BY occurred_at DESC, id DESC LIMIT 1`
      ).bind(game.internalGameId).first();
      latestRosterAuditDetails = parseV3AuditDetails(rosterAudit?.failure_message);
    } catch (error) {
      console.warn(`[ADMIN_V3_OVERVIEW] internalGameId=${game.internalGameId} stage=roster_audit_read failureCode=${error?.code || "V3_ROSTER_AUDIT_READ_FAILED"}`);
    }
    const rosterStatusDecision = getV3RosterStatusDecision({
      game,
      now: overviewNow,
      snapshot: canonicalRosterSnapshot,
      jobs: rosterJobRows,
      noticeState: latestRosterAuditDetails.noticeState || latestRosterAuditDetails.reasonCode || null
    });
    const currentRosterJob = selectedRosterJob || rosterStatusDecision.openRosterJob || null;
    rosterDiagnostics = {
      ...rosterDiagnostics,
      generatedSlots: rosterDiagnostics.generatedSlots?.length ? rosterDiagnostics.generatedSlots : rosterSlots,
      dueSlots: rosterDiagnostics.dueSlots?.length ? rosterDiagnostics.dueSlots : dueRosterSlots,
      selectedDueSlot: rosterStatusDecision.selectedDueSlot || selectedRosterSlot,
      actualJobExists: Boolean(currentRosterJob || rosterDiagnostics.actualJobExists),
      jobStatus: currentRosterJob?.status || rosterDiagnostics.jobStatus || null,
      existingJobId: currentRosterJob?.id || rosterDiagnostics.existingJobId || null,
      rosterSnapshotExists: canonicalRosterSnapshot.exists,
      rosterSnapshotInternalGameId: canonicalRosterSnapshot.internalGameId,
      rosterSnapshotStatus: canonicalRosterSnapshot.status,
      rosterSnapshotPlayerCount: canonicalRosterSnapshot.playerCount,
      rosterSnapshotCapturedAt: canonicalRosterSnapshot.capturedAt,
      rosterSnapshotGameDate: canonicalRosterSnapshot.gameDate,
      rosterSnapshotSource: canonicalRosterSnapshot.source,
      isSnapshotFresh: canonicalRosterSnapshot.isFresh,
      isSnapshotStale: canonicalRosterSnapshot.isStale,
      staleReason: canonicalRosterSnapshot.staleReason,
      sourceUrl: latestRosterAuditDetails.sourceUrl || null,
      httpStatus: latestRosterAuditDetails.httpStatus || null,
      parserResult: latestRosterAuditDetails.parserResult || null,
      registeredCountHome: latestRosterAuditDetails.registeredCountHome ?? null,
      deregisteredCountHome: latestRosterAuditDetails.deregisteredCountHome ?? null,
      registeredCountAway: latestRosterAuditDetails.registeredCountAway ?? null,
      deregisteredCountAway: latestRosterAuditDetails.deregisteredCountAway ?? null,
      totalRosterChanges: latestRosterAuditDetails.totalRosterChanges ?? null,
      noticeState: latestRosterAuditDetails.noticeState || latestRosterAuditDetails.reasonCode || null,
      executorStage: latestRosterAuditDetails.executorStage || null,
      sourceDate: latestRosterAuditDetails.sourceDate || latestRosterAuditDetails.diagnostics?.sourceDate || null,
      fetchedAt: latestRosterAuditDetails.fetchedAt || null,
      registeredPlayersHome: latestRosterAuditDetails.registeredPlayersHome || [],
      deregisteredPlayersHome: latestRosterAuditDetails.deregisteredPlayersHome || [],
      registeredPlayersAway: latestRosterAuditDetails.registeredPlayersAway || [],
      deregisteredPlayersAway: latestRosterAuditDetails.deregisteredPlayersAway || [],
      selectedSlotReason: latestRosterAuditDetails.plannerDecision?.selectedSlotReason || (rosterStatusDecision.selectedDueSlot ? "latest_due_roster_slot" : "roster_not_due"),
      currentJstTime: rosterStatusDecision.currentJstTime,
      plannedSlots: rosterStatusDecision.plannedSlots,
      nextCheckAt: rosterStatusDecision.nextCheckAt,
      isBeforeFirstRosterSlot: rosterStatusDecision.isBeforeFirstRosterSlot,
      isAfterDueSlot: rosterStatusDecision.isAfterDueSlot,
      freshSnapshotExists: rosterStatusDecision.freshSnapshotExists,
      staleSnapshotExists: rosterStatusDecision.staleSnapshotExists,
      openJobExists: rosterStatusDecision.openRosterJobExists,
      terminalRosterJobExists: rosterStatusDecision.terminalRosterJobExists,
      reasonCode: rosterStatusDecision.reasonCode,
      severity: rosterStatusDecision.severity,
      label: rosterStatusDecision.label
    };
    const probableSlots = getV3ProbableStarterSlots(game).map((slot) => slot.toISOString());
    const probableJobSlots = new Set(jobRows
      .filter((job) => String(job.job_type || "") === "probable_starter_fetch")
      .map((job) => String(job.scheduled_slot_at || "")));
    const missingDueProbableSlot = probableSlots
      .filter((slot) => new Date(slot).getTime() <= overviewNow.getTime() && !probableJobSlots.has(slot))
      .pop() || "";
    const nextProbableSlot = missingDueProbableSlot
      || probableSlots.find((slot) => new Date(slot).getTime() > overviewNow.getTime() && !probableJobSlots.has(slot))
      || "";
    const probableStarterNextCheckAt = serializedProbableStarter?.nextCheckAt
      || probableStarterDiagnostics?.nextCheckAt
      || nextProbableSlot
      || null;
    const probableStarterActualJob = jobRows
      .filter((job) => String(job.job_type || "") === "probable_starter_fetch"
        && probableStarterNextCheckAt
        && String(job.scheduled_slot_at || "") === String(probableStarterNextCheckAt))
      .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0] || null;
    const schedule = {
      ...scheduleBase,
      probableStarterSlots: probableSlots,
      probableStarterNextAt: serializedProbableStarter?.dataStatus === "announced" ? null : probableStarterNextCheckAt,
      probableStarterNextCheckAt,
      probableStarterJob: probableStarterActualJob ? {
        actualJobExists: true,
        jobId: Number(probableStarterActualJob.id || 0) || null,
        scheduledSlotAt: probableStarterActualJob.scheduled_slot_at || null,
        jobStatus: probableStarterActualJob.status || null,
        attemptCount: Number(probableStarterActualJob.attempt_count || 0),
        maxAttempts: Number(probableStarterActualJob.max_attempts || 0),
        nextRetryAt: probableStarterActualJob.next_retry_at || null,
        claimedAt: probableStarterActualJob.claimed_at || null,
        completedAt: probableStarterActualJob.completed_at || null
      } : {
        actualJobExists: false,
        jobId: null,
        scheduledSlotAt: null,
        jobStatus: "not_created",
        attemptCount: 0,
        maxAttempts: 0,
        nextRetryAt: null,
        claimedAt: null,
        completedAt: null
      }
    };
    const nextAction = getV3NextAction({ schedule, state: resolvedState.state, jobs: jobRows, now: overviewNow });
    const phaseStatuses = {
      probable_starter: deriveV3PhaseStatus({ phase: "probable_starter", game, now: overviewNow, workflowState: resolvedState.state, jobs: jobRows, sourceStatus: currentProbableStarterDataStatus }),
      roster: deriveV3PhaseStatus({ phase: "roster", game, now: overviewNow, workflowState: resolvedState.state, jobs: jobRows, snapshot: canonicalRosterSnapshot, noticeState: rosterDiagnostics.noticeState }),
      prediction_close: deriveV3PhaseStatus({ phase: "prediction_close", game, now: overviewNow, workflowState: resolvedState.state, jobs: jobRows }),
      lineup_fetch: deriveV3PhaseStatus({ phase: "lineup_fetch", game, now: overviewNow, workflowState: resolvedState.state, jobs: jobRows }),
      lineup_finalize: deriveV3PhaseStatus({ phase: "lineup_finalize", game, now: overviewNow, workflowState: resolvedState.state, jobs: jobRows }),
      score: deriveV3PhaseStatus({ phase: "score", game, now: overviewNow, workflowState: resolvedState.state, jobs: jobRows, noOpReason: scoringSummary.noOpReason }),
      ranking: deriveV3PhaseStatus({ phase: "ranking", game, now: overviewNow, workflowState: resolvedState.state, jobs: jobRows, noOpReason: rankingSummary.noOpReason }),
      publish: deriveV3PhaseStatus({ phase: "publish", game, now: overviewNow, workflowState: resolvedState.state, jobs: jobRows })
    };
    rows.push({
      ...game,
      state: resolvedState,
      jobs: jobRows,
      lineupSummary,
      scoringSummary,
      rankingSummary,
      publicationSummary,
      probableStarter: probableStarterPayload,
      probableStarterDiagnostics,
      rosterDiagnostics,
      phaseStatuses,
      probableStarterNextCheckAt,
      probableStarterJob: schedule.probableStarterJob,
      auxiliaryErrors: [
        ...(state?.errorCode ? [{ field: "state", errorCode: state.errorCode }] : []),
        ...(jobs.errorCode ? [{ field: "jobs", errorCode: jobs.errorCode }] : []),
        ...(probableStarterError ? [{ field: "probableStarter", errorCode: probableStarterError }] : [])
      ],
      schedule: { ...schedule, ...nextAction }
    });
  }
  return jsonResponse({
    ok: true,
    featureFlag: V3_FEATURE_FLAG,
    enabled: isGameAutomationV3Enabled(env),
    schema,
    todayOps: {
      cronLastRunAt,
      cronLastRunSource: "game_automation_v3_audit",
      cronSchedule: V3_CRON_SCHEDULE,
      cronIntervalMinutes: V3_CRON_INTERVAL_MINUTES,
      cronGraceMinutes: V3_CRON_GRACE_MINUTES,
      cronDescription: V3_CRON_DESCRIPTION,
      futureGamesCount,
      futureGamesMinimum: AUTOMATION_MIN_FUTURE_GAMES,
      futureGamesDefinition: "game_date > JST today",
      futureScheduleSync
    },
    games: rows
  }, 200, cors);
}

async function handleAdminV3IdentityResolve(request, env, cors, internalGameId, options = {}) {
  const operationSource = options.source || "admin";
  const access = options.skipAuth ? { ok: true, user: null } : await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  let diagnosticId = "";
  let diagnosticGame = null;
  try {
    const id = normalizeV3InternalGameId(internalGameId);
    diagnosticId = id;
    const columns = await getTableColumnSet(env.AUTH_DB, "games");
    const requiredColumns = ["npb_game_code", "npb_game_url", "source_schedule_key", "npb_identity_status", "npb_identity_resolved_at", "npb_identity_source"];
    if (!requiredColumns.every((column) => columns.has(column))) {
      return jsonResponse({ ok: false, code: "GAME_AUTOMATION_V3_SCHEMA_UNAVAILABLE", error: "NPB識別情報スキーマが準備されていません。" }, 503, cors);
    }
    const current = await env.AUTH_DB.prepare(
      `SELECT internal_game_id, game_date, start_time, home_team, away_team, stadium,
              npb_game_code, npb_game_url, source_schedule_key, npb_identity_status,
              npb_identity_resolved_at, npb_identity_source, game_status
         FROM games WHERE internal_game_id = ?1 LIMIT 1`
    ).bind(id).first();
    if (!current) return jsonResponse({ ok: false, code: "V3_GAME_NOT_REGISTERED", error: "対象試合が日程DBに登録されていません。" }, 404, cors);
    diagnosticGame = current;
    if (current.npb_identity_status === "manually_overridden" && options.skipAuth) {
      return jsonResponse({ ok: true, noOp: true, resolvedBy: "manually_overridden", identityState: "manually_overridden", game: serializeV3GameIdentity(current) }, 200, cors);
    }
    if (current.npb_identity_status === "resolved" && options.skipAuth) {
      return jsonResponse({ ok: true, noOp: true, resolvedBy: current.npb_identity_source || "persisted", identityState: "resolved", game: serializeV3GameIdentity(current) }, 200, cors);
    }
    if (current.npb_identity_status === "manually_overridden") {
      return jsonResponse({ ok: false, code: "NPB_IDENTITY_MANUAL_OVERRIDE", error: "管理者上書き値は自動再解決で変更できません。" }, 409, cors);
    }
    let payload;
    try {
      payload = await fetchNpbWorkerJson(env, { mode: "schedule", date: current.game_date });
    } catch (error) {
      const failureCode = classifyNpbScheduleFetchError(error);
      const diagnostics = createNpbResolutionDiagnostics(current, {
        fetchEndpoint: error?.fetchEndpoint || null,
        fetchHttpStatus: Number(error?.httpStatus || error?.upstreamStatus) || null,
        responseContentType: error?.contentType || null,
        rejectionReasonCounts: { FETCH_FAILED: 1 },
        finalFailureCode: failureCode
      });
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "v3_npb_identity_resolution",
        status: "error",
        gameId: id,
        message: "NPB試合識別情報の候補取得に失敗しました。",
        errorCode: failureCode,
        metadata: diagnostics,
        source: operationSource
      });
      console.warn(`[GAME_AUTOMATION_V3] stage=npb_identity_resolve_fetch code=${failureCode} status=${diagnostics.fetchHttpStatus || "unknown"}`);
      return jsonResponse({ ok: false, code: failureCode, error: "NPB日程候補を取得できませんでした。", identityState: getNpbIdentityRuntimeState(current.start_time), resolutionDiagnostics: diagnostics }, 502, cors);
    }
    if (!Array.isArray(payload?.games)) {
      const diagnostics = createNpbResolutionDiagnostics(current, {
        fetchEndpoint: payload?.__fetchMeta?.endpoint || null,
        fetchHttpStatus: Number(payload?.__fetchMeta?.httpStatus) || 200,
        responseContentType: payload?.__fetchMeta?.contentType || "application/json",
        rejectionReasonCounts: { RESPONSE_GAMES_NOT_ARRAY: 1 },
        finalFailureCode: "NPB_SCHEDULE_RESPONSE_INVALID"
      });
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "v3_npb_identity_resolution",
        status: "error",
        gameId: id,
        message: "NPB日程レスポンスのgamesが不正です。",
        errorCode: "NPB_SCHEDULE_RESPONSE_INVALID",
        metadata: diagnostics,
        source: operationSource
      });
      return jsonResponse({ ok: false, code: "NPB_SCHEDULE_RESPONSE_INVALID", error: "NPB日程レスポンスが不正です。", identityState: getNpbIdentityRuntimeState(current.start_time), resolutionDiagnostics: diagnostics }, 502, cors);
    }
    const staticGames = getScheduledGames();
    const staticDateCount = staticGames.filter((game) => String(game?.date || game?.game_date || "") === String(current.game_date || "")).length;
    const staticTargetCandidates = getStaticNpbTargetCandidates(staticGames, current);
    const scheduleCandidates = mergeNpbScheduleCandidates(payload.games, staticGames, current.game_date, current);
    const targetHome = normalizeScheduleTeamCode(current.home_team);
    const targetAway = normalizeScheduleTeamCode(current.away_team);
    const targetStart = new Date(current.start_time || "");
    const hasLiveOrMergedTarget = scheduleCandidates.some((game) => {
      const candidate = normalizeNpbScheduleCandidate(game, current.game_date);
      return candidate.candidateDateJst === current.game_date
        && candidate.normalizedHomeTeam === targetHome
        && candidate.normalizedAwayTeam === targetAway
        && !Number.isNaN(candidate.candidateStart.getTime())
        && candidate.candidateStart.getTime() === targetStart.getTime();
    });
    const identityCandidates = hasLiveOrMergedTarget
      ? scheduleCandidates
      : [...scheduleCandidates, ...staticTargetCandidates];
    const resolved = resolveNpbScheduleIdentity({
      date: current.game_date,
      startAt: current.start_time,
      homeTeam: current.home_team,
      awayTeam: current.away_team,
      stadium: current.stadium,
      games: identityCandidates
    });
    if (resolved.status !== "resolved") {
      const status = resolved.status === "conflict" ? 409 : 422;
      const noCandidates = payload.games.length === 0 && identityCandidates.length === 0;
      const staticHasNoIdentity = staticTargetCandidates.length > 0
        && staticTargetCandidates.every((game) => !getScheduleGameCode(game));
      const finalFailureCode = noCandidates
        ? (staticDateCount === 0 ? "NPB_STATIC_SCHEDULE_EMPTY" : "NPB_SCHEDULE_CANDIDATES_EMPTY")
        : (staticHasNoIdentity && resolved.code === "NPB_IDENTITY_NO_MATCH"
          ? "NPB_STATIC_SCHEDULE_NO_IDENTITY"
          : resolved.code);
      const diagnostics = createNpbResolutionDiagnostics(current, {
        ...(resolved.diagnostics || {}),
        fetchEndpoint: payload?.__fetchMeta?.endpoint || null,
        fetchHttpStatus: Number(payload?.__fetchMeta?.httpStatus) || 200,
        responseContentType: payload?.__fetchMeta?.contentType || "application/json",
        rawCandidateCount: payload.games.length,
        parsedCandidateCount: resolved.diagnostics?.parsedCandidateCount || 0,
        staticCandidateCount: staticTargetCandidates.length,
        mergedCandidateCount: identityCandidates.length,
        finalFailureCode,
        rejectionReasonCounts: {
          ...(resolved.diagnostics?.rejectionReasonCounts || {}),
          ...(noCandidates ? { CANDIDATES_EMPTY: 1 } : {}),
          ...(noCandidates && staticDateCount === 0 ? { STATIC_SCHEDULE_EMPTY: 1 } : {}),
          ...(staticHasNoIdentity ? { STATIC_SCHEDULE_NO_IDENTITY: 1 } : {})
        }
      });
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "v3_npb_identity_resolution",
        status: resolved.status === "conflict" ? "error" : "warning",
        gameId: id,
        message: resolved.status === "conflict" ? "NPB日程の候補が複数あります。" : "NPB日程から対象試合を解決できませんでした。",
        errorCode: finalFailureCode,
        metadata: diagnostics,
        source: operationSource
      });
      return jsonResponse({ ok: false, code: finalFailureCode, error: ["NPB_SCHEDULE_CANDIDATES_EMPTY", "NPB_STATIC_SCHEDULE_EMPTY"].includes(finalFailureCode) ? "NPB日程候補が空です。" : (resolved.status === "conflict" ? "NPB日程の候補が複数あります。" : "NPB日程から対象試合を解決できませんでした。"), identityState: getNpbIdentityRuntimeState(current.start_time), resolutionDiagnostics: diagnostics }, status, cors);
    }
    const identifiers = [
      { provider: "npb", identifierType: "npb_game_code", identifierValue: resolved.gameCode },
      { provider: "schedule_worker", identifierType: "source_game_key", identifierValue: resolved.sourceScheduleKey }
    ];
    for (const identifier of identifiers) {
      const conflict = await env.AUTH_DB.prepare(
        `SELECT internal_game_id FROM game_identifiers
          WHERE provider = ?1 AND identifier_type = ?2 AND identifier_value = ?3
          LIMIT 2`
      ).bind(identifier.provider, identifier.identifierType, identifier.identifierValue).all();
      const otherIds = [...new Set((conflict.results || []).map((row) => String(row.internal_game_id || "")).filter((value) => value && value !== id))];
      if (otherIds.length) {
        const diagnostics = createNpbResolutionDiagnostics(current, {
          ...(resolved.diagnostics || {}),
          fetchEndpoint: payload?.__fetchMeta?.endpoint || null,
          fetchHttpStatus: Number(payload?.__fetchMeta?.httpStatus) || 200,
          responseContentType: payload?.__fetchMeta?.contentType || "application/json",
          rawCandidateCount: payload.games.length,
          staticCandidateCount: staticTargetCandidates.length,
          mergedCandidateCount: identityCandidates.length,
          finalFailureCode: "NPB_IDENTITY_CONFLICT",
          rejectionReasonCounts: { ...(resolved.diagnostics?.rejectionReasonCounts || {}), IDENTIFIER_CONFLICT: 1 }
        });
        await recordWorkflowLog(env.AUTH_DB, {
          eventType: "v3_npb_identity_resolution",
          status: "error",
          gameId: id,
          message: "NPB識別子が別の試合へ登録されています。",
          errorCode: "NPB_IDENTITY_CONFLICT",
          metadata: diagnostics,
          source: operationSource
        });
        return jsonResponse({ ok: false, code: "NPB_IDENTITY_CONFLICT", error: "NPB識別子が別の試合へ登録されています。", identityState: getNpbIdentityRuntimeState(current.start_time), resolutionDiagnostics: diagnostics }, 409, cors);
      }
    }
    const now = new Date();
    await updateGameScheduleMetadata(env.AUTH_DB, id, {
      gameDate: current.game_date,
      startTime: current.start_time,
      homeTeam: current.home_team,
      awayTeam: current.away_team,
      gameStatus: current.game_status
    }, {
      npbGameCode: resolved.gameCode,
      npbGameUrl: resolved.gameUrl,
      sourceScheduleKey: resolved.sourceScheduleKey,
      npbIdentityStatus: "resolved",
      npbIdentityResolvedAt: now.toISOString(),
      npbIdentitySource: resolved.diagnostics?.resolvedBy || resolved.source || "npb_schedule_resolve",
      updatedBy: access.user?.id ? `admin:${String(access.user.id)}` : operationSource === "cron" ? "system" : "admin"
    }, now);
    for (const identifier of identifiers) await registerGameIdentifier(env.AUTH_DB, id, identifier, now);
    const updated = await env.AUTH_DB.prepare(
      `SELECT internal_game_id, game_date, start_time, home_team, away_team,
              npb_game_code, npb_game_url, source_schedule_key, npb_identity_status,
              npb_identity_resolved_at, npb_identity_source, game_status
         FROM games WHERE internal_game_id = ?1 LIMIT 1`
    ).bind(id).first();
    const diagnostics = createNpbResolutionDiagnostics(current, {
      ...(resolved.diagnostics || {}),
      fetchEndpoint: payload?.__fetchMeta?.endpoint || null,
      fetchHttpStatus: Number(payload?.__fetchMeta?.httpStatus) || 200,
      responseContentType: payload?.__fetchMeta?.contentType || "application/json",
      rawCandidateCount: payload.games.length,
      parsedCandidateCount: resolved.diagnostics?.parsedCandidateCount || 0,
      staticCandidateCount: staticTargetCandidates.length,
      mergedCandidateCount: identityCandidates.length,
      finalFailureCode: ""
    });
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "v3_npb_identity_resolution",
      status: "success",
      gameId: id,
      message: "NPB試合識別情報を解決しました。",
      metadata: diagnostics,
      source: operationSource
    });
    return jsonResponse({ ok: true, resolvedBy: resolved.diagnostics?.resolvedBy || resolved.source || "npb_schedule_resolve", identityState: "resolved", resolutionDiagnostics: diagnostics, game: serializeV3GameIdentity(updated) }, 200, cors);
  } catch (error) {
    const code = String(error?.code || "NPB_IDENTITY_RESOLUTION_FAILED");
    console.error(`[GAME_AUTOMATION_V3] stage=npb_identity_resolve code=${code}`);
    const diagnostics = createNpbResolutionDiagnostics(diagnosticGame, {
      internalGameId: diagnosticId,
      finalFailureCode: code,
      rejectionReasonCounts: { RESOLUTION_EXCEPTION: 1 }
    });
    return jsonResponse({ ok: false, code, error: "NPB試合識別情報を再解決できませんでした。", identityState: getNpbIdentityRuntimeState(diagnosticGame?.start_time), resolutionDiagnostics: diagnostics }, 500, cors);
  }
}

function serializeV3GameIdentity(row) {
  return {
    internalGameId: row?.internal_game_id || "",
    gameDate: row?.game_date || "",
    startAt: row?.start_time || null,
    homeTeam: row?.home_team || "",
    awayTeam: row?.away_team || "",
    npbGameCode: row?.npb_game_code || null,
    npbGameUrl: row?.npb_game_url || null,
    sourceScheduleKey: row?.source_schedule_key || null,
    npbIdentityStatus: row?.npb_identity_status || "unresolved",
    npbIdentityResolvedAt: row?.npb_identity_resolved_at || null,
    npbIdentitySource: row?.npb_identity_source || null,
    gameStatus: row?.game_status || null
  };
}

async function handleAdminV3NpbGameCodeUpdate(request, env, cors, internalGameId) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;

  try {
    const id = normalizeV3InternalGameId(internalGameId);
    const gameColumns = await getTableColumnSet(env.AUTH_DB, "games");
    if (!gameColumns.has("npb_game_code")) {
      return jsonResponse({ ok: false, code: "GAME_AUTOMATION_V3_SCHEMA_UNAVAILABLE", error: "games.npb_game_code が利用できません。" }, 503, cors);
    }
    const identityColumns = ["npb_game_url", "source_schedule_key", "npb_identity_status", "npb_identity_resolved_at", "npb_identity_source"];
    if (!identityColumns.every((column) => gameColumns.has(column))) {
      return jsonResponse({ ok: false, code: "GAME_AUTOMATION_V3_SCHEMA_UNAVAILABLE", error: "NPB識別情報スキーマが準備されていません。" }, 503, cors);
    }
    const auditColumns = await getTableColumnSet(env.AUTH_DB, "game_automation_v3_audit");
    const requiredAuditColumns = ["event_type", "previous_npb_game_code", "next_npb_game_code", "updated_by", "previous_npb_game_url", "next_npb_game_url", "previous_npb_identity_status", "next_npb_identity_status", "previous_npb_identity_source", "next_npb_identity_source"];
    if (!requiredAuditColumns.every((column) => auditColumns.has(column))) {
      return jsonResponse({ ok: false, code: "GAME_AUTOMATION_V3_AUDIT_SCHEMA_UNAVAILABLE", error: "V3監査スキーマが準備されていません。" }, 503, cors);
    }

    const current = await env.AUTH_DB.prepare(
      `SELECT internal_game_id, game_date, start_time, home_team, away_team,
              npb_game_code, npb_game_url, source_schedule_key, npb_identity_status,
              npb_identity_resolved_at, npb_identity_source, game_status, is_active, deleted_at
         FROM games WHERE internal_game_id = ?1 LIMIT 1`
    ).bind(id).first();
    if (!current) return jsonResponse({ ok: false, code: "V3_GAME_NOT_REGISTERED", error: "対象試合が日程DBに登録されていません。" }, 404, cors);

    const input = await readJson(request);
    if (!input || !Object.prototype.hasOwnProperty.call(input, "npbGameCode") || typeof input.npbGameCode !== "string") {
      return jsonResponse({ ok: false, code: "NPB_GAME_CODE_INVALID", error: "npbGameCodeは文字列で指定してください。" }, 400, cors);
    }
    const rawCode = input.npbGameCode.trim();
    const nextCode = rawCode ? normalizeNpbGameCode(rawCode) : "";
    if (rawCode && !nextCode) {
      return jsonResponse({ ok: false, code: "NPB_GAME_CODE_INVALID", error: "NPBゲームコードの形式が不正です。" }, 400, cors);
    }

    const previousCode = String(current.npb_game_code || "").trim().toLowerCase() || null;
    const previousUrl = String(current.npb_game_url || "").trim() || null;
    const previousStatus = String(current.npb_identity_status || "unresolved");
    const previousSource = String(current.npb_identity_source || "").trim() || null;
    const updatedAt = new Date().toISOString();
    const updatedBy = access.user?.id ? `admin:${String(access.user.id)}` : "admin";
    const nextUrl = nextCode ? buildNpbGameUrl(current.game_date, nextCode) : null;
    const nextStatus = nextCode ? "manually_overridden" : "unresolved";
    const nextSource = nextCode ? "admin_manual_override" : "admin_manual_clear";
    const updateFields = ["npb_game_code = ?1", "npb_game_url = ?2", "npb_identity_status = ?3", "npb_identity_resolved_at = ?4", "npb_identity_source = ?5", "updated_at = ?6"];
    const updateValues = [nextCode || null, nextUrl, nextStatus, nextCode ? updatedAt : null, nextSource, updatedAt];
    if (gameColumns.has("updated_by")) {
      updateFields.push(`updated_by = ?${updateValues.length + 1}`);
      updateValues.push(updatedBy);
    }
    updateValues.push(id);

    await env.AUTH_DB.batch([
      env.AUTH_DB.prepare(`UPDATE games SET ${updateFields.join(", ")} WHERE internal_game_id = ?${updateValues.length}`).bind(...updateValues),
      env.AUTH_DB.prepare(
        `INSERT INTO game_automation_v3_audit
           (internal_game_id, job_type, event_type, previous_npb_game_code,
            next_npb_game_code, previous_npb_game_url, next_npb_game_url,
            previous_npb_identity_status, next_npb_identity_status,
            previous_npb_identity_source, next_npb_identity_source,
            updated_by, occurred_at, source)
         VALUES (?1, 'npb_game_code_update', 'admin_npb_game_code_update', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'admin')`
      ).bind(id, previousCode, nextCode || null, previousUrl, nextUrl, previousStatus, nextStatus, previousSource, nextSource, updatedBy, updatedAt)
    ]);

    const updated = await env.AUTH_DB.prepare(
      `SELECT internal_game_id, game_date, start_time, home_team, away_team,
              npb_game_code, npb_game_url, source_schedule_key, npb_identity_status,
              npb_identity_resolved_at, npb_identity_source, game_status, is_active, deleted_at
         FROM games WHERE internal_game_id = ?1 LIMIT 1`
    ).bind(id).first();
    return jsonResponse({ ok: true, updated: previousCode !== (nextCode || null), game: {
      internalGameId: updated.internal_game_id,
      gameDate: updated.game_date,
      startAt: updated.start_time,
      homeTeam: updated.home_team,
      awayTeam: updated.away_team,
      npbGameCode: updated.npb_game_code || null,
      npbGameUrl: updated.npb_game_url || null,
      sourceScheduleKey: updated.source_schedule_key || null,
      npbIdentityStatus: updated.npb_identity_status || "unresolved",
      npbIdentityResolvedAt: updated.npb_identity_resolved_at || null,
      npbIdentitySource: updated.npb_identity_source || null,
      gameStatus: updated.game_status,
      isActive: updated.is_active,
      deletedAt: updated.deleted_at
    } }, 200, cors);
  } catch (error) {
    const code = String(error?.code || "V3_NPB_GAME_CODE_UPDATE_FAILED");
    console.error(`[GAME_AUTOMATION_V3] stage=npb_game_code_update code=${code}`);
    return jsonResponse({ ok: false, code, error: "NPBゲームコードを更新できませんでした。" }, 500, cors);
  }
}

async function getV3OrientationImpact(db, internalGameId, legacyGameId = "") {
  const tables = ["predictions", "game_jobs_v3", "game_lineups", "ranking_games", "game_workflow_state"];
  const impact = {};
  for (const table of tables) {
    const columns = await getTableColumnSet(db, table);
    if (columns.has("internal_game_id")) {
      const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE internal_game_id = ?1`).bind(internalGameId).first();
      impact[table] = Number(row?.count || 0);
      continue;
    }
    if (!columns.has("game_id") || !legacyGameId) {
      impact[table] = 0;
      continue;
    }
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE game_id = ?1`).bind(legacyGameId).first();
    impact[table] = Number(row?.count || 0);
  }
  return impact;
}

async function handleAdminV3OrientationUpdate(request, env, cors, internalGameId) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  try {
    const id = normalizeV3InternalGameId(internalGameId);
    const columns = await getTableColumnSet(env.AUTH_DB, "games");
    if (!columns.has("home_team") || !columns.has("away_team")) {
      return jsonResponse({ ok: false, code: "GAME_AUTOMATION_V3_SCHEMA_UNAVAILABLE", error: "gamesのhome/away列が利用できません。" }, 503, cors);
    }
    const current = await env.AUTH_DB.prepare(
      `SELECT internal_game_id, game_date, start_time, home_team, away_team, game_status,
              ${columns.has("updated_at") ? "updated_at," : ""}
              ${columns.has("updated_by") ? "updated_by" : "internal_game_id"}
         FROM games WHERE internal_game_id = ?1 LIMIT 1`
    ).bind(id).first();
    if (!current) return jsonResponse({ ok: false, code: "V3_GAME_NOT_REGISTERED", error: "対象試合が日程DBに登録されていません。" }, 404, cors);

    const legacyGameId = columns.has("game_id")
      ? String((await env.AUTH_DB.prepare("SELECT game_id FROM games WHERE internal_game_id = ?1 LIMIT 1").bind(id).first())?.game_id || "")
      : "";

    const input = await readJson(request);
    const homeTeam = normalizeScheduleTeamCode(input?.homeTeam);
    const awayTeam = normalizeScheduleTeamCode(input?.awayTeam);
    const reason = String(input?.reason || "").trim();
    if (!homeTeam || !awayTeam || homeTeam === awayTeam) {
      return jsonResponse({ ok: false, code: "V3_ORIENTATION_INVALID", error: "homeTeamとawayTeamの組み合わせが不正です。" }, 400, cors);
    }
    if (!reason || reason.length > 240) {
      return jsonResponse({ ok: false, code: "V3_ORIENTATION_REASON_REQUIRED", error: "向きの修正理由を入力してください。" }, 400, cors);
    }

    const impact = await getV3OrientationImpact(env.AUTH_DB, id, legacyGameId);
    const warning = Object.values(impact).some((count) => count > 0);
    const now = new Date().toISOString();
    const updatedBy = access.user?.id ? `admin:${String(access.user.id)}` : "admin";
    const fields = ["home_team = ?1", "away_team = ?2"];
    const values = [homeTeam, awayTeam];
    if (columns.has("updated_at")) {
      fields.push(`updated_at = ?${values.length + 1}`);
      values.push(now);
    }
    if (columns.has("updated_by")) {
      fields.push(`updated_by = ?${values.length + 1}`);
      values.push(updatedBy);
    }
    values.push(id);
    await env.AUTH_DB.prepare(`UPDATE games SET ${fields.join(", ")} WHERE internal_game_id = ?${values.length}`).bind(...values).run();

    const scheduleColumns = await getTableColumnSet(env.AUTH_DB, "detected_game_schedule");
    let scheduleRowsUpdated = 0;
    if (scheduleColumns.has("internal_game_id") && scheduleColumns.has("home_team") && scheduleColumns.has("away_team")) {
      const scheduleFields = ["home_team = ?1", "away_team = ?2"];
      const scheduleValues = [homeTeam, awayTeam];
      if (scheduleColumns.has("updated_at")) {
        scheduleFields.push(`updated_at = ?${scheduleValues.length + 1}`);
        scheduleValues.push(now);
      }
      scheduleValues.push(id);
      const result = await env.AUTH_DB.prepare(`UPDATE detected_game_schedule SET ${scheduleFields.join(", ")} WHERE internal_game_id = ?${scheduleValues.length}`).bind(...scheduleValues).run();
      scheduleRowsUpdated = Number(result?.meta?.changes || 0);
    }

    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_game_orientation_changed",
      status: "success",
      gameId: id,
      message: "管理者が試合のhome/away向きを修正しました。",
      metadata: {
        internalGameId: id,
        previousHomeTeam: String(current.home_team || ""),
        previousAwayTeam: String(current.away_team || ""),
        nextHomeTeam: homeTeam,
        nextAwayTeam: awayTeam,
        reason,
        impact,
        warning,
        scheduleRowsUpdated,
        updatedBy,
        updatedAt: now
      },
      source: operationSource
    });
    const updated = await env.AUTH_DB.prepare(
      "SELECT internal_game_id, game_date, start_time, home_team, away_team, game_status FROM games WHERE internal_game_id = ?1 LIMIT 1"
    ).bind(id).first();
    return jsonResponse({ ok: true, warning, impact, scheduleRowsUpdated, game: serializeV3GameIdentity(updated) }, 200, cors);
  } catch (error) {
    const code = String(error?.code || "V3_ORIENTATION_UPDATE_FAILED");
    console.error(`[GAME_AUTOMATION_V3] stage=orientation_update code=${code}`);
    return jsonResponse({ ok: false, code, error: "試合のhome/away向きを更新できませんでした。" }, 500, cors);
  }
}

async function handleAdminV3JobCreate(request, env, cors, internalGameId) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const input = await readJson(request);
  const jobType = String(input?.jobType || "").trim();
  try {
    const id = normalizeV3InternalGameId(internalGameId);
    if (!V3_JOB_TYPES.includes(jobType)) throw createV3Error("V3_JOB_TYPE_INVALID", "V3ジョブ種別が不正です。");
    const game = (await listV3Games(env.AUTH_DB, new Date())).find((row) => row.internalGameId === id);
    if (!game) throw createV3Error("V3_GAME_NOT_REGISTERED", "V3対象試合が日程DBに登録されていません。");
    if (["lineup_fetch", "lineup_finalize"].includes(jobType)
      && !["resolved", "manually_overridden"].includes(String(game.npbIdentityStatus || ""))) {
      throw createV3Error("NPB_IDENTITY_PENDING", "NPB識別情報が解決するまでスタメン取得ジョブを投入できません。");
    }
    const now = new Date();
    const schedule = deriveV3Schedule(game);
    const created = await createV3Job(env.AUTH_DB, {
      internalGameId: id,
      jobType,
      scheduledAt: now,
      scheduledSlotAt: input?.scheduledSlotAt || now,
      source: "admin"
    });
    return jsonResponse({ ok: true, job: created.job, created: created.created, schedule: {
      predictionDeadline: schedule.predictionDeadline.toISOString(),
      lineupPollingStart: schedule.lineupPollingStart.toISOString(),
      finalLineupAt: schedule.finalLineupAt.toISOString(),
      publicationAt: schedule.publicationAt.toISOString()
    } }, 200, cors);
  } catch (error) {
    const code = String(error?.code || "V3_ADMIN_JOB_CREATE_FAILED");
    const status = code === "V3_GAME_NOT_REGISTERED" ? 404 : 400;
    return jsonResponse({ ok: false, code, error: String(error?.message || "V3ジョブを作成できませんでした。") }, status, cors);
  }
}

function parseAdminV3JobRoute(path) {
  const match = /^\/api\/admin\/v3\/games\/([^/]+)\/jobs$/.exec(path);
  if (!match) return null;
  try {
    return { internalGameId: decodeURIComponent(match[1]) };
  } catch {
    return { internalGameId: "" };
  }
}

function parseAdminV3Phase1Route(path) {
  const match = /^\/api\/admin\/v3\/games\/([^/]+)\/(lineup|lineup-revisions|lineup-finalize|scoring\/preview|scoring\/confirm|ranking|ranking\/rebuild|publication|publication\/publish|publication\/republish|ranking-eligibility|schedule|jobs\/(\d+)(?:\/(retry|cancel))?)$/.exec(path);
  if (!match) return null;
  try {
    return { internalGameId: decodeURIComponent(match[1]), action: match[2], jobId: match[3] || "", jobOperation: match[4] || "" };
  } catch {
    return { internalGameId: "", action: "invalid" };
  }
}

async function loadV3AdminContext(db, internalGameId) {
  const id = normalizeV3InternalGameId(internalGameId);
  const target = await loadV3GameTarget(db, id);
  return {
    id,
    target,
    metadata: {
      gameId: id,
      internalGameId: id,
      date: String(target.game_date || "").slice(0, 10),
      homeCode: String(target.home_team || "").toLowerCase(),
      awayCode: String(target.away_team || "").toLowerCase()
    }
  };
}

function v3AdminErrorResponse(cors, error, fallback = "V3管理操作に失敗しました。") {
  const code = String(error?.code || "V3_ADMIN_OPERATION_FAILED");
  const status = Number(error?.httpStatus) || ({
    V3_GAME_NOT_REGISTERED: 404,
    V3_INTERNAL_GAME_ID_REQUIRED: 400,
    V3_JOB_NOT_FOUND: 404,
    V3_JOB_OPERATION_INVALID: 409,
    V3_REASON_REQUIRED: 400,
    V3_SCHEDULE_UPDATE_FAILED: 409,
    V3_SCHEMA_UNAVAILABLE: 503
  }[code] || 500);
  return jsonResponse({ ok: false, code, error: String(error?.message || fallback) }, status, cors);
}

async function recordV3AdminAudit(db, { internalGameId, jobId = null, jobType = "admin_operation", stateBefore = null, stateAfter = null, failureCode = null, failureMessage = null, occurredAt = new Date() } = {}) {
  try {
    await db.prepare(
      `INSERT INTO game_automation_v3_audit
         (internal_game_id, job_id, job_type, state_before, state_after, attempt_count,
          failure_code, failure_message, occurred_at, source)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, 'admin')`
    ).bind(internalGameId, jobId, jobType, stateBefore, stateAfter, failureCode, failureMessage, occurredAt.toISOString()).run();
  } catch (error) {
    console.error(`[GAME_AUTOMATION_V3] stage=admin_audit code=${error?.code || "V3_ADMIN_AUDIT_FAILED"}`);
  }
}

function parseV3AuditDetails(failureMessage) {
  const text = String(failureMessage || "").trim();
  if (!text) return {};
  const marker = text.indexOf("[v3_details=");
  if (marker >= 0) {
    const json = text.slice(marker + "[v3_details=".length).replace(/\]\s*$/, "");
    try { return JSON.parse(json); } catch { return {}; }
  }
  if (text.startsWith("{")) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  return {};
}

async function handleAdminV3AutomationLogs(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const url = new URL(request.url);
  const filters = {
    runId: String(url.searchParams.get("runId") || "").trim(),
    internalGameId: String(url.searchParams.get("internalGameId") || "").trim(),
    jobType: String(url.searchParams.get("jobType") || "").trim(),
    status: String(url.searchParams.get("status") || "").trim(),
    reasonCode: String(url.searchParams.get("reasonCode") || "").trim(),
    failureCode: String(url.searchParams.get("failureCode") || "").trim()
  };
  const requestedLimit = Number(url.searchParams.get("limit") || 100);
  const limit = Math.max(50, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 100));
  try {
    const result = await env.AUTH_DB.prepare(
      `SELECT id, internal_game_id, job_id, job_type, scheduled_slot_at,
              state_before, state_after, attempt_count, failure_code,
              failure_message, occurred_at, source, event_type
         FROM game_automation_v3_audit
        ORDER BY occurred_at DESC, id DESC
        LIMIT 500`
    ).all();
    const allRows = (result.results || []).map((row) => {
      const details = parseV3AuditDetails(row.failure_message);
      return {
        id: row.id,
        internalGameId: row.internal_game_id,
        jobId: row.job_id,
        jobType: row.job_type,
        scheduledSlotAt: row.scheduled_slot_at,
        stateBefore: row.state_before,
        stateAfter: row.state_after,
        attemptCount: Number(row.attempt_count || 0),
        failureCode: row.failure_code || details.failureCode || null,
        failureMessage: row.failure_message || details.failureMessage || null,
        occurredAt: row.occurred_at,
        source: row.source,
        eventType: row.event_type || "job",
        details
      };
    });
    const matches = (row) => {
      const detailStatus = String(row.details?.status || row.stateAfter || "");
      const detailReason = String(row.details?.reasonCode || row.details?.plannerDecision?.reasonCode || "");
      return (!filters.runId || String(row.details?.runId || "") === filters.runId)
        && (!filters.internalGameId || String(row.internalGameId || "") === filters.internalGameId)
        && (!filters.jobType || String(row.jobType || "") === filters.jobType)
        && (!filters.status || detailStatus === filters.status)
        && (!filters.reasonCode || detailReason === filters.reasonCode)
        && (!filters.failureCode || String(row.failureCode || "") === filters.failureCode);
    };
    const rows = allRows.filter(matches).slice(0, limit);
    const latestCronSummary = allRows.find((row) => row.eventType === "cron_run_summary") || null;
    const runMap = new Map();
    for (const row of allRows) {
      const runKey = String(row.details?.runId || "");
      if (!runKey || row.eventType === "cron_run_summary") continue;
      const run = runMap.get(runKey) || { runId: runKey, correlationId: row.details?.correlationId || runKey, internalGameIds: new Set(), events: 0, latestOccurredAt: row.occurredAt, failureCount: 0 };
      if (row.internalGameId) run.internalGameIds.add(row.internalGameId);
      run.events += 1;
      run.latestOccurredAt = run.latestOccurredAt > row.occurredAt ? run.latestOccurredAt : row.occurredAt;
      if (row.failureCode || ["failed", "retry_wait"].includes(String(row.details?.status || ""))) run.failureCount += 1;
      runMap.set(runKey, run);
    }
    const gameRuns = [...runMap.values()].map((run) => ({ ...run, internalGameIds: [...run.internalGameIds] })).slice(0, 100);
    return jsonResponse({ ok: true, filters, limit, rows, latestCronSummary, gameRuns, jobTimeline: rows.filter((row) => row.jobId !== null) }, 200, cors);
  } catch (error) {
    console.error(`[ADMIN_V3_AUTOMATION_LOGS] stage=read failureCode=${error?.code || "V3_AUTOMATION_LOG_READ_FAILED"}`);
    return jsonResponse({ ok: false, code: "V3_AUTOMATION_LOG_READ_FAILED", error: "V3自動運転ログを取得できませんでした。" }, 500, cors);
  }
}

async function getV3LineupRevisionRows(db, gameId, internalGameId) {
  const columns = await getTableColumnSet(db, "game_lineup_revisions");
  if (internalGameId && !columns.has("internal_game_id")) return [];
  const where = columns.has("internal_game_id") && internalGameId ? "internal_game_id = ?1" : "game_id = ?1";
  const bindings = [columns.has("internal_game_id") && internalGameId ? internalGameId : gameId];
  const rows = await db.prepare(`SELECT * FROM game_lineup_revisions WHERE ${where} ORDER BY version DESC`).bind(...bindings).all();
  return rows.results || [];
}

function serializeV3LineupRevision(row, previous = null) {
  const result = serializeLineupRevision(row);
  result.lineup = parseStoredActualLineup(row.actual_lineup_json) || [];
  if (previous) {
    const previousLineup = parseStoredActualLineup(previous.actual_lineup_json) || [];
    result.changed = JSON.stringify(result.lineup) !== JSON.stringify(previousLineup);
    result.previousRevisionId = previous.revision_id || `${previous.game_id}:${Number(previous.version)}`;
  } else {
    result.changed = true;
    result.previousRevisionId = null;
  }
  return result;
}

async function getV3Job(db, internalGameId, jobId) {
  return db.prepare("SELECT * FROM game_jobs_v3 WHERE id = ?1 AND internal_game_id = ?2 LIMIT 1").bind(Number(jobId), internalGameId).first();
}

async function createV3AdminActionJob(db, internalGameId, jobType, now, source = "admin", { allowAfterCompleted = false, scheduledSlotAt = null } = {}) {
  const open = await db.prepare(
    `SELECT * FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = ?2
       AND status IN ('pending', 'claimed', 'retry_wait') ORDER BY id DESC LIMIT 1`
  ).bind(internalGameId, jobType).first();
  if (open) return { created: false, noOp: true, job: open };
  const completed = await db.prepare(
    `SELECT * FROM game_jobs_v3 WHERE internal_game_id = ?1 AND job_type = ?2
       AND status = 'completed' ORDER BY id DESC LIMIT 1`
  ).bind(internalGameId, jobType).first();
  if (completed && !allowAfterCompleted) return { created: false, noOp: true, job: completed };
  return createV3Job(db, { internalGameId, jobType, scheduledAt: now, scheduledSlotAt: scheduledSlotAt || now, source });
}

async function invokeV3RescoreCore(requestBody, env, cors, metadata, user, action, options = {}) {
  const request = new Request("https://starting9.internal/api/admin/v3/rescore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody)
  });
  const response = action === "preview"
    ? await handleAdminRescorePreview(request, env, cors, metadata, user)
    : await handleAdminRescoreConfirm(request, env, cors, metadata, user, options);
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function handleAdminV3Phase1Route(request, env, cors, route) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  if (route.action === "invalid") return jsonResponse({ ok: false, code: "V3_INTERNAL_GAME_ID_REQUIRED", error: "internalGameIdが不正です。" }, 400, cors);
  let context;
  try {
    context = await loadV3AdminContext(env.AUTH_DB, route.internalGameId);
  } catch (error) {
    return v3AdminErrorResponse(cors, error, "対象試合を取得できませんでした。");
  }
  try {
    const { id, target, metadata } = context;
    if (route.action === "lineup" && request.method === "GET") return await handleAdminV3LineupGet(env, cors, context);
    if (route.action === "lineup-revisions" && request.method === "GET") return await handleAdminV3LineupRevisionsGet(env, cors, context);
    if (route.action === "lineup-revisions" && request.method === "POST") return await handleAdminV3LineupRevisionCreate(request, env, cors, context, access.user);
    if (route.action === "lineup-finalize" && request.method === "POST") return await handleAdminV3LineupFinalize(request, env, cors, context, access.user);
    if (route.action === "scoring/preview" && request.method === "POST") return await handleAdminV3ScoringPreview(request, env, cors, context, access.user);
    if (route.action === "scoring/confirm" && request.method === "POST") return await handleAdminV3ScoringConfirm(request, env, cors, context, access.user);
    if (route.action === "ranking" && request.method === "GET") return await handleAdminV3RankingGet(env, cors, context);
    if (route.action === "ranking/rebuild" && request.method === "POST") return await handleAdminV3RankingRebuild(request, env, cors, context, access.user);
    if (route.action === "publication" && request.method === "GET") return await handleAdminV3PublicationGet(env, cors, context);
    if (["publication/publish", "publication/republish"].includes(route.action) && request.method === "POST") return await handleAdminV3PublicationQueue(request, env, cors, context, access.user, route.action.endsWith("republish"));
    if (route.action === "ranking-eligibility" && request.method === "GET") return await handleAdminV3EligibilityGet(env, cors, context);
    if (route.action === "ranking-eligibility" && request.method === "PUT") return await handleAdminV3EligibilityUpdate(request, env, cors, context, access.user);
    if (route.action === "schedule" && request.method === "GET") return await handleAdminV3ScheduleGet(env, cors, context);
    if (route.action === "schedule" && request.method === "PUT") return await handleAdminV3ScheduleUpdate(request, env, cors, context, access.user);
    if (route.action.startsWith("jobs/") && request.method === "GET") return await handleAdminV3JobDetail(env, cors, context, route.jobId);
    if (route.action.startsWith("jobs/") && request.method === "POST" && route.jobOperation === "retry") return await handleAdminV3JobRetry(request, env, cors, context, route.jobId, access.user);
    if (route.action.startsWith("jobs/") && request.method === "POST" && route.jobOperation === "cancel") return await handleAdminV3JobCancel(request, env, cors, context, route.jobId, access.user);
    return jsonResponse({ ok: false, code: "V3_ADMIN_METHOD_NOT_ALLOWED", error: "V3管理APIのHTTPメソッドが不正です。" }, 405, cors);
  } catch (error) {
    await recordV3AdminAudit(env.AUTH_DB, {
      internalGameId: context.id,
      jobType: `admin:${route.action}`,
      failureCode: String(error?.code || "V3_ADMIN_OPERATION_FAILED"),
      failureMessage: String(error?.message || "V3管理操作に失敗しました。").slice(0, 240)
    });
    return v3AdminErrorResponse(cors, error);
  }
}

async function handleAdminV3LineupGet(env, cors, context) {
  const lineup = await getGameLineup(env.AUTH_DB, context.metadata);
  const rows = await getV3LineupRevisionRows(env.AUTH_DB, context.metadata.gameId, context.id);
  const current = rows.find((row) => Number(row.is_current) === 1) || rows[0] || null;
  const final = rows.find((row) => Number(row.is_final) === 1) || null;
  return jsonResponse({
    ok: true,
    internalGameId: context.id,
    lineup: serializeGameLineup(lineup),
    currentRevision: current ? serializeV3LineupRevision(current, rows[rows.indexOf(current) + 1] || null) : null,
    finalRevision: final ? serializeV3LineupRevision(final) : null,
    lineupStatus: lineup?.scoring_status || (final ? "finalized" : "pending"),
    finalizedAt: lineup?.finalized_at || final?.finalized_at || null,
    finalizedBy: lineup?.finalized_by || final?.finalized_by || null
  }, 200, cors);
}

async function handleAdminV3LineupRevisionsGet(env, cors, context) {
  const rows = await getV3LineupRevisionRows(env.AUTH_DB, context.metadata.gameId, context.id);
  return jsonResponse({
    ok: true,
    internalGameId: context.id,
    revisions: rows.map((row, index) => serializeV3LineupRevision(row, rows[index + 1] || null))
  }, 200, cors);
}

async function handleAdminV3LineupRevisionCreate(request, env, cors, context, user) {
  const input = await readJson(request);
  const reason = String(input?.reason || "").trim();
  if (!reason || reason.length > 240) throw createV3Error("V3_REASON_REQUIRED", "スタメン修正理由を1〜240文字で入力してください。", { httpStatus: 400 });
  const actual = sanitizeActualLineupForScoring(input?.lineup || input?.actualLineup, { allowUnresolvedPlayer: true });
  if (!actual.ok) throw createV3Error("V3_LINEUP_INVALID", actual.error, { httpStatus: 400 });
  const rows = await getV3LineupRevisionRows(env.AUTH_DB, context.metadata.gameId, context.id);
  const latest = rows[0] || null;
  const fingerprint = await sha256Base64Url(JSON.stringify(actual.lineup));
  if (latest && latest.lineup_fingerprint === fingerprint) {
    return jsonResponse({ ok: true, internalGameId: context.id, noOp: true, revision: serializeV3LineupRevision(latest) }, 200, cors);
  }
  const revision = await saveLineupCandidateRevision(env.AUTH_DB, {
    gameId: context.metadata.gameId,
    internalGameId: context.id,
    lineup: actual.lineup,
    source: "admin",
    capturedAt: new Date(),
    reason,
    createdBy: user.id,
    validation: { source: "admin", playerCount: actual.lineup.length, unresolvedPlayerCount: actual.lineup.filter((row) => !row.playerId).length },
    allowUnresolvedPlayer: true
  });
  await recordWorkflowLog(env.AUTH_DB, { eventType: "v3_admin_lineup_revision", status: "success", gameId: context.metadata.gameId, occurredAt: new Date(), message: "V3管理者がスタメンrevisionを作成しました。", metadata: { internalGameId: context.id, revisionId: revision.revision_id || `${context.metadata.gameId}:${revision.version}` }, source: "admin" });
  await recordV3AdminAudit(env.AUTH_DB, { internalGameId: context.id, jobType: "admin:lineup_revision" });
  return jsonResponse({ ok: true, internalGameId: context.id, noOp: false, revision: serializeV3LineupRevision(revision) }, 201, cors);
}

async function handleAdminV3LineupFinalize(request, env, cors, context, user) {
  const input = await readJson(request);
  const reason = String(input?.reason || "").trim();
  if (!reason || reason.length > 240) throw createV3Error("V3_REASON_REQUIRED", "正式スタメン確定理由を1〜240文字で入力してください。", { httpStatus: 400 });
  const rows = await getV3LineupRevisionRows(env.AUTH_DB, context.metadata.gameId, context.id);
  const requestedId = String(input?.lineupRevisionId || input?.revisionId || "");
  const requestedVersion = Number(input?.version);
  const revision = rows.find((row) => (requestedId && (row.revision_id === requestedId || `${row.game_id}:${Number(row.version)}` === requestedId)) || (Number.isInteger(requestedVersion) && Number(row.version) === requestedVersion));
  if (!revision) throw createV3Error("V3_LINEUP_REVISION_NOT_FOUND", "正式スタメンrevisionが見つかりません。", { httpStatus: 404 });
  const actual = sanitizeActualLineupForScoring(parseStoredActualLineup(revision.actual_lineup_json));
  if (!actual.ok) throw createV3Error("V3_LINEUP_INVALID", actual.error, { httpStatus: 409 });
  const currentLineup = await getGameLineup(env.AUTH_DB, context.metadata);
  const currentFinalRevisionId = String(currentLineup?.final_lineup_revision_id || "");
  const requestedRevisionId = String(revision.revision_id || `${revision.game_id}:${Number(revision.version)}`);
  if (currentFinalRevisionId === requestedRevisionId && Number(revision.is_final || 0) === 1) {
    return jsonResponse({ ok: true, internalGameId: context.id, noOp: true, finalizedRevision: serializeV3LineupRevision(revision) }, 200, cors);
  }
  if (currentLineup?.scoring_status === "processing") {
    throw createV3Error("V3_LINEUP_FINALIZE_IN_PROGRESS", "採点中は別のスタメンrevisionへ差し替えできません。", { httpStatus: 409 });
  }
  if (!currentLineup || currentLineup.scoring_status !== "scored") {
    await saveActualLineupForAutoScoring(env.AUTH_DB, context.metadata.gameId, actual.lineup, new Date(), { allowAfterStart: true, now: new Date(), source: "manual", internalGameId: context.id, scoringDueAt: new Date() });
  }
  await activateLineupRevision(env.AUTH_DB, { gameId: context.metadata.gameId, internalGameId: context.id, version: Number(revision.version), finalizedAt: new Date(), finalizedBy: "admin" });
  await linkFinalLineupRevision(env.AUTH_DB, { gameId: context.metadata.gameId, internalGameId: context.id, version: Number(revision.version), finalizedAt: new Date(), finalizedBy: "admin" });
  const state = await env.AUTH_DB.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1").bind(context.id).first();
  await recordV3AdminAudit(env.AUTH_DB, { internalGameId: context.id, jobType: "admin:lineup_finalize", stateBefore: state?.state || null, stateAfter: "lineup_ready" });
  const scoreJob = currentLineup?.scoring_status === "scored" ? null : await createV3AdminActionJob(env.AUTH_DB, context.id, "score", new Date());
  return jsonResponse({ ok: true, internalGameId: context.id, finalizedRevision: serializeV3LineupRevision({ ...revision, is_final: 1, is_current: 1, finalized_by: "admin", finalized_at: new Date().toISOString() }), scoreJob, rescoreRequired: currentLineup?.scoring_status === "scored" }, 200, cors);
}

function v3RescoreBody(input, context) {
  return {
    gameId: context.metadata.gameId,
    gameDate: context.metadata.date,
    homeTeam: context.metadata.homeCode,
    awayTeam: context.metadata.awayCode,
    lineupVersion: Number(input?.lineupVersion || input?.version),
    reason: String(input?.reason || "").trim(),
    previewId: input?.previewId || ""
  };
}

async function handleAdminV3ScoringPreview(request, env, cors, context, user) {
  const input = await readJson(request);
  const body = v3RescoreBody(input, context);
  if (!body.reason) throw createV3Error("V3_REASON_REQUIRED", "再採点理由を入力してください。", { httpStatus: 400 });
  const current = await ensureCurrentLineupRevision(env.AUTH_DB, context.metadata);
  if (!Number.isInteger(body.lineupVersion)) body.lineupVersion = Number(current.version);
  const result = await invokeV3RescoreCore(body, env, cors, context.metadata, user, "preview");
  if (!result.payload?.ok) return jsonResponse({ ...result.payload, internalGameId: context.id }, result.response.status, cors);
  const activeScoringRevision = await getActiveScoringRevision(env.AUTH_DB, context.id);
  const previewRow = await env.AUTH_DB.prepare(
    "SELECT summary_json FROM game_rescore_previews WHERE id = ?1 AND game_id = ?2 LIMIT 1"
  ).bind(result.payload.previewId, context.metadata.gameId).first();
  let previewSummary = {};
  try { previewSummary = JSON.parse(previewRow?.summary_json || "{}"); } catch { previewSummary = {}; }
  previewSummary.v3Lineage = {
    internalGameId: context.id,
    lineupRevisionId: `${context.metadata.gameId}:${Number(result.payload.lineupVersion)}`,
    scoringRevisionId: activeScoringRevision?.id || "legacy"
  };
  await env.AUTH_DB.prepare(
    "UPDATE game_rescore_previews SET summary_json = ?1 WHERE id = ?2 AND game_id = ?3"
  ).bind(JSON.stringify(previewSummary), result.payload.previewId, context.metadata.gameId).run();
  await recordV3AdminAudit(env.AUTH_DB, { internalGameId: context.id, jobType: "admin:scoring_preview" });
  return jsonResponse({ ...result.payload, internalGameId: context.id, scoringRevisionId: activeScoringRevision?.id || "legacy" }, result.response.status, cors);
}

async function handleAdminV3ScoringConfirm(request, env, cors, context, user) {
  const input = await readJson(request);
  const body = v3RescoreBody(input, context);
  if (!body.reason) throw createV3Error("V3_REASON_REQUIRED", "再採点理由を入力してください。", { httpStatus: 400 });
  await assertV3RescoreLineage(env.AUTH_DB, context, body);
  const result = await invokeV3RescoreCore(body, env, cors, context.metadata, user, "confirm", { deferPublication: true });
  if (!result.payload?.ok) return jsonResponse({ ...result.payload, internalGameId: context.id }, result.response.status, cors);
  await recordV3AdminAudit(env.AUTH_DB, { internalGameId: context.id, jobType: "admin:scoring_confirm", stateAfter: "scored" });
  return jsonResponse({ ...result.payload, internalGameId: context.id }, result.response.status, cors);
}

async function assertV3RescoreLineage(db, context, body) {
  const row = await db.prepare(
    `SELECT previews.summary_json, jobs.internal_game_id
       FROM game_rescore_previews previews
       LEFT JOIN game_rescore_jobs jobs ON jobs.id = previews.id
      WHERE previews.id = ?1 AND previews.game_id = ?2 LIMIT 1`
  ).bind(String(body.previewId || ""), context.metadata.gameId).first();
  if (!row) throw createV3Error("RESCORE_PREVIEW_INVALID", "再採点プレビューを確認してください。", { httpStatus: 409 });
  let lineage = null;
  try { lineage = JSON.parse(row.summary_json || "{}").v3Lineage || null; } catch { lineage = null; }
  if (lineage && String(lineage.internalGameId || "") !== context.id) {
    throw createV3Error("RESCORE_PREVIEW_INVALID", "再採点プレビューの試合が一致しません。", { httpStatus: 409 });
  }
  if (row.internal_game_id && String(row.internal_game_id) !== context.id) {
    throw createV3Error("RESCORE_PREVIEW_INVALID", "再採点jobの試合が一致しません。", { httpStatus: 409 });
  }
  const active = await getActiveScoringRevision(db, context.id);
  const expectedScoringRevisionId = String(lineage?.scoringRevisionId || "legacy");
  if (expectedScoringRevisionId !== String(active?.id || "legacy")) {
    throw createV3Error("RESCORE_SCORING_REVISION_CHANGED", "採点revisionが変わりました。再プレビューしてください。", { httpStatus: 409 });
  }
}

async function handleAdminV3RankingGet(env, cors, context) {
  const ranking = await getRankingGameState(env.AUTH_DB, context.metadata.gameId, context.id);
  const completion = await getScoringCompletionState(env.AUTH_DB, context.metadata);
  const activeRevision = await getActiveScoringRevision(env.AUTH_DB, context.id);
  let noOpReason = null;
  let rankingNoOpReason = null;
  try {
    const noOpAudit = await env.AUTH_DB.prepare(
      `SELECT event_type, failure_message FROM game_automation_v3_audit
         WHERE internal_game_id = ?1 AND (event_type = 'scoring_no_op' OR event_type = 'ranking_no_op')
         ORDER BY occurred_at DESC LIMIT 1`
    ).bind(context.id).first();
    if (noOpAudit?.event_type === "ranking_no_op") rankingNoOpReason = noOpAudit.failure_message || null;
    else noOpReason = noOpAudit?.failure_message || null;
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  let reflection = null;
  try {
    reflection = await env.AUTH_DB.prepare(
      `SELECT id, scoring_revision_id, ranking_eligibility_version, ranking_update_revision, status, reflected_at
         FROM ranking_reflection_revisions WHERE internal_game_id = ?1 ORDER BY ranking_update_revision DESC LIMIT 1`
    ).bind(context.id).first();
  } catch (error) { if (!isPregameSchemaError(error)) throw error; }
  return jsonResponse({ ok: true, internalGameId: context.id, ranking: ranking ? {
    gameStatus: ranking.game_status, publicationStatus: ranking.publication_status,
    rankingEligible: Number(ranking.is_ranking_eligible || 0) === 1,
    scoredPrivateAt: ranking.scored_private_at, publishedAt: ranking.published_at
  } : null, scoring: { ...completion, noOpReason }, rankingNoOpReason, activeScoringRevision: activeRevision, reflection }, 200, cors);
}

async function handleAdminV3RankingRebuild(request, env, cors, context, user) {
  const input = await readJson(request);
  const reason = String(input?.reason || "").trim();
  if (!reason || reason.length > 240) throw createV3Error("V3_REASON_REQUIRED", "ランキング再構築理由を入力してください。", { httpStatus: 400 });
  const completion = await getScoringCompletionState(env.AUTH_DB, context.metadata);
  if (!completion.complete) throw createV3Error("V3_SCORING_INCOMPLETE", "全予想の採点が完了していません。", { httpStatus: 409 });
  const activeRevision = await getActiveScoringRevision(env.AUTH_DB, context.id);
  let reflectedRevision = null;
  try {
    reflectedRevision = await env.AUTH_DB.prepare(
      `SELECT scoring_revision_id FROM ranking_reflection_revisions
        WHERE internal_game_id = ?1 AND status = 'reflected' ORDER BY ranking_update_revision DESC LIMIT 1`
    ).bind(context.id).first();
  } catch (error) { if (!isPregameSchemaError(error)) throw error; }
  if (activeRevision?.id && reflectedRevision?.scoring_revision_id === activeRevision.id) {
    return jsonResponse({ ok: true, internalGameId: context.id, noOp: true, reason, reflectedRevision: activeRevision.id }, 200, cors);
  }
  const job = await createV3AdminActionJob(env.AUTH_DB, context.id, "ranking_rebuild", new Date(), "admin", {
    allowAfterCompleted: true,
    scheduledSlotAt: activeRevision?.created_at || deriveV3Schedule(context.target).publicationAt
  });
  await recordWorkflowLog(env.AUTH_DB, { eventType: "v3_admin_ranking_rebuild", status: "info", gameId: context.metadata.gameId, occurredAt: new Date(), message: "V3管理者がランキング再構築jobを投入しました。", metadata: { internalGameId: context.id, reason }, source: "admin" });
  await recordV3AdminAudit(env.AUTH_DB, { internalGameId: context.id, jobId: job.job?.id || null, jobType: "admin:ranking_rebuild" });
  return jsonResponse({ ok: true, internalGameId: context.id, job, reason }, 202, cors);
}

async function handleAdminV3PublicationGet(env, cors, context) {
  const lineup = await getGameLineup(env.AUTH_DB, context.metadata);
  const ranking = await getRankingGameState(env.AUTH_DB, context.metadata.gameId, context.id);
  let publishedLineupRevision = null;
  let publishedScoringRevision = null;
  try {
    const finalRevision = await env.AUTH_DB.prepare(
      `SELECT version, revision_id, source, finalized_at
         FROM game_lineup_revisions
         WHERE internal_game_id = ?1 AND is_final = 1
         ORDER BY version DESC LIMIT 1`
    ).bind(context.id).first();
    publishedLineupRevision = finalRevision || null;
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  try {
    const activeRevision = await getActiveScoringRevision(env.AUTH_DB, context.id);
    publishedScoringRevision = activeRevision || null;
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  return jsonResponse({ ok: true, internalGameId: context.id, publication: {
    status: lineup?.publication_status || ranking?.publication_status || "pending",
    publishedAt: lineup?.published_at || ranking?.published_at || null,
    scoringStatus: lineup?.scoring_status || null,
    rankingStatus: ranking?.game_status || null,
    lastError: lineup?.last_error || null,
    publishedLineupRevision,
    publishedScoringRevision
  } }, 200, cors);
}

async function handleAdminV3PublicationQueue(request, env, cors, context, user, republish = false) {
  const input = await readJson(request);
  const reason = String(input?.reason || "").trim();
  if (!reason || reason.length > 240) throw createV3Error("V3_REASON_REQUIRED", "公開理由を入力してください。", { httpStatus: 400 });
  const lineup = await getGameLineup(env.AUTH_DB, context.metadata);
  const revisions = await getV3LineupRevisionRows(env.AUTH_DB, context.metadata.gameId, context.id);
  const finalRevision = revisions.find((row) => Number(row.is_final) === 1) || null;
  const ranking = await getRankingGameState(env.AUTH_DB, context.metadata.gameId, context.id);
  const completion = await getScoringCompletionState(env.AUTH_DB, context.metadata);
  const activeRevision = await getActiveScoringRevision(env.AUTH_DB, context.id);
  let reflectedRevision = null;
  try {
    reflectedRevision = await env.AUTH_DB.prepare(
      `SELECT scoring_revision_id FROM ranking_reflection_revisions
        WHERE internal_game_id = ?1 AND status = 'reflected' ORDER BY ranking_update_revision DESC LIMIT 1`
    ).bind(context.id).first();
  } catch (error) { if (!isPregameSchemaError(error)) throw error; }
  if (!finalRevision || !lineup || lineup.scoring_status !== "scored" || !completion.complete || !ranking || String(ranking.publication_status || "") === "pending") {
    throw createV3Error("V3_PUBLICATION_PREREQUISITE_MISSING", "採点・ランキング反映済みの公開対象がありません。", { httpStatus: 409 });
  }
  if (!activeRevision?.id || reflectedRevision?.scoring_revision_id !== activeRevision.id) {
    throw createV3Error("V3_RANKING_REVISION_NOT_REFLECTED", "現在の採点revisionがランキングへ反映されていません。", { httpStatus: 409 });
  }
  if (!republish && String(lineup.publication_status || "") === "published") {
    return jsonResponse({ ok: true, internalGameId: context.id, noOp: true, publicationStatus: "published" }, 200, cors);
  }
  if (republish && String(lineup.publication_status || "") === "published") {
    const activeRevision = await getActiveScoringRevision(env.AUTH_DB, context.id);
    const reflected = await env.AUTH_DB.prepare(
      `SELECT scoring_revision_id FROM ranking_reflection_revisions
        WHERE internal_game_id = ?1 AND status = 'reflected' ORDER BY ranking_update_revision DESC LIMIT 1`
    ).bind(context.id).first();
    if (!activeRevision?.id || reflected?.scoring_revision_id === activeRevision.id) {
      return jsonResponse({ ok: true, internalGameId: context.id, noOp: true, publicationStatus: "published" }, 200, cors);
    }
  }
  const job = await createV3AdminActionJob(env.AUTH_DB, context.id, "publish", new Date(), "admin", {
    allowAfterCompleted: republish,
    scheduledSlotAt: activeRevision.created_at || deriveV3Schedule(context.target).publicationAt
  });
  await recordWorkflowLog(env.AUTH_DB, { eventType: republish ? "v3_admin_republish" : "v3_admin_publish", status: "info", gameId: context.metadata.gameId, occurredAt: new Date(), message: republish ? "V3管理者が結果再公開jobを投入しました。" : "V3管理者が結果公開jobを投入しました。", metadata: { internalGameId: context.id, reason }, source: "admin" });
  await recordV3AdminAudit(env.AUTH_DB, { internalGameId: context.id, jobId: job.job?.id || null, jobType: republish ? "admin:republish" : "admin:publish" });
  return jsonResponse({ ok: true, internalGameId: context.id, job, republish, reason }, 202, cors);
}

async function handleAdminV3EligibilityGet(env, cors, context) {
  return jsonResponse({ ok: true, internalGameId: context.id, rankingEligibility: await getRankingEligibilityState(env.AUTH_DB, context.metadata.gameId, context.id) }, 200, cors);
}

async function handleAdminV3EligibilityUpdate(request, env, cors, context, user) {
  const input = await readJson(request);
  const status = String(input?.status || "").trim().toLowerCase();
  const reason = String(input?.reason || "").trim();
  if (!reason || reason.length > 240) throw createV3Error("V3_REASON_REQUIRED", "ランキング対象状態の変更理由を入力してください。", { httpStatus: 400 });
  if (!Object.values(RANKING_ELIGIBILITY_STATUS).includes(status)) throw createV3Error("V3_RANKING_ELIGIBILITY_INVALID", "ランキング対象状態が不正です。", { httpStatus: 400 });
  const previous = await getRankingEligibilityState(env.AUTH_DB, context.metadata.gameId, context.id);
  if (previous && previous.rankingEligibilityStatus === status && String(previous.rankingEligibilityReason || "") === reason && String(previous.rankingEligibilityNote || "") === String(input?.note || "").trim()) {
    return jsonResponse({ ok: true, internalGameId: context.id, noOp: true, rankingEligibility: previous }, 200, cors);
  }
  const eligibility = await setRankingEligibility(env.AUTH_DB, { gameId: context.metadata.gameId, internalGameId: context.id, status, reason, note: String(input?.note || "").trim(), updatedBy: `admin:${user.id}`, now: new Date() });
  const rankingJob = await createV3AdminActionJob(env.AUTH_DB, context.id, "ranking_rebuild", new Date(), "admin", {
    allowAfterCompleted: true,
    scheduledSlotAt: eligibility?.rankingEligibilityUpdatedAt || new Date()
  });
  await recordV3AdminAudit(env.AUTH_DB, { internalGameId: context.id, jobType: "admin:ranking_eligibility", stateAfter: status });
  return jsonResponse({ ok: true, internalGameId: context.id, rankingEligibility: eligibility, rankingJob }, 200, cors);
}

async function handleAdminV3ScheduleGet(env, cors, context) {
  const schedule = deriveV3Schedule(context.target);
  return jsonResponse({ ok: true, internalGameId: context.id, schedule: {
    gameDate: context.target.game_date, startAt: schedule.startAt.toISOString(),
    predictionDeadline: schedule.predictionDeadline.toISOString(),
    lineupPollingStart: schedule.lineupPollingStart.toISOString(),
    finalLineupAt: schedule.finalLineupAt.toISOString(), publicationAt: schedule.publicationAt.toISOString(),
    homeTeam: context.target.home_team, awayTeam: context.target.away_team,
    gameStatus: context.target.gameStatus, isActive: context.target.isActive
  } }, 200, cors);
}

async function handleAdminV3ScheduleUpdate(request, env, cors, context, user) {
  const input = await readJson(request);
  const reason = String(input?.reason || "").trim();
  if (!reason || reason.length > 240) throw createV3Error("V3_REASON_REQUIRED", "日程変更理由を入力してください。", { httpStatus: 400 });
  const body = {
    startAt: input?.startAt,
    gameDate: context.target.game_date,
    homeTeam: context.target.home_team,
    awayTeam: context.target.away_team,
    status: context.target.gameStatus || "scheduled",
    npbGameCode: context.target.gameCode || "",
    stadium: context.target.stadium || "",
    reason
  };
  const synthetic = new Request("https://starting9.internal/api/admin/v3/schedule", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const response = await handleAdminGameScheduleUpdate(synthetic, env, cors, context.metadata, user);
  const payload = await response.json().catch(() => ({}));
  if (!payload?.ok) return jsonResponse({ ...payload, internalGameId: context.id }, response.status, cors);
  const pendingJobsRescheduled = await reschedulePendingV3Jobs(env.AUTH_DB, context.id, payload.schedule);
  await recordV3AdminAudit(env.AUTH_DB, { internalGameId: context.id, jobType: "admin:schedule", stateBefore: context.target.gameStatus || null });
  return jsonResponse({ ...payload, internalGameId: context.id, pendingJobsRescheduled }, response.status, cors);
}

async function reschedulePendingV3Jobs(db, internalGameId, schedule) {
  const slots = {
    prediction_close: schedule?.predictionDeadline,
    lineup_fetch: schedule?.lineupPollingStart,
    lineup_finalize: schedule?.finalLineupAt,
    score: schedule?.finalLineupAt,
    ranking_rebuild: schedule?.publicationAt,
    publish: schedule?.publicationAt
  };
  let changed = 0;
  for (const [jobType, value] of Object.entries(slots)) {
    if (!value) continue;
    const result = await db.prepare(
      `UPDATE game_jobs_v3 SET scheduled_at = ?1, scheduled_slot_at = ?1, updated_at = ?2
        WHERE internal_game_id = ?3 AND job_type = ?4 AND status = 'pending'`
    ).bind(value, new Date().toISOString(), internalGameId, jobType).run();
    changed += Number(result?.meta?.changes || 0);
  }
  return changed;
}

async function handleAdminV3JobDetail(env, cors, context, jobId) {
  const job = await getV3Job(env.AUTH_DB, context.id, jobId);
  if (!job) throw createV3Error("V3_JOB_NOT_FOUND", "V3ジョブが見つかりません。", { httpStatus: 404 });
  const audits = await env.AUTH_DB.prepare(
    `SELECT id, job_id, job_type, state_before, state_after, attempt_count, failure_code, failure_message, occurred_at, source, event_type
       FROM game_automation_v3_audit WHERE internal_game_id = ?1 AND job_id = ?2 ORDER BY occurred_at DESC LIMIT 20`
  ).bind(context.id, Number(jobId)).all();
  let pipelineEvents = [];
  try {
    const events = await env.AUTH_DB.prepare(
      `SELECT event_type, status, error_code, metadata, occurred_at
         FROM game_workflow_logs
        WHERE game_id = ?1
        ORDER BY occurred_at DESC LIMIT 50`
    ).bind(context.id).all();
    pipelineEvents = (events.results || []).map((event) => ({
      eventType: event.event_type,
      status: event.status,
      errorCode: event.error_code || null,
      occurredAt: event.occurred_at || null,
      metadata: parseWorkflowLogMetadata(event.metadata)
    })).filter((event) => String(event.metadata?.jobId || "") === String(jobId));
  } catch (error) {
    console.error(`[ADMIN_V3_JOB_DETAIL] internalGameId=${context.id} jobId=${jobId} stage=pipeline_event_read failureCode=${error?.code || "V3_PIPELINE_EVENT_READ_FAILED"}`);
  }
  const latestPipelineEvent = pipelineEvents[0] || null;
  const pipelineDiagnostics = latestPipelineEvent?.metadata?.planningDiagnostics || null;
  const auditRows = (audits.results || []).map((audit) => ({
    ...audit,
    details: parseV3AuditDetails(audit.failure_message)
  }));
  return jsonResponse({ ok: true, internalGameId: context.id, job, audits: auditRows, pipelineEvents, pipelineDiagnostics }, 200, cors);
}

async function requireV3JobReason(request) {
  const input = await readJson(request);
  const reason = String(input?.reason || "").trim();
  if (!reason || reason.length > 240) throw createV3Error("V3_REASON_REQUIRED", "job操作理由を1〜240文字で入力してください。", { httpStatus: 400 });
  return reason;
}

async function handleAdminV3JobRetry(request, env, cors, context, jobId, user) {
  const reason = await requireV3JobReason(request);
  const before = await getV3Job(env.AUTH_DB, context.id, jobId);
  const result = await env.AUTH_DB.prepare(
    `UPDATE game_jobs_v3 SET status = 'pending', next_retry_at = NULL, claimed_at = NULL,
        lease_expires_at = NULL, claim_token = NULL, failure_code = NULL, failure_message = NULL, updated_at = ?1
      WHERE id = ?2 AND internal_game_id = ?3 AND status IN ('failed', 'retry_wait') AND attempt_count < max_attempts`
  ).bind(new Date().toISOString(), Number(jobId), context.id).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw createV3Error("V3_JOB_OPERATION_INVALID", "このjobは再試行できない状態です。", { httpStatus: 409 });
  const job = await getV3Job(env.AUTH_DB, context.id, jobId);
  await recordV3AdminAudit(env.AUTH_DB, {
    internalGameId: context.id,
    jobId: Number(jobId),
    jobType: "admin:job_retry",
    stateBefore: before?.status || null,
    stateAfter: job?.status || "pending",
    failureCode: before?.failure_code || null,
    failureMessage: before?.failure_message || null
  });
  await recordWorkflowLog(env.AUTH_DB, { eventType: "v3_admin_job_retry", status: "info", gameId: context.metadata.gameId, occurredAt: new Date(), message: "V3管理者がjobを再試行可能状態へ戻しました。", metadata: { internalGameId: context.id, jobId: Number(jobId), reason, updatedBy: user.id }, source: "admin" });
  return jsonResponse({ ok: true, internalGameId: context.id, job }, 200, cors);
}

async function handleAdminV3JobCancel(request, env, cors, context, jobId, user) {
  const reason = await requireV3JobReason(request);
  const before = await getV3Job(env.AUTH_DB, context.id, jobId);
  const result = await env.AUTH_DB.prepare(
    `UPDATE game_jobs_v3 SET status = 'cancelled', next_retry_at = NULL, lease_expires_at = NULL,
        claim_token = NULL, updated_at = ?1
      WHERE id = ?2 AND internal_game_id = ?3 AND status IN ('pending', 'retry_wait')`
  ).bind(new Date().toISOString(), Number(jobId), context.id).run();
  if (Number(result?.meta?.changes || 0) !== 1) throw createV3Error("V3_JOB_OPERATION_INVALID", "このjobは取消できない状態です。", { httpStatus: 409 });
  const job = await getV3Job(env.AUTH_DB, context.id, jobId);
  await recordV3AdminAudit(env.AUTH_DB, {
    internalGameId: context.id,
    jobId: Number(jobId),
    jobType: "admin:job_cancel",
    stateBefore: before?.status || null,
    stateAfter: job?.status || "cancelled"
  });
  await recordWorkflowLog(env.AUTH_DB, { eventType: "v3_admin_job_cancel", status: "info", gameId: context.metadata.gameId, occurredAt: new Date(), message: "V3管理者がjobを取消しました。", metadata: { internalGameId: context.id, jobId: Number(jobId), reason, updatedBy: user.id }, source: "admin" });
  return jsonResponse({ ok: true, internalGameId: context.id, job }, 200, cors);
}

function parseAdminV3NpbGameCodeRoute(path) {
  const match = /^\/api\/admin\/v3\/games\/([^/]+)\/npb-game-code$/.exec(path);
  if (!match) return null;
  try {
    return { internalGameId: decodeURIComponent(match[1]) };
  } catch {
    return { internalGameId: "" };
  }
}

function parseAdminV3OrientationRoute(path) {
  const match = /^\/api\/admin\/v3\/games\/([^/]+)\/orientation$/.exec(path);
  if (!match) return null;
  try {
    return { internalGameId: decodeURIComponent(match[1]) };
  } catch {
    return { internalGameId: "" };
  }
}

function parseAdminV3IdentityResolveRoute(path) {
  const match = /^\/api\/admin\/v3\/games\/([^/]+)\/npb-identity\/resolve$/.exec(path);
  if (!match) return null;
  try {
    return { internalGameId: decodeURIComponent(match[1]) };
  } catch {
    return { internalGameId: "" };
  }
}

function parseAutoScoringTestRoute(path) {
  if (path === "/api/admin/auto-scoring-tests") return { action: "collection" };
  const match = /^\/api\/admin\/auto-scoring-tests\/([^/]+)(?:\/(answer-lineup|prediction|run|retry))?$/.exec(path);
  if (!match) return null;
  try {
    return { gameId: decodeURIComponent(match[1]), action: match[2] || "detail" };
  } catch {
    return { invalid: true };
  }
}

async function handleAutoScoringTestRoute(request, env, cors, route) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  if (request.method !== "GET") return legacyAdminOperationRetiredResponse(cors);
  if (route.invalid) return jsonResponse({ ok: false, code: "TEST_GAME_ID_INVALID", error: "テスト試合IDが不正です。" }, 400, cors);
  try {
    if (route.action === "collection" && request.method === "GET") {
      const rows = await env.AUTH_DB.prepare(
        `SELECT game_id, title, game_date, start_at, prediction_deadline_at, away_team, venue,
                status, last_auto_run_at, last_error_code, last_error_message, answer_lineup_json,
                created_at, updated_at
           FROM auto_scoring_tests
          WHERE mode = 'auto_scoring' AND status <> 'deleted'
          ORDER BY start_at DESC, created_at DESC`
      ).all();
      return jsonResponse({ ok: true, games: (rows.results || []).map(serializeAutoScoringTestSummary) }, 200, cors);
    }
    if (route.action === "collection" && request.method === "POST") {
      return await createAutoScoringTest(request, env, cors, access.user);
    }
    const test = await getAutoScoringTest(env.AUTH_DB, route.gameId);
    if (!test || test.mode !== "auto_scoring" || test.status === "deleted") {
      return jsonResponse({ ok: false, code: "TEST_GAME_NOT_FOUND", error: "自動採点テストが見つかりません。" }, 404, cors);
    }
    if (route.action === "detail" && request.method === "GET") {
      return await getAutoScoringTestDetail(env, cors, test);
    }
    if (route.action === "answer-lineup" && request.method === "POST") {
      return await saveAutoScoringTestAnswer(request, env, cors, test);
    }
    if (route.action === "prediction" && request.method === "POST") {
      return await saveAutoScoringTestPrediction(request, env, cors, test, access.user);
    }
    if (route.action === "run" && request.method === "POST") {
      const result = await runSingleAutoScoringTest(env, test.game_id, new Date(), { manual: true });
      return jsonResponse({ ok: result.ok, ...result }, result.ok ? 200 : (result.httpStatus || 409), cors);
    }
    if (route.action === "retry" && request.method === "POST") {
      await env.AUTH_DB.prepare(
        `UPDATE auto_scoring_tests
            SET status = 'ready', last_error_code = NULL, last_error_message = NULL, updated_at = ?1
          WHERE game_id = ?2 AND mode = 'auto_scoring'`
      ).bind(new Date().toISOString(), test.game_id).run();
      const result = await runSingleAutoScoringTest(env, test.game_id, new Date(), { manual: true });
      return jsonResponse({ ok: result.ok, ...result }, result.ok ? 200 : (result.httpStatus || 409), cors);
    }
    return jsonResponse({ ok: false, error: "自動採点テストのHTTPメソッドが不正です。" }, 405, cors);
  } catch (error) {
    if (isPregameSchemaError(error)) {
      return jsonResponse({ ok: false, code: "AUTO_SCORING_TEST_SCHEMA_NOT_READY", error: "自動採点テスト用データベースが準備されていません。" }, 503, cors);
    }
    console.error(`[AUTO_SCORING_TEST] route=${route.action} status=failed code=${error?.code || "AUTO_SCORING_TEST_FAILED"}`);
    return jsonResponse({ ok: false, code: error?.code || "AUTO_SCORING_TEST_FAILED", error: "自動採点テストを実行できませんでした。" }, 500, cors);
  }
}

function normalizeAutoScoringTestName(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\u3000]/g, "").trim();
}

export function parseAutoScoringRosterText(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const players = [];
  const unknown = [];
  const seen = new Set();
  for (const line of lines) {
    const name = line.split(/[\t,]/)[0].trim() || line.split(/\s{2,}/)[0].trim();
    const player = findFightersPlayerByName(name);
    if (!player) {
      unknown.push(name.slice(0, 40));
      continue;
    }
    const key = normalizeAutoScoringTestName(player.name);
    if (seen.has(key)) return { ok: false, error: "ロースターに同じ選手が重複しています。" };
    seen.add(key);
    players.push({ playerId: createFightersPlayerId(player.uniformNumber), playerName: player.name, uniformNumber: player.uniformNumber, teamId: FIGHTERS_TEAM_ID, teamCode: FIGHTERS_TEAM_CODE });
  }
  if (players.length < SCORING_LINEUP_SIZE) return { ok: false, error: "ロースターは9人以上入力してください。", unknown };
  return { ok: true, players, unknown };
}

export function parseAutoScoringAnswerLineup(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lineup = lines.map((line) => {
    const parts = line.split(/\s+/);
    return { battingOrder: Number(parts.shift()), position: parts.shift() || "", playerName: parts.join(" ") };
  });
  const resolved = lineup.map((item) => {
    const player = findFightersPlayerByName(item.playerName);
    return player ? { ...item, playerId: createFightersPlayerId(player.uniformNumber), uniformNumber: player.uniformNumber, teamId: FIGHTERS_TEAM_ID, teamCode: FIGHTERS_TEAM_CODE, playerName: player.name } : item;
  });
  const sanitized = sanitizeActualLineupForScoring(resolved);
  return sanitized.ok ? sanitized : { ok: false, error: sanitized.error || "正解スタメンを入力してください。" };
}

function validateAutoScoringTestRosterLineup(rosterPlayers, lineup) {
  const rosterIds = new Set((Array.isArray(rosterPlayers) ? rosterPlayers : []).map((player) => player?.playerId).filter(Boolean));
  return Array.isArray(lineup) && lineup.every((player) => rosterIds.has(player.playerId));
}

function serializeAutoScoringTestSummary(row) {
  return {
    gameId: row.game_id,
    title: row.title,
    gameDate: row.game_date,
    startAt: row.start_at,
    predictionDeadlineAt: row.prediction_deadline_at,
    awayTeam: row.away_team,
    venue: row.venue,
    status: row.status,
    answerLineupRegistered: Boolean(row.answer_lineup_json),
    lastAutoRunAt: row.last_auto_run_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message
  };
}

async function getAutoScoringTest(db, gameId) {
  return db.prepare("SELECT * FROM auto_scoring_tests WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
}

function testInputIso(value) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function createAutoScoringTest(request, env, cors, user) {
  const input = await readJson(request);
  const title = String(input?.title || "").trim().slice(0, 160);
  const startAt = testInputIso(input?.startAt);
  const deadlineAt = testInputIso(input?.predictionDeadlineAt);
  const gameDate = String(input?.gameDate || "").trim();
  const awayTeam = String(input?.awayTeam || "e").trim().toLowerCase();
  const roster = parseAutoScoringRosterText(input?.rosterText);
  const answer = parseAutoScoringAnswerLineup(input?.answerLineupText);
  if (!title || !startAt || !deadlineAt || !/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) return jsonResponse({ ok: false, code: "AUTO_SCORING_TEST_INPUT_INVALID", error: "試合名、試合日、開始日時、締切日時を入力してください。" }, 400, cors);
  if (new Date(deadlineAt) >= new Date(startAt)) return jsonResponse({ ok: false, code: "AUTO_SCORING_TEST_DEADLINE_INVALID", error: "締切日時は試合開始より前にしてください。" }, 400, cors);
  if (!roster.ok) return jsonResponse({ ok: false, code: "AUTO_SCORING_TEST_ROSTER_INVALID", error: roster.error, unknown: roster.unknown || [] }, 400, cors);
  if (!answer.ok) return jsonResponse({ ok: false, code: "AUTO_SCORING_TEST_LINEUP_INVALID", error: answer.error }, 400, cors);
  if (!validateAutoScoringTestRosterLineup(roster.players, answer.lineup)) return jsonResponse({ ok: false, code: "AUTO_SCORING_TEST_LINEUP_ROSTER_MISMATCH", error: "正解スタメンにロースター外の選手が含まれています。" }, 400, cors);
  const gameId = `${gameDate}-f-e-${90000 + Math.floor(Math.random() * 9999)}`;
  const now = new Date().toISOString();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(
      `INSERT INTO auto_scoring_tests
       (game_id, title, game_date, start_at, prediction_deadline_at, home_team, away_team, venue, roster_json, answer_lineup_json, mode, status, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'f', ?6, ?7, ?8, ?9, 'auto_scoring', 'ready', ?10, ?11, ?11)`
    ).bind(gameId, title, gameDate, startAt, deadlineAt, awayTeam, String(input?.venue || "").trim().slice(0, 160), JSON.stringify(roster.players), JSON.stringify(answer.lineup), user.id, now),
    env.AUTH_DB.prepare(
      `INSERT INTO ranking_games (game_id, game_date, is_ranking_eligible, game_status, is_test_game, publication_status, created_at, updated_at)
       VALUES (?1, ?2, 0, 'pending', 1, 'pending', ?3, ?3)`
    ).bind(gameId, gameDate, now)
  ]);
  return jsonResponse({ ok: true, game: serializeAutoScoringTestSummary({ game_id: gameId, title, game_date: gameDate, start_at: startAt, prediction_deadline_at: deadlineAt, away_team: awayTeam, venue: input?.venue || "", status: "ready", answer_lineup_json: JSON.stringify(answer.lineup) }) }, 201, cors);
}

async function getAutoScoringTestDetail(env, cors, test) {
  const lineup = await getGameLineup(env.AUTH_DB, test.game_id);
  const counts = await env.AUTH_DB.prepare(
    `SELECT COUNT(*) AS prediction_count,
            SUM(CASE WHEN status = 'scored' THEN 1 ELSE 0 END) AS scored_count
       FROM predictions WHERE game_id = ?1 AND is_test_prediction = 1`
  ).bind(test.game_id).first();
  const rows = await env.AUTH_DB.prepare(
    `SELECT predictions.id, users.username, predictions.score, predictions.max_score, predictions.status,
            predictions.scored_at, predictions.updated_at
       FROM predictions JOIN users ON users.id = predictions.user_id
      WHERE predictions.game_id = ?1 AND predictions.is_test_prediction = 1
      ORDER BY predictions.updated_at DESC`
  ).bind(test.game_id).all();
  const now = new Date();
  const deadline = new Date(test.prediction_deadline_at);
  const remainingSeconds = Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 1000));
  let status = test.status;
  if (!test.answer_lineup_json) status = "設定不足";
  else if (now < deadline) status = "予想受付中";
  else if (test.status === "ready" || test.status === "waiting") status = "自動採点待ち";
  else if (test.status === "scoring") status = "自動採点中";
  else if (test.status === "scored") status = "自動採点済み";
  else if (test.status === "published") status = "結果公開済み";
  else if (test.status === "failed") status = "自動採点失敗";
  return jsonResponse({ ok: true, game: {
    ...serializeAutoScoringTestSummary(test),
    currentStatus: status,
    now: now.toISOString(),
    roster: JSON.parse(test.roster_json),
    deadlineRemainingSeconds: remainingSeconds,
    answerLineupRegistered: Boolean(test.answer_lineup_json),
    answerLineup: test.answer_lineup_json ? JSON.parse(test.answer_lineup_json) : null,
    autoScoring: serializeGameLineup(lineup),
    predictionCount: Number(counts?.prediction_count || 0),
    scoredCount: Number(counts?.scored_count || 0),
    results: (rows.results || []).map((row) => ({ username: row.username, score: row.score, maxScore: row.max_score, status: row.status, scoredAt: row.scored_at, updatedAt: row.updated_at }))
  } }, 200, cors);
}

async function saveAutoScoringTestAnswer(request, env, cors, test) {
  const input = await readJson(request);
  const answer = parseAutoScoringAnswerLineup(input?.answerLineupText);
  if (!answer.ok) return jsonResponse({ ok: false, code: "AUTO_SCORING_TEST_LINEUP_INVALID", error: answer.error }, 400, cors);
  if (!validateAutoScoringTestRosterLineup(JSON.parse(test.roster_json), answer.lineup)) return jsonResponse({ ok: false, code: "AUTO_SCORING_TEST_LINEUP_ROSTER_MISMATCH", error: "正解スタメンにロースター外の選手が含まれています。" }, 400, cors);
  const now = new Date().toISOString();
  await env.AUTH_DB.prepare(
    `UPDATE auto_scoring_tests SET answer_lineup_json = ?1, status = CASE WHEN status = 'failed' THEN 'ready' ELSE status END,
      last_error_code = NULL, last_error_message = NULL, updated_at = ?2 WHERE game_id = ?3`
  ).bind(JSON.stringify(answer.lineup), now, test.game_id).run();
  return jsonResponse({ ok: true, gameId: test.game_id, answerLineup: answer.lineup }, 200, cors);
}

async function saveAutoScoringTestPrediction(request, env, cors, test, user) {
  if (new Date() >= new Date(test.prediction_deadline_at)) return jsonResponse({ ok: false, code: "PREDICTION_DEADLINE_CLOSED", error: "このテスト試合の予想受付は終了しています。" }, 409, cors);
  const input = await readJson(request);
  const predictionResult = sanitizePredictionPayload(input?.prediction || input);
  if (!predictionResult.ok) return jsonResponse({ ok: false, error: predictionResult.error }, 400, cors);
  const roster = JSON.parse(test.roster_json);
  const rosterIds = new Set(roster.map((player) => player.playerId));
  if (predictionResult.prediction.lineup.some((player) => !rosterIds.has(player.playerId))) return jsonResponse({ ok: false, code: "AUTO_SCORING_TEST_ROSTER_MISMATCH", error: "ロースター外の選手は予想できません。" }, 400, cors);
  const now = new Date().toISOString();
  const existing = await getPredictionRow(env.AUTH_DB, user.id, test.game_id);
  await env.AUTH_DB.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version, game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, locked_at, status, score, max_score, scored_at, actual_lineup_json, is_test_prediction)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'f', ?7, ?7, 1, ?8, ?8, NULL, 'submitted', NULL, NULL, NULL, NULL, 1)
     ON CONFLICT(user_id, game_id) DO UPDATE SET prediction_json = excluded.prediction_json, updated_at = excluded.updated_at,
       status = 'submitted', score = NULL, max_score = NULL, scored_at = NULL, actual_lineup_json = NULL, is_test_prediction = 1
     WHERE predictions.locked_at IS NULL AND predictions.status NOT IN ('locked', 'scored')`
  ).bind(existing?.id || randomToken(16), user.id, test.game_id, JSON.stringify(predictionResult.prediction), PREDICTION_SCHEMA_VERSION, test.game_date, test.away_team, now).run();
  return jsonResponse({ ok: true, gameId: test.game_id, updatedAt: now }, 200, cors);
}

async function updateAutoScoringTestStatus(db, gameId, status, now, error = null) {
  await db.prepare(
    `UPDATE auto_scoring_tests SET status = ?1, last_auto_run_at = ?2, last_error_code = ?3, last_error_message = ?4, updated_at = ?2 WHERE game_id = ?5`
  ).bind(status, now.toISOString(), error?.code || null, error ? String(error.message || "自動採点に失敗しました。").slice(0, 240) : null, gameId).run();
}

async function runSingleAutoScoringTest(env, gameId, now, { manual = false } = {}) {
  const test = await getAutoScoringTest(env.AUTH_DB, gameId);
  if (!test || test.mode !== "auto_scoring" || test.status === "deleted") return { ok: false, code: "TEST_GAME_NOT_FOUND", error: "自動採点テストが見つかりません。", httpStatus: 404 };
  if (now < new Date(test.prediction_deadline_at)) return { ok: false, code: "AUTO_SCORING_TEST_NOT_DUE", error: "まだ締切日時を過ぎていません。", httpStatus: 409, status: "waiting" };
  if (!test.answer_lineup_json) return { ok: false, code: "AUTO_SCORING_TEST_LINEUP_REQUIRED", error: "自動採点用の正解スタメンが登録されていません。", httpStatus: 409, status: "waiting" };
  try {
    const answer = sanitizeActualLineupForScoring(JSON.parse(test.answer_lineup_json));
    if (!answer.ok) throw Object.assign(new Error(answer.error), { code: "AUTO_SCORING_TEST_LINEUP_INVALID" });
    let record = await getGameLineup(env.AUTH_DB, gameId);
    if (!record) {
      record = await approveActualLineupForAutoScoring(env, gameId, answer.lineup, now, { allowTestGame: true, isTestGame: true, scoringDueAt: now, now, source: "manual" });
    }
    await markGameRankingPending(env.AUTH_DB, gameId, now, env, 1);
    const claimed = await claimGameLineupForScoring(env.AUTH_DB, gameId, now, { resetAttempts: manual });
    if (!claimed) return { ok: true, gameId, status: "already_processing" };
    await updateAutoScoringTestStatus(env.AUTH_DB, gameId, "scoring", now);
    const scored = await scoreClaimedGameLineup(env.AUTH_DB, claimed, now, 1);
    const published = await publishGameResults(env, gameId, now, { isTestGame: true });
    await updateAutoScoringTestStatus(env.AUTH_DB, gameId, published.published ? "published" : "scored", now);
    console.log(`[AUTO_SCORING_TEST] gameId=${gameId} status=${published.published ? "published" : "scored"} processed=${scored.processed}`);
    return { ok: true, gameId, status: published.published ? "published" : "scored", ...scored, publication: published };
  } catch (error) {
    await markGameLineupFailed(env.AUTH_DB, gameId, error, now);
    await updateAutoScoringTestStatus(env.AUTH_DB, gameId, "failed", now, error);
    console.warn(`[AUTO_SCORING_TEST] gameId=${gameId} status=failed code=${error?.code || "AUTO_SCORING_TEST_FAILED"}`);
    return { ok: false, gameId, status: "failed", code: error?.code || "AUTO_SCORING_TEST_FAILED", error: "自動採点テストに失敗しました。", httpStatus: 500 };
  }
}

async function handleAdminTestRoute(request, env, cors, route) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) {
    return access.response;
  }
  if (request.method !== "GET") return legacyAdminOperationRetiredResponse(cors);
  if (route.invalid) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdが不正です。" }, 400, cors);
  }
  if (route.action === "status" && request.method === "GET") {
    const gameId = getValidGameId(new URL(request.url).searchParams.get("gameId"));
    const record = gameId ? await getGameLineup(env.AUTH_DB, gameId) : null;
    return jsonResponse({
      ok: true,
      autoScoringDelaySeconds: getAutoScoringDelaySeconds(env),
      user: publicUser(access.user),
      gameId: gameId || "",
      autoScoring: serializeGameLineup(record)
    }, 200, cors);
  }
  if (route.action === "create-perfect-prediction" && request.method === "POST") {
    const metadata = parsePredictionGameId(route.gameId);
    if (!metadata) {
      return jsonResponse({ ok: false, error: "対象試合のgameIdが不正です。" }, 400, cors);
    }
    return await handleCreateAdminTestPerfectPrediction(env, cors, access.user, metadata);
  }
  if (route.action === "achievements" && request.method === "GET") {
    return await handleDevelopmentAchievements(env, cors, access.user);
  }
  if (route.action === "achievements/grant-test" && request.method === "POST") {
    return await handleDevelopmentAchievementGrant(request, env, cors, access.user);
  }
  if (route.action === "achievements/delete-test-grant" && request.method === "DELETE") {
    return await handleDevelopmentAchievementDelete(env, cors, access.user, route.code);
  }
  return jsonResponse({ ok: false, error: "開発APIのHTTPメソッドが不正です。" }, 405, cors);
}

function parseAdminTestGameRoute(path) {
  if (path === "/api/admin/test-games") return { collection: true };
  const match = /^\/api\/admin\/test-games\/([^/]+)(?:\/(roster|prediction|lineup|close|reopen|publish|score(?:\/preview)?|rescore\/(?:preview|confirm)))?$/.exec(path);
  if (!match) return null;
  try {
    return { gameId: decodeURIComponent(match[1]), action: match[2] || "detail" };
  } catch {
    return { invalid: true };
  }
}

async function handleAdminTestGameRoute(request, env, cors, route) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  if (request.method !== "GET") return legacyAdminOperationRetiredResponse(cors);
  if (route.invalid) return jsonResponse({ ok: false, code: "TEST_GAME_ID_INVALID", error: "テスト試合IDが不正です。" }, 400, cors);

  try {
    if (route.collection && request.method === "GET") return await listAdminTestGames(env.AUTH_DB, cors);
    if (route.collection && request.method === "POST") return await createAdminTestGame(request, env, cors, access.user);
    if (route.collection) return jsonResponse({ ok: false, error: "テスト試合APIのHTTPメソッドが不正です。" }, 405, cors);

    const game = await getTestGame(env.AUTH_DB, route.gameId);
    if (!game) return jsonResponse({ ok: false, code: "TEST_GAME_NOT_FOUND", error: "指定されたテスト試合が見つかりません。" }, 404, cors);
    if (route.action === "detail" && request.method === "GET") return await getAdminTestGameDetail(env.AUTH_DB, cors, game);
    if (route.action === "roster" && request.method === "POST") return await saveAdminTestGameRoster(request, env.AUTH_DB, cors, game);
    if (route.action === "prediction" && request.method === "POST") return await saveAdminTestPrediction(request, env, cors, game, access.user);
    if (route.action === "lineup" && request.method === "POST") return await saveAdminTestLineup(request, env, cors, game);
    if (route.action === "close" && request.method === "POST") return await updateAdminTestGameDeadline(env.AUTH_DB, cors, game, "close");
    if (route.action === "reopen" && request.method === "POST") return await updateAdminTestGameDeadline(env.AUTH_DB, cors, game, "reopen");
    if (route.action === "publish" && request.method === "POST") return await publishAdminTestGame(env, cors, game);
    if (route.action === "score/preview" && request.method === "POST") return await scoreAdminTestGamePreview(env, cors, game);
    if (route.action === "score" && request.method === "POST") return await scoreAdminTestGame(env, cors, game);
    if (route.action === "rescore/preview" && request.method === "POST") return await rescoreAdminTestGamePreview(request, env, cors, game, access.user);
    if (route.action === "rescore/confirm" && request.method === "POST") return await rescoreAdminTestGameConfirm(request, env, cors, game, access.user);
    if (route.action === "detail" && request.method === "PATCH") return await updateAdminTestGame(request, env.AUTH_DB, cors, game);
    if (route.action === "detail" && request.method === "DELETE") return await deleteAdminTestGame(env.AUTH_DB, cors, game);
    return jsonResponse({ ok: false, error: "テスト試合APIのHTTPメソッドが不正です。" }, 405, cors);
  } catch (error) {
    console.warn(`[TEST_GAME] gameId=${route.gameId || "-"} status=failed code=${error?.code || "TEST_GAME_FAILED"}`);
    return jsonResponse({
      ok: false,
      code: isPregameSchemaError(error) ? "TEST_GAME_SCHEMA_NOT_READY" : String(error?.code || "TEST_GAME_FAILED"),
      error: isPregameSchemaError(error) ? "テスト試合用データベースが準備されていません。" : "テスト試合の処理に失敗しました。"
    }, isPregameSchemaError(error) ? 503 : (Number(error?.httpStatus) || 500), cors);
  }
}

function parseTestGameDate(value) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return parsed.toISOString().slice(0, 10) === date ? date : null;
}

function parseTestGameTimestamp(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 64) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeTestPlayerName(value) {
  return String(value || "").normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim();
}

export function parseTestRosterText(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, error: "ロースターを1人以上入力してください。" };
  const players = [];
  const warnings = [];
  const seen = new Set();
  for (const line of lines) {
    const [rawName, rawPosition = ""] = line.split(/[，,]/, 2);
    const name = normalizeTestPlayerName(rawName);
    if (!name) return { ok: false, error: "空の選手名は登録できません。" };
    const key = name.replace(/\s/g, "");
    if (seen.has(key)) return { ok: false, error: `選手が重複しています：${name}` };
    seen.add(key);
    const player = findFightersPlayerByName(name);
    const rawPositionLabel = rawPosition.trim();
    const normalizedPosition = normalizeScoringPosition(rawPositionLabel);
    const isRosterCategory = ["捕手", "内野手", "外野手", "投手", "DH", "指名打者"].includes(rawPositionLabel);
    const position = normalizedPosition || rawPositionLabel;
    if (rawPositionLabel && !normalizedPosition && !isRosterCategory) warnings.push(`${name}：守備位置を確認してください。`);
    if (!player) {
      warnings.push(`${name}：選手マスタと照合できません。予想・スタメン登録には使用できません。`);
      players.push({ playerId: null, teamId: "F", teamCode: "f", uniformNumber: null, playerName: name, position });
      continue;
    }
    players.push({
      playerId: createFightersPlayerId(player.uniformNumber),
      teamId: "F",
      teamCode: "f",
      uniformNumber: player.uniformNumber,
      playerName: player.name,
      position
    });
  }
  if (players.length < SCORING_LINEUP_SIZE) return { ok: false, error: "ロースターは9人以上入力してください。" };
  return { ok: true, players, warnings };
}

export function parseTestLineupInput(input) {
  if (Array.isArray(input)) {
    const result = sanitizeActualLineupForScoring(input);
    return result.ok ? result : { ok: false, error: result.error };
  }
  const lines = String(input || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== SCORING_LINEUP_SIZE) return { ok: false, error: "スタメンは1番から9番まで入力してください。" };
  const lineup = [];
  const orders = new Set();
  const players = new Set();
  for (const line of lines) {
    const parts = line.replace(/\u3000/g, " ").replace(/\s+/g, " ").split(" ");
    const order = Number(parts.shift());
    const position = normalizeScoringPosition(parts.shift());
    const name = normalizeTestPlayerName(parts.join(" "));
    const player = findFightersPlayerByName(name);
    if (!Number.isInteger(order) || order < 1 || order > SCORING_LINEUP_SIZE || !position || !name || !player) {
      return { ok: false, error: `スタメンを確認できません：${line}` };
    }
    const playerId = createFightersPlayerId(player.uniformNumber);
    if (orders.has(order) || players.has(playerId)) return { ok: false, error: "打順または選手が重複しています。" };
    orders.add(order);
    players.add(playerId);
    lineup[order - 1] = { battingOrder: order, playerId, teamId: FIGHTERS_TEAM_ID, teamCode: FIGHTERS_TEAM_CODE, uniformNumber: player.uniformNumber, playerName: player.name, position };
  }
  return sanitizeActualLineupForScoring(lineup);
}

async function getTestGame(db, gameId) {
  return db.prepare("SELECT * FROM test_games WHERE game_id = ?1 AND status <> 'deleted' LIMIT 1").bind(gameId).first();
}

function serializeTestGame(row, extra = {}) {
  return {
    gameId: row.game_id,
    title: row.title,
    gameDate: row.game_date,
    startAt: row.start_at,
    predictionDeadlineAt: row.prediction_deadline_at,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    venue: row.venue || "",
    status: row.status,
    roster: parseJsonArray(row.roster_json),
    memo: row.memo || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra
  };
}

function testGameMetadata(game) {
  const metadata = parsePredictionGameId(game.game_id);
  return metadata ? { ...metadata, startAt: new Date(game.start_at), predictionDeadlineAt: new Date(game.prediction_deadline_at) } : null;
}

async function listAdminTestGames(db, cors) {
  const result = await db.prepare(
    `SELECT test_games.*,
            (SELECT COUNT(*) FROM predictions WHERE game_id = test_games.game_id AND is_test_prediction = 1) AS prediction_count,
            game_lineups.scoring_status, game_lineups.publication_status, game_lineups.scored_at, game_lineups.published_at
       FROM test_games
      WHERE test_games.status <> 'deleted'
      ORDER BY test_games.start_at DESC, test_games.game_id DESC`
  ).all();
  return jsonResponse({ ok: true, games: (result.results || []).map((row) => serializeTestGame(row, {
    predictionCount: Number(row.prediction_count || 0),
    lineupStatus: row.scoring_status ? "registered" : "pending",
    scoringStatus: row.scoring_status || "pending",
    publicationStatus: row.publication_status || "pending",
    scoredAt: row.scored_at || null,
    publishedAt: row.published_at || null
  })) }, 200, cors);
}

async function createAdminTestGame(request, env, cors, user) {
  const input = await readJson(request);
  const title = String(input?.title || "").trim().slice(0, 120);
  const gameDate = parseTestGameDate(input?.gameDate);
  const startAt = parseTestGameTimestamp(input?.startAt);
  const deadlineAt = parseTestGameTimestamp(input?.predictionDeadlineAt);
  const awayTeam = String(input?.awayTeam || "").trim().slice(0, 80);
  const venue = String(input?.venue || "").trim().slice(0, 120);
  const memo = String(input?.memo || "").trim().slice(0, 2000);
  if (!title || !gameDate || !startAt || !deadlineAt || !awayTeam) {
    return jsonResponse({ ok: false, code: "TEST_GAME_INPUT_INVALID", error: "試合名、試合日、開始日時、締切日時、対戦相手を入力してください。" }, 400, cors);
  }
  const start = new Date(startAt);
  const deadline = new Date(deadlineAt);
  if (deadline.getTime() >= start.getTime()) {
    return jsonResponse({ ok: false, code: "TEST_GAME_DEADLINE_INVALID", error: "予想締切は試合開始より前に設定してください。" }, 400, cors);
  }
  const roster = parseTestRosterText(input?.rosterText);
  if (!roster.ok) return jsonResponse({ ok: false, code: "TEST_ROSTER_INVALID", error: roster.error }, 400, cors);
  let gameId = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${gameDate}-f-${TEST_GAME_DEFAULT_OPPONENT_CODE}-${90000 + Math.floor(Math.random() * 9999)}`;
    if (!await getTestGame(env.AUTH_DB, candidate)) { gameId = candidate; break; }
  }
  if (!gameId) throw createPregameError("TEST_GAME_ID_CREATE_FAILED", "テスト試合IDを作成できませんでした。");
  const now = new Date().toISOString();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(
      `INSERT INTO test_games
       (game_id, title, game_date, start_at, prediction_deadline_at, home_team, away_team, venue, roster_json, probable_starter_json, memo, status, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '北海道日本ハムファイターズ', ?6, ?7, ?8, NULL, ?9, 'scheduled', ?10, ?11, ?11)`
    ).bind(gameId, title, gameDate, startAt, deadlineAt, awayTeam, venue, JSON.stringify(roster.players), memo || null, user.id),
    env.AUTH_DB.prepare(
      `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game, publication_status, scored_private_at, published_at, created_at, updated_at)
       VALUES (?1, ?2, 0, NULL, 'pending', 1, 'pending', NULL, NULL, ?3, ?3)`
    ).bind(gameId, gameDate, now)
  ]);
  console.log(`[TEST_GAME] action=create gameId=${gameId} status=success`);
  return jsonResponse({ ok: true, game: serializeTestGame({ game_id: gameId, title, game_date: gameDate, start_at: startAt, prediction_deadline_at: deadlineAt, home_team: "北海道日本ハムファイターズ", away_team: awayTeam, venue, roster_json: JSON.stringify(roster.players), memo, status: "scheduled", created_at: now, updated_at: now }), warnings: roster.warnings }, 201, cors);
}

async function getAdminTestGameDetail(db, cors, game) {
  const [lineup, predictionSummary, revisions, results] = await Promise.all([
    getGameLineup(db, game.game_id),
    db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'scored' THEN 1 ELSE 0 END) AS scored FROM predictions WHERE game_id = ?1 AND is_test_prediction = 1").bind(game.game_id).first(),
    db.prepare("SELECT * FROM game_lineup_revisions WHERE game_id = ?1 ORDER BY version DESC").bind(game.game_id).all(),
    db.prepare(
      `SELECT users.username, predictions.score, predictions.max_score, predictions.status,
              predictions.scored_at, predictions.updated_at
         FROM predictions JOIN users ON users.id = predictions.user_id
        WHERE predictions.game_id = ?1 AND predictions.is_test_prediction = 1
        ORDER BY predictions.updated_at DESC, predictions.id DESC`
    ).bind(game.game_id).all()
  ]);
  return jsonResponse({
    ok: true,
    game: serializeTestGame(game, {
      predictionCount: Number(predictionSummary?.total || 0),
      scoredPredictionCount: Number(predictionSummary?.scored || 0),
      lineup: serializeGameLineup(lineup),
      revisions: (revisions.results || []).map(serializeLineupRevision),
      results: (results.results || []).map((row) => ({
        username: row.username,
        score: row.score === null ? null : Number(row.score),
        maxScore: row.max_score === null ? null : Number(row.max_score),
        status: row.status,
        scoredAt: row.scored_at || null,
        updatedAt: row.updated_at || null
      }))
    })
  }, 200, cors);
}

async function saveAdminTestGameRoster(request, db, cors, game) {
  const input = await readJson(request);
  const roster = parseTestRosterText(input?.rosterText);
  if (!roster.ok) return jsonResponse({ ok: false, code: "TEST_ROSTER_INVALID", error: roster.error }, 400, cors);
  const now = new Date().toISOString();
  await db.prepare("UPDATE test_games SET roster_json = ?1, updated_at = ?2 WHERE game_id = ?3").bind(JSON.stringify(roster.players), now, game.game_id).run();
  return jsonResponse({ ok: true, gameId: game.game_id, roster: roster.players, warnings: roster.warnings }, 200, cors);
}

async function updateAdminTestGame(request, db, cors, game) {
  const input = await readJson(request);
  const startAt = input?.startAt === undefined ? game.start_at : parseTestGameTimestamp(input.startAt);
  const deadlineAt = input?.predictionDeadlineAt === undefined ? game.prediction_deadline_at : parseTestGameTimestamp(input.predictionDeadlineAt);
  if (!startAt || !deadlineAt || new Date(deadlineAt) >= new Date(startAt)) return jsonResponse({ ok: false, code: "TEST_GAME_DEADLINE_INVALID", error: "締切日時を確認してください。" }, 400, cors);
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE test_games SET title = ?1, start_at = ?2, prediction_deadline_at = ?3, away_team = ?4, venue = ?5, memo = ?6, updated_at = ?7 WHERE game_id = ?8`
  ).bind(String(input?.title ?? game.title).trim().slice(0, 120), startAt, deadlineAt, String(input?.awayTeam ?? game.away_team).trim().slice(0, 80), String(input?.venue ?? game.venue ?? "").trim().slice(0, 120), String(input?.memo ?? game.memo ?? "").trim().slice(0, 2000) || null, now, game.game_id).run();
  return getAdminTestGameDetail(db, cors, await getTestGame(db, game.game_id));
}

async function updateAdminTestGameDeadline(db, cors, game, mode) {
  const now = new Date();
  const deadline = mode === "close"
    ? new Date(now.getTime() - 1000)
    : new Date(new Date(game.start_at).getTime() - TEST_GAME_DEFAULT_REOPEN_MINUTES * 60 * 1000);
  await db.prepare("UPDATE test_games SET prediction_deadline_at = ?1, updated_at = ?2 WHERE game_id = ?3").bind(deadline.toISOString(), now.toISOString(), game.game_id).run();
  return jsonResponse({ ok: true, gameId: game.game_id, predictionDeadlineAt: deadline.toISOString(), status: mode === "close" ? "closed" : "open" }, 200, cors);
}

async function deleteAdminTestGame(db, cors, game) {
  const statements = [
    db.prepare("DELETE FROM game_rescore_audits WHERE game_id = ?1").bind(game.game_id),
    db.prepare("DELETE FROM game_rescore_jobs WHERE game_id = ?1").bind(game.game_id),
    db.prepare("DELETE FROM game_rescore_previews WHERE game_id = ?1").bind(game.game_id),
    db.prepare("DELETE FROM game_lineup_revisions WHERE game_id = ?1").bind(game.game_id),
    db.prepare("DELETE FROM perfect_achievers WHERE game_id = ?1").bind(game.game_id),
    db.prepare("DELETE FROM predictions WHERE game_id = ?1 AND is_test_prediction = 1").bind(game.game_id),
    db.prepare("DELETE FROM game_lineups WHERE game_id = ?1").bind(game.game_id),
    db.prepare("DELETE FROM ranking_games WHERE game_id = ?1 AND is_test_game = 1").bind(game.game_id),
    db.prepare("DELETE FROM test_games WHERE game_id = ?1").bind(game.game_id)
  ];
  await db.batch(statements);
  return jsonResponse({ ok: true, gameId: game.game_id, deleted: true }, 200, cors);
}

async function saveAdminTestPrediction(request, env, cors, game, user) {
  const metadata = testGameMetadata(game);
  if (!metadata) return jsonResponse({ ok: false, code: "TEST_GAME_ID_INVALID", error: "テスト試合IDが不正です。" }, 400, cors);
  if (new Date() >= new Date(game.prediction_deadline_at)) {
    return jsonResponse({ ok: false, code: "TEST_GAME_CLOSED", error: "テスト試合の予想受付は終了しています。" }, 409, cors);
  }
  const input = await readJson(request);
  const predictionResult = sanitizePredictionPayload(input?.prediction);
  if (!predictionResult.ok) return jsonResponse({ ok: false, code: "TEST_PREDICTION_INVALID", error: predictionResult.error }, 400, cors);
  const roster = parseJsonArray(game.roster_json);
  const rosterIds = new Set(roster.map((player) => player?.playerId).filter(Boolean));
  if (rosterIds.size && predictionResult.prediction.lineup.some((player) => !rosterIds.has(player.playerId))) {
    return jsonResponse({ ok: false, code: "TEST_PREDICTION_OUTSIDE_ROSTER", error: "ロースターに登録された選手だけで予想してください。" }, 400, cors);
  }
  const now = new Date().toISOString();
  const existing = await env.AUTH_DB.prepare("SELECT id, submitted_at FROM predictions WHERE user_id = ?1 AND game_id = ?2 AND is_test_prediction = 1 LIMIT 1").bind(user.id, game.game_id).first();
  await env.AUTH_DB.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version, game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, locked_at, status, score, max_score, scored_at, actual_lineup_json, is_test_prediction)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'e', 1, ?9, ?9, NULL, 'submitted', NULL, NULL, NULL, NULL, 1)
     ON CONFLICT(user_id, game_id) DO UPDATE SET
       prediction_json = excluded.prediction_json, schema_version = excluded.schema_version,
       game_date = excluded.game_date, home_team = excluded.home_team, away_team = excluded.away_team,
       updated_at = excluded.updated_at, status = 'submitted', locked_at = NULL, score = NULL,
       max_score = NULL, scored_at = NULL, actual_lineup_json = NULL, is_test_prediction = 1
     WHERE predictions.is_test_prediction = 1 AND predictions.locked_at IS NULL AND predictions.status NOT IN ('locked', 'scored')`
  ).bind(existing?.id || randomToken(16), user.id, game.game_id, JSON.stringify(predictionResult.prediction), PREDICTION_SCHEMA_VERSION, game.game_date, "f", game.away_team, now).run();
  return jsonResponse({ ok: true, gameId: game.game_id, created: !existing, updated: Boolean(existing), submittedAt: existing?.submitted_at || now }, 200, cors);
}

async function saveAdminTestLineup(request, env, cors, game) {
  const input = await readJson(request);
  const actual = parseTestLineupInput(input?.lineup || input?.lineupText);
  if (!actual.ok) return jsonResponse({ ok: false, code: "TEST_LINEUP_INVALID", error: actual.error }, 400, cors);
  const roster = parseJsonArray(game.roster_json);
  const rosterIds = new Set(roster.map((player) => player?.playerId).filter(Boolean));
  const outsideRoster = actual.lineup.filter((player) => rosterIds.size && !rosterIds.has(player.playerId)).map((player) => player.playerName);
  const now = new Date();
  const record = await approveActualLineupForAutoScoring(env, game.game_id, actual.lineup, now, {
    allowTestGame: true,
    isTestGame: true,
    scoringDueAt: now,
    now,
    source: "manual"
  });
  return jsonResponse({ ok: true, gameId: game.game_id, autoScoring: serializeGameLineup(record), warnings: outsideRoster.length ? [`ロースター外の選手です：${outsideRoster.join("、")}`] : [] }, 200, cors);
}

async function scoreAdminTestGamePreview(env, cors, game) {
  const record = await getGameLineup(env.AUTH_DB, game.game_id);
  const actual = sanitizeActualLineupForScoring(parseStoredActualLineup(record?.actual_lineup_json));
  if (!actual.ok) return jsonResponse({ ok: false, code: "TEST_LINEUP_REQUIRED", error: "先に9人の実スタメンを登録してください。" }, 409, cors);
  const scoring = await prepareGamePredictionScoring(env.AUTH_DB, game.game_id, actual.lineup, 1);
  return jsonResponse({ ok: true, gameId: game.game_id, processed: scoring.processed, scored: scoring.scored, failed: scoring.failed, maxScore: SCORING_MAX_SCORE, perfectCount: scoring.perfectCount, averageScore: scoring.averageScore, validationErrors: scoring.validationErrors, lineupFingerprint: record.lineup_fingerprint }, 200, cors);
}

async function scoreAdminTestGame(env, cors, game) {
  const record = await getGameLineup(env.AUTH_DB, game.game_id);
  if (!record) return jsonResponse({ ok: false, code: "TEST_LINEUP_REQUIRED", error: "先に実スタメンを登録してください。" }, 409, cors);
  const now = new Date();
  await markGameRankingPending(env.AUTH_DB, game.game_id, now, env, true);
  const claimed = await claimGameLineupForScoring(env.AUTH_DB, game.game_id, now, { force: true, resetAttempts: true });
  if (!claimed) return jsonResponse({ ok: false, code: "TEST_SCORING_IN_PROGRESS", error: "このテスト試合は現在採点処理中です。" }, 409, cors);
  try {
    const result = await scoreClaimedGameLineup(env.AUTH_DB, claimed, now, 1);
    return jsonResponse({ ok: true, gameId: game.game_id, ...result, autoScoring: serializeGameLineup(await getGameLineup(env.AUTH_DB, game.game_id)) }, 200, cors);
  } catch (error) {
    await markGameLineupFailed(env.AUTH_DB, game.game_id, error, now);
    throw error;
  }
}

async function publishAdminTestGame(env, cors, game) {
  const lineup = await getGameLineup(env.AUTH_DB, game.game_id);
  if (!lineup || lineup.scoring_status !== "scored") return jsonResponse({ ok: false, code: "TEST_SCORING_REQUIRED", error: "先にテスト採点を完了してください。" }, 409, cors);
  const now = new Date().toISOString();
  const perfectRows = await env.AUTH_DB.prepare(
    "SELECT user_id, score, max_score FROM predictions WHERE game_id = ?1 AND is_test_prediction = 1 AND status = 'scored' AND score = max_score"
  ).bind(game.game_id).all();
  const statements = [env.AUTH_DB.prepare(
    `UPDATE game_lineups SET publication_status = 'published', published_at = ?1, new_perfect_achievers = ?2, updated_at = ?1 WHERE game_id = ?3 AND scoring_status = 'scored'`
  ).bind(now, (perfectRows.results || []).length, game.game_id), env.AUTH_DB.prepare(
    `UPDATE ranking_games SET is_ranking_eligible = 0, game_status = 'scored', is_test_game = 1, publication_status = 'published', published_at = ?1, updated_at = ?1 WHERE game_id = ?2`
  ).bind(now, game.game_id), env.AUTH_DB.prepare("DELETE FROM perfect_achievers WHERE game_id = ?1").bind(game.game_id)];
  for (const row of perfectRows.results || []) {
    statements.push(env.AUTH_DB.prepare("INSERT OR IGNORE INTO perfect_achievers (id, user_id, game_id, score, max_score, achieved_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)").bind(randomToken(16), row.user_id, game.game_id, Number(row.score), Number(row.max_score), now));
  }
  await env.AUTH_DB.batch(statements);
  return jsonResponse({ ok: true, gameId: game.game_id, publishedAt: now, perfectCount: (perfectRows.results || []).length }, 200, cors);
}

async function rescoreAdminTestGamePreview(request, env, cors, game, user) {
  const input = await readJson(request);
  const metadata = testGameMetadata(game);
  const reason = validateManualRescoreInput({ ...input, gameId: game.game_id, gameDate: game.game_date, homeTeam: "f", awayTeam: "e" }, metadata);
  assertManualRescoreWindow(metadata);
  const actual = parseTestLineupInput(input?.lineup || input?.lineupText);
  if (!actual.ok) return jsonResponse({ ok: false, code: "TEST_LINEUP_INVALID", error: actual.error }, 400, cors);
  const current = await ensureCurrentLineupRevision(env.AUTH_DB, metadata);
  const summary = await buildManualRescorePreview(env.AUTH_DB, game.game_id, actual.lineup, 1);
  const version = Number(current.version) + 1;
  const fingerprint = await sha256Base64Url(JSON.stringify(actual.lineup));
  const now = new Date();
  const previewId = randomToken(20);
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare("INSERT INTO game_lineup_revisions (game_id, version, actual_lineup_json, lineup_fingerprint, source, created_at, created_by, reason, is_current, superseded_at) VALUES (?1, ?2, ?3, ?4, 'manual-revision', ?5, ?6, ?7, 0, NULL)").bind(game.game_id, version, JSON.stringify(actual.lineup), fingerprint, now.toISOString(), user.id, reason),
    env.AUTH_DB.prepare("INSERT INTO game_rescore_previews (id, game_id, lineup_version, created_by, reason, summary_json, expected_prediction_count, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)").bind(previewId, game.game_id, version, user.id, reason, JSON.stringify({ ...summary, candidateLineup: actual.lineup }), summary.processed, new Date(now.getTime() + MANUAL_RESCORE_PREVIEW_TTL_MS).toISOString(), now.toISOString()),
    env.AUTH_DB.prepare("INSERT INTO game_rescore_jobs (id, game_id, lineup_version, status, error_code, created_at, updated_at) VALUES (?1, ?2, ?3, 'previewed', NULL, ?4, ?4)").bind(previewId, game.game_id, version, now.toISOString())
  ]);
  return jsonResponse({ ok: true, gameId: game.game_id, previewId, lineupVersion: version, summary }, 200, cors);
}

async function rescoreAdminTestGameConfirm(request, env, cors, game, user) {
  const input = await readJson(request);
  const metadata = testGameMetadata(game);
  const reason = validateManualRescoreInput({ ...input, gameId: game.game_id, gameDate: game.game_date, homeTeam: "f", awayTeam: "e" }, metadata);
  assertManualRescoreWindow(metadata);
  const preview = await env.AUTH_DB.prepare("SELECT * FROM game_rescore_previews WHERE id = ?1 AND game_id = ?2 AND created_by = ?3 LIMIT 1").bind(String(input?.previewId || ""), game.game_id, user.id).first();
  if (!preview || preview.reason !== reason || Number(preview.lineup_version) !== Number(input?.lineupVersion)) return jsonResponse({ ok: false, code: "RESCORE_PREVIEW_INVALID", error: "再採点プレビューを確認してください。" }, 409, cors);
  if (new Date(preview.expires_at) < new Date()) return jsonResponse({ ok: false, code: "RESCORE_PREVIEW_EXPIRED", error: "再採点プレビューの有効期限が切れました。" }, 409, cors);
  const candidate = parseJsonArray((JSON.parse(preview.summary_json || "{}")).candidateLineup);
  const actual = sanitizeActualLineupForScoring(candidate);
  if (!actual.ok) return jsonResponse({ ok: false, code: "RESCORE_LINEUP_REQUIRED", error: actual.error }, 409, cors);
  const current = await getLineupRevision(env.AUTH_DB, game.game_id, preview.lineup_version);
  if (!current) return jsonResponse({ ok: false, code: "RESCORE_VERSION_CHANGED", error: "正式スタメンversionを確認してください。" }, 409, cors);
  const now = new Date();
  const claimResult = await env.AUTH_DB.prepare(
    `UPDATE game_rescore_jobs SET status = 'running', error_code = NULL, updated_at = ?1
      WHERE id = ?2 AND game_id = ?3 AND status = 'previewed'`
  ).bind(now.toISOString(), preview.id, game.game_id).run();
  if (Number(claimResult?.meta?.changes || 0) !== 1) return jsonResponse({ ok: false, code: "RESCORE_PREVIEW_INVALID", error: "再採点プレビューを確認してください。" }, 409, cors);
  await env.AUTH_DB.prepare("UPDATE game_lineup_revisions SET is_current = 0, superseded_at = ?1 WHERE game_id = ?2 AND is_current = 1").bind(now.toISOString(), game.game_id).run();
  await env.AUTH_DB.prepare("UPDATE game_lineup_revisions SET is_current = 1 WHERE game_id = ?1 AND version = ?2").bind(game.game_id, preview.lineup_version).run();
  const result = await applyManualRescore(env.AUTH_DB, metadata, current, { ...preview, expected_prediction_count: Number(preview.expected_prediction_count) }, user.id, reason, now, 1);
  await env.AUTH_DB.prepare("DELETE FROM game_rescore_previews WHERE id = ?1").bind(preview.id).run();
  return jsonResponse({ ok: true, gameId: game.game_id, ...result }, 200, cors);
}

async function handleMyAchievements(request, env, cors) {
  const access = await requireAuthenticatedUser(request, env, cors);
  if (!access.ok) return access.response;
  const achievements = await getUserAchievements(env.AUTH_DB, access.user.id);
  return jsonResponse({ ok: true, achievements: achievements.map(toPublicAchievement) }, 200, cors);
}

async function handleGetPerfectAchieversRanking(request, env, cors) {
  const options = parsePerfectAchieversQuery(new URL(request.url).searchParams);
  if (!options.ok) {
    return jsonResponse({ ok: false, error: options.error }, 400, cors);
  }

  const achievers = await getPerfectAchieversForDate(env.AUTH_DB, options);
  const response = jsonResponse({
    ok: true,
    date: options.date,
    achievers: achievers.rows,
    totalCount: achievers.totalCount,
    updatedAt: new Date().toISOString()
  }, 200, cors);
  response.headers.set("Cache-Control", "public, max-age=30");
  return response;
}

async function handleGetYearlyRanking(request, env, cors) {
  const options = parseYearlyRankingQuery(new URL(request.url).searchParams);
  if (!options.ok) {
    return jsonResponse({ ok: false, error: options.error }, 400, cors);
  }
  const ranking = await getRankingForPeriod(env.AUTH_DB, options);
  const response = jsonResponse({
    year: options.year,
    ranking: ranking.rows,
    summary: ranking.summary,
    pagination: ranking.pagination,
    updatedAt: new Date().toISOString()
  }, 200, cors);
  response.headers.set("Cache-Control", "public, max-age=30");
  return response;
}

async function handleGetMyYearlyRanking(request, env, cors) {
  const access = await requireAuthenticatedUser(request, env, cors);
  if (!access.ok) return access.response;

  const options = parseYearlyRankingQuery(new URL(request.url).searchParams);
  if (!options.ok) {
    return jsonResponse({ ok: false, error: options.error }, 400, cors);
  }
  const rankingData = await getRankingEntryForUser(env.AUTH_DB, access.user.id, options);
  return jsonResponse({ ok: true, year: options.year, rankingData }, 200, cors);
}

async function handleGetMonthlyRanking(request, env, cors) {
  const options = parseMonthlyRankingQuery(new URL(request.url).searchParams);
  if (!options.ok) {
    return jsonResponse({ ok: false, error: options.error }, 400, cors);
  }

  const ranking = await getRankingForPeriod(env.AUTH_DB, options);
  const response = jsonResponse({
    year: options.year,
    month: options.month,
    ranking: ranking.rows,
    summary: ranking.summary,
    pagination: ranking.pagination,
    updatedAt: new Date().toISOString()
  }, 200, cors);
  response.headers.set("Cache-Control", "public, max-age=30");
  return response;
}

async function handleGetMyMonthlyRanking(request, env, cors) {
  const access = await requireAuthenticatedUser(request, env, cors);
  if (!access.ok) return access.response;

  const options = parseMonthlyRankingQuery(new URL(request.url).searchParams);
  if (!options.ok) {
    return jsonResponse({ ok: false, error: options.error }, 400, cors);
  }

  const rankingData = await getRankingEntryForUser(env.AUTH_DB, access.user.id, options);
  return jsonResponse({
    ok: true,
    year: options.year,
    month: options.month,
    rankingData
  }, 200, cors);
}

function getJapanYearMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month) };
}

function parsePerfectAchieversQuery(searchParams) {
  const date = String(searchParams.get("date") || getJstDateString(new Date())).trim();
  const pagination = parseRankingPaginationQuery(searchParams);
  if (!pagination.ok) return pagination;
  if (!isValidPregameDate(date)) {
    return { ok: false, error: "dateはYYYY-MM-DD形式で指定してください。" };
  }
  if (date > getJstDateString(new Date())) {
    return { ok: false, error: "未来日の満点者は取得できません。" };
  }
  return { ok: true, date, ...pagination };
}

function parseYearlyRankingQuery(searchParams) {
  const current = getJapanYearMonth();
  const rawYear = searchParams.get("year");
  const pagination = parseRankingPaginationQuery(searchParams);
  if (!pagination.ok) return pagination;
  if (rawYear !== null && rawYear !== "" && !/^\d{4}$/.test(rawYear)) {
    return { ok: false, error: "yearは有効な4桁の年を指定してください。" };
  }
  const year = rawYear === null || rawYear === "" ? current.year : Number(rawYear);
  if (!Number.isInteger(year) || year < YEARLY_RANKING_MIN_YEAR) {
    return { ok: false, error: "yearは有効な4桁の年を指定してください。" };
  }
  if (year > current.year) {
    return { ok: false, error: "未来年の年間ランキングは取得できません。" };
  }
  return {
    ok: true,
    year,
    startAt: `${String(year).padStart(4, "0")}-01-01`,
    endAt: `${String(year + 1).padStart(4, "0")}-01-01`,
    ...pagination
  };
}

function parseMonthlyRankingQuery(searchParams) {
  const current = getJapanYearMonth();
  const rawYear = searchParams.get("year");
  const rawMonth = searchParams.get("month");
  const pagination = parseRankingPaginationQuery(searchParams);
  if (!pagination.ok) return pagination;

  if (rawYear !== null && rawYear !== "" && !/^\d{4}$/.test(rawYear)) {
    return { ok: false, error: "yearは有効な4桁の年を指定してください。" };
  }
  if (rawMonth !== null && rawMonth !== "" && !/^\d{1,2}$/.test(rawMonth)) {
    return { ok: false, error: "monthは1から12で指定してください。" };
  }
  const year = rawYear === null || rawYear === "" ? current.year : Number(rawYear);
  const month = rawMonth === null || rawMonth === "" ? current.month : Number(rawMonth);
  if (!Number.isInteger(year) || year < MONTHLY_RANKING_MIN_YEAR) {
    return { ok: false, error: "yearは有効な4桁の年を指定してください。" };
  }
  if (!/^\d{1,2}$/.test(String(month)) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, error: "monthは1から12で指定してください。" };
  }
  if (year > current.year || (year === current.year && month > current.month)) {
    return { ok: false, error: "未来月の月間ランキングは取得できません。" };
  }
  const nextMonthDate = new Date(Date.UTC(year, month, 1));
  return {
    ok: true,
    year,
    month,
    startAt: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`,
    endAt: nextMonthDate.toISOString().slice(0, 10),
    ...pagination
  };
}

function parseRankingPaginationQuery(searchParams) {
  const rawLimit = searchParams.get("limit");
  const rawOffset = searchParams.get("offset");
  const rawQualifiedOnly = searchParams.get("qualifiedOnly");
  if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > RANKING_MAX_LIMIT)) {
    return { ok: false, error: `limitは1から${RANKING_MAX_LIMIT}で指定してください。` };
  }
  if (rawOffset !== null && (!/^\d+$/.test(rawOffset) || Number(rawOffset) > RANKING_MAX_OFFSET)) {
    return { ok: false, error: "offsetが不正です。" };
  }
  if (rawQualifiedOnly !== null && !["true", "false", "1", "0"].includes(rawQualifiedOnly.trim().toLowerCase())) {
    return { ok: false, error: "qualifiedOnlyが不正です。" };
  }
  return {
    ok: true,
    limit: rawLimit === null ? RANKING_DEFAULT_LIMIT : Number(rawLimit),
    offset: rawOffset === null ? 0 : Number(rawOffset),
    qualifiedOnly: rawQualifiedOnly === null ? true : ["true", "1"].includes(rawQualifiedOnly.trim().toLowerCase())
  };
}

function createRankingCte() {
  // ?1 / ?2 are game_date period filters for the selected year or month.
  return `WITH eligible_games AS (
    SELECT game_id
     FROM ranking_games
     WHERE is_ranking_eligible = 1
       AND game_status = 'scored'
       AND is_test_game = 0
       AND (?1 IS NULL OR game_date >= ?1)
       AND (?2 IS NULL OR game_date < ?2)
  ), eligibility AS (
    SELECT COUNT(*) AS eligible_games FROM eligible_games
  ), threshold AS (
    SELECT eligible_games,
           CAST((eligible_games * 2 + 2) / 3 AS INTEGER) AS required_games
      FROM eligibility
  ), user_totals AS (
    SELECT predictions.user_id,
           users.username,
           COUNT(DISTINCT predictions.game_id) AS games_played,
           SUM(predictions.score) AS total_score,
           SUM(CASE WHEN predictions.score = predictions.max_score THEN 1 ELSE 0 END) AS perfect_count,
           MAX(predictions.score) AS best_score,
           MAX(predictions.scored_at) AS last_scored_at
      FROM predictions
      JOIN eligible_games ON eligible_games.game_id = predictions.game_id
      JOIN users ON users.id = predictions.user_id
     WHERE predictions.status = 'scored'
       AND predictions.score IS NOT NULL
       AND predictions.max_score IS NOT NULL
       AND predictions.is_test_prediction = 0
       AND users.status = 'active'
     GROUP BY predictions.user_id, users.username
  ), qualified_rows AS (
    SELECT user_totals.*,
           threshold.eligible_games,
           threshold.required_games,
           1 AS is_qualified,
           0 AS games_needed,
           RANK() OVER (
             ORDER BY (total_score * 1.0 / games_played) DESC,
                      perfect_count DESC,
                      total_score DESC,
                      games_played DESC
           ) AS ranking_rank
      FROM user_totals CROSS JOIN threshold
     WHERE games_played >= required_games
  ), unqualified_rows AS (
    SELECT user_totals.*,
           threshold.eligible_games,
           threshold.required_games,
           0 AS is_qualified,
           MAX(threshold.required_games - user_totals.games_played, 0) AS games_needed,
           NULL AS ranking_rank
      FROM user_totals CROSS JOIN threshold
     WHERE games_played < required_games
  ), combined AS (
    SELECT * FROM qualified_rows
    UNION ALL
    SELECT * FROM unqualified_rows
  )`;
}

export async function getPerfectAchieversForDate(db, { date, limit, offset }) {
  const latestPredictions = `WITH latest_predictions AS (
    SELECT predictions.id, predictions.user_id, predictions.game_id, predictions.score, predictions.max_score,
           predictions.opponent_code, predictions.submitted_at, predictions.status, predictions.is_test_prediction,
           ROW_NUMBER() OVER (
             PARTITION BY predictions.user_id, predictions.game_id
             ORDER BY predictions.updated_at DESC, predictions.submitted_at DESC, predictions.id DESC
           ) AS submission_rank
      FROM predictions
  )`;
  const conditions = `latest_predictions.submission_rank = 1
       AND latest_predictions.status = 'scored'
       AND latest_predictions.score IS NOT NULL
       AND latest_predictions.is_test_prediction = 0
       AND ranking_games.game_date = ?1
       AND ranking_games.is_ranking_eligible = 1
       AND ranking_games.game_status = 'scored'
       AND ranking_games.is_test_game = 0
       AND users.status = 'active'
       AND latest_predictions.score = latest_predictions.max_score`;
  const [countRow, rowsResult] = await Promise.all([
    db.prepare(`${latestPredictions}
      SELECT COUNT(*) AS total_count
        FROM latest_predictions
        JOIN ranking_games ON ranking_games.game_id = latest_predictions.game_id
        JOIN users ON users.id = latest_predictions.user_id
       WHERE ${conditions}`).bind(date).first(),
    db.prepare(`${latestPredictions}
      SELECT users.username,
             latest_predictions.score,
             ranking_games.game_date,
             latest_predictions.opponent_code,
             latest_predictions.submitted_at
        FROM latest_predictions
        JOIN ranking_games ON ranking_games.game_id = latest_predictions.game_id
        JOIN users ON users.id = latest_predictions.user_id
       WHERE ${conditions}
     ORDER BY latest_predictions.submitted_at ASC, latest_predictions.id ASC
     LIMIT ?2 OFFSET ?3`).bind(date, limit, offset).all()
  ]);

  const totalCount = Number(countRow?.total_count || 0);
  return {
    rows: (rowsResult.results || []).map((row) => ({
      username: row.username,
      score: Number(row.score),
      gameDate: row.game_date,
      opponent: row.opponent_code || "",
      submittedAt: row.submitted_at || null
    })),
    totalCount
  };
}

async function getRankingForPeriod(db, { limit, offset, qualifiedOnly, startAt = null, endAt = null }) {
  const cte = createRankingCte();
  const [summaryRow, countRow, rowsResult] = await Promise.all([
    db.prepare(`${cte}
      SELECT COALESCE(MAX(eligible_games), 0) AS eligible_games,
             COALESCE(MAX(required_games), 0) AS required_games,
             COALESCE(SUM(CASE WHEN is_qualified = 1 THEN 1 ELSE 0 END), 0) AS qualified_users,
             COUNT(*) AS total_users
        FROM combined`).bind(startAt, endAt).first(),
    db.prepare(`${cte}
      SELECT COUNT(*) AS total_users
        FROM combined
       WHERE (?3 = 0 OR is_qualified = 1)`).bind(startAt, endAt, qualifiedOnly ? 1 : 0).first(),
    db.prepare(`${cte}
      SELECT user_id, username, games_played, eligible_games, required_games, is_qualified, games_needed,
             total_score, (total_score * 1.0 / games_played) AS average_score,
             perfect_count, best_score, last_scored_at, ranking_rank
        FROM combined
       WHERE (?3 = 0 OR is_qualified = 1)
       ORDER BY is_qualified DESC,
                ranking_rank ASC,
                average_score DESC,
                perfect_count DESC,
                total_score DESC,
                games_played DESC,
                user_id ASC
       LIMIT ?4 OFFSET ?5`).bind(startAt, endAt, qualifiedOnly ? 1 : 0, limit, offset).all()
  ]);

  const internalRows = rowsResult.results || [];
  const achievementsByUser = await getRankingAchievementsByUser(db, internalRows.map((row) => row.user_id));
  const summary = {
    eligibleGames: Number(summaryRow?.eligible_games || 0),
    requiredGames: Number(summaryRow?.required_games || 0),
    qualifiedUsers: Number(summaryRow?.qualified_users || 0),
    totalUsers: Number(summaryRow?.total_users || 0)
  };

  return {
    rows: internalRows.map((row) => toPublicRankingRow(row, achievementsByUser.get(row.user_id))),
    summary,
    pagination: { limit, offset, totalUsers: Number(countRow?.total_users || 0) }
  };
}

async function getRankingEntryForUser(db, userId, { startAt = null, endAt = null } = {}) {
  const cte = createRankingCte();
  const row = await db.prepare(`${cte}
    SELECT user_id, username, games_played, eligible_games, required_games, is_qualified, games_needed,
           total_score, (total_score * 1.0 / games_played) AS average_score,
           perfect_count, best_score, last_scored_at, ranking_rank
      FROM combined
     WHERE user_id = ?3
     LIMIT 1`).bind(startAt, endAt, userId).first();
  return row ? toPublicRankingRow(row) : null;
}

function toPublicRankingRow(row, achievementSummary = null) {
  const eligibleGames = Number(row.eligible_games || 0);
  const gamesPlayed = Number(row.games_played || 0);
  return {
    rank: Number(row.is_qualified) === 1 ? Number(row.ranking_rank) : null,
    username: row.username,
    gamesPlayed,
    eligibleGames,
    requiredGames: Number(row.required_games || 0),
    participationRate: eligibleGames > 0 ? gamesPlayed / eligibleGames : 0,
    isQualified: Number(row.is_qualified) === 1,
    gamesNeeded: Number(row.games_needed || 0),
    totalScore: Number(row.total_score || 0),
    averageScore: Number(row.average_score || 0),
    perfectCount: Number(row.perfect_count || 0),
    bestScore: Number(row.best_score || 0),
    lastScoredAt: row.last_scored_at || null,
    ...(achievementSummary ? achievementSummary : {})
  };
}

async function getRankingAchievementsByUser(db, userIds) {
  const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
  const results = new Map();
  if (uniqueUserIds.length === 0) return results;

  const placeholders = uniqueUserIds.map((_, index) => `?${index + 1}`).join(", ");
  const rows = await db.prepare(
    `SELECT user_achievements.user_id, achievements.code, achievements.name, achievements.icon_key, achievements.rarity
       FROM user_achievements
       JOIN achievements ON achievements.id = user_achievements.achievement_id
      WHERE achievements.is_hidden = 0
        AND user_achievements.user_id IN (${placeholders})
      ORDER BY user_achievements.user_id ASC, user_achievements.earned_at DESC, achievements.code ASC`
  ).bind(...uniqueUserIds).all();

  for (const row of rows.results || []) {
    const current = results.get(row.user_id) || [];
    current.push({ code: row.code, name: row.name, iconKey: row.icon_key, rarity: row.rarity });
    results.set(row.user_id, current);
  }
  for (const [userId, achievements] of results) {
    results.set(userId, {
      achievements: achievements.slice(0, RANKING_ACHIEVEMENT_DISPLAY_LIMIT),
      achievementCount: achievements.length
    });
  }
  return results;
}

async function handleDevelopmentAchievements(env, cors, user) {
  const [master, earned] = await Promise.all([
    getAchievementMaster(env.AUTH_DB),
    getUserAchievements(env.AUTH_DB, user.id)
  ]);
  return jsonResponse({
    ok: true,
    achievements: master.map(toDevelopmentAchievement),
    earned: earned.map(toDevelopmentAchievement)
  }, 200, cors);
}

async function handleDevelopmentAchievementGrant(request, env, cors, user) {
  const input = await readJson(request);
  const code = normalizeAchievementCode(input?.code);
  if (!code) return jsonResponse({ ok: false, error: "実績codeが不正です。" }, 400, cors);
  const achievement = await getAchievementByCode(env.AUTH_DB, code);
  if (!achievement) return jsonResponse({ ok: false, error: "指定された実績は存在しません。" }, 404, cors);
  const now = new Date().toISOString();
  const result = await env.AUTH_DB.prepare(
    `INSERT OR IGNORE INTO user_achievements
       (id, user_id, achievement_id, earned_at, source, metadata_json, created_at)
     VALUES (?1, ?2, ?3, ?4, 'development', NULL, ?4)`
  ).bind(randomToken(16), user.id, achievement.id, now).run();
  return jsonResponse({
    ok: true,
    granted: Number(result?.meta?.changes || 0) === 1,
    achievement: toPublicAchievement({ ...achievement, earned_at: now })
  }, 200, cors);
}

async function handleDevelopmentAchievementDelete(env, cors, user, rawCode) {
  const code = normalizeAchievementCode(rawCode);
  if (!code) return jsonResponse({ ok: false, error: "実績codeが不正です。" }, 400, cors);
  const result = await env.AUTH_DB.prepare(
    `DELETE FROM user_achievements
      WHERE user_id = ?1
        AND source = 'development'
        AND achievement_id = (SELECT id FROM achievements WHERE code = ?2 LIMIT 1)`
  ).bind(user.id, code).run();
  return jsonResponse({ ok: true, removed: Number(result?.meta?.changes || 0) === 1 }, 200, cors);
}

function normalizeAchievementCode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  return /^[a-z][a-z0-9_]{2,63}$/.test(code) ? code : "";
}

async function getAchievementMaster(db) {
  const result = await db.prepare(
    `SELECT id, code, name, description, icon_key, rarity, is_hidden
       FROM achievements
      ORDER BY CASE rarity WHEN 'limited' THEN 1 WHEN 'epic' THEN 2 WHEN 'rare' THEN 3 ELSE 4 END, code ASC`
  ).all();
  return result.results || [];
}

async function getAchievementByCode(db, code) {
  return db.prepare(
    `SELECT id, code, name, description, icon_key, rarity, is_hidden
       FROM achievements WHERE code = ?1 LIMIT 1`
  ).bind(code).first();
}

async function getUserAchievements(db, userId) {
  const result = await db.prepare(
    `SELECT achievements.id, achievements.code, achievements.name, achievements.description,
            achievements.icon_key, achievements.rarity, achievements.is_hidden,
            user_achievements.earned_at, user_achievements.source
       FROM user_achievements
       JOIN achievements ON achievements.id = user_achievements.achievement_id
      WHERE user_achievements.user_id = ?1
      ORDER BY user_achievements.earned_at DESC, achievements.code ASC`
  ).bind(userId).all();
  return result.results || [];
}

function toPublicAchievement(row) {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    iconKey: row.icon_key,
    rarity: row.rarity,
    earnedAt: row.earned_at
  };
}

function toDevelopmentAchievement(row) {
  return {
    ...toPublicAchievement(row),
    source: row.source || "",
    isHidden: Number(row.is_hidden || 0) === 1
  };
}

async function handleCreateAdminTestPerfectPrediction(env, cors, user, metadata) {
  const record = await getGameLineup(env.AUTH_DB, metadata.gameId);
  const actualResult = sanitizeActualLineupForScoring(parseStoredActualLineup(record?.actual_lineup_json));
  if (!actualResult.ok) {
    return jsonResponse({ ok: false, error: "完全一致予想を作成するには、9人分の実スタメンを保存してください。" }, 409, cors);
  }
  const existing = await getPredictionRow(env.AUTH_DB, user.id, metadata.gameId);
  const now = new Date().toISOString();
  const prediction = {
    schemaVersion: PREDICTION_SCHEMA_VERSION,
    lineup: actualResult.lineup
  };
  const predictionJson = JSON.stringify(prediction);
  const id = existing?.id || randomToken(16);
  await env.AUTH_DB.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version, game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, locked_at, status, score, max_score, scored_at, actual_lineup_json, is_test_prediction)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, NULL, 'submitted', NULL, NULL, NULL, NULL, 1)
     ON CONFLICT(user_id, game_id) DO UPDATE SET
       prediction_json = excluded.prediction_json, schema_version = excluded.schema_version, updated_at = excluded.updated_at,
       locked_at = NULL, status = 'submitted', score = NULL, max_score = NULL, scored_at = NULL, actual_lineup_json = NULL,
       is_test_prediction = 1`
  ).bind(id, user.id, metadata.gameId, predictionJson, PREDICTION_SCHEMA_VERSION, metadata.date, metadata.homeCode, metadata.awayCode, metadata.opponentCode, metadata.isHome ? 1 : 0, now).run();
  return jsonResponse({ ok: true, gameId: metadata.gameId, created: !existing, updated: Boolean(existing) }, 200, cors);
}

async function handleAdminGameScheduleUpdate(request, env, cors, metadata, user) {
  const now = new Date();
  try {
    const input = await readJson(request);
    const currentColumns = await getTableColumnSet(env.AUTH_DB, "games");
    const current = await env.AUTH_DB.prepare(
      `SELECT game_date, start_time, home_team, away_team, game_status${currentColumns.has("npb_game_code") ? ", npb_game_code" : ""}${currentColumns.has("season") ? ", season" : ""}${currentColumns.has("stadium") ? ", stadium" : ""}${currentColumns.has("is_active") ? ", is_active" : ""}
         FROM games WHERE internal_game_id = ?1 LIMIT 1`
    ).bind(metadata.internalGameId).first();
    if (!current) return jsonResponse({ ok: false, code: "GAME_NOT_FOUND", error: "対象試合が見つかりません。" }, 404, cors);
    const reason = String(input?.reason || "").trim();
    if (!reason || reason.length > 240) return jsonResponse({ ok: false, code: "SCHEDULE_CHANGE_REASON_REQUIRED", error: "日程変更理由を入力してください。" }, 400, cors);
    const startAt = new Date(input?.startAt || current.start_time || "");
    if (Number.isNaN(startAt.getTime())) return jsonResponse({ ok: false, code: "SCHEDULE_START_AT_INVALID", error: "試合開始時刻が不正です。" }, 400, cors);
    const gameDate = String(input?.gameDate || current.game_date || "").trim();
    const homeTeam = String(input?.homeTeam || current.home_team || "").trim();
    const awayTeam = String(input?.awayTeam || current.away_team || "").trim();
    const status = String(input?.status || current.game_status || "scheduled").trim().toLowerCase();
    const npbGameCode = String(input?.npbGameCode || current.npb_game_code || "").trim();
    const season = input?.season === undefined ? current.season : Number(input.season);
    const stadium = String(input?.stadium === undefined ? (current.stadium || "") : input.stadium).trim().slice(0, 160);
    const isActive = input?.isActive === undefined ? Number(current.is_active ?? 1) : (input.isActive ? 1 : 0);
    const v3Schedule = deriveV3Schedule({ startAt });
    const canonical = v3Schedule ? {
      startAt: v3Schedule.startAt.toISOString(),
      predictionDeadline: v3Schedule.predictionDeadline.toISOString(),
      rosterFetchAt1: v3Schedule.rosterFetchAt1.toISOString(),
      rosterFetchAt2: v3Schedule.rosterFetchAt2.toISOString(),
      lineupPollingStart: v3Schedule.lineupPollingStart.toISOString(),
      finalLineupAt: v3Schedule.finalLineupAt.toISOString(),
      publicationAt: v3Schedule.publicationAt.toISOString()
    } : null;
    if (!canonical) return jsonResponse({ ok: false, code: "SCHEDULE_INPUT_INVALID", error: "日程情報が不正です。" }, 400, cors);
    const previousStartAt = new Date(current.start_time || "");
    const previousDeadline = Number.isNaN(previousStartAt.getTime()) ? null : new Date(previousStartAt.getTime() - V3_TIMING.predictionDeadlineMinutes * 60000);
    const wasClosed = previousDeadline && now >= previousDeadline;
    const scheduleColumns = await getTableColumnSet(env.AUTH_DB, "game_schedule_change_history");
    if (!scheduleColumns.size) return jsonResponse({ ok: false, code: "V3_SCHEDULE_SCHEMA_NOT_READY", error: "日程変更履歴のスキーマが準備されていません。" }, 503, cors);

    const fields = ["game_date = ?1", "start_time = ?2", "home_team = ?3", "away_team = ?4", "game_status = ?5", "updated_at = ?6"];
    const values = [gameDate, canonical.startAt, homeTeam, awayTeam, status, now.toISOString()];
    if (currentColumns.has("npb_game_code")) { fields.push(`npb_game_code = ?${values.length + 1}`); values.push(npbGameCode || null); }
    if (currentColumns.has("season")) { fields.push(`season = ?${values.length + 1}`); values.push(Number.isInteger(season) ? season : null); }
    if (currentColumns.has("stadium")) { fields.push(`stadium = ?${values.length + 1}`); values.push(stadium || null); }
    if (currentColumns.has("is_active")) { fields.push(`is_active = ?${values.length + 1}`); values.push(isActive); }
    if (currentColumns.has("deleted_at")) { fields.push(`deleted_at = ?${values.length + 1}`); values.push(isActive ? null : now.toISOString()); }
    if (currentColumns.has("prediction_deadline_at")) { fields.push(`prediction_deadline_at = ?${values.length + 1}`); values.push(canonical.predictionDeadline); }
    if (currentColumns.has("roster_fetch_at1")) { fields.push(`roster_fetch_at1 = ?${values.length + 1}`); values.push(canonical.rosterFetchAt1); }
    if (currentColumns.has("roster_fetch_at2")) { fields.push(`roster_fetch_at2 = ?${values.length + 1}`); values.push(canonical.rosterFetchAt2); }
    if (currentColumns.has("lineup_polling_start_at")) { fields.push(`lineup_polling_start_at = ?${values.length + 1}`); values.push(canonical.lineupPollingStart); }
    if (currentColumns.has("final_lineup_at")) { fields.push(`final_lineup_at = ?${values.length + 1}`); values.push(canonical.finalLineupAt); }
    if (currentColumns.has("publication_at")) { fields.push(`publication_at = ?${values.length + 1}`); values.push(canonical.publicationAt); }
    if (currentColumns.has("updated_by")) { fields.push(`updated_by = ?${values.length + 1}`); values.push(user?.id ? `admin:${user.id}` : "admin"); }
    const gameIdPlaceholder = `?${values.length + 1}`;
    values.push(metadata.internalGameId);
    await env.AUTH_DB.prepare(`UPDATE games SET ${fields.join(", ")} WHERE internal_game_id = ${gameIdPlaceholder}`).bind(...values).run();
    await env.AUTH_DB.prepare(
      `INSERT INTO game_schedule_change_history
         (internal_game_id, previous_start_at, next_start_at, previous_status, next_status, reason, changed_by, changed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(metadata.internalGameId, current.start_time || null, canonical.startAt, current.game_status || null, status, reason, user?.id ? String(user.id) : "admin", now.toISOString()).run();

    if (status === "cancelled" || status === "postponed") {
      const cancellationReason = status === "postponed"
        ? "postponed"
        : (now < startAt ? "cancelled_before_start" : "cancelled_after_start");
      const rankingState = await getRankingGameState(env.AUTH_DB, metadata.gameId);
      if (rankingState) {
        await setRankingEligibility(env.AUTH_DB, {
          gameId: metadata.gameId,
          internalGameId: metadata.internalGameId,
          status: RANKING_ELIGIBILITY_STATUS.EXCLUDED,
          reason: cancellationReason,
          note: reason,
          updatedBy: user?.id ? `admin:${user.id}` : "admin",
          now
        });
      }
    }

    if (wasClosed) {
      const v3State = await env.AUTH_DB.prepare("SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1").bind(metadata.internalGameId).first();
      if (v3State?.state === "scheduled") {
        await transitionV3State(env.AUTH_DB, { internalGameId: metadata.internalGameId, from: "scheduled", to: "prediction_closed", now });
      }
    }
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_schedule_changed",
      status: "success",
      gameId: metadata.gameId,
      occurredAt: now,
      message: "管理者が試合日程を変更しました。",
      metadata: { internalGameId: metadata.internalGameId, predictionDeadline: canonical.predictionDeadline, lineupPollingStart: canonical.lineupPollingStart, finalLineupAt: canonical.finalLineupAt },
      source: "admin"
    });
    return jsonResponse({ ok: true, schedule: canonical, predictionReopened: false }, 200, cors);
  } catch (error) {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_schedule_changed",
      status: "error",
      gameId: metadata?.gameId || "",
      occurredAt: now,
      message: "管理者による日程変更に失敗しました。",
      errorCode: String(error?.code || "SCHEDULE_UPDATE_FAILED"),
      source: "admin"
    }).catch(() => {});
    return jsonResponse({ ok: false, code: String(error?.code || "SCHEDULE_UPDATE_FAILED"), error: "試合日程を変更できませんでした。" }, Number(error?.httpStatus) || 500, cors);
  }
}

function parseAdminScoringRoute(path) {
  const match = /^\/api\/admin\/games\/([^/]+)\/(schedule|predictions\/(?:summary|score-predictions(?:\/preview)?)|actual-lineup|lineup-history|lineup-revisions|rescore-preview|rescore-confirm|restore-lineup-version|rescore-history|service-unavailable|restore-service-unavailable|ranking-eligibility|auto-scoring\/(?:status|run-now|retry|cancel)|pregame-automation\/(?:run-roster|run-lineup|run-notice|distribute-notice|fix-roster|publish|pause-workflow|resume-workflow))$/.exec(path);
  if (!match) {
    return null;
  }

  let gameId = "";
  try {
    gameId = decodeURIComponent(match[1]);
  } catch {
    return { invalid: true };
  }

  return { gameId, action: match[2] };
}

async function handleAdminScoringRoute(request, env, cors, route) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) {
    return access.response;
  }

  if (request.method !== "GET") return legacyAdminOperationRetiredResponse(cors);

  if (route.invalid) return jsonResponse({ ok: false, code: "INVALID_GAME_IDENTIFIER_FORMAT", error: "対象試合のgameIdが不正です。" }, 400, cors);
  const reference = await resolveApiGameReference(env.AUTH_DB, route.gameId);
  if (!reference.ok) return jsonResponse({ ok: false, code: reference.code, error: "対象試合のgameIdが不正です。" }, 400, cors);
  const metadata = reference.metadata;
  if (metadata.internalGameId && request.method !== "GET" && isV3ManagedAdminMutation(route.action)
    && await isV3ManagedGame(env.AUTH_DB, metadata.internalGameId)) {
    return jsonResponse({ ok: false, code: "V3_MANAGED_GAME_USE_V3_API", error: "この試合はV3管理APIを使用してください。" }, 409, cors);
  }
  if (route.action === "schedule" && request.method === "PUT") {
    return await handleAdminGameScheduleUpdate(request, env, cors, metadata, access.user);
  }

  if (route.action === "predictions/summary" && request.method === "GET") {
    return await handleAdminPredictionSummary(env, cors, metadata.gameId);
  }
  if (route.action === "score-predictions/preview" && request.method === "POST") {
    return await handleAdminScorePredictionsPreview(request, env, cors, metadata.gameId);
  }
  if (route.action === "score-predictions" && request.method === "POST") {
    return await handleAdminScorePredictions(request, env, cors, metadata.gameId);
  }
  if (route.action === "actual-lineup" && request.method === "POST") {
    return await handleAdminActualLineupSave(request, env, cors, metadata.gameId, metadata);
  }
  if (route.action === "service-unavailable" && request.method === "POST") {
    return await handleAdminServiceUnavailable(env, cors, metadata.gameId, true);
  }
  if (route.action === "restore-service-unavailable" && request.method === "POST") {
    return await handleAdminServiceUnavailable(env, cors, metadata.gameId, false);
  }
  if (route.action === "ranking-eligibility" && request.method === "GET") {
    return jsonResponse({ ok: true, gameId: metadata.gameId, rankingEligibility: await getRankingEligibilityState(env.AUTH_DB, metadata.gameId) }, 200, cors);
  }
  if (route.action === "ranking-eligibility" && request.method === "PUT") {
    return await handleAdminRankingEligibilityUpdate(request, env, cors, metadata, access.user);
  }
  if (route.action === "lineup-history" && request.method === "GET") {
    return await handleAdminLineupHistory(env, cors, metadata.gameId);
  }
  if (route.action === "rescore-history" && request.method === "GET") {
    return await handleAdminRescoreHistory(env, cors, metadata.gameId);
  }
  if (route.action === "lineup-revisions" && request.method === "POST") {
    return await handleAdminLineupRevision(request, env, cors, metadata, access.user);
  }
  if (route.action === "restore-lineup-version" && request.method === "POST") {
    return await handleAdminLineupRestore(request, env, cors, metadata, access.user);
  }
  if (route.action === "rescore-preview" && request.method === "POST") {
    return await handleAdminRescorePreview(request, env, cors, metadata, access.user);
  }
  if (route.action === "rescore-confirm" && request.method === "POST") {
    return await handleAdminRescoreConfirm(request, env, cors, metadata, access.user);
  }
  if (route.action === "auto-scoring/status" && request.method === "GET") {
    return await handleAdminAutoScoringStatus(env, cors, metadata.gameId);
  }
  if (route.action === "auto-scoring/run-now" && request.method === "POST") {
    try {
      return await handleAdminAutoScoringRunNow(env, cors, metadata.gameId);
    } catch (error) {
      return createPregameToolErrorResponse(cors, metadata.gameId, "auto-scoring/run-now", error);
    }
  }
  if (route.action === "auto-scoring/retry" && request.method === "POST") {
    return await handleAdminAutoScoringRetry(env, cors, metadata.gameId);
  }
  if (route.action === "auto-scoring/cancel" && request.method === "POST") {
    return await handleAdminAutoScoringCancel(env, cors, metadata.gameId);
  }
  if (route.action === "pregame-automation/pause-workflow" && request.method === "POST") {
    return await handleAdminGameWorkflowPause(env, cors, metadata.gameId, true);
  }
  if (route.action === "pregame-automation/resume-workflow" && request.method === "POST") {
    return await handleAdminGameWorkflowPause(env, cors, metadata.gameId, false);
  }
  if (route.action === "pregame-automation/run-roster" && request.method === "POST") {
    return await executePregameTool(env, cors, metadata.gameId, "run-roster", () => captureGameRosterSnapshot(env, metadata.gameId, new Date(), {
      force: true,
      source: "admin",
      target: { ...metadata, gameId: metadata.gameId, internalGameId: metadata.internalGameId }
    }));
  }
  if (route.action === "pregame-automation/run-lineup" && request.method === "POST") {
    return await executePregameTool(env, cors, metadata.gameId, "run-lineup", () => captureOfficialLineup(env, metadata.gameId, new Date(), {
      force: true,
      internalGameId: metadata.internalGameId || "",
      target: { ...metadata, gameId: metadata.gameId, internalGameId: metadata.internalGameId }
    }));
  }
  if (route.action === "pregame-automation/run-notice" && request.method === "POST") {
    return await executePregameTool(env, cors, metadata.gameId, "run-notice", () => runGameDayNoticeOnce(env, new Date(), metadata.gameId));
  }
  if (route.action === "pregame-automation/distribute-notice" && request.method === "POST") {
    return await executePregameTool(env, cors, metadata.gameId, "distribute-notice", () => distributeStoredGameDayNotice(env, metadata.gameId, new Date()));
  }
  if (route.action === "pregame-automation/fix-roster" && request.method === "POST") {
    return await executePregameTool(env, cors, metadata.gameId, "fix-roster", () => fixGameRosterAtDeadline(env, metadata.gameId, new Date()));
  }
  if (route.action === "pregame-automation/publish" && request.method === "POST") {
    return await executePregameTool(env, cors, metadata.gameId, "publish", () => publishScoredGameResults(env, metadata.gameId, new Date()));
  }

  return jsonResponse({ ok: false, error: "管理者採点APIのHTTPメソッドが不正です。" }, 405, cors);
}

const V3_MANAGED_ADMIN_MUTATIONS = new Set([
  "schedule", "actual-lineup", "lineup-revisions", "restore-lineup-version", "rescore-preview", "rescore-confirm",
  "predictions/score-predictions", "predictions/score-predictions/preview",
  "service-unavailable", "restore-service-unavailable", "ranking-eligibility", "auto-scoring/run-now", "auto-scoring/retry",
  "auto-scoring/cancel", "pregame-automation/run-roster", "pregame-automation/run-lineup", "pregame-automation/publish",
  "pregame-automation/pause-workflow", "pregame-automation/resume-workflow"
]);

function isV3ManagedAdminMutation(action) {
  return V3_MANAGED_ADMIN_MUTATIONS.has(String(action || ""));
}

async function isV3ManagedGame(db, internalGameId) {
  try {
    const row = await db.prepare(
      `SELECT 1 FROM game_automation_v3_state WHERE internal_game_id = ?1
       UNION ALL
       SELECT 1 FROM game_jobs_v3 WHERE internal_game_id = ?1 LIMIT 1`
    ).bind(internalGameId).first();
    return Boolean(row);
  } catch (error) {
    if (isPregameSchemaError(error)) return false;
    throw error;
  }
}

async function executePregameTool(env, cors, gameId, action, operation) {
  try {
    const result = await operation();
    const metadata = PREGAME_TOOL_ACTIONS[action] || { logAction: action };
    const upstreamFields = metadata.upstreamMode
      ? `transport=${metadata.transport || "-"} action=${metadata.logAction} gameId=${gameId} upstreamPath=/ mode=${metadata.upstreamMode}`
      : `action=${metadata.logAction} gameId=${gameId}`;
    const noticeFields = action === "run-notice"
      ? ` noticeDate=${result?.noticeDate || "-"} pageDate=${result?.pageDate || "-"} registrationCount=${Number(result?.registrationCount || 0)} removalCount=${Number(result?.removalCount || 0)} isEmpty=${result?.isEmpty === true}`
      : "";
    console.log(`[PREGAME_TOOL] ${upstreamFields} upstreamStatus=${Number(result?.upstreamStatus || 200)}${noticeFields} status=success`);
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_manual_operation",
      status: "success",
      gameId,
      occurredAt: new Date(),
      message: `${metadata.label || action}を実行しました。`,
      metadata: { action, upstreamStatus: Number(result?.upstreamStatus || 200) },
      source: "admin"
    });
    return jsonResponse({ ok: true, gameId, result }, 200, cors);
  } catch (error) {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_manual_operation",
      status: "error",
      gameId,
      occurredAt: new Date(),
      message: `${PREGAME_TOOL_ACTIONS[action]?.label || action}に失敗しました。`,
      errorCode: String(error?.code || "PREGAME_TOOL_FAILED"),
      metadata: { action },
      source: "admin"
    });
    return createPregameToolErrorResponse(cors, gameId, action, error);
  }
}

async function getManagedGameJobSummary(db, internalGameId) {
  if (!internalGameId) return { pendingCount: 0, retryCount: 0, nextExecutionAt: null, jobs: [], lineupJobs: [], lineupFetchStatus: { provisional: null, final: null }, lineupFetchState: "not_started", lastFetchAttempt: null, validation: null, scoringEligibility: { eligible: false, status: "waiting", reasonCode: "FINAL_LINEUP_REQUIRED" }, warnings: [], errors: [] };
  const result = await db.prepare(
    `SELECT id, job_type, status, scheduled_slot_at, next_attempt_at, error_code, error_detail,
            source, attempt_count, max_attempts, claimed_at, lease_expires_at,
            started_at, completed_at, result_metadata, updated_at
       FROM game_job_runs
      WHERE internal_game_id = ?1
      ORDER BY COALESCE(next_attempt_at, scheduled_slot_at) ASC, job_type ASC`
  ).bind(internalGameId).all();
  const jobs = (result?.results || []).map((row) => ({
    id: Number(row.id),
    jobType: row.job_type,
    status: row.status,
    scheduledAt: row.scheduled_slot_at || null,
    nextAttemptAt: row.next_attempt_at || null,
    errorCode: row.error_code || null,
    errorDetail: row.error_detail || null,
    source: row.source || null,
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 0),
    claimedAt: row.claimed_at || null,
    leaseExpiresAt: row.lease_expires_at || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at || null,
    recoveryMode: (() => {
      const metadata = parseSafeWorkflowJobMetadata(row.result_metadata);
      return metadata.recoveryMode || null;
    })(),
    recoveryReasonCode: (() => parseSafeWorkflowJobMetadata(row.result_metadata).recoveryReasonCode || null)(),
    recoveredAt: (() => parseSafeWorkflowJobMetadata(row.result_metadata).recoveredAt || null)(),
    previousErrorCode: (() => parseSafeWorkflowJobMetadata(row.result_metadata).previousErrorCode || null)(),
    previousErrorDetail: (() => parseSafeWorkflowJobMetadata(row.result_metadata).previousErrorDetail || null)(),
    attemptCountBeforeRecovery: (() => {
      const value = parseSafeWorkflowJobMetadata(row.result_metadata).attemptCountBeforeRecovery;
      return Number.isFinite(value) ? value : null;
    })(),
    attemptCountChanged: (() => {
      const value = parseSafeWorkflowJobMetadata(row.result_metadata).attemptCountChanged;
      return typeof value === "boolean" ? value : null;
    })(),
    workflowTerminalOverrideApplied: (() => parseSafeWorkflowJobMetadata(row.result_metadata).workflowTerminalOverrideApplied === true)(),
    validation: (() => {
      const metadata = parseSafeWorkflowJobMetadata(row.result_metadata);
      return sanitizeLineupValidationDetails({
        ...metadata.validation,
        parseStage: metadata.parseStage,
        sourceUrlHost: metadata.sourceUrlHost,
        httpStatus: metadata.httpStatus,
        retryable: metadata.retryable
      });
    })(),
    targetResolution: parseSafeWorkflowJobMetadata(row.result_metadata).targetResolution || null
  }));
  const pending = jobs.filter((job) => ["pending", "claimed", "running"].includes(job.status));
  const retry = jobs.filter((job) => job.status === "retry_wait");
  const nextExecutionAt = jobs
    .map((job) => job.nextAttemptAt || job.scheduledAt)
    .filter(Boolean)
    .sort()[0] || null;
  const lineupDiagnostics = summarizeLineupWorkflowJobs(jobs);
  return { pendingCount: pending.length, retryCount: retry.length, nextExecutionAt, jobs, lineupJobs: lineupDiagnostics.lineupJobs, lineupFetchStatus: lineupDiagnostics.lineupFetchStatus, lineupFetchState: lineupDiagnostics.status, lastFetchAttempt: lineupDiagnostics.lastFetchAttempt, validation: lineupDiagnostics.validation, scoringEligibility: lineupDiagnostics.scoringEligibility, warnings: lineupDiagnostics.warnings, errors: lineupDiagnostics.errors };
}

async function getAdminPublicationWorkflowAudit(db, {
  internalGameId,
  legacyGameId,
  workflowStatus = "",
  jobSummary = {},
  recoveryLog = null,
  recoveryVisitLog = null,
  scoreResultCount = null,
  now = new Date()
} = {}) {
  const lineup = await getGameLineup(db, { gameId: legacyGameId, internalGameId });
  const ranking = await getRankingReflectionState(db, legacyGameId);
  const publicationJob = (jobSummary.jobs || []).find((job) => job.jobType === "publication" && job.status !== "cancelled") || null;
  const publishedAt = lineup?.published_at || ranking.row?.published_at || null;
  const publicationStatus = lineup?.publication_status || ranking.row?.publication_status || "pending";
  let publicationTarget = null;
  let publicationTargetError = null;
  try {
    publicationTarget = await resolvePublicationTarget(db, internalGameId, legacyGameId);
  } catch (error) {
    publicationTargetError = error;
  }
  const targetResolution = publicationTarget?.targetResolution || publicationTargetError?.targetResolution || null;
  const identifierConflict = Array.isArray(targetResolution?.identifierConflicts) && targetResolution.identifierConflicts.length > 0;
  const publicationRecovery = getPublicationJobRecoveryEligibility({
    jobType: publicationJob?.jobType,
    status: publicationJob?.status,
    errorCode: publicationJob?.errorCode,
    errorDetail: publicationJob?.errorDetail,
    publishedAt,
    publicationStatus,
    scoringPersisted: lineup?.scoring_status === "scored",
    scoreResultCount,
    rankingReflected: ranking.reflected,
    internalGameIdMatches: Boolean(lineup && String(lineup.internal_game_id || "") === String(internalGameId || "")),
    identifierConflict,
    attemptCount: publicationJob?.attemptCount,
    maxAttempts: publicationJob?.maxAttempts
  });
  const recoveryLogMetadata = parseJsonObject(recoveryLog?.metadata);
  const recoveryVisitMetadata = parseJsonObject(recoveryVisitLog?.metadata);
  const publicationRecoveryCronVisited = Boolean(recoveryVisitLog);
  const publicationRecoveryApplied = [
    "publication_legacy_schedule_error",
    "publication_executor_reference_error"
  ].includes(publicationJob?.recoveryMode)
    || [
      "publication_legacy_schedule_error",
      "publication_executor_reference_error"
    ].includes(recoveryLogMetadata?.recoveryMode);
  const publicationRecoveryDetected = publicationRecovery.eligible || publicationRecoveryApplied
    || recoveryLogMetadata?.originalErrorCode === PUBLICATION_LEGACY_ERROR_CODE
    || recoveryLogMetadata?.originalErrorCode === PUBLICATION_REFERENCE_ERROR_CODE
      && recoveryLogMetadata?.originalErrorDetail === PUBLICATION_REFERENCE_ERROR_DETAIL;
  const workflowTerminalOverrideApplied = publicationJob?.workflowTerminalOverrideApplied === true
    || recoveryLogMetadata?.workflowTerminalOverrideApplied === true;
  const staleLeaseDetected = Boolean(publicationJob
    && ["claimed", "running"].includes(publicationJob.status)
    && publicationJob.leaseExpiresAt
    && new Date(publicationJob.leaseExpiresAt).getTime() <= now.getTime());
  const reconciliation = getPublicationWorkflowReconciliationEligibility({
    workflowStatus,
    publicationStatus,
    publishedAt,
    finalLineupScored: lineup?.scoring_status === "scored",
    rankingReflected: ranking.reflected,
    internalGameIdMatches: Boolean(lineup && String(lineup.internal_game_id || "") === String(internalGameId || "")),
    identifierConflict: false
  });
  const successfulJobs = (jobSummary.jobs || [])
    .filter((job) => job.status === "succeeded" && job.completedAt)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
  const currentErrors = (jobSummary.jobs || [])
    .filter((job) => ["claimed", "running", "retry_wait", "permanently_failed"].includes(job.status) && job.errorCode)
    .map((job) => job.errorCode);
  let stalePregameErrorIgnored = false;
  try {
    const pregame = await db.prepare(
      "SELECT last_error_code FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1"
    ).bind(legacyGameId).first();
    stalePregameErrorIgnored = STALE_PREGAME_SCHEDULE_ERROR_CODES.has(String(pregame?.last_error_code || ""))
      && Boolean(lineup?.scoring_status === "scored" && ranking.reflected);
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  const currentPublicationError = publicationRecoveryApplied
    ? null
    : publicationRecovery.eligible
    ? { code: "PUBLICATION_RECOVERY_ELIGIBLE", previousCode: publicationJob?.errorCode || null }
    : (currentErrors[0] ? { code: currentErrors[0], detail: publicationJob?.errorDetail || null } : null);
  const previousPublicationError = publicationRecoveryDetected
    ? {
        code: publicationJob?.previousErrorCode || recoveryLogMetadata?.previousErrorCode || recoveryLogMetadata?.originalErrorCode || PUBLICATION_LEGACY_ERROR_CODE,
        detail: publicationJob?.previousErrorDetail
          || recoveryLogMetadata?.previousErrorDetail
          || (publicationJob?.previousErrorCode === PUBLICATION_REFERENCE_ERROR_CODE
            ? PUBLICATION_REFERENCE_ERROR_DETAIL
            : PUBLICATION_LEGACY_ERROR_DETAIL)
      }
    : null;
  const publicationRecoveredJobId = publicationRecoveryApplied
    ? (Number.isInteger(Number(publicationJob?.id)) ? Number(publicationJob.id) : Number(recoveryLogMetadata?.recoveredJobId) || null)
    : (Number(recoveryLogMetadata?.recoveredJobId) || null);
  const publicationRecoveredAt = publicationRecoveryApplied
    ? (publicationJob?.recoveredAt || recoveryLogMetadata?.recoveredAt || recoveryLog?.occurred_at || null)
    : (recoveryLogMetadata?.recoveredAt || recoveryLog?.occurred_at || null);
  const recoveryAttemptCountPreserved = publicationRecoveryDetected
    ? (publicationJob?.attemptCountChanged === false
      || (Number.isFinite(publicationJob?.attemptCountBeforeRecovery) && Number(publicationJob.attemptCountBeforeRecovery) === Number(publicationJob.attemptCount)))
    : false;
  return {
    status: publicationStatus,
    workflowStatus: workflowStatus || "unknown",
    jobStatus: publicationJob?.status || "not_started",
    scheduledAt: publicationJob?.scheduledAt || null,
    nextAttemptAt: publicationJob?.nextAttemptAt || null,
    attemptCount: publicationJob ? Number(publicationJob.attemptCount || 0) : 0,
    errorCode: currentPublicationError?.code || null,
    publishedAt,
    publicationTargetResolution: targetResolution,
    publicationPrerequisites: {
      targetResolved: Boolean(publicationTarget),
      scoringPersisted: lineup?.scoring_status === "scored",
      scoreResultCount,
      rankingReflected: ranking.reflected,
      publicationStatus,
      publishedAtPresent: Boolean(publishedAt),
      internalGameIdMatches: Boolean(lineup && String(lineup.internal_game_id || "") === String(internalGameId || "")),
      identifierConflict
    },
    publicationRecoveryEligible: publicationRecovery.eligible,
    publicationRecoveryBlockedReason: publicationRecoveryApplied || publicationRecovery.eligible ? null : publicationRecovery.reasonCode,
    publicationJobRecoveryMode: publicationJob?.recoveryMode || null,
    publicationRecoveryDetected,
    publicationRecoveryApplied,
    publicationRecoveredJobId,
    publicationRecoveredAt,
    publicationRecoveryMode: publicationJob?.recoveryMode || recoveryLogMetadata?.recoveryMode || null,
    workflowTerminalOverrideApplied,
    previousPublicationError,
    recoveryAttemptCountPreserved,
    recoveryExecutionBlockedReason: publicationRecoveryDetected && !publicationRecoveryApplied
      ? (workflowStatus === "manual_intervention_required" ? "WORKFLOW_TERMINAL" : publicationRecovery.reasonCode)
      : null,
    publicationRecoveryCronVisited,
    publicationRecoveryCronVisitedAt: recoveryVisitMetadata.publicationRecoveryCronVisitedAt || recoveryVisitLog?.occurred_at || null,
    publicationRecoveryCandidateSelected: recoveryVisitMetadata.publicationRecoveryCandidateSelected === true,
    publicationRecoveryCandidateJobId: Number.isInteger(Number(recoveryVisitMetadata.publicationRecoveryCandidateJobId))
      ? Number(recoveryVisitMetadata.publicationRecoveryCandidateJobId)
      : null,
    publicationRecoveryStage: recoveryVisitMetadata.publicationRecoveryStage
      || (publicationRecoveryDetected && !publicationRecoveryCronVisited ? "not_visited" : null),
    publicationRecoverySkippedReason: recoveryVisitMetadata.publicationRecoverySkippedReason
      || (publicationRecoveryDetected && !publicationRecoveryCronVisited ? "CRON_RECOVERY_FUNCTION_NOT_CALLED" : null),
    publicationRecoveryUpdateRowCount: Number(recoveryVisitMetadata.publicationRecoveryUpdateRowCount || 0),
    publicationErrorStage: publicationTargetError ? "publication_target_resolution" : (currentPublicationError ? "publication_executor" : null),
    publicationPersisted: Boolean(publishedAt || publicationStatus === "published"),
    publicationJobStatus: publicationJob?.status || "not_started",
    currentPublicationError,
    stalePregameErrorIgnored,
    rankingReflected: ranking.reflected,
    staleLeaseDetected,
    reconciliationEligible: reconciliation.eligible,
    reconciliationReasonCode: reconciliation.reasonCode,
    lastSuccessfulTransition: successfulJobs[0]
      ? { jobType: successfulJobs[0].jobType, completedAt: successfulJobs[0].completedAt }
      : null,
    currentBlocker: currentPublicationError?.code || null,
    currentWarning: jobSummary.warnings?.[0] || null
  };
}

function getManagedWorkflowStep(workflowStatus, lastCompletedJobType = "") {
  const byStatus = {
    waiting: "notice",
    prediction_open: "close_predictions",
    prediction_closed: "close_predictions",
    lineup_pending: "lineup",
    provisional_lineup_captured: "final_lineup",
    final_lineup_captured: "score",
    scoring_pending: "score",
    scored_private: "publish",
    published: "completed",
    retrying: lastCompletedJobType === "scoring" ? "score" : lastCompletedJobType === "publication" ? "publish" : "lineup",
    service_unavailable: "lineup",
    manual_intervention_required: "lineup"
  };
  return byStatus[String(workflowStatus || "")] || (lastCompletedJobType === "publication" ? "publish" : "notice");
}

function buildManagedWorkflowSchedule(selection, fallback = null) {
  const startAt = parseManagedGameStart(selection?.startAt, selection?.gameDate);
  if (!startAt) return fallback;
  try {
    const timeline = buildPregameTimeline({
      gameId: selection.legacyGameId,
      date: selection.gameDate,
      startAt,
      homeTeam: selection.homeTeam,
      awayTeam: selection.awayTeam,
      gameCode: selection.gameCode,
      status: selection.gameStatus
    });
    return timeline ? {
      startAt: timeline.startAt.toISOString(),
      rosterCaptureAt: timeline.rosterCaptureAt.toISOString(),
      predictionDeadlineAt: timeline.predictionDeadlineAt.toISOString(),
      lineupFetchStartAt: timeline.lineupFetchStartAt.toISOString(),
      finalLineupFetchAt: timeline.finalLineupFetchAt.toISOString(),
      resultReleaseAt: timeline.resultReleaseAt.toISOString()
    } : fallback;
  } catch {
    return fallback;
  }
}

function buildCurrentWorkflowObservation(selection, legacyStatus, jobSummary, publicationWorkflow, now = new Date()) {
  const workflow = selection?.workflowStatus || legacyStatus?.workflow?.workflowStatus || "waiting";
  const currentGame = {
    ...(legacyStatus?.game || {}),
    gameId: selection.legacyGameId,
    internalGameId: selection.internalGameId,
    date: selection.gameDate,
    startTime: selection.startAt,
    homeTeam: selection.homeTeam,
    awayTeam: selection.awayTeam,
    matchupLabel: formatGameProgressLabel({ date: selection.gameDate, homeTeam: selection.homeTeam, awayTeam: selection.awayTeam })
  };
  const latestJobsByType = new Map();
  for (const job of [...(jobSummary?.jobs || [])]
    .filter((item) => item && item.status !== "cancelled")
    .sort((left, right) => String(right.updatedAt || right.completedAt || right.scheduledAt || "").localeCompare(String(left.updatedAt || left.completedAt || left.scheduledAt || "")))) {
    if (job.jobType && !latestJobsByType.has(job.jobType)) latestJobsByType.set(job.jobType, job);
  }
  const activeJob = [...latestJobsByType.values()]
    .filter((job) => ["pending", "claimed", "running", "retry_wait", "permanently_failed"].includes(job.status))
    .sort((left, right) => String(right.updatedAt || right.scheduledAt || "").localeCompare(String(left.updatedAt || left.scheduledAt || "")))[0];
  const currentErrorJob = [...latestJobsByType.values()]
    .filter((job) => ["claimed", "running", "retry_wait", "permanently_failed"].includes(job.status) && job.errorCode)
    .sort((left, right) => String(right.updatedAt || right.scheduledAt || "").localeCompare(String(left.updatedAt || left.scheduledAt || "")))[0];
  const finalLineupJob = (jobSummary?.jobs || []).find((job) => job.jobType === "final_lineup_fetch" && job.status !== "cancelled") || null;
  const provisionalLineupJob = (jobSummary?.jobs || []).find((job) => job.jobType === "provisional_lineup_fetch" && job.status !== "cancelled") || null;
  const scoringJob = (jobSummary?.jobs || []).find((job) => job.jobType === "scoring" && job.status !== "cancelled") || null;
  return {
    game: currentGame,
    schedule: buildManagedWorkflowSchedule(selection, legacyStatus?.schedule || null),
    workflow: {
      ...(legacyStatus?.workflow || {}),
      status: workflow,
      currentStep: getManagedWorkflowStep(workflow, selection.lastCompletedJobType),
      lastRunAt: selection.updatedAt || legacyStatus?.workflow?.lastRunAt || null,
      lastResult: activeJob?.status || legacyStatus?.workflow?.lastResult || workflow,
      errorCode: currentErrorJob?.errorCode || selection.lastErrorCode || "",
      errorMessage: currentErrorJob?.errorDetail || ""
    },
    lineup: {
      ...(legacyStatus?.lineup || {}),
      status: finalLineupJob?.status === "succeeded" ? "captured" : (finalLineupJob?.status || legacyStatus?.lineup?.status || "pending"),
      attempts: finalLineupJob?.attemptCount ?? legacyStatus?.lineup?.attempts ?? 0,
      lastAttemptAt: finalLineupJob?.updatedAt || legacyStatus?.lineup?.lastAttemptAt || null,
      finalAttemptAt: finalLineupJob?.completedAt || legacyStatus?.lineup?.finalAttemptAt || null,
      nextAttemptAt: finalLineupJob?.nextAttemptAt || legacyStatus?.lineup?.nextAttemptAt || null,
      provisional: Boolean(provisionalLineupJob && provisionalLineupJob.status === "succeeded") || legacyStatus?.lineup?.provisional === true
    },
    scoring: {
      ...(legacyStatus?.scoring || {}),
      status: scoringJob?.status === "succeeded" ? "scored" : (scoringJob?.status || legacyStatus?.scoring?.status || "pending"),
      scoredAt: scoringJob?.completedAt || legacyStatus?.scoring?.scoredAt || null,
      publicationStatus: publicationWorkflow?.status || legacyStatus?.scoring?.publicationStatus || "pending",
      publishedAt: publicationWorkflow?.publishedAt || legacyStatus?.scoring?.publishedAt || null
    },
    publishing: {
      ...(legacyStatus?.publishing || {}),
      status: publicationWorkflow?.status || legacyStatus?.publishing?.status || "pending",
      publishedAt: publicationWorkflow?.publishedAt || legacyStatus?.publishing?.publishedAt || null,
      errorCode: publicationWorkflow?.errorCode || legacyStatus?.publishing?.errorCode || "",
      errorMessage: publicationWorkflow?.currentPublicationError?.detail || legacyStatus?.publishing?.errorMessage || ""
    },
    workflowAuditSource: "game_workflow_state+game_job_runs",
    workflowAuditInternalGameId: selection.internalGameId,
    workflowAuditObservedAt: now.toISOString()
  };
}

async function handleAdminCurrentGameWorkflow(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  try {
    const now = new Date();
    const { selection, candidates } = await getCurrentManagedGame(env.AUTH_DB, now);
    const historicalFailures = candidates
      .map((candidate) => normalizeManagedGameCandidate(candidate, now))
      .filter((candidate) => candidate.isHistorical && candidate.isFailed)
      .sort((left, right) => String(right.startAt || "").localeCompare(String(left.startAt || "")))
      .slice(0, 10)
      .map((candidate) => ({
        internalGameId: candidate.internalGameId,
        gameId: candidate.legacyGameId,
        gameDate: candidate.gameDate,
        startAt: candidate.startAt || null,
        homeTeam: candidate.homeTeam,
        awayTeam: candidate.awayTeam,
        workflowStatus: candidate.workflowStatus,
        gameStatus: candidate.gameStatus,
        classification: classifyManagedGame(candidate),
        lastErrorCode: candidate.lastErrorCode || null,
        lastErrorAt: candidate.lastErrorAt || null
      }));
    if (!selection || !selection.legacyGameId) {
      return jsonResponse({ ok: true, currentGame: null, selectionReason: "NO_MANAGED_GAME", historicalFailures, pendingJobs: [], retryJobs: [], warnings: [], errors: [] }, 200, cors);
    }
    const status = await getPregameAutomationStatus(env.AUTH_DB, selection.legacyGameId);
    let jobSummary = { pendingCount: 0, retryCount: 0, nextExecutionAt: null, jobs: [], lineupJobs: [], lineupFetchStatus: { provisional: null, final: null }, lineupFetchState: "not_started", lastFetchAttempt: null, validation: null, scoringEligibility: { eligible: false, status: "waiting", reasonCode: "FINAL_LINEUP_REQUIRED" }, warnings: [], errors: [] };
    try {
      jobSummary = await getManagedGameJobSummary(env.AUTH_DB, selection.internalGameId);
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
    }
    const publicationWorkflow = await getAdminPublicationWorkflowAudit(env.AUTH_DB, {
      internalGameId: selection.internalGameId,
      legacyGameId: selection.legacyGameId,
      workflowStatus: selection.workflowStatus,
      jobSummary,
      scoreResultCount: status?.scoreResultCount ?? null,
      now
    });
    const warnings = [...new Set([
      ...(selection.isFuture && selection.workflowStatus === "retrying" ? ["future_workflow_retry_wait"] : []),
      ...(jobSummary.warnings || [])
    ])];
    const errors = [...new Set(jobSummary.errors || [])];
    const workflowObservation = buildCurrentWorkflowObservation(selection, status, jobSummary, publicationWorkflow, now);
    const response = jsonResponse({
      ok: true,
      ...status,
      ...workflowObservation,
      currentGame: selection,
      selectionReason: selection.selectionReason,
      historicalFailures,
      pendingJobs: jobSummary.jobs.filter((job) => ["pending", "claimed", "running"].includes(job.status)),
      retryJobs: jobSummary.jobs.filter((job) => job.status === "retry_wait"),
      jobSummary,
      lineupJobs: jobSummary.lineupJobs,
      lineupFetchStatus: jobSummary.lineupFetchStatus,
      lineupFetchState: jobSummary.lineupFetchState,
      lastFetchAttempt: jobSummary.lastFetchAttempt,
      validation: jobSummary.validation,
      scoringEligibility: jobSummary.scoringEligibility,
      publicationWorkflow,
      currentBlocker: publicationWorkflow.currentBlocker,
      currentWarning: publicationWorkflow.currentWarning,
      warnings,
      errors
    }, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("現在の試合進行状態の読み取りに失敗しました", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ ok: false, code: isPregameSchemaError(error) ? "CURRENT_GAME_WORKFLOW_SCHEMA_NOT_READY" : "CURRENT_GAME_WORKFLOW_READ_FAILED", error: "現在の試合進行状態を取得できませんでした。" }, isPregameSchemaError(error) ? 503 : 500, cors);
  }
}

async function handleAdminGameWorkflowPause(env, cors, gameId, paused) {
  const now = new Date().toISOString();
  try {
    await env.AUTH_DB.prepare(
      `INSERT INTO game_workflow_controls (game_id, automation_paused, paused_at, resumed_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(game_id) DO UPDATE SET
         automation_paused = excluded.automation_paused,
         paused_at = CASE WHEN excluded.automation_paused = 1 THEN excluded.paused_at ELSE game_workflow_controls.paused_at END,
         resumed_at = CASE WHEN excluded.automation_paused = 0 THEN excluded.resumed_at ELSE game_workflow_controls.resumed_at END,
         updated_at = excluded.updated_at`
    ).bind(gameId, paused ? 1 : 0, paused ? now : null, paused ? null : now, now).run();
    console.log(`[GAME_WORKFLOW] gameId=${gameId} step=all action=${paused ? "paused" : "resumed"} status=success`);
    return jsonResponse({ ok: true, gameId, paused, observedAt: now }, 200, cors);
  } catch (error) {
    console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=all action=${paused ? "paused" : "resumed"} status=failed code=${error?.code || "GAME_WORKFLOW_CONTROL_FAILED"}`);
    return jsonResponse({
      ok: false,
      gameId,
      code: isPregameSchemaError(error) ? "GAME_WORKFLOW_CONTROL_SCHEMA_NOT_READY" : "GAME_WORKFLOW_CONTROL_FAILED",
      error: "自動運転の停止状態を更新できませんでした。"
    }, isPregameSchemaError(error) ? 503 : 500, cors);
  }
}

async function handleAdminServiceUnavailable(env, cors, gameId, unavailable) {
  const now = new Date();
  try {
    const current = await getRankingGameState(env.AUTH_DB, gameId);
    if (Number(current?.is_test_game || 0) === 1) {
      return jsonResponse({ ok: false, code: "TEST_GAME_NOT_ALLOWED", error: "テスト試合は通常試合の集計対象外状態に変更できません。" }, 409, cors);
    }
    if (unavailable) {
      if (current?.game_status === "scored") {
        return jsonResponse({ ok: false, code: "SCORED_GAME_NOT_ALLOWED", error: "採点済み試合は先に既存の再採点手順を確認してください。" }, 409, cors);
      }
      const changed = await markGameServiceUnavailable(env.AUTH_DB, gameId, now, "ADMIN_SERVICE_UNAVAILABLE");
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "service_unavailable_marked",
        status: "warning",
        gameId,
        occurredAt: now,
        message: SERVICE_UNAVAILABLE_MESSAGE,
        errorCode: "ADMIN_SERVICE_UNAVAILABLE",
        metadata: { source: "admin", changed },
        source: "admin"
      });
      return jsonResponse({ ok: true, gameId, status: SERVICE_UNAVAILABLE_GAME_STATUS, changed }, 200, cors);
    }

    const result = await env.AUTH_DB.prepare(
      `UPDATE ranking_games
          SET is_ranking_eligible = 0, ranking_eligible_at = NULL,
              game_status = 'pending', publication_status = 'pending',
              scored_private_at = NULL, published_at = NULL, updated_at = ?1
        WHERE game_id = ?2 AND game_status = ?3 AND is_test_game = 0`
    ).bind(now.toISOString(), gameId, SERVICE_UNAVAILABLE_GAME_STATUS).run();
    await env.AUTH_DB.prepare(
      `UPDATE game_pregame_automation
          SET last_error_code = CASE WHEN last_error_code = ?1 THEN NULL ELSE last_error_code END,
              last_error_message = CASE WHEN last_error_code = ?1 THEN NULL ELSE last_error_message END,
              next_lineup_attempt_at = ?2, updated_at = ?2
        WHERE game_id = ?3`
    ).bind(SCORING_RETRY_EXPIRED_CODE, now.toISOString(), gameId).run();
    const changed = Number(result?.meta?.changes || 0) === 1;
    if (changed) {
      await setRankingEligibility(env.AUTH_DB, {
        gameId,
        internalGameId: current?.internal_game_id || "",
        status: RANKING_ELIGIBILITY_STATUS.ELIGIBLE,
        reason: null,
        updatedBy: "admin",
        now
      });
    }
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "service_unavailable_restored",
      status: "info",
      gameId,
      occurredAt: now,
      message: "集計対象外状態を解除しました。再取得・再採点を実行できます。",
      metadata: { source: "admin", changed },
      source: "admin"
    });
    return jsonResponse({ ok: true, gameId, status: "pending", changed }, 200, cors);
  } catch (error) {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: unavailable ? "service_unavailable_marked" : "service_unavailable_restored",
      status: "error",
      gameId,
      occurredAt: now,
      message: unavailable ? "集計対象外状態への変更に失敗しました。" : "集計対象外状態の解除に失敗しました。",
      errorCode: String(error?.code || "SERVICE_UNAVAILABLE_STATE_FAILED"),
      source: "admin"
    });
    return jsonResponse({ ok: false, code: "SERVICE_UNAVAILABLE_STATE_FAILED", error: "試合状態を更新できませんでした。" }, 500, cors);
  }
}

function createPregameToolErrorResponse(cors, gameId, action, error) {
  const normalized = normalizePregameToolError(action, error);
  const metadata = PREGAME_TOOL_ACTIONS[action] || { logAction: action };
  const upstreamStatus = Number(error?.upstreamStatus || error?.httpStatus || 0) || 0;
  const upstreamPath = error?.upstreamPath === "/" ? "/" : "-";
  const upstreamMode = String(error?.upstreamMode || metadata.upstreamMode || "-");
  const transport = String(error?.upstreamTransport || metadata.transport || "-");
  console.log(`[PREGAME_TOOL] transport=${transport} action=${metadata.logAction} gameId=${gameId} upstreamPath=${upstreamPath} mode=${upstreamMode} upstreamStatus=${upstreamStatus || "-"} status=failed code=${normalized.code}`);
  const body = {
    ok: false,
    gameId,
    error: normalized.message,
    code: normalized.code,
    httpStatus: normalized.status
  };
  if (upstreamStatus > 0) body.upstreamStatus = upstreamStatus;
  return jsonResponse(body, normalized.status, cors);
}

export function normalizePregameToolError(action, error) {
  const metadata = PREGAME_TOOL_ACTIONS[action] || {};
  const rawCode = String(error?.code || "").trim();
  let code = rawCode;

  if (isPregameSchemaError(error)) {
    code = metadata.schemaCode || "PREGAME_SCHEMA_NOT_READY";
  } else if (Number(error?.upstreamStatus) === 404) {
    code = "NPB_WORKER_ROUTE_NOT_FOUND";
  } else if (rawCode === "SCHEDULE_UNAVAILABLE") {
    code = "GAME_NOT_FOUND";
  } else if (rawCode === "INVALID_ROSTER") {
    code = "ROSTER_PARSE_FAILED";
  } else if (rawCode === "INVALID_LINEUP") {
    code = "LINEUP_INVALID";
  } else if (rawCode === "NPB_RESPONSE_INVALID") {
    code = Number(error?.upstreamStatus) === 422
      ? (metadata.parseCode || metadata.fetchCode || "NPB_WORKER_HTTP_ERROR")
      : (metadata.fetchCode || metadata.failureCode || "NPB_WORKER_HTTP_ERROR");
  } else if (rawCode === "NOTICE_DATE_MISMATCH") {
    code = "NOTICE_PARSE_FAILED";
  } else if (rawCode === "NPB_SERVICE_BINDING_MISSING" || rawCode === "NPB_SERVICE_BINDING_INVALID" || rawCode === "NPB_WORKER_ROUTE_NOT_FOUND") {
    code = rawCode;
  } else if (rawCode === "NPB_HTTP_ERROR" || rawCode === "NPB_WORKER_TIMEOUT" || rawCode === "TIMEOUT") {
    code = metadata.fetchCode || metadata.failureCode || "NPB_WORKER_HTTP_ERROR";
  } else if (!code || !PREGAME_TOOL_ERROR_MESSAGES[code]) {
    code = metadata.failureCode || "PREGAME_TOOL_FAILED";
  }

  let status = Number(error?.httpStatus || 0) || 500;
  if (code === "LINEUP_NOT_PUBLISHED" || code === "SCORING_LINEUP_REQUIRED" || code === "SCORING_IN_PROGRESS" || code === "NOTICE_NOT_FOUND") status = 409;
  else if (code === "GAME_NOT_FOUND") status = 404;
  else if (code.endsWith("_SCHEMA_NOT_READY") || code === "NPB_SERVICE_BINDING_MISSING" || code === "NPB_SERVICE_BINDING_INVALID") status = 503;
  else if (code.endsWith("_PARSE_FAILED") || code === "LINEUP_INVALID" || code === "NOTICE_RESPONSE_INVALID") status = 422;
  else if (code.endsWith("_FETCH_FAILED") || ["NPB_WORKER_HTTP_ERROR", "NPB_WORKER_ROUTE_NOT_FOUND"].includes(code)) status = 502;
  else if (status < 400 || status > 599) status = 500;

  return { code, status, message: PREGAME_TOOL_ERROR_MESSAGES[code] || "試合前処理を実行できませんでした。" };
}

function isPregameSchemaError(error) {
  const message = String(error?.message || "").toLowerCase();
  return /no such table|no such column|has no column named|does not exist|schema.*not ready|migration/.test(message);
}

async function isWorkflowJobSchemaReady(db) {
  try {
    await db.prepare("SELECT 1 FROM game_job_runs LIMIT 1").first();
    return true;
  } catch (error) {
    if (isPregameSchemaError(error)) return false;
    throw error;
  }
}

async function handleGetGameDayStatus(request, env, cors) {
  const gameId = getValidGameId(new URL(request.url).searchParams.get("gameId"));
  const identity = gameId ? getGameIdentityForPregame(gameId) : null;
  if (!identity) return jsonResponse({ ok: false, error: "対象試合を指定してください。" }, 400, cors);
  const status = await getGameDayStatus(env.AUTH_DB, identity);
  return jsonResponse({ ok: true, gameId, ...status }, 200, cors);
}

async function handleGetGameDayRoster(request, env, cors) {
  const internalGameId = String(new URL(request.url).searchParams.get("internalGameId") || "").trim();
  if (!INTERNAL_GAME_ID_PATTERN.test(internalGameId)) {
    return jsonResponse({ ok: false, code: "INVALID_INTERNAL_GAME_ID", error: "対象試合を指定してください。" }, 400, cors);
  }
  const game = await env.AUTH_DB.prepare(
    `SELECT internal_game_id, game_date
       FROM games
      WHERE internal_game_id = ?1
      LIMIT 1`
  ).bind(internalGameId).first();
  if (!game) {
    return jsonResponse({ ok: false, code: "INTERNAL_GAME_ID_NOT_FOUND", error: "対象試合を確認できません。" }, 404, cors);
  }
  const row = await env.AUTH_DB.prepare(
    `SELECT internal_game_id, game_date, captured_at, roster_json, player_count, source, status
       FROM game_roster_snapshots
      WHERE internal_game_id = ?1
      ORDER BY updated_at DESC, captured_at DESC
      LIMIT 1`
  ).bind(internalGameId).first();
  return jsonResponse(buildPublicGameDayRosterResponse({
    internalGameId,
    gameDate: game.game_date,
    snapshot: row
  }), 200, cors);
}

export function buildPublicGameDayRosterResponse({ internalGameId = "", gameDate = "", snapshot = null } = {}) {
  const freshness = getV3RosterSnapshotFreshness(snapshot, { internalGameId, gameDate });
  const players = freshness.isFresh
    ? parseJsonArray(snapshot?.roster_json).filter((player) => player && player.name && player.number && player.position)
    : [];
  return {
    ok: true,
    internalGameId,
    gameDate,
    status: players.length ? "captured" : "pending",
    capturedAt: players.length ? snapshot?.captured_at || null : null,
    playerCount: players.length,
    players
  };
}

function getGameTeamCodes(identity) {
  return Array.from(new Set([
    String(identity?.game?.homeTeam || "").trim().toLowerCase(),
    String(identity?.game?.awayTeam || "").trim().toLowerCase()
  ].filter(Boolean)));
}

async function ensureGameDayNoticeRows(db, timelines, date, now) {
  const rows = (Array.isArray(timelines) ? timelines : [])
    .filter((timeline) => timeline?.game?.date === date)
    .map((timeline) => db.prepare(
      `INSERT INTO game_day_notice_games
         (game_id, notice_date, home_team, away_team, notice_status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'waiting', ?5, ?5)
       ON CONFLICT(game_id) DO UPDATE SET
         notice_date = excluded.notice_date,
         home_team = excluded.home_team,
         away_team = excluded.away_team,
         updated_at = excluded.updated_at`
    ).bind(
      timeline.gameId,
      date,
      String(timeline.game.homeTeam || "").trim().toLowerCase(),
      String(timeline.game.awayTeam || "").trim().toLowerCase(),
      now.toISOString()
    ));
  if (rows.length) await db.batch(rows);
}

async function claimGameDayNoticeSlot(db, date, slotKey, now) {
  await db.prepare(
    `INSERT INTO game_day_notices (notice_date, source_url, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT(notice_date) DO NOTHING`
  ).bind(date, GAME_DAY_NOTICE_SOURCE, now.toISOString()).run();
  const result = await db.prepare(
    `UPDATE game_day_notices
        SET last_slot_key = ?1, updated_at = ?2
      WHERE notice_date = ?3
        AND (last_slot_key IS NULL OR last_slot_key <> ?1)`
  ).bind(slotKey, now.toISOString(), date).run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function runGameDayNoticeOnce(env, now, requestedGameId = "", timelines = getPregameTimelines()) {
  const date = getJstDateString(now);
  await ensureGameDayNoticeRows(env.AUTH_DB, timelines, date, now);
  const payload = normalizeGameDayNoticePayload(await fetchNpbWorkerJson(env, { mode: "notice", date }), date);
  console.log(`game-day notice fetched: noticeDate=${payload.noticeDate} pageDate=${payload.pageDate || "-"} http=${payload.upstreamStatus} registrationCount=${payload.registrationCount} removalCount=${payload.removalCount} isEmpty=${payload.isEmpty} hash=${String(payload.contentHash || "").slice(0, 12)}`);
  let stored;
  try {
    stored = await storeGameDayNotice(env.AUTH_DB, payload, now);
  } catch (error) {
    if (isPregameSchemaError(error)) throw error;
    throw createPregameError("NOTICE_FETCH_FAILED", "取得した公示結果の保存に失敗しました。");
  }
  let applied;
  try {
    applied = await applyGameDayNoticeToGames(env, date, payload, now, new Set(timelines.map((timeline) => timeline.gameId)));
  } catch (error) {
    if (isPregameSchemaError(error)) throw error;
    throw createPregameError("NOTICE_DISTRIBUTION_FAILED", "取得した公示結果の配布に失敗しました。");
  }
  return {
    status: stored.status,
    date,
    noticeDate: payload.noticeDate,
    pageDate: payload.pageDate || null,
    slotKey: payload.contentHash || "",
    upstreamStatus: payload.upstreamStatus,
    registeredCount: payload.registrationCount,
    removedCount: payload.removalCount,
    registrationCount: payload.registrationCount,
    removalCount: payload.removalCount,
    isEmpty: payload.isEmpty,
    message: payload.isEmpty ? "指定日の公示はありません。" : "公示取得が完了しました。",
    appliedGameIds: applied,
    requestedGameId: requestedGameId || null
  };
}

function isValidPregameDate(value) {
  const normalized = String(value || "").trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(normalized)) return false;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(`${normalized}T`);
}

export function normalizeGameDayNoticePayload(payload, expectedNoticeDate = "") {
  const noticeDate = String(payload?.noticeDate || "").trim();
  if (!isValidPregameDate(noticeDate)) {
    throw createPregameError("NOTICE_RESPONSE_INVALID", "NPB公示レスポンスの日付が不正です。", { httpStatus: 422 });
  }
  if (expectedNoticeDate && noticeDate !== expectedNoticeDate) {
    throw createPregameError("NOTICE_DATE_MISMATCH", "NPB公示の日付を確認できませんでした。", { httpStatus: 422 });
  }
  if (!Array.isArray(payload?.registrations) || !Array.isArray(payload?.removals)) {
    throw createPregameError("NOTICE_RESPONSE_INVALID", "NPB公示レスポンスの登録・抹消一覧が不正です。", { httpStatus: 422 });
  }

  const registrations = payload.registrations;
  const removals = payload.removals;
  const pageDate = isValidPregameDate(payload?.pageDate) ? String(payload.pageDate).trim() : "";
  return {
    ...payload,
    noticeDate,
    pageDate,
    registrations,
    removals,
    registrationCount: registrations.length,
    removalCount: removals.length,
    registeredCount: registrations.length,
    removedCount: removals.length,
    isEmpty: registrations.length === 0 && removals.length === 0,
    upstreamStatus: Number(payload?.httpStatus) || 200
  };
}

async function distributeStoredGameDayNotice(env, gameId, now) {
  const identity = getGameIdentityForPregame(gameId);
  if (!identity?.game?.date) {
    throw createPregameError("GAME_NOT_FOUND", "対象試合が見つかりません。");
  }
  const row = await env.AUTH_DB.prepare(
    `SELECT content_hash, fetched_at, registered_json, removed_json, rosters_json,
            registered_count, removed_count
       FROM game_day_notices
      WHERE notice_date = ?1
      LIMIT 1`
  ).bind(identity.game.date).first();
  if (!row) {
    throw createPregameError("NOTICE_NOT_FOUND", "保存済みの公示結果がありません。");
  }
  const payload = {
    noticeDate: identity.game.date,
    contentHash: row.content_hash || "",
    fetchedAt: row.fetched_at || now.toISOString(),
    registrations: parseJsonArray(row.registered_json),
    removals: parseJsonArray(row.removed_json),
    rosters: parseJsonObject(row.rosters_json)
  };
  const appliedGameIds = await applyGameDayNoticeToGames(env, identity.game.date, payload, now);
  return {
    status: "distributed",
    date: identity.game.date,
    registeredCount: Number(row.registered_count || payload.registrations.length || 0),
    removedCount: Number(row.removed_count || payload.removals.length || 0),
    appliedGameIds,
    requestedGameId: gameId
  };
}

async function recordGameDayNoticeError(db, date, error, now) {
  await db.prepare(
    `INSERT INTO game_day_notices (notice_date, source_url, status, last_error_code, created_at, updated_at)
     VALUES (?1, ?2, 'error', ?3, ?4, ?4)
     ON CONFLICT(notice_date) DO UPDATE SET
       status = 'error', last_error_code = ?3, updated_at = ?4`
  ).bind(date, GAME_DAY_NOTICE_SOURCE, String(error?.code || "NOTICE_FETCH_FAILED").slice(0, 80), now.toISOString()).run();
}

export function resolveNoticeRostersForStorage(incomingRosters, existingRostersJson = "{}") {
  const rosters = incomingRosters && typeof incomingRosters === "object" && !Array.isArray(incomingRosters)
    ? incomingRosters
    : {};
  const hasPlayers = Object.values(rosters).some((players) => Array.isArray(players) && players.length > 0);
  return hasPlayers ? rosters : parseJsonObject(existingRostersJson);
}

export async function storeGameDayNotice(db, payload, now) {
  const date = String(payload.noticeDate || "");
  const existing = await db.prepare("SELECT content_hash, rosters_json FROM game_day_notices WHERE notice_date = ?1 LIMIT 1").bind(date).first();
  if (existing?.content_hash && existing.content_hash === payload.contentHash) {
    return { status: "unchanged" };
  }
  const rosters = resolveNoticeRostersForStorage(payload.rosters, existing?.rosters_json);
  await db.prepare(
    `INSERT INTO game_day_notices
       (notice_date, source_url, content_hash, fetched_at, registered_json, removed_json, rosters_json,
        registered_count, removed_count, status, last_error_code, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'success', NULL, ?4, ?4)
     ON CONFLICT(notice_date) DO UPDATE SET
       source_url = excluded.source_url,
       content_hash = excluded.content_hash,
       fetched_at = excluded.fetched_at,
       registered_json = excluded.registered_json,
       removed_json = excluded.removed_json,
       rosters_json = excluded.rosters_json,
       registered_count = excluded.registered_count,
       removed_count = excluded.removed_count,
       status = 'success',
       last_error_code = NULL,
       updated_at = excluded.updated_at`
  ).bind(
    date,
    String(payload.sourceUrl || GAME_DAY_NOTICE_SOURCE),
    String(payload.contentHash || ""),
    String(payload.fetchedAt || now.toISOString()),
    JSON.stringify(Array.isArray(payload.registrations) ? payload.registrations : []),
    JSON.stringify(Array.isArray(payload.removals) ? payload.removals : []),
    JSON.stringify(rosters),
    Number(payload.registrationCount ?? payload.registeredCount ?? 0),
    Number(payload.removalCount ?? payload.removedCount ?? 0)
  ).run();
  return { status: existing ? "updated" : "captured" };
}

async function applyGameDayNoticeToGames(env, date, payload, now, allowedGameIds = null) {
  const rows = await env.AUTH_DB.prepare(
    "SELECT * FROM game_day_notice_games WHERE notice_date = ?1"
  ).bind(date).all();
  const registrations = Array.isArray(payload.registrations) ? payload.registrations : [];
  const removals = Array.isArray(payload.removals) ? payload.removals : [];
  const applied = [];
  for (const row of rows.results || []) {
    if (allowedGameIds instanceof Set && !allowedGameIds.has(row.game_id)) continue;
    try {
      const teams = new Set([String(row.home_team || "").toLowerCase(), String(row.away_team || "").toLowerCase()]);
      const matchingRegistrations = registrations.filter((item) => teams.has(String(item?.teamCode || "").toLowerCase()));
      const matchingRemovals = removals.filter((item) => teams.has(String(item?.teamCode || "").toLowerCase()));
      const detected = matchingRegistrations.length > 0 || matchingRemovals.length > 0;
      const identity = getGameIdentityForPregame(row.game_id);
      const nowIso = now.toISOString();
      if (detected) {
        const afterDeadline = identity && now >= identity.predictionDeadlineAt;
        await env.AUTH_DB.prepare(
          `UPDATE game_day_notice_games
              SET notice_status = 'detected', registered_count = ?1, removed_count = ?2,
                  last_checked_at = ?3, detected_at = COALESCE(detected_at, ?3),
                  after_deadline_notice = ?4, last_error_code = ?5, updated_at = ?3
            WHERE game_id = ?6`
        ).bind(matchingRegistrations.length, matchingRemovals.length, nowIso, afterDeadline ? 1 : 0, afterDeadline ? "NOTICE_AFTER_DEADLINE" : null, row.game_id).run();
        if (!afterDeadline && identity) {
          await saveRosterSnapshotFromNotice(env.AUTH_DB, identity, payload, now);
        }
        applied.push(row.game_id);
      } else if (identity && now >= identity.predictionDeadlineAt && now < identity.startAt && row.notice_status === GAME_DAY_NOTICE_STATUS.WAITING) {
        await env.AUTH_DB.prepare(
          `UPDATE game_day_notice_games
              SET notice_status = 'closed_without_notice', last_checked_at = ?1, updated_at = ?1
            WHERE game_id = ?2`
        ).bind(nowIso, row.game_id).run();
        applied.push(row.game_id);
      }
    } catch (error) {
      await recordGameWorkflowOutcome(env.AUTH_DB, row.game_id, "notice", "failed", error, now);
      console.warn(`[GAME_WORKFLOW] gameId=${row.game_id} step=notice action=distribution status=failed code=${error?.code || "NOTICE_DISTRIBUTION_FAILED"}`);
    }
  }
  return applied;
}

async function saveRosterSnapshotFromNotice(db, identity, payload, capturedAt) {
  const rosters = payload?.rosters && typeof payload.rosters === "object" ? payload.rosters : {};
  const targetTeams = getGameTeamCodes(identity);
  const players = [];
  // Starting9の候補マスタは日本ハム向けなので、同一背番号の相手選手を混ぜない。
  // 将来の全球団対応では teamCode ごとのスナップショットへ拡張できる形を維持する。
  const snapshotTeams = Array.isArray(rosters.fighters) ? ["fighters"] : targetTeams;
  for (const teamCode of snapshotTeams) {
    const teamRoster = Array.isArray(rosters[teamCode]) ? rosters[teamCode] : [];
    for (const player of teamRoster) {
      const name = String(player?.name || "").replace(/[\s\u3000]/g, "");
      const number = typeof player?.number === "string" ? player.number.trim() : String(player?.number || "").trim();
      const position = String(player?.position || "").trim();
      if (name && number && position) players.push({ teamCode, position, number, name });
    }
  }
  if (!players.length || players.length > 100) return false;
  const rosterJson = JSON.stringify(players);
  const capturedAtIso = capturedAt instanceof Date ? capturedAt.toISOString() : String(capturedAt || new Date().toISOString());
  const storage = await requireInternalGameIdForWrite(db, {
    table: "game_roster_snapshots",
    gameId: identity.gameId,
    internalGameId: identity.internalGameId || identity.game?.internalGameId || ""
  });
  const internalColumn = storage.schemaReady ? ", internal_game_id" : "";
  const internalValue = storage.schemaReady ? ", ?6" : "";
  await db.batch([
    db.prepare(
      `INSERT INTO game_roster_snapshots
         (game_id, game_date, captured_at, roster_json, source, player_count, status, created_at, updated_at${internalColumn})
       VALUES (?1, ?2, ?3, ?4, 'npb-roster', ?5, 'captured', ?3, ?3${internalValue})
       ON CONFLICT(game_id) DO UPDATE SET
         ${storage.schemaReady ? "internal_game_id = CASE WHEN excluded.internal_game_id IS NULL OR excluded.internal_game_id = '' THEN game_roster_snapshots.internal_game_id ELSE excluded.internal_game_id END," : ""}
         captured_at = excluded.captured_at, roster_json = excluded.roster_json,
         player_count = excluded.player_count, updated_at = excluded.updated_at`
    ).bind(...(storage.schemaReady
      ? [identity.gameId, identity.game.date, capturedAtIso, rosterJson, players.length, storage.internalGameId]
      : [identity.gameId, identity.game.date, capturedAtIso, rosterJson, players.length])),
    db.prepare(
      `UPDATE game_pregame_automation
          SET roster_status = 'captured', roster_captured_at = ?1,
              last_error_code = NULL, last_error_message = NULL, updated_at = ?1
        WHERE game_id = ?2`
    ).bind(capturedAtIso, identity.gameId)
  ]);
  await linkLegacyGameRowsToInternalGameId(db, storage.internalGameId, identity.gameId);
  return true;
}

async function fixGameRosterAtDeadline(env, gameId, now) {
  const identity = getGameIdentityForPregame(gameId);
  if (!identity) throw createPregameError("SCHEDULE_UNAVAILABLE", "試合日程を確認できません。");
  if (now < identity.predictionDeadlineAt) return { status: "not_due", fixedAt: null };
  await ensurePregameAutomationRow(env.AUTH_DB, identity, now);
  const row = await env.AUTH_DB.prepare("SELECT * FROM game_day_notice_games WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
  const snapshot = await env.AUTH_DB.prepare("SELECT game_id FROM game_roster_snapshots WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
  const notice = await env.AUTH_DB.prepare("SELECT * FROM game_day_notices WHERE notice_date = ?1 LIMIT 1").bind(identity.game.date).first();
  let captured = Boolean(snapshot);
  if (!captured && row?.notice_status === GAME_DAY_NOTICE_STATUS.DETECTED && notice?.fetched_at && new Date(notice.fetched_at) <= identity.predictionDeadlineAt) {
    captured = await saveRosterSnapshotFromNotice(env.AUTH_DB, identity, {
      rosters: parseJsonObject(notice.rosters_json)
    }, new Date(notice.fetched_at));
  }
  const fixedAt = now.toISOString();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare(
      `UPDATE game_day_notice_games
          SET roster_fixed_at = COALESCE(roster_fixed_at, ?1), updated_at = ?1
        WHERE game_id = ?2`
    ).bind(fixedAt, gameId),
    env.AUTH_DB.prepare(
      `UPDATE game_pregame_automation
          SET roster_fixed_at = COALESCE(roster_fixed_at, ?1),
              roster_status = CASE WHEN ?3 THEN 'captured' ELSE roster_status END,
              updated_at = ?1
        WHERE game_id = ?2`
    ).bind(fixedAt, gameId, captured ? 1 : 0)
  ]);
  return { status: captured ? "fixed" : "fixed_without_snapshot", fixedAt };
}

async function fixDueGameRosters(env, timelines, now) {
  let fixed = 0;
  let failed = 0;
  for (const timeline of timelines) {
    if (now < timeline.predictionDeadlineAt || now > timeline.startAt) continue;
    try {
      const result = await fixGameRosterAtDeadline(env, timeline.gameId, now);
      if (result.status.startsWith("fixed")) fixed += 1;
    } catch (error) {
      failed += 1;
      await recordGameWorkflowOutcome(env.AUTH_DB, timeline.gameId, "close_predictions", "failed", error, now);
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "prediction_close_failed",
        status: "error",
        gameId: timeline.gameId,
        occurredAt: now,
        message: "予想受付終了処理に失敗しました。",
        errorCode: String(error?.code || "PREDICTION_CLOSE_FAILED"),
        metadata: { processName: "close_predictions", scheduledAt: timeline.predictionDeadlineAt.toISOString() },
        source: "cron"
      });
      console.warn(`[GAME_WORKFLOW] gameId=${timeline.gameId} step=close_predictions action=executed status=failed code=${error?.code || "ROSTER_FIX_FAILED"}`);
    }
  }
  return { fixed, failed };
}

function isNormalRosterTimeline(timeline) {
  const game = timeline?.game || {};
  const gameType = String(game.type || game.gameType || "").toLowerCase();
  const gameId = String(timeline?.gameId || game.gameId || "").toLowerCase();
  return game.isTestGame !== true
    && game.isAutoScoringTest !== true
    && game.testGame !== true
    && !["test", "auto_scoring_test", "auto-scoring-test"].includes(gameType)
    && !gameId.includes("auto-scoring-test");
}

export function normalizeAutoApproveEnabled(value, fallback = true) {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return fallback;
}

export async function getAutomationSettings(db) {
  try {
    const row = await db.prepare(
      "SELECT setting_value, updated_at FROM automation_settings WHERE setting_key = ?1 LIMIT 1"
    ).bind(AUTO_APPROVE_SETTING_KEY).first();
    return {
      autoApproveEnabled: normalizeAutoApproveEnabled(row?.setting_value, true),
      updatedAt: row?.updated_at || null,
      available: true
    };
  } catch (error) {
    if (isPregameSchemaError(error)) {
      // migration未適用の既存環境でも、自動処理は従来どおり停止させません。
      return { autoApproveEnabled: true, updatedAt: null, available: false };
    }
    throw error;
  }
}

async function handleAdminAutomationSettingsGet(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const settings = await getAutomationSettings(env.AUTH_DB);
  const response = jsonResponse({ ok: true, settings }, 200, cors);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function handleAdminAutomationSettingsPut(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const input = await readJson(request);
  if (typeof input?.autoApproveEnabled !== "boolean") {
    return jsonResponse({ ok: false, error: "自動承認設定が不正です。" }, 400, cors);
  }

  const now = new Date().toISOString();
  try {
    await env.AUTH_DB.prepare(
      `INSERT INTO automation_settings (setting_key, setting_value, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`
    ).bind(AUTO_APPROVE_SETTING_KEY, input.autoApproveEnabled ? "1" : "0", now).run();
  } catch (error) {
    if (isPregameSchemaError(error)) {
      return jsonResponse({ ok: false, code: "AUTOMATION_SETTINGS_SCHEMA_NOT_READY", error: "自動承認設定用データベースが準備されていません。" }, 503, cors);
    }
    throw error;
  }

  const response = jsonResponse({
    ok: true,
    settings: { autoApproveEnabled: input.autoApproveEnabled, updatedAt: now, available: true }
  }, 200, cors);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function getAutomationHealth() {
  return { available: false, cronLastRunAt: null, cronLastSuccessAt: null, cronLastErrorAt: null, cronLastError: "", processedGameCount: 0 };
}

async function getGameDayStatus(db, identity) {
  const [gameResult, noticeResult, lineupResult] = await db.batch([
    db.prepare("SELECT * FROM game_day_notice_games WHERE game_id = ?1 LIMIT 1").bind(identity.gameId),
    db.prepare("SELECT notice_date, source_url, fetched_at, registered_count, removed_count, status, last_error_code FROM game_day_notices WHERE notice_date = ?1 LIMIT 1").bind(identity.game.date),
    db.prepare("SELECT scoring_status, publication_status FROM game_lineups WHERE game_id = ?1 LIMIT 1").bind(identity.gameId)
  ]);
  const game = gameResult?.results?.[0] || null;
  const notice = noticeResult?.results?.[0] || null;
  const lineup = lineupResult?.results?.[0] || null;
  const now = new Date();
  const resultStatus = now < identity.startAt
    ? "prestart"
    : lineup?.publication_status === "published"
      ? "published"
      : "preparing";
  return {
    noticeStatus: game?.notice_status || GAME_DAY_NOTICE_STATUS.WAITING,
    noticeLabel: game?.notice_status === GAME_DAY_NOTICE_STATUS.DETECTED
      ? "本日の公示を反映済み"
      : game?.notice_status === GAME_DAY_NOTICE_STATUS.CLOSED
        ? "締切時点まで対象球団の公示は確認されませんでした"
        : "本日の対象球団の公示は確認できていません",
    noticeDate: identity.game.date,
    checkedAt: game?.last_checked_at || null,
    detectedAt: game?.detected_at || null,
    rosterFixedAt: game?.roster_fixed_at || null,
    afterDeadline: Number(game?.after_deadline_notice || 0) === 1,
    registeredCount: Number(game?.registered_count || 0),
    removedCount: Number(game?.removed_count || 0),
    sourceUrl: notice?.source_url || GAME_DAY_NOTICE_SOURCE,
    fetchedAt: notice?.fetched_at || null,
    sourceStatus: notice?.status || "waiting",
    hasError: Boolean(notice?.status === GAME_DAY_NOTICE_STATUS.ERROR),
    resultStatus
  };
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getGameIdentityForPregame(gameId, fallback = {}) {
  const timeline = getPregameTimeline(gameId) || buildPregameTimeline({
    gameId,
    date: fallback.date,
    startAt: fallback.startAt ? new Date(fallback.startAt) : null,
    homeTeam: fallback.homeTeam,
    awayTeam: fallback.awayTeam,
    gameCode: fallback.gameCode,
    status: fallback.status
  });
  if (!timeline) return null;
  const storedGameCode = normalizeNpbGameCode(timeline.game?.gameCode);
  const idGameCode = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(timeline.gameId)?.[1] || "";
  const gameCode = storedGameCode || normalizeNpbGameCode(fallback.gameCode) || normalizeNpbGameCode(idGameCode);
  if (!gameCode) return null;
  return { ...timeline, gameCode };
}

async function resolvePregameIdentity(db, gameId, fallback = {}) {
  try {
    const reference = await resolveApiGameReference(db, gameId);
    if (reference.ok && reference.metadata?.startAt) {
      const metadata = reference.metadata;
      const resolvedGameId = metadata.legacyGameId || metadata.gameId || gameId;
      const identity = getGameIdentityForPregame(resolvedGameId, {
        date: metadata.date || fallback.date,
        startAt: metadata.startAt || fallback.startAt,
        homeTeam: metadata.game?.home_team || metadata.game?.homeTeam || fallback.homeTeam,
        awayTeam: metadata.game?.away_team || metadata.game?.awayTeam || fallback.awayTeam,
        gameCode: metadata.gameCode || fallback.gameCode,
        status: metadata.game?.game_status || metadata.game?.status || fallback.status
      });
      if (identity) {
        return {
          ...identity,
          internalGameId: metadata.internalGameId || "",
          game: { ...identity.game, internalGameId: metadata.internalGameId || "" },
          resolvedBy: metadata.resolvedBy || "game_identity_registry"
        };
      }
    }
    // 呼び出し元が既にworkflow targetとして検証した内部IDと日程を持つ場合は、
    // registryの別名検索に失敗しても、そのtargetを共通resolverの補助入力として使う。
    // 任意のlegacy IDを許可するのではなく、内部ID・開始時刻・対戦カードが揃う場合だけに限定する。
    const fallbackInternalGameId = String(fallback?.internalGameId || "").trim();
    const fallbackStartAt = fallback?.startAt ? new Date(fallback.startAt) : null;
    const fallbackIdentity = fallbackInternalGameId && fallbackStartAt && !Number.isNaN(fallbackStartAt.getTime())
      ? getGameIdentityForPregame(gameId, fallback)
      : null;
    if (fallbackIdentity) {
      return {
        ...fallbackIdentity,
        internalGameId: fallbackInternalGameId,
        game: { ...fallbackIdentity.game, internalGameId: fallbackInternalGameId },
        resolvedBy: "workflow_target_fallback"
      };
    }
    const registry = await getGameIdentityRegistryAvailability(db);
    if (registry.available) return null;
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  return getGameIdentityForPregame(gameId, fallback);
}

export function isBeforeGameStart(startAt, now = new Date()) {
  const start = startAt instanceof Date ? startAt : new Date(startAt);
  const current = now instanceof Date ? now : new Date(now);
  return Number.isFinite(start.getTime())
    && Number.isFinite(current.getTime())
    && current.getTime() < start.getTime();
}

function assertOfficialLineupSaveAllowed(gameId, now = new Date()) {
  const identity = getGameIdentityForPregame(gameId);
  if (!identity) {
    throw createPregameError("SCHEDULE_UNAVAILABLE", "試合日程を確認できません。", { httpStatus: 409 });
  }
  if (!isBeforeGameStart(identity.startAt, now)) {
    throw createPregameError(
      "LINEUP_SAVE_CLOSED",
      "試合開始後の正式スタメン修正は、正式スタメン修正・再採点機能を使用してください。",
      { httpStatus: 409 }
    );
  }
  return identity;
}

function getNpbFetchServiceBinding(env) {
  if (!env?.NPB_FETCH_WORKER) {
    throw createPregameError("NPB_SERVICE_BINDING_MISSING", "NPB取得WorkerのService Bindingが設定されていません。");
  }
  if (typeof env.NPB_FETCH_WORKER.fetch !== "function") {
    throw createPregameError("NPB_SERVICE_BINDING_INVALID", "NPB取得WorkerのService Bindingが不正です。");
  }
  return env.NPB_FETCH_WORKER;
}

export function buildNpbServiceBindingRequest(params = {}) {
  const url = new URL("/", NPB_SERVICE_BINDING_INTERNAL_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return new Request(url.toString(), {
    method: "GET",
    headers: { "Cache-Control": "no-store" }
  });
}

export async function fetchNpbWorkerJson(env, params) {
  const upstreamMode = String(params?.mode || "");
  const upstreamDetails = {
    upstreamPath: "/",
    upstreamMode,
    upstreamTransport: "service-binding"
  };
  let binding;
  let request;
  try {
    binding = getNpbFetchServiceBinding(env);
    request = buildNpbServiceBindingRequest(params);
    upstreamDetails.fetchEndpoint = `${new URL(request.url).pathname}${new URL(request.url).search}`;
  } catch (error) {
    if (error?.code) {
      Object.assign(error, upstreamDetails);
      throw error;
    }
    throw createPregameError("NPB_SERVICE_BINDING_INVALID", "NPB取得WorkerのService Bindingが不正です。", upstreamDetails);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NPB_FETCH_TIMEOUT_MS);
  try {
    const response = await binding.fetch(request, { signal: controller.signal });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw createPregameError("NPB_RESPONSE_INVALID", "NPB取得Workerのレスポンス形式が不正です。", {
        httpStatus: response.status,
        upstreamStatus: response.status,
        contentType: response.headers.get("content-type") || "",
        ...upstreamDetails
      });
    }
    if (!response.ok || !payload?.ok) {
      const upstreamCode = payload?.code || (response.status === 422 ? "NPB_RESPONSE_INVALID" : "NPB_HTTP_ERROR");
      throw createPregameError(upstreamCode, payload?.error || "NPB取得Workerがエラーを返しました。", {
        httpStatus: response.status,
        upstreamStatus: response.status,
        externalStatus: payload?.httpStatus,
        contentType: response.headers.get("content-type") || "",
        upstreamUrl: payload?.sourceUrl,
        ...upstreamDetails
      });
    }
    Object.defineProperty(payload, "__fetchMeta", {
      value: {
        httpStatus: response.status,
        contentType: response.headers.get("content-type") || "",
        endpoint: request.url
      },
      enumerable: false
    });
    return payload;
  } catch (error) {
    if (error?.code) throw error;
    throw createPregameError(error?.name === "AbortError" ? "NPB_WORKER_TIMEOUT" : "NPB_HTTP_ERROR", "NPB公式データを取得できませんでした。", upstreamDetails);
  } finally {
    clearTimeout(timer);
  }
}

function createPregameError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  if (typeof details.retryable === "boolean") error.retryable = details.retryable;
  const targetResolution = sanitizeWorkflowTargetDiagnostics(details.targetResolution);
  if (targetResolution) error.targetResolution = targetResolution;
  if (Number(details.httpStatus) > 0) error.httpStatus = Number(details.httpStatus);
  if (Number(details.upstreamStatus) > 0) error.upstreamStatus = Number(details.upstreamStatus);
  if (Number(details.externalStatus) > 0) error.externalStatus = Number(details.externalStatus);
  if (typeof details.upstreamUrl === "string" && /^https:\/\/npb\.jp\//i.test(details.upstreamUrl)) error.upstreamUrl = details.upstreamUrl;
  if (details.upstreamPath === "/") error.upstreamPath = "/";
  if (typeof details.upstreamMode === "string" && details.upstreamMode) error.upstreamMode = details.upstreamMode;
  if (typeof details.upstreamTransport === "string" && details.upstreamTransport) error.upstreamTransport = details.upstreamTransport;
  if (typeof details.contentType === "string" && details.contentType) error.contentType = details.contentType.slice(0, 120);
  if (typeof details.fetchEndpoint === "string" && details.fetchEndpoint) error.fetchEndpoint = details.fetchEndpoint.slice(0, 240);
  if (typeof details.parseStage === "string" && details.parseStage) error.parseStage = details.parseStage.slice(0, 80);
  const validation = sanitizeLineupValidationDetails(details.validation);
  if (validation) error.validation = validation;
  return error;
}

function normalizeRosterForSnapshot(players) {
  if (!Array.isArray(players) || players.length < ROSTER_MINIMUM_PLAYER_COUNT) return null;
  const normalized = players.map((player) => ({
    position: String(player?.position || "").trim(),
    number: typeof player?.number === "string" ? player.number : String(player?.number || "").trim(),
    name: String(player?.name || "").replace(/[\s\u3000]/g, "")
  }));
  if (normalized.some((player) => !player.position || !player.number || !player.name)) return null;
  return normalized;
}

function createOfficialLineupFromNpb(lineup) {
  const parsedCount = Array.isArray(lineup) ? lineup.length : 0;
  const validation = {
    parseStage: "official_lineup",
    expectedTeams: [FIGHTERS_TEAM_CODE],
    detectedTeams: [],
    expectedCount: SCORING_LINEUP_SIZE,
    parsedCount,
    resolvedPlayerCount: 0,
    validPositionCount: 0,
    missingPositionCount: 0,
    duplicateBattingOrderCount: 0,
    duplicatePlayerCount: 0,
    battingOrderMin: null,
    battingOrderMax: null
  };
  const invalid = (code, error, extra = {}) => ({
    ok: false,
    code,
    error,
    validation: sanitizeLineupValidationDetails({ ...validation, ...extra, validationReason: code })
  });
  if (!Array.isArray(lineup) || lineup.length !== SCORING_LINEUP_SIZE) {
    return invalid("LINEUP_INVALID_PLAYER_COUNT", "NPBのスタメン人数が9人ではありません。");
  }
  const result = [];
  const orders = new Set();
  const players = new Set();
  for (const row of lineup) {
    const rawPlayerName = String(row?.playerName || "").trim();
    const player = findFightersPlayerByName(rawPlayerName);
    const battingOrder = Number(row?.order);
    const position = normalizeScoringPosition(row?.position);
    if (!Number.isInteger(battingOrder) || battingOrder < 1 || battingOrder > 9 || orders.has(battingOrder)) {
      return invalid("LINEUP_PARSE_FAILED", "NPBの打順を安全に解析できません。", {
        resolvedPlayerCount: result.length,
        duplicateBattingOrderCount: orders.has(battingOrder) ? 1 : 0,
        battingOrderMin: Number.isInteger(battingOrder) ? battingOrder : null,
        battingOrderMax: Number.isInteger(battingOrder) ? battingOrder : null
      });
    }
    if (!position) {
      return invalid("LINEUP_INVALID_POSITION", "NPBの守備位置を正規化できません。", {
        resolvedPlayerCount: result.length,
        missingPositionCount: 1
      });
    }
    const playerId = player ? createFightersPlayerId(player.uniformNumber) : null;
    if (playerId && players.has(playerId)) {
      return invalid("LINEUP_DUPLICATE_PLAYER", "NPBのスタメンに同一選手が重複しています。", {
        resolvedPlayerCount: result.length,
        duplicatePlayerCount: 1
      });
    }
    orders.add(battingOrder);
    if (playerId) players.add(playerId);
    validation.resolvedPlayerCount += playerId ? 1 : 0;
    validation.validPositionCount = result.length + 1;
    validation.battingOrderMin = validation.battingOrderMin === null ? battingOrder : Math.min(validation.battingOrderMin, battingOrder);
    validation.battingOrderMax = validation.battingOrderMax === null ? battingOrder : Math.max(validation.battingOrderMax, battingOrder);
    result.push({
      playerId,
      teamId: FIGHTERS_TEAM_ID,
      teamCode: FIGHTERS_TEAM_CODE,
      uniformNumber: player?.uniformNumber || String(row?.uniformNumber || "").trim(),
      playerName: player?.name || rawPlayerName || "不明",
      battingOrder,
      position,
      ...(playerId ? {} : { resolutionStatus: "unresolved", rawPlayerName: rawPlayerName || "不明" })
    });
  }
  const sanitized = sanitizeActualLineupForScoring(result, { allowUnresolvedPlayer: true });
  return sanitized.ok ? { ok: true, lineup: sanitized.lineup, validation: { ...validation, valid: true, unresolvedPlayerCount: sanitized.lineup.filter((row) => !row.playerId).length } } : {
    ...invalid("LINEUP_INVALID_POSITION", sanitized.error || "NPBの守備位置を検証できません。", {
      resolvedPlayerCount: result.length,
      validPositionCount: result.length,
      missingPositionCount: 1
    })
  };
}

export function shouldAutoApproveOfficialLineup(autoApproveEnabled, lineupResult) {
  return Boolean(autoApproveEnabled)
    && Boolean(lineupResult?.ok)
    && Array.isArray(lineupResult.lineup)
    && lineupResult.lineup.length === SCORING_LINEUP_SIZE;
}

async function ensurePregameAutomationRow(db, identity, now) {
  const nowIso = now.toISOString();
  const storage = await requireInternalGameIdForWrite(db, {
    table: "game_pregame_automation",
    gameId: identity.gameId,
    internalGameId: identity.internalGameId || identity.game?.internalGameId || ""
  });
  const internalColumn = storage.schemaReady ? ", internal_game_id" : "";
  const internalValue = storage.schemaReady ? ", ?5" : "";
  await db.prepare(
    `INSERT INTO game_pregame_automation (game_id, game_date, start_at, created_at, updated_at${internalColumn})
     VALUES (?1, ?2, ?3, ?4, ?4${internalValue})
     ON CONFLICT(game_id) DO UPDATE SET game_date = excluded.game_date, start_at = excluded.start_at, updated_at = excluded.updated_at`
  ).bind(...(storage.schemaReady
    ? [identity.gameId, identity.game.date, identity.startAt.toISOString(), nowIso, storage.internalGameId]
    : [identity.gameId, identity.game.date, identity.startAt.toISOString(), nowIso])).run();
}

async function readRosterFetchState(db, gameId) {
  try {
    return await db.prepare(
      `SELECT last_successful_roster_fetch_at, roster_next_check_at, last_pregame_check_game_id,
              last_roster_fetch_slot, last_roster_attempt_at, last_roster_error_code, last_roster_fetch_source
         FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1`
    ).bind(gameId).first();
  } catch (error) {
    if (isPregameSchemaError(error)) return null;
    throw error;
  }
}

async function updateRosterFetchState(db, gameId, now, { source = "cron", success = false, pregame = false, pregameMarker = "", fetchSlot = "", errorCode = "" } = {}) {
  const nowIso = now.toISOString();
  const nextCheckAt = success && !pregame
    ? new Date(now.getTime() + ROSTER_AUTO_FETCH_INTERVAL_MS).toISOString()
    : success
      ? null
      : new Date(now.getTime() + ROSTER_AUTO_FETCH_RETRY_INTERVAL_MS).toISOString();
  try {
    await db.prepare(
      `UPDATE game_pregame_automation
          SET last_roster_attempt_at = ?1,
              last_successful_roster_fetch_at = CASE WHEN ?2 THEN ?1 ELSE last_successful_roster_fetch_at END,
              roster_next_check_at = ?3,
              last_pregame_check_game_id = CASE WHEN ?4 THEN COALESCE(?5, game_id) ELSE last_pregame_check_game_id END,
              last_roster_fetch_slot = CASE WHEN ?6 <> '' THEN ?6 ELSE last_roster_fetch_slot END,
              last_roster_error_code = ?7,
              last_roster_fetch_source = ?8,
              updated_at = ?1
        WHERE game_id = ?9`
    ).bind(nowIso, success ? 1 : 0, nextCheckAt, pregame ? 1 : 0, pregameMarker || null, fetchSlot || "", errorCode || null, source === "admin" ? "admin" : "cron", gameId).run();
  } catch (error) {
    if (isPregameSchemaError(error)) {
      console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=roster state=record status=failed code=ROSTER_STATE_SCHEMA_NOT_READY`);
      return false;
    }
    throw error;
  }
  return true;
}

async function readRosterSnapshot(db, gameId) {
  const row = await db.prepare(
    "SELECT roster_json, captured_at FROM game_roster_snapshots WHERE game_id = ?1 LIMIT 1"
  ).bind(gameId).first();
  return {
    capturedAt: row?.captured_at || "",
    players: parseJsonArray(row?.roster_json)
  };
}

function rosterFingerprint(players) {
  return JSON.stringify((Array.isArray(players) ? players : []).map((player) => ({
    position: String(player?.position || ""),
    number: String(player?.number || ""),
    name: String(player?.name || "")
  })).sort((left, right) => `${left.number}:${left.name}:${left.position}`.localeCompare(`${right.number}:${right.name}:${right.position}`)));
}

// Roster capture is schedule-driven. It deliberately does not require an NPB
// game code because the roster endpoint is a fixed source and the canonical
// schedule row is the source of truth for the target and timing.
async function resolveRosterScheduleTarget(db, gameId, target = {}) {
  const requestedInternalGameId = String(target?.internalGameId || target?.internal_game_id || target?.game?.internalGameId || "").trim();
  if (!INTERNAL_GAME_ID_PATTERN.test(requestedInternalGameId)) {
    const error = createPregameError("SCHEDULE_UNAVAILABLE", "日程DBからロースター対象試合を確認できません。", { retryable: false });
    error.rosterResolution = {
      resolutionStage: "canonical_schedule_db",
      resolvedBy: "unresolved",
      startAtFound: false
    };
    throw error;
  }
  const columns = await getTableColumnSet(db, "games");
  if (!columns.has("internal_game_id")) {
    throw createPregameError("V3_ROSTER_SCHEMA_UNAVAILABLE", "V3日程DBが準備されていません。", { httpStatus: 503, retryable: false });
  }
  const row = await db.prepare(
    `SELECT internal_game_id, game_date, start_time, home_team, away_team, game_status
       FROM games WHERE internal_game_id = ?1 LIMIT 1`
  ).bind(requestedInternalGameId).first();
  const startAt = new Date(row?.start_time || "");
  if (!row || Number.isNaN(startAt.getTime())) {
    const error = createPregameError("SCHEDULE_UNAVAILABLE", "日程DBからロースター対象試合を確認できません。", { retryable: false });
    error.rosterResolution = {
      resolutionStage: "canonical_schedule_db",
      resolvedBy: "unresolved",
      startAtFound: false
    };
    throw error;
  }
  return {
    gameId: requestedInternalGameId,
    internalGameId: requestedInternalGameId,
    date: row.game_date,
    startAt,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    status: row.game_status || "scheduled",
    game: {
      gameId: requestedInternalGameId,
      date: row.game_date,
      startAt,
      internalGameId: requestedInternalGameId,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      status: row.game_status || "scheduled"
    },
    resolvedBy: "games.internal_game_id"
  };
}

export function summarizeV3RosterNotice(payload, { gameDate = "", homeTeam = "", awayTeam = "" } = {}) {
  const targetHomeTeam = normalizeScheduleTeamCode(homeTeam);
  const targetAwayTeam = normalizeScheduleTeamCode(awayTeam);
  const teams = Object.entries(payload?.rosters && typeof payload.rosters === "object" ? payload.rosters : {})
    .map(([team, roster]) => [normalizeScheduleTeamCode(team), Array.isArray(roster) ? roster : []])
    .filter(([team]) => Boolean(team));
  const rosterByTeam = new Map(teams);
  const changesFor = (field, team) => (Array.isArray(payload?.[field]) ? payload[field] : [])
    .filter((entry) => normalizeScheduleTeamCode(entry?.team || entry?.teamName || entry?.club || "") === team);
  const namesFor = (field, team) => changesFor(field, team)
    .map((entry) => String(entry?.name || entry?.playerName || entry?.player_name || "").trim())
    .filter(Boolean);
  const registeredHome = changesFor("registrations", targetHomeTeam);
  const deregisteredHome = changesFor("removals", targetHomeTeam);
  const registeredAway = changesFor("registrations", targetAwayTeam);
  const deregisteredAway = changesFor("removals", targetAwayTeam);
  const registeredCountHome = registeredHome.length;
  const deregisteredCountHome = deregisteredHome.length;
  const registeredCountAway = registeredAway.length;
  const deregisteredCountAway = deregisteredAway.length;
  const homeRosterConfirmed = rosterByTeam.has(targetHomeTeam) && rosterByTeam.get(targetHomeTeam).length > 0;
  const awayRosterConfirmed = rosterByTeam.has(targetAwayTeam) && rosterByTeam.get(targetAwayTeam).length > 0;
  const totalRosterChanges = registeredCountHome + deregisteredCountHome + registeredCountAway + deregisteredCountAway;
  return {
    targetHomeTeam,
    targetAwayTeam,
    homeRosterConfirmed,
    awayRosterConfirmed,
    registeredCountHome,
    deregisteredCountHome,
    registeredCountAway,
    deregisteredCountAway,
    registeredPlayersHome: namesFor("registrations", targetHomeTeam),
    deregisteredPlayersHome: namesFor("removals", targetHomeTeam),
    registeredPlayersAway: namesFor("registrations", targetAwayTeam),
    deregisteredPlayersAway: namesFor("removals", targetAwayTeam),
    totalRosterChanges,
    sourceDate: String(payload?.pageDate || "") || null,
    noticeState: String(payload?.pageDate || "") === String(gameDate || "")
      ? (totalRosterChanges > 0 ? "ROSTER_CHANGES_CAPTURED" : "ROSTER_NO_CHANGES")
      : "ROSTER_NOTICE_DATE_UNAVAILABLE"
  };
}

export function validateV3RosterAnnouncement(notice, { gameDate = "" } = {}) {
  if (!notice?.sourceDate || notice.sourceDate !== String(gameDate || "")) {
    return { ok: false, code: "ROSTER_SOURCE_DATE_MISMATCH", parserResult: "notice_date_mismatch" };
  }
  if (!notice.homeRosterConfirmed || !notice.awayRosterConfirmed) {
    return { ok: false, code: "ROSTER_TEAM_MISMATCH", parserResult: "team_confirmation_failed" };
  }
  return { ok: true, code: notice.noticeState, parserResult: "valid" };
}

async function captureGameRosterSnapshot(env, gameId, now, { force = false, source = "admin", pregame = false, pregameMarker = "", fetchSlot = "", target = null } = {}) {
  const isV3 = source === "v3";
  const identity = await resolveRosterScheduleTarget(env.AUTH_DB, gameId, target || {});
  const storage = await requireInternalGameIdForWrite(env.AUTH_DB, {
    table: "game_roster_snapshots",
    gameId,
    internalGameId: identity.internalGameId || identity.game?.internalGameId || ""
  });
  if (!isV3) await ensurePregameAutomationRow(env.AUTH_DB, identity, now);
  const frozen = isV3
    ? null
    : await env.AUTH_DB.prepare("SELECT roster_fixed_at FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
  if (frozen?.roster_fixed_at) return { status: "frozen", fixedAt: frozen.roster_fixed_at };
  const existing = isV3 && storage.schemaReady
    ? await env.AUTH_DB.prepare("SELECT game_id, game_date, captured_at, source, status, player_count, roster_json FROM game_roster_snapshots WHERE internal_game_id = ?1 ORDER BY updated_at DESC, captured_at DESC LIMIT 1").bind(storage.internalGameId).first()
    : await env.AUTH_DB.prepare("SELECT game_id, roster_json FROM game_roster_snapshots WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
  if (existing && !force && !isV3) return { status: "already_captured" };
  try {
    const payload = await fetchNpbWorkerJson(env, { mode: "roster" });
    const roster = normalizeRosterForSnapshot(payload.players);
    if (!roster || payload.warning) {
      throw createPregameError(isV3 ? "ROSTER_PARSE_FAILED" : "INVALID_ROSTER", "NPBロースターの解析結果が不完全です。", { retryable: isV3 });
    }
    const noticePayload = isV3
      ? await fetchNpbWorkerJson(env, { mode: "notice", date: identity.game.date })
      : null;
    const notice = isV3
      ? summarizeV3RosterNotice(noticePayload, {
        gameDate: identity.game.date,
        homeTeam: identity.game.homeTeam,
        awayTeam: identity.game.awayTeam
      })
      : null;
    if (isV3 && (payload?.stale || noticePayload?.stale)) {
      const error = createPregameError("ROSTER_SOURCE_STALE", "最新のNPBロースター情報を確認できません。", { retryable: true });
      error.diagnostics = {
        executorStage: "validate_roster_source",
        internalGameId: storage.internalGameId,
        gameDate: identity.game.date,
        sourceUrl: noticePayload?.sourceUrl || payload?.sourceUrl || null,
        httpStatus: Number(noticePayload?.httpStatus || payload?.httpStatus || 0) || null,
        parserResult: "source_stale"
      };
      throw error;
    }
    const announcementValidation = isV3 ? validateV3RosterAnnouncement(notice, { gameDate: identity.game.date }) : null;
    if (isV3 && !announcementValidation.ok) {
      const error = createPregameError(announcementValidation.code, announcementValidation.code === "ROSTER_SOURCE_DATE_MISMATCH"
        ? "対象日のNPB公示を確認できません。"
        : "対象試合の両球団ロースターを公式公示で確認できません。", { retryable: true });
      error.diagnostics = {
        executorStage: announcementValidation.code === "ROSTER_SOURCE_DATE_MISMATCH" ? "validate_notice_date" : "validate_notice_teams",
        internalGameId: storage.internalGameId,
        gameDate: identity.game.date,
        sourceUrl: noticePayload?.sourceUrl || null,
        httpStatus: Number(noticePayload?.httpStatus || noticePayload?.__fetchMeta?.httpStatus || 0) || null,
        parserResult: announcementValidation.parserResult,
        ...notice
      };
      throw error;
    }
    const capturedAt = String((isV3 ? noticePayload?.fetchedAt : payload.fetchedAt) || payload.fetchedAt || now.toISOString());
    const rosterJson = JSON.stringify(roster);
    const previousRosterJson = existing;
    const unchanged = Boolean(previousRosterJson?.roster_json && rosterFingerprint(parseJsonArray(previousRosterJson.roster_json)) === rosterFingerprint(roster));
    if (unchanged && !isV3) {
      if (!isV3) await updateRosterFetchState(env.AUTH_DB, gameId, now, { source, success: true, pregame, pregameMarker, fetchSlot });
      return { status: "unchanged", playerCount: roster.length, capturedAt, roster, unchanged: true };
    }
    // V3 owns a UUID-keyed snapshot row. Older legacy-keyed rows are historical only.
    const snapshotGameId = isV3 ? storage.internalGameId : gameId;
    const internalColumn = storage.schemaReady ? ", internal_game_id" : "";
    const internalValue = storage.schemaReady ? ", ?6" : "";
    const statements = [
      env.AUTH_DB.prepare(
        `INSERT INTO game_roster_snapshots (game_id, game_date, captured_at, roster_json, source, player_count, status, created_at, updated_at${internalColumn})
         VALUES (?1, ?2, ?3, ?4, 'npb-roster', ?5, 'captured', ?3, ?3${internalValue})
         ON CONFLICT(game_id) DO UPDATE SET${storage.schemaReady ? " internal_game_id = CASE WHEN excluded.internal_game_id IS NULL OR excluded.internal_game_id = '' THEN game_roster_snapshots.internal_game_id ELSE excluded.internal_game_id END," : ""} captured_at = excluded.captured_at, roster_json = excluded.roster_json, player_count = excluded.player_count, updated_at = excluded.updated_at`
      ).bind(...(storage.schemaReady
        ? [snapshotGameId, identity.game.date, capturedAt, rosterJson, roster.length, storage.internalGameId]
        : [snapshotGameId, identity.game.date, capturedAt, rosterJson, roster.length]))
    ];
    if (!isV3) {
      statements.push(env.AUTH_DB.prepare(
        `UPDATE game_pregame_automation SET roster_status = 'captured', roster_captured_at = ?1, last_error_code = NULL, last_error_message = NULL, updated_at = ?1 WHERE game_id = ?2`
      ).bind(capturedAt, gameId));
    }
    await env.AUTH_DB.batch(statements);
    // V3 writes stay on the canonical UUID row; historical legacy rows are read-only.
    if (!isV3) await updateRosterFetchState(env.AUTH_DB, gameId, now, { source, success: true, pregame, pregameMarker, fetchSlot });
    return {
      status: "captured",
      playerCount: roster.length,
      capturedAt,
      roster,
      unchanged,
      reasonCode: isV3 ? notice.noticeState : null,
      snapshotCaptured: true,
      snapshotCapturedAt: capturedAt,
      snapshotGameDate: identity.game.date,
      snapshotInternalGameId: storage.internalGameId,
      snapshotFresh: isV3 ? true : null,
      sourceUrl: isV3 ? (noticePayload?.sourceUrl || payload?.sourceUrl || null) : (payload?.sourceUrl || null),
      httpStatus: isV3 ? Number(noticePayload?.httpStatus || noticePayload?.__fetchMeta?.httpStatus || 0) || null : Number(payload?.httpStatus || payload?.__fetchMeta?.httpStatus || 0) || null,
      parserResult: "valid",
      sourceDate: noticePayload?.pageDate || null,
      fetchedAt: capturedAt,
      ...(isV3 ? notice : {}),
      rosterResolution: {
        resolutionStage: "canonical_schedule_db",
        resolvedBy: identity.resolvedBy || "canonical_schedule_db",
        startAtFound: Boolean(identity.startAt && !Number.isNaN(new Date(identity.startAt).getTime())
        )
      }
    };
  } catch (error) {
    if (isV3 && ["NPB_HTTP_ERROR", "NPB_WORKER_TIMEOUT", "NPB_FETCH_FAILED"].includes(String(error?.code || ""))) {
      error.code = "HTTP_FETCH_FAILED";
    }
    error.rosterResolution = {
      resolutionStage: "canonical_schedule_db",
      resolvedBy: identity.resolvedBy || "canonical_schedule_db",
      startAtFound: Boolean(identity.startAt && !Number.isNaN(new Date(identity.startAt).getTime()))
    };
    if (isV3) {
      error.diagnostics = {
        ...(error?.diagnostics && typeof error.diagnostics === "object" ? error.diagnostics : {}),
        executorStage: error?.diagnostics?.executorStage || "capture_roster_snapshot",
        internalGameId: storage.internalGameId,
        gameDate: identity.game.date,
        sourceUrl: error?.upstreamUrl || error?.diagnostics?.sourceUrl || null,
        httpStatus: Number(error?.httpStatus || error?.upstreamStatus || error?.diagnostics?.httpStatus || 0) || null,
        parserResult: error?.diagnostics?.parserResult || "failed",
        rosterResolution: error.rosterResolution
      };
    }
    if (!isV3) {
      await updateRosterFetchState(env.AUTH_DB, gameId, now, { source, errorCode: String(error?.code || "ROSTER_FETCH_FAILED") });
      try {
        await recordPregameError(env.AUTH_DB, gameId, "roster", error, now);
      } catch (recordError) {
        console.error(`pregame roster error record failed: game=${gameId} code=${recordError?.code || "schema"}`);
      }
    }
    throw error;
  }
}

export async function selectV3LineupFinalizeCandidate(db, { internalGameId = "" } = {}) {
  const id = String(internalGameId || "");
  const diagnostics = {
    internalGameId: id,
    lookup: "game_lineup_revisions.internal_game_id",
    executorReached: true,
    provisionalLineupFound: false,
    candidateCount: 0,
    selectedRevisionId: null,
    playerCount: 0,
    validation: null,
    rejectionReasons: []
  };
  if (!INTERNAL_GAME_ID_PATTERN.test(id)) {
    return { ok: false, code: "V3_LINEUP_INTERNAL_ID_INVALID", diagnostics };
  }
  const columns = await getTableColumnSet(db, "game_lineup_revisions");
  if (!columns.has("internal_game_id")) {
    return {
      ok: false,
      code: "V3_LINEUP_SCHEMA_UNAVAILABLE",
      diagnostics: { ...diagnostics, lookup: "internal_game_id_column_missing" }
    };
  }
  const rows = await db.prepare(
    "SELECT * FROM game_lineup_revisions WHERE internal_game_id = ?1 ORDER BY version DESC LIMIT 20"
  ).bind(id).all();
  const candidates = (rows.results || []).filter((row) => Number(row.is_final || 0) !== 1);
  diagnostics.candidateCount = candidates.length;
  for (const row of candidates) {
    const permissive = sanitizeActualLineupForScoring(parseStoredActualLineup(row.actual_lineup_json), { allowUnresolvedPlayer: true });
    if (!permissive.ok) {
      diagnostics.rejectionReasons.push({ revisionId: row.revision_id || `${row.game_id}:${row.version}`, code: "V3_LINEUP_INCOMPLETE", message: permissive.error });
      continue;
    }
    const strict = sanitizeActualLineupForScoring(permissive.lineup);
    if (!strict.ok) {
      diagnostics.rejectionReasons.push({ revisionId: row.revision_id || `${row.game_id}:${row.version}`, code: "V3_LINEUP_PLAYER_RESOLUTION_FAILED", message: strict.error });
      continue;
    }
    diagnostics.provisionalLineupFound = true;
    diagnostics.selectedRevisionId = row.revision_id || `${row.game_id}:${row.version}`;
    diagnostics.playerCount = strict.lineup.length;
    diagnostics.validation = row.validation_json || null;
    return { ok: true, row, lineup: strict.lineup, diagnostics };
  }
  const firstRejection = diagnostics.rejectionReasons[0];
  return {
    ok: false,
    code: firstRejection?.code || "V3_LINEUP_CANDIDATE_NOT_FOUND",
    diagnostics
  };
}

function normalizeV3LineupFinalizeError(error, diagnostics = {}) {
  if (error?.code) {
    if (!error.diagnostics) error.diagnostics = diagnostics;
    return error;
  }
  return createV3Error("V3_LINEUP_FINALIZE_FAILED", "正式スタメン確定処理に失敗しました。", {
    retryable: true,
    diagnostics: {
      ...diagnostics,
      executorError: String(error?.message || "unknown").slice(0, 120)
    }
  });
}

async function adoptPersistedLineupCandidate(env, gameId, now, { internalGameId = "", target = null, source = "legacy" } = {}) {
  const startAt = new Date(target?.startAt || "");
  if (!INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || "")) || Number.isNaN(startAt.getTime())) return null;
  const finalAt = new Date(startAt.getTime() + V3_TIMING.finalLineupMinutesAfterStart * 60000);
  if (now < finalAt) return null;
  if (source === "v3") {
    const candidate = await selectV3LineupFinalizeCandidate(env.AUTH_DB, { internalGameId });
    if (!candidate.ok) {
      if (candidate.code !== "V3_LINEUP_CANDIDATE_NOT_FOUND") {
        throw createV3Error(candidate.code, "V3の正式スタメン候補を確定できません。", {
          retryable: candidate.code === "V3_LINEUP_INCOMPLETE" || candidate.code === "V3_LINEUP_PLAYER_RESOLUTION_FAILED",
          diagnostics: candidate.diagnostics
        });
      }
      return null;
    }
    const row = candidate.row;
    const detectedAt = parseLineupDetectedAt(row.captured_at || row.created_at) || now;
    const record = await approveActualLineupForAutoScoring(env, gameId, candidate.lineup, detectedAt, {
      source: "npb-auto",
      scoringDueAt: finalAt,
      now,
      allowAfterStart: true,
      preventOverwrite: true,
      internalGameId
    });
    await activateLineupRevision(env.AUTH_DB, { gameId, version: row.version, internalGameId, finalizedAt: now, finalizedBy: "system" });
    await linkFinalLineupRevision(env.AUTH_DB, { gameId, internalGameId, version: row.version, finalizedAt: now, finalizedBy: "system" });
    return {
      status: "captured",
      recoveryMode: "persisted_lineup_revision_adoption",
      autoScoring: serializeGameLineup(record),
      lineupRevision: row,
      finalizationDiagnostics: candidate.diagnostics
    };
  }
  const rows = await env.AUTH_DB.prepare(
    "SELECT * FROM game_lineup_revisions WHERE game_id = ?1 ORDER BY version DESC LIMIT 20"
  ).bind(gameId).all();
  for (const row of rows.results || []) {
    const actual = sanitizeActualLineupForScoring(parseStoredActualLineup(row.actual_lineup_json), { allowUnresolvedPlayer: true });
    if (!actual.ok) continue;
    const detectedAt = parseLineupDetectedAt(row.captured_at || row.created_at) || now;
    const record = await approveActualLineupForAutoScoring(env, gameId, actual.lineup, detectedAt, {
      source: "npb-auto",
      scoringDueAt: finalAt,
      now,
      allowAfterStart: true,
      preventOverwrite: true,
      internalGameId
    });
    await activateLineupRevision(env.AUTH_DB, { gameId, version: row.version, internalGameId, finalizedAt: now, finalizedBy: "system" });
    await linkFinalLineupRevision(env.AUTH_DB, { gameId, internalGameId, version: row.version, finalizedAt: now, finalizedBy: "system" });
    if (source !== "v3") {
      await env.AUTH_DB.prepare(
        `UPDATE game_pregame_automation
            SET lineup_status = 'captured', lineup_captured_at = ?1, final_lineup_attempt_at = ?1,
                next_lineup_attempt_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = ?1
          WHERE game_id = ?2`
      ).bind(now.toISOString(), gameId).run();
    }
    return { status: "captured", recoveryMode: "persisted_lineup_revision_adoption", autoScoring: serializeGameLineup(record), lineupRevision: row };
  }
  return null;
}

async function captureOfficialLineup(env, gameId, now, { force = false, phase = "provisional", autoApproveEnabled = true, internalGameId = "", target = null, identityOverride = null, source = "legacy" } = {}) {
  const isFinalCapture = phase === "final";
  const isV3 = source === "v3";
  const existing = await getGameLineup(env.AUTH_DB, { gameId, internalGameId });
  if (existing) {
    return {
      status: isFinalCapture ? "already_captured" : "provisional",
      reused: true,
      lineupSource: existing.lineup_source || "manual"
    };
  }
  if (isFinalCapture) {
    const adopted = await adoptPersistedLineupCandidate(env, gameId, now, { internalGameId, target, source });
    if (adopted) return adopted;
  }
  if (!identityOverride) {
    throw createV3Error(LEGACY_AUTOMATION_RETIRED_CODE, "旧スタメン取得経路は停止されています。V3のinternal_game_id経路を使用してください。", { httpStatus: 410, retryable: false });
  }
  const identity = identityOverride;
  if (!isV3) await ensurePregameAutomationRow(env.AUTH_DB, identity, now);
  if (isFinalCapture ? now < identity.finalLineupFetchAt : !isBeforeGameStart(identity.startAt, now)) {
    // 試合開始後に残った仮スタメンjobは「未発表」ではない。
    // executorがfinal_lineup_fetchを後続作成できるよう、正常な引き継ぎ結果にする。
    return { status: isFinalCapture ? "not_due" : "superseded_after_start", superseded: !isFinalCapture };
  }
  try {
    const payload = identityOverride?.sourceUrl
      ? await fetchNpbWorkerJson(env, { mode: "lineup", url: identityOverride.sourceUrl })
      : await fetchNpbWorkerJson(env, { mode: "lineup", date: identity.game.date, gameCode: identity.gameCode });
    const actual = createOfficialLineupFromNpb(payload.lineup);
    if (!actual.ok) {
      throw createPregameError(actual.code || "LINEUP_PARSE_FAILED", actual.error, {
        parseStage: "official_lineup",
        validation: { ...actual.validation, detectedTeams: payload.team ? [String(payload.team)] : [] },
        upstreamUrl: payload.sourceUrl,
        upstreamMode: "lineup"
      });
    }
    const detectedAt = new Date(payload.fetchedAt || now);
    if (!isFinalCapture) {
      const revision = await saveProvisionalOfficialLineup(env.AUTH_DB, gameId, actual.lineup, detectedAt, now, {
        internalGameId,
        validation: actual.validation || null,
        source
      });
      return { status: "provisional", sourceUrl: payload.sourceUrl, lineup: actual.lineup, detectedAt: detectedAt.toISOString(), lineupRevision: revision };
    }
    const revision = await saveLineupCandidateRevision(env.AUTH_DB, {
      gameId,
      internalGameId,
      lineup: actual.lineup,
      source: "npb",
      capturedAt: detectedAt,
      validation: actual.validation || null,
      reason: "NPB公式スタメン最終候補",
      allowUnresolvedPlayer: true
    });
    const record = await approveActualLineupForAutoScoring(env, gameId, actual.lineup, detectedAt, {
      source: "npb-auto",
      scoringDueAt: new Date(identity.startAt.getTime() + 2 * 60 * 1000),
      now,
      allowAfterStart: true,
      preventOverwrite: true,
      internalGameId
    });
    await activateLineupRevision(env.AUTH_DB, { gameId, version: revision.version, internalGameId, finalizedAt: now, finalizedBy: "system" });
    await linkFinalLineupRevision(env.AUTH_DB, { gameId, internalGameId, version: revision.version, finalizedAt: now, finalizedBy: "system" });
    if (!isV3) {
      await env.AUTH_DB.prepare(
        `UPDATE game_pregame_automation
            SET lineup_status = 'captured', lineup_captured_at = ?1, final_lineup_attempt_at = ?1,
                last_lineup_attempt_at = ?1, lineup_attempt_count = lineup_attempt_count + 1,
                next_lineup_attempt_at = NULL,
                last_error_code = NULL, last_error_message = NULL, updated_at = ?1
          WHERE game_id = ?2`
      ).bind(now.toISOString(), gameId).run();
    }
    return { status: "captured", sourceUrl: payload.sourceUrl, autoScoring: serializeGameLineup(record), lineupRevision: revision };
  } catch (error) {
    if (!isV3) {
      try {
        await recordPregameLineupAttempt(env.AUTH_DB, gameId, identity, now, error, phase);
      } catch (recordError) {
        console.error(`pregame lineup error record failed: game=${gameId} code=${recordError?.code || "schema"}`);
      }
    }
    throw error;
  }
}

const WORKFLOW_LOG_STATUSES = new Set(["success", "warning", "error", "info"]);
const WORKFLOW_LOG_SOURCES = new Set(["cron", "admin", "system"]);

function parseWorkflowLogMetadata(value) {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function hasRecentEquivalentWorkflowLog(db, { eventType, status, gameId, errorCode, metadata, occurred }) {
  try {
    const since = new Date(occurred.getTime() - WORKFLOW_LOG_DEDUPE_WINDOW_MS).toISOString();
    const normalizedEventType = String(eventType || "workflow").slice(0, 80);
    const normalizedErrorCode = String(errorCode || "").slice(0, 80);
    const expectedDate = String(metadata?.gameDate || metadata?.date || "");
    // 期限ちょうどは「30分以上経過」として再通知を許可するため、比較は厳密な > にします。
    const rows = gameId
      ? await db.prepare(
        `SELECT status, error_code, metadata FROM game_workflow_logs
           WHERE event_type = ?1 AND game_id = ?2 AND occurred_at > ?3
           ORDER BY occurred_at DESC LIMIT 50`
      ).bind(normalizedEventType, gameId, since).all()
      : await db.prepare(
        `SELECT status, error_code, metadata FROM game_workflow_logs
           WHERE event_type = ?1 AND game_id IS NULL AND occurred_at > ?2
           ORDER BY occurred_at DESC LIMIT 50`
      ).bind(normalizedEventType, since).all();
    const recent = (rows.results || []).find((row) => {
      if (!gameId && expectedDate) {
        const rowMetadata = parseWorkflowLogMetadata(row.metadata);
        return String(rowMetadata.gameDate || rowMetadata.date || "") === expectedDate;
      }
      return true;
    });
    return Boolean(recent)
      && recent.status === status
      && String(recent.error_code || "") === normalizedErrorCode;
  } catch (error) {
    console.warn(`[GAME_WORKFLOW_LOG] action=dedupe status=failed code=${error?.code || "WORKFLOW_LOG_DEDUPE_READ_FAILED"}`);
    return false;
  }
}

function serializeWorkflowLogMetadata(metadata) {
  const source = metadata && typeof metadata === "object" ? metadata : {};
  try {
    const serialized = JSON.stringify(source, (key, value) => {
      if (/(cookie|authorization|token|secret|password|webhook|email|nickname|prediction)/i.test(key)) {
        return "[redacted]";
      }
      return value;
    });
    return serialized && serialized.length <= 2000 ? serialized : JSON.stringify({ truncated: true });
  } catch {
    return JSON.stringify({ unavailable: true });
  }
}

async function recordWorkflowLog(db, {
  eventType,
  status = "info",
  gameId = "",
  occurredAt = new Date(),
  message = "",
  errorCode = "",
  metadata = {},
  source = "system"
} = {}) {
  try {
    const normalizedGameId = String(gameId || "").slice(0, 120);
    if (normalizedGameId && await isTestRankingGame(db, normalizedGameId)) return null;
    const occurred = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
    if (Number.isNaN(occurred.getTime())) return null;
    const normalizedStatus = WORKFLOW_LOG_STATUSES.has(status) ? status : "info";
    const normalizedSource = WORKFLOW_LOG_SOURCES.has(source) ? source : "system";
    const inputMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
    const safeMetadata = {
      ...inputMetadata,
      processName: inputMetadata.processName || String(eventType || "workflow").slice(0, 80),
      gameId: inputMetadata.gameId || normalizedGameId || null,
      gameDate: inputMetadata.gameDate || inputMetadata.date || null,
      attemptedAt: inputMetadata.attemptedAt || occurred.toISOString(),
      completedAt: inputMetadata.completedAt || null,
      durationMs: inputMetadata.durationMs ?? null,
      source: inputMetadata.source || normalizedSource
    };
    const normalizedEventType = String(eventType || "workflow").slice(0, 80);
    const normalizedErrorCode = String(errorCode || "").slice(0, 80);
    if (await hasRecentEquivalentWorkflowLog(db, {
      eventType: normalizedEventType,
      status: normalizedStatus,
      gameId: normalizedGameId,
      errorCode: normalizedErrorCode,
      metadata: safeMetadata,
      occurred
    })) return null;
    await db.prepare(
      `INSERT INTO game_workflow_logs
         (id, event_type, status, game_id, occurred_at, message, error_code, metadata, source)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(
      randomToken(24),
      normalizedEventType,
      normalizedStatus,
      normalizedGameId || null,
      occurred.toISOString(),
      String(message || "").slice(0, 300),
      normalizedErrorCode || null,
      serializeWorkflowLogMetadata(safeMetadata),
      normalizedSource
    ).run();
    return true;
  } catch (error) {
    console.warn(`[GAME_WORKFLOW_LOG] action=write status=failed code=${error?.code || "WORKFLOW_LOG_WRITE_FAILED"}`);
    return false;
  }
}

export function getWorkflowLogCutoff(now) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return null;
  return new Date(current.getTime() - WORKFLOW_LOG_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
}

async function cleanupWorkflowLogs(db, now) {
  try {
    const current = now instanceof Date ? now : new Date(now);
    const today = getJstDateString(current);
    const maintenance = await db.prepare(
      "SELECT last_cleanup_at FROM game_workflow_log_maintenance WHERE maintenance_key = ?1 LIMIT 1"
    ).bind(WORKFLOW_LOG_CLEANUP_KEY).first();
    if (maintenance?.last_cleanup_at && getJstDateString(new Date(maintenance.last_cleanup_at)) === today) return;
    const cutoff = getWorkflowLogCutoff(current);
    if (!cutoff) return;
    await db.batch([
      db.prepare("DELETE FROM game_workflow_logs WHERE occurred_at < ?1").bind(cutoff),
      db.prepare(
        `INSERT INTO game_workflow_log_maintenance (maintenance_key, last_cleanup_at, updated_at)
         VALUES (?1, ?2, ?2)
         ON CONFLICT(maintenance_key) DO UPDATE SET last_cleanup_at = excluded.last_cleanup_at, updated_at = excluded.updated_at`
      ).bind(WORKFLOW_LOG_CLEANUP_KEY, current.toISOString())
    ]);
  } catch (error) {
    console.warn(`[GAME_WORKFLOW_LOG] action=cleanup status=failed code=${error?.code || "WORKFLOW_LOG_CLEANUP_FAILED"}`);
    await recordWorkflowLog(db, {
      eventType: "workflow_log_cleanup_failed",
      status: "warning",
      occurredAt: now,
      message: "試合進行ログの削除に失敗しました。",
      errorCode: String(error?.code || "WORKFLOW_LOG_CLEANUP_FAILED"),
      metadata: { processName: "workflow_log_cleanup" },
      source: "system"
    });
  }
}

function updatePredictionTargetState(_db, target) {
  return { changed: false, previousGameId: "", nextGameId: String(target?.gameId || ""), skipped: true };
}

function parseWorkflowLogLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return WORKFLOW_LOG_DEFAULT_LIMIT;
  return Math.min(WORKFLOW_LOG_MAX_LIMIT, Math.max(1, parsed));
}

function getWorkflowLogDateBoundary(value, endOfDay = false) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const boundary = new Date(`${date}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+09:00`);
  return Number.isNaN(boundary.getTime()) ? null : boundary.toISOString();
}

async function handleAdminWorkflowLogs(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const url = new URL(request.url);
  const limit = parseWorkflowLogLimit(url.searchParams.get("limit"));
  const clauses = [];
  const bindings = [];
  const gameId = String(url.searchParams.get("gameId") || "").trim().slice(0, 120);
  const eventType = String(url.searchParams.get("eventType") || "").trim().slice(0, 80);
  const status = String(url.searchParams.get("status") || "").trim();
  const dateFrom = getWorkflowLogDateBoundary(url.searchParams.get("dateFrom"));
  const dateTo = getWorkflowLogDateBoundary(url.searchParams.get("dateTo"), true);
  if (gameId) { bindings.push(gameId); clauses.push(`game_id = ?${bindings.length}`); }
  if (eventType) { bindings.push(eventType); clauses.push(`event_type = ?${bindings.length}`); }
  if (WORKFLOW_LOG_STATUSES.has(status)) { bindings.push(status); clauses.push(`status = ?${bindings.length}`); }
  if (dateFrom) { bindings.push(dateFrom); clauses.push(`occurred_at >= ?${bindings.length}`); }
  if (dateTo) { bindings.push(dateTo); clauses.push(`occurred_at <= ?${bindings.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  try {
    const result = await env.AUTH_DB.prepare(
      `SELECT id, event_type, status, game_id, occurred_at, message, error_code, metadata, source
         FROM game_workflow_logs ${where}
        ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`
    ).bind(...bindings).all();
    const logs = (result.results || []).map((row) => ({
      id: row.id,
      eventType: row.event_type,
      status: row.status,
      gameId: row.game_id || "",
      occurredAt: row.occurred_at,
      message: row.message,
      errorCode: row.error_code || "",
      metadata: parseJsonObject(row.metadata),
      source: row.source
    }));
    const response = jsonResponse({ ok: true, logs, limit }, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonResponse({
      ok: false,
      code: isPregameSchemaError(error) ? "WORKFLOW_LOG_SCHEMA_NOT_READY" : "WORKFLOW_LOG_READ_FAILED",
      error: "試合進行ログを取得できませんでした。"
    }, isPregameSchemaError(error) ? 503 : 500, cors);
  }
}

export function parseGameIdentityAuditOptions(request, now = new Date()) {
  const url = new URL(request.url);
  const suppliedGameDate = String(url.searchParams.get("gameDate") || "").trim();
  if (suppliedGameDate && !/^\d{4}-\d{2}-\d{2}$/.test(suppliedGameDate)) {
    return { ok: false, code: "GAME_IDENTITY_AUDIT_DATE_INVALID" };
  }
  const scope = String(url.searchParams.get("scope") || "").trim().toLowerCase();
  const allPeriod = scope === "all";
  const parsedLimit = Number.parseInt(url.searchParams.get("limit"), 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(GAME_IDENTITY_AUDIT_MAX_LIMIT, Math.max(1, parsedLimit))
    : GAME_IDENTITY_AUDIT_DEFAULT_LIMIT;
  const gameId = String(url.searchParams.get("gameId") || "").trim().slice(0, 160);
  const includeDetails = ["1", "true"].includes(String(url.searchParams.get("includeDetails") || "").trim().toLowerCase());
  const today = getJstDateString(now);
  const rangeStart = new Date(now.getTime() - ((GAME_IDENTITY_AUDIT_DEFAULT_RANGE_DAYS - 1) * 24 * 60 * 60 * 1000));
  return {
    ok: true,
    gameId,
    includeDetails,
    limit,
    allPeriod,
    gameDate: suppliedGameDate || "",
    dateFrom: suppliedGameDate || (allPeriod ? "" : getJstDateString(rangeStart)),
    dateTo: suppliedGameDate || (allPeriod ? "" : today),
    timestampFrom: allPeriod ? "" : rangeStart.toISOString(),
    timestampTo: allPeriod ? "" : now.toISOString()
  };
}

function getGameIdentityAuditFilter(options, field, isGameDate = false) {
  if (options.gameId) return { where: "WHERE game_id = ?", bindings: [options.gameId] };
  if (options.allPeriod || !field) return { where: "", bindings: [] };
  if (isGameDate) return { where: `WHERE ${field} >= ? AND ${field} <= ?`, bindings: [options.dateFrom, options.dateTo] };
  return { where: `WHERE ${field} >= ? AND ${field} <= ?`, bindings: [options.timestampFrom, options.timestampTo] };
}

async function getAvailableGameIdentityAuditTables(db) {
  const placeholders = GAME_IDENTITY_AUDIT_TABLES.map(() => "?").join(", ");
  const result = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
  ).bind(...GAME_IDENTITY_AUDIT_TABLES).all();
  return new Set((result.results || []).map((row) => String(row.name || "")));
}

async function readGameIdentityAuditRows(db, table, selectColumns, options, dateField, isGameDate = false) {
  const filter = getGameIdentityAuditFilter(options, dateField, isGameDate);
  const query = `${selectColumns} FROM ${table} ${filter.where} GROUP BY game_id ORDER BY last_seen_at DESC LIMIT ${GAME_IDENTITY_AUDIT_MAX_SCHEDULE_ROWS}`;
  const result = await db.prepare(query).bind(...filter.bindings).all();
  return result.results || [];
}

const GAME_IDENTITY_AUDIT_TABLE_QUERIES = Object.freeze({
  probable_starters: {
    dateField: "updated_at",
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(updated_at) AS first_seen_at, MAX(updated_at) AS last_seen_at,
      MAX(status) AS probable_starter_status, MAX(next_check_at) AS next_check_at, MAX(error_code) AS error_code,
      SUM(CASE WHEN internal_game_id IS NULL OR internal_game_id = '' THEN 1 ELSE 0 END) AS unlinked_row_count,
      GROUP_CONCAT(DISTINCT NULLIF(internal_game_id, '')) AS internal_game_ids`
  },
  game_day_notice_games: {
    dateField: "notice_date",
    isGameDate: true,
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(created_at) AS first_seen_at, MAX(updated_at) AS last_seen_at,
      MAX(notice_date) AS game_date, MAX(notice_status) AS notice_status, MAX(last_error_code) AS error_code`
  },
  game_roster_snapshots: {
    dateField: "game_date",
    isGameDate: true,
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(created_at) AS first_seen_at, MAX(updated_at) AS last_seen_at,
      MAX(game_date) AS game_date, MAX(status) AS roster_status,
      SUM(CASE WHEN internal_game_id IS NULL OR internal_game_id = '' THEN 1 ELSE 0 END) AS unlinked_row_count,
      GROUP_CONCAT(DISTINCT NULLIF(internal_game_id, '')) AS internal_game_ids`
  },
  game_pregame_automation: {
    dateField: "game_date",
    isGameDate: true,
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(created_at) AS first_seen_at, MAX(updated_at) AS last_seen_at,
      MAX(game_date) AS game_date, MAX(start_at) AS start_at, MAX(roster_status) AS roster_status,
      MAX(lineup_status) AS lineup_status, MAX(scoring_status) AS scoring_status,
      MAX(last_error_code) AS error_code, MAX(next_lineup_attempt_at) AS next_lineup_attempt_at,
      SUM(CASE WHEN internal_game_id IS NULL OR internal_game_id = '' THEN 1 ELSE 0 END) AS unlinked_row_count,
      GROUP_CONCAT(DISTINCT NULLIF(internal_game_id, '')) AS internal_game_ids`
  },
  game_lineups: {
    dateField: "updated_at",
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(created_at) AS first_seen_at, MAX(updated_at) AS last_seen_at,
      MAX(scoring_status) AS lineup_scoring_status, MAX(publication_status) AS publication_status,
      MAX(scored_at) AS scored_at, MAX(published_at) AS published_at,
      SUM(CASE WHEN internal_game_id IS NULL OR internal_game_id = '' THEN 1 ELSE 0 END) AS unlinked_row_count,
      GROUP_CONCAT(DISTINCT NULLIF(internal_game_id, '')) AS internal_game_ids`
  },
  game_lineup_revisions: {
    dateField: "created_at",
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(created_at) AS first_seen_at, MAX(created_at) AS last_seen_at,
      MAX(version) AS latest_revision_version, MAX(is_current) AS has_current_revision`
  },
  predictions: {
    dateField: "game_date",
    isGameDate: true,
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(submitted_at) AS first_seen_at, MAX(updated_at) AS last_seen_at,
      MAX(game_date) AS game_date, SUM(CASE WHEN status = 'scored' THEN 1 ELSE 0 END) AS scored_prediction_count,
      SUM(CASE WHEN status <> 'scored' THEN 1 ELSE 0 END) AS unscored_prediction_count,
      SUM(CASE WHEN internal_game_id IS NULL OR internal_game_id = '' THEN 1 ELSE 0 END) AS unlinked_row_count,
      GROUP_CONCAT(DISTINCT NULLIF(internal_game_id, '')) AS internal_game_ids`
  },
  ranking_games: {
    dateField: "game_date",
    isGameDate: true,
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(created_at) AS first_seen_at, MAX(updated_at) AS last_seen_at,
      MAX(game_date) AS game_date, MAX(is_ranking_eligible) AS is_ranking_eligible,
      MAX(game_status) AS ranking_game_status, MAX(publication_status) AS publication_status,
      MAX(published_at) AS published_at,
      SUM(CASE WHEN internal_game_id IS NULL OR internal_game_id = '' THEN 1 ELSE 0 END) AS unlinked_row_count,
      GROUP_CONCAT(DISTINCT NULLIF(internal_game_id, '')) AS internal_game_ids`
  },
  perfect_achievers: {
    dateField: "achieved_at",
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(achieved_at) AS first_seen_at, MAX(achieved_at) AS last_seen_at`
  },
  game_rescore_jobs: {
    dateField: "updated_at",
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(created_at) AS first_seen_at, MAX(updated_at) AS last_seen_at,
      MAX(status) AS rescore_status, MAX(error_code) AS error_code,
      SUM(CASE WHEN internal_game_id IS NULL OR internal_game_id = '' THEN 1 ELSE 0 END) AS unlinked_row_count,
      GROUP_CONCAT(DISTINCT NULLIF(internal_game_id, '')) AS internal_game_ids`
  },
  game_workflow_logs: {
    dateField: "occurred_at",
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(occurred_at) AS first_seen_at, MAX(occurred_at) AS last_seen_at,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_log_count, MAX(error_code) AS error_code`
  },
  game_workflow_controls: {
    dateField: "updated_at",
    select: `SELECT game_id, COUNT(*) AS row_count, MIN(updated_at) AS first_seen_at, MAX(updated_at) AS last_seen_at,
      MAX(automation_paused) AS automation_paused`
  }
});

async function collectGameIdentityAuditData(db, options) {
  const availableTables = await getAvailableGameIdentityAuditTables(db);
  const unavailableTables = GAME_IDENTITY_AUDIT_TABLES.filter((table) => !availableTables.has(table));
  const internalRegistry = await collectInternalGameRegistryAuditData(db, options);
  const scheduleRows = [];
  if (availableTables.has("detected_game_schedule")) {
    const filter = getGameIdentityAuditFilter(options, "game_date", true);
    const result = await db.prepare(
      `SELECT game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, game_status, internal_game_id,
              detected_at, schedule_checked_at, created_at, updated_at
         FROM detected_game_schedule ${filter.where}
        ORDER BY game_date DESC, start_at DESC LIMIT ${GAME_IDENTITY_AUDIT_MAX_SCHEDULE_ROWS}`
    ).bind(...filter.bindings).all();
    scheduleRows.push(...(result.results || []));
  }

  const tableRows = {};
  await Promise.all(Object.entries(GAME_IDENTITY_AUDIT_TABLE_QUERIES).map(async ([table, config]) => {
    if (!availableTables.has(table)) return;
    try {
      tableRows[table] = await readGameIdentityAuditRows(db, table, config.select, options, config.dateField, config.isGameDate);
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
      unavailableTables.push(table);
    }
  }));
  return { availableTables, unavailableTables: [...new Set(unavailableTables)].sort(), scheduleRows, tableRows, internalRegistry };
}

async function collectInternalGameRegistryAuditData(db, options) {
  const registry = await getGameIdentityRegistryAvailability(db);
  if (!registry.available) {
    return { available: false, reasonCode: "INTERNAL_GAME_REGISTRY_SCHEMA_NOT_READY" };
  }
  const gameFilter = getGameIdentityAuditFilter(options, "game_date", true);
  const scheduleFilter = getGameIdentityAuditFilter(options, "game_date", true);
  const gamesResult = await db.prepare(
    `SELECT COUNT(*) AS games_count
       FROM games ${gameFilter.where}`
  ).bind(...gameFilter.bindings).first();
  const identifiersResult = await db.prepare(
    `SELECT COUNT(*) AS identifiers_count
       FROM game_identifiers identifiers
       JOIN games ON games.internal_game_id = identifiers.internal_game_id
       ${gameFilter.where.replace(/game_date/g, "games.game_date")}`
  ).bind(...gameFilter.bindings).first();
  const withoutIdentifiersResult = await db.prepare(
    `SELECT COUNT(*) AS games_without_identifiers
       FROM games
       LEFT JOIN game_identifiers identifiers ON identifiers.internal_game_id = games.internal_game_id
       ${gameFilter.where.replace(/game_date/g, "games.game_date")}
       ${gameFilter.where ? "AND" : "WHERE"} identifiers.id IS NULL`
  ).bind(...gameFilter.bindings).first();
  const identifiersWithoutGamesResult = await db.prepare(
    `SELECT COUNT(*) AS identifiers_without_games
       FROM game_identifiers identifiers
       LEFT JOIN games ON games.internal_game_id = identifiers.internal_game_id
      WHERE games.internal_game_id IS NULL`
  ).bind().first();
  const multipleCandidatesResult = await db.prepare(
    `SELECT COUNT(*) AS multiple_internal_game_candidates
       FROM (
         SELECT game_date, start_time, home_team, away_team
           FROM games ${gameFilter.where}
          GROUP BY game_date, start_time, home_team, away_team
         HAVING COUNT(*) > 1
       )`
  ).bind(...gameFilter.bindings).first();
  const coverageResult = await db.prepare(
    `SELECT COUNT(*) AS schedule_games,
            SUM(CASE WHEN internal_game_id IS NOT NULL AND internal_game_id <> '' THEN 1 ELSE 0 END) AS linked_schedule_games,
            SUM(CASE WHEN internal_game_id IS NULL OR internal_game_id = '' THEN 1 ELSE 0 END) AS legacy_ids_without_internal_game_id
       FROM detected_game_schedule ${scheduleFilter.where}`
  ).bind(...scheduleFilter.bindings).first();
  const scheduleGames = Number(coverageResult?.schedule_games || 0);
  const linkedScheduleGames = Number(coverageResult?.linked_schedule_games || 0);
  return {
    available: true,
    gamesCount: Number(gamesResult?.games_count || 0),
    identifiersCount: Number(identifiersResult?.identifiers_count || 0),
    gamesWithoutIdentifiers: Number(withoutIdentifiersResult?.games_without_identifiers || 0),
    identifiersWithoutGames: Number(identifiersWithoutGamesResult?.identifiers_without_games || 0),
    multipleInternalGameCandidates: Number(multipleCandidatesResult?.multiple_internal_game_candidates || 0),
    legacyIdsWithoutInternalGameId: Number(coverageResult?.legacy_ids_without_internal_game_id || 0),
    internalGameIdCoverage: {
      scheduleGames,
      linkedScheduleGames,
      ratio: scheduleGames ? linkedScheduleGames / scheduleGames : 0
    }
  };
}

export function classifyGameIdentityFormat(value) {
  const gameId = String(value || "").trim();
  if (!gameId) return "empty";
  if (/^\d{4}-\d{2}-\d{2}-[a-z]{1,2}-[a-z]{1,2}-\d+$/i.test(gameId)) return "compact";
  if (parsePredictionGameId(gameId)?.format === "descriptive") return "descriptive";
  return "other";
}

function normalizeAuditIdentityValue(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function normalizeAuditStartAt(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  const parsed = new Date(source);
  return Number.isNaN(parsed.getTime()) ? source : parsed.toISOString();
}

function createAuditIdentifierCounts() {
  return { compact: 0, descriptive: 0, other: 0, empty: 0 };
}

function addAuditReference(references, table, row) {
  const gameId = String(row?.game_id || "").trim();
  if (!gameId) return;
  const reference = references.get(gameId) || { gameId, tables: {} };
  reference.tables[table] = row;
  references.set(gameId, reference);
}

function getAuditReferenceSummary(reference) {
  return Object.entries(reference?.tables || {}).map(([table, row]) => ({
    table,
    rowCount: Number(row?.row_count || 1),
    firstSeenAt: row?.first_seen_at || row?.created_at || "",
    lastSeenAt: row?.last_seen_at || row?.updated_at || ""
  })).sort((left, right) => left.table.localeCompare(right.table));
}

function isAuditPublished(reference) {
  const lineup = reference?.tables?.game_lineups;
  const ranking = reference?.tables?.ranking_games;
  return lineup?.publication_status === "published" || ranking?.publication_status === "published";
}

function buildAuditGameState(reference) {
  const lineup = reference?.tables?.game_lineups || {};
  const ranking = reference?.tables?.ranking_games || {};
  const pregame = reference?.tables?.game_pregame_automation || {};
  return {
    scored: lineup.lineup_scoring_status === "scored" || ranking.ranking_game_status === "scored",
    published: isAuditPublished(reference),
    serviceUnavailable: ranking.ranking_game_status === "service_unavailable",
    workflowStatus: pregame.scoring_status || "",
    lineupStatus: pregame.lineup_status || ""
  };
}

function buildAuditGameDetail(gameId, scheduleRow, reference) {
  const prediction = reference?.tables?.predictions || {};
  return {
    gameId,
    gameCode: scheduleRow?.game_code || "",
    sourceGameKey: scheduleRow?.source_game_key || "",
    gameDate: scheduleRow?.game_date || prediction.game_date || reference?.tables?.game_pregame_automation?.game_date || "",
    references: getAuditReferenceSummary(reference),
    predictionCount: Number(prediction.row_count || 0),
    hasLineup: Boolean(reference?.tables?.game_lineups),
    hasRankingGame: Boolean(reference?.tables?.ranking_games),
    workflow: buildAuditGameState(reference)
  };
}

function pushAuditConflict(conflicts, conflict) {
  conflicts.push({
    gameId: conflict.gameId || "",
    code: conflict.code,
    detail: conflict.detail || ""
  });
}

function buildGameIdentityAuditStateConflicts(references, duplicateGroups) {
  const conflicts = [];
  for (const reference of references.values()) {
    const lineup = reference.tables.game_lineups;
    const pregame = reference.tables.game_pregame_automation;
    const ranking = reference.tables.ranking_games;
    const predictions = reference.tables.predictions;
    if (lineup && !pregame) pushAuditConflict(conflicts, { gameId: reference.gameId, code: "LINEUP_WITHOUT_PREGAME_STATE", detail: "正式スタメンはありますが試合前自動処理状態がありません。" });
    if (lineup && pregame && pregame.lineup_status && pregame.lineup_status !== "captured") pushAuditConflict(conflicts, { gameId: reference.gameId, code: "LINEUP_WORKFLOW_STATE_MISMATCH", detail: "正式スタメンの保存状態と自動処理の取得状態が一致しません。" });
    if (Number(predictions?.scored_prediction_count || 0) > 0 && !lineup) pushAuditConflict(conflicts, { gameId: reference.gameId, code: "SCORED_PREDICTIONS_WITHOUT_LINEUP", detail: "採点済み予想がありますが正式スタメンがありません。" });
    if (ranking?.ranking_game_status === "scored" && !lineup) pushAuditConflict(conflicts, { gameId: reference.gameId, code: "SCORED_RANKING_GAME_WITHOUT_LINEUP", detail: "採点済み試合として記録されていますが正式スタメンがありません。" });
    if (lineup?.publication_status === "published" && lineup.lineup_scoring_status !== "scored") pushAuditConflict(conflicts, { gameId: reference.gameId, code: "LINEUP_PUBLISHED_NOT_SCORED", detail: "正式結果として公開されていますがスタメン採点状態が scored ではありません。" });
    if (ranking?.publication_status === "published" && ranking.ranking_game_status !== "scored") pushAuditConflict(conflicts, { gameId: reference.gameId, code: "RANKING_PUBLISHED_NOT_SCORED", detail: "ランキング側で公開されていますが試合状態が scored ではありません。" });
    if (ranking?.ranking_game_status === "service_unavailable" && Number(ranking.is_ranking_eligible) === 1) pushAuditConflict(conflicts, { gameId: reference.gameId, code: "SERVICE_UNAVAILABLE_RANKING_ELIGIBLE", detail: "サービス未稼働の試合がランキング対象です。" });
    if (Number(ranking?.is_ranking_eligible) === 1 && ranking.ranking_game_status !== "scored") pushAuditConflict(conflicts, { gameId: reference.gameId, code: "RANKING_ELIGIBLE_NOT_SCORED", detail: "ランキング対象ですが試合状態が scored ではありません。" });
    if (pregame?.error_code === "SCORING_RETRY_EXPIRED" && pregame.next_lineup_attempt_at) pushAuditConflict(conflicts, { gameId: reference.gameId, code: "RETRY_EXPIRED_WITH_NEXT_ATTEMPT", detail: "再試行期限切れ後にも次回スタメン取得時刻が残っています。" });
    if (Number(predictions?.scored_prediction_count || 0) > 0 && Number(predictions?.unscored_prediction_count || 0) > 0) pushAuditConflict(conflicts, { gameId: reference.gameId, code: "MIXED_PREDICTION_SCORING_STATE", detail: "同じ試合に採点済みと未採点の予想が混在しています。" });
  }
  for (const group of duplicateGroups) {
    const publishedIds = group.gameIds.filter((gameId) => isAuditPublished(references.get(gameId)));
    if (publishedIds.length > 0 && publishedIds.length < group.gameIds.length) {
      pushAuditConflict(conflicts, { gameId: group.gameIds.join(","), code: "DUPLICATE_ALIAS_PUBLICATION_SPLIT", detail: "同一試合候補の一部 ID だけが公開済みです。" });
    }
    const tableGameIds = {};
    for (const gameId of group.gameIds) {
      for (const table of Object.keys(references.get(gameId)?.tables || {})) {
        if (table === "detected_game_schedule") continue;
        tableGameIds[table] = [...new Set([...(tableGameIds[table] || []), gameId])];
      }
    }
    if (new Set(Object.values(tableGameIds).flat()).size > 1) {
      pushAuditConflict(conflicts, { gameId: group.gameIds.join(","), code: "TABLE_ID_PARTITIONED", detail: "同一試合候補の関連データが複数の game_id に分断されています。", tableGameIds });
    }
  }
  return conflicts;
}

function buildGameIdentityAuditDuplicates(scheduleRows, references) {
  const groups = new Map();
  for (const row of scheduleRows) {
    const identityParts = [row.game_date, normalizeAuditStartAt(row.start_at), normalizeAuditIdentityValue(row.home_team), normalizeAuditIdentityValue(row.away_team)];
    if (identityParts.some((value) => !value)) continue;
    const identity = identityParts.join("|");
    const group = groups.get(identity) || [];
    group.push(row);
    groups.set(identity, group);
  }
  return [...groups.values()]
    .filter((rows) => new Set(rows.map((row) => String(row.game_id || "").trim())).size > 1)
    .map((rows) => {
      const gameIds = [...new Set(rows.map((row) => String(row.game_id || "").trim()).filter(Boolean))].sort();
      return {
        gameDate: rows[0].game_date,
        startAt: normalizeAuditStartAt(rows[0].start_at),
        homeTeam: rows[0].home_team,
        awayTeam: rows[0].away_team,
        gameIds,
        gameCodes: [...new Set(rows.map((row) => String(row.game_code || "").trim()).filter(Boolean))].sort(),
        sourceGameKeys: [...new Set(rows.map((row) => String(row.source_game_key || "").trim()).filter(Boolean))].sort(),
        games: gameIds.map((gameId) => buildAuditGameDetail(gameId, rows.find((row) => row.game_id === gameId), references))
      };
    });
}

export function buildGameIdentityAuditReport({ scheduleRows = [], tableRows = {}, unavailableTables = [], internalRegistry = { available: false, reasonCode: "INTERNAL_GAME_REGISTRY_SCHEMA_NOT_READY" }, options = {} } = {}) {
  const rowsByTable = { detected_game_schedule: scheduleRows, ...tableRows };
  const identifierFormats = { all: createAuditIdentifierCounts(), tables: {} };
  const references = new Map();
  for (const [table, rows] of Object.entries(rowsByTable)) {
    const counts = createAuditIdentifierCounts();
    for (const row of rows || []) {
      const count = Number(row?.row_count || 1);
      const format = classifyGameIdentityFormat(row?.game_id);
      counts[format] += count;
      identifierFormats.all[format] += count;
      addAuditReference(references, table, row);
    }
    identifierFormats.tables[table] = counts;
  }

  const scheduleById = new Map(scheduleRows.map((row) => [String(row.game_id || "").trim(), row]));
  const duplicateCandidates = buildGameIdentityAuditDuplicates(scheduleRows, references);
  const identifierIssues = [];
  const gameCodeToIds = new Map();
  const sourceKeyToIds = new Map();
  for (const row of scheduleRows) {
    const gameId = String(row.game_id || "").trim();
    const gameCode = String(row.game_code || "").trim();
    const sourceKey = String(row.source_game_key || "").trim();
    if (!gameCode) pushAuditConflict(identifierIssues, { gameId, code: "GAME_CODE_EMPTY", detail: "日程レコードに game_code がありません。" });
    else if (!normalizeNpbGameCode(gameCode)) pushAuditConflict(identifierIssues, { gameId, code: "GAME_CODE_INVALID", detail: "game_code が既存のNPBコード形式として利用できません。" });
    const parsed = parsePredictionGameId(gameId);
    if (parsed?.format === "compact" && gameCode && normalizeNpbGameCode(gameCode) !== parsed.gameCode) pushAuditConflict(identifierIssues, { gameId, code: "COMPACT_ID_GAME_CODE_MISMATCH", detail: "compact game_id と game_code が一致しません。" });
    if (gameCode) gameCodeToIds.set(gameCode, [...new Set([...(gameCodeToIds.get(gameCode) || []), gameId])]);
    if (sourceKey) sourceKeyToIds.set(sourceKey, [...new Set([...(sourceKeyToIds.get(sourceKey) || []), gameId])]);
  }
  for (const [gameCode, gameIds] of gameCodeToIds) if (gameIds.length > 1) pushAuditConflict(identifierIssues, { gameId: gameIds.join(","), code: "GAME_CODE_LINKED_TO_MULTIPLE_IDS", detail: `同じ game_code (${gameCode}) が複数の game_id に紐付いています。` });
  for (const [sourceKey, gameIds] of sourceKeyToIds) if (gameIds.length > 1) pushAuditConflict(identifierIssues, { gameId: gameIds.join(","), code: "SOURCE_GAME_KEY_LINKED_TO_MULTIPLE_IDS", detail: `同じ source_game_key (${sourceKey}) が複数の game_id に紐付いています。` });

  const scheduleAvailable = !unavailableTables.includes("detected_game_schedule");
  const orphanIds = scheduleAvailable
    ? [...references.values()].filter((reference) => !scheduleById.has(reference.gameId)).map((reference) => buildAuditGameDetail(reference.gameId, null, reference))
    : [];
  const stateConflicts = buildGameIdentityAuditStateConflicts(references, duplicateCandidates);
  const reasonCodes = new Set();
  if (identifierFormats.all.compact > 0 && identifierFormats.all.descriptive > 0) reasonCodes.add("ID_FORMAT_MIXED");
  if (duplicateCandidates.length) reasonCodes.add("DUPLICATE_SCHEDULE_IDENTITY");
  if (orphanIds.length) reasonCodes.add("ORPHAN_GAME_ID");
  if (identifierIssues.length) reasonCodes.add("IDENTIFIER_MISMATCH");
  if (stateConflicts.some((conflict) => conflict.code === "TABLE_ID_PARTITIONED")) reasonCodes.add("TABLE_ID_PARTITIONED");
  if (unavailableTables.length) reasonCodes.add("AUDIT_TABLE_UNAVAILABLE");
  const identityRisk = ["DUPLICATE_SCHEDULE_IDENTITY", "ORPHAN_GAME_ID", "IDENTIFIER_MISMATCH", "TABLE_ID_PARTITIONED"].some((code) => reasonCodes.has(code));
  const limit = Number(options.limit || GAME_IDENTITY_AUDIT_DEFAULT_LIMIT);
  const details = options.includeDetails ? {
    duplicateCandidates: duplicateCandidates.slice(0, limit),
    orphanIds: orphanIds.slice(0, limit),
    identifierIssues: identifierIssues.slice(0, limit),
    stateConflicts: stateConflicts.slice(0, limit)
  } : undefined;
  return {
    summary: {
      scheduleGames: scheduleRows.length,
      identifierFormats,
      duplicateCandidateGroups: duplicateCandidates.length,
      orphanGameIds: orphanIds.length,
      identifierIssues: identifierIssues.length,
      stateConflicts: stateConflicts.length,
      scannedTables: Object.keys(rowsByTable).sort(),
      unavailableTables: [...new Set(unavailableTables)].sort(),
      readQueryCount: 1 + (unavailableTables.includes("detected_game_schedule") ? 0 : 1) + Object.keys(tableRows).length,
      queryScope: options.allPeriod ? "all" : "last_30_days",
      dateFrom: options.dateFrom || "",
      dateTo: options.dateTo || "",
      limit,
      internalRegistry
    },
    ...(details || {}),
    recommendation: {
      canFreezeCurrentGameId: !identityRisk,
      requiresNewInternalId: identityRisk,
      assessment: identityRisk ? "manual_review_required" : "no_identity_blocker_observed",
      reasonCodes: [...reasonCodes].sort()
    }
  };
}

async function handleAdminGameIdentityAudit(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const options = parseGameIdentityAuditOptions(request);
  if (!options.ok) return jsonResponse({ ok: false, code: options.code, error: "監査対象日が不正です。" }, 400, cors);
  try {
    const auditData = await collectGameIdentityAuditData(env.AUTH_DB, options);
    const report = buildGameIdentityAuditReport({ ...auditData, options });
    const repairSummary = await collectGameIdentityRepairSummary(env.AUTH_DB);
    report.summary.repairableOrphanCount = repairSummary.repairableOrphanCount;
    report.summary.nonGameScopeCount = repairSummary.nonGameScopeCount;
    report.summary.safeCreateInternalGameCount = repairSummary.safeCreateInternalGameCount;
    report.summary.safeAutoLinkCount = repairSummary.safeAutoLinkCount;
    report.summary.manualReviewCount = repairSummary.manualReviewCount;
    report.summary.projectedCoverage = repairSummary.projectedCoverage;
    report.summary.pendingRepairPlanCount = repairSummary.pendingRepairPlanCount;
    report.summary.completedRepairCount = repairSummary.completedRepairCount;
    report.summary.failedRepairCount = repairSummary.failedRepairCount;
    report.summary.stateRepairCandidateCount = repairSummary.stateRepairCandidateCount;
    const response = jsonResponse({ ok: true, ...report }, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("試合識別子監査の読み取りに失敗しました", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ ok: false, code: "GAME_IDENTITY_AUDIT_READ_FAILED", error: "試合識別子監査を取得できませんでした。" }, 500, cors);
  }
}

async function collectGameIdentityRepairSummary(db) {
  try {
    if (!await isGameIdentityRepairSchemaReady(db)) {
      return {
        repairableOrphanCount: 0, nonGameScopeCount: 0, safeCreateInternalGameCount: 0, safeAutoLinkCount: 0,
        manualReviewCount: 0, projectedCoverage: null, pendingRepairPlanCount: 0, completedRepairCount: 0,
        failedRepairCount: 0, stateRepairCandidateCount: 0
      };
    }
    const result = await db.prepare(
      `SELECT status, classification, COUNT(*) AS count
         FROM game_identity_repair_plans GROUP BY status, classification`
    ).bind().all();
    const rows = result.results || [];
    const count = (predicate) => rows.filter(predicate).reduce((sum, row) => sum + Number(row.count || 0), 0);
    return {
      repairableOrphanCount: 0,
      nonGameScopeCount: 0,
      safeCreateInternalGameCount: count((row) => row.classification === "SAFE_CREATE_INTERNAL_GAME"),
      safeAutoLinkCount: count((row) => row.classification === "SAFE_AUTO_LINK"),
      manualReviewCount: count((row) => row.classification === "MANUAL_REVIEW"),
      projectedCoverage: null,
      pendingRepairPlanCount: count((row) => row.status === "pending_review" || row.status === "executing"),
      completedRepairCount: count((row) => row.status === "completed"),
      failedRepairCount: count((row) => row.status === "failed"),
      stateRepairCandidateCount: 0
    };
  } catch (error) {
    if (isPregameSchemaError(error)) return {
      repairableOrphanCount: 0, nonGameScopeCount: 0, safeCreateInternalGameCount: 0, safeAutoLinkCount: 0,
      manualReviewCount: 0, projectedCoverage: null, pendingRepairPlanCount: 0, completedRepairCount: 0,
      failedRepairCount: 0, stateRepairCandidateCount: 0
    };
    throw error;
  }
}

function parseGameIdentityRepairRollbackRoute(path) {
  const match = /^\/api\/admin\/game-identities\/repairs\/([^/]+)\/rollback$/.exec(path);
  return match ? { repairId: decodeURIComponent(match[1]) } : null;
}

function parseGameIdentityRepairAuditRoute(path) {
  const match = /^\/api\/admin\/audit\/game-identity-repairs\/([^/]+)$/.exec(path);
  return match ? { repairId: decodeURIComponent(match[1]) } : null;
}

function isSafeGameIdentityRepairClassification(value) {
  return value === "SAFE_AUTO_LINK" || value === "SAFE_CREATE_INTERNAL_GAME";
}

async function isGameIdentityRepairSchemaReady(db) {
  const result = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_identity_repair_plans'"
  ).bind().first();
  return Boolean(result?.name);
}

async function collectGameIdentityRepairPreviewData(db, options) {
  const auditData = await collectGameIdentityAuditData(db, options);
  const registry = await getGameIdentityRegistryAvailability(db);
  if (!registry.available) {
    const error = new Error("内部試合IDレジストリのmigrationが未適用です。");
    error.code = "INTERNAL_GAME_REGISTRY_SCHEMA_NOT_READY";
    throw error;
  }
  const gameFilter = getGameIdentityAuditFilter(options, "game_date", true);
  const [gamesResult, identifiersResult] = await Promise.all([
    db.prepare(`SELECT internal_game_id, game_date, start_time, home_team, away_team, game_status
                  FROM games ${gameFilter.where}
                 ORDER BY game_date DESC, start_time DESC LIMIT ${GAME_IDENTITY_AUDIT_MAX_SCHEDULE_ROWS}`)
      .bind(...gameFilter.bindings).all(),
    db.prepare(`SELECT identifiers.internal_game_id, identifiers.provider, identifiers.identifier_type, identifiers.identifier_value
                  FROM game_identifiers identifiers
                  JOIN games ON games.internal_game_id = identifiers.internal_game_id
                  ${gameFilter.where.replace(/game_date/g, "games.game_date")}
                 ORDER BY identifiers.id ASC LIMIT ${GAME_IDENTITY_AUDIT_MAX_SCHEDULE_ROWS * 5}`)
      .bind(...gameFilter.bindings).all()
  ]);
  return {
    ...auditData,
    games: gamesResult.results || [],
    identifiers: identifiersResult.results || []
  };
}

async function buildCurrentGameIdentityRepairPreview(db, options) {
  const data = await collectGameIdentityRepairPreviewData(db, options);
  const auditReport = buildGameIdentityAuditReport({ ...data, options: { ...options, includeDetails: true } });
  const preview = await buildGameIdentityRepairPreview({
    scheduleRows: data.scheduleRows,
    games: data.games,
    identifiers: data.identifiers,
    tableRows: data.tableRows,
    stateConflicts: auditReport.stateConflicts || [],
    now: new Date()
  });
  return { data, auditReport, preview };
}

function createDefaultGameIdentityRepairPreviewOptions(now = new Date()) {
  const rangeStart = new Date(now.getTime() - ((GAME_IDENTITY_AUDIT_DEFAULT_RANGE_DAYS - 1) * 24 * 60 * 60 * 1000));
  return {
    ok: true,
    gameId: "",
    includeDetails: true,
    limit: GAME_IDENTITY_AUDIT_MAX_LIMIT,
    allPeriod: false,
    gameDate: "",
    dateFrom: getJstDateString(rangeStart),
    dateTo: getGameIdentityRepairPreviewDateTo(now),
    timestampFrom: rangeStart.toISOString(),
    timestampTo: now.toISOString()
  };
}

// Repair previews must include the same near-term window that registers
// upcoming schedules. This lets the default admin dry-run find legacy rows
// created before the registry link was available, without widening the audit
// to an unbounded period.
export function getGameIdentityRepairPreviewDateTo(now = new Date()) {
  const date = new Date(now.getTime() + (AUTOMATION_SCHEDULE_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000));
  return getJstDateString(date);
}

function getGameIdentityRepairPreviewOptions(options, now = new Date()) {
  if (options.gameDate || options.allPeriod) return options;
  return { ...options, dateTo: getGameIdentityRepairPreviewDateTo(now) };
}

async function handleAdminGameIdentityRepairPreview(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const options = parseGameIdentityAuditOptions(request);
  if (!options.ok) return jsonResponse({ ok: false, code: options.code, error: "監査対象日が不正です。" }, 400, cors);
  try {
    const previewOptions = getGameIdentityRepairPreviewOptions(options);
    const { preview } = await buildCurrentGameIdentityRepairPreview(env.AUTH_DB, previewOptions);
    const response = jsonResponse({ ok: true, dryRun: true, ...preview }, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonResponse({
      ok: false,
      code: error?.code || "GAME_IDENTITY_REPAIR_PREVIEW_FAILED",
      error: "試合ID修復計画を生成できませんでした。"
    }, isPregameSchemaError(error) ? 503 : 500, cors);
  }
}

function normalizeRepairRequest(input) {
  const repairIds = [...new Set((Array.isArray(input?.repairIds) ? input.repairIds : []).map((value) => String(value || "").trim()).filter(Boolean))];
  const expectedPlanHashes = input?.expectedPlanHashes && typeof input.expectedPlanHashes === "object" ? input.expectedPlanHashes : {};
  return { repairIds, expectedPlanHashes, dryRun: input?.dryRun === true };
}

async function loadSingleRepairPlan(db, repairId) {
  const options = createDefaultGameIdentityRepairPreviewOptions();
  const { preview } = await buildCurrentGameIdentityRepairPreview(db, options);
  return preview.repairPlans.find((plan) => plan.repairId === repairId) || null;
}

async function getExistingRepairRecord(db, repairId) {
  return await db.prepare(
    `SELECT repair_id, status, classification, plan_json, plan_hash, rollback_json, target_internal_game_id, create_internal_game,
            generated_at, executed_at, completed_at, error_code, error_message
       FROM game_identity_repair_plans WHERE repair_id = ?1 LIMIT 1`
  ).bind(repairId).first();
}

function createGameIdentityRepairError(code, message, stage, details = null) {
  const error = new Error(message);
  error.code = code;
  error.repairStage = stage;
  if (details && typeof details === "object") Object.assign(error, details);
  return error;
}

async function runGameIdentityRepairStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (!error?.repairStage) error.repairStage = stage;
    throw error;
  }
}

function parseStoredRepairPlan(record) {
  try {
    const plan = JSON.parse(String(record?.plan_json || ""));
    return plan && typeof plan === "object" ? plan : null;
  } catch {
    return null;
  }
}

function parseRepairRollbackData(record) {
  try {
    const data = JSON.parse(String(record?.rollback_json || ""));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function isGameIdentityRepairConflict(error) {
  const code = String(error?.code || "");
  return code === "GAME_IDENTITY_REPAIR_ALREADY_EXECUTED" || code === "GAME_IDENTITY_REPAIR_INTERRUPTED"
    || code === "GAME_IDENTITY_REPAIR_PLAN_NOT_FOUND" || code === "GAME_IDENTITY_REPAIR_PLAN_HASH_MISMATCH"
    || code === "GAME_IDENTITY_REPAIR_SCHEDULE_CHANGED" || code === "GAME_IDENTITY_REPAIR_TARGET_NOT_FOUND"
    || code === "GAME_IDENTITY_REPAIR_UPDATE_COUNT_MISMATCH" || code === "GAME_IDENTIFIER_CONFLICT"
    || code === "GAME_IDENTITY_REPAIR_MANUAL_REVIEW_REQUIRED";
}

function createRepairFailureMetadata({ repairId, stage, errorCode, targetInternalGameId = "", now = new Date() }) {
  return {
    repairId,
    targetInternalGameId: targetInternalGameId || null,
    failure: {
      stage,
      errorCode,
      occurredAt: now.toISOString()
    }
  };
}

function normalizePlanHash(value) {
  const hash = String(value || "").trim();
  return hash || null;
}

export function canResumeFailedGameIdentityRepair({ status, partialWriteDetected, expectedPlanHash, currentPlanHash, canonicalStoredPlanHash }) {
  return status === "failed" && partialWriteDetected !== true
    && Boolean(expectedPlanHash)
    && expectedPlanHash === currentPlanHash
    && currentPlanHash === canonicalStoredPlanHash;
}

function createPlanHashMismatchError({ expectedPlanHash, currentPlanHash, storedPlanHash, mismatchReason, stage = "plan_read" }) {
  return createGameIdentityRepairError(
    "GAME_IDENTITY_REPAIR_PLAN_HASH_MISMATCH",
    "修復計画が更新されています。再度dry-runを確認してください。",
    stage,
    {
      repairHashComparison: {
        expectedPlanHash: normalizePlanHash(expectedPlanHash),
        currentPlanHash: normalizePlanHash(currentPlanHash),
        storedPlanHash: normalizePlanHash(storedPlanHash),
        mismatchReason
      }
    }
  );
}

function repairHashComparisonResponse(error) {
  return error?.repairHashComparison && typeof error.repairHashComparison === "object"
    ? error.repairHashComparison
    : {};
}

async function saveRepairPlanRecord(db, { plan, status, adminId, targetInternalGameId = null, rollbackData = null, errorCode = null, errorMessage = null, now = new Date() }) {
  const timestamp = now.toISOString();
  await db.prepare(
    `INSERT INTO game_identity_repair_plans
       (repair_id, status, classification, target_internal_game_id, create_internal_game, plan_json, plan_hash, generated_at,
        reviewed_at, reviewed_by, executed_at, completed_at, error_code, error_message, rollback_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT(repair_id) DO UPDATE SET
       status = excluded.status, target_internal_game_id = COALESCE(excluded.target_internal_game_id, game_identity_repair_plans.target_internal_game_id),
       plan_json = excluded.plan_json, plan_hash = excluded.plan_hash, reviewed_at = excluded.reviewed_at,
       reviewed_by = excluded.reviewed_by, executed_at = excluded.executed_at, completed_at = excluded.completed_at,
       error_code = excluded.error_code, error_message = excluded.error_message, rollback_json = excluded.rollback_json`
  ).bind(
    plan.repairId, status, plan.classification, targetInternalGameId, plan.createInternalGame ? 1 : 0,
    JSON.stringify(plan), plan.planHash, plan.generatedAt, timestamp, adminId || null,
    status === "executing" ? timestamp : null, status === "completed" ? timestamp : null,
    errorCode, errorMessage, rollbackData ? JSON.stringify(rollbackData) : null
  ).run();
}

async function assertRepairPlanIdentifiersAvailable(db, plan, targetInternalGameId) {
  for (const identifier of plan.identifiersToInsert || []) {
    const existing = await db.prepare(
      "SELECT internal_game_id FROM game_identifiers WHERE provider = ?1 AND identifier_type = ?2 AND identifier_value = ?3 LIMIT 1"
    ).bind(identifier.provider, identifier.identifierType, identifier.identifierValue).first();
    if (existing && String(existing.internal_game_id) !== targetInternalGameId) {
      const error = new Error("試合識別子が別の内部試合IDに紐付いています。");
      error.code = "GAME_IDENTIFIER_CONFLICT";
      throw error;
    }
  }
}

export async function applyGameIdentityRepairPlan(db, plan, adminId, { targetInternalGameId: requestedTargetInternalGameId = "", now = new Date() } = {}) {
  if (!isSafeGameIdentityRepairClassification(plan.classification)) {
    const error = new Error("手動確認が必要な修復計画は自動実行できません。");
    error.code = "GAME_IDENTITY_REPAIR_MANUAL_REVIEW_REQUIRED";
    throw error;
  }
  const schedule = await runGameIdentityRepairStage("schedule_read", () => db.prepare(
    `SELECT game_id, internal_game_id, game_date, start_at, home_team, away_team, game_code, source_game_key, game_status
       FROM detected_game_schedule WHERE game_id = ?1 LIMIT 2`
  ).bind(plan.scheduleGameId).all());
  if ((schedule.results || []).length !== 1) {
    throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_SCHEDULE_CHANGED", "対象日程が存在しません。", "schedule_read");
  }
  const scheduleRow = schedule.results[0];
  let targetInternalGameId = requestedTargetInternalGameId || plan.targetInternalGameId;
  let createdInternalGame = false;
  if (plan.createInternalGame) {
    if (!targetInternalGameId) throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_TARGET_MISSING", "作成する内部試合IDがありません。", "game_create");
    const existingGame = await runGameIdentityRepairStage("game_create", () => db.prepare(
      "SELECT internal_game_id, game_date, start_time, home_team, away_team FROM games WHERE internal_game_id = ?1 LIMIT 1"
    ).bind(targetInternalGameId).first());
    if (existingGame) {
      const sameIdentity = String(existingGame.game_date) === String(scheduleRow.game_date)
        && String(existingGame.start_time) === new Date(scheduleRow.start_at).toISOString()
        && String(existingGame.home_team).toLowerCase() === String(scheduleRow.home_team).toLowerCase()
        && String(existingGame.away_team).toLowerCase() === String(scheduleRow.away_team).toLowerCase();
      if (!sameIdentity) throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_TARGET_CONFLICT", "内部試合IDが別試合に使用されています。", "game_create");
    } else {
      await runGameIdentityRepairStage("game_create", () => db.prepare(
        `INSERT INTO games (internal_game_id, game_date, start_time, home_team, away_team, game_status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`
      ).bind(targetInternalGameId, scheduleRow.game_date, new Date(scheduleRow.start_at).toISOString(), String(scheduleRow.home_team).toLowerCase(), String(scheduleRow.away_team).toLowerCase(), scheduleRow.game_status || "scheduled", now.toISOString()).run());
      createdInternalGame = true;
    }
  } else {
    const game = await runGameIdentityRepairStage("game_read", () => db.prepare("SELECT internal_game_id FROM games WHERE internal_game_id = ?1 LIMIT 1").bind(targetInternalGameId).first());
    if (!game) {
      throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_TARGET_NOT_FOUND", "修復先の内部試合IDが存在しません。", "game_read");
    }
  }
  const currentScheduleInternalGameId = String(scheduleRow.internal_game_id || "");
  if (currentScheduleInternalGameId && currentScheduleInternalGameId !== targetInternalGameId) {
    throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_SCHEDULE_CHANGED", "対象日程が別の内部試合IDに変更されています。", "schedule_read");
  }
  await runGameIdentityRepairStage("identifier_validate", () => assertRepairPlanIdentifiersAvailable(db, plan, targetInternalGameId));
  const addedIdentifiers = [];
  for (const identifier of plan.identifiersToInsert || []) {
    const outcome = await runGameIdentityRepairStage("identifier_register", () => registerGameIdentifier(db, targetInternalGameId, identifier, now));
    if (outcome.registered) addedIdentifiers.push(identifier);
  }
  let scheduleLinked = false;
  if (!currentScheduleInternalGameId) {
    const scheduleUpdate = await runGameIdentityRepairStage("schedule_link", () => db.prepare(
      "UPDATE detected_game_schedule SET internal_game_id = ?1, updated_at = ?2 WHERE game_id = ?3 AND (internal_game_id IS NULL OR internal_game_id = '')"
    ).bind(targetInternalGameId, now.toISOString(), plan.scheduleGameId).run());
    if (Number(scheduleUpdate?.meta?.changes || 0) !== 1) {
      throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_UPDATE_COUNT_MISMATCH", "日程の更新件数が修復計画と一致しません。", "schedule_link");
    }
    scheduleLinked = true;
  }
  const linkedRows = [];
  for (const row of plan.tableRowsToUpdate || []) {
    if (!REPAIRABLE_TABLES.includes(row.table)) continue;
    const result = await runGameIdentityRepairStage("legacy_row_link", () => db.prepare(
      `UPDATE ${row.table} SET internal_game_id = ?1 WHERE game_id = ?2 AND (internal_game_id IS NULL OR internal_game_id = '')`
    ).bind(targetInternalGameId, row.legacyGameId).run());
    const changes = Number(result?.meta?.changes || 0);
    if (changes !== Number(row.expectedCount || 0)) {
      throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_UPDATE_COUNT_MISMATCH", `${row.table} の更新件数が修復計画と一致しません。`, "legacy_row_link");
    }
    linkedRows.push({ table: row.table, legacyGameId: row.legacyGameId, count: changes });
  }
  const rollbackData = {
    targetInternalGameId,
    scheduleGameId: plan.scheduleGameId,
    scheduleLinked,
    createdInternalGame,
    addedIdentifiers,
    linkedRows,
    workflowStateCorrection: null
  };
  await runGameIdentityRepairStage("history_complete", () => saveRepairPlanRecord(db, { plan, status: "completed", adminId, targetInternalGameId, rollbackData, now }));
  return { repairId: plan.repairId, status: "completed", targetInternalGameId, rollbackData };
}

export async function collectGameIdentityRepairExecutionState(db, record) {
  const plan = parseStoredRepairPlan(record);
  if (!plan) throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_RECORD_INVALID", "保存済みの修復計画を読み取れません。", "history_read");
  const targetInternalGameId = String(record?.target_internal_game_id || plan.targetInternalGameId || "");
  const [schedule, targetGame] = await Promise.all([
    db.prepare("SELECT game_id, internal_game_id FROM detected_game_schedule WHERE game_id = ?1 LIMIT 1").bind(plan.scheduleGameId).first(),
    targetInternalGameId
      ? db.prepare("SELECT internal_game_id FROM games WHERE internal_game_id = ?1 LIMIT 1").bind(targetInternalGameId).first()
      : Promise.resolve(null)
  ]);
  const identifiers = [];
  for (const identifier of plan.identifiersToInsert || []) {
    const row = await db.prepare(
      "SELECT internal_game_id FROM game_identifiers WHERE provider = ?1 AND identifier_type = ?2 AND identifier_value = ?3 LIMIT 1"
    ).bind(identifier.provider, identifier.identifierType, identifier.identifierValue).first();
    identifiers.push({
      provider: identifier.provider,
      identifierType: identifier.identifierType,
      identifierValue: identifier.identifierValue,
      state: !row ? "missing" : String(row.internal_game_id) === targetInternalGameId ? "linked_to_target" : "linked_to_other"
    });
  }
  const tableRows = [];
  for (const row of plan.tableRowsToUpdate || []) {
    if (!REPAIRABLE_TABLES.includes(row.table)) continue;
    const result = await db.prepare(
      `SELECT COUNT(*) AS row_count,
              SUM(CASE WHEN internal_game_id = ?1 THEN 1 ELSE 0 END) AS linked_to_target_count,
              SUM(CASE WHEN internal_game_id IS NULL OR internal_game_id = '' THEN 1 ELSE 0 END) AS unlinked_count
         FROM ${row.table} WHERE game_id = ?2`
    ).bind(targetInternalGameId, row.legacyGameId).first();
    tableRows.push({
      table: row.table,
      legacyGameId: row.legacyGameId,
      expectedCount: Number(row.expectedCount || 0),
      rowCount: Number(result?.row_count || 0),
      linkedToTargetCount: Number(result?.linked_to_target_count || 0),
      unlinkedCount: Number(result?.unlinked_count || 0)
    });
  }
  const rollbackData = parseRepairRollbackData(record);
  const rollbackRecordedChanges = Boolean(
    rollbackData.createdInternalGame === true || rollbackData.scheduleLinked === true
    || (Array.isArray(rollbackData.addedIdentifiers) && rollbackData.addedIdentifiers.length)
    || (Array.isArray(rollbackData.linkedRows) && rollbackData.linkedRows.some((row) => Number(row?.count || 0) > 0))
  );
  const hasTargetInternalGameId = Boolean(targetInternalGameId);
  const partialWriteDetected = Boolean(
    targetGame || (hasTargetInternalGameId && schedule && String(schedule.internal_game_id || "") === targetInternalGameId)
    || identifiers.some((item) => item.state === "linked_to_target")
    || tableRows.some((item) => item.linkedToTargetCount > 0)
    || rollbackRecordedChanges
  );
  return {
    repairId: record.repair_id,
    status: record.status,
    classification: record.classification,
    planHash: record.plan_hash,
    targetInternalGameId: targetInternalGameId || null,
    errorCode: record.error_code || null,
    failure: parseRepairRollbackData(record).failure || null,
    plan: {
      scheduleGameId: plan.scheduleGameId,
      createInternalGame: Boolean(plan.createInternalGame),
      legacyGameIds: plan.legacyGameIds || [],
      tableRowsToUpdate: (plan.tableRowsToUpdate || []).map((item) => ({ table: item.table, legacyGameId: item.legacyGameId, expectedCount: Number(item.expectedCount || 0) }))
    },
    observed: {
      targetGameExists: Boolean(targetGame),
      scheduleInternalGameId: schedule?.internal_game_id || null,
      identifiers,
      tableRows,
      rollbackRecordedChanges,
      partialWriteDetected
    }
  };
}

async function handleAdminGameIdentityRepairExecutionAudit(request, env, cors, repairId) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  try {
    if (!await isGameIdentityRepairSchemaReady(env.AUTH_DB)) {
      return jsonResponse({ ok: false, code: "GAME_IDENTITY_REPAIR_SCHEMA_NOT_READY", error: "修復履歴のmigrationが未適用です。" }, 503, cors);
    }
    const record = await getExistingRepairRecord(env.AUTH_DB, repairId);
    if (!record) return jsonResponse({ ok: false, code: "GAME_IDENTITY_REPAIR_RECORD_NOT_FOUND", error: "修復履歴が見つかりません。" }, 404, cors);
    return jsonResponse({ ok: true, readOnly: true, repair: await collectGameIdentityRepairExecutionState(env.AUTH_DB, record) }, 200, cors);
  } catch (error) {
    console.error("試合ID修復監査に失敗しました", { repairId, stage: error?.repairStage || "audit", errorCode: error?.code || "GAME_IDENTITY_REPAIR_AUDIT_FAILED" });
    return jsonResponse({ ok: false, repairId, stage: error?.repairStage || "audit", code: error?.code || "GAME_IDENTITY_REPAIR_AUDIT_FAILED", error: "修復状態を確認できませんでした。" }, 500, cors);
  }
}

async function handleAdminGameIdentityRepairs(request, env, cors) {
  let repairId = "";
  let stage = "request";
  try {
    const access = await requireAdminUser(request, env, cors);
    if (!access.ok) return access.response;
    const input = normalizeRepairRequest(await readJson(request));
    if (input.dryRun || !input.repairIds.length || input.repairIds.length > 20) {
      return jsonResponse({ ok: false, code: "GAME_IDENTITY_REPAIR_REQUEST_INVALID", error: "修復IDを1件以上20件以下で指定してください。" }, 400, cors);
    }
    if (!await isGameIdentityRepairSchemaReady(env.AUTH_DB)) {
      return jsonResponse({ ok: false, code: "GAME_IDENTITY_REPAIR_SCHEMA_NOT_READY", error: "修復履歴のmigrationが未適用です。" }, 503, cors);
    }
    const results = [];
    for (const requestedRepairId of input.repairIds) {
      repairId = requestedRepairId;
      stage = "plan_read";
      let plan = null;
      let targetInternalGameId = "";
      try {
        const existing = await getExistingRepairRecord(env.AUTH_DB, repairId);
        if (existing) {
          plan = parseStoredRepairPlan(existing);
          if (!plan) throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_RECORD_INVALID", "保存済みの修復計画を読み取れません。", "history_read");
          const expectedPlanHash = normalizePlanHash(input.expectedPlanHashes[repairId]);
          const storedPlanHash = normalizePlanHash(existing.plan_hash);
          const state = await collectGameIdentityRepairExecutionState(env.AUTH_DB, existing);
          const currentPlan = await loadSingleRepairPlan(env.AUTH_DB, repairId);
          const currentPlanHash = normalizePlanHash(currentPlan?.planHash);
          const canonicalStoredPlanHash = normalizePlanHash(await hashGameIdentityRepairPlan(plan));
          const canResumeFailedWithoutPartialWrite = canResumeFailedGameIdentityRepair({
            status: existing.status,
            partialWriteDetected: state.observed.partialWriteDetected,
            expectedPlanHash,
            currentPlanHash,
            canonicalStoredPlanHash
          });
          if (existing.status === "failed" && !state.observed.partialWriteDetected && !currentPlanHash) {
            throw createPlanHashMismatchError({
              expectedPlanHash,
              currentPlanHash,
              storedPlanHash,
              mismatchReason: "CURRENT_PLAN_NOT_FOUND"
            });
          }
          if (existing.status === "failed" && !state.observed.partialWriteDetected && currentPlanHash !== canonicalStoredPlanHash) {
            throw createPlanHashMismatchError({
              expectedPlanHash,
              currentPlanHash,
              storedPlanHash,
              mismatchReason: "STORED_PLAN_DIFFERS_FROM_CURRENT_PLAN"
            });
          }
          if (!canResumeFailedWithoutPartialWrite && expectedPlanHash !== storedPlanHash) {
            throw createPlanHashMismatchError({
              expectedPlanHash,
              currentPlanHash,
              storedPlanHash,
              mismatchReason: "EXPECTED_HASH_DIFFERS_FROM_STORED_PLAN"
            });
          }
          if (existing.status === "executing") {
            stage = "interrupted_execution";
            targetInternalGameId = String(existing.target_internal_game_id || "");
            await saveRepairPlanRecord(env.AUTH_DB, {
              plan,
              status: "failed",
              adminId: access.user.id,
              targetInternalGameId,
              errorCode: "GAME_IDENTITY_REPAIR_INTERRUPTED",
              errorMessage: "前回の修復実行が完了応答なしで終了しました。状態監査を確認してください。",
              rollbackData: { ...parseRepairRollbackData(existing), ...createRepairFailureMetadata({ repairId, stage, errorCode: "GAME_IDENTITY_REPAIR_INTERRUPTED", targetInternalGameId }), observed: state.observed }
            });
            throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_INTERRUPTED", "前回の修復実行が中断されています。状態監査を確認してください。", stage);
          }
          if (existing.status === "failed") {
            if (!state.observed.partialWriteDetected && currentPlan) plan = currentPlan;
            targetInternalGameId = String(existing.target_internal_game_id || plan.targetInternalGameId || "");
            if (!targetInternalGameId && plan.createInternalGame && !state.observed.partialWriteDetected) {
              targetInternalGameId = crypto.randomUUID();
            }
            if (!targetInternalGameId) {
              throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_TARGET_MISSING", "再実行する内部試合IDを確認できません。状態監査を確認してください。", "history_read");
            }
            stage = "history_resume";
            await saveRepairPlanRecord(env.AUTH_DB, {
              plan,
              status: "executing",
              adminId: access.user.id,
              targetInternalGameId,
              rollbackData: { ...parseRepairRollbackData(existing), resumedAt: new Date().toISOString() }
            });
            stage = "apply";
            results.push(await applyGameIdentityRepairPlan(env.AUTH_DB, plan, access.user.id, { targetInternalGameId }));
            continue;
          }
          throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_ALREADY_EXECUTED", "この修復計画はすでに実行済みまたは失敗状態です。状態監査を確認してください。", "history_read");
        }
        plan = await loadSingleRepairPlan(env.AUTH_DB, repairId);
        if (!plan) throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_PLAN_NOT_FOUND", "修復計画が見つかりません。", stage);
        const expectedPlanHash = normalizePlanHash(input.expectedPlanHashes[repairId]);
        const currentPlanHash = normalizePlanHash(plan.planHash);
        if (expectedPlanHash !== currentPlanHash) {
          throw createPlanHashMismatchError({
            expectedPlanHash,
            currentPlanHash,
            storedPlanHash: null,
            mismatchReason: "EXPECTED_HASH_DIFFERS_FROM_CURRENT_PLAN",
            stage
          });
        }
        targetInternalGameId = plan.createInternalGame ? crypto.randomUUID() : plan.targetInternalGameId;
        if (!targetInternalGameId) throw createGameIdentityRepairError("GAME_IDENTITY_REPAIR_TARGET_MISSING", "修復先の内部試合IDを決定できません。", stage);
        stage = "history_executing";
        await saveRepairPlanRecord(env.AUTH_DB, { plan, status: "executing", adminId: access.user.id, targetInternalGameId });
        stage = "apply";
        const result = await applyGameIdentityRepairPlan(env.AUTH_DB, plan, access.user.id, { targetInternalGameId });
        results.push(result);
      } catch (error) {
        const errorCode = error?.code || "GAME_IDENTITY_REPAIR_FAILED";
        const errorStage = error?.repairStage || stage;
        const hashComparison = repairHashComparisonResponse(error);
        if (plan && errorCode !== "GAME_IDENTITY_REPAIR_ALREADY_EXECUTED" && errorCode !== "GAME_IDENTITY_REPAIR_INTERRUPTED") {
          try {
            await saveRepairPlanRecord(env.AUTH_DB, {
              plan,
              status: "failed",
              adminId: access.user.id,
              targetInternalGameId,
              errorCode,
              errorMessage: "試合ID修復処理が失敗しました。",
              rollbackData: createRepairFailureMetadata({ repairId, stage: errorStage, errorCode, targetInternalGameId })
            });
          } catch (recordError) {
            console.error("試合ID修復の失敗履歴を保存できませんでした", { repairId, stage: "history_failed", errorCode: recordError?.code || "GAME_IDENTITY_REPAIR_HISTORY_WRITE_FAILED" });
          }
        }
        console.error("試合ID修復に失敗しました", { repairId, stage: errorStage, errorCode });
        return jsonResponse({ ok: false, repairId, stage: errorStage, code: errorCode, error: "試合ID修復に失敗しました。状態監査を確認してください。", ...hashComparison }, isGameIdentityRepairConflict(error) ? 409 : 500, cors);
      }
    }
    return jsonResponse({ ok: true, results }, 200, cors);
  } catch (error) {
    const errorCode = error?.code || "GAME_IDENTITY_REPAIR_UNEXPECTED_ERROR";
    console.error("試合ID修復APIの予期しない失敗", { repairId: repairId || null, stage, errorCode });
    return jsonResponse({ ok: false, repairId: repairId || null, stage, code: errorCode, error: "試合ID修復APIの処理に失敗しました。" }, 500, cors);
  }
}

async function handleAdminGameIdentityRepairRollback(request, env, cors, repairId) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const input = await readJson(request);
  if (!await isGameIdentityRepairSchemaReady(env.AUTH_DB)) {
    return jsonResponse({ ok: false, code: "GAME_IDENTITY_REPAIR_SCHEMA_NOT_READY", error: "修復履歴のmigrationが未適用です。" }, 503, cors);
  }
  const record = await getExistingRepairRecord(env.AUTH_DB, repairId);
  if (!record || record.status !== "completed" || String(input?.expectedPlanHash || "") !== String(record.plan_hash || "")) {
    return jsonResponse({ ok: false, code: "GAME_IDENTITY_REPAIR_ROLLBACK_NOT_ALLOWED", error: "修復計画またはplan hashを確認できません。" }, 409, cors);
  }
  const rollback = parseJsonObject(record.rollback_json);
  try {
    for (const row of rollback.linkedRows || []) {
      if (!REPAIRABLE_TABLES.includes(row.table)) continue;
      await env.AUTH_DB.prepare(`UPDATE ${row.table} SET internal_game_id = NULL WHERE game_id = ?1 AND internal_game_id = ?2`)
        .bind(row.legacyGameId, rollback.targetInternalGameId).run();
    }
    if (rollback.scheduleLinked) {
      await env.AUTH_DB.prepare("UPDATE detected_game_schedule SET internal_game_id = NULL WHERE game_id = ?1 AND internal_game_id = ?2")
        .bind(rollback.scheduleGameId, rollback.targetInternalGameId).run();
    }
    for (const identifier of rollback.addedIdentifiers || []) {
      await env.AUTH_DB.prepare(
        "DELETE FROM game_identifiers WHERE internal_game_id = ?1 AND provider = ?2 AND identifier_type = ?3 AND identifier_value = ?4"
      ).bind(rollback.targetInternalGameId, identifier.provider, identifier.identifierType, identifier.identifierValue).run();
    }
    if (rollback.createdInternalGame) {
      await env.AUTH_DB.prepare("DELETE FROM games WHERE internal_game_id = ?1 AND NOT EXISTS (SELECT 1 FROM game_identifiers WHERE internal_game_id = ?1)")
        .bind(rollback.targetInternalGameId).run();
    }
    await env.AUTH_DB.prepare(
      "UPDATE game_identity_repair_plans SET status = 'rolled_back', reviewed_at = ?1, reviewed_by = ?2 WHERE repair_id = ?3 AND status = 'completed'"
    ).bind(new Date().toISOString(), access.user.id, repairId).run();
    return jsonResponse({ ok: true, repairId, status: "rolled_back" }, 200, cors);
  } catch (error) {
    return jsonResponse({ ok: false, code: error?.code || "GAME_IDENTITY_REPAIR_ROLLBACK_FAILED", error: "修復のロールバックに失敗しました。" }, 500, cors);
  }
}

function parseHistoricalGameWorkflowAuditRoute(path) {
  const prefix = "/api/admin/audit/game-workflows/";
  if (!String(path || "").startsWith(prefix)) return null;
  const rawInternalGameId = String(path).slice(prefix.length);
  try {
    return { internalGameId: decodeURIComponent(rawInternalGameId) };
  } catch {
    return { internalGameId: rawInternalGameId };
  }
}

function sanitizeHistoricalWorkflowErrorDetail(value) {
  const detail = String(value || "").trim();
  if (!detail) return null;
  if (/[\"'](?:token|cookie|authorization|password|secret)[\"']?\s*:/i.test(detail)) return "機密情報を含む可能性があるため詳細を省略しました。";
  return detail.slice(0, 500);
}

function mapHistoricalWorkflowJobRow(row, now = new Date()) {
  const metadata = parseSafeWorkflowJobMetadata(row?.result_metadata);
  const validation = sanitizeLineupValidationDetails({
    ...metadata.validation,
    parseStage: metadata.parseStage || metadata.validation?.parseStage,
    sourceUrlHost: metadata.sourceUrlHost || metadata.validation?.sourceUrlHost,
    httpStatus: metadata.httpStatus || metadata.validation?.httpStatus,
    retryable: typeof metadata.retryable === "boolean" ? metadata.retryable : metadata.validation?.retryable
  });
  const job = {
    id: Number.isFinite(Number(row?.id)) ? Number(row.id) : null,
    jobType: String(row?.job_type || ""),
    status: String(row?.status || "unknown"),
    source: String(row?.source || "system"),
    scheduledAt: row?.scheduled_slot_at || null,
    nextAttemptAt: row?.next_attempt_at || null,
    attemptCount: Number(row?.attempt_count || 0),
    maxAttempts: Number(row?.max_attempts || 0),
    errorCode: row?.error_code || null,
    errorDetail: sanitizeHistoricalWorkflowErrorDetail(row?.error_detail),
    claimedAt: row?.claimed_at || null,
    leaseExpiresAt: row?.lease_expires_at || null,
    startedAt: row?.started_at || null,
    completedAt: row?.completed_at || null,
    updatedAt: row?.updated_at || null,
    validation,
    targetResolution: metadata.targetResolution || null,
    recoveryMode: metadata.recoveryMode || null,
    recoveryReasonCode: metadata.recoveryReasonCode || null,
    recoveredAt: metadata.recoveredAt || null,
    previousErrorCode: metadata.previousErrorCode || null,
    attemptCountBeforeRecovery: Number.isFinite(metadata.attemptCountBeforeRecovery) ? metadata.attemptCountBeforeRecovery : null,
    attemptCountChanged: typeof metadata.attemptCountChanged === "boolean" ? metadata.attemptCountChanged : null,
    workflowTerminalOverrideApplied: metadata.workflowTerminalOverrideApplied === true,
    parseStage: metadata.parseStage || null,
    httpStatus: metadata.httpStatus || null,
    sourceUrlHost: metadata.sourceUrlHost || null,
    claimedJobId: metadata.claimedJobId || null,
    claimedJobType: metadata.claimedJobType || null,
    resolvedNpbGameCode: metadata.resolvedNpbGameCode || null,
    lineupSourceUrl: metadata.lineupSourceUrl || null,
    lineupHttpStatus: metadata.lineupHttpStatus || null,
    lineupParseStage: metadata.lineupParseStage || null,
    lineupDataClassification: metadata.lineupDataClassification || null,
    dataNotAnnouncedReason: metadata.dataNotAnnouncedReason || null,
    rosterResolutionStage: metadata.rosterResolutionStage || null,
    rosterResolvedBy: metadata.rosterResolvedBy || null,
    rosterStartAtFound: typeof metadata.rosterStartAtFound === "boolean" ? metadata.rosterStartAtFound : null,
    retryable: typeof metadata.retryable === "boolean" ? metadata.retryable : String(row?.status || "") === "retry_wait"
  };
  const health = getWorkflowJobHealth(job, now);
  const nextAt = job.nextAttemptAt || job.scheduledAt;
  const nextDate = nextAt ? new Date(nextAt) : null;
  return {
    ...job,
    overdue: ["pending", "retry_wait"].includes(job.status)
      && (!nextDate || Number.isNaN(nextDate.getTime()) || nextDate.getTime() <= now.getTime()),
    health
  };
}

export function summarizeHistoricalWorkflowJobs(jobs = [], workflowStatus = "", now = new Date(), lineupRows = []) {
  const current = now instanceof Date ? now : new Date(now);
  const normalizedJobs = (Array.isArray(jobs) ? jobs : [])
    .map((job) => job?.jobType ? job : mapHistoricalWorkflowJobRow(job, current))
    .sort((left, right) => String(right.updatedAt || right.startedAt || right.scheduledAt || "").localeCompare(String(left.updatedAt || left.startedAt || left.scheduledAt || "")));
  const activeRetryJobs = normalizedJobs.filter((job) => job.status === "retry_wait");
  const warnings = [];
  if (workflowStatus === "retrying" && activeRetryJobs.length === 0) {
    warnings.push("WORKFLOW_RETRYING_WITHOUT_ACTIVE_RETRY_JOB");
    if (normalizedJobs.some((job) => ["cancelled", "permanently_failed", "succeeded"].includes(job.status))) {
      warnings.push("HISTORICAL_JOB_STATE_MISMATCH");
    }
  }
  const errors = normalizedJobs
    .filter((job) => job.health?.level === "error")
    .map((job) => `${job.jobType}:${job.health.reasonCode}`);
  const byType = (jobType) => normalizedJobs.find((job) => job.jobType === jobType && job.status !== "cancelled")
    || normalizedJobs.find((job) => job.jobType === jobType)
    || null;
  const provisional = byType("provisional_lineup_fetch");
  const final = byType("final_lineup_fetch");
  const latest = normalizedJobs.find((job) => ["provisional_lineup_fetch", "final_lineup_fetch"].includes(job.jobType)) || null;
  const latestValidation = latest?.validation || null;
  const lineupCaptured = Array.isArray(lineupRows) && lineupRows.length > 0;
  const finalSucceeded = final?.status === "succeeded";
  const scoringRow = (Array.isArray(lineupRows) ? lineupRows : []).find((row) => row?.scoring_status === "scored") || null;
  let scoringEligibility;
  if (workflowStatus === "service_unavailable") {
    scoringEligibility = { eligible: false, status: "service_unavailable", reasonCode: "SERVICE_UNAVAILABLE" };
  } else if (scoringRow || finalSucceeded) {
    scoringEligibility = { eligible: true, status: scoringRow ? "scored" : "ready", reasonCode: scoringRow ? "LINEUP_SCORED" : "FINAL_LINEUP_JOB_SUCCEEDED" };
  } else {
    scoringEligibility = { eligible: false, status: errors.length ? "blocked" : "waiting", reasonCode: final?.errorCode || "FINAL_LINEUP_REQUIRED" };
  }
  const latestHealth = latest ? getWorkflowJobHealth(latest, current) : null;
  return {
    jobs: normalizedJobs,
    lineupJobs: normalizedJobs.filter((job) => ["provisional_lineup_fetch", "final_lineup_fetch"].includes(job.jobType)),
    lineupFetchStatus: { provisional, final },
    lineupFetchState: finalSucceeded ? "completed" : (latestHealth?.status || "not_started"),
    lastFetchAttempt: latest ? {
      jobType: latest.jobType,
      status: latest.status,
      attemptCount: latest.attemptCount,
      maxAttempts: latest.maxAttempts,
      startedAt: latest.startedAt || null,
      updatedAt: latest.updatedAt || null,
      nextAttemptAt: latest.nextAttemptAt || null,
      errorCode: latest.errorCode || null,
      errorDetail: latest.errorDetail || null,
      validation: latestValidation,
      health: latestHealth
    } : null,
    validation: latestValidation,
    scoringEligibility,
    activeRetryJobs,
    warnings: [...new Set(warnings)],
    errors: [...new Set(errors)],
    lineupCaptured
  };
}

function normalizeAuditTeam(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s　]+/g, " ");
}

export function auditGameHomeAwayConsistency({ game = null, scheduleRows = [] } = {}) {
  const observations = [];
  if (game?.homeTeam && game?.awayTeam) {
    observations.push({ source: "games", homeTeam: String(game.homeTeam), awayTeam: String(game.awayTeam), startAt: game.startAt || null });
  }
  for (const row of Array.isArray(scheduleRows) ? scheduleRows : []) {
    if (!row?.home_team || !row?.away_team) continue;
    observations.push({ source: "detected_game_schedule", gameId: row.game_id || null, sourceGameKey: row.source_game_key || null, homeTeam: String(row.home_team), awayTeam: String(row.away_team), startAt: row.start_at || null });
  }
  const reference = observations[0];
  const mismatches = reference ? observations.slice(1).filter((item) => normalizeAuditTeam(item.homeTeam) !== normalizeAuditTeam(reference.homeTeam) || normalizeAuditTeam(item.awayTeam) !== normalizeAuditTeam(reference.awayTeam)) : [];
  return {
    consistent: Boolean(reference) && mismatches.length === 0,
    warningCode: mismatches.length ? "GAME_HOME_AWAY_INCONSISTENCY" : null,
    observations,
    mismatches
  };
}

async function handleAdminHistoricalGameWorkflow(request, env, cors, requestedInternalGameId) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const internalGameId = String(requestedInternalGameId || "").trim();
  if (!INTERNAL_GAME_ID_PATTERN.test(internalGameId)) {
    return jsonResponse({ ok: false, code: "INVALID_INTERNAL_GAME_ID", error: "内部試合IDの形式が不正です。" }, 400, cors);
  }
  try {
    if (!await isWorkflowJobSchemaReady(env.AUTH_DB)) {
      return jsonResponse({ ok: false, code: "GAME_WORKFLOW_JOB_SCHEMA_NOT_READY", error: "試合進行ジョブのmigrationが未適用です。" }, 503, cors);
    }
    const identity = await env.AUTH_DB.prepare(
      `SELECT games.internal_game_id, games.game_date, games.start_time, games.home_team, games.away_team,
              games.game_status, games.created_at, games.updated_at,
              state.legacy_game_id, state.workflow_status, state.workflow_version,
              state.last_completed_job_type, state.last_error_code, state.last_error_at,
              state.next_due_at, state.updated_at AS workflow_updated_at
         FROM games
         LEFT JOIN game_workflow_state AS state ON state.internal_game_id = games.internal_game_id
        WHERE games.internal_game_id = ?1 LIMIT 1`
    ).bind(internalGameId).first();
    if (!identity) {
      return jsonResponse({ ok: false, code: "GAME_WORKFLOW_NOT_FOUND", error: "指定された試合の進行状態が見つかりません。" }, 404, cors);
    }
    const identifierResult = await env.AUTH_DB.prepare(
      `SELECT provider, identifier_type, identifier_value
         FROM game_identifiers
        WHERE internal_game_id = ?1
          AND identifier_type IN ('descriptive_game_id', 'legacy_compact_game_id', 'npb_game_code', 'source_game_key', 'game_code')
        ORDER BY identifier_type ASC, identifier_value ASC`
    ).bind(internalGameId).all();
    const identifiers = (identifierResult?.results || []).map((row) => ({
      provider: String(row.provider || ""),
      type: String(row.identifier_type || ""),
      value: String(row.identifier_value || "")
    }));
    const legacyGameId = String(identity.legacy_game_id || identifiers.find((row) => ["descriptive_game_id", "legacy_compact_game_id"].includes(row.type))?.value || "");
    const sourceGameKey = identifiers.find((row) => row.type === "source_game_key")?.value || "";
    const npbGameCode = identifiers.find((row) => ["npb_game_code", "game_code"].includes(row.type))?.value || "";
    const [scheduleResult, jobResult, lineupResult, pregameResult, rosterResult, recoveryLog, recoveryVisitLog, rankingResult, scoringRecoveryLog] = await Promise.all([
      env.AUTH_DB.prepare(
        `SELECT game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, venue, game_status, internal_game_id
           FROM detected_game_schedule
          WHERE internal_game_id = ?1 OR game_id = ?2 OR (?3 <> '' AND source_game_key = ?3)
          ORDER BY updated_at DESC`
      ).bind(internalGameId, legacyGameId, sourceGameKey).all(),
      env.AUTH_DB.prepare(
        `SELECT id, job_type, status, source, attempt_count, max_attempts, scheduled_slot_at,
                next_attempt_at, error_code, error_detail, claimed_at, lease_expires_at,
                started_at, completed_at, result_metadata, updated_at
           FROM game_job_runs
          WHERE internal_game_id = ?1
          ORDER BY COALESCE(updated_at, scheduled_slot_at) DESC, id DESC`
      ).bind(internalGameId).all(),
      env.AUTH_DB.prepare(
        `SELECT game_id, internal_game_id, lineup_source, lineup_detected_at, scoring_status, scoring_due_at,
                scored_at, publication_status, published_at, last_error, updated_at
           FROM game_lineups
          WHERE internal_game_id = ?1 OR (internal_game_id IS NULL AND game_id = ?2)
          ORDER BY updated_at DESC LIMIT 10`
      ).bind(internalGameId, legacyGameId).all(),
      env.AUTH_DB.prepare(
        `SELECT game_id, roster_status, lineup_status, lineup_attempt_count, last_lineup_attempt_at,
                next_lineup_attempt_at, scoring_status, last_error_code, last_error_message, updated_at
           FROM game_pregame_automation
          WHERE internal_game_id = ?1 OR (internal_game_id IS NULL AND game_id = ?2)
          ORDER BY updated_at DESC LIMIT 10`
      ).bind(internalGameId, legacyGameId).all(),
      env.AUTH_DB.prepare(
        `SELECT game_id, captured_at, player_count, status, source, updated_at
           FROM game_roster_snapshots
          WHERE internal_game_id = ?1 OR (internal_game_id IS NULL AND game_id = ?2)
          ORDER BY updated_at DESC LIMIT 10`
      ).bind(internalGameId, legacyGameId).all(),
      env.AUTH_DB.prepare(
        `SELECT occurred_at, error_code, metadata
           FROM game_workflow_logs
          WHERE game_id = ?1 AND event_type = 'workflow_job_recovered'
          ORDER BY occurred_at DESC LIMIT 1`
      ).bind(legacyGameId).first(),
      env.AUTH_DB.prepare(
        `SELECT occurred_at, error_code, metadata
           FROM game_workflow_logs
          WHERE game_id = ?1 AND event_type = 'publication_recovery_cron_visit'
          ORDER BY occurred_at DESC LIMIT 1`
      ).bind(legacyGameId).first(),
      env.AUTH_DB.prepare(
        `SELECT game_id, internal_game_id, is_ranking_eligible, game_status,
                publication_status, scored_private_at, published_at, updated_at
           FROM ranking_games
          WHERE internal_game_id = ?1 OR (internal_game_id IS NULL AND game_id = ?2)
           ORDER BY updated_at DESC LIMIT 1`
      ).bind(internalGameId, legacyGameId).first(),
      env.AUTH_DB.prepare(
        `SELECT occurred_at, error_code, metadata
           FROM game_workflow_logs
          WHERE game_id = ?1 AND event_type = 'scoring_workflow_reconciled'
          ORDER BY occurred_at DESC LIMIT 1`
      ).bind(legacyGameId).first()
    ]);
    const now = new Date();
    const jobs = (jobResult?.results || []).map((row) => mapHistoricalWorkflowJobRow(row, now));
    const lineupRows = lineupResult?.results || [];
    const scoredLineup = lineupRows.find((row) => row.scoring_status === "scored") || null;
    const scoringJob = jobs.find((job) => job.jobType === "scoring") || null;
    const rankingJob = jobs.find((job) => job.jobType === "ranking_update" && job.status !== "cancelled") || null;
    const publicationJob = jobs.find((job) => job.jobType === "publication" && job.status !== "cancelled") || null;
    const rankingRow = rankingResult || null;
    const rankingReflected = Boolean(rankingRow
      && Number(rankingRow.is_ranking_eligible || 0) === 1
      && String(rankingRow.game_status || "") === "scored"
      && String(rankingRow.publication_status || "") !== "pending");
    const diagnostics = summarizeHistoricalWorkflowJobs(jobs, identity.workflow_status || "unknown", now, lineupRows);
    const finalJob = diagnostics.lineupFetchStatus.final;
    const recoveryEligibility = getHistoricalWorkflowRecoveryEligibility({
      job: finalJob,
      workflowStatus: identity.workflow_status,
      gameStatus: identity.game_status,
      gameDate: identity.game_date,
      startAt: identity.start_time,
      lineupRows,
      now
    });
    let targetResolution = finalJob?.targetResolution || null;
    try {
      targetResolution = (await resolveWorkflowJobGame(env.AUTH_DB, internalGameId)).targetResolution || targetResolution;
    } catch (error) {
      targetResolution = getSafeWorkflowErrorMetadata(error).targetResolution || targetResolution;
    }
    const scoringPersistence = getScoringPersistenceReconciliationEligibility({
      workflowStatus: identity.workflow_status,
      workflowErrorCode: scoringJob?.errorCode || identity.last_error_code,
      workflowErrorDetail: scoringJob?.errorDetail || "",
      scoringStatus: scoredLineup?.scoring_status || "",
      scoredAt: scoredLineup?.scored_at || "",
      lastError: scoredLineup?.last_error || "",
      finalLineupExists: Boolean(scoredLineup),
      scoreResultExists: Boolean(scoredLineup),
      scoreResultCount: lineupRows.filter((row) => row.scoring_status === "scored").length,
      publicationStatus: scoredLineup?.publication_status || "pending",
      rankingCheckAvailable: true,
      identifierConflict: Array.isArray(targetResolution?.identifierConflicts) && targetResolution.identifierConflicts.length > 0,
      internalGameIdMatches: Boolean(scoredLineup && String(scoredLineup.internal_game_id || "") === internalGameId)
    });
    const scoringRecoveryMetadata = parseJsonObject(scoringRecoveryLog?.metadata);
    const scoringJobRecoveryMode = String(scoringRecoveryMetadata?.recoveryMode || scoringPersistence.scoringJobRecoveryMode || "none");
    const rawRecoveryMetadata = parseJsonObject(recoveryLog?.metadata);
    const recoveredJobId = Number(rawRecoveryMetadata?.recoveredJobId);
    const supersededJobIds = Array.isArray(rawRecoveryMetadata?.supersededJobIds)
      ? rawRecoveryMetadata.supersededJobIds.map(Number).filter(Number.isInteger)
      : [];
    const recoveryAudit = {
      ...recoveryEligibility,
      recoveredJobId: Number.isInteger(recoveredJobId) ? recoveredJobId : null,
      supersededJobIds,
      recoveredAt: typeof rawRecoveryMetadata?.recoveredAt === "string" ? rawRecoveryMetadata.recoveredAt : null,
      targetResolution
    };
    const publicationWorkflow = await getAdminPublicationWorkflowAudit(env.AUTH_DB, {
      internalGameId,
      legacyGameId,
      workflowStatus: identity.workflow_status,
      jobSummary: { jobs },
      recoveryLog,
      recoveryVisitLog,
      scoreResultCount: scoringPersistence.scoreResultCount,
      now
    });
    const homeAwayAudit = auditGameHomeAwayConsistency({
      game: { homeTeam: identity.home_team, awayTeam: identity.away_team, startAt: identity.start_time },
      scheduleRows: scheduleResult?.results || []
    });
    const warnings = [...new Set([...(diagnostics.warnings || []), ...(homeAwayAudit.warningCode ? [homeAwayAudit.warningCode] : [])])];
    const lineupData = lineupRows.map((row) => ({
      gameId: row.game_id || null,
      source: row.lineup_source || null,
      detectedAt: row.lineup_detected_at || null,
      scoringStatus: row.scoring_status || null,
      scoringDueAt: row.scoring_due_at || null,
      scoredAt: row.scored_at || null,
      publicationStatus: row.publication_status || null,
      publishedAt: row.published_at || null,
      lastError: sanitizeHistoricalWorkflowErrorDetail(row.last_error),
      updatedAt: row.updated_at || null
    }));
    const pregameData = (pregameResult?.results || []).map((row) => ({
      gameId: row.game_id || null,
      rosterStatus: row.roster_status || null,
      lineupStatus: row.lineup_status || null,
      lineupAttemptCount: Number(row.lineup_attempt_count || 0),
      lastLineupAttemptAt: row.last_lineup_attempt_at || null,
      nextLineupAttemptAt: row.next_lineup_attempt_at || null,
      scoringStatus: row.scoring_status || null,
      lastErrorCode: row.last_error_code || null,
      lastErrorMessage: sanitizeHistoricalWorkflowErrorDetail(row.last_error_message),
      updatedAt: row.updated_at || null
    }));
    const rosterData = (rosterResult?.results || []).map((row) => ({
      gameId: row.game_id || null,
      capturedAt: row.captured_at || null,
      playerCount: Number(row.player_count || 0),
      status: row.status || null,
      source: row.source || null,
      updatedAt: row.updated_at || null
    }));
    const response = jsonResponse({
      ok: true,
      internalGameId,
      observedAt: now.toISOString(),
      game: {
        internalGameId,
        legacyGameId,
        gameDate: identity.game_date || null,
        startAt: identity.start_time || null,
        homeTeam: identity.home_team || null,
        awayTeam: identity.away_team || null,
        gameStatus: identity.game_status || null,
        sourceGameKey,
        npbGameCode,
        identifiers
      },
      workflow: {
        status: identity.workflow_status || "unknown",
        gameStatus: identity.game_status || null,
        version: Number(identity.workflow_version || 0),
        lastCompletedJobType: identity.last_completed_job_type || null,
        lastErrorCode: identity.last_error_code || null,
        lastErrorAt: identity.last_error_at || null,
        nextDueAt: identity.next_due_at || null,
        updatedAt: identity.workflow_updated_at || identity.updated_at || null
      },
      jobs: diagnostics.jobs,
      lineupJobs: diagnostics.lineupJobs,
      lineupFetchStatus: diagnostics.lineupFetchStatus,
      lineupFetchState: diagnostics.lineupFetchState,
      lastFetchAttempt: diagnostics.lastFetchAttempt,
      validation: diagnostics.validation,
      scoringEligibility: diagnostics.scoringEligibility,
      scoringPersistenceState: scoringPersistence.scoringPersistenceState,
      workflowStateConsistency: scoringPersistence.workflowStateConsistency,
      scoringPersisted: scoringPersistence.scoringPersisted,
      scoredAt: scoredLineup?.scored_at || null,
      workflowBehindScoring: scoringPersistence.workflowBehindScoring,
      reconciliationEligible: scoringPersistence.reconciliationEligible,
      reconciliationBlockedReason: scoringPersistence.reconciliationBlockedReason,
      rankingJobExists: Boolean(rankingJob),
      rankingStatus: rankingReflected ? "reflected" : (rankingJob?.status || "not_started"),
      publicationJobExists: Boolean(publicationJob),
      publicationStatus: scoredLineup?.publication_status || rankingRow?.publication_status || "pending",
      publicationWorkflow,
      scoreResultCount: scoringPersistence.scoreResultCount,
      scoringJobRecoveryMode,
      staleLeaseDetected: recoveryAudit.staleLeaseDetected,
      eligibleForRecovery: recoveryAudit.eligibleForRecovery,
      recoveryBlockedReason: recoveryAudit.recoveryBlockedReason,
      recoveryReasonCode: recoveryAudit.recoveryReasonCode || recoveryLog?.error_code || null,
      recoveredJobId: recoveryAudit.recoveredJobId,
      supersededJobIds: recoveryAudit.supersededJobIds,
      recoveredAt: recoveryAudit.recoveredAt,
      reconciliationScope: recoveryAudit.reconciliationScope,
      targetResolution: recoveryAudit.targetResolution,
      dataState: { lineups: lineupData, pregameAutomation: pregameData, rosterSnapshots: rosterData },
      homeAwayAudit,
      warnings,
      errors: diagnostics.errors
    }, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("過去試合の進行詳細監査に失敗しました", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ ok: false, code: isPregameSchemaError(error) ? "HISTORICAL_GAME_WORKFLOW_SCHEMA_NOT_READY" : "HISTORICAL_GAME_WORKFLOW_READ_FAILED", error: "過去試合の進行詳細を取得できませんでした。" }, isPregameSchemaError(error) ? 503 : 500, cors);
  }
}

function parseGameWorkflowAuditOptions(request) {
  const url = new URL(request.url);
  const internalGameId = String(url.searchParams.get("internalGameId") || "").trim().slice(0, 80);
  const parsedLimit = Number.parseInt(url.searchParams.get("limit"), 10);
  return {
    internalGameId,
    limit: Number.isFinite(parsedLimit) ? Math.min(200, Math.max(1, parsedLimit)) : 50
  };
}

async function handleAdminGameWorkflowAudit(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const options = parseGameWorkflowAuditOptions(request);
  try {
    if (!await isGameWorkflowJobSchemaReady(env.AUTH_DB)) {
      return jsonResponse({ ok: false, code: "GAME_WORKFLOW_JOB_SCHEMA_NOT_READY", error: "試合進行ジョブのmigrationが未適用です。" }, 503, cors);
    }
    const filter = options.internalGameId ? "WHERE internal_game_id = ?1" : "";
    const bindings = options.internalGameId ? [options.internalGameId] : [];
    const [workflowStates, jobStates, jobTypeStates, staleLeases, permanentFailures, orphanedStates, duplicateSlots, jobs] = await Promise.all([
      env.AUTH_DB.prepare(`SELECT workflow_status, COUNT(*) AS count FROM game_workflow_state ${filter} GROUP BY workflow_status`).bind(...bindings).all(),
      env.AUTH_DB.prepare(`SELECT status, COUNT(*) AS count FROM game_job_runs ${filter} GROUP BY status`).bind(...bindings).all(),
      env.AUTH_DB.prepare(`SELECT job_type, status, COUNT(*) AS count FROM game_job_runs ${filter} GROUP BY job_type, status`).bind(...bindings).all(),
      env.AUTH_DB.prepare(`SELECT COUNT(*) AS count FROM game_job_runs ${filter}${filter ? " AND" : " WHERE"} status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?${bindings.length + 1}`).bind(...bindings, new Date().toISOString()).first(),
      env.AUTH_DB.prepare(`SELECT id, internal_game_id, job_type, scheduled_slot_at, attempt_count, max_attempts, error_code, updated_at FROM game_job_runs ${filter}${filter ? " AND" : " WHERE"} status = 'permanently_failed' ORDER BY updated_at DESC LIMIT ?${bindings.length + 1}`).bind(...bindings, options.limit).all(),
      env.AUTH_DB.prepare(`SELECT COUNT(*) AS count FROM game_workflow_state state LEFT JOIN games ON games.internal_game_id = state.internal_game_id ${options.internalGameId ? "WHERE state.internal_game_id = ?1 AND" : "WHERE"} games.internal_game_id IS NULL`).bind(...bindings).first(),
      env.AUTH_DB.prepare(`SELECT COUNT(*) AS count FROM (SELECT internal_game_id, job_type, scheduled_slot_at FROM game_job_runs ${filter} GROUP BY internal_game_id, job_type, scheduled_slot_at HAVING COUNT(*) > 1)`).bind(...bindings).first(),
      env.AUTH_DB.prepare(`SELECT jobs.id, jobs.internal_game_id, state.legacy_game_id, jobs.job_type, jobs.status, jobs.source, jobs.attempt_count, jobs.max_attempts, jobs.scheduled_slot_at, jobs.next_attempt_at, jobs.lease_expires_at, jobs.error_code, jobs.updated_at FROM game_job_runs jobs LEFT JOIN game_workflow_state state ON state.internal_game_id = jobs.internal_game_id ${options.internalGameId ? "WHERE jobs.internal_game_id = ?1" : ""} ORDER BY jobs.updated_at DESC LIMIT ?${bindings.length + 1}`).bind(...bindings, options.limit).all()
    ]);
    const response = jsonResponse({
      ok: true,
      summary: {
        workflowStates: workflowStates.results || [],
        jobStates: jobStates.results || [],
        jobTypeStates: jobTypeStates.results || [],
        staleLeaseCount: Number(staleLeases?.count || 0),
        permanentlyFailedCount: (permanentFailures.results || []).length,
        orphanedStateCount: Number(orphanedStates?.count || 0),
        duplicateJobSlotCount: Number(duplicateSlots?.count || 0)
      },
      permanentlyFailedJobs: permanentFailures.results || [],
      recentJobs: jobs.results || []
    }, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("試合進行ジョブ監査の読み取りに失敗しました", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ ok: false, code: "GAME_WORKFLOW_JOB_AUDIT_READ_FAILED", error: "試合進行ジョブ監査を取得できませんでした。" }, 500, cors);
  }
}

export function deriveReleaseReadiness({ schemaReady = true, counts = {} } = {}) {
  const blockers = [];
  const warnings = [];
  const numeric = (key) => Math.max(0, Number(counts?.[key] || 0));
  const checks = {
    activeWorkflowCount: numeric("activeWorkflowCount"),
    pendingJobCount: numeric("pendingJobCount"),
    retryWaitCount: numeric("retryWaitCount"),
    staleLeaseCount: numeric("staleLeaseCount"),
    permanentlyFailedCount: numeric("permanentlyFailedCount"),
    missingDownstreamJobCount: numeric("missingDownstreamJobCount"),
    duplicateJobSlotCount: numeric("duplicateJobSlotCount"),
    serviceUnavailableCount: numeric("serviceUnavailableCount"),
    gamesWithoutInternalGameId: numeric("gamesWithoutInternalGameId"),
    historicalGamesWithoutInternalGameId: numeric("historicalGamesWithoutInternalGameId"),
    identifiersWithoutGames: numeric("identifiersWithoutGames"),
    newLegacyOnlyInsertCount: numeric("newLegacyOnlyInsertCount") || numeric("newLegacyOnlyWritesLast24h"),
    legacyOnlyUpdateCount: numeric("legacyOnlyUpdateCount"),
    retryWaitBlockerCount: numeric("retryWaitBlockerCount"),
    publishedWorkflowMismatchCount: numeric("publishedWorkflowMismatchCount"),
    publicationWorkflowBehindCount: numeric("publicationWorkflowBehindCount")
  };
  if (!schemaReady) blockers.push("WORKFLOW_SCHEMA_NOT_READY");
  if (checks.duplicateJobSlotCount > 0) blockers.push("ACTIVE_DUPLICATE_JOBS");
  if (checks.gamesWithoutInternalGameId > 0) blockers.push("NEW_GAME_WITHOUT_INTERNAL_ID");
  if (checks.identifiersWithoutGames > 0) blockers.push("IDENTIFIER_WITHOUT_GAME");
  if (checks.missingDownstreamJobCount > 0) blockers.push("MISSING_DOWNSTREAM_JOB");
  if (checks.staleLeaseCount > 0) blockers.push("STALE_LEASE");
  if (checks.newLegacyOnlyInsertCount > 0) blockers.push("RECENT_LEGACY_ONLY_WRITE");
  if (checks.retryWaitBlockerCount > 0) blockers.push("RETRY_WAIT_EXPIRED");
  if (checks.publishedWorkflowMismatchCount > 0) blockers.push("WORKFLOW_STATE_CONFLICT");
  if (checks.permanentlyFailedCount > 0) warnings.push("PERMANENTLY_FAILED_JOBS");
  if (checks.serviceUnavailableCount > 0) warnings.push("SERVICE_UNAVAILABLE_GAMES");
  if (checks.retryWaitCount > 0) warnings.push("RETRY_WAIT_JOBS");
  if (checks.historicalGamesWithoutInternalGameId > 0) warnings.push("HISTORICAL_GAME_WITHOUT_INTERNAL_ID");
  if (checks.legacyOnlyUpdateCount > 0) warnings.push("HISTORICAL_LEGACY_ONLY_UPDATE");
  if (checks.publicationWorkflowBehindCount > 0) warnings.push("PUBLICATION_WORKFLOW_RECONCILIATION_PENDING");
  return { ready: blockers.length === 0, blockers, warnings, checks };
}

const RELEASE_READINESS_LEGACY_AUDIT_LIMIT = 200;
const RETRY_WAIT_STALE_GRACE_MS = 60 * 60 * 1000;

function isAuditableGameId(value) {
  const gameId = String(value || "").trim();
  if (!gameId || /^day-\d{4}-\d{2}-\d{2}$/i.test(gameId)) return false;
  return !["global", "batch", "system"].includes(gameId.toLowerCase());
}

export function classifyLegacyOnlyWrite({ createdAt = "", updatedAt = "", since = "" } = {}) {
  const threshold = new Date(since).getTime();
  if (!Number.isFinite(threshold)) return "unknown";
  const created = new Date(createdAt).getTime();
  const updated = new Date(updatedAt).getTime();
  if (Number.isFinite(created) && created >= threshold) return "insert";
  if (Number.isFinite(updated) && updated >= threshold) return "update";
  return "unknown";
}

export function classifyScheduleInternalGameScope(gameDate, currentDate) {
  const date = String(gameDate || "");
  const current = String(currentDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(current)) return "unknown";
  return date >= current ? "current_or_future" : "historical";
}

async function collectGamesWithoutInternalGameIdDetails(db, dateFrom, dateTo, currentDate = dateFrom) {
  const result = await db.prepare(
    `SELECT schedule.game_id, schedule.game_date, schedule.start_at, schedule.home_team, schedule.away_team,
            schedule.game_code, schedule.source_game_key, schedule.internal_game_id,
            schedule.created_at, schedule.updated_at,
            (SELECT COUNT(*) FROM games
              WHERE games.game_date = schedule.game_date
                AND games.start_time = schedule.start_at
                AND games.home_team = schedule.home_team
                AND games.away_team = schedule.away_team) AS games_candidate_count,
            (SELECT COUNT(*) FROM game_identifiers identifiers
              WHERE identifiers.identifier_value IN (schedule.game_id, schedule.game_code, schedule.source_game_key)) AS identifier_candidate_count
       FROM detected_game_schedule schedule
      WHERE schedule.game_date >= ?1 AND schedule.game_date <= ?2
        AND (schedule.internal_game_id IS NULL OR schedule.internal_game_id = '')
      ORDER BY schedule.game_date DESC, schedule.start_at DESC, schedule.game_id ASC
      LIMIT ?3`
  ).bind(dateFrom, dateTo, RELEASE_READINESS_LEGACY_AUDIT_LIMIT).all();
  return (result.results || []).map((row) => {
    const gamesCandidateCount = Number(row.games_candidate_count || 0);
    const identifierCandidateCount = Number(row.identifier_candidate_count || 0);
    return {
      scheduleGameId: String(row.game_id || ""),
      gameDate: row.game_date || null,
      startTime: row.start_at || null,
      homeTeam: row.home_team || "",
      awayTeam: row.away_team || "",
      npbGameCode: row.game_code || null,
      sourceGameKey: row.source_game_key || null,
      detectedScheduleInternalGameId: row.internal_game_id || null,
      gamesCandidateCount,
      identifierCandidateCount,
      scope: classifyScheduleInternalGameScope(row.game_date, currentDate),
      createdBy: "schedule_sync",
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      reasonCode: gamesCandidateCount > 1
        ? "INTERNAL_GAME_IDENTITY_AMBIGUOUS"
        : gamesCandidateCount === 1
          ? "SCHEDULE_INTERNAL_GAME_ID_LINK_MISSING"
          : identifierCandidateCount > 1
            ? "INTERNAL_GAME_IDENTIFIER_AMBIGUOUS"
            : "INTERNAL_GAME_REGISTRY_MISSING"
    };
  });
}

async function collectRecentLegacyOnlyWrites(db, since) {
  const definitions = [
    { table: "detected_game_schedule", creationColumn: "created_at", source: "schedule_sync" },
    { table: "predictions", creationColumn: "submitted_at", source: "prediction_save", exclusion: " AND is_test_prediction = 0" },
    { table: "probable_starters", creationColumn: "", source: "probable_starter_fetch" },
    { table: "game_roster_snapshots", creationColumn: "created_at", sourceColumn: "source", source: "roster_fetch" },
    { table: "game_pregame_automation", creationColumn: "created_at", source: "pregame_automation" },
    { table: "game_lineups", creationColumn: "created_at", sourceColumn: "lineup_source", source: "lineup_save" },
    { table: "ranking_games", creationColumn: "created_at", source: "ranking_state", exclusion: " AND (is_test_game = 0 OR is_test_game IS NULL)" },
    { table: "game_rescore_jobs", creationColumn: "created_at", source: "rescore" }
  ];
  const rows = [];
  for (const definition of definitions) {
    const sourceExpression = definition.sourceColumn ? `COALESCE(${definition.sourceColumn}, '${definition.source}')` : `'${definition.source}'`;
    try {
      const result = await db.prepare(
        `SELECT game_id, ${definition.creationColumn ? definition.creationColumn : "NULL"} AS created_at,
                updated_at, ${sourceExpression} AS write_source
           FROM ${definition.table}
          WHERE (internal_game_id IS NULL OR internal_game_id = '')
            AND (updated_at >= ?1 OR ${definition.creationColumn ? `${definition.creationColumn} >= ?1` : "0"})
            AND game_id IS NOT NULL AND game_id <> ''
            AND game_id NOT LIKE 'day-%'${definition.exclusion || ""}
          ORDER BY COALESCE(updated_at, created_at) DESC
          LIMIT ?2`
      ).bind(since, RELEASE_READINESS_LEGACY_AUDIT_LIMIT).all();
      for (const row of result.results || []) {
        if (!isAuditableGameId(row.game_id)) continue;
        const writeType = classifyLegacyOnlyWrite({ createdAt: row.created_at, updatedAt: row.updated_at, since });
        if (writeType === "unknown") continue;
        rows.push({
          table: definition.table,
          gameId: String(row.game_id),
          writeType,
          createdAt: row.created_at || null,
          updatedAt: row.updated_at || null,
          occurredAt: row.updated_at || row.created_at || null,
          writeSource: String(row.write_source || definition.source),
          expectedInternalGameId: "",
          reasonCode: "INTERNAL_GAME_ID_NOT_PERSISTED"
        });
      }
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
    }
  }
  const uniqueGameIds = [...new Set(rows.map((row) => row.gameId))];
  if (uniqueGameIds.length) {
    const placeholders = uniqueGameIds.map((_, index) => `?${index + 1}`).join(", ");
    const [schedule, identifiers] = await Promise.all([
      db.prepare(`SELECT game_id, internal_game_id FROM detected_game_schedule WHERE game_id IN (${placeholders})`).bind(...uniqueGameIds).all(),
      db.prepare(`SELECT identifier_value, internal_game_id FROM game_identifiers WHERE identifier_value IN (${placeholders})`).bind(...uniqueGameIds).all()
    ]);
    const resolved = new Map();
    for (const row of [...(schedule.results || []), ...(identifiers.results || []).map((item) => ({ game_id: item.identifier_value, internal_game_id: item.internal_game_id }))]) {
      const id = String(row.internal_game_id || "").trim();
      if (!id) continue;
      const values = resolved.get(String(row.game_id)) || new Set();
      values.add(id);
      resolved.set(String(row.game_id), values);
    }
    for (const row of rows) {
      const candidates = [...(resolved.get(row.gameId) || [])];
      if (candidates.length === 1 && INTERNAL_GAME_ID_PATTERN.test(candidates[0])) {
        row.expectedInternalGameId = candidates[0];
        row.reasonCode = "INTERNAL_GAME_ID_NOT_PERSISTED";
      } else if (candidates.length > 1) {
        row.reasonCode = "INTERNAL_GAME_ID_AMBIGUOUS";
      } else {
        row.reasonCode = "INTERNAL_GAME_ID_UNRESOLVED";
      }
    }
  }
  return rows
    .sort((left, right) => String(right.occurredAt || "").localeCompare(String(left.occurredAt || "")) || left.table.localeCompare(right.table) || left.gameId.localeCompare(right.gameId))
    .slice(0, RELEASE_READINESS_LEGACY_AUDIT_LIMIT);
}

function summarizeLegacyOnlyWrites(rows) {
  const byTable = {};
  const bySource = {};
  const byType = { insert: 0, update: 0 };
  for (const row of rows) {
    byTable[row.table] = (byTable[row.table] || 0) + 1;
    bySource[row.writeSource] = (bySource[row.writeSource] || 0) + 1;
    if (Object.hasOwn(byType, row.writeType)) byType[row.writeType] += 1;
  }
  return { byTable, bySource, byType, insertCount: byType.insert, updateCount: byType.update };
}

export function classifyRetryWaitJobs(rows, now) {
  const current = now instanceof Date ? now : new Date(now);
  const retryWaitJobs = (rows || []).filter((row) => row.status === "retry_wait").map((row) => {
    const nextAttemptAt = row.next_attempt_at ? new Date(row.next_attempt_at) : null;
    const overdue = Boolean(nextAttemptAt && current.getTime() - nextAttemptAt.getTime() > RETRY_WAIT_STALE_GRACE_MS);
    const attemptsExceeded = Number(row.attempt_count || 0) >= Number(row.max_attempts || 1);
    const internalMissing = !INTERNAL_GAME_ID_PATTERN.test(String(row.internal_game_id || ""));
    const expired = attemptsExceeded || String(row.error_code || "") === SCORING_RETRY_EXPIRED_CODE || !nextAttemptAt;
    const blockerReasonCode = internalMissing
      ? "INTERNAL_GAME_ID_UNRESOLVED"
      : expired
        ? "RETRY_WINDOW_EXPIRED"
        : overdue
          ? "RETRY_WAIT_OVERDUE"
          : "";
    return {
      internalGameId: row.internal_game_id || null,
      jobType: row.job_type,
      status: row.status,
      scheduledSlotAt: row.scheduled_slot_at || null,
      nextAttemptAt: row.next_attempt_at || null,
      attemptCount: Number(row.attempt_count || 0),
      maxAttempts: Number(row.max_attempts || 0),
      errorCode: row.error_code || null,
      updatedAt: row.updated_at || null,
      overdue,
      blockerReasonCode: blockerReasonCode || null
    };
  });
  const blockers = retryWaitJobs.filter((job) => job.blockerReasonCode);
  const oldestRetryWaitAt = retryWaitJobs.map((job) => job.updatedAt).filter(Boolean).sort()[0] || null;
  return { retryWaitJobs, retryWaitBlockerCount: blockers.length, oldestRetryWaitAt };
}

async function collectReleaseReadiness(env, now = new Date()) {
  const db = env.AUTH_DB;
  const schemaReady = await isGameWorkflowJobSchemaReady(db);
  if (!schemaReady) return deriveReleaseReadiness({ schemaReady: false });
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const tomorrow = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const dateFrom = getJstDateString(yesterday);
  const dateTo = getJstDateString(tomorrow);
  const currentDate = getJstDateString(now);
  const timestamp24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [workflowRows, jobRows, staleLease, duplicateSlots, scheduleMissing, scheduleMissingDetails, identifiersMissing, currentLineups] = await Promise.all([
    db.prepare(
      `SELECT state.internal_game_id, state.game_status, state.workflow_status, games.game_date
         FROM game_workflow_state state
         JOIN games ON games.internal_game_id = state.internal_game_id
        WHERE games.game_date >= ?1 AND games.game_date <= ?2`
    ).bind(dateFrom, dateTo).all(),
    db.prepare(
      `SELECT internal_game_id, job_type, status, scheduled_slot_at, next_attempt_at,
              attempt_count, max_attempts, error_code, updated_at
         FROM game_job_runs
        WHERE scheduled_slot_at <= ?1 OR status IN ('retry_wait', 'claimed', 'running')`
    ).bind(tomorrow.toISOString()).all(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM game_job_runs
        WHERE status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1`
    ).bind(now.toISOString()).first(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM (
        SELECT internal_game_id, job_type, scheduled_slot_at
          FROM game_job_runs
         GROUP BY internal_game_id, job_type, scheduled_slot_at
        HAVING COUNT(*) > 1
      )`
    ).bind().first(),
    db.prepare(
      `SELECT COUNT(*) AS count FROM detected_game_schedule
        WHERE game_date >= ?1 AND game_date <= ?2 AND (internal_game_id IS NULL OR internal_game_id = '')`
    ).bind(currentDate, dateTo).first(),
    collectGamesWithoutInternalGameIdDetails(db, dateFrom, dateTo, currentDate),
    db.prepare(
      `SELECT COUNT(*) AS count FROM game_identifiers identifiers
         LEFT JOIN games ON games.internal_game_id = identifiers.internal_game_id
        WHERE games.internal_game_id IS NULL`
    ).bind().first(),
    db.prepare(
      `SELECT internal_game_id, scoring_status, publication_status, published_at
         FROM game_lineups
        WHERE internal_game_id IS NOT NULL AND internal_game_id <> ''`
    ).bind().all(),
  ]);
  const jobs = jobRows.results || [];
  let managed = { selection: null, candidates: [] };
  try {
    managed = await getCurrentManagedGame(db, now);
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  const managedCandidates = managed.candidates || [];
  const currentAndFutureIds = new Set(managedCandidates
    .map((candidate) => normalizeManagedGameCandidate(candidate, now))
    .filter((candidate) => !candidate.isHistorical && !candidate.isTestGame)
    .map((candidate) => candidate.internalGameId)
    .filter(Boolean));
  const currentWorkflows = currentAndFutureIds.size
    ? (workflowRows.results || []).filter((row) => currentAndFutureIds.has(row.internal_game_id))
    : (workflowRows.results || []).filter((row) => row.game_date >= currentDate);
  const scopedJobs = currentAndFutureIds.size
    ? jobs.filter((job) => currentAndFutureIds.has(job.internal_game_id))
    : jobs.filter((job) => !job.internal_game_id);
  const retryState = classifyRetryWaitJobs(scopedJobs, now);
  const jobsByGame = new Map();
  for (const job of scopedJobs) {
    const list = jobsByGame.get(job.internal_game_id) || [];
    list.push(job);
    jobsByGame.set(job.internal_game_id, list);
  }
  const lineupsByGame = new Map((currentLineups.results || []).map((row) => [row.internal_game_id, row]));
  let missingDownstreamJobCount = 0;
  for (const workflow of currentWorkflows) {
    if (["cancelled", "service_unavailable", "published"].includes(workflow.workflow_status)) continue;
    const gameJobs = jobsByGame.get(workflow.internal_game_id) || [];
    const lineup = lineupsByGame.get(workflow.internal_game_id);
    const hasJob = (type) => gameJobs.some((job) => job.job_type === type && job.status !== "cancelled");
    if (workflow.workflow_status === "final_lineup_captured" && !hasJob("scoring")) missingDownstreamJobCount += 1;
    if (lineup?.scoring_status === "scored" && !hasJob("ranking_update")) missingDownstreamJobCount += 1;
    if (gameJobs.some((job) => job.job_type === "ranking_update" && job.status === "succeeded")
      && lineup?.publication_status !== "published" && !hasJob("publication")) missingDownstreamJobCount += 1;
  }
  const publicationWorkflowBehindCount = currentWorkflows.filter((workflow) => {
    const lineup = lineupsByGame.get(workflow.internal_game_id);
    return lineup?.publication_status === "published"
      && lineup?.published_at
      && workflow.workflow_status !== "published";
  }).length;
  const counts = {
    activeWorkflowCount: currentWorkflows.filter((row) => !["published", "service_unavailable", "cancelled"].includes(row.workflow_status)).length,
    pendingJobCount: scopedJobs.filter((job) => job.status === "pending").length,
    retryWaitCount: scopedJobs.filter((job) => job.status === "retry_wait").length,
    staleLeaseCount: Number(staleLease?.count || 0),
    permanentlyFailedCount: scopedJobs.filter((job) => job.status === "permanently_failed").length,
    missingDownstreamJobCount,
    duplicateJobSlotCount: Number(duplicateSlots?.count || 0),
    serviceUnavailableCount: currentWorkflows.filter((row) => row.workflow_status === "service_unavailable").length,
    gamesWithoutInternalGameId: Number(scheduleMissing?.count || 0),
    identifiersWithoutGames: Number(identifiersMissing?.count || 0),
    newLegacyOnlyWritesLast24h: 0,
    newLegacyOnlyInsertCount: 0,
    legacyOnlyUpdateCount: 0,
    historicalGamesWithoutInternalGameId: scheduleMissingDetails.filter((detail) => detail.scope === "historical").length,
    retryWaitBlockerCount: retryState.retryWaitBlockerCount,
    publicationWorkflowBehindCount,
    publishedWorkflowMismatchCount: currentWorkflows.filter((row) => row.workflow_status === "published"
      && lineupsByGame.get(row.internal_game_id)?.publication_status !== "published").length
  };
  const recentLegacyOnlyWrites = await collectRecentLegacyOnlyWrites(db, timestamp24h);
  const legacyWriteSummary = summarizeLegacyOnlyWrites(recentLegacyOnlyWrites);
  counts.newLegacyOnlyWritesLast24h = legacyWriteSummary.insertCount;
  counts.newLegacyOnlyInsertCount = legacyWriteSummary.insertCount;
  counts.legacyOnlyUpdateCount = legacyWriteSummary.updateCount;
  const historicalFailures = managedCandidates
    .map((candidate) => normalizeManagedGameCandidate(candidate, now))
    .filter((candidate) => candidate.isHistorical && candidate.isFailed)
    .sort((left, right) => String(right.startAt || "").localeCompare(String(left.startAt || "")))
    .slice(0, 10)
    .map((candidate) => ({
      internalGameId: candidate.internalGameId,
      gameId: candidate.legacyGameId,
      gameDate: candidate.gameDate,
      workflowStatus: candidate.workflowStatus,
      gameStatus: candidate.gameStatus,
      classification: classifyManagedGame(candidate),
      lastErrorCode: candidate.lastErrorCode || null,
      lastErrorAt: candidate.lastErrorAt || null
    }));
  let currentPublicationWorkflow = null;
  if (managed.selection?.internalGameId) {
    try {
      currentPublicationWorkflow = await getAdminPublicationWorkflowAudit(db, {
        internalGameId: managed.selection.internalGameId,
        legacyGameId: managed.selection.legacyGameId,
        workflowStatus: managed.selection.workflowStatus,
        jobSummary: {
          jobs: scopedJobs
            .filter((job) => job.internal_game_id === managed.selection.internalGameId)
            .map((job) => ({
              jobType: job.job_type,
              status: job.status,
              scheduledAt: job.scheduled_slot_at,
              nextAttemptAt: job.next_attempt_at,
              errorCode: job.error_code,
              attemptCount: job.attempt_count,
              completedAt: job.completed_at,
              leaseExpiresAt: job.lease_expires_at
            })),
          warnings: [],
          errors: []
        },
        now
      });
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
    }
  }
  return {
    ...deriveReleaseReadiness({ schemaReady, counts }),
    currentGame: managed.selection,
    currentGameSelection: managed.selection ? {
      selectionReason: managed.selection.selectionReason,
      gameId: managed.selection.legacyGameId,
      internalGameId: managed.selection.internalGameId,
      classification: managed.selection.classification
    } : null,
    currentPublicationWorkflow,
    historicalFailures,
    activeWorkflowGameIds: currentWorkflows.filter((row) => !["published", "service_unavailable", "cancelled"].includes(row.workflow_status)).map((row) => row.internal_game_id),
    pendingJobGameIds: [...new Set(scopedJobs.filter((job) => job.status === "pending").map((job) => job.internal_game_id))],
    retryJobGameIds: [...new Set(scopedJobs.filter((job) => job.status === "retry_wait").map((job) => job.internal_game_id))],
    gamesWithoutInternalGameIdDetails: scheduleMissingDetails,
    recentLegacyOnlyWrites,
    legacyOnlyWritesByTable: legacyWriteSummary.byTable,
    legacyOnlyWritesBySource: legacyWriteSummary.bySource,
    legacyOnlyWritesByType: legacyWriteSummary.byType,
    recentLegacyOnlyInsertCount: legacyWriteSummary.insertCount,
    recentLegacyOnlyUpdateCount: legacyWriteSummary.updateCount,
    oldestRetryWaitAt: retryState.oldestRetryWaitAt,
    retryWaitJobs: retryState.retryWaitJobs,
    dateFrom,
    dateTo,
    cronLastRunAt: null,
    cronLastSuccessAt: null,
    cronLastErrorCode: null
  };
}

async function handleAdminReleaseReadiness(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  try {
    const report = await collectReleaseReadiness(env, new Date());
    const response = jsonResponse({ ok: true, ...report }, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.error("リリース準備状況の読み取りに失敗しました", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ ok: false, code: "RELEASE_READINESS_READ_FAILED", error: "リリース準備状況を取得できませんでした。" }, 500, cors);
  }
}

export function selectNextPredictionTarget(games, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return null;
  return (Array.isArray(games) ? games : [])
    .filter((game) => game?.gameId && !isScheduleGameUnavailable(game))
    .map((game) => ({ game, startAt: game.startAt instanceof Date ? game.startAt : parseJstScheduleStart(game) }))
    .filter(({ startAt }) => startAt && startAt.getTime() > current.getTime())
    .sort((left, right) => left.startAt.getTime() - right.startAt.getTime())[0]?.game || null;
}

async function getServerPredictionTarget(db, now = new Date()) {
  let detectedGames = [];
  let registryAvailable = false;
  try {
    const registry = await getGameIdentityRegistryAvailability(db);
    registryAvailable = registry.available;
    const internalFilter = registry.scheduleColumnAvailable ? " AND internal_game_id IS NOT NULL AND internal_game_id <> ''" : "";
    const rows = await db.prepare(
      `SELECT game_id, game_date, start_at, home_team, away_team, game_code, venue, game_status${registry.scheduleColumnAvailable ? ", internal_game_id" : ""}
         FROM detected_game_schedule
        WHERE game_status = 'scheduled' AND start_at > ?1${internalFilter}
        ORDER BY start_at ASC LIMIT 50`
    ).bind(now.toISOString()).all();
    detectedGames = (rows.results || []).map((row) => ({
      gameId: row.game_id,
      date: row.game_date,
      startAt: new Date(row.start_at),
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      gameCode: row.game_code || "",
      internalGameId: row.internal_game_id || "",
      venue: row.venue || "",
      status: row.game_status
    }));
  } catch {
    // V3では検出日程を読めない場合も静的日程へ戻さず、対象なしとして扱います。
  }
  if (!registryAvailable) return null;
  const target = selectNextPredictionTarget(detectedGames, now);
  if (!target) return null;
  if (!INTERNAL_GAME_ID_PATTERN.test(String(target.internalGameId || ""))) {
    return null;
  }
  return serializePredictionTarget(target);
}

function serializePredictionTarget(game) {
  const startAt = game?.startAt instanceof Date ? game.startAt : parseJstScheduleStart(game);
  return {
    gameId: game.gameId,
    date: game.date || "",
    startTime: game.startTime || (startAt ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(startAt) : ""),
    startAt: startAt?.toISOString() || "",
    homeTeam: game.homeTeam || "",
    awayTeam: game.awayTeam || "",
    gameCode: game.gameCode || "",
    internalGameId: game.internalGameId || "",
    venue: game.venue || ""
  };
}

async function handleGetPredictionTarget(request, env, cors) {
  const target = await getServerPredictionTarget(env.AUTH_DB, new Date());
  const response = jsonResponse({ ok: true, target, generatedAt: new Date().toISOString() }, 200, cors);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function handleGetPublicGames(request, env, cors) {
  const now = new Date();
  const today = getJstDateString(now);
  let result;
  try {
    result = await env.AUTH_DB.prepare(
      `SELECT games.internal_game_id, games.game_date, games.start_time,
              games.home_team, games.away_team, games.game_status,
              COALESCE(workflow.legacy_game_id, schedule.game_id, '') AS legacy_game_id,
              COALESCE(workflow.workflow_status, '') AS workflow_status,
              COALESCE(lineup.publication_status, ranking.publication_status, '') AS publication_status,
              COALESCE(lineup.published_at, ranking.published_at, '') AS published_at
         FROM games
         LEFT JOIN game_workflow_state AS workflow
           ON workflow.internal_game_id = games.internal_game_id
         LEFT JOIN detected_game_schedule AS schedule
           ON schedule.internal_game_id = games.internal_game_id
         LEFT JOIN game_lineups AS lineup
           ON lineup.internal_game_id = games.internal_game_id
         LEFT JOIN ranking_games AS ranking
           ON ranking.internal_game_id = games.internal_game_id
        WHERE games.game_date >= ?1
          AND games.game_status NOT IN ('cancelled', 'canceled', 'postponed')
          AND games.is_active = 1
          AND games.deleted_at IS NULL
        ORDER BY games.start_time ASC
        LIMIT 50`
    ).bind(today).all();
  } catch (error) {
    // Public selection must remain available when an older optional status column is absent.
    console.warn("public game status joins unavailable; using canonical games fallback", error instanceof Error ? error.message : "unknown error");
    result = await env.AUTH_DB.prepare(
      `SELECT internal_game_id, game_date, start_time, home_team, away_team, game_status
         FROM games
        WHERE game_date >= ?1
          AND game_status NOT IN ('cancelled', 'canceled', 'postponed')
        ORDER BY start_time ASC
        LIMIT 50`
    ).bind(today).all();
  }

  const games = (result.results || []).map((row) => {
    const startAt = new Date(row.start_time);
    const publicationStatus = String(row.publication_status || "");
    return {
      internalGameId: row.internal_game_id,
      gameId: row.legacy_game_id || row.internal_game_id,
      date: row.game_date || "",
      startTime: Number.isNaN(startAt.getTime())
        ? String(row.start_time || "").slice(11, 16)
        : new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(startAt),
      startAt: row.start_time || "",
      homeTeam: row.home_team || "",
      awayTeam: row.away_team || "",
      gameStatus: row.game_status || "scheduled",
      workflowState: row.workflow_status || "",
      publicationStatus,
      publishedAt: row.published_at || null,
      isPublished: publicationStatus === "published" || Boolean(row.published_at)
    };
  });

  const response = jsonResponse({ ok: true, games, generatedAt: now.toISOString() }, 200, cors);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function handleGetProbableStarter(request, env, cors) {
  const params = new URL(request.url).searchParams;
  const suppliedInternalGameId = String(params.get("internalGameId") || "").trim();
  if (!INTERNAL_GAME_ID_PATTERN.test(suppliedInternalGameId)) {
    return jsonResponse({ ok: false, code: "INTERNAL_GAME_ID_REQUIRED", error: "internalGameIdを指定してください。" }, 400, cors);
  }
  try {
    const game = await env.AUTH_DB.prepare(
      `SELECT internal_game_id, game_date, start_time, home_team, away_team
         FROM games WHERE internal_game_id = ?1 LIMIT 1`
    ).bind(suppliedInternalGameId).first();
    if (!game) return jsonResponse({ ok: false, code: "V3_GAME_NOT_FOUND", error: "対象試合が見つかりません。" }, 404, cors);
    const row = await readProbableStarterRow(env.AUTH_DB, { internalGameId: suppliedInternalGameId });
    const probableStarter = serializeProbableStarterRow(row);
    const response = jsonResponse({
      ok: true,
      internalGameId: suppliedInternalGameId,
      gameDate: game.game_date || "",
      startAt: game.start_time || "",
      // Retired response aliases (not used for lookup): gameDate: metadata.date || game.game_date || ""
      // Retired response aliases (not used for lookup): startAt: metadata.startAt || game.start_at || ""
      homeTeam: game.home_team || "",
      awayTeam: game.away_team || "",
      source: probableStarter?.source || "",
      fetchedAt: probableStarter?.fetchedAt || null,
      status: probableStarter?.status || "empty",
      dataStatus: probableStarter?.dataStatus || "unannounced",
      state: probableStarter?.status || "empty",
      errorCode: probableStarter?.errorCode || null,
      lastFailureCode: probableStarter?.lastFailureCode || null,
      isConfirmed: Boolean(probableStarter?.isConfirmed),
      confirmed: Boolean(probableStarter?.isConfirmed),
      homeProbableStarter: probableStarter?.homeProbableStarter || null,
      awayProbableStarter: probableStarter?.awayProbableStarter || null,
      probableStarter
    }, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonResponse({
      ok: false,
      code: error?.code || (isPregameSchemaError(error) ? "PROBABLE_STARTER_SCHEMA_NOT_READY" : "PROBABLE_STARTER_READ_FAILED"),
      error: "予告先発情報を取得できませんでした。"
    }, Number(error?.httpStatus) || (isPregameSchemaError(error) ? 503 : 500), cors);
  }
}

function parseProbableStarterRefreshRoute(path) {
  const match = String(path || "").match(/^\/api\/admin\/games\/([^/]+)\/probable-starter\/refresh$/);
  if (!match) return null;
  try {
    return { gameId: decodeURIComponent(match[1]) };
  } catch {
    return { gameId: "" };
  }
}

function parseResultGameRoute(path) {
  const match = String(path || "").match(/^\/api\/results\/games\/([^/]+)$/);
  if (!match) return null;
  try {
    return { gameId: decodeURIComponent(match[1]) };
  } catch {
    return { gameId: "" };
  }
}

async function getResultGameMetadata(db, gameId) {
  try {
    const row = await db.prepare(
      `SELECT game_id, game_date, start_at, home_team, away_team, game_code, venue, internal_game_id
         FROM detected_game_schedule WHERE game_id = ?1 LIMIT 1`
    ).bind(gameId).first();
    if (row) {
      return serializePredictionTarget({
        gameId: row.game_id,
        date: row.game_date,
        startAt: new Date(row.start_at),
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        gameCode: row.game_code || "",
        internalGameId: row.internal_game_id || "",
        venue: row.venue || ""
      });
    }
  } catch {
    // 既存日程だけで解決できる場合は下の静的日程へ進みます。
  }
  const identity = getGameIdentityForPregame(gameId);
  return identity?.game ? serializePredictionTarget({
    ...identity.game,
    gameId,
    startAt: identity.startAt,
    gameCode: identity.gameCode
  }) : { gameId, date: "", startAt: "", startTime: "", homeTeam: "", awayTeam: "", gameCode: "", venue: "" };
}

async function handleGetResultGames(request, env, cors) {
  const access = await requireAuthenticatedUser(request, env, cors);
  const rankingColumns = await getTableColumnSet(env.AUTH_DB, "ranking_games");
  const eligibilitySelect = rankingColumns.has("ranking_eligibility_status")
    ? "ranking_games.ranking_eligibility_status, ranking_games.ranking_eligibility_reason, ranking_games.ranking_eligibility_note"
    : "NULL AS ranking_eligibility_status, NULL AS ranking_eligibility_reason, NULL AS ranking_eligibility_note";
  const eligibilityCondition = rankingColumns.has("ranking_eligibility_status")
    ? "OR ranking_games.ranking_eligibility_status <> 'eligible'"
    : "";
  if (!access.ok) return access.response;

  const rows = await env.AUTH_DB.prepare(
    `WITH latest_predictions AS (
       SELECT predictions.game_id, predictions.score, predictions.max_score, predictions.scored_at,
              predictions.updated_at, predictions.status,
              ROW_NUMBER() OVER (
                PARTITION BY predictions.user_id, predictions.game_id
                ORDER BY predictions.updated_at DESC, predictions.submitted_at DESC, predictions.id DESC
              ) AS submission_rank
          FROM predictions
         WHERE predictions.user_id = ?1 AND predictions.is_test_prediction = 0
     )
     SELECT latest_predictions.game_id, latest_predictions.score, latest_predictions.max_score,
            latest_predictions.scored_at, latest_predictions.updated_at, latest_predictions.status,
            ranking_games.game_date, ranking_games.game_status, ranking_games.publication_status,
            ${eligibilitySelect}
       FROM latest_predictions
       JOIN ranking_games ON ranking_games.game_id = latest_predictions.game_id
      WHERE latest_predictions.submission_rank = 1
        AND (
          (latest_predictions.status = 'scored'
           AND ranking_games.game_status = 'scored'
           AND ranking_games.is_ranking_eligible = 1)
          OR ranking_games.game_status = 'service_unavailable'
          ${eligibilityCondition}
        )
        AND ranking_games.is_test_game = 0
      ORDER BY ranking_games.game_date DESC, latest_predictions.updated_at DESC, latest_predictions.game_id DESC
      LIMIT 50`
  ).bind(access.user.id).all();

  const now = new Date();
  const games = [];
  for (const row of rows.results || []) {
    const metadata = await getResultGameMetadata(env.AUTH_DB, row.game_id);
    const resultsPublished = await isGameResultsPublished(env.AUTH_DB, row.game_id, now);
    const serviceUnavailable = isServiceUnavailableGameStatus(row.game_status);
    const excluded = String(row.ranking_eligibility_status || "") === "excluded" || serviceUnavailable;
    games.push({
      ...metadata,
      gameDate: row.game_date || metadata.date,
      resultsPublished,
      score: !excluded && resultsPublished && row.score !== null ? Number(row.score) : null,
      maxScore: !excluded && resultsPublished && row.max_score !== null ? Number(row.max_score) : null,
      scoredAt: !excluded ? (row.scored_at || null) : null,
      publicationStatus: row.publication_status || "scored_private",
      serviceUnavailable,
      serviceUnavailableReason: serviceUnavailable ? SCORING_RETRY_EXPIRED_CODE : null,
      serviceUnavailableMessage: serviceUnavailable ? SERVICE_UNAVAILABLE_MESSAGE : null,
      rankingEligibilityStatus: row.ranking_eligibility_status || (serviceUnavailable ? "excluded" : "eligible"),
      rankingEligibilityReason: row.ranking_eligibility_reason || (serviceUnavailable ? "data_invalid" : null),
      rankingEligibilityNote: row.ranking_eligibility_note || null,
      rankingExcluded: excluded,
      rankingExcludedMessage: excluded ? "この試合はランキング対象外です。" : null
    });
  }
  return jsonResponse({ ok: true, games }, 200, cors);
}

async function handleGetResultGame(request, env, cors, gameId) {
  const access = await requireAuthenticatedUser(request, env, cors);
  if (!access.ok) return access.response;
  const metadata = await resolvePredictionGameMetadata(env.AUTH_DB, gameId);
  if (!metadata) return jsonResponse({ ok: false, error: "対象試合のgameIdが不正です。" }, 400, cors);
  if (await isTestRankingGame(env.AUTH_DB, metadata.gameId)) {
    return jsonResponse({ ok: false, error: "テスト試合の結果は通常画面で表示できません。" }, 404, cors);
  }

  const rankingState = await getRankingGameState(env.AUTH_DB, metadata.gameId);
  const serviceUnavailable = isServiceUnavailableGameStatus(rankingState?.game_status);
  const rankingEligibility = await getRankingEligibilityState(env.AUTH_DB, metadata.gameId);
  const row = await getPredictionRow(env.AUTH_DB, access.user.id, metadata.gameId);
  if (!row) {
    return jsonResponse({ ok: false, error: "採点済みの結果が見つかりません。" }, 404, cors);
  }
  const prediction = parseStoredPrediction(row.prediction_json);
  if (!prediction) return jsonResponse({ ok: false, error: "保存済み予想の読み込みに失敗しました。" }, 500, cors);
  if (serviceUnavailable) {
    return jsonResponse({
      ok: true,
      game: await getResultGameMetadata(env.AUTH_DB, metadata.gameId),
      gameId: metadata.gameId,
      prediction,
      status: SERVICE_UNAVAILABLE_GAME_STATUS,
      submittedAt: row.submitted_at,
      updatedAt: row.updated_at,
      score: null,
      maxScore: null,
      scoredAt: null,
      actualLineup: null,
      resultsPublished: false,
      serviceUnavailable,
      serviceUnavailableReason: serviceUnavailable ? SCORING_RETRY_EXPIRED_CODE : null,
      serviceUnavailableMessage: serviceUnavailable ? SERVICE_UNAVAILABLE_MESSAGE : null,
      rankingExcluded: true,
      rankingEligibilityStatus: rankingEligibility?.rankingEligibilityStatus || "excluded",
      rankingEligibilityReason: rankingEligibility?.rankingEligibilityReason || null,
      rankingEligibilityNote: rankingEligibility?.rankingEligibilityNote || null,
      rankingEligibilityMessage: rankingEligibility?.rankingEligibilityStatus === "pending_admin_decision"
        ? "公式記録の確認中のため、ランキング対象を管理者が判断しています。"
        : "この試合はランキング対象外です。"
    }, 200, cors);
  }
  if (rankingEligibility?.rankingEligibilityStatus !== "eligible") {
    return jsonResponse({
      ok: true,
      game: await getResultGameMetadata(env.AUTH_DB, metadata.gameId),
      gameId: metadata.gameId,
      prediction,
      status: "excluded",
      submittedAt: row.submitted_at,
      updatedAt: row.updated_at,
      score: null,
      maxScore: null,
      scoredAt: null,
      actualLineup: null,
      resultsPublished: false,
      serviceUnavailable: false,
      serviceUnavailableReason: null,
      serviceUnavailableMessage: null,
      rankingExcluded: true,
      rankingEligibilityStatus: rankingEligibility?.rankingEligibilityStatus || "excluded",
      rankingEligibilityReason: rankingEligibility?.rankingEligibilityReason || null,
      rankingEligibilityNote: rankingEligibility?.rankingEligibilityNote || null,
      rankingEligibilityMessage: rankingEligibility?.rankingEligibilityStatus === "pending_admin_decision"
        ? "公式記録の確認中のため、ランキング対象を管理者が判断しています。"
        : "この試合はランキング対象外です。"
    }, 200, cors);
  }
  if (row.status !== "scored") {
    return jsonResponse({ ok: false, error: "採点済みの結果が見つかりません。" }, 404, cors);
  }
  const resultsPublished = await isGameResultsPublished(env.AUTH_DB, metadata.gameId, new Date());
  return jsonResponse({
    ok: true,
    game: await getResultGameMetadata(env.AUTH_DB, metadata.gameId),
    gameId: metadata.gameId,
    prediction,
    status: resultsPublished ? row.status : "submitted",
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    score: resultsPublished && row.score !== null ? Number(row.score) : null,
    maxScore: resultsPublished && row.max_score !== null ? Number(row.max_score) : null,
    scoredAt: resultsPublished ? row.scored_at : null,
    actualLineup: resultsPublished && row.actual_lineup_json ? parseStoredActualLineup(row.actual_lineup_json) : null,
    resultsPublished,
    serviceUnavailable: false,
    serviceUnavailableReason: null,
    serviceUnavailableMessage: null
  }, 200, cors);
}

async function getTableColumnSet(db, table) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).bind().all();
  return new Set((result.results || []).map((row) => String(row.name || "")));
}

async function saveLineupCandidateRevision(db, {
  gameId,
  internalGameId = "",
  lineup,
  source = "npb",
  capturedAt = new Date(),
  validation = null,
  reason = "NPB公式スタメン候補",
  createdBy = null,
  allowUnresolvedPlayer = false
} = {}) {
  const actual = sanitizeActualLineupForScoring(lineup, { allowUnresolvedPlayer });
  if (!actual.ok) {
    const error = createPregameError("LINEUP_REVISION_INVALID", actual.error, { httpStatus: 409 });
    error.validation = validation || null;
    throw error;
  }
  const fingerprint = await sha256Base64Url(JSON.stringify(actual.lineup));
  const columns = await getTableColumnSet(db, "game_lineup_revisions");
  const hasCanonicalIdentity = columns.has("internal_game_id") && INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || ""));
  if (internalGameId && !hasCanonicalIdentity) {
    throw createV3Error("V3_LINEUP_SCHEMA_UNAVAILABLE", "V3スタメンrevisionのUUID保存先が準備されていません。", { httpStatus: 503, retryable: false });
  }
  const latest = hasCanonicalIdentity
    ? await db.prepare(
      "SELECT * FROM game_lineup_revisions WHERE internal_game_id = ?1 ORDER BY version DESC LIMIT 1"
    ).bind(internalGameId).first()
    : await db.prepare(
      "SELECT * FROM game_lineup_revisions WHERE game_id = ?1 ORDER BY version DESC LIMIT 1"
    ).bind(gameId).first();
  if (latest && String(latest.lineup_fingerprint || "") === fingerprint) return latest;

  const createdAt = (capturedAt instanceof Date ? capturedAt : new Date(capturedAt)).toISOString();
  const storedSource = source === "npb" ? "npb-auto" : source === "admin" ? "manual-revision" : source;
  let version = Number(latest?.version || 0) + 1;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fields = ["game_id", "version", "actual_lineup_json", "lineup_fingerprint", "source", "created_at", "created_by", "reason", "is_current", "superseded_at"];
    const values = [gameId, version, JSON.stringify(actual.lineup), fingerprint, storedSource, createdAt, createdBy, reason, 0, null];
    if (columns.has("revision_id")) {
      fields.push("revision_id");
      values.push(`${gameId}:${version}`);
    }
    if (columns.has("internal_game_id")) {
      fields.push("internal_game_id");
      values.push(internalGameId || null);
    }
    if (columns.has("captured_at")) {
      fields.push("captured_at");
      values.push(createdAt);
    }
    if (columns.has("validation_json")) {
      fields.push("validation_json");
      values.push(validation ? JSON.stringify(validation) : null);
    }
    if (columns.has("unresolved_player_count")) {
      fields.push("unresolved_player_count");
      values.push(actual.lineup.filter((row) => !row.playerId).length);
    }
    const placeholders = fields.map((_, index) => `?${index + 1}`).join(", ");
    try {
      await db.prepare(
        `INSERT INTO game_lineup_revisions (${fields.join(", ")}) VALUES (${placeholders})`
      ).bind(...values).run();
      return hasCanonicalIdentity
        ? db.prepare(
          "SELECT * FROM game_lineup_revisions WHERE internal_game_id = ?1 AND version = ?2 LIMIT 1"
        ).bind(internalGameId, version).first()
        : db.prepare(
          "SELECT * FROM game_lineup_revisions WHERE game_id = ?1 AND version = ?2 LIMIT 1"
        ).bind(gameId, version).first();
    } catch (error) {
      if (!/constraint|unique|primary key/i.test(String(error?.message || "")) || attempt === 1) throw error;
      const concurrent = hasCanonicalIdentity
        ? await db.prepare(
          "SELECT * FROM game_lineup_revisions WHERE internal_game_id = ?1 ORDER BY version DESC LIMIT 1"
        ).bind(internalGameId).first()
        : await db.prepare(
          "SELECT * FROM game_lineup_revisions WHERE game_id = ?1 ORDER BY version DESC LIMIT 1"
        ).bind(gameId).first();
      if (concurrent && String(concurrent.lineup_fingerprint || "") === fingerprint) return concurrent;
      version = Number(concurrent?.version || version) + 1;
    }
  }
  throw createPregameError("V3_LINEUP_REVISION_CONFLICT", "スタメンrevisionの作成が競合しました。", { httpStatus: 409 });
}

async function activateLineupRevision(db, { gameId, version, internalGameId = "", finalizedAt = new Date(), finalizedBy = "system" } = {}) {
  const finalizedAtIso = (finalizedAt instanceof Date ? finalizedAt : new Date(finalizedAt)).toISOString();
  const columns = await getTableColumnSet(db, "game_lineup_revisions");
  const hasCanonicalIdentity = columns.has("internal_game_id") && INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || ""));
  if (internalGameId && !hasCanonicalIdentity) {
    throw createV3Error("V3_LINEUP_SCHEMA_UNAVAILABLE", "V3スタメンrevisionのUUID保存先が準備されていません。", { httpStatus: 503, retryable: false });
  }
  const updateFields = ["is_current = 1"];
  const bindings = [];
  const addBinding = (column, value) => {
    updateFields.push(`${column} = ?${bindings.length + 1}`);
    bindings.push(value);
  };
  if (columns.has("finalized_at")) addBinding("finalized_at", finalizedAtIso);
  if (columns.has("finalized_by")) addBinding("finalized_by", finalizedBy);
  if (columns.has("internal_game_id")) addBinding("internal_game_id", internalGameId || null);
  if (columns.has("is_final")) addBinding("is_final", 1);
  const gameIdPlaceholder = `?${bindings.length + 1}`;
  bindings.push(hasCanonicalIdentity ? internalGameId : gameId);
  const versionPlaceholder = `?${bindings.length + 1}`;
  bindings.push(Number(version));
  await db.batch([
    hasCanonicalIdentity
      ? db.prepare("UPDATE game_lineup_revisions SET is_current = 0, superseded_at = ?1 WHERE internal_game_id = ?2 AND is_current = 1").bind(finalizedAtIso, internalGameId)
      : db.prepare("UPDATE game_lineup_revisions SET is_current = 0, superseded_at = ?1 WHERE game_id = ?2 AND is_current = 1").bind(finalizedAtIso, gameId),
    db.prepare(`UPDATE game_lineup_revisions SET ${updateFields.join(", ")} WHERE ${hasCanonicalIdentity ? "internal_game_id" : "game_id"} = ${gameIdPlaceholder} AND version = ${versionPlaceholder}`).bind(...bindings)
  ]);
  return hasCanonicalIdentity
    ? db.prepare("SELECT * FROM game_lineup_revisions WHERE internal_game_id = ?1 AND version = ?2 LIMIT 1").bind(internalGameId, Number(version)).first()
    : getLineupRevision(db, gameId, version);
}

async function linkFinalLineupRevision(db, { gameId, internalGameId = "", version, finalizedAt = new Date(), finalizedBy = "system" } = {}) {
  const columns = await getTableColumnSet(db, "game_lineups");
  const fields = [];
  const values = [];
  if (columns.has("final_lineup_revision_id")) {
    fields.push("final_lineup_revision_id = ?1");
    values.push(`${gameId}:${Number(version)}`);
  }
  if (columns.has("finalized_at")) {
    fields.push(`finalized_at = ?${values.length + 1}`);
    values.push((finalizedAt instanceof Date ? finalizedAt : new Date(finalizedAt)).toISOString());
  }
  if (columns.has("finalized_by")) {
    fields.push(`finalized_by = ?${values.length + 1}`);
    values.push(finalizedBy);
  }
  if (!fields.length) return;
  if (internalGameId && !columns.has("internal_game_id")) {
    throw createV3Error("V3_LINEUP_SCHEMA_UNAVAILABLE", "V3正式スタメンのcanonical schemaが準備されていません。", {
      httpStatus: 503,
      retryable: false
    });
  }
  if (columns.has("internal_game_id") && INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || ""))) {
    values.push(internalGameId);
    await db.prepare(`UPDATE game_lineups SET ${fields.join(", ")} WHERE internal_game_id = ?${values.length}`).bind(...values).run();
    return;
  }
  values.push(gameId);
  await db.prepare(`UPDATE game_lineups SET ${fields.join(", ")} WHERE game_id = ?${values.length}`).bind(...values).run();
}

async function saveProvisionalOfficialLineup(db, gameId, lineup, detectedAt, now, options = {}) {
  const revision = await saveLineupCandidateRevision(db, {
    gameId,
    internalGameId: options.internalGameId || "",
    lineup,
    source: "npb",
    capturedAt: detectedAt,
    validation: options.validation || null,
    allowUnresolvedPlayer: true
  });
  if (options.source !== "v3") {
    await db.prepare(
      `UPDATE game_pregame_automation
          SET lineup_status = 'captured', provisional_lineup_json = ?1,
              provisional_lineup_detected_at = ?2, lineup_attempt_count = lineup_attempt_count + 1,
              last_lineup_attempt_at = ?3, next_lineup_attempt_at = NULL,
              last_error_code = NULL, last_error_message = NULL, updated_at = ?3
        WHERE game_id = ?4`
    ).bind(JSON.stringify(lineup), detectedAt.toISOString(), now.toISOString(), gameId).run();
  }
  return revision;
}

async function useProvisionalLineupFallback(env, gameId, identity, now, finalError) {
  const job = await env.AUTH_DB.prepare(
    "SELECT provisional_lineup_json, provisional_lineup_detected_at FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1"
  ).bind(gameId).first();
  const provisional = parseStoredActualLineup(job?.provisional_lineup_json);
  const strictResult = sanitizeActualLineupForScoring(provisional);
  const actualResult = strictResult.ok
    ? strictResult
    : sanitizeActualLineupForScoring(provisional, { allowUnresolvedPlayer: true });
  if (!actualResult.ok) return { used: false };

  const detectedAt = parseLineupDetectedAt(job?.provisional_lineup_detected_at) || now;
  const revision = await saveLineupCandidateRevision(env.AUTH_DB, {
    gameId,
    internalGameId: identity.internalGameId || "",
    lineup: actualResult.lineup,
    source: "npb",
    capturedAt: detectedAt,
    reason: "保存済み候補の最終確定",
    allowUnresolvedPlayer: true
  });
  const record = await approveActualLineupForAutoScoring(env, gameId, actualResult.lineup, detectedAt, {
    source: "npb-auto",
    scoringDueAt: new Date(identity.startAt.getTime() + 2 * 60 * 1000),
    now,
    allowAfterStart: true,
    preventOverwrite: true,
    internalGameId: identity.internalGameId || ""
  });
  await activateLineupRevision(env.AUTH_DB, { gameId, version: revision.version, internalGameId: identity.internalGameId || "", finalizedAt: now, finalizedBy: "system" });
  await linkFinalLineupRevision(env.AUTH_DB, { gameId, internalGameId: identity.internalGameId || "", version: revision.version, finalizedAt: now, finalizedBy: "system" });
  const errorCode = classifyLineupErrorCode(finalError);
  await env.AUTH_DB.prepare(
    `UPDATE game_pregame_automation
        SET lineup_status = 'captured', lineup_captured_at = ?1,
            final_lineup_attempt_at = ?1, next_lineup_attempt_at = NULL,
            final_lineup_fallback_used = 1, final_lineup_error_code = ?2,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?1
      WHERE game_id = ?3`
  ).bind(now.toISOString(), errorCode, gameId).run();
  return { used: true, record, revision, errorCode };
}

async function recordPregameError(db, gameId, area, error, now) {
  const code = String(error?.code || "NPB_HTTP_ERROR").slice(0, 80);
  const message = String(error?.message || "取得に失敗しました。").slice(0, 240);
  const column = area === "roster" ? "roster_status" : "lineup_status";
  await db.prepare(
    `UPDATE game_pregame_automation SET ${column} = 'failed', last_error_code = ?1, last_error_message = ?2, updated_at = ?3 WHERE game_id = ?4`
  ).bind(code, message, now.toISOString(), gameId).run();
}

async function recordPregameLineupAttempt(db, gameId, identity, now, error, phase = "provisional") {
  const next = new Date(now.getTime() + 10 * 60 * 1000);
  const errorCode = classifyLineupErrorCode(error);
  await db.prepare(
    `UPDATE game_pregame_automation
        SET lineup_status = 'failed', lineup_attempt_count = lineup_attempt_count + 1, last_lineup_attempt_at = ?1,
            final_lineup_attempt_at = CASE WHEN ?5 = 'final' THEN ?1 ELSE final_lineup_attempt_at END,
            next_lineup_attempt_at = CASE WHEN ?5 = 'final' OR ?2 <= ?6 THEN ?2 ELSE NULL END,
            last_error_code = ?3, last_error_message = ?4, updated_at = ?1
      WHERE game_id = ?7`
  ).bind(now.toISOString(), next.toISOString(), errorCode, String(error?.message || "取得に失敗しました。").slice(0, 240), phase, identity.startAt.toISOString(), gameId).run();
}

function classifyLineupErrorCode(error) {
  const raw = String(error?.code || "LINEUP_FETCH_FAILED").slice(0, 80);
  if (["GAME_NOT_FOUND", "SCHEDULE_UNAVAILABLE"].includes(raw)) return "LINEUP_GAME_NOT_FOUND";
  if (raw === "LINEUP_URL_BUILD_FAILED") return raw;
  if (["NPB_HTTP_ERROR", "NPB_WORKER_HTTP_ERROR", "NPB_WORKER_TIMEOUT", "NPB_SERVICE_BINDING_MISSING", "NPB_SERVICE_BINDING_INVALID"].includes(raw)) {
    return "LINEUP_HTTP_ERROR";
  }
  if (["LINEUP_NOT_PUBLISHED", "LINEUP_NOT_ANNOUNCED"].includes(raw)) return "LINEUP_NOT_ANNOUNCED";
  if (["PARSE_FAILED", "NPB_RESPONSE_INVALID", "INVALID_LINEUP", "LINEUP_PARSE_FAILED"].includes(raw)) return "LINEUP_PARSE_FAILED";
  if (["LINEUP_INVALID_PLAYER_COUNT", "LINEUP_INVALID_POSITION", "LINEUP_PLAYER_RESOLUTION_FAILED", "LINEUP_DUPLICATE_PLAYER", "LINEUP_SAVE_FAILED"].includes(raw)) return raw;
  if (/^(D1|SQLITE|SQLITE_CONSTRAINT|DATABASE)_/i.test(raw)) return "LINEUP_SAVE_FAILED";
  return raw.startsWith("LINEUP_") ? raw : "LINEUP_FETCH_FAILED";
}

async function recordPregameLineupDeferred(db, gameId, identity, now) {
  const next = new Date(now.getTime() + 10 * 60 * 1000);
  await db.prepare(
    `UPDATE game_pregame_automation
        SET lineup_status = 'pending', lineup_attempt_count = lineup_attempt_count + 1, last_lineup_attempt_at = ?1,
            next_lineup_attempt_at = ?2, last_error_code = NULL, last_error_message = NULL, updated_at = ?1
      WHERE game_id = ?3`
  ).bind(now.toISOString(), next <= identity.startAt ? next.toISOString() : null, gameId).run();
}

const SCORING_RETRY_EXPIRED_CODE = "SCORING_RETRY_EXPIRED";
const SERVICE_UNAVAILABLE_GAME_STATUS = "service_unavailable";
const SERVICE_UNAVAILABLE_MESSAGE = "この試合はサービス未稼働のため集計対象外です。";

function isServiceUnavailableGameStatus(status) {
  return String(status || "") === SERVICE_UNAVAILABLE_GAME_STATUS;
}

async function getRankingGameState(db, gameId, internalGameId = "") {
  const columns = await getTableColumnSet(db, "ranking_games");
  if (internalGameId && !columns.has("internal_game_id")) return null;
  const optional = [
    "ranking_eligibility_status", "ranking_eligibility_reason", "ranking_eligibility_note",
    "ranking_eligibility_version", "ranking_eligibility_updated_by", "ranking_eligibility_updated_at"
  ].filter((column) => columns.has(column));
  const canonical = columns.has("internal_game_id") && INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || ""));
  return canonical
    ? db.prepare(
      `SELECT game_id, internal_game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status,
              is_test_game, publication_status, scored_private_at, published_at${optional.length ? `, ${optional.join(", ")}` : ""}
         FROM ranking_games
        WHERE internal_game_id = ?1
        LIMIT 1`
    ).bind(internalGameId).first()
    : db.prepare(
      `SELECT game_id, internal_game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status,
              is_test_game, publication_status, scored_private_at, published_at${optional.length ? `, ${optional.join(", ")}` : ""}
         FROM ranking_games WHERE game_id = ?1 LIMIT 1`
    ).bind(gameId).first();
}

async function getRankingEligibilityState(db, gameId, internalGameId = "") {
  const row = await getRankingGameState(db, gameId, internalGameId);
  if (!row) return null;
  const status = normalizeRankingEligibilityStatus(row.ranking_eligibility_status
    || (Number(row.is_ranking_eligible || 0) === 1 ? RANKING_ELIGIBILITY_STATUS.ELIGIBLE : RANKING_ELIGIBILITY_STATUS.EXCLUDED));
  return {
    gameId: row.game_id,
    internalGameId: row.internal_game_id || null,
    rankingEligible: status === RANKING_ELIGIBILITY_STATUS.ELIGIBLE && Number(row.is_ranking_eligible || 0) === 1,
    rankingEligibilityStatus: status,
    rankingEligibilityReason: row.ranking_eligibility_reason || null,
    rankingEligibilityNote: row.ranking_eligibility_note || null,
    rankingEligibilityVersion: Math.max(1, Number(row.ranking_eligibility_version || 1)),
    rankingEligibilityUpdatedBy: row.ranking_eligibility_updated_by || "system",
    rankingEligibilityUpdatedAt: row.ranking_eligibility_updated_at || row.updated_at || null,
    gameStatus: row.game_status || "pending",
    publicationStatus: row.publication_status || "pending"
  };
}

async function isGameEligibleForScoring(db, gameId) {
  const eligibility = await getRankingEligibilityState(db, gameId);
  return !eligibility || eligibility.rankingEligibilityStatus === RANKING_ELIGIBILITY_STATUS.ELIGIBLE;
}

async function setCanonicalEligibilityWorkflowStatus(db, internalGameId, canonicalStatus, now) {
  if (!internalGameId) return false;
  const columns = await getTableColumnSet(db, "game_workflow_state");
  if (!columns.has("canonical_status")) return false;
  const result = await db.prepare(
    `UPDATE game_workflow_state
        SET canonical_status = ?1, state_updated_by = 'admin', state_updated_at = ?2, updated_at = ?2
      WHERE internal_game_id = ?3`
  ).bind(canonicalStatus, now.toISOString(), internalGameId).run();
  return Number(result?.meta?.changes || 0) === 1;
}

async function cancelUnstartedRankingJobs(db, internalGameId, now) {
  if (!internalGameId) return 0;
  const result = await db.prepare(
    `UPDATE game_job_runs
        SET status = 'cancelled', lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?1
      WHERE internal_game_id = ?2
        AND job_type IN ('provisional_lineup_fetch', 'final_lineup_fetch', 'scoring', 'ranking_update', 'publication')
        AND status IN ('pending', 'retry_wait')`
  ).bind(now.toISOString(), internalGameId).run();
  return Number(result?.meta?.changes || 0);
}

async function recordRankingReflectionRevision(db, {
  internalGameId = "", scoringRevisionId = "none", eligibilityVersion = 1,
  status = "reflected", now = new Date()
} = {}) {
  if (!internalGameId) return null;
  try {
    const latest = await db.prepare(
      "SELECT COALESCE(MAX(ranking_update_revision), 0) AS revision FROM ranking_reflection_revisions WHERE internal_game_id = ?1"
    ).bind(internalGameId).first();
    const updateRevision = Number(latest?.revision || 0) + 1;
    const id = `${internalGameId}:${scoringRevisionId}:${Number(eligibilityVersion || 1)}`;
    await db.prepare(
      `INSERT INTO ranking_reflection_revisions
         (id, internal_game_id, scoring_revision_id, ranking_eligibility_version,
          ranking_update_revision, status, reflected_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
       ON CONFLICT(internal_game_id, scoring_revision_id, ranking_eligibility_version) DO UPDATE SET
         status = excluded.status, reflected_at = excluded.reflected_at,
         ranking_update_revision = excluded.ranking_update_revision`
    ).bind(id, internalGameId, scoringRevisionId, Math.max(1, Number(eligibilityVersion || 1)), updateRevision, status, status === "pending" ? null : now.toISOString()).run();
    return { id, rankingUpdateRevision: updateRevision, status };
  } catch (error) {
    if (isPregameSchemaError(error)) return null;
    throw error;
  }
}

async function setRankingEligibility(db, {
  gameId, internalGameId = "", status, reason = null, note = null,
  updatedBy = "admin", now = new Date()
} = {}) {
  const nextStatus = normalizeRankingEligibilityStatus(status);
  if (!gameId) throw createPregameError("RANKING_GAME_REQUIRED", "対象試合がありません。", { httpStatus: 400 });
  if (nextStatus === RANKING_ELIGIBILITY_STATUS.EXCLUDED && !String(reason || "").trim()) {
    throw createPregameError("RANKING_ELIGIBILITY_REASON_REQUIRED", "対象外理由を入力してください。", { httpStatus: 400 });
  }
  const current = await getRankingGameState(db, gameId);
  if (!current) throw createPregameError("RANKING_GAME_NOT_FOUND", "対象試合が見つかりません。", { httpStatus: 404 });
  const columns = await getTableColumnSet(db, "ranking_games");
  const previous = await getRankingEligibilityState(db, gameId);
  const version = Math.max(1, Number(previous?.rankingEligibilityVersion || 1) + (previous?.rankingEligibilityStatus === nextStatus && String(previous?.rankingEligibilityReason || "") === String(reason || "") && String(previous?.rankingEligibilityNote || "") === String(note || "") ? 0 : 1));
  const fields = ["is_ranking_eligible = ?1", "ranking_eligible_at = CASE WHEN ?1 = 1 THEN ?2 ELSE NULL END"];
  const values = [nextStatus === RANKING_ELIGIBILITY_STATUS.ELIGIBLE ? 1 : 0, now.toISOString()];
  const add = (column, value) => { if (columns.has(column)) { fields.push(`${column} = ?${values.length + 1}`); values.push(value); } };
  add("ranking_eligibility_status", nextStatus);
  add("ranking_eligibility_reason", nextStatus === RANKING_ELIGIBILITY_STATUS.ELIGIBLE ? null : normalizeRankingEligibilityReason(reason));
  add("ranking_eligibility_note", String(note || "").trim().slice(0, 500) || null);
  add("ranking_eligibility_version", version);
  add("ranking_eligibility_updated_by", String(updatedBy || "admin").slice(0, 120));
  add("ranking_eligibility_updated_at", now.toISOString());
  if (nextStatus !== RANKING_ELIGIBILITY_STATUS.ELIGIBLE) {
    add("publication_status", "pending");
    add("published_at", null);
  }
  fields.push(`updated_at = ?${values.length + 1}`);
  values.push(now.toISOString());
  values.push(gameId);
  const changed = await db.prepare(`UPDATE ranking_games SET ${fields.join(", ")} WHERE game_id = ?${values.length}`).bind(...values).run();
  if (Number(changed?.meta?.changes || 0) !== 1) throw createPregameError("RANKING_ELIGIBILITY_UPDATE_FAILED", "ランキング対象状態を更新できませんでした。");
  try {
    await db.prepare(
      `INSERT INTO ranking_eligibility_history
         (internal_game_id, game_id, previous_status, next_status, reason, note, version, updated_by, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(internalGameId || current.internal_game_id || null, gameId, previous?.rankingEligibilityStatus || null, nextStatus, nextStatus === "eligible" ? null : normalizeRankingEligibilityReason(reason), String(note || "").trim().slice(0, 500) || null, version, String(updatedBy || "admin").slice(0, 120), now.toISOString()).run();
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  if (nextStatus === RANKING_ELIGIBILITY_STATUS.EXCLUDED) {
    await cancelUnstartedRankingJobs(db, internalGameId || current.internal_game_id || "", now);
    await setCanonicalEligibilityWorkflowStatus(db, internalGameId || current.internal_game_id || "", "ranking_excluded", now);
    await recordRankingReflectionRevision(db, { internalGameId: internalGameId || current.internal_game_id || "", eligibilityVersion: version, status: "excluded", now });
  } else if (nextStatus === RANKING_ELIGIBILITY_STATUS.PENDING_ADMIN_DECISION) {
    await cancelUnstartedRankingJobs(db, internalGameId || current.internal_game_id || "", now);
    await setCanonicalEligibilityWorkflowStatus(db, internalGameId || current.internal_game_id || "", "ranking_exclusion_pending", now);
  } else {
    await setCanonicalEligibilityWorkflowStatus(db, internalGameId || current.internal_game_id || "", "ranking_reflected", now);
    await recordRankingReflectionRevision(db, { internalGameId: internalGameId || current.internal_game_id || "", eligibilityVersion: version, status: "reflected", now });
  }
  return await getRankingEligibilityState(db, gameId);
}

async function handleAdminRankingEligibilityUpdate(request, env, cors, metadata, user) {
  try {
    const input = await readJson(request);
    const requestedStatus = String(input?.status || "").trim().toLowerCase();
    const status = normalizeRankingEligibilityStatus(requestedStatus);
    if (!Object.values(RANKING_ELIGIBILITY_STATUS).includes(requestedStatus)) {
      return jsonResponse({ ok: false, code: "RANKING_ELIGIBILITY_STATUS_INVALID", error: "ランキング対象状態が不正です。" }, 400, cors);
    }
    const rankingEligibility = await setRankingEligibility(env.AUTH_DB, {
      gameId: metadata.gameId,
      internalGameId: metadata.internalGameId,
      status,
      reason: input?.reason,
      note: input?.note,
      updatedBy: user?.id ? `admin:${user.id}` : "admin",
      now: new Date()
    });
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "ranking_eligibility_changed",
      status: "success",
      gameId: metadata.gameId,
      occurredAt: new Date(),
      message: "ランキング対象状態を更新しました。",
      metadata: { internalGameId: metadata.internalGameId, status, reason: input?.reason || null },
      source: "admin"
    });
    return jsonResponse({ ok: true, gameId: metadata.gameId, rankingEligibility }, 200, cors);
  } catch (error) {
    return jsonResponse({ ok: false, code: String(error?.code || "RANKING_ELIGIBILITY_UPDATE_FAILED"), error: error?.message || "ランキング対象状態を更新できませんでした。" }, Number(error?.httpStatus) || 500, cors);
  }
}

async function isServiceUnavailableGame(db, gameId) {
  const row = await getRankingGameState(db, gameId);
  return isServiceUnavailableGameStatus(row?.game_status);
}

async function markGameServiceUnavailable(db, gameId, at, reasonCode = SCORING_RETRY_EXPIRED_CODE, internalGameId = "") {
  const metadata = parsePredictionGameId(gameId);
  if (!metadata) return false;
  const now = toIsoString(at);
  const existing = await getRankingGameState(db, gameId);
  if (Number(existing?.is_test_game || 0) === 1 || ["scored", "cancelled"].includes(existing?.game_status)) return false;
  const storage = await getInternalGameIdStorageAvailability(db, ["ranking_games"]);
  if (storage.ranking_games) {
    internalGameId = (await requireInternalGameIdForWrite(db, { table: "ranking_games", gameId, internalGameId })).internalGameId;
  }
  const internalColumn = storage.ranking_games ? ", internal_game_id" : "";
  const internalValue = storage.ranking_games ? ", ?2" : "";
  await db.prepare(
    `INSERT INTO ranking_games
       (game_id${internalColumn}, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
        publication_status, scored_private_at, published_at, created_at, updated_at)
     VALUES (?1${internalValue}, ?${storage.ranking_games ? 4 : 2}, 0, NULL, ?${storage.ranking_games ? 5 : 3}, 0, 'pending', NULL, NULL, ?${storage.ranking_games ? 6 : 4}, ?${storage.ranking_games ? 6 : 4})
     ON CONFLICT(game_id) DO UPDATE SET
       ${storage.ranking_games ? "internal_game_id = excluded.internal_game_id," : ""}
       game_date = excluded.game_date,
       is_ranking_eligible = 0,
       ranking_eligible_at = NULL,
       game_status = excluded.game_status,
       is_test_game = 0,
       publication_status = 'pending',
       scored_private_at = NULL,
       published_at = NULL,
       updated_at = excluded.updated_at`
  ).bind(...(storage.ranking_games
    ? [gameId, internalGameId, metadata.date, SERVICE_UNAVAILABLE_GAME_STATUS, now]
    : [gameId, metadata.date, SERVICE_UNAVAILABLE_GAME_STATUS, now])).run();
  const current = await getRankingGameState(db, gameId);
  if (current) {
    await setRankingEligibility(db, {
      gameId,
      internalGameId: current.internal_game_id || internalGameId || "",
      status: RANKING_ELIGIBILITY_STATUS.EXCLUDED,
      reason: "data_invalid",
      updatedBy: "system",
      now: at instanceof Date ? at : new Date(at)
    });
  }
  return true;
}

async function recordScoringRetryExpiredOnce(db, timeline, now, previousErrorCode = "") {
  const gameId = String(timeline?.gameId || "");
  const retryDeadlineAt = getFinalLineupRetryDeadline(timeline);
  if (!gameId || !retryDeadlineAt) return false;
  try {
    const state = await db.prepare(
      "SELECT last_error_code FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1"
    ).bind(gameId).first();
    if (state?.last_error_code === SCORING_RETRY_EXPIRED_CODE) {
      try {
        await markGameServiceUnavailable(db, gameId, now, SCORING_RETRY_EXPIRED_CODE);
      } catch (error) {
        console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=service_unavailable action=state_record status=failed code=${error?.code || "SERVICE_UNAVAILABLE_STATE_FAILED"}`);
      }
      return false;
    }
    const existingLog = await db.prepare(
      `SELECT id FROM game_workflow_logs
         WHERE event_type = 'scoring_retry_expired'
           AND game_id = ?1
           AND status = 'warning'
           AND error_code = ?2
         LIMIT 1`
    ).bind(gameId, SCORING_RETRY_EXPIRED_CODE).first();
    if (existingLog) {
      try {
        await markGameServiceUnavailable(db, gameId, now, SCORING_RETRY_EXPIRED_CODE);
      } catch (error) {
        console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=service_unavailable action=state_record status=failed code=${error?.code || "SERVICE_UNAVAILABLE_STATE_FAILED"}`);
      }
      await db.prepare(
        `UPDATE game_pregame_automation
            SET last_error_code = ?1, next_lineup_attempt_at = NULL, updated_at = ?2
          WHERE game_id = ?3`
      ).bind(SCORING_RETRY_EXPIRED_CODE, now.toISOString(), gameId).run();
      return false;
    }
    const claim = await db.prepare(
      `UPDATE game_pregame_automation
          SET last_error_code = ?1,
              last_error_message = ?2,
              next_lineup_attempt_at = NULL,
              updated_at = ?3
        WHERE game_id = ?4
          AND (last_error_code IS NULL OR last_error_code <> ?1)`
    ).bind(
      SCORING_RETRY_EXPIRED_CODE,
      "最終スタメンを取得できないまま再試行期限を迎えました。",
      now.toISOString(),
      gameId
    ).run();
    if (Number(claim?.meta?.changes || 0) !== 1) return false;
    try {
      await markGameServiceUnavailable(db, gameId, now, SCORING_RETRY_EXPIRED_CODE);
    } catch (error) {
      console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=service_unavailable action=state_record status=failed code=${error?.code || "SERVICE_UNAVAILABLE_STATE_FAILED"}`);
    }
    await recordWorkflowLog(db, {
      eventType: "scoring_retry_expired",
      status: "warning",
      gameId,
      occurredAt: now,
      message: "最終スタメンを取得できないまま再試行期限を迎えたため、自動採点を終了しました。",
      errorCode: SCORING_RETRY_EXPIRED_CODE,
      metadata: {
        processName: "scoring_retry",
        gameId,
        gameDate: timeline?.game?.date || timeline?.date || null,
        scheduledStartAt: timeline.startAt?.toISOString?.() || null,
        retryDeadlineAt: retryDeadlineAt.toISOString(),
        attemptedAt: now.toISOString(),
        previousErrorCode: String(previousErrorCode || ""),
        reason: "final_lineup_retry_window_expired"
      },
      source: "cron"
    });
    return true;
  } catch (error) {
    console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=scoring_retry action=expire status=failed code=${error?.code || "SCORING_RETRY_EXPIRY_FAILED"}`);
    return false;
  }
}

const COMPLETION_WORKFLOW_JOB_TYPES = Object.freeze([
  "provisional_lineup_fetch", "final_lineup_fetch", "scoring", "ranking_update", "publication", "rescore"
]);

function getCompletionJobScheduledSlot(timeline, jobType, now = new Date()) {
  const startAt = timeline?.startAt instanceof Date ? timeline.startAt : new Date(timeline?.startAt);
  if (jobType === "provisional_lineup_fetch") return timeline?.lineupFetchStartAt || startAt;
  if (jobType === "final_lineup_fetch") return timeline?.finalLineupFetchAt || new Date(startAt.getTime() + 60 * 1000);
  if (jobType === "scoring" || jobType === "ranking_update") return new Date(startAt.getTime() + 2 * 60 * 1000);
  if (jobType === "publication") return timeline?.resultReleaseAt || new Date(startAt.getTime() + 5 * 60 * 1000);
  return now;
}

async function shouldUseCompletionWorkflowJobs(env) {
  if (String(env.ENABLE_WORKFLOW_COMPLETION_JOBS || "").toLowerCase() !== "true") return false;
  try {
    return await isGameWorkflowJobSchemaReady(env.AUTH_DB);
  } catch (error) {
    if (!isPregameSchemaError(error)) console.warn(`completion workflow schema check failed: ${error?.code || "unknown"}`);
    return false;
  }
}

async function createCompletionWorkflowJob(db, timeline, jobType, now, source = "cron", scheduledSlotAt = null) {
  const internalGameId = String(timeline?.game?.internalGameId || timeline?.internalGameId || "");
  if (!internalGameId) return false;
  const currentState = await db.prepare(
    "SELECT workflow_status, game_status FROM game_workflow_state WHERE internal_game_id = ?1 LIMIT 1"
  ).bind(internalGameId).first();
  if (currentState && (
    ["published", "service_unavailable", "manual_intervention_required", "cancelled"].includes(String(currentState.workflow_status || ""))
    || ["cancelled", "postponed", "service_unavailable"].includes(String(currentState.game_status || ""))
  )) {
    return false;
  }
  await ensureGameWorkflowState(db, {
    internalGameId,
    legacyGameId: timeline.gameId,
    gameStatus: timeline.game?.status === "cancelled" ? "cancelled" : "scheduled",
    workflowStatus: "prediction_open",
    now
  });
  const created = await createWorkflowJob(db, {
    internalGameId,
    jobType,
    scheduledSlotAt: scheduledSlotAt || getCompletionJobScheduledSlot(timeline, jobType, now),
    source,
    maxAttempts: jobType.includes("lineup") ? 72 : 5,
    now
  });
  return created.created;
}

async function ensureCompletionWorkflowJob(db, timeline, jobType, now, source = "cron") {
  const internalGameId = String(timeline?.game?.internalGameId || timeline?.internalGameId || "");
  if (!internalGameId) return { created: false, reason: "internal_id_missing" };
  const existing = await db.prepare(
    `SELECT id, status FROM game_job_runs
      WHERE internal_game_id = ?1 AND job_type = ?2 AND status <> 'cancelled'
      ORDER BY id DESC LIMIT 1`
  ).bind(internalGameId, jobType).first();
  if (existing) return { created: false, reason: "already_exists", job: existing };
  const created = await createCompletionWorkflowJob(db, timeline, jobType, now, source);
  return { created, reason: created ? "created" : "already_exists" };
}

async function recordCreatedCompletionJob(db, timeline, jobType, now, source = "cron") {
  const result = await ensureCompletionWorkflowJob(db, timeline, jobType, now, source);
  if (result.created) {
    await recordWorkflowJobEvent(db, {
      eventType: "workflow_job_created",
      status: "info",
      internalGameId: timeline.game.internalGameId || timeline.internalGameId,
      job: { legacyGameId: timeline.gameId, job_type: jobType },
      now,
      source
    });
  }
  return result;
}

async function getRankingReflectionState(db, gameId) {
  const row = await getRankingGameState(db, gameId);
  const eligibilityStatus = normalizeRankingEligibilityStatus(row?.ranking_eligibility_status
    || (Number(row?.is_ranking_eligible || 0) === 1 ? "eligible" : "excluded"));
  return {
    row,
    reflected: Boolean(row
      && Number(row.is_ranking_eligible || 0) === 1
      && eligibilityStatus === "eligible"
      && String(row.game_status || "") === "scored"
      && String(row.publication_status || "") !== "pending")
  };
}

async function getActiveScoringRevision(db, internalGameId) {
  if (!internalGameId) return null;
  try {
    const columns = await getTableColumnSet(db, "game_scoring_revisions");
    if (!columns.size) return null;
    return await db.prepare(
      `SELECT id, revision_number, lineup_revision_id, status, created_at
         FROM game_scoring_revisions
        WHERE internal_game_id = ?1 AND is_active = 1 AND status = 'completed'
        ORDER BY revision_number DESC LIMIT 1`
    ).bind(internalGameId).first();
  } catch (error) {
    if (isPregameSchemaError(error)) return null;
    throw error;
  }
}

async function getScoringCompletionState(db, { gameId = "", internalGameId = "" } = {}) {
  const columns = await getTableColumnSet(db, "predictions");
  if (internalGameId && !columns.has("internal_game_id")) {
    throw createV3Error("V3_SCORING_SCHEMA_UNAVAILABLE", "V3採点のUUID保存先が準備されていません。", { httpStatus: 503, retryable: false });
  }
  const hasInternalId = columns.has("internal_game_id") && internalGameId;
  const scope = hasInternalId ? "internal_game_id = ?1" : "game_id = ?1";
  const bindings = [hasInternalId ? internalGameId : gameId];
  const rows = await db.prepare(
    `SELECT
       COUNT(*) AS total_count,
       SUM(CASE WHEN ${columns.has("scoring_status") ? "scoring_status = 'scored'" : "status = 'scored'"} THEN 1 ELSE 0 END) AS scored_count,
       SUM(CASE WHEN ${columns.has("scoring_status") ? "scoring_status = 'excluded'" : "0"} THEN 1 ELSE 0 END) AS excluded_count,
       SUM(CASE WHEN ${columns.has("scoring_status") ? "scoring_status = 'failed'" : "0"} THEN 1 ELSE 0 END) AS failed_count
       FROM predictions WHERE ${scope} AND is_test_prediction = 0`
  ).bind(...bindings).first();
  const total = Number(rows?.total_count || 0);
  const excluded = Number(rows?.excluded_count || 0);
  const state = {
    eligiblePredictionCount: Math.max(0, total - excluded),
    scoredPredictionCount: Number(rows?.scored_count || 0),
    excludedPredictionCount: excluded,
    failedPredictionCount: Number(rows?.failed_count || 0)
  };
  const revision = await getActiveScoringRevision(db, internalGameId);
  return {
    ...state,
    scoringRevisionId: revision?.id || "legacy",
    scoringRevisionNumber: Number(revision?.revision_number || 1),
    activeRevision: revision,
    complete: isScoringComplete(state) && (!internalGameId || !revision || revision.status === "completed")
  };
}

async function ensureWorkflowScoringPending(db, internalGameId, now) {
  const state = await db.prepare(
    "SELECT workflow_status FROM game_workflow_state WHERE internal_game_id = ?1 LIMIT 1"
  ).bind(String(internalGameId || "")).first();
  if (!state) throw createPregameError("WORKFLOW_STATE_NOT_FOUND", "試合進行状態がありません。");
  if (["scoring_pending", "scored_private", "published"].includes(String(state.workflow_status || ""))) return state.workflow_status;
  await transitionWorkflowState(db, { internalGameId, to: "scoring_pending", now });
  return "scoring_pending";
}

const STALE_PREGAME_SCHEDULE_ERROR_CODES = new Set([
  "SCHEDULE_UNAVAILABLE",
  "SCHEDULE_NOT_PUBLISHED",
  "GAME_NOT_FOUND"
]);
const PUBLICATION_WORKFLOW_TERMINAL_STATUSES = new Set([
  "published",
  "service_unavailable",
  "manual_intervention_required"
]);

export function getPublicationWorkflowReconciliationEligibility({
  workflowStatus = "",
  publicationStatus = "",
  publishedAt = null,
  finalLineupScored = false,
  rankingReflected = false,
  internalGameIdMatches = false,
  identifierConflict = false
} = {}) {
  const workflow = String(workflowStatus || "");
  const publication = String(publicationStatus || "");
  if (!internalGameIdMatches) return { eligible: false, reasonCode: "PUBLICATION_INTERNAL_ID_MISMATCH" };
  if (identifierConflict) return { eligible: false, reasonCode: "PUBLICATION_IDENTIFIER_CONFLICT" };
  if (!finalLineupScored) return { eligible: false, reasonCode: "PUBLICATION_SCORING_REQUIRED" };
  if (publication !== "published" || !publishedAt) return { eligible: false, reasonCode: "PUBLICATION_DATA_NOT_PERSISTED" };
  if (!rankingReflected) return { eligible: false, reasonCode: "PUBLICATION_RANKING_REQUIRED" };
  if (workflow === "published") return { eligible: false, reasonCode: "PUBLICATION_WORKFLOW_ALREADY_COMPLETE" };
  if (!["scored_private", "rescore_pending"].includes(workflow)) {
    return { eligible: false, reasonCode: "PUBLICATION_WORKFLOW_STATE_NOT_RECONCILABLE" };
  }
  return { eligible: true, reasonCode: "PUBLICATION_PERSISTED_WORKFLOW_BEHIND" };
}

export function getPregameAuxiliaryStateReconciliation({
  internalGameId = "",
  rowInternalGameId = "",
  scoringStatus = "",
  workflowStatus = "",
  publicationStatus = "",
  publishedAt = null,
  rankingReflected = false,
  currentErrorCode = "",
  activeErrorCodes = []
} = {}) {
  const errorCode = String(currentErrorCode || "");
  if (!internalGameId || String(rowInternalGameId || "") !== String(internalGameId)) {
    return { eligible: false, reasonCode: "PREGAME_INTERNAL_ID_MISMATCH" };
  }
  if (String(scoringStatus || "") === "scored") return { eligible: false, reasonCode: "PREGAME_SCORING_ALREADY_RECORDED" };
  if (! ["scored_private", "published"].includes(String(workflowStatus || ""))) {
    return { eligible: false, reasonCode: "PREGAME_WORKFLOW_NOT_SCORED" };
  }
  if (String(scoringStatus || "") !== "pending") return { eligible: false, reasonCode: "PREGAME_SCORING_STATE_NOT_PENDING" };
  if (publicationStatus !== "published" && !rankingReflected) {
    return { eligible: false, reasonCode: "PREGAME_RANKING_NOT_REFLECTED" };
  }
  if (!STALE_PREGAME_SCHEDULE_ERROR_CODES.has(errorCode)) {
    return { eligible: false, reasonCode: "PREGAME_ERROR_NOT_STALE_SCHEDULE" };
  }
  if ((Array.isArray(activeErrorCodes) ? activeErrorCodes : []).some((code) => String(code || "") === errorCode)) {
    return { eligible: false, reasonCode: "PREGAME_SCHEDULE_ERROR_STILL_ACTIVE" };
  }
  return { eligible: true, reasonCode: "PREGAME_STALE_SCHEDULE_ERROR_RECONCILED" };
}

async function ensureCompletionDownstreamJobs(env, job, now) {
  let nextJobType = ({
    probable_starter_fetch: "provisional_lineup_fetch",
    provisional_lineup_fetch: "final_lineup_fetch",
    final_lineup_fetch: "scoring",
    scoring: "ranking_update",
    ranking_update: "publication"
  })[job?.job_type];
  if (!nextJobType) return { created: false, reason: "no_downstream" };
  const target = await resolveWorkflowJobGame(env.AUTH_DB, job.internal_game_id);
  const timeline = buildWorkflowJobTimeline(target);
  if (!timeline || target.status === "cancelled") return { created: false, reason: "out_of_scope" };
  if (nextJobType === "scoring") {
    await ensureWorkflowScoringPending(env.AUTH_DB, job.internal_game_id, now);
  } else if (job?.job_type === "scoring") {
    const ranking = await getRankingReflectionState(env.AUTH_DB, target.gameId);
    if (ranking.reflected) nextJobType = "publication";
  }
  const result = await recordCreatedCompletionJob(env.AUTH_DB, { ...timeline, internalGameId: job.internal_game_id }, nextJobType, now);
  return { ...result, jobType: nextJobType };
}

const HISTORICAL_WORKFLOW_RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1000;
const HISTORICAL_WORKFLOW_RECOVERY_STATUSES = new Set([
  "prediction_open", "prediction_closed", "lineup_pending", "provisional_lineup_captured", "retrying"
]);
const HISTORICAL_WORKFLOW_TERMINAL_STATUSES = new Set([
  "service_unavailable", "manual_intervention_required", "scored_private", "published"
]);
const LEGACY_TARGET_VALIDATION_ERROR_DETAIL = "試合進行ジョブの対象試合が無効です。";
const SCORING_WORKFLOW_STATE_TRANSITION_ERROR_DETAIL = "試合進行状態を final_lineup_captured から scored_private へ変更できません。";

function getWorkflowRecoveryDateScope(now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  return {
    from: new Date(current.getTime() - HISTORICAL_WORKFLOW_RECOVERY_WINDOW_MS),
    gameDates: [getJstDateString(new Date(current.getTime() - 24 * 60 * 60 * 1000)), getJstDateString(current)]
  };
}

function hasOnlyEmptyLegacyValidationCounts(validation = null) {
  const details = validation && typeof validation === "object" ? validation : {};
  return ["parsedCount", "expectedCount", "resolvedPlayerCount", "parsedHomeCount", "parsedAwayCount"]
    .every((key) => Number(details[key] || 0) === 0);
}

export function getHistoricalWorkflowRecoveryEligibility({
  job = null,
  workflowStatus = "",
  gameStatus = "",
  gameDate = "",
  startAt = "",
  lineupRows = [],
  now = new Date()
} = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const scope = getWorkflowRecoveryDateScope(current);
  const status = String(job?.status || "");
  const jobType = String(job?.jobType || job?.job_type || "");
  const workflow = String(workflowStatus || "waiting");
  const start = new Date(startAt || "");
  const lease = new Date(job?.leaseExpiresAt || job?.lease_expires_at || "");
  const attemptCount = Number(job?.attemptCount ?? job?.attempt_count ?? 0);
  const maxAttempts = Math.max(1, Number(job?.maxAttempts ?? job?.max_attempts ?? 1));
  const currentDate = getJstDateString(current);
  const previousDate = getJstDateString(new Date(current.getTime() - 24 * 60 * 60 * 1000));
  const rows = Array.isArray(lineupRows) ? lineupRows : [];
  const finalLineupExists = rows.length > 0;
  const scoringCompleted = rows.some((row) => String(row?.scoring_status || "") === "scored");
  const publicationCompleted = rows.some((row) => String(row?.publication_status || "") === "published");
  const staleLeaseDetected = status === "claimed"
    && !Number.isNaN(lease.getTime())
    && lease.getTime() <= current.getTime();
  const scopeSummary = {
    windowHours: 48,
    gameDates: [previousDate, currentDate],
    inWindow: !Number.isNaN(start.getTime()) && start.getTime() >= scope.from.getTime() && start.getTime() <= current.getTime(),
    inDateScope: [previousDate, currentDate].includes(String(gameDate || ""))
  };
  let recoveryBlockedReason = "";
  let recoveryReasonCode = "";
  if (jobType !== "final_lineup_fetch") recoveryBlockedReason = "FINAL_LINEUP_JOB_REQUIRED";
  else if (HISTORICAL_WORKFLOW_TERMINAL_STATUSES.has(workflow) || ["cancelled", "service_unavailable"].includes(String(gameStatus || ""))) recoveryBlockedReason = "WORKFLOW_TERMINAL";
  else if (!HISTORICAL_WORKFLOW_RECOVERY_STATUSES.has(workflow)) recoveryBlockedReason = "WORKFLOW_NOT_ACTIVE";
  else if (!scopeSummary.inDateScope || !scopeSummary.inWindow) recoveryBlockedReason = "OUTSIDE_HISTORICAL_RECOVERY_SCOPE";
  else if (finalLineupExists || scoringCompleted || publicationCompleted) recoveryBlockedReason = "DOWNSTREAM_ALREADY_COMPLETED";
  else if (attemptCount >= maxAttempts) recoveryBlockedReason = "MAX_ATTEMPTS_REACHED";
  else if (status === "claimed") {
    if (staleLeaseDetected) recoveryReasonCode = "STALE_CLAIM_RECOVERY";
    else recoveryBlockedReason = "LEASE_STILL_ACTIVE";
  } else if (status === "retry_wait") {
    const legacyTargetValidation = String(job?.errorCode || job?.error_code || "") === "DATA_VALIDATION_FAILED"
      && String(job?.errorDetail || job?.error_detail || "") === LEGACY_TARGET_VALIDATION_ERROR_DETAIL
      && !job?.parseStage
      && !job?.httpStatus
      && !job?.sourceUrlHost
      && job?.retryable === false
      && hasOnlyEmptyLegacyValidationCounts(job?.validation);
    if (legacyTargetValidation) recoveryReasonCode = "LEGACY_TARGET_VALIDATION_REEVALUATION";
    else recoveryBlockedReason = "LEGACY_ERROR_NOT_ELIGIBLE";
  } else {
    recoveryBlockedReason = "JOB_STATUS_NOT_RECOVERABLE";
  }
  return {
    staleLeaseDetected,
    eligibleForRecovery: Boolean(recoveryReasonCode),
    recoveryBlockedReason: recoveryBlockedReason || null,
    recoveryReasonCode: recoveryReasonCode || null,
    reconciliationScope: scopeSummary
  };
}

async function listHistoricalCompletionRecoveryJobs(db, now) {
  const scope = getWorkflowRecoveryDateScope(now);
  const result = await db.prepare(
    `SELECT jobs.*, state.legacy_game_id, state.workflow_status, games.game_date, games.start_time, games.game_status
       FROM game_job_runs AS jobs
       JOIN game_workflow_state AS state ON state.internal_game_id = jobs.internal_game_id
       JOIN games ON games.internal_game_id = jobs.internal_game_id
      WHERE jobs.job_type = 'final_lineup_fetch'
        AND jobs.status IN ('claimed', 'retry_wait')
        AND jobs.attempt_count < jobs.max_attempts
        AND state.workflow_status IN ('prediction_open', 'prediction_closed', 'lineup_pending', 'provisional_lineup_captured', 'retrying')
        AND games.game_status NOT IN ('cancelled', 'canceled', 'postponed', 'service_unavailable')
        AND games.game_date IN (?1, ?2)
        AND games.start_time >= ?3
        AND games.start_time <= ?4
        AND NOT EXISTS (
          SELECT 1 FROM game_lineups AS lineups
           WHERE lineups.internal_game_id = jobs.internal_game_id
        )
      ORDER BY games.start_time ASC, jobs.id ASC
      LIMIT 10`
  ).bind(scope.gameDates[0], scope.gameDates[1], scope.from.toISOString(), now.toISOString()).all();
  return result.results || [];
}

async function cancelSupersededLineupJobsWithDetails(db, internalGameId, now) {
  const candidates = await db.prepare(
    `SELECT id FROM game_job_runs
      WHERE internal_game_id = ?1
        AND job_type = 'provisional_lineup_fetch'
        AND status IN ('pending', 'retry_wait', 'claimed', 'running')
      ORDER BY id ASC`
  ).bind(internalGameId).all();
  const cancelled = await cancelSupersededLineupJobs(db, internalGameId, now);
  return {
    count: cancelled,
    jobIds: (candidates.results || []).map((row) => Number(row.id)).filter(Number.isInteger)
  };
}

async function reconcileHistoricalCompletionWorkflowJobs(env, now) {
  const summary = { checked: 0, recovered: 0, recoveredJobIds: [], supersededJobIds: [], blocked: 0 };
  const candidates = await listHistoricalCompletionRecoveryJobs(env.AUTH_DB, now);
  for (const row of candidates) {
    summary.checked += 1;
    const job = mapHistoricalWorkflowJobRow(row, now);
    const eligibility = getHistoricalWorkflowRecoveryEligibility({
      job,
      workflowStatus: row.workflow_status,
      gameStatus: row.game_status,
      gameDate: row.game_date,
      startAt: row.start_time,
      lineupRows: [],
      now
    });
    if (!eligibility.eligibleForRecovery) {
      summary.blocked += 1;
      continue;
    }
    let target;
    try {
      target = await resolveWorkflowJobGame(env.AUTH_DB, row.internal_game_id);
    } catch (error) {
      summary.blocked += 1;
      continue;
    }
    const recovered = await recoverWorkflowJobForReevaluation(env.AUTH_DB, {
      jobId: row.id,
      expectedStatus: row.status,
      expectedErrorCode: row.error_code || "",
      expectedErrorDetail: row.error_detail || "",
      recoveryMetadata: {
        recoveryReasonCode: eligibility.recoveryReasonCode,
        recoveredAt: now.toISOString(),
        reconciliationScope: eligibility.reconciliationScope,
        targetResolution: target.targetResolution || null
      },
      now
    });
    if (!recovered.recovered) continue;
    const superseded = await cancelSupersededLineupJobsWithDetails(env.AUTH_DB, row.internal_game_id, now);
    try {
      await transitionWorkflowState(env.AUTH_DB, {
        internalGameId: row.internal_game_id,
        to: "lineup_pending",
        nextDueAt: now,
        now
      });
    } catch (error) {
      console.warn(`historical workflow recovery state transition skipped: job=${row.id} code=${error?.code || "WORKFLOW_STATE_CONFLICT"}`);
    }
    try {
      await recordWorkflowJobEvent(env.AUTH_DB, {
        eventType: "workflow_job_recovered",
        status: "warning",
        internalGameId: row.internal_game_id,
        job: { ...row, legacyGameId: target.gameId },
        now,
        errorCode: eligibility.recoveryReasonCode,
        metadata: {
          recoveredJobId: Number(row.id),
          supersededJobIds: superseded.jobIds,
          recoveredAt: now.toISOString(),
          reconciliationScope: eligibility.reconciliationScope,
          targetResolution: target.targetResolution || null
        },
        source: "system"
      });
    } catch (error) {
      console.error(`historical workflow recovery event record failed: job=${row.id} code=${error?.code || "WORKFLOW_LOG_WRITE_FAILED"}`);
    }
    summary.recovered += 1;
    summary.recoveredJobIds.push(Number(row.id));
    summary.supersededJobIds.push(...superseded.jobIds);
  }
  return summary;
}

export function getScoringPersistenceReconciliationEligibility({
  workflowStatus = "",
  workflowErrorCode = "",
  workflowErrorDetail = "",
  scoringStatus = "",
  scoredAt = "",
  lastError = "",
  finalLineupExists = false,
  scoreResultExists = false,
  scoreResultCount = 0,
  publicationStatus = "pending",
  rankingCheckAvailable = true,
  identifierConflict = false,
  internalGameIdMatches = true
} = {}) {
  const workflow = String(workflowStatus || "");
  const scoringPersisted = String(scoringStatus || "") === "scored"
    && Boolean(scoredAt)
    && !String(lastError || "")
    && Boolean(scoreResultExists);
  const workflowBehindScoring = scoringPersisted && !["scored_private", "published"].includes(workflow);
  const transitionFailure = String(workflowErrorCode || "") === "WORKFLOW_STATE_TRANSITION_FAILED"
    || (String(workflowErrorCode || "") === "DATA_VALIDATION_FAILED"
      && String(workflowErrorDetail || "") === SCORING_WORKFLOW_STATE_TRANSITION_ERROR_DETAIL);
  let reconciliationBlockedReason = "";
  if (!workflowBehindScoring) reconciliationBlockedReason = "SCORING_WORKFLOW_NOT_BEHIND";
  else if (!["manual_intervention_required", "final_lineup_captured", "scoring_pending", "retrying"].includes(workflow)) reconciliationBlockedReason = "WORKFLOW_STATUS_NOT_RECONCILABLE";
  else if (workflow === "manual_intervention_required" && !transitionFailure) reconciliationBlockedReason = "MANUAL_INTERVENTION_NOT_STATE_TRANSITION";
  else if (!finalLineupExists) reconciliationBlockedReason = "FINAL_LINEUP_REQUIRED";
  else if (!scoringPersisted) reconciliationBlockedReason = "SCORING_RESULT_NOT_PERSISTED";
  else if (Number(scoreResultCount) !== 1) reconciliationBlockedReason = "SCORING_RESULT_COUNT_INVALID";
  else if (String(publicationStatus || "") === "published") reconciliationBlockedReason = "PUBLICATION_ALREADY_COMPLETED";
  else if (!rankingCheckAvailable) reconciliationBlockedReason = "RANKING_STATE_UNAVAILABLE";
  else if (identifierConflict) reconciliationBlockedReason = "GAME_IDENTIFIER_CONFLICT";
  else if (!internalGameIdMatches) reconciliationBlockedReason = "INTERNAL_GAME_ID_MISMATCH";
  return {
    scoringPersistenceState: scoringPersisted ? "scored" : "not_scored",
    workflowStateConsistency: workflowBehindScoring ? "behind" : "consistent",
    scoringPersisted,
    workflowBehindScoring,
    reconciliationEligible: !reconciliationBlockedReason,
    reconciliationBlockedReason: reconciliationBlockedReason || null,
    reasonCode: reconciliationBlockedReason ? null : "SCORING_PERSISTED_WORKFLOW_BEHIND",
    scoreResultCount: Number(scoreResultCount || 0),
    scoringJobRecoveryMode: reconciliationBlockedReason ? "none" : "persisted_result_adoption"
  };
}

async function listPersistedScoringWorkflowCandidates(db, now) {
  const from = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const result = await db.prepare(
    `SELECT state.internal_game_id, state.legacy_game_id, state.workflow_status,
            state.last_error_code AS workflow_error_code, games.game_date, games.start_time,
            games.game_status, lineups.game_id, lineups.internal_game_id AS lineup_internal_game_id,
            lineups.scoring_status, lineups.scored_at, lineups.last_error,
            lineups.publication_status, lineups.processed_predictions,
            (SELECT COUNT(*) FROM game_lineups AS scored_rows
              WHERE scored_rows.internal_game_id = state.internal_game_id
                AND scored_rows.scoring_status = 'scored') AS score_result_count
       FROM game_workflow_state AS state
       JOIN games ON games.internal_game_id = state.internal_game_id
       JOIN game_lineups AS lineups ON lineups.internal_game_id = state.internal_game_id
      WHERE state.workflow_status IN ('manual_intervention_required', 'final_lineup_captured', 'scoring_pending', 'retrying')
        AND lineups.scoring_status = 'scored'
        AND lineups.scored_at IS NOT NULL
        AND COALESCE(lineups.publication_status, 'pending') <> 'published'
        AND games.start_time >= ?1
        AND games.start_time <= ?2
      ORDER BY games.start_time ASC, state.internal_game_id ASC
      LIMIT 20`
  ).bind(from, now.toISOString()).all();
  return result.results || [];
}

async function reconcilePersistedScoringWorkflows(env, now) {
  const summary = { checked: 0, reconciled: 0, created: 0, blocked: 0, recoveredJobIds: [] };
  const candidates = await listPersistedScoringWorkflowCandidates(env.AUTH_DB, now);
  for (const row of candidates) {
    summary.checked += 1;
    const jobResult = await env.AUTH_DB.prepare(
      `SELECT id, job_type, status, error_code, error_detail
         FROM game_job_runs
        WHERE internal_game_id = ?1 AND job_type IN ('scoring', 'ranking_update', 'publication')
        ORDER BY id DESC`
    ).bind(row.internal_game_id).all();
    const jobs = jobResult.results || [];
    const scoringJob = jobs.find((job) => job.job_type === "scoring") || null;
    const rankingJob = jobs.find((job) => job.job_type === "ranking_update" && job.status !== "cancelled") || null;
    const publicationJob = jobs.find((job) => job.job_type === "publication" && job.status !== "cancelled") || null;
    let target;
    try {
      target = await resolveWorkflowJobGame(env.AUTH_DB, row.internal_game_id);
    } catch (error) {
      summary.blocked += 1;
      continue;
    }
    const ranking = await getRankingReflectionState(env.AUTH_DB, row.game_id);
    const eligibility = getScoringPersistenceReconciliationEligibility({
      workflowStatus: row.workflow_status,
      workflowErrorCode: scoringJob?.error_code || row.workflow_error_code,
      workflowErrorDetail: scoringJob?.error_detail || "",
      scoringStatus: row.scoring_status,
      scoredAt: row.scored_at,
      lastError: row.last_error,
      finalLineupExists: true,
      scoreResultExists: Number(row.score_result_count || 0) === 1,
      scoreResultCount: Number(row.score_result_count || 0),
      publicationStatus: row.publication_status || "pending",
      rankingCheckAvailable: true,
      identifierConflict: (target.targetResolution?.identifierConflicts || []).length > 0,
      internalGameIdMatches: String(row.lineup_internal_game_id || "") === String(row.internal_game_id || "")
    });
    if (!eligibility.reconciliationEligible) {
      summary.blocked += 1;
      continue;
    }
    if (scoringJob?.status === "permanently_failed") {
      const adopted = await reconcilePersistedScoringJob(env.AUTH_DB, {
        jobId: scoringJob.id,
        expectedStatus: "permanently_failed",
        expectedErrorCode: scoringJob.error_code,
        expectedErrorDetail: scoringJob.error_detail,
        resultMetadata: {
          recoveryMode: eligibility.scoringJobRecoveryMode,
          reasonCode: eligibility.reasonCode,
          originalErrorCode: scoringJob.error_code
        },
        now
      });
      if (!adopted.reconciled) continue;
      summary.recoveredJobIds.push(Number(scoringJob.id));
    }
    try {
      await ensureWorkflowScoringPending(env.AUTH_DB, row.internal_game_id, now);
      await transitionWorkflowState(env.AUTH_DB, {
        internalGameId: row.internal_game_id,
        to: "scored_private",
        completedJobType: "scoring",
        now
      });
    } catch (error) {
      summary.blocked += 1;
      continue;
    }
    let downstream = { created: false, jobType: "" };
    if (ranking.reflected) {
      if (!publicationJob && row.publication_status !== "published") {
        downstream = await recordCreatedCompletionJob(env.AUTH_DB, { ...buildWorkflowJobTimeline(target), internalGameId: row.internal_game_id }, "publication", now, "system");
        downstream.jobType = "publication";
      }
    } else if (!rankingJob) {
      downstream = await recordCreatedCompletionJob(env.AUTH_DB, { ...buildWorkflowJobTimeline(target), internalGameId: row.internal_game_id }, "ranking_update", now, "system");
      downstream.jobType = "ranking_update";
    }
    if (downstream.created) summary.created += 1;
    try {
      await recordWorkflowJobEvent(env.AUTH_DB, {
        eventType: "scoring_workflow_reconciled",
        status: "success",
        internalGameId: row.internal_game_id,
        job: { id: scoringJob?.id || null, job_type: "scoring", legacyGameId: row.game_id },
        now,
        errorCode: eligibility.reasonCode,
        metadata: {
          recoveryMode: eligibility.scoringJobRecoveryMode,
          scoreResultCount: eligibility.scoreResultCount,
          rankingReflected: ranking.reflected,
          downstreamJobType: downstream.jobType || null,
          rankingJobExists: Boolean(rankingJob),
          publicationJobExists: Boolean(publicationJob)
        },
        source: "system"
      });
    } catch (error) {
      console.error(`scoring workflow reconciliation event record failed: game=${row.internal_game_id} code=${error?.code || "WORKFLOW_LOG_WRITE_FAILED"}`);
    }
    summary.reconciled += 1;
  }
  return summary;
}

async function reconcileStalePublicationJobs(env, now) {
  const summary = { checked: 0, recovered: 0, recoveredJobIds: [] };
  const rows = await env.AUTH_DB.prepare(
    `SELECT jobs.id, jobs.internal_game_id, jobs.job_type, jobs.status, jobs.attempt_count,
            jobs.max_attempts, jobs.claimed_at, jobs.lease_expires_at, jobs.error_code,
            jobs.error_detail, state.legacy_game_id, state.workflow_status, state.game_status,
            lineups.publication_status, lineups.published_at
       FROM game_job_runs jobs
       JOIN game_workflow_state state ON state.internal_game_id = jobs.internal_game_id
       JOIN game_lineups lineups ON lineups.internal_game_id = jobs.internal_game_id
      WHERE jobs.job_type = 'publication'
        AND jobs.status = 'claimed'
        AND jobs.lease_expires_at IS NOT NULL
        AND jobs.lease_expires_at <= ?1
        AND jobs.completed_at IS NULL
        AND state.workflow_status NOT IN ('published', 'service_unavailable', 'manual_intervention_required')
        AND state.game_status <> 'cancelled'
        AND lineups.published_at IS NULL
        AND COALESCE(lineups.publication_status, 'pending') <> 'published'
        AND jobs.attempt_count < jobs.max_attempts
      ORDER BY jobs.lease_expires_at ASC, jobs.id ASC
      LIMIT 50`
  ).bind(now.toISOString()).all();
  for (const row of rows.results || []) {
    summary.checked += 1;
    const recovered = await recoverWorkflowJobForReevaluation(env.AUTH_DB, {
      jobId: row.id,
      expectedStatus: "claimed",
      expectedJobType: "publication",
      recoveryMetadata: {
        recoveryReasonCode: "PUBLICATION_STALE_CLAIM",
        recoveredAt: now.toISOString(),
        attemptCountBeforeRecovery: Number(row.attempt_count || 0)
      },
      now
    });
    if (!recovered.recovered) continue;
    summary.recovered += 1;
    summary.recoveredJobIds.push(Number(row.id));
    try {
      await recordWorkflowJobEvent(env.AUTH_DB, {
        eventType: "workflow_job_recovered",
        status: "warning",
        internalGameId: row.internal_game_id,
        job: { ...row, legacyGameId: row.legacy_game_id },
        now,
        errorCode: "PUBLICATION_STALE_CLAIM",
        metadata: {
          recoveredJobId: Number(row.id),
          recoveryReasonCode: "PUBLICATION_STALE_CLAIM",
          attemptCountBeforeRecovery: Number(row.attempt_count || 0),
          attemptCountChanged: false
        },
        source: "system"
      });
    } catch (error) {
      console.error(`publication stale recovery event record failed: job=${row.id} code=${error?.code || "WORKFLOW_LOG_WRITE_FAILED"}`);
    }
  }
  return summary;
}

async function reconcileLegacyPublicationJobs(env, now) {
  const summary = {
    checked: 0,
    recovered: 0,
    recoveredJobIds: [],
    blocked: 0,
    terminalOverrides: 0,
    publicationRecoveryCronVisited: true,
    publicationRecoveryCronVisitedAt: now.toISOString(),
    publicationRecoveryCandidateSelected: false,
    publicationRecoveryCandidateJobId: null,
    publicationRecoveryStage: "candidate_query",
    publicationRecoverySkippedReason: null,
    publicationRecoveryUpdateRowCount: 0,
    publicationRecoveryApplied: false
  };
  let rows;
  try {
    rows = await env.AUTH_DB.prepare(
      `SELECT jobs.id, jobs.internal_game_id, jobs.job_type, jobs.status, jobs.error_code,
              jobs.error_detail, jobs.attempt_count, jobs.max_attempts,
              state.workflow_status, state.game_status,
              lineups.game_id, lineups.internal_game_id AS lineup_internal_game_id,
              lineups.scoring_status, lineups.publication_status, lineups.published_at,
              CASE WHEN lineups.scoring_status = 'scored' AND lineups.scored_at IS NOT NULL THEN 1 ELSE 0 END AS score_result_count,
              ranking.is_ranking_eligible, ranking.game_status AS ranking_game_status,
              ranking.publication_status AS ranking_publication_status
         FROM game_job_runs jobs
         JOIN game_workflow_state state ON state.internal_game_id = jobs.internal_game_id
         JOIN game_lineups lineups ON lineups.internal_game_id = jobs.internal_game_id
         LEFT JOIN ranking_games ranking ON ranking.game_id = lineups.game_id
        WHERE jobs.job_type = 'publication'
          AND jobs.status = 'permanently_failed'
          AND jobs.completed_at IS NOT NULL
          AND (
            (jobs.error_code = ?1 AND jobs.error_detail = ?2 AND jobs.attempt_count = jobs.max_attempts)
            OR (jobs.error_code = ?3 AND jobs.error_detail = ?4
                AND jobs.attempt_count IN (jobs.max_attempts, jobs.max_attempts + 1))
          )
          AND state.workflow_status NOT IN ('published', 'service_unavailable')
          AND state.game_status NOT IN ('cancelled', 'canceled', 'postponed', 'service_unavailable')
        ORDER BY jobs.id ASC LIMIT 20`
    ).bind(
      PUBLICATION_LEGACY_ERROR_CODE,
      PUBLICATION_LEGACY_ERROR_DETAIL,
      PUBLICATION_REFERENCE_ERROR_CODE,
      PUBLICATION_REFERENCE_ERROR_DETAIL
    ).all();
  } catch (error) {
    if (isPregameSchemaError(error)) {
      summary.publicationRecoveryStage = "candidate_query_failed";
      summary.publicationRecoverySkippedReason = "SCHEMA_NOT_READY";
      return summary;
    }
    throw error;
  }
  for (const row of rows.results || []) {
    summary.checked += 1;
    summary.publicationRecoveryCandidateSelected = true;
    summary.publicationRecoveryCandidateJobId = Number(row.id);
    summary.publicationRecoveryStage = "candidate_selected";
    const recordVisit = async (stage, skippedReason = null, updateRowCount = 0, applied = false) => {
      summary.publicationRecoveryStage = stage;
      summary.publicationRecoverySkippedReason = skippedReason;
      summary.publicationRecoveryUpdateRowCount = updateRowCount;
      summary.publicationRecoveryApplied = applied;
      try {
        await recordWorkflowLog(env.AUTH_DB, {
          eventType: "publication_recovery_cron_visit",
          status: skippedReason ? "warning" : applied ? "success" : "info",
          gameId: row.game_id,
          occurredAt: now,
          message: applied ? "publication旧エラー復旧をCronから適用しました。" : "publication旧エラー復旧候補をCronで確認しました。",
          errorCode: skippedReason || "",
          metadata: {
            processName: "publication_recovery_cron",
            internalGameId: row.internal_game_id,
            publicationRecoveryCronVisited: true,
            publicationRecoveryCronVisitedAt: now.toISOString(),
            publicationRecoveryCandidateSelected: true,
            publicationRecoveryCandidateJobId: Number(row.id),
            publicationRecoveryStage: stage,
            publicationRecoverySkippedReason: skippedReason,
            publicationRecoveryUpdateRowCount: updateRowCount,
            publicationRecoveryApplied: applied
          },
          source: "cron"
        });
      } catch (error) {
        console.error(`publication recovery visit log failed: job=${row.id} code=${error?.code || "WORKFLOW_LOG_WRITE_FAILED"}`);
      }
    };
    let target;
    try {
      target = await resolvePublicationTarget(env.AUTH_DB, row.internal_game_id, row.game_id);
    } catch {
      summary.blocked += 1;
      await recordVisit("target_resolution", "TARGET_RESOLUTION_FAILED");
      continue;
    }
    const rankingReflected = Number(row.is_ranking_eligible || 0) === 1
      && String(row.ranking_game_status || "") === "scored"
      && String(row.ranking_publication_status || "") !== "pending";
    const recoveryProfile = getPublicationRecoveryProfile(row.error_code, row.error_detail);
    const eligibility = getPublicationJobRecoveryEligibility({
      jobType: row.job_type,
      status: row.status,
      errorCode: row.error_code,
      errorDetail: row.error_detail,
      publishedAt: row.published_at,
      publicationStatus: row.publication_status,
      scoringPersisted: row.scoring_status === "scored" && Number(row.score_result_count || 0) > 0,
      scoreResultCount: Number(row.score_result_count || 0),
      rankingReflected,
      internalGameIdMatches: String(row.lineup_internal_game_id || "") === String(row.internal_game_id || ""),
      identifierConflict: (target.targetResolution?.identifierConflicts || []).length > 0,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      recoveryProfile
    });
    if (!eligibility.eligible) {
      summary.blocked += 1;
      await recordVisit("eligibility", eligibility.reasonCode || "CANDIDATE_NOT_ELIGIBLE");
      continue;
    }
    const workflowTerminalOverrideApplied = row.workflow_status === "manual_intervention_required";
    if (workflowTerminalOverrideApplied) {
      const terminalOverride = getPublicationTerminalRecoveryEligibility({
        workflowStatus: row.workflow_status,
        jobType: row.job_type,
        status: row.status,
        errorCode: row.error_code,
        errorDetail: row.error_detail,
        publishedAt: row.published_at,
        publicationStatus: row.publication_status,
        scoringPersisted: row.scoring_status === "scored" && Number(row.score_result_count || 0) > 0,
        scoreResultCount: Number(row.score_result_count || 0),
        rankingReflected,
        internalGameIdMatches: String(row.lineup_internal_game_id || "") === String(row.internal_game_id || ""),
        identifierConflict: (target.targetResolution?.identifierConflicts || []).length > 0,
        attemptCount: row.attempt_count,
        maxAttempts: row.max_attempts,
        recoveryProfile
      });
      if (!terminalOverride.eligible) {
        summary.blocked += 1;
        await recordVisit("terminal_override", terminalOverride.reasonCode || "TERMINAL_OVERRIDE_REJECTED");
        continue;
      }
      try {
        await transitionWorkflowState(env.AUTH_DB, {
          internalGameId: row.internal_game_id,
          to: "scoring_pending",
          completedJobType: "scoring",
          now
        });
        await transitionWorkflowState(env.AUTH_DB, {
          internalGameId: row.internal_game_id,
          to: "scored_private",
          completedJobType: "scoring",
          now
        });
      } catch (error) {
        summary.blocked += 1;
        await recordVisit("workflow_transition", "WORKFLOW_TRANSITION_FAILED");
        console.warn(`publication terminal recovery state transition skipped: job=${row.id} code=${error?.code || "WORKFLOW_STATE_CONFLICT"}`);
        continue;
      }
    }
    const recovered = await recoverWorkflowJobForReevaluation(env.AUTH_DB, {
      jobId: row.id,
      expectedStatus: "permanently_failed",
      expectedJobType: "publication",
      expectedErrorCode: row.error_code,
      expectedErrorDetail: row.error_detail,
      allowOneOverMaxAttempt: recoveryProfile?.allowOneOverMaxAttempt === true,
      recoveryMetadata: {
        recoveryMode: recoveryProfile?.recoveryMode || "publication_legacy_schedule_error",
        recoveryReasonCode: eligibility.reasonCode,
        recoveredAt: now.toISOString(),
        previousErrorCode: row.error_code,
        previousErrorDetail: row.error_detail,
        attemptCountBeforeRecovery: Number(row.attempt_count || 0),
        attemptCountChanged: false,
        workflowTerminalOverrideApplied,
        targetResolution: target.targetResolution
      },
      now
    });
    if (!recovered.recovered) {
      await recordVisit("atomic_update", "ATOMIC_UPDATE_NO_MATCH", recovered.updateRowCount || 0);
      continue;
    }
    summary.recovered += 1;
    summary.recoveredJobIds.push(Number(row.id));
    if (workflowTerminalOverrideApplied) summary.terminalOverrides += 1;
    await recordVisit("applied", null, recovered.updateRowCount || 0, true);
    await recordWorkflowJobEvent(env.AUTH_DB, {
      eventType: "workflow_job_recovered",
      status: "warning",
      internalGameId: row.internal_game_id,
      job: { id: row.id, job_type: "publication", legacyGameId: row.game_id },
      now,
      errorCode: eligibility.reasonCode,
      metadata: {
        recoveredJobId: Number(row.id),
        recoveryMode: recoveryProfile?.recoveryMode || "publication_legacy_schedule_error",
        originalErrorCode: row.error_code,
        originalErrorDetail: row.error_detail,
        previousErrorCode: row.error_code,
        previousErrorDetail: row.error_detail,
        attemptCountBeforeRecovery: Number(row.attempt_count || 0),
        attemptCountChanged: false,
        workflowTerminalOverrideApplied,
        targetResolution: target.targetResolution
      },
      source: "system"
    });
  }
  return summary;
}

async function reconcilePersistedPublicationWorkflows(env, now) {
  const summary = { checked: 0, reconciled: 0, recoveredJobIds: [], blocked: 0 };
  const since = new Date(now.getTime() - HISTORICAL_WORKFLOW_RECOVERY_WINDOW_MS).toISOString();
  let rows;
  try {
    rows = await env.AUTH_DB.prepare(
      `SELECT state.internal_game_id, state.legacy_game_id, state.workflow_status,
              state.last_error_code, games.game_status, games.start_time,
              lineups.game_id, lineups.internal_game_id AS lineup_internal_game_id,
              lineups.scoring_status, lineups.publication_status, lineups.published_at
         FROM game_workflow_state state
         JOIN games ON games.internal_game_id = state.internal_game_id
         JOIN game_lineups lineups ON lineups.internal_game_id = state.internal_game_id
        WHERE lineups.scoring_status = 'scored'
          AND lineups.publication_status = 'published'
          AND lineups.published_at IS NOT NULL
          AND state.workflow_status <> 'published'
          AND games.start_time >= ?1 AND games.start_time <= ?2
        ORDER BY lineups.published_at ASC, state.internal_game_id ASC
        LIMIT 50`
    ).bind(since, now.toISOString()).all();
  } catch (error) {
    if (isPregameSchemaError(error)) return summary;
    throw error;
  }
  for (const row of rows.results || []) {
    summary.checked += 1;
    const [ranking, jobsResult] = await Promise.all([
      getRankingReflectionState(env.AUTH_DB, row.game_id),
      env.AUTH_DB.prepare(
        `SELECT id, job_type, status, error_code, error_detail, completed_at, attempt_count,
                max_attempts, claimed_at, lease_expires_at
           FROM game_job_runs
          WHERE internal_game_id = ?1 AND job_type = 'publication' AND status <> 'cancelled'
          ORDER BY id DESC LIMIT 10`
      ).bind(row.internal_game_id).all()
    ]);
    let targetResolution = null;
    let identifierConflict = false;
    try {
      targetResolution = (await resolveWorkflowJobGame(env.AUTH_DB, row.internal_game_id)).targetResolution || null;
      identifierConflict = Array.isArray(targetResolution?.identifierConflicts) && targetResolution.identifierConflicts.length > 0;
    } catch (error) {
      summary.blocked += 1;
      continue;
    }
    const eligibility = getPublicationWorkflowReconciliationEligibility({
      workflowStatus: row.workflow_status,
      publicationStatus: row.publication_status,
      publishedAt: row.published_at,
      finalLineupScored: row.scoring_status === "scored",
      rankingReflected: ranking.reflected,
      internalGameIdMatches: String(row.lineup_internal_game_id || "") === String(row.internal_game_id || ""),
      identifierConflict
    });
    if (!eligibility.eligible) {
      summary.blocked += 1;
      continue;
    }
    const publicationJob = (jobsResult.results || []).find((job) => job.status !== "succeeded") || null;
    if (publicationJob) {
      const adopted = await reconcilePersistedPublicationJob(env.AUTH_DB, {
        jobId: publicationJob.id,
        expectedStatus: publicationJob.status,
        expectedErrorCode: publicationJob.error_code || "",
        expectedErrorDetail: publicationJob.error_detail || "",
        resultMetadata: {
          reconciliationReasonCode: eligibility.reasonCode,
          publishedAt: row.published_at,
          publicationAlreadyPersisted: true
        },
        now
      });
      if (!adopted.reconciled) continue;
      summary.recoveredJobIds.push(Number(publicationJob.id));
    }
    try {
      await transitionWorkflowState(env.AUTH_DB, {
        internalGameId: row.internal_game_id,
        to: "published",
        completedJobType: "publication",
        now
      });
    } catch (error) {
      summary.blocked += 1;
      continue;
    }
    await recordWorkflowJobEvent(env.AUTH_DB, {
      eventType: "publication_workflow_reconciled",
      status: "success",
      internalGameId: row.internal_game_id,
      job: { id: publicationJob?.id || null, job_type: "publication", legacyGameId: row.legacy_game_id },
      now,
      errorCode: eligibility.reasonCode,
      metadata: {
        publicationAlreadyPersisted: true,
        publishedAt: row.published_at,
        publicationJobReconciled: Boolean(publicationJob),
        targetResolution
      },
      source: "system"
    });
    summary.reconciled += 1;
  }
  return summary;
}

async function reconcilePregameAutomationState(env, now) {
  const summary = { checked: 0, reconciled: 0 };
  let rows;
  try {
    rows = await env.AUTH_DB.prepare(
      `SELECT state.internal_game_id, state.legacy_game_id, state.workflow_status,
              state.last_error_code AS workflow_error_code,
              lineups.game_id, lineups.internal_game_id AS lineup_internal_game_id,
              lineups.scoring_status, lineups.publication_status, lineups.published_at,
              pregame.internal_game_id AS pregame_internal_game_id,
              pregame.scoring_status AS pregame_scoring_status,
              pregame.last_error_code AS pregame_error_code,
              pregame.last_error_message AS pregame_error_message
         FROM game_workflow_state state
         JOIN game_lineups lineups ON lineups.internal_game_id = state.internal_game_id
         JOIN game_pregame_automation pregame ON pregame.game_id = lineups.game_id
        WHERE lineups.scoring_status = 'scored'
          AND pregame.scoring_status = 'pending'
        ORDER BY pregame.updated_at ASC
        LIMIT 50`
    ).bind().all();
  } catch (error) {
    if (isPregameSchemaError(error)) return summary;
    throw error;
  }
  for (const row of rows.results || []) {
    summary.checked += 1;
    const ranking = await getRankingReflectionState(env.AUTH_DB, row.game_id);
    const activeJobs = await env.AUTH_DB.prepare(
      `SELECT error_code FROM game_job_runs
        WHERE internal_game_id = ?1 AND status IN ('pending', 'claimed', 'running', 'retry_wait')
          AND error_code IS NOT NULL AND error_code <> ''`
    ).bind(row.internal_game_id).all();
    const activeErrorCodes = [
      ...(PUBLICATION_WORKFLOW_TERMINAL_STATUSES.has(String(row.workflow_status || "")) ? [] : [row.workflow_error_code]),
      ...(activeJobs.results || []).map((job) => job.error_code)
    ].filter(Boolean);
    const eligibility = getPregameAuxiliaryStateReconciliation({
      internalGameId: row.internal_game_id,
      rowInternalGameId: row.pregame_internal_game_id,
      scoringStatus: row.pregame_scoring_status,
      workflowStatus: row.workflow_status,
      publicationStatus: row.publication_status,
      publishedAt: row.published_at,
      rankingReflected: ranking.reflected,
      currentErrorCode: row.pregame_error_code,
      activeErrorCodes
    });
    if (!eligibility.eligible) continue;
    const updated = await env.AUTH_DB.prepare(
      `UPDATE game_pregame_automation
          SET scoring_status = 'scored', last_error_code = NULL,
              last_error_message = NULL, updated_at = ?1
        WHERE game_id = ?2 AND internal_game_id = ?3
          AND scoring_status = 'pending' AND last_error_code = ?4`
    ).bind(now.toISOString(), row.game_id, row.internal_game_id, row.pregame_error_code).run();
    if (Number(updated?.meta?.changes || 0) !== 1) continue;
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "pregame_auxiliary_state_reconciled",
      status: "info",
      gameId: row.game_id,
      occurredAt: now,
      message: "採点済みの試合進行状態を補助テーブルへ反映しました。",
      errorCode: eligibility.reasonCode,
      metadata: {
        internalGameId: row.internal_game_id,
        previousErrorCode: row.pregame_error_code,
        previousErrorMessage: String(row.pregame_error_message || "").slice(0, 240),
        scoringStatus: "scored",
        historyRetained: true
      },
      source: "system"
    });
    summary.reconciled += 1;
  }
  return summary;
}

async function reconcileCompletionWorkflowJobs(env, now, timelines) {
  const summary = { checked: 0, created: 0, skipped: 0, recovered: 0, recoveredJobIds: [], supersededJobIds: [], scoringReconciled: 0, scoringRecoveredJobIds: [], publicationReconciled: 0, publicationRecoveredJobIds: [], publicationRecoveryReconciled: 0, publicationRecoveryJobIds: [], publicationRecoveryTerminalOverrides: 0, auxiliaryReconciled: 0 };
  for (const timeline of Array.isArray(timelines) ? timelines : []) {
    const internalGameId = String(timeline?.game?.internalGameId || timeline?.internalGameId || "");
    if (!internalGameId || timeline?.game?.status === "cancelled" || isScheduleGameUnavailable(timeline?.game)) {
      summary.skipped += 1;
      continue;
    }
    summary.checked += 1;
    const canonicalTimeline = { ...timeline, internalGameId };
    if (!(await isGameEligibleForScoring(env.AUTH_DB, timeline.gameId))) continue;
    const lineup = await getGameLineup(env.AUTH_DB, { gameId: timeline.gameId, internalGameId });
    if (lineup) await cancelSupersededLineupJobs(env.AUTH_DB, internalGameId, now);
    let requiredJobType = "";
    if (!lineup) {
      requiredJobType = now >= timeline.finalLineupFetchAt ? "final_lineup_fetch" : "provisional_lineup_fetch";
    } else if (lineup.scoring_status !== "scored" && lineup.scoring_due_at) {
      requiredJobType = "scoring";
    } else if (lineup.scoring_status === "scored") {
      const rankingJob = await env.AUTH_DB.prepare(
        `SELECT status FROM game_job_runs
          WHERE internal_game_id = ?1 AND job_type = 'ranking_update' AND status <> 'cancelled'
          ORDER BY id DESC LIMIT 1`
      ).bind(internalGameId).first();
      const ranking = await getRankingReflectionState(env.AUTH_DB, timeline.gameId);
      if (!ranking.reflected && !rankingJob) requiredJobType = "ranking_update";
      else if (rankingJob?.status === "succeeded" && lineup.publication_status !== "published") requiredJobType = "publication";
      else if (ranking.reflected && lineup.publication_status !== "published") requiredJobType = "publication";
    }
    if (!requiredJobType) continue;
    if (requiredJobType === "final_lineup_fetch") await cancelSupersededLineupJobs(env.AUTH_DB, internalGameId, now);
    const result = await recordCreatedCompletionJob(env.AUTH_DB, canonicalTimeline, requiredJobType, now, "system");
    if (result.created) summary.created += 1;
  }
  // Run the narrowly scoped legacy publication recovery before other historical
  // reconciliation can abort the completion pass. The normal timeline work above
  // has already created any missing current jobs, and the recovered job is handed
  // to the due-job executor below in this same Cron invocation.
  let legacyPublication;
  try {
    legacyPublication = await reconcileLegacyPublicationJobs(env, now);
  } catch (error) {
    legacyPublication = {
      checked: 0,
      recovered: 0,
      recoveredJobIds: [],
      blocked: 1,
      terminalOverrides: 0,
      publicationRecoveryCronVisited: true,
      publicationRecoveryCronVisitedAt: now.toISOString(),
      publicationRecoveryCandidateSelected: false,
      publicationRecoveryCandidateJobId: null,
      publicationRecoveryStage: "reconcile_exception",
      publicationRecoverySkippedReason: "CRON_RECOVERY_EXCEPTION",
      publicationRecoveryUpdateRowCount: 0,
      publicationRecoveryApplied: false
    };
    await recordCronStepFailure(env.AUTH_DB, "publication_recovery", now, error);
  }
  summary.recovered += legacyPublication.recovered;
  summary.recoveredJobIds.push(...legacyPublication.recoveredJobIds);
  summary.publicationRecoveryReconciled = legacyPublication.recovered;
  summary.publicationRecoveryJobIds = legacyPublication.recoveredJobIds;
  summary.publicationRecoveryTerminalOverrides = legacyPublication.terminalOverrides;
  const historical = await reconcileHistoricalCompletionWorkflowJobs(env, now);
  summary.recovered += historical.recovered;
  summary.recoveredJobIds.push(...historical.recoveredJobIds);
  summary.supersededJobIds = historical.supersededJobIds;
  const scoring = await reconcilePersistedScoringWorkflows(env, now);
  summary.scoringReconciled = scoring.reconciled;
  summary.scoringRecoveredJobIds = scoring.recoveredJobIds;
  summary.created += scoring.created;
  const stalePublication = await reconcileStalePublicationJobs(env, now);
  summary.recovered += stalePublication.recovered;
  summary.recoveredJobIds.push(...stalePublication.recoveredJobIds);
  const publication = await reconcilePersistedPublicationWorkflows(env, now);
  summary.publicationReconciled = publication.reconciled;
  summary.publicationRecoveredJobIds = publication.recoveredJobIds;
  const auxiliary = await reconcilePregameAutomationState(env, now);
  summary.auxiliaryReconciled = auxiliary.reconciled;
  return summary;
}

async function shouldSkipPublicationWorkflowJob(db, job) {
  if (!job?.internal_game_id) return false;
  const row = await db.prepare(
    `SELECT state.workflow_status, state.game_status,
            lineups.publication_status, lineups.published_at
       FROM game_workflow_state state
       LEFT JOIN game_lineups lineups ON lineups.internal_game_id = state.internal_game_id
      WHERE state.internal_game_id = ?1 LIMIT 1`
  ).bind(job.internal_game_id).first();
  if (!row) return true;
  if (PUBLICATION_WORKFLOW_TERMINAL_STATUSES.has(String(row.workflow_status || ""))) return true;
  if (String(row.game_status || "") === "cancelled") return true;
  if (row.published_at || String(row.publication_status || "") === "published") return true;
  return false;
}

async function cancelSupersededLineupJobs(db, internalGameId, now) {
  if (!internalGameId) return 0;
  const result = await db.prepare(
    `UPDATE game_job_runs
        SET status = 'cancelled', lease_expires_at = NULL, next_attempt_at = NULL, updated_at = ?1
      WHERE internal_game_id = ?2
        AND job_type = 'provisional_lineup_fetch'
        AND status IN ('pending', 'retry_wait', 'claimed', 'running')`
  ).bind(now.toISOString(), internalGameId).run();
  return Number(result?.meta?.changes || 0);
}

async function alignWorkflowStateWithStoredLineup(db, internalGameId, legacyGameId, now) {
  await ensureGameWorkflowState(db, { internalGameId, legacyGameId, workflowStatus: "prediction_open", now });
  const state = await db.prepare("SELECT workflow_status FROM game_workflow_state WHERE internal_game_id = ?1 LIMIT 1").bind(internalGameId).first();
  if (state?.workflow_status === "prediction_open") {
    await transitionWorkflowState(db, { internalGameId, to: "lineup_pending", now });
    await transitionWorkflowState(db, { internalGameId, to: "final_lineup_captured", now });
  } else if (["lineup_pending", "provisional_lineup_captured", "retrying"].includes(state?.workflow_status)) {
    await transitionWorkflowState(db, { internalGameId, to: "final_lineup_captured", now });
  }
}

async function executeCompletionWorkflowJob(env, job, now) {
  const target = job.job_type === "publication"
    ? await resolvePublicationTarget(env.AUTH_DB, job.internal_game_id)
    : await resolveWorkflowJobGame(env.AUTH_DB, job.internal_game_id);
  if (job.job_type !== "publication") await linkLegacyGameRowsToInternalGameId(env.AUTH_DB, job.internal_game_id, target.gameId);
  const timeline = job.job_type === "publication" ? null : buildWorkflowJobTimeline(target);
  if ((job.job_type !== "publication" && !timeline) || target.status === "cancelled") {
    throw createPregameError("GAME_TARGET_INVALID", "試合進行ジョブの対象試合が無効です。", {
      retryable: false,
      targetResolution: target.targetResolution
    });
  }
  let result;
  if (job.job_type === "provisional_lineup_fetch") {
    result = await captureOfficialLineup(env, target.gameId, now, { phase: "provisional", internalGameId: job.internal_game_id, target });
    if (!["provisional", "superseded_after_start"].includes(result.status)) {
      throw createPregameError("LINEUP_NOT_ANNOUNCED", "仮スタメンをまだ取得できません。");
    }
    if (result.status === "provisional") {
      await transitionWorkflowState(env.AUTH_DB, { internalGameId: job.internal_game_id, to: "provisional_lineup_captured", completedJobType: job.job_type, now });
    }
  } else if (job.job_type === "final_lineup_fetch") {
    result = await captureOfficialLineup(env, target.gameId, now, { phase: "final", internalGameId: job.internal_game_id, target });
    if (result.status !== "captured" && result.status !== "already_captured") throw createPregameError("LINEUP_NOT_ANNOUNCED", "最終スタメンをまだ取得できません。");
    await transitionWorkflowState(env.AUTH_DB, { internalGameId: job.internal_game_id, to: "final_lineup_captured", completedJobType: job.job_type, now });
  } else if (job.job_type === "scoring") {
    if (!(await isGameEligibleForScoring(env.AUTH_DB, target.gameId))) {
      throw createPregameError("RANKING_GAME_EXCLUDED", "ランキング対象外の試合は採点しません。", { retryable: false });
    }
    await ensureWorkflowScoringPending(env.AUTH_DB, job.internal_game_id, now);
    const claimed = await claimGameLineupForScoring(env.AUTH_DB, target.gameId, now);
    if (!claimed) {
      const existing = await getGameLineup(env.AUTH_DB, target.gameId);
      if (existing?.scoring_status !== "scored") throw createPregameError("SCORING_IN_PROGRESS", "採点処理を開始できません。");
      result = { status: "already_scored" };
    } else {
      result = await scoreClaimedGameLineup(env.AUTH_DB, claimed, now);
    }
    await transitionWorkflowState(env.AUTH_DB, { internalGameId: job.internal_game_id, to: "scored_private", canonicalStatus: "scored", completedJobType: job.job_type, now });
  } else if (job.job_type === "ranking_update") {
    if (!(await isGameEligibleForScoring(env.AUTH_DB, target.gameId))) {
      throw createPregameError("RANKING_GAME_EXCLUDED", "ランキング対象外の試合は集計しません。", { retryable: false });
    }
    const lineup = await getGameLineup(env.AUTH_DB, target.gameId);
    if (!lineup || lineup.scoring_status !== "scored") throw createPregameError("SCORING_LINEUP_REQUIRED", "採点結果がありません。");
    const scoringCompletion = await getScoringCompletionState(env.AUTH_DB, { gameId: target.gameId, internalGameId: job.internal_game_id });
    if (!scoringCompletion.complete) {
      throw createPregameError("SCORING_INCOMPLETE", "全予想の採点が完了していません。", { retryable: true });
    }
    await markGameRankingScoredPrivate(env.AUTH_DB, target.gameId, lineup.scored_at || now.toISOString(), env, 0, job.internal_game_id);
    const eligibility = await getRankingEligibilityState(env.AUTH_DB, target.gameId);
    await recordRankingReflectionRevision(env.AUTH_DB, {
      internalGameId: job.internal_game_id,
      scoringRevisionId: scoringCompletion.scoringRevisionId,
      eligibilityVersion: eligibility?.rankingEligibilityVersion || 1,
      status: "reflected",
      now
    });
    result = { status: "ranking_updated" };
    await transitionWorkflowState(env.AUTH_DB, { internalGameId: job.internal_game_id, to: "scored_private", canonicalStatus: "ranking_reflected", completedJobType: job.job_type, now });
  } else if (job.job_type === "publication") {
    result = await publishScoredGameResults(env, target.gameId, now, { internalGameId: job.internal_game_id, target });
    if (!result.published && result.status !== "already_published") throw createPregameError("PUBLICATION_NOT_READY", "公開条件を満たしていません。");
    await transitionWorkflowState(env.AUTH_DB, { internalGameId: job.internal_game_id, to: "published", completedJobType: job.job_type, now });
  } else {
    throw createPregameError("JOB_INPUT_INVALID", "未対応の試合進行ジョブです。");
  }
  await linkLegacyGameRowsToInternalGameId(env.AUTH_DB, job.internal_game_id, target.gameId);
  const completed = await completeWorkflowJob(env.AUTH_DB, {
    jobId: job.id,
    claimToken: job.claim_token,
    resultMetadata: {
      status: result?.status || "success",
      ...getWorkflowExecutionDiagnostics({ job, target, result })
    },
    now
  });
  if (!completed) throw createPregameError("JOB_CLAIM_CONFLICT", "試合進行ジョブの完了権限を確認できません。");
  if (job.job_type === "publication") await reconcilePregameAutomationState(env, now);
  if (job.job_type === "final_lineup_fetch") await cancelSupersededLineupJobs(env.AUTH_DB, job.internal_game_id, now);
  return result;
}

const CURRENT_MANAGED_TERMINAL_WORKFLOWS = new Set(["published", "service_unavailable", "cancelled"]);
const CURRENT_MANAGED_FAILED_WORKFLOWS = new Set(["retrying", "manual_intervention_required"]);

function parseManagedGameStart(value, date = "") {
  const raw = String(value || "").trim();
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
    if (/^\d{1,2}:\d{2}/.test(raw) && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      const local = new Date(`${date}T${raw.slice(0, 5)}:00+09:00`);
      if (!Number.isNaN(local.getTime())) return local;
    }
  }
  return null;
}

function normalizeManagedGameCandidate(candidate, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const startAt = parseManagedGameStart(candidate?.startAt || candidate?.start_time, candidate?.gameDate || candidate?.date);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(candidate?.gameDate || candidate?.date || ""))
    ? String(candidate.gameDate || candidate.date)
    : (startAt ? getJstDateString(startAt) : "");
  const today = getJstDateString(current);
  const workflowStatus = String(candidate?.workflowStatus || candidate?.workflow_status || "waiting");
  const gameStatus = String(candidate?.gameStatus || candidate?.game_status || "scheduled");
  const terminal = gameStatus === "cancelled" || CURRENT_MANAGED_TERMINAL_WORKFLOWS.has(workflowStatus);
  const failed = Boolean(String(candidate?.lastErrorCode || candidate?.last_error_code || "").trim())
    || CURRENT_MANAGED_FAILED_WORKFLOWS.has(workflowStatus)
    || workflowStatus.endsWith("_failed");
  const legacyGameId = String(candidate?.legacyGameId || candidate?.gameId || "").trim();
  return {
    internalGameId: String(candidate?.internalGameId || candidate?.internal_game_id || "").trim(),
    legacyGameId,
    gameId: legacyGameId,
    gameDate: date,
    date,
    startAt: startAt?.toISOString() || "",
    startTime: candidate?.startTime || candidate?.start_time || startAt?.toISOString() || "",
    homeTeam: String(candidate?.homeTeam || candidate?.home_team || ""),
    awayTeam: String(candidate?.awayTeam || candidate?.away_team || ""),
    gameCode: String(candidate?.gameCode || candidate?.game_code || ""),
    venue: String(candidate?.venue || ""),
    gameStatus,
    workflowStatus,
    lastCompletedJobType: String(candidate?.lastCompletedJobType || candidate?.last_completed_job_type || ""),
    lastErrorCode: String(candidate?.lastErrorCode || candidate?.last_error_code || ""),
    lastErrorAt: candidate?.lastErrorAt || candidate?.last_error_at || null,
    nextDueAt: candidate?.nextDueAt || candidate?.next_due_at || null,
    updatedAt: candidate?.updatedAt || candidate?.updated_at || null,
    isTestGame: candidate?.isTestGame === true || Number(candidate?.is_test_game || 0) === 1,
    isTerminal: terminal,
    isFailed: failed,
    isFuture: Boolean(startAt && startAt.getTime() > current.getTime()),
    isHistorical: Boolean(date && date < today)
  };
}

function managedGameSelectionReason(candidate, currentDate) {
  if (!candidate) return "NO_MANAGED_GAME";
  if (candidate.gameDate === currentDate && !candidate.isTerminal && candidate.gameStatus !== "completed") return "TODAY_UNCOMPLETED_GAME";
  if (candidate.gameDate === currentDate && !candidate.isTerminal && candidate.gameStatus === "completed") return "TODAY_INCOMPLETE_GAME";
  if (!candidate.isFuture && !candidate.isTerminal && candidate.startAt) return "RECENT_UNCOMPLETED_GAME";
  if (candidate.isFuture && !candidate.isTerminal) return "NEXT_UPCOMING_GAME";
  if (candidate.isHistorical && candidate.isFailed) return "RECENT_HISTORICAL_FAILURE";
  return "LATEST_HISTORICAL_FALLBACK";
}

function classifyManagedGame(candidate) {
  if (!candidate?.isHistorical) return candidate?.isFuture ? "future" : "current";
  if (candidate.workflowStatus === "service_unavailable" || candidate.gameStatus === "service_unavailable") return "historical_service_unavailable";
  if (candidate.workflowStatus === "manual_intervention_required") return "manual_review_required";
  if (candidate.isFailed) return "historical_failed";
  if (candidate.gameStatus === "completed" && candidate.lastErrorCode) return "completed_with_error";
  return "historical";
}

export function selectCurrentManagedGame(candidates, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return null;
  const currentDate = getJstDateString(current);
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => normalizeManagedGameCandidate(candidate, current))
    .filter((candidate) => (candidate.internalGameId || candidate.legacyGameId) && !candidate.isTestGame);
  const byStartAscending = (left, right) => String(left.startAt || "").localeCompare(String(right.startAt || "")) || left.legacyGameId.localeCompare(right.legacyGameId);
  const byStartDescending = (left, right) => byStartAscending(right, left);
  const todayUncompleted = normalized.filter((candidate) => candidate.gameDate === currentDate && candidate.gameStatus !== "completed" && !candidate.isTerminal).sort(byStartAscending);
  const todayIncomplete = normalized.filter((candidate) => candidate.gameDate === currentDate && candidate.gameStatus === "completed" && !candidate.isTerminal).sort(byStartAscending);
  const recentUncompleted = normalized.filter((candidate) => {
    if (candidate.isFuture || candidate.isTerminal || !candidate.startAt) return false;
    const start = new Date(candidate.startAt);
    return !Number.isNaN(start.getTime()) && start.getTime() >= current.getTime() - 48 * 60 * 60 * 1000;
  }).sort(byStartDescending);
  const nextUpcoming = normalized.filter((candidate) => candidate.isFuture && !candidate.isTerminal).sort(byStartAscending);
  const recentFailures = normalized.filter((candidate) => candidate.isHistorical && candidate.isFailed).sort(byStartDescending);
  const historical = normalized.filter((candidate) => candidate.isHistorical).sort(byStartDescending);
  const selected = todayUncompleted[0] || todayIncomplete[0] || recentUncompleted[0] || nextUpcoming[0] || recentFailures[0] || historical[0] || null;
  if (!selected) return null;
  return {
    ...selected,
    classification: classifyManagedGame(selected),
    selectionReason: managedGameSelectionReason(selected, currentDate),
    isCurrent: !selected.isHistorical,
    isHistorical: selected.isHistorical,
    isFuture: selected.isFuture
  };
}

async function getCurrentManagedGameCandidates(db, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const historyFrom = new Date(current.getTime() - 30 * 24 * 60 * 60 * 1000);
  const dateFrom = getJstDateString(historyFrom);
  const dateTo = getJstDateString(new Date(current.getTime() + AUTOMATION_SCHEDULE_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000));
  const [gamesResult, scheduleResult, testResult] = await db.batch([
    db.prepare(
      `SELECT games.internal_game_id, games.game_date, games.start_time, games.home_team, games.away_team, games.game_status,
              state.legacy_game_id, state.game_status AS workflow_game_status, state.workflow_status, state.last_completed_job_type, state.last_error_code, state.last_error_at, state.next_due_at, state.updated_at
         FROM games
         LEFT JOIN game_workflow_state state ON state.internal_game_id = games.internal_game_id
        WHERE games.game_date >= ?1 AND games.game_date <= ?2
        ORDER BY games.game_date ASC, games.start_time ASC, games.internal_game_id ASC`
    ).bind(dateFrom, dateTo),
    db.prepare(
      `SELECT internal_game_id, game_id, game_date, start_at, home_team, away_team, game_code, venue, game_status
         FROM detected_game_schedule
        WHERE game_date >= ?1 AND game_date <= ?2
        ORDER BY game_date ASC, start_at ASC, game_id ASC`
    ).bind(dateFrom, dateTo),
    db.prepare(
      `SELECT internal_game_id, game_id
         FROM ranking_games
        WHERE is_test_game = 1 AND game_date >= ?1 AND game_date <= ?2`
    ).bind(dateFrom, dateTo)
  ]);
  const schedules = new Map();
  for (const row of scheduleResult?.results || []) {
    const key = String(row.internal_game_id || "");
    if (key && !schedules.has(key)) schedules.set(key, row);
  }
  const testIds = new Set();
  for (const row of testResult?.results || []) {
    if (row.internal_game_id) testIds.add(String(row.internal_game_id));
    if (row.game_id) testIds.add(String(row.game_id));
  }
  return (gamesResult?.results || []).map((row) => {
    const schedule = schedules.get(String(row.internal_game_id || "")) || {};
    const legacyGameId = String(row.legacy_game_id || schedule.game_id || "");
    return {
      internalGameId: row.internal_game_id,
      legacyGameId,
      gameDate: row.game_date || schedule.game_date,
      startAt: row.start_time || schedule.start_at,
      homeTeam: row.home_team || schedule.home_team,
      awayTeam: row.away_team || schedule.away_team,
      gameCode: schedule.game_code || "",
      venue: schedule.venue || "",
      gameStatus: row.workflow_game_status || row.game_status || schedule.game_status || "scheduled",
      workflowStatus: row.workflow_status || "waiting",
      lastCompletedJobType: row.last_completed_job_type || "",
      lastErrorCode: row.last_error_code || "",
      lastErrorAt: row.last_error_at || null,
      nextDueAt: row.next_due_at || null,
      updatedAt: row.updated_at || null,
      isTestGame: testIds.has(String(row.internal_game_id || "")) || testIds.has(legacyGameId)
    };
  });
}

async function getCurrentManagedGame(db, now = new Date()) {
  const candidates = await getCurrentManagedGameCandidates(db, now);
  return { selection: selectCurrentManagedGame(candidates, now), candidates };
}

function scheduleGameFromDetectedRow(row) {
  if (!row) return null;
  return {
    gameId: row.game_id,
    date: row.game_date,
    startAt: row.start_at,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    gameCode: row.game_code || "",
    venue: row.venue || "",
    status: row.game_status || "scheduled"
  };
}

async function getDetectedScheduleGame(db, gameId) {
  try {
    const row = await db.prepare(
      `SELECT game_id, game_date, start_at, home_team, away_team, game_code, venue, game_status
         FROM detected_game_schedule WHERE game_id = ?1 LIMIT 1`
    ).bind(gameId).first();
    return scheduleGameFromDetectedRow(row);
  } catch {
    return null;
  }
}

function resolveGameProgressContext({ gameId, target, detectedGame, identity, workflow }) {
  const candidates = [
    { source: "prediction_target", game: target, schedule: null },
    { source: "detected_game_schedule", game: detectedGame, schedule: null },
    { source: "existing_schedule", game: identity?.game, schedule: identity },
    { source: "workflow_state", game: workflow?.game, schedule: workflow?.schedule }
  ];
  const checkedScheduleSources = candidates.map((candidate) => candidate.source);
  const resolved = candidates.find((candidate) => {
    const schedule = candidate.schedule || buildPregameTimeline(candidate.game);
    return schedule?.startAt instanceof Date && !Number.isNaN(schedule.startAt.getTime())
      && schedule?.predictionDeadlineAt instanceof Date
      && !Number.isNaN(schedule.predictionDeadlineAt.getTime());
  });
  const sourceGame = resolved?.game || detectedGame || target || identity?.game || workflow?.game || { gameId };
  const schedule = resolved ? (resolved.schedule || buildPregameTimeline(resolved.game)) : null;
  const displayGame = {
    ...sourceGame,
    gameId,
    matchupLabel: [workflow?.game, identity?.game, target, detectedGame]
      .map((game) => String(game?.matchupLabel || "").trim())
      .find(Boolean) || formatGameProgressLabel(sourceGame)
  };
  return { game: displayGame, schedule, scheduleSource: resolved?.source || "none", checkedScheduleSources };
}

async function handleAdminGameProgressStatus(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const url = new URL(request.url);
  let gameId = getValidGameId(url.searchParams.get("gameId"));
  let target = null;
  let currentSelection = null;
  if (!gameId) {
    let managed = null;
    try {
      managed = await getCurrentManagedGame(env.AUTH_DB, new Date());
    } catch (error) {
      if (!isPregameSchemaError(error)) throw error;
      target = await getServerPredictionTarget(env.AUTH_DB, new Date());
    }
    currentSelection = managed?.selection || null;
    gameId = getValidGameId(currentSelection?.legacyGameId || currentSelection?.gameId);
    if (!gameId) gameId = getValidGameId(target?.gameId);
    if (currentSelection) {
      target = {
        gameId: currentSelection.legacyGameId || currentSelection.gameId,
        date: currentSelection.gameDate,
        startAt: currentSelection.startAt ? new Date(currentSelection.startAt) : null,
        homeTeam: currentSelection.homeTeam,
        awayTeam: currentSelection.awayTeam,
        gameCode: currentSelection.gameCode,
        venue: currentSelection.venue,
        internalGameId: currentSelection.internalGameId,
        status: currentSelection.gameStatus
      };
    }
  }
  if (!gameId) return jsonResponse({ ok: true, game: null, gameId: "", currentGame: null, selectionReason: "NO_MANAGED_GAME", statuses: null, errors: [], updatedAt: null }, 200, cors);
  if (await isTestRankingGame(env.AUTH_DB, gameId)) {
    return jsonResponse({ ok: true, game: null, gameId: "", statuses: null, errors: [], updatedAt: null, excluded: "test_game" }, 200, cors);
  }
  try {
    const record = await getPregameAutomationStatus(env.AUTH_DB, gameId);
    const detectedGame = await getDetectedScheduleGame(env.AUTH_DB, gameId);
    const predictionMetadata = await resolvePredictionGameMetadata(env.AUTH_DB, gameId);
    const resolvedTarget = predictionMetadata?.startAt ? {
      ...(predictionMetadata.game || {}),
      gameId: predictionMetadata.gameId || gameId,
      date: predictionMetadata.date,
      startAt: new Date(predictionMetadata.startAt),
      startTime: predictionMetadata.startAt,
      homeTeam: predictionMetadata.game?.home_team || predictionMetadata.game?.homeTeam || "",
      awayTeam: predictionMetadata.game?.away_team || predictionMetadata.game?.awayTeam || "",
      gameCode: predictionMetadata.gameCode || "",
      internalGameId: predictionMetadata.internalGameId || ""
    } : null;
    const identity = getGameIdentityForPregame(gameId);
    const context = resolveGameProgressContext({
      gameId,
      target: resolvedTarget || (target?.gameId === gameId ? target : null),
      detectedGame,
      identity,
      workflow: record
    });
    const [probableResult, rankingResult, logResult] = await env.AUTH_DB.batch([
      env.AUTH_DB.prepare("SELECT status, home_pitcher_name, away_pitcher_name, fetched_at, announced_at, error_code FROM probable_starters WHERE game_id = ?1 LIMIT 1").bind(gameId),
      env.AUTH_DB.prepare("SELECT is_ranking_eligible, ranking_eligible_at, publication_status, published_at FROM ranking_games WHERE game_id = ?1 LIMIT 1").bind(gameId),
      env.AUTH_DB.prepare("SELECT event_type, status, occurred_at, message, error_code FROM game_workflow_logs WHERE game_id = ?1 ORDER BY occurred_at DESC LIMIT 100").bind(gameId)
    ]);
    const probableStarter = probableResult?.results?.[0] || null;
    const rankingRow = rankingResult?.results?.[0] || null;
    const rankingEligibility = await getRankingEligibilityState(env.AUTH_DB, gameId);
    const logs = (logResult?.results || []).map((log) => ({ eventType: log.event_type, status: log.status, occurredAt: log.occurred_at, message: log.message, errorCode: log.error_code || "" }));
    const derived = deriveGameProgressStatuses({
      gameId,
      game: context.game,
      schedule: context.schedule,
      probableStarter,
      lineup: record.lineup,
      scoring: record.scoring,
      ranking: rankingRow ? { isRankingEligible: Number(rankingRow.is_ranking_eligible || 0) === 1, rankingEligibleAt: rankingRow.ranking_eligible_at || null, publicationStatus: rankingRow.publication_status || "pending", publishedAt: rankingRow.published_at || null } : null,
      logs,
      scheduleSource: context.scheduleSource,
      checkedScheduleSources: context.checkedScheduleSources
    });
    const game = context.game || { gameId };
    const gameLabel = formatGameProgressLabel(game);
    return jsonResponse({
      ok: true,
      gameId,
      game,
      gameLabel,
      updatedAt: derived.lastUpdatedAt,
      statuses: derived.statuses,
      errors: derived.errors,
      metadata: { scheduleSource: context.scheduleSource, checkedScheduleSources: context.checkedScheduleSources },
      rankingEligibility,
      currentGame: currentSelection,
      selectionReason: currentSelection?.selectionReason || "EXPLICIT_GAME_ID"
    }, 200, cors);
  } catch (error) {
    return jsonResponse({ ok: false, code: isPregameSchemaError(error) ? "GAME_PROGRESS_SCHEMA_NOT_READY" : "GAME_PROGRESS_STATUS_FAILED", error: "試合進行ステータスを取得できませんでした。" }, isPregameSchemaError(error) ? 503 : 500, cors);
  }
}

async function getPregameAutomationStatus(db, gameId) {
  const identity = getGameIdentityForPregame(gameId);
  const [job, snapshot, lineup, noticeResult, dailyNoticeResult, controlResult] = await db.batch([
    db.prepare("SELECT * FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1").bind(gameId),
    db.prepare("SELECT captured_at, player_count FROM game_roster_snapshots WHERE game_id = ?1 LIMIT 1").bind(gameId),
    db.prepare("SELECT lineup_source, lineup_detected_at, scoring_status, scoring_due_at, scored_at, publication_status, published_at, last_error FROM game_lineups WHERE game_id = ?1 LIMIT 1").bind(gameId),
    db.prepare("SELECT notice_status, registered_count, removed_count, last_checked_at, detected_at, roster_fixed_at, after_deadline_notice, last_error_code FROM game_day_notice_games WHERE game_id = ?1 LIMIT 1").bind(gameId),
    db.prepare("SELECT content_hash, fetched_at, source_url, last_slot_key, status, last_error_code FROM game_day_notices WHERE notice_date = ?1 LIMIT 1").bind(identity?.game?.date || ""),
    db.prepare("SELECT automation_paused, paused_at, resumed_at, updated_at FROM game_workflow_controls WHERE game_id = ?1 LIMIT 1").bind(gameId)
  ]);
  const notice = noticeResult?.results?.[0] || null;
  const dailyNotice = dailyNoticeResult?.results?.[0] || null;
  const control = controlResult?.results?.[0] || null;
  const jobRow = job?.results?.[0] || null;
  const lineupRow = lineup?.results?.[0] || null;
  const provisionalLineup = jobRow?.provisional_lineup_json
    ? parseStoredActualLineup(jobRow.provisional_lineup_json)
    : null;
  const nextNoticeAt = getNextGameDayNoticeAt(getPregameTimelines(), new Date());
  const statusNow = new Date();
  const nextAttempt = identity && !lineupRow
    ? statusNow < identity.startAt
      ? getNextPregameLineupAttempt(identity, jobRow?.last_lineup_attempt_at)
      : getNextFinalLineupAttempt(identity, jobRow?.final_lineup_attempt_at)
    : null;
  const workflow = getGameWorkflowProgress(identity, jobRow, lineupRow, notice, dailyNotice);
  const health = await getAutomationHealth(db);
  return {
    gameId,
    game: identity?.game ? {
      gameId: identity.game.gameId || gameId,
      date: identity.game.date || "",
      startTime: identity.game.startTime || "",
      matchupLabel: identity.game.matchupLabel || "",
      venue: identity.game.venue || ""
    } : null,
    schedule: identity ? {
      startAt: identity.startAt.toISOString(), rosterCaptureAt: identity.rosterCaptureAt.toISOString(), predictionDeadlineAt: identity.predictionDeadlineAt.toISOString(),
      lineupFetchStartAt: identity.lineupFetchStartAt.toISOString(), finalLineupFetchAt: identity.finalLineupFetchAt.toISOString(), resultReleaseAt: identity.resultReleaseAt.toISOString()
    } : null,
    roster: {
      status: snapshot?.results?.[0] ? "captured" : (jobRow?.roster_status || "pending"),
      capturedAt: snapshot?.results?.[0]?.captured_at || null,
      playerCount: snapshot?.results?.[0] ? Number(snapshot.results[0].player_count) : 0,
      fixedAt: jobRow?.roster_fixed_at || notice?.roster_fixed_at || null,
      lastSuccessfulFetchAt: jobRow?.last_successful_roster_fetch_at || null,
      nextCheckAt: jobRow?.roster_next_check_at || null,
      lastPregameCheckGameId: jobRow?.last_pregame_check_game_id || null,
      lastAttemptAt: jobRow?.last_roster_attempt_at || null,
      lastErrorCode: jobRow?.last_roster_error_code || null,
      fetchSource: jobRow?.last_roster_fetch_source || null
    },
    lineup: lineupRow ? {
      status: "captured", source: lineupRow.lineup_source, detectedAt: lineupRow.lineup_detected_at,
      finalLineupFallbackUsed: Number(jobRow?.final_lineup_fallback_used || 0) === 1,
      finalLineupErrorCode: jobRow?.final_lineup_error_code || "",
      finalLineupMessage: Number(jobRow?.final_lineup_fallback_used || 0) === 1 ? "最終取得失敗・直前取得データを使用" : ""
    } : {
      status: jobRow?.lineup_status === "failed" ? "failed" : jobRow?.provisional_lineup_json ? "provisional" : (jobRow?.lineup_status || "pending"),
      provisional: Boolean(jobRow?.provisional_lineup_json), provisionalDetectedAt: jobRow?.provisional_lineup_detected_at || null,
      provisionalLineup: Array.isArray(provisionalLineup) ? provisionalLineup.map((item) => ({ battingOrder: item.battingOrder, position: item.position, playerName: item.playerName })) : [],
      attempts: Number(jobRow?.lineup_attempt_count || 0), lastAttemptAt: jobRow?.last_lineup_attempt_at || null,
      finalAttemptAt: jobRow?.final_lineup_attempt_at || null, nextAttemptAt: nextAttempt
    },
    scoring: lineupRow ? { status: lineupRow.scoring_status, dueAt: lineupRow.scoring_due_at, scoredAt: lineupRow.scored_at, publicationStatus: lineupRow.publication_status || "pending", publishedAt: lineupRow.published_at || null, lastError: lineupRow.last_error || null } : { status: jobRow?.scoring_status || "pending", publicationStatus: "pending", publishedAt: null, lastError: null },
    publishing: lineupRow ? { status: workflow.publishingStatus, publishedAt: lineupRow.published_at || null, errorCode: workflow.errorCode || "", errorMessage: workflow.errorMessage || "" } : { status: "pending", publishedAt: null, errorCode: "", errorMessage: "" },
    notice: notice ? {
      status: notice.notice_status,
      registeredCount: Number(notice.registered_count || 0),
      removedCount: Number(notice.removed_count || 0),
      lastCheckedAt: notice.last_checked_at,
      detectedAt: notice.detected_at,
      rosterFixedAt: notice.roster_fixed_at,
      afterDeadline: Number(notice.after_deadline_notice || 0) === 1,
      lastErrorCode: notice.last_error_code || "",
      contentHash: dailyNotice?.content_hash || "",
      fetchedAt: dailyNotice?.fetched_at || null,
      sourceUrl: dailyNotice?.source_url || GAME_DAY_NOTICE_SOURCE,
      nextFetchAt: nextNoticeAt
    } : {
      status: GAME_DAY_NOTICE_STATUS.WAITING, registeredCount: 0, removedCount: 0,
      lastCheckedAt: null, detectedAt: null, rosterFixedAt: null, afterDeadline: false,
      lastErrorCode: dailyNotice?.last_error_code || "", contentHash: dailyNotice?.content_hash || "",
      fetchedAt: dailyNotice?.fetched_at || null, sourceUrl: dailyNotice?.source_url || GAME_DAY_NOTICE_SOURCE,
      nextFetchAt: nextNoticeAt
    },
    automation: {
      paused: Number(control?.automation_paused || 0) === 1,
      pausedAt: control?.paused_at || null,
      resumedAt: control?.resumed_at || null,
      health
    },
    workflow,
    lastErrorCode: workflow.errorCode || "",
    lastErrorMessage: workflow.errorMessage || ""
  };
}

export function classifyScheduleUnavailable({ startAt = null, now = new Date(), code = "SCHEDULE_UNAVAILABLE" } = {}) {
  const rawCode = String(code || "").trim();
  if (!["SCHEDULE_UNAVAILABLE", "GAME_NOT_FOUND", "SCHEDULE_NOT_PUBLISHED"].includes(rawCode)) {
    return { status: "error", code: rawCode || "SCHEDULE_FETCH_FAILED", retryable: false, detail: "試合情報を取得できませんでした。" };
  }
  const start = startAt instanceof Date ? startAt : new Date(startAt || "");
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isNaN(start.getTime()) && !Number.isNaN(current.getTime()) && start.getTime() > current.getTime()) {
    return { status: "waiting", code: "SCHEDULE_NOT_PUBLISHED", retryable: true, detail: "試合情報公開待ち" };
  }
  return { status: "error", code: "SCHEDULE_FETCH_FAILED", retryable: true, detail: "試合情報の取得に失敗しました。" };
}

export function deriveGameWorkflowProgress({ identity = null, job = null, lineup = null, notice = null, dailyNotice = null, now = new Date() } = {}) {
  const lineupError = lineup?.scoring_status === "failed" ? "SCORING_FAILED" : "";
  const rawLastErrorCode = String(job?.last_error_code || dailyNotice?.last_error_code || lineupError || "");
  const scheduleAvailability = classifyScheduleUnavailable({ startAt: identity?.startAt, now, code: rawLastErrorCode });
  const scheduleWaiting = scheduleAvailability.status === "waiting";
  const lastErrorCode = scheduleWaiting ? "" : rawLastErrorCode;
  const lastErrorMessage = String(job?.last_error_message || lineup?.last_error || "");
  const timestamps = [
    job?.updated_at,
    notice?.last_checked_at,
    notice?.roster_fixed_at,
    dailyNotice?.fetched_at,
    lineup?.lineup_detected_at,
    lineup?.scored_at,
    lineup?.published_at
  ].filter(Boolean).map((value) => new Date(value)).filter((value) => !Number.isNaN(value.getTime()));
  const lastRunAt = timestamps.length ? new Date(Math.max(...timestamps.map((value) => value.getTime()))).toISOString() : null;
  if (scheduleWaiting) {
    return {
      currentStep: identity && now >= identity.predictionDeadlineAt ? "close_predictions" : "notice",
      lastRunAt,
      lastResult: "retry_wait",
      publishingStatus: lineup?.publication_status || "pending",
      errorCode: "",
      errorMessage: scheduleAvailability.detail,
      waitingReasonCode: scheduleAvailability.code
    };
  }
  if (lineup?.publication_status === "published") return { currentStep: "completed", lastRunAt, lastResult: "published", publishingStatus: "published", errorCode: "", errorMessage: "" };
  if (lastErrorCode) {
    const publishFailure = lastErrorCode === "PUBLISH_FAILED";
    return {
      currentStep: publishFailure ? "publish" : "score",
      lastRunAt,
      lastResult: publishFailure ? "publish_failed" : "scoring_failed",
      publishingStatus: publishFailure ? "failed" : (lineup?.publication_status || "pending"),
      errorCode: lastErrorCode,
      errorMessage: lastErrorMessage
    };
  }
  if (lineup?.scoring_status === "scored") return { currentStep: "publish", lastRunAt, lastResult: "scored_private", publishingStatus: lineup.publication_status || "scored_private", errorCode: "", errorMessage: "" };
  if (lineup?.scoring_status === "processing") return { currentStep: "score", lastRunAt, lastResult: "scoring", publishingStatus: "pending", errorCode: "", errorMessage: "" };
  if (lineup) return { currentStep: "score", lastRunAt, lastResult: "scoring_pending", publishingStatus: "pending", errorCode: "", errorMessage: "" };
  if (job?.provisional_lineup_json) {
    return { currentStep: now >= identity?.finalLineupFetchAt ? "final_lineup" : "lineup", lastRunAt, lastResult: "provisional", publishingStatus: "pending", errorCode: "", errorMessage: "" };
  }
  if (identity && now >= identity.startAt) return { currentStep: "score", lastRunAt, lastResult: "waiting", publishingStatus: "pending", errorCode: "", errorMessage: "" };
  if (identity && now >= identity.lineupFetchStartAt) return { currentStep: "lineup", lastRunAt, lastResult: "waiting", publishingStatus: "pending", errorCode: "", errorMessage: "" };
  if (identity && now >= identity.predictionDeadlineAt) return { currentStep: "close_predictions", lastRunAt, lastResult: "waiting", publishingStatus: "pending", errorCode: "", errorMessage: "" };
  return { currentStep: "notice", lastRunAt, lastResult: "waiting", publishingStatus: "pending", errorCode: "", errorMessage: "" };
}

function getGameWorkflowProgress(identity, job, lineup, notice, dailyNotice) {
  return deriveGameWorkflowProgress({ identity, job, lineup, notice, dailyNotice, now: new Date() });
}

function getNextGameDayNoticeAt(timelines, now) {
  const plan = getNoticePollingPlan(timelines, now);
  if (!plan.date) return null;
  if (!plan.due) {
    const hasToday = (Array.isArray(timelines) ? timelines : []).some((timeline) => timeline?.game?.date === plan.date && now < timeline.predictionDeadlineAt);
    return hasToday ? new Date(`${plan.date}T10:00:00+09:00`).toISOString() : null;
  }
  const active = (Array.isArray(timelines) ? timelines : []).filter((timeline) => plan.activeGameIds.includes(timeline.gameId));
  const monitorStart = new Date(`${plan.date}T10:00:00+09:00`);
  const highFrequency = active.some((timeline) => now >= new Date(timeline.startAt.getTime() - 2 * 60 * 60 * 1000));
  const anchor = highFrequency
    ? new Date(Math.min(...active.map((timeline) => timeline.startAt.getTime() - 2 * 60 * 60 * 1000)))
    : monitorStart;
  const next = anchor.getTime() + (Math.floor((now.getTime() - anchor.getTime()) / (plan.intervalMinutes * 60 * 1000)) + 1) * plan.intervalMinutes * 60 * 1000;
  return new Date(next).toISOString();
}

function getNextPregameLineupAttempt(timeline, lastAttemptAt) {
  const last = lastAttemptAt ? new Date(lastAttemptAt).getTime() : null;
  for (let time = timeline.lineupFetchStartAt.getTime(); time <= timeline.startAt.getTime(); time += 10 * 60 * 1000) {
    if (!last || time > last) return new Date(time).toISOString();
  }
  return null;
}

function getNextFinalLineupAttempt(timeline, lastAttemptAt) {
  const first = timeline.finalLineupFetchAt.getTime();
  const last = lastAttemptAt ? new Date(lastAttemptAt).getTime() : null;
  if (!last || Number.isNaN(last)) return new Date(first).toISOString();
  return new Date(last + 10 * 60 * 1000).toISOString();
}

async function handleAdminPredictionSummary(env, cors, gameId) {
  const row = await env.AUTH_DB.prepare(
    `SELECT COUNT(*) AS prediction_count,
            SUM(CASE WHEN status = 'scored' THEN 1 ELSE 0 END) AS scored_count
       FROM predictions
      WHERE game_id = ?1 AND is_test_prediction = 0`
  ).bind(gameId).first();

  return jsonResponse({
    ok: true,
    gameId,
    predictionCount: Number(row?.prediction_count || 0),
    scoredCount: Number(row?.scored_count || 0)
  }, 200, cors);
}

async function handleAdminScorePredictionsPreview(request, env, cors, gameId) {
  if (await isServiceUnavailableGame(env.AUTH_DB, gameId)) {
    return jsonResponse({ ok: false, code: "SERVICE_UNAVAILABLE_GAME", error: SERVICE_UNAVAILABLE_MESSAGE }, 409, cors);
  }
  const record = await getGameLineup(env.AUTH_DB, gameId);
  if (!record) {
    return jsonResponse({
      ok: false,
      code: "SCORING_LINEUP_REQUIRED",
      error: "採点に使用する正式スタメンが保存されていません。"
    }, 409, cors);
  }
  const actualResult = sanitizeActualLineupForScoring(parseStoredActualLineup(record.actual_lineup_json));
  if (!actualResult.ok) {
    return jsonResponse({ ok: false, error: actualResult.error }, 400, cors);
  }

  const scoring = await prepareGamePredictionScoring(env.AUTH_DB, gameId, actualResult.lineup);
  return jsonResponse({
    ok: true,
    gameId,
    processed: scoring.processed,
    scored: scoring.scored,
    failed: scoring.failed,
    maxScore: SCORING_MAX_SCORE,
    averageScore: scoring.averageScore,
    perfectCount: scoring.perfectCount,
    scoreDistribution: scoring.scoreDistribution,
    validationErrors: scoring.validationErrors,
    lineupFingerprint: record.lineup_fingerprint,
    lineupDetectedAt: record.lineup_detected_at
  }, 200, cors);
}

async function handleAdminScorePredictions(request, env, cors, gameId) {
  if (await isServiceUnavailableGame(env.AUTH_DB, gameId)) {
    return jsonResponse({ ok: false, code: "SERVICE_UNAVAILABLE_GAME", error: SERVICE_UNAVAILABLE_MESSAGE }, 409, cors);
  }
  const record = await getGameLineup(env.AUTH_DB, gameId);
  if (!record) {
    return jsonResponse({
      ok: false,
      code: "SCORING_LINEUP_REQUIRED",
      error: "採点に使用する正式スタメンが保存されていません。"
    }, 409, cors);
  }
  const actualResult = sanitizeActualLineupForScoring(parseStoredActualLineup(record.actual_lineup_json));
  if (!actualResult.ok) {
    return jsonResponse({ ok: false, error: actualResult.error }, 400, cors);
  }

  // 手動採点も保存済みgame_lineupsを使い、クライアント入力で正式スタメンを差し替えません。
  const scoringStartedAt = new Date();
  await markGameRankingPending(env.AUTH_DB, gameId, scoringStartedAt, env);
  const claimed = await claimGameLineupForScoring(env.AUTH_DB, gameId, scoringStartedAt, { force: true });
  if (!claimed) {
    return jsonResponse({ ok: false, error: "この試合は現在採点処理中です。" }, 409, cors);
  }

  try {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "scoring_started",
      status: "info",
      gameId,
      occurredAt: scoringStartedAt,
      message: "採点を開始しました。",
      metadata: { source: "admin" },
      source: "admin"
    });
    const result = await scoreClaimedGameLineup(env.AUTH_DB, claimed, new Date());
    await recordGameWorkflowOutcome(env.AUTH_DB, gameId, "score", "success", null, new Date());
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "scoring_succeeded",
      status: "success",
      gameId,
      occurredAt: new Date(),
      message: "採点が完了しました。",
      metadata: { processed: result.processed, perfectCount: result.perfectCount, source: "admin" },
      source: "admin"
    });
    return jsonResponse({
      ok: true,
      gameId,
      processed: result.processed,
      scored: result.scored,
      failed: result.failed,
      maxScore: SCORING_MAX_SCORE,
      perfectCount: result.perfectCount,
      newPerfectAchievers: result.newPerfectAchievers,
      scoredAt: result.scoredAt,
      message: result.processed === 0 ? "保存済み予想はありません。" : undefined,
      autoScoring: serializeGameLineup(await getGameLineup(env.AUTH_DB, gameId))
    }, 200, cors);
  } catch (error) {
    await markGameLineupFailed(env.AUTH_DB, gameId, error, new Date());
    await recordGameWorkflowOutcome(env.AUTH_DB, gameId, "score", "failed", error, new Date());
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "scoring_failed",
      status: "error",
      gameId,
      occurredAt: new Date(),
      message: "採点に失敗しました。",
      errorCode: String(error?.code || "SCORING_FAILED"),
      metadata: { source: "admin" },
      source: "admin"
    });
    if (error?.code === "prediction_validation_failed") {
      return jsonResponse({
        ok: false,
        error: "保存済み予想に検証エラーがあるため、本番採点は実行されませんでした。",
        gameId,
        processed: error.processed,
        scored: 0,
        failed: error.failed,
        maxScore: SCORING_MAX_SCORE,
        validationErrors: error.validationErrors
      }, 409, cors);
    }
    throw error;
  }
}

async function prepareGamePredictionScoring(db, gameReference, actualLineup, isTestPrediction = 0) {
  const metadata = typeof gameReference === "object" && gameReference ? gameReference : null;
  const gameId = String(metadata?.gameId || gameReference || "");
  const internalGameId = String(metadata?.internalGameId || "");
  const storage = await getInternalGameIdStorageAvailability(db, ["predictions"]);
  if (internalGameId && !storage.predictions) {
    throw createV3Error("V3_SCORING_SCHEMA_UNAVAILABLE", "V3採点のcanonical predictions schemaが準備されていません。", {
      httpStatus: 503,
      retryable: false
    });
  }
  const scope = internalGameId ? "internal_game_id = ?1" : "game_id = ?1";
  const bindings = internalGameId ? [internalGameId] : [gameId];
  const productionQuery = `SELECT id, user_id, prediction_json FROM predictions WHERE ${scope} AND is_test_prediction = 0 ORDER BY submitted_at ASC, id ASC`;
  const testQuery = `SELECT id, user_id, prediction_json FROM predictions WHERE ${scope} AND is_test_prediction = 1 ORDER BY submitted_at ASC, id ASC`;
  const rows = await db.prepare(isTestPrediction ? testQuery : productionQuery).bind(...bindings).all();

  const outcomes = [];
  const exclusions = [];
  const validationErrors = [];
  const distribution = new Map();

  for (const row of rows?.results || []) {
    const prediction = parseStoredPrediction(row.prediction_json);
    const sanitized = prediction ? sanitizePredictionPayload(prediction) : { ok: false, error: "保存済み予想の形式が不正です。" };
    if (!sanitized.ok) {
      const message = String(sanitized.error || "");
      const reason = message.includes("9人") ? "INCOMPLETE_LINEUP"
        : message.includes("同じ選手") ? "DUPLICATE_PLAYER"
          : message.includes("打順が重複") ? "DUPLICATE_ORDER"
            : "INVALID_PREDICTION";
      exclusions.push({ id: row.id, reason });
      continue;
    }

    const score = scorePredictionLineup(sanitized.prediction.lineup, actualLineup);
    outcomes.push({ id: row.id, userId: row.user_id, score });
    distribution.set(score.total, (distribution.get(score.total) || 0) + 1);
  }

  const scored = outcomes.length;
  const totalScore = outcomes.reduce((total, outcome) => total + outcome.score.total, 0);
  return {
    processed: (rows?.results || []).length,
    scored,
    failed: 0,
    excluded: exclusions.length,
    exclusions,
    outcomes,
    validationErrors: Array.from(new Set(validationErrors)).slice(0, 10),
    averageScore: scored ? Number((totalScore / scored).toFixed(2)) : 0,
    perfectCount: outcomes.filter((outcome) => outcome.score.total === SCORING_MAX_SCORE).length,
    scoreDistribution: Object.fromEntries(
      Array.from(distribution.entries()).sort((left, right) => left[0] - right[0]).map(([score, count]) => [String(score), count])
    )
  };
}

async function scoreClaimedGameLineup(db, record, now, isTestPrediction = 0) {
  const storedLineup = parseStoredActualLineup(record.actual_lineup_json);
  const actualResult = sanitizeActualLineupForScoring(storedLineup, { allowUnresolvedPlayer: true });
  if (!actualResult.ok) {
    throw new Error(`stored actual lineup is invalid: ${actualResult.error}`);
  }

  const currentLineupRevision = await getCurrentLineupRevisionForScoring(db, record.game_id);
  const revisionId = record.scoring_lineup_revision_id
    || currentLineupRevision?.revisionId
    || `${record.game_id}:1`;
  const revision = await beginGameScoringRevision(db, {
    gameId: record.game_id,
    internalGameId: record.internal_game_id || "",
    lineupRevisionId: revisionId,
    reason: Number(record.scoring_revision || 0) > 0 ? "lineup_correction" : "initial_scoring",
    now
  });
  if (revision.existingCompleted) {
    const completedRevision = record.internal_game_id
      ? await ensurePersistedScoringRevision(db, {
        gameId: record.game_id,
        internalGameId: record.internal_game_id,
        lineupRevisionId: revisionId,
        revisionNumber: revision.number,
        reason: "existing_completed_scoring",
        now
      })
      : revision;
    await db.prepare(
      "UPDATE game_lineups SET scoring_status = 'scored', scoring_started_at = NULL, last_error = NULL, updated_at = ?1 WHERE game_id = ?2 AND scoring_status = 'processing'"
    ).bind(now.toISOString(), record.game_id).run();
    return {
      processed: 0,
      scored: 0,
      excluded: 0,
      failed: 0,
      maxScore: SCORING_MAX_SCORE,
      perfectCount: 0,
      newPerfectAchievers: 0,
      scoredAt: now.toISOString(),
      lineupRevisionId: revisionId,
      scoringRevision: revision.number,
      scoringRevisionId: completedRevision?.id || revision.id,
      status: "already_scored"
    };
  }

  try {
    const scoring = await prepareGamePredictionScoring(
      db,
      { gameId: record.game_id, internalGameId: record.internal_game_id || "" },
      actualResult.lineup,
      isTestPrediction
    );
    if (scoring.failed > 0) {
      const error = new Error("stored predictions include validation errors");
      error.code = "prediction_validation_failed";
      error.processed = scoring.processed;
      error.failed = scoring.failed;
      error.validationErrors = scoring.validationErrors;
      throw error;
    }
    const result = await persistGamePredictionScoring(
      db,
      record.game_id,
      actualResult.lineup,
      scoring,
      now,
      isTestPrediction,
      record.internal_game_id || "",
      revision.number
    );
    const noOpReason = scoring.processed === 0
      ? "V3_SCORING_NO_PREDICTIONS"
      : scoring.scored === 0 && scoring.excluded === scoring.processed
        ? "V3_SCORING_NO_ELIGIBLE_PREDICTIONS"
        : null;
    const persistedRevision = record.internal_game_id
      ? await ensurePersistedScoringRevision(db, {
        gameId: record.game_id,
        internalGameId: record.internal_game_id,
        lineupRevisionId: revisionId,
        revisionNumber: revision.number,
        reason: noOpReason || "initial_scoring",
        now
      })
      : revision;
    await completeGameScoringRevision(db, {
      internalGameId: record.internal_game_id || "",
      scoringRevisionId: persistedRevision?.id || revision.id,
      now
    });
    return { ...result, scoringRevisionId: persistedRevision?.id || revision.id, status: noOpReason ? "no_op_success" : "scored", noOpReason };
  } catch (error) {
    await failGameScoringRevision(db, { scoringRevisionId: revision.id, error, now });
    throw error;
  }
}

async function persistGamePredictionScoring(db, gameId, actualLineup, scoring, now, isTestPrediction = 0, internalGameId = "", scoringRevisionNumber = null) {
  const scoredAt = now.toISOString();
  const actualLineupJson = JSON.stringify(actualLineup);
  const scoreSql = isTestPrediction
    ? `UPDATE predictions
          SET score = ?1, max_score = ?2, scored_at = ?3, status = 'scored', actual_lineup_json = ?4
        WHERE id = ?5 AND game_id = ?6 AND is_test_prediction = 1`
    : `UPDATE predictions
          SET score = ?1, max_score = ?2, scored_at = ?3, status = 'scored', actual_lineup_json = ?4
        WHERE id = ?5 AND game_id = ?6`;
  const statements = scoring.outcomes.map((outcome) => db.prepare(scoreSql).bind(
    outcome.score.total, SCORING_MAX_SCORE, scoredAt, actualLineupJson, outcome.id, gameId
  ));
  try {
    const predictionColumns = await getTableColumnSet(db, "predictions");
    if (predictionColumns.has("scoring_status") && predictionColumns.has("scoring_exclusion_reason")) {
      for (const exclusion of scoring.exclusions || []) {
        statements.push(db.prepare(
          `UPDATE predictions
              SET scoring_status = 'excluded', scoring_exclusion_reason = ?, updated_at = ?
            WHERE id = ? AND game_id = ? AND is_test_prediction = ?`
        ).bind(exclusion.reason, scoredAt, exclusion.id, gameId, isTestPrediction ? 1 : 0));
      }
    }
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }

  const predictionStatementCount = statements.length;
  statements.push(db.prepare(
    `UPDATE game_lineups
        SET scoring_status = 'scored', scored_at = ?1, scoring_started_at = NULL,
            last_error = NULL, processed_predictions = ?2, perfect_count = ?3,
            new_perfect_achievers = ?4, updated_at = ?1
      WHERE game_id = ?5 AND scoring_status = 'processing'`
  ).bind(scoredAt, scoring.processed, scoring.perfectCount, 0, gameId));
  const rankingStatement = await createGameRankingScoredPrivateStatement(db, gameId, scoredAt, 0, internalGameId);
  const effectiveRankingStatement = isTestPrediction
    ? await createGameRankingScoredPrivateStatement(db, gameId, scoredAt, 1, internalGameId)
    : rankingStatement;
  if (isTestPrediction && effectiveRankingStatement) statements.push(effectiveRankingStatement);
  else if (rankingStatement) statements.push(rankingStatement);

  const results = await db.batch(statements);
  const predictionResults = results.slice(0, scoring.outcomes.length);
  if (predictionResults.some((result) => Number(result?.meta?.changes || 0) !== 1)) {
    throw new Error("prediction score update count mismatch");
  }
  const gameLineupResult = results[predictionStatementCount];
  if (Number(gameLineupResult?.meta?.changes || 0) !== 1) {
    throw new Error("game lineup scoring state update mismatch");
  }
  if (effectiveRankingStatement && Number(results[results.length - 1]?.meta?.changes || 0) !== 1) {
    throw new Error("game ranking private state update mismatch");
  }

  const revision = await getCurrentLineupRevisionForScoring(db, gameId);
  const scoringRevision = Number(scoringRevisionNumber || await getNextScoringRevision(db, gameId));
  await recordScoringRevisionMetadata(db, {
    gameId,
    internalGameId,
    lineupRevisionId: revision?.revisionId || `${gameId}:${Number(revision?.version || 1)}`,
    scoringRevision,
    scoredBy: "system",
    scoredAt,
    isTestPrediction
  });

  return {
    processed: scoring.processed,
    scored: scoring.scored,
    excluded: scoring.excluded || 0,
    failed: scoring.failed || 0,
    maxScore: SCORING_MAX_SCORE,
    perfectCount: scoring.perfectCount,
    newPerfectAchievers: 0,
    scoredAt,
    lineupRevisionId: revision?.revisionId || `${gameId}:${Number(revision?.version || 1)}`,
    scoringRevision
  };
}

async function handleAdminActualLineupSave(request, env, cors, gameId, metadata = null) {
  const input = await readJson(request);
  const actualResult = sanitizeActualLineupForScoring(input?.actualLineup);
  if (!actualResult.ok) {
    return jsonResponse({ ok: false, error: actualResult.error }, 400, cors);
  }

  const now = new Date();
  try {
    assertOfficialLineupSaveAllowed(gameId, now);
    const existing = await getGameLineup(env.AUTH_DB, gameId);
    if (existing && (existing.scoring_status === "processing"
      || existing.scoring_status === "scored"
      || existing.publication_status === "published"
      || await isManualRescoreLocked(env.AUTH_DB, gameId))) {
      return jsonResponse({
        ok: false,
        code: "LINEUP_REVISION_REQUIRED",
        error: "採点済みまたは再採点処理中の正式スタメンは、正式スタメン修正・再採点機能を使用してください。"
      }, 409, cors);
    }

    const detectedAt = parseLineupDetectedAt(input?.lineupDetectedAt) || now;
    const revision = await saveLineupCandidateRevision(env.AUTH_DB, {
      gameId,
      internalGameId: metadata?.internalGameId || "",
      lineup: actualResult.lineup,
      source: "admin",
      capturedAt: detectedAt,
      validation: { source: "admin", playerCount: actualResult.lineup.length },
      reason: String(input?.reason || "管理者による初回正式スタメン登録").slice(0, 240)
    });
    const record = await approveActualLineupForAutoScoring(env, gameId, actualResult.lineup, detectedAt, {
      scoringDueAt: detectedAt,
      now,
      source: "manual",
      internalGameId: metadata?.internalGameId || ""
    });
    await activateLineupRevision(env.AUTH_DB, { gameId, version: revision.version, internalGameId: metadata?.internalGameId || "", finalizedAt: now, finalizedBy: "admin" });
    await linkFinalLineupRevision(env.AUTH_DB, { gameId, internalGameId: metadata?.internalGameId || "", version: revision.version, finalizedAt: now, finalizedBy: "admin" });
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_lineup_approved",
      status: "success",
      gameId,
      occurredAt: now,
      message: "管理者が正式スタメンを登録しました。",
      metadata: { source: "admin", playerCount: actualResult.lineup.length, revision: Number(revision.version) },
      source: "admin"
    });
    console.log(`auto scoring scheduled: game=${gameId} due=${record.scoring_due_at}`);
    return jsonResponse({
      ok: true,
      gameId,
      autoScoring: serializeGameLineup(record),
      lineupRevision: serializeLineupRevision(revision)
    }, 200, cors);
  } catch (error) {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_lineup_approved",
      status: "error",
      gameId,
      occurredAt: now,
      message: "管理者による正式スタメン登録に失敗しました。",
      errorCode: String(error?.code || "LINEUP_SAVE_FAILED"),
      source: "admin"
    });
    if (error?.code === "LINEUP_SAVE_CLOSED" || error?.code === "SCHEDULE_UNAVAILABLE") {
      return jsonResponse({ ok: false, code: error.code, error: error.message }, error.httpStatus || 409, cors);
    }
    throw error;
  }
}

export function getManualRescoreExpiresAt(gameDate) {
  const base = new Date(`${gameDate}T23:59:59.999+09:00`);
  return new Date(base.getTime() + MANUAL_RESCORE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

function validateManualRescoreInput(input, metadata, { requireReason = true } = {}) {
  if (!input || String(input.gameId || "") !== metadata.gameId) {
    throw createPregameError("RESCORE_GAME_ID_MISMATCH", "URLとリクエスト本文の対象試合が一致しません。", { httpStatus: 409 });
  }
  if (String(input.gameDate || "") !== metadata.date
    || String(input.homeTeam || "").toLowerCase() !== metadata.homeCode
    || String(input.awayTeam || "").toLowerCase() !== metadata.awayCode) {
    throw createPregameError("RESCORE_GAME_METADATA_MISMATCH", "対象試合の日付または対戦カードが一致しません。", { httpStatus: 409 });
  }
  const reason = String(input.reason || "").trim();
  if (requireReason && (!reason || reason.length > 240)) {
    throw createPregameError("RESCORE_REASON_REQUIRED", "修正理由を1〜240文字で入力してください。", { httpStatus: 400 });
  }
  return reason;
}

function assertManualRescoreWindow(metadata, now = new Date()) {
  const expiresAt = getManualRescoreExpiresAt(metadata.date);
  if (now > expiresAt) {
    throw createPregameError("RESCORE_WINDOW_EXPIRED", "この試合の通常再採点可能期間は終了しています。", { httpStatus: 409 });
  }
  return expiresAt;
}

function serializeLineupRevision(row) {
  return {
    gameId: row.game_id,
    version: Number(row.version),
    revisionId: row.revision_id || `${row.game_id}:${Number(row.version)}`,
    internalGameId: row.internal_game_id || null,
    source: row.source,
    createdAt: row.created_at,
    capturedAt: row.captured_at || row.created_at,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    reason: row.reason,
    isCurrent: Number(row.is_current) === 1,
    supersededAt: row.superseded_at || null,
    finalizedAt: row.finalized_at || null,
    finalizedBy: row.finalized_by || null,
    unresolvedPlayerCount: Number(row.unresolved_player_count || 0),
    isFinal: Number(row.is_final || 0) === 1,
    validation: row.validation_json ? parseJsonObject(row.validation_json) : null
  };
}

async function ensureCurrentLineupRevision(db, metadata) {
  const current = await db.prepare(
    "SELECT * FROM game_lineup_revisions WHERE game_id = ?1 AND is_current = 1 LIMIT 1"
  ).bind(metadata.gameId).first();
  if (current) return current;

  const lineup = await getGameLineup(db, metadata.gameId);
  const actual = sanitizeActualLineupForScoring(parseStoredActualLineup(lineup?.actual_lineup_json));
  if (!lineup || !actual.ok) {
    throw createPregameError("RESCORE_LINEUP_REQUIRED", "再採点する正式スタメンが保存されていません。", { httpStatus: 409 });
  }
  const createdAt = lineup.lineup_detected_at || new Date().toISOString();
  await db.prepare(
    `INSERT INTO game_lineup_revisions
       (game_id, version, actual_lineup_json, lineup_fingerprint, source, created_at, created_by, reason, is_current, superseded_at)
     VALUES (?1, 1, ?2, ?3, ?4, ?5, NULL, '既存の正式スタメンを履歴化', 1, NULL)`
  ).bind(metadata.gameId, JSON.stringify(actual.lineup), lineup.lineup_fingerprint, lineup.lineup_source === "npb-auto" ? "npb-auto" : "manual", createdAt).run();
  return db.prepare(
    "SELECT * FROM game_lineup_revisions WHERE game_id = ?1 AND version = 1 LIMIT 1"
  ).bind(metadata.gameId).first();
}

async function getLineupRevision(db, gameId, version) {
  return db.prepare(
    "SELECT * FROM game_lineup_revisions WHERE game_id = ?1 AND version = ?2 LIMIT 1"
  ).bind(gameId, Number(version)).first();
}

function createManualRescoreErrorResponse(cors, error) {
  const code = String(error?.code || (isPregameSchemaError(error) ? "RESCORE_SCHEMA_NOT_READY" : "RESCORE_FAILED"));
  const status = Number(error?.httpStatus) || (code === "RESCORE_SCHEMA_NOT_READY" ? 503 : 500);
  const messages = {
    RESCORE_GAME_ID_MISMATCH: "URLとリクエスト本文の対象試合が一致しません。",
    RESCORE_GAME_METADATA_MISMATCH: "対象試合の日付または対戦カードが一致しません。",
    RESCORE_REASON_REQUIRED: "修正理由を入力してください。",
    RESCORE_WINDOW_EXPIRED: "この試合の通常再採点可能期間は終了しています。",
    RESCORE_LINEUP_REQUIRED: "再採点する正式スタメンが保存されていません。",
    RESCORE_LINEUP_UNCHANGED: "現在の正式スタメンと同じ内容です。",
    RESCORE_RESTORE_VERSION_INVALID: "復元する正式スタメンversionが見つかりません。",
    RESCORE_PREVIEW_INVALID: "再採点プレビューを確認してください。",
    RESCORE_PREVIEW_EXPIRED: "再採点プレビューの有効期限が切れました。",
    RESCORE_VERSION_CHANGED: "正式スタメンversionが変わりました。再プレビューしてください。",
    RESCORE_SCHEMA_NOT_READY: "再採点用データベースが準備されていません。"
  };
  return jsonResponse({ ok: false, code, error: messages[code] || "再採点処理を実行できませんでした。" }, status, cors);
}

async function handleAdminLineupHistory(env, cors, gameId) {
  const metadata = parsePredictionGameId(gameId);
  try {
    const current = await ensureCurrentLineupRevision(env.AUTH_DB, metadata);
    const rows = await env.AUTH_DB.prepare(
      "SELECT * FROM game_lineup_revisions WHERE game_id = ?1 ORDER BY version DESC"
    ).bind(gameId).all();
    return jsonResponse({
      ok: true,
      gameId,
      gameDate: metadata.date,
      rescoreExpiresAt: getManualRescoreExpiresAt(metadata.date).toISOString(),
      currentVersion: Number(current.version),
      revisions: (rows.results || []).map(serializeLineupRevision)
    }, 200, cors);
  } catch (error) {
    return createManualRescoreErrorResponse(cors, error);
  }
}

async function handleAdminRescoreHistory(env, cors, gameId) {
  try {
    const rows = await env.AUTH_DB.prepare(
      `SELECT game_id, game_date, previous_version, lineup_version, reason, executed_at,
              prediction_count, changed_score_count, perfect_count_delta, status, error_code
         FROM game_rescore_audits WHERE game_id = ?1 ORDER BY executed_at DESC LIMIT 30`
    ).bind(gameId).all();
    return jsonResponse({ ok: true, gameId, history: rows.results || [] }, 200, cors);
  } catch (error) {
    return createManualRescoreErrorResponse(cors, error);
  }
}

async function createManualLineupRevision(db, metadata, actualLineup, userId, reason, source = "manual-revision") {
  const current = await ensureCurrentLineupRevision(db, metadata);
  const fingerprint = await sha256Base64Url(JSON.stringify(actualLineup));
  if (current.lineup_fingerprint === fingerprint) {
    throw createPregameError("RESCORE_LINEUP_UNCHANGED", "現在の正式スタメンと同じ内容です。", { httpStatus: 409 });
  }
  const revision = await saveLineupCandidateRevision(db, {
    gameId: metadata.gameId,
    internalGameId: metadata.internalGameId || "",
    lineup: actualLineup,
    source: source === "restore" ? "restore" : "admin",
    capturedAt: new Date(),
    reason,
    createdBy: userId
  });
  const activated = await activateLineupRevision(db, {
    gameId: metadata.gameId,
    version: revision.version,
    internalGameId: metadata.internalGameId || "",
    finalizedAt: new Date(),
    finalizedBy: "admin"
  });
  await markManualLineupCorrectionPending(db, metadata.internalGameId || "", new Date());
  return activated;
}

async function markManualLineupCorrectionPending(db, internalGameId, now) {
  if (!internalGameId) return false;
  const current = await db.prepare(
    "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
  ).bind(internalGameId).first();
  if (!current) return false;
  const currentState = String(current.state || "");
  if (currentState === "manual_action_required") return true;
  if (currentState !== "published") return false;
  await transitionV3State(db, {
    internalGameId,
    from: currentState,
    to: "manual_action_required",
    now,
    failureCode: "LINEUP_CORRECTION_PENDING",
    failureMessage: "管理者による正式スタメン修正を待っています。"
  });
  return true;
}

async function markManualRescoreCompleted(db, internalGameId, publicationStatus, now, { deferPublication = false } = {}) {
  if (!internalGameId) return false;
  const current = await db.prepare(
    "SELECT state FROM game_automation_v3_state WHERE internal_game_id = ?1 LIMIT 1"
  ).bind(internalGameId).first();
  if (!current) return false;
  let currentState = String(current.state || "");
  if (currentState === "published") {
    await transitionV3State(db, {
      internalGameId,
      from: currentState,
      to: "manual_action_required",
      now,
      failureCode: "RESCORE_PENDING",
      failureMessage: "修正版の再採点結果を反映しています。"
    });
    currentState = "manual_action_required";
  }
  if (currentState !== "manual_action_required") return false;
  await transitionV3State(db, {
    internalGameId,
    from: currentState,
    to: "scored",
    now
  });
  currentState = "scored";
  if (!deferPublication) {
    await transitionV3State(db, {
      internalGameId,
      from: currentState,
      to: "ranked",
      now
    });
    currentState = "ranked";
  }
  if (!deferPublication && publicationStatus === "published") {
    await transitionV3State(db, {
      internalGameId,
      from: currentState,
      to: "published",
      now
    });
  }
  return true;
}

async function handleAdminLineupRevision(request, env, cors, metadata, user) {
  try {
    const input = await readJson(request);
    const reason = validateManualRescoreInput(input, metadata);
    const expiresAt = assertManualRescoreWindow(metadata);
    const actual = sanitizeActualLineupForScoring(input?.actualLineup);
    if (!actual.ok) return jsonResponse({ ok: false, error: actual.error }, 400, cors);
    const revision = await createManualLineupRevision(env.AUTH_DB, metadata, actual.lineup, user.id, reason);
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_lineup_revision",
      status: "success",
      gameId: metadata.gameId,
      occurredAt: new Date(),
      message: "管理者が正式スタメンを修正しました。",
      metadata: { version: revision.version, source: revision.source },
      source: "admin"
    });
    return jsonResponse({ ok: true, gameId: metadata.gameId, rescoreExpiresAt: expiresAt.toISOString(), revision: serializeLineupRevision(revision) }, 201, cors);
  } catch (error) {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_lineup_revision",
      status: "error",
      gameId: metadata.gameId,
      occurredAt: new Date(),
      message: "管理者による正式スタメン修正に失敗しました。",
      errorCode: String(error?.code || "RESCORE_LINEUP_REVISION_FAILED"),
      source: "admin"
    });
    return createManualRescoreErrorResponse(cors, error);
  }
}

async function handleAdminLineupRestore(request, env, cors, metadata, user) {
  try {
    const input = await readJson(request);
    const reason = validateManualRescoreInput(input, metadata);
    const expiresAt = assertManualRescoreWindow(metadata);
    const source = await getLineupRevision(env.AUTH_DB, metadata.gameId, input?.version);
    const actual = sanitizeActualLineupForScoring(parseStoredActualLineup(source?.actual_lineup_json));
    if (!source || !actual.ok) {
      throw createPregameError("RESCORE_RESTORE_VERSION_INVALID", "復元する正式スタメンversionが見つかりません。", { httpStatus: 404 });
    }
    const revision = await createManualLineupRevision(env.AUTH_DB, metadata, actual.lineup, user.id, reason, "restore");
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_lineup_restore",
      status: "success",
      gameId: metadata.gameId,
      occurredAt: new Date(),
      message: "管理者が正式スタメンを復元しました。",
      metadata: { version: revision.version, restoredVersion: Number(input?.version) },
      source: "admin"
    });
    return jsonResponse({ ok: true, gameId: metadata.gameId, rescoreExpiresAt: expiresAt.toISOString(), revision: serializeLineupRevision(revision) }, 201, cors);
  } catch (error) {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_lineup_restore",
      status: "error",
      gameId: metadata.gameId,
      occurredAt: new Date(),
      message: "管理者による正式スタメン復元に失敗しました。",
      errorCode: String(error?.code || "RESCORE_LINEUP_RESTORE_FAILED"),
      source: "admin"
    });
    return createManualRescoreErrorResponse(cors, error);
  }
}

async function buildManualRescorePreview(db, gameId, actualLineup, isTestPrediction = 0) {
  const scoring = await prepareGamePredictionScoring(db, gameId, actualLineup, isTestPrediction);
  if (scoring.failed > 0) {
    throw createPregameError("RESCORE_PREDICTION_INVALID", "保存済み予想に検証エラーがあるため再採点できません。", { httpStatus: 409 });
  }
  const previous = await db.prepare(
    "SELECT id, score, max_score FROM predictions WHERE game_id = ?1 AND is_test_prediction = ?2"
  ).bind(gameId, isTestPrediction ? 1 : 0).all();
  const previousById = new Map((previous.results || []).map((row) => [row.id, row]));
  const differences = scoring.outcomes.filter((outcome) => Number(previousById.get(outcome.id)?.score) !== outcome.score.total);
  const beforePerfectCount = (previous.results || []).filter((row) => Number(row.score) === Number(row.max_score) && Number(row.max_score) > 0).length;
  return {
    processed: scoring.processed,
    scored: scoring.scored,
    scoreChangedCount: differences.length,
    scoreIncreasedCount: differences.filter((outcome) => outcome.score.total > Number(previousById.get(outcome.id)?.score || 0)).length,
    scoreDecreasedCount: differences.filter((outcome) => outcome.score.total < Number(previousById.get(outcome.id)?.score || 0)).length,
    perfectCountBefore: beforePerfectCount,
    perfectCountAfter: scoring.perfectCount,
    perfectCountDelta: scoring.perfectCount - beforePerfectCount,
    rankingAffectedUserCount: differences.length,
    scoreDistribution: scoring.scoreDistribution,
    examples: differences.slice(0, 5).map((outcome) => ({ oldScore: Number(previousById.get(outcome.id)?.score || 0), newScore: outcome.score.total }))
  };
}

async function handleAdminRescorePreview(request, env, cors, metadata, user) {
  try {
    const input = await readJson(request);
    const reason = validateManualRescoreInput(input, metadata);
    const expiresAt = assertManualRescoreWindow(metadata);
    const current = await ensureCurrentLineupRevision(env.AUTH_DB, metadata);
    const version = Number(input?.lineupVersion);
    if (!Number.isInteger(version) || version !== Number(current.version)) {
      throw createPregameError("RESCORE_VERSION_CHANGED", "正式スタメンversionが変わりました。再プレビューしてください。", { httpStatus: 409 });
    }
    const lineup = sanitizeActualLineupForScoring(parseStoredActualLineup(current.actual_lineup_json));
    if (!lineup.ok) throw createPregameError("RESCORE_LINEUP_REQUIRED", lineup.error, { httpStatus: 409 });
    const summary = await buildManualRescorePreview(env.AUTH_DB, metadata.gameId, lineup.lineup);
    const now = new Date();
    const previewId = randomToken(20);
    const previewExpiresAt = new Date(Math.min(expiresAt.getTime(), now.getTime() + MANUAL_RESCORE_PREVIEW_TTL_MS));
    const writeIdentity = await requireInternalGameIdForWrite(env.AUTH_DB, {
      table: "game_rescore_jobs",
      gameId: metadata.gameId,
      internalGameId: metadata.internalGameId
    });
    await env.AUTH_DB.batch([
      env.AUTH_DB.prepare(
        `INSERT INTO game_rescore_previews
         (id, game_id, lineup_version, created_by, reason, summary_json, expected_prediction_count, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(previewId, metadata.gameId, version, user.id, reason, JSON.stringify(summary), summary.processed, previewExpiresAt.toISOString(), now.toISOString()),
      env.AUTH_DB.prepare(
        `INSERT INTO game_rescore_jobs (id, game_id${writeIdentity.schemaReady ? ", internal_game_id" : ""}, lineup_version, status, error_code, created_at, updated_at)
         VALUES (?1, ?2${writeIdentity.schemaReady ? ", ?3" : ""}, ?${writeIdentity.schemaReady ? 4 : 3}, 'previewed', NULL, ?${writeIdentity.schemaReady ? 5 : 4}, ?${writeIdentity.schemaReady ? 5 : 4})`
      ).bind(...(writeIdentity.schemaReady
        ? [previewId, metadata.gameId, writeIdentity.internalGameId, version, now.toISOString()]
        : [previewId, metadata.gameId, version, now.toISOString()]))
    ]);
    await writeManualRescoreAudit(env.AUTH_DB, metadata, null, version, reason, user.id, now, summary, "previewed");
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_rescore_preview",
      status: "info",
      gameId: metadata.gameId,
      occurredAt: now,
      message: "管理者が再採点プレビューを作成しました。",
      metadata: { lineupVersion: version, processed: summary.processed, scoreChangedCount: summary.scoreChangedCount },
      source: "admin"
    });
    return jsonResponse({ ok: true, gameId: metadata.gameId, lineupVersion: version, previewId, previewExpiresAt: previewExpiresAt.toISOString(), rescoreExpiresAt: expiresAt.toISOString(), summary }, 200, cors);
  } catch (error) {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_rescore_preview",
      status: "error",
      gameId: metadata.gameId,
      occurredAt: new Date(),
      message: "管理者による再採点プレビューに失敗しました。",
      errorCode: String(error?.code || "RESCORE_PREVIEW_FAILED"),
      source: "admin"
    });
    return createManualRescoreErrorResponse(cors, error);
  }
}

async function writeManualRescoreAudit(db, metadata, previousVersion, lineupVersion, reason, userId, now, summary, status, errorCode = null) {
  await db.prepare(
    `INSERT INTO game_rescore_audits
       (id, game_id, game_date, previous_version, lineup_version, reason, executed_by, executed_at,
        prediction_count, changed_score_count, perfect_count_delta, status, error_code, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?8, ?8)`
  ).bind(
    randomToken(16), metadata.gameId, metadata.date, previousVersion, lineupVersion, reason, userId, now.toISOString(),
    Number(summary?.processed || 0), Number(summary?.scoreChangedCount || 0), Number(summary?.perfectCountDelta || 0), status, errorCode
  ).run();
}

async function handleAdminRescoreConfirm(request, env, cors, metadata, user, { deferPublication = false } = {}) {
  let previewId = "";
  try {
    const input = await readJson(request);
    const reason = validateManualRescoreInput(input, metadata);
    assertManualRescoreWindow(metadata);
    previewId = String(input?.previewId || "");
    const preview = await env.AUTH_DB.prepare(
      `SELECT * FROM game_rescore_previews WHERE id = ?1 AND game_id = ?2 AND created_by = ?3 LIMIT 1`
    ).bind(previewId, metadata.gameId, user.id).first();
    if (!preview || Number(preview.lineup_version) !== Number(input?.lineupVersion) || preview.reason !== reason) {
      throw createPregameError("RESCORE_PREVIEW_INVALID", "再採点プレビューを確認してください。", { httpStatus: 409 });
    }
    if (new Date(preview.expires_at) < new Date()) {
      throw createPregameError("RESCORE_PREVIEW_EXPIRED", "再採点プレビューの有効期限が切れました。", { httpStatus: 409 });
    }
    const current = await ensureCurrentLineupRevision(env.AUTH_DB, metadata);
    if (Number(current.version) !== Number(preview.lineup_version)) {
      throw createPregameError("RESCORE_VERSION_CHANGED", "正式スタメンversionが変わりました。再プレビューしてください。", { httpStatus: 409 });
    }
    const now = new Date();
    const claimResult = await env.AUTH_DB.prepare(
      `UPDATE game_rescore_jobs SET status = 'running', error_code = NULL, updated_at = ?1
        WHERE id = ?2 AND game_id = ?3 AND status = 'previewed'`
    ).bind(now.toISOString(), previewId, metadata.gameId).run();
    if (Number(claimResult?.meta?.changes || 0) !== 1) {
      throw createPregameError("RESCORE_PREVIEW_INVALID", "再採点プレビューを確認してください。", { httpStatus: 409 });
    }
    const result = await applyManualRescore(env.AUTH_DB, metadata, current, preview, user.id, reason, now, 0, { deferPublication });
    await markManualRescoreCompleted(env.AUTH_DB, metadata.internalGameId || "", result.publicationStatus, now, { deferPublication });
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_rescore_confirmed",
      status: "success",
      gameId: metadata.gameId,
      occurredAt: now,
      message: "管理者が再採点を確定しました。",
      metadata: { lineupVersion: Number(current.version), processed: result.processed, perfectCount: result.perfectCount },
      source: "admin"
    });
    return jsonResponse({ ok: true, gameId: metadata.gameId, lineupVersion: Number(current.version), ...result }, 200, cors);
  } catch (error) {
    if (previewId) {
      try {
        await env.AUTH_DB.prepare(
          `UPDATE game_rescore_jobs SET status = 'failed', error_code = ?1, updated_at = ?2
            WHERE id = ?3 AND game_id = ?4 AND status = 'running'`
        ).bind(String(error?.code || "RESCORE_FAILED").slice(0, 80), new Date().toISOString(), previewId, metadata.gameId).run();
      } catch {
        // 元の再採点エラーを優先します。
      }
    }
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_rescore_confirmed",
      status: "error",
      gameId: metadata.gameId,
      occurredAt: new Date(),
      message: "管理者による再採点確定に失敗しました。",
      errorCode: String(error?.code || "RESCORE_FAILED"),
      source: "admin"
    });
    return createManualRescoreErrorResponse(cors, error);
  }
}

async function applyManualRescore(db, metadata, revision, preview, userId, reason, now, isTestPrediction = 0, { deferPublication = false } = {}) {
  const lineup = sanitizeActualLineupForScoring(parseStoredActualLineup(revision.actual_lineup_json));
  if (!lineup.ok) throw createPregameError("RESCORE_LINEUP_REQUIRED", lineup.error, { httpStatus: 409 });
  const gameLineup = await getGameLineup(db, metadata.gameId);
  if (!gameLineup || gameLineup.scoring_status === "processing") {
    throw createPregameError("RESCORE_LINEUP_REQUIRED", "この試合は現在再採点できません。", { httpStatus: 409 });
  }
  const lineupRevisionId = revision.revision_id || `${metadata.gameId}:${Number(revision.version || 1)}`;
  const scoringRevisionState = await beginGameScoringRevision(db, {
    gameId: metadata.gameId,
    internalGameId: metadata.internalGameId || "",
    lineupRevisionId,
    reason,
    now
  });
  if (scoringRevisionState.existingCompleted) {
    throw createPregameError("RESCORE_ALREADY_APPLIED", "このlineup revisionはすでに再採点済みです。", { httpStatus: 409 });
  }
  try {
    const scoringRevision = scoringRevisionState.number;
    const scoring = await prepareGamePredictionScoring(db, metadata.gameId, lineup.lineup, isTestPrediction);
    if (scoring.failed > 0 || scoring.processed !== Number(preview.expected_prediction_count)) {
      throw createPregameError("RESCORE_PREVIEW_INVALID", "予想データが変わりました。再プレビューしてください。", { httpStatus: 409 });
    }
    const previous = await db.prepare(
      "SELECT id, score, max_score FROM predictions WHERE game_id = ?1 AND is_test_prediction = ?2"
    ).bind(metadata.gameId, isTestPrediction ? 1 : 0).all();
    const previousById = new Map((previous.results || []).map((row) => [row.id, row]));
    const changedScoreCount = scoring.outcomes.filter((outcome) => Number(previousById.get(outcome.id)?.score) !== outcome.score.total).length;
    const beforePerfectCount = (previous.results || []).filter((row) => Number(row.score) === Number(row.max_score) && Number(row.max_score) > 0).length;
    const perfectCountDelta = scoring.perfectCount - beforePerfectCount;
    const nowIso = now.toISOString();
    const actualLineupJson = JSON.stringify(lineup.lineup);
    const published = gameLineup.publication_status === "published";
    const auditId = randomToken(16);
    const statements = scoring.outcomes.map((outcome) => db.prepare(
    `UPDATE predictions
        SET score = ?1, max_score = ?2, scored_at = ?3, status = 'scored', actual_lineup_json = ?4
      WHERE id = ?5 AND game_id = ?6`
  ).bind(outcome.score.total, SCORING_MAX_SCORE, nowIso, actualLineupJson, outcome.id, metadata.gameId));
  statements.push(db.prepare("DELETE FROM perfect_achievers WHERE game_id = ?1").bind(metadata.gameId));
  for (const outcome of scoring.outcomes.filter((outcome) => outcome.score.total === SCORING_MAX_SCORE)) {
    statements.push(db.prepare(
      `INSERT INTO perfect_achievers
         (id, user_id, game_id, score, max_score, achieved_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
    ).bind(randomToken(16), outcome.userId, metadata.gameId, outcome.score.total, SCORING_MAX_SCORE, nowIso));
  }
  const keepPublished = published && !deferPublication;
  statements.push(db.prepare(
    `UPDATE game_lineups
        SET actual_lineup_json = ?1, lineup_fingerprint = ?2, lineup_detected_at = ?3,
            scoring_status = 'scored', scoring_started_at = NULL, scored_at = ?3,
            last_error = NULL, processed_predictions = ?4, perfect_count = ?5,
            new_perfect_achievers = ?5, lineup_source = 'manual-revision',
            publication_status = CASE WHEN ?7 = 1 THEN 'published' ELSE 'pending' END,
            published_at = CASE WHEN ?7 = 1 THEN published_at ELSE NULL END,
            updated_at = ?3
      WHERE game_id = ?6 AND scoring_status <> 'processing'`
  ).bind(actualLineupJson, revision.lineup_fingerprint, nowIso, scoring.processed, scoring.perfectCount, metadata.gameId, keepPublished ? 1 : 0));
  statements.push(db.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
       publication_status, scored_private_at, published_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'scored', ?5, ?6, ?4, ?7, ?4, ?4)
     ON CONFLICT(game_id) DO UPDATE SET
       game_date = excluded.game_date,
       is_ranking_eligible = excluded.is_ranking_eligible,
       ranking_eligible_at = excluded.ranking_eligible_at,
       game_status = 'scored',
       is_test_game = excluded.is_test_game,
       publication_status = excluded.publication_status,
       scored_private_at = excluded.scored_private_at,
       published_at = CASE WHEN excluded.publication_status = 'published' THEN excluded.published_at ELSE NULL END,
       updated_at = excluded.updated_at`
  ).bind(metadata.gameId, metadata.date, isTestPrediction ? 0 : (keepPublished ? 1 : 0), isTestPrediction ? 1 : 0, keepPublished ? "published" : "scored_private", keepPublished ? (gameLineup.published_at || nowIso) : null, nowIso));
  statements.push(db.prepare(
    `INSERT INTO game_rescore_audits
       (id, game_id, game_date, previous_version, lineup_version, reason, executed_by, executed_at,
        prediction_count, changed_score_count, perfect_count_delta, status, error_code, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'completed', NULL, ?8, ?8)`
  ).bind(auditId, metadata.gameId, metadata.date, Number(revision.version) - 1, Number(revision.version), reason, userId, nowIso, scoring.processed, changedScoreCount, perfectCountDelta));
  statements.push(db.prepare(
    `UPDATE game_rescore_jobs SET status = 'completed', error_code = NULL, updated_at = ?1
      WHERE id = ?2 AND game_id = ?3 AND status = 'running'`
  ).bind(nowIso, preview.id, metadata.gameId));
  statements.push(db.prepare("DELETE FROM game_rescore_previews WHERE id = ?1").bind(preview.id));
  const results = await db.batch(statements);
  const lineupResultIndex = scoring.outcomes.length + 1 + scoring.perfectCount;
  if (Number(results[lineupResultIndex]?.meta?.changes || 0) !== 1) {
    throw new Error("manual rescore lineup update count mismatch");
  }
  await recordScoringRevisionMetadata(db, {
    gameId: metadata.gameId,
    internalGameId: metadata.internalGameId || "",
    lineupRevisionId,
    scoringRevision,
    scoredBy: userId,
    scoredAt: now,
    isTestPrediction
  });
  await completeGameScoringRevision(db, {
    internalGameId: metadata.internalGameId || "",
    scoringRevisionId: scoringRevisionState.id,
    now
  });
    return {
      processed: scoring.processed,
      scored: scoring.scored,
      changedScoreCount,
      perfectCount: scoring.perfectCount,
      perfectCountDelta,
      scoredAt: nowIso,
      lineupRevisionId,
      scoringRevision,
      scoringRevisionId: scoringRevisionState.id,
      publicationStatus: keepPublished ? "published" : "scored_private"
    };
  } catch (error) {
    await failGameScoringRevision(db, { scoringRevisionId: scoringRevisionState.id, error, now });
    throw error;
  }
}

async function handleAdminAutoScoringStatus(env, cors, gameId) {
  const record = await getGameLineup(env.AUTH_DB, gameId);
  const summary = await getPredictionScoringSummary(env.AUTH_DB, gameId);
  return jsonResponse({
    ok: true,
    gameId,
    autoScoring: serializeGameLineup(record),
    predictionCount: summary.predictionCount,
    scoredCount: summary.scoredCount
  }, 200, cors);
}

async function handleAdminAutoScoringRunNow(env, cors, gameId) {
  if (await isServiceUnavailableGame(env.AUTH_DB, gameId)) {
    return jsonResponse({ ok: false, code: "SERVICE_UNAVAILABLE_GAME", error: SERVICE_UNAVAILABLE_MESSAGE }, 409, cors);
  }
  const record = await getGameLineup(env.AUTH_DB, gameId);
  if (!record) {
    console.log(`[PREGAME_TOOL] action=scoring gameId=${gameId} status=failed code=SCORING_LINEUP_REQUIRED npbStatus=-`);
    return jsonResponse({
      ok: false,
      code: "SCORING_LINEUP_REQUIRED",
      error: PREGAME_TOOL_ERROR_MESSAGES.SCORING_LINEUP_REQUIRED,
      httpStatus: 409
    }, 409, cors);
  }

  const now = new Date();
  await markGameRankingPending(env.AUTH_DB, gameId, now, env);
  const claimed = await claimGameLineupForScoring(env.AUTH_DB, gameId, now, { force: true, resetAttempts: true });
  if (!claimed) {
    console.log(`[PREGAME_TOOL] action=scoring gameId=${gameId} status=failed code=SCORING_IN_PROGRESS npbStatus=-`);
    return jsonResponse({
      ok: false,
      code: "SCORING_IN_PROGRESS",
      error: PREGAME_TOOL_ERROR_MESSAGES.SCORING_IN_PROGRESS,
      httpStatus: 409
    }, 409, cors);
  }

  try {
    const result = await scoreClaimedGameLineup(env.AUTH_DB, claimed, now);
    await recordGameWorkflowOutcome(env.AUTH_DB, gameId, "score", "success", null, now);
    return jsonResponse({ ok: true, gameId, ...result, autoScoring: serializeGameLineup(await getGameLineup(env.AUTH_DB, gameId)) }, 200, cors);
  } catch (error) {
    await markGameLineupFailed(env.AUTH_DB, gameId, error, now);
    await recordGameWorkflowOutcome(env.AUTH_DB, gameId, "score", "failed", error, now);
    throw error;
  }
}

async function handleAdminAutoScoringRetry(env, cors, gameId) {
  if (await isServiceUnavailableGame(env.AUTH_DB, gameId)) {
    return jsonResponse({ ok: false, code: "SERVICE_UNAVAILABLE_GAME", error: SERVICE_UNAVAILABLE_MESSAGE }, 409, cors);
  }
  const record = await getGameLineup(env.AUTH_DB, gameId);
  if (!record) {
    return jsonResponse({ ok: false, error: "再試行する実スタメンがありません。" }, 404, cors);
  }
  if (record.scoring_status === "processing") {
    return jsonResponse({ ok: false, error: "この試合は現在採点処理中です。" }, 409, cors);
  }

  const now = new Date().toISOString();
  await markGameRankingPending(env.AUTH_DB, gameId, now, env);
  await env.AUTH_DB.prepare(
    `UPDATE game_lineups
        SET scoring_status = 'pending', scoring_due_at = ?1, scoring_started_at = NULL,
            scoring_attempts = 0, last_error = NULL, updated_at = ?1
      WHERE game_id = ?2`
  ).bind(now, gameId).run();
  return jsonResponse({ ok: true, gameId, autoScoring: serializeGameLineup(await getGameLineup(env.AUTH_DB, gameId)) }, 200, cors);
}

async function handleAdminAutoScoringCancel(env, cors, gameId) {
  const record = await getGameLineup(env.AUTH_DB, gameId);
  if (!record) {
    return jsonResponse({ ok: false, error: "取り消す自動採点はありません。" }, 404, cors);
  }
  if (record.scoring_status === "processing") {
    return jsonResponse({ ok: false, error: "処理中の採点は取り消せません。完了後に再採点してください。" }, 409, cors);
  }
  await markGameRankingIneligible(env.AUTH_DB, gameId, "cancelled", new Date(), env);

  const now = new Date().toISOString();
  await env.AUTH_DB.prepare(
    `UPDATE game_lineups
        SET scoring_status = 'cancelled', scoring_started_at = NULL, updated_at = ?1
      WHERE game_id = ?2`
  ).bind(now, gameId).run();
  return jsonResponse({ ok: true, gameId, autoScoring: serializeGameLineup(await getGameLineup(env.AUTH_DB, gameId)) }, 200, cors);
}

async function getPredictionScoringSummary(db, gameId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS prediction_count,
            SUM(CASE WHEN status = 'scored' THEN 1 ELSE 0 END) AS scored_count
       FROM predictions WHERE game_id = ?1 AND is_test_prediction = 0`
  ).bind(gameId).first();
  return {
    predictionCount: Number(row?.prediction_count || 0),
    scoredCount: Number(row?.scored_count || 0)
  };
}

function getAutoScoringDelaySeconds(env) {
  const raw = String(env?.AUTO_SCORING_DELAY_SECONDS ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return AUTO_SCORING_DEFAULT_DELAY_SECONDS;
  }
  return Math.min(Number(raw), AUTO_SCORING_MAX_DELAY_SECONDS);
}

function parseLineupDetectedAt(value) {
  if (typeof value !== "string" || value.length > 64) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Cron自動承認と管理者の本承認は、このサーバー側の同一処理で採点待ち状態を作ります。
async function approveActualLineupForAutoScoring(env, gameId, actualLineup, detectedAt, options = {}) {
  const writeIdentity = options.isTestGame
    ? { internalGameId: String(options.internalGameId || ""), schemaReady: false }
    : await requireInternalGameIdForWrite(env.AUTH_DB, { table: "game_lineups", gameId, internalGameId: options.internalGameId || "" });
  const effectiveOptions = { ...options, internalGameId: writeIdentity.internalGameId };
  const record = await saveActualLineupForAutoScoring(env.AUTH_DB, gameId, actualLineup, detectedAt, effectiveOptions);
  await markGameRankingPending(env.AUTH_DB, gameId, detectedAt, env, options.isTestGame ? 1 : 0, writeIdentity.internalGameId);
  return record;
}

async function saveActualLineupForAutoScoring(db, gameId, actualLineup, detectedAt, options = {}) {
  if (!options.allowTestGame && !options.allowAfterStart) assertOfficialLineupSaveAllowed(gameId, options.now || new Date());
  const actualLineupJson = JSON.stringify(actualLineup);
  if (new TextEncoder().encode(actualLineupJson).byteLength > PREDICTION_MAX_JSON_BYTES) {
    throw new Error("actual lineup payload exceeds the allowed size");
  }
  const fingerprint = await sha256Base64Url(actualLineupJson);
  const storage = await getInternalGameIdStorageAvailability(db, ["game_lineups"]);
  const writeIdentity = options.isTestGame
    ? { internalGameId: String(options.internalGameId || ""), schemaReady: storage.game_lineups }
    : await requireInternalGameIdForWrite(db, { table: "game_lineups", gameId, internalGameId: options.internalGameId || "" });
  const internalGameId = writeIdentity.internalGameId;
  const existing = await getGameLineup(db, { gameId, internalGameId });
  if (existing && options.preventOverwrite) {
    return existing;
  }
  if (existing && existing.lineup_fingerprint === fingerprint && !options.forceReschedule) {
    return existing;
  }

  const detectedAtIso = detectedAt.toISOString();
  const delaySeconds = Number.isInteger(options.delaySeconds) ? options.delaySeconds : AUTO_SCORING_DEFAULT_DELAY_SECONDS;
  const requestedDueAt = options.scoringDueAt instanceof Date ? options.scoringDueAt : null;
  const scoringDueAt = (requestedDueAt || new Date(detectedAt.getTime() + Math.max(0, delaySeconds) * 1000)).toISOString();
  const lineupSource = options.source === "npb-auto" ? "npb-auto" : "manual";
  const id = existing?.id || randomToken(16);
  await db.prepare(
    `INSERT INTO game_lineups
       (id, game_id${storage.game_lineups ? ", internal_game_id" : ""}, actual_lineup_json, lineup_fingerprint, schema_version,
        lineup_detected_at, scoring_due_at, scoring_started_at, scored_at,
        scoring_status, scoring_attempts, last_error, processed_predictions,
        perfect_count, new_perfect_achievers, lineup_source, publication_status, published_at, created_at, updated_at)
     VALUES (?1, ?2${storage.game_lineups ? ", ?3" : ""}, ?${storage.game_lineups ? 4 : 3}, ?${storage.game_lineups ? 5 : 4}, ?${storage.game_lineups ? 6 : 5}, ?${storage.game_lineups ? 7 : 6}, ?${storage.game_lineups ? 8 : 7}, NULL, NULL, 'pending', 0, NULL, NULL, NULL, NULL, ?${storage.game_lineups ? 9 : 8}, 'pending', NULL, ?${storage.game_lineups ? 7 : 6}, ?${storage.game_lineups ? 7 : 6})
     ON CONFLICT(game_id) DO UPDATE SET
       ${storage.game_lineups ? "internal_game_id = CASE WHEN excluded.internal_game_id IS NULL OR excluded.internal_game_id = '' THEN game_lineups.internal_game_id ELSE excluded.internal_game_id END," : ""}
       actual_lineup_json = excluded.actual_lineup_json,
       lineup_fingerprint = excluded.lineup_fingerprint,
       schema_version = excluded.schema_version,
       lineup_detected_at = excluded.lineup_detected_at,
       scoring_due_at = excluded.scoring_due_at,
       scoring_started_at = NULL,
       scored_at = NULL,
       scoring_status = 'pending',
       scoring_attempts = 0,
       last_error = NULL,
       processed_predictions = NULL,
       perfect_count = NULL,
       new_perfect_achievers = NULL,
       lineup_source = excluded.lineup_source,
       publication_status = 'pending',
       published_at = NULL,
       updated_at = excluded.updated_at`
  ).bind(id, gameId, ...(storage.game_lineups ? [internalGameId || null] : []), actualLineupJson, fingerprint, PREDICTION_SCHEMA_VERSION, detectedAtIso, scoringDueAt, lineupSource).run();
  return await getGameLineup(db, { gameId, internalGameId });
}

async function getGameLineup(db, gameReference) {
  const metadata = typeof gameReference === "object" && gameReference ? gameReference : null;
  const gameId = String(metadata?.gameId || gameReference || "");
  const internalGameId = String(metadata?.internalGameId || "");
  const storage = await getInternalGameIdStorageAvailability(db, ["game_lineups"]);
  if (internalGameId) {
    if (!storage.game_lineups) return null;
    return db.prepare(
      `SELECT id, game_id, internal_game_id, actual_lineup_json, lineup_fingerprint, lineup_detected_at,
              scoring_due_at, scoring_started_at, scored_at, scoring_status,
              scoring_attempts, last_error, processed_predictions, perfect_count,
              new_perfect_achievers, lineup_source, publication_status, published_at, updated_at
         FROM game_lineups
        WHERE internal_game_id = ?1
        LIMIT 1`
    ).bind(internalGameId).first();
  }
  return db.prepare(
    `SELECT id, game_id, actual_lineup_json, lineup_fingerprint, lineup_detected_at,
            scoring_due_at, scoring_started_at, scored_at, scoring_status,
            scoring_attempts, last_error, processed_predictions, perfect_count,
            new_perfect_achievers, lineup_source, publication_status, published_at, updated_at
       FROM game_lineups WHERE game_id = ?1 LIMIT 1`
  ).bind(gameId).first();
}

function serializeGameLineup(record) {
  if (!record) {
    return null;
  }
  return {
    gameId: record.game_id,
    lineupFingerprint: record.lineup_fingerprint,
    lineupDetectedAt: record.lineup_detected_at,
    lineupSource: record.lineup_source || "manual",
    scoringDueAt: record.scoring_due_at,
    scoringStartedAt: record.scoring_started_at,
    scoredAt: record.scored_at,
    status: record.scoring_status,
    attempts: Number(record.scoring_attempts || 0),
    maxAttempts: AUTO_SCORING_MAX_ATTEMPTS,
    lastError: record.last_error || "",
    processedPredictions: record.processed_predictions === null ? null : Number(record.processed_predictions),
    perfectCount: record.perfect_count === null ? null : Number(record.perfect_count),
    newPerfectAchievers: record.new_perfect_achievers === null ? null : Number(record.new_perfect_achievers),
    publicationStatus: record.publication_status || "pending",
    publishedAt: record.published_at || null
  };
}

async function claimGameLineupForScoring(db, gameId, now, { force = false, resetAttempts = false } = {}) {
  const nowIso = now.toISOString();
  if (force) {
    const prepareResult = await db.prepare(
      `UPDATE game_lineups
          SET scoring_status = 'pending', scoring_due_at = ?1, scoring_started_at = NULL,
              scoring_attempts = CASE WHEN ?2 THEN 0 ELSE scoring_attempts END,
              last_error = NULL, updated_at = ?1
        WHERE game_id = ?3 AND scoring_status <> 'processing'`
    ).bind(nowIso, resetAttempts ? 1 : 0, gameId).run();
    if (Number(prepareResult?.meta?.changes || 0) !== 1) {
      return null;
    }
  }

  const claimResult = await db.prepare(
    `UPDATE game_lineups
        SET scoring_status = 'processing', scoring_started_at = ?1,
            scoring_attempts = scoring_attempts + 1, last_error = NULL, updated_at = ?1
      WHERE game_id = ?2
        AND scoring_status IN ('pending', 'failed')
        AND scoring_due_at <= ?1
        AND scoring_attempts < ?3`
  ).bind(nowIso, gameId, AUTO_SCORING_MAX_ATTEMPTS).run();
  if (Number(claimResult?.meta?.changes || 0) !== 1) {
    return null;
  }
  return await getGameLineup(db, gameId);
}

async function getCurrentLineupRevisionForScoring(db, gameId) {
  try {
    const row = await db.prepare(
      "SELECT version, revision_id FROM game_lineup_revisions WHERE game_id = ?1 ORDER BY is_current DESC, version DESC LIMIT 1"
    ).bind(gameId).first();
    return row ? { version: Number(row.version || 1), revisionId: row.revision_id || `${gameId}:${Number(row.version || 1)}` } : null;
  } catch (error) {
    if (isPregameSchemaError(error)) return null;
    throw error;
  }
}

async function getNextScoringRevision(db, gameId) {
  try {
    const columns = await getTableColumnSet(db, "game_lineups");
    if (!columns.has("scoring_revision")) return 1;
    const row = await db.prepare("SELECT scoring_revision FROM game_lineups WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
    return Math.max(1, Number(row?.scoring_revision || 0) + 1);
  } catch (error) {
    if (isPregameSchemaError(error)) return 1;
    throw error;
  }
}

async function recordScoringRevisionMetadata(db, {
  gameId,
  internalGameId = "",
  lineupRevisionId = "",
  scoringRevision = 1,
  scoredBy = "system",
  scoredAt,
  isTestPrediction = 0
} = {}) {
  const timestamp = scoredAt instanceof Date ? scoredAt.toISOString() : String(scoredAt || new Date().toISOString());
  const predictionsColumns = await getTableColumnSet(db, "predictions");
  const lineupColumns = await getTableColumnSet(db, "game_lineups");
  const statements = [];
  if (predictionsColumns.has("scored_lineup_revision_id") && predictionsColumns.has("scoring_revision") && predictionsColumns.has("scored_by")) {
    statements.push(db.prepare(
      "UPDATE predictions SET scored_lineup_revision_id = ?1, scoring_revision = ?2, scored_by = ?3 WHERE game_id = ?4 AND status = 'scored' AND is_test_prediction = ?5"
    ).bind(lineupRevisionId || null, Number(scoringRevision), scoredBy, gameId, isTestPrediction ? 1 : 0));
  }
  const lineupSet = [];
  const lineupValues = [];
  const addLineupValue = (column, value) => {
    lineupSet.push(`${column} = ?${lineupValues.length + 1}`);
    lineupValues.push(value);
  };
  if (lineupColumns.has("scoring_lineup_revision_id")) addLineupValue("scoring_lineup_revision_id", lineupRevisionId || null);
  if (lineupColumns.has("scoring_revision")) addLineupValue("scoring_revision", Number(scoringRevision));
  if (lineupColumns.has("scored_by")) addLineupValue("scored_by", scoredBy);
  if (lineupSet.length) {
    const gameIdPlaceholder = `?${lineupValues.length + 1}`;
    lineupValues.push(gameId);
    statements.push(db.prepare(`UPDATE game_lineups SET ${lineupSet.join(", ")} WHERE game_id = ${gameIdPlaceholder}`).bind(...lineupValues));
  }
  if (statements.length) await db.batch(statements);
  try {
    const revisionColumns = await getTableColumnSet(db, "prediction_score_revisions");
    if (revisionColumns.has("prediction_id") && revisionColumns.has("scoring_revision")) {
      await db.prepare(
        `INSERT OR IGNORE INTO prediction_score_revisions
           (id, prediction_id, game_id, internal_game_id, is_test_prediction,
            scoring_revision, lineup_revision_id, score, max_score, actual_lineup_json,
            scored_at, scored_by, created_at)
         SELECT p.id || ':' || ?2, p.id, p.game_id, COALESCE(p.internal_game_id, ?1),
                p.is_test_prediction, ?2, ?3, p.score, p.max_score, p.actual_lineup_json,
                p.scored_at, ?4, COALESCE(p.scored_at, ?5)
           FROM predictions AS p
          WHERE p.game_id = ?6
            AND p.status = 'scored'
            AND p.is_test_prediction = ?7`
      ).bind(internalGameId || null, Number(scoringRevision), lineupRevisionId || null, scoredBy, timestamp, gameId, isTestPrediction ? 1 : 0).run();
    }
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  return { lineupRevisionId: lineupRevisionId || null, scoringRevision: Number(scoringRevision), scoredAt: timestamp };
}

async function markGameLineupFailed(db, gameId, error, now) {
  const message = toSafeAutoScoringError(error);
  await db.prepare(
    `UPDATE game_lineups
        SET scoring_status = 'failed', scoring_started_at = NULL, last_error = ?1, updated_at = ?2
      WHERE game_id = ?3 AND scoring_status = 'processing'`
  ).bind(message, now.toISOString(), gameId).run();
}

// 既存の管理用状態行へ採点・公開の成否を残します。再試行対象はgame_lineups側で管理します。
async function recordGameWorkflowOutcome(db, gameId, step, status, error, now) {
  const failed = status === "failed";
  const isLineupStep = step === "lineup" || step === "final_lineup";
  const code = failed
    ? (isLineupStep ? classifyLineupErrorCode(error) : String(error?.code || `${String(step || "workflow").toUpperCase()}_FAILED`).slice(0, 80))
    : null;
  const message = failed ? toSafeAutoScoringError(error).slice(0, 240) : null;
  try {
    await db.prepare(
      `UPDATE game_pregame_automation
          SET scoring_status = CASE
                WHEN ?1 = 'score' AND ?2 = 'success' THEN 'scored'
                WHEN ?1 = 'score' AND ?2 = 'failed' THEN 'blocked'
                ELSE scoring_status
              END,
              last_error_code = ?3,
              last_error_message = ?4,
              updated_at = ?5
        WHERE game_id = ?6`
    ).bind(step, status, code, message, now.toISOString(), gameId).run();
  } catch (recordError) {
    console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=${step} action=state_record status=failed code=${recordError?.code || "WORKFLOW_STATE_RECORD_FAILED"}`);
  }
}

function toIsoString(value) {
  if (typeof value === "string") return value;
  return value instanceof Date ? value.toISOString() : new Date().toISOString();
}

// テスト用として保存した試合は、正式なランキング分母へ登録しません。
async function markGameRankingPending(db, gameId, at, env, isTestGame = 0, internalGameId = "") {
  let metadata = parsePredictionGameId(gameId);
  if (!metadata && INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || ""))) {
    const game = await db.prepare(
      "SELECT game_date FROM games WHERE internal_game_id = ?1 LIMIT 1"
    ).bind(internalGameId).first();
    if (game?.game_date) metadata = { date: String(game.game_date) };
  }
  if (!metadata) return;
  const now = toIsoString(at);
  const storage = await getInternalGameIdStorageAvailability(db, ["ranking_games"]);
  if (internalGameId && !storage.ranking_games) {
    throw createV3Error("V3_RANKING_SCHEMA_UNAVAILABLE", "V3ランキングのcanonical schemaが準備されていません。", {
      httpStatus: 503,
      retryable: false
    });
  }
  if (storage.ranking_games && !isTestGame) {
    internalGameId = (await requireInternalGameIdForWrite(db, { table: "ranking_games", gameId, internalGameId })).internalGameId;
  }
  const hasInternalGameId = storage.ranking_games && INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || ""));
  if (hasInternalGameId) {
    const sql = isTestGame
      ? `INSERT INTO ranking_games
           (game_id, internal_game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
            publication_status, scored_private_at, published_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, NULL, 'pending', 1, 'pending', NULL, NULL, ?4, ?4)
         ON CONFLICT(game_id) DO UPDATE SET
           internal_game_id = excluded.internal_game_id, game_date = excluded.game_date,
           is_ranking_eligible = 0, ranking_eligible_at = NULL, game_status = 'pending', is_test_game = 1,
           publication_status = 'pending', scored_private_at = NULL, published_at = NULL, updated_at = excluded.updated_at`
      : `INSERT INTO ranking_games
           (game_id, internal_game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
            publication_status, scored_private_at, published_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, NULL, 'pending', 0, 'pending', NULL, NULL, ?4, ?4)
         ON CONFLICT(game_id) DO UPDATE SET
           internal_game_id = excluded.internal_game_id, game_date = excluded.game_date,
           is_ranking_eligible = 0, ranking_eligible_at = NULL, game_status = 'pending', is_test_game = 0,
           publication_status = 'pending', scored_private_at = NULL, published_at = NULL, updated_at = excluded.updated_at`;
    await db.prepare(sql).bind(gameId, internalGameId, metadata.date, now).run();
    return;
  }
  const productionSql = `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
        publication_status, scored_private_at, published_at, created_at, updated_at)
     VALUES (?1, ?2, 0, NULL, 'pending', ?3, 'pending', NULL, NULL, ?4, ?4)
     ON CONFLICT(game_id) DO UPDATE SET
       game_date = excluded.game_date, is_ranking_eligible = 0, ranking_eligible_at = NULL,
       game_status = 'pending', is_test_game = 0, publication_status = 'pending',
       scored_private_at = NULL, published_at = NULL, updated_at = excluded.updated_at`;
  const testSql = `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
        publication_status, scored_private_at, published_at, created_at, updated_at)
     VALUES (?1, ?2, 0, NULL, 'pending', 1, 'pending', NULL, NULL, ?3, ?3)
     ON CONFLICT(game_id) DO UPDATE SET
       game_date = excluded.game_date, is_ranking_eligible = 0, ranking_eligible_at = NULL,
       game_status = 'pending', is_test_game = 1, publication_status = 'pending',
       scored_private_at = NULL, published_at = NULL, updated_at = excluded.updated_at`;
  await db.prepare(isTestGame ? testSql : productionSql)
    .bind(gameId, metadata.date, now).run();
}

async function createGameRankingScoredPrivateStatement(db, gameId, scoredAt, isTestGame = 0, internalGameId = "") {
  let metadata = parsePredictionGameId(gameId);
  if (!metadata && INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || ""))) {
    const game = await db.prepare(
      "SELECT game_date FROM games WHERE internal_game_id = ?1 LIMIT 1"
    ).bind(internalGameId).first();
    if (game?.game_date) metadata = { date: String(game.game_date) };
  }
  if (!metadata) return null;
  if (!isTestGame) {
    const eligibility = await getRankingEligibilityState(db, gameId, internalGameId);
    if (eligibility && eligibility.rankingEligibilityStatus !== RANKING_ELIGIBILITY_STATUS.ELIGIBLE) return null;
  }
  const now = toIsoString(scoredAt);
  const storage = await getInternalGameIdStorageAvailability(db, ["ranking_games"]);
  if (internalGameId && !storage.ranking_games) {
    throw createV3Error("V3_RANKING_SCHEMA_UNAVAILABLE", "V3ランキングのcanonical schemaが準備されていません。", {
      httpStatus: 503,
      retryable: false
    });
  }
  if (storage.ranking_games && !isTestGame) {
    internalGameId = (await requireInternalGameIdForWrite(db, { table: "ranking_games", gameId, internalGameId })).internalGameId;
  }
  const hasInternalGameId = storage.ranking_games && INTERNAL_GAME_ID_PATTERN.test(String(internalGameId || ""));
  if (hasInternalGameId) {
    const sql = isTestGame
      ? `INSERT INTO ranking_games
           (game_id, internal_game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
            publication_status, scored_private_at, published_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, NULL, 'pending', 1, 'scored_private', ?4, NULL, ?4, ?4)
         ON CONFLICT(game_id) DO UPDATE SET
           internal_game_id = excluded.internal_game_id, game_date = excluded.game_date,
           is_ranking_eligible = 0, ranking_eligible_at = NULL, game_status = 'pending', is_test_game = 1,
           publication_status = 'scored_private', scored_private_at = excluded.scored_private_at,
           published_at = NULL, updated_at = excluded.updated_at`
      : `INSERT INTO ranking_games
           (game_id, internal_game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
            publication_status, scored_private_at, published_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4, 'scored', 0, 'scored_private', ?4, NULL, ?4, ?4)
         ON CONFLICT(game_id) DO UPDATE SET
           internal_game_id = excluded.internal_game_id, game_date = excluded.game_date,
           is_ranking_eligible = 1, ranking_eligible_at = excluded.ranking_eligible_at, game_status = 'scored',
           is_test_game = 0, publication_status = 'scored_private', scored_private_at = excluded.scored_private_at,
           published_at = NULL, updated_at = excluded.updated_at`;
    return db.prepare(sql).bind(gameId, internalGameId, metadata.date, now);
  }
  const productionSql = `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
        publication_status, scored_private_at, published_at, created_at, updated_at)
     VALUES (?1, ?2, 1, ?4, 'scored', ?3, 'scored_private', ?4, NULL, ?4, ?4)
     ON CONFLICT(game_id) DO UPDATE SET
       game_date = excluded.game_date, is_ranking_eligible = 1, ranking_eligible_at = excluded.ranking_eligible_at,
       game_status = 'scored', is_test_game = 0, publication_status = 'scored_private',
       scored_private_at = excluded.scored_private_at, published_at = NULL, updated_at = excluded.updated_at`;
  const testSql = `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
        publication_status, scored_private_at, published_at, created_at, updated_at)
     VALUES (?1, ?2, 0, NULL, 'pending', 1, 'scored_private', ?3, NULL, ?3, ?3)
     ON CONFLICT(game_id) DO UPDATE SET
       game_date = excluded.game_date, is_ranking_eligible = 0, ranking_eligible_at = NULL,
       game_status = 'pending', is_test_game = 1, publication_status = 'scored_private',
       scored_private_at = excluded.scored_private_at, published_at = NULL, updated_at = excluded.updated_at`;
  return db.prepare(isTestGame ? testSql : productionSql)
    .bind(gameId, metadata.date, now);
}

async function markGameRankingScoredPrivate(db, gameId, scoredAt, env, isTestGame = 0, internalGameId = "") {
  const statement = await createGameRankingScoredPrivateStatement(db, gameId, scoredAt, isTestGame, internalGameId);
  if (statement) await statement.run();
}

async function publishScoredGameResults(env, gameId, now, options = {}) {
  try {
    const result = await publishGameResults(env, gameId, now, options);
    if (result.published && options.source !== "v3") {
      await recordGameWorkflowOutcome(env.AUTH_DB, gameId, "publish", "success", null, now);
    }
    return result;
  } catch (error) {
    if (options.source !== "v3") await recordGameWorkflowOutcome(env.AUTH_DB, gameId, "publish", "failed", error, now);
    throw error;
  }
}

async function publishGameResults(env, gameId, now, { isTestGame = false, internalGameId = "", target = null } = {}) {
  const testGame = isTestGame ? await getAutoScoringTest(env.AUTH_DB, gameId) : null;
  if (!isTestGame && await isServiceUnavailableGame(env.AUTH_DB, gameId)) {
    return { published: false, status: SERVICE_UNAVAILABLE_GAME_STATUS, publishedAt: null };
  }
  const publicationTarget = !isTestGame
    ? (target || await resolvePublicationTarget(env.AUTH_DB, internalGameId, gameId))
    : null;
  if (!isTestGame) {
    const startAt = new Date(publicationTarget.startAt);
    if (Number.isNaN(startAt.getTime())) {
      throw createPregameError("PUBLICATION_TARGET_INVALID", "公開対象の開始時刻が不正です。", { retryable: false, targetResolution: publicationTarget.targetResolution });
    }
    const resultReleaseAt = new Date(startAt.getTime() + RESULT_RELEASE_MINUTES_AFTER_START * 60 * 1000);
    if (now < resultReleaseAt) return { published: false, status: "not_due", publishedAt: null };
  } else if (!testGame) {
    throw createPregameError("TEST_GAME_NOT_FOUND", "自動採点テストが見つかりません。");
  }
  const lineup = await getGameLineup(env.AUTH_DB, { gameId, internalGameId });
  if (!isTestGame && internalGameId) {
    const revisions = await getV3LineupRevisionRows(env.AUTH_DB, gameId, internalGameId);
    if (!revisions.some((row) => Number(row.is_final) === 1)) {
      throw createPregameError("PUBLICATION_PREREQUISITE_MISSING", "正式スタメン確定済みの公開対象がありません。", { retryable: false, targetResolution: publicationTarget.targetResolution });
    }
  }
  if (!lineup || lineup.scoring_status !== "scored") {
    return { published: false, status: "not_ready", publishedAt: null };
  }
  if (lineup.publication_status === "published") {
    return { published: false, status: "already_published", publishedAt: lineup.published_at || null };
  }

  const scoringCompletion = await getScoringCompletionState(env.AUTH_DB, { gameId, internalGameId });
  if (!scoringCompletion.complete) {
    throw createPregameError("SCORING_INCOMPLETE", "全予想の採点が完了していません。", { retryable: true });
  }

  const ranking = isTestGame ? null : await getRankingReflectionState(env.AUTH_DB, gameId);
  if (!isTestGame && !ranking.reflected) {
    throw createPregameError("PUBLICATION_PREREQUISITE_MISSING", "ランキング反映済みの公開対象がありません。", { retryable: false, targetResolution: publicationTarget.targetResolution });
  }
  if (isTestGame) {
    await markGameRankingScoredPrivate(env.AUTH_DB, gameId, lineup.scored_at || now.toISOString(), env, 1);
  }
  const perfectQuery = isTestGame
    ? `SELECT user_id, score, max_score FROM predictions WHERE game_id = ?1 AND is_test_prediction = 1 AND status = 'scored' AND score = max_score`
    : `SELECT user_id, score, max_score FROM predictions WHERE game_id = ?1 AND is_test_prediction = 0
        AND status = 'scored' AND score = max_score`;
  const perfectRows = await env.AUTH_DB.prepare(perfectQuery
  ).bind(gameId).all();
  const publishedAt = now.toISOString();
  const rankingSql = isTestGame
    ? `UPDATE ranking_games
        SET is_ranking_eligible = 0, ranking_eligible_at = NULL, game_status = 'scored',
            is_test_game = 1, publication_status = 'published', published_at = ?1, updated_at = ?1
      WHERE game_id = ?2 AND is_test_game = 1 AND publication_status = 'scored_private'`
    : `UPDATE ranking_games
        SET is_ranking_eligible = 1, ranking_eligible_at = ?1, game_status = 'scored',
            publication_status = 'published', published_at = ?1, updated_at = ?1
      WHERE game_id = ?2 AND publication_status = 'scored_private'`;
  const statements = [env.AUTH_DB.prepare(rankingSql
  ).bind(publishedAt, gameId)];
  for (const row of perfectRows.results || []) {
    statements.push(env.AUTH_DB.prepare(
      `INSERT OR IGNORE INTO perfect_achievers
         (id, user_id, game_id, score, max_score, achieved_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`
    ).bind(randomToken(16), row.user_id, gameId, Number(row.score), Number(row.max_score), publishedAt));
  }
  statements.push(env.AUTH_DB.prepare(
      `UPDATE game_lineups
        SET publication_status = 'published', published_at = ?1,
            new_perfect_achievers = ?2, updated_at = ?1
      WHERE game_id = ?3 AND (?4 = '' OR internal_game_id = ?4)
        AND scoring_status = 'scored' AND publication_status <> 'published'`
  ).bind(publishedAt, (perfectRows.results || []).length, gameId, isTestGame ? "" : String(internalGameId || "")));
  let results;
  try {
    results = await env.AUTH_DB.batch(statements);
  } catch (error) {
    throw createPregameError("PUBLICATION_RESULT_PERSIST_FAILED", "公開結果の保存に失敗しました。", {
      retryable: true,
      cause: error
    });
  }
  const rankResult = results[0];
  const lineupResult = results[results.length - 1];
  if (Number(rankResult?.meta?.changes || 0) === 0 && Number(lineupResult?.meta?.changes || 0) === 0) {
    return { published: false, status: "already_published", publishedAt };
  }
  return {
    published: true,
    status: "published",
    publishedAt,
    perfectCount: (perfectRows.results || []).length
  };
}

async function markGameRankingIneligible(db, gameId, status, at, env) {
  const metadata = parsePredictionGameId(gameId);
  if (!metadata) return;
  const now = toIsoString(at);
  await db.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
        publication_status, scored_private_at, published_at, created_at, updated_at)
     VALUES (?1, ?2, 0, NULL, ?3, 0, 'pending', NULL, NULL, ?4, ?4)
     ON CONFLICT(game_id) DO UPDATE SET
       game_date = excluded.game_date,
       is_ranking_eligible = 0,
       ranking_eligible_at = NULL,
       game_status = excluded.game_status,
       publication_status = 'pending',
       scored_private_at = NULL,
       published_at = NULL,
       updated_at = excluded.updated_at`
  ).bind(gameId, metadata.date, status, now).run();
  const reason = status === "postponed"
    ? "postponed"
    : status === "cancelled"
      ? "cancelled_before_start"
      : "data_invalid";
  const current = await getRankingGameState(db, gameId);
  if (current) {
    await setRankingEligibility(db, {
      gameId,
      internalGameId: current.internal_game_id || "",
      status: RANKING_ELIGIBILITY_STATUS.EXCLUDED,
      reason,
      updatedBy: "system",
      now: at instanceof Date ? at : new Date(at)
    });
  }
}

async function beginGameScoringRevision(db, {
  gameId, internalGameId = "", lineupRevisionId = "", reason = "initial_scoring", now = new Date()
} = {}) {
  const fallback = { id: `${gameId}:scoring:${await getNextScoringRevision(db, gameId)}`, number: await getNextScoringRevision(db, gameId), existingCompleted: false };
  if (!internalGameId || !lineupRevisionId) return fallback;
  try {
    const columns = await getTableColumnSet(db, "game_scoring_revisions");
    if (!columns.size) return fallback;
    const existing = await db.prepare(
      "SELECT id, revision_number, status FROM game_scoring_revisions WHERE internal_game_id = ?1 AND lineup_revision_id = ?2 LIMIT 1"
    ).bind(internalGameId, lineupRevisionId).first();
    if (existing) return { id: existing.id, number: Number(existing.revision_number), existingCompleted: existing.status === "completed" };
    const latest = await db.prepare(
      "SELECT COALESCE(MAX(revision_number), 0) AS revision FROM game_scoring_revisions WHERE internal_game_id = ?1"
    ).bind(internalGameId).first();
    const number = Number(latest?.revision || 0) + 1;
    const id = `${internalGameId}:scoring:${number}`;
    await db.prepare(
      `INSERT INTO game_scoring_revisions
         (id, internal_game_id, game_id, revision_number, lineup_revision_id, status,
          reason, created_by, created_at, is_active)
       VALUES (?1, ?2, ?3, ?4, ?5, 'in_progress', ?6, 'system', ?7, 0)`
    ).bind(id, internalGameId, gameId, number, lineupRevisionId, reason, now.toISOString()).run();
    return { id, number, existingCompleted: false };
  } catch (error) {
    if (isPregameSchemaError(error)) return fallback;
    throw error;
  }
}

export async function ensurePersistedScoringRevision(db, {
  gameId = "", internalGameId = "", lineupRevisionId = "", revisionNumber = null,
  reason = "initial_scoring", now = new Date()
} = {}) {
  if (!internalGameId) return null;
  const columns = await getTableColumnSet(db, "game_scoring_revisions");
  const requiredColumns = [
    "id", "internal_game_id", "game_id", "revision_number", "lineup_revision_id",
    "status", "reason", "created_by", "created_at", "completed_at", "is_active"
  ];
  if (!requiredColumns.every((column) => columns.has(column))) {
    throw createV3Error("V3_SCORING_SCHEMA_UNAVAILABLE", "V3採点revisionの保存先が準備されていません。", { httpStatus: 503, retryable: false });
  }
  const resolvedLineupRevisionId = String(lineupRevisionId || `${internalGameId}:1`);
  let existing = await db.prepare(
    "SELECT id, revision_number, status, lineup_revision_id FROM game_scoring_revisions WHERE internal_game_id = ?1 AND lineup_revision_id = ?2 LIMIT 1"
  ).bind(internalGameId, resolvedLineupRevisionId).first();
  if (!existing) {
    const latest = await db.prepare(
      "SELECT COALESCE(MAX(revision_number), 0) AS revision FROM game_scoring_revisions WHERE internal_game_id = ?1"
    ).bind(internalGameId).first();
    const number = Number.isInteger(Number(revisionNumber)) && Number(revisionNumber) > 0
      ? Number(revisionNumber)
      : Number(latest?.revision || 0) + 1;
    const id = `${internalGameId}:scoring:${number}`;
    await db.prepare(
      `INSERT OR IGNORE INTO game_scoring_revisions
         (id, internal_game_id, game_id, revision_number, lineup_revision_id, status,
          reason, created_by, created_at, completed_at, is_active)
       VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, 'system', ?7, ?7, 1)`
    ).bind(id, internalGameId, gameId || internalGameId, number, resolvedLineupRevisionId, reason, now.toISOString()).run();
    existing = await db.prepare(
      "SELECT id, revision_number, status, lineup_revision_id FROM game_scoring_revisions WHERE internal_game_id = ?1 AND lineup_revision_id = ?2 LIMIT 1"
    ).bind(internalGameId, resolvedLineupRevisionId).first();
  }
  if (!existing?.id) {
    throw createV3Error("V3_SCORING_REVISION_PERSIST_FAILED", "採点revisionを保存できませんでした。", { retryable: true });
  }
  await db.batch([
    db.prepare("UPDATE game_scoring_revisions SET is_active = 0 WHERE internal_game_id = ?1").bind(internalGameId),
    db.prepare(
      "UPDATE game_scoring_revisions SET status = 'completed', is_active = 1, completed_at = COALESCE(completed_at, ?1) WHERE id = ?2 AND internal_game_id = ?3"
    ).bind(now.toISOString(), existing.id, internalGameId)
  ]);
  return {
    id: existing.id,
    number: Number(existing.revision_number || revisionNumber || 1),
    lineupRevisionId: existing.lineup_revision_id || resolvedLineupRevisionId,
    existingCompleted: existing.status === "completed"
  };
}

async function completeGameScoringRevision(db, { internalGameId = "", scoringRevisionId = "", now = new Date() } = {}) {
  if (!internalGameId || !scoringRevisionId) return;
  try {
    await db.batch([
      db.prepare("UPDATE game_scoring_revisions SET is_active = 0 WHERE internal_game_id = ?1").bind(internalGameId),
      db.prepare("UPDATE game_scoring_revisions SET status = 'completed', is_active = 1, completed_at = ?1 WHERE id = ?2 AND internal_game_id = ?3").bind(now.toISOString(), scoringRevisionId, internalGameId)
    ]);
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
}

async function failGameScoringRevision(db, { scoringRevisionId = "", error, now = new Date() } = {}) {
  if (!scoringRevisionId) return;
  try {
    await db.prepare(
      "UPDATE game_scoring_revisions SET status = 'failed', is_active = 0, completed_at = NULL WHERE id = ?1"
    ).bind(scoringRevisionId).run();
  } catch (recordError) {
    if (!isPregameSchemaError(recordError)) throw recordError;
  }
  void error;
  void now;
}

function toSafeAutoScoringError(error) {
  const message = error instanceof Error ? error.message : "unknown error";
  return message.slice(0, 180);
}

function sanitizeActualLineupForScoring(value, options = {}) {
  return sanitizeScoringLineup(value, "実スタメン", options);
}

function sanitizeScoringLineup(value, label, { allowUnresolvedPlayer = false } = {}) {
  if (!Array.isArray(value) || value.length !== SCORING_LINEUP_SIZE) {
    return { ok: false, error: `${label}は9人分入力してください。` };
  }

  const lineup = value.map((item) => {
    const battingOrder = Number(item?.battingOrder ?? item?.order);
    const teamCode = typeof item?.teamCode === "string" ? item.teamCode.trim().toLowerCase() : "";
    const teamId = typeof item?.teamId === "string" ? item.teamId : "";
    const uniformNumber = item?.uniformNumber;
    const playerId = typeof item?.playerId === "string" && item.playerId.trim() ? item.playerId : null;
    const playerName = typeof item?.playerName === "string" ? item.playerName.trim().slice(0, 40) : "";
    const displayName = typeof item?.displayName === "string" ? item.displayName.trim().slice(0, 40) : "";
    const position = normalizeScoringPosition(item?.position);
    const resolvedDisplayName = displayName || playerName || (allowUnresolvedPlayer ? "不明" : "");
    return { battingOrder, teamCode, teamId, uniformNumber, playerId, playerName: playerName || resolvedDisplayName, displayName: resolvedDisplayName, position, resolutionStatus: item?.resolutionStatus || (playerId ? "resolved" : "unresolved"), rawPlayerName: item?.rawPlayerName || playerName || displayName || "不明" };
  });

  if (lineup.some((item) => !Number.isInteger(item.battingOrder) || item.battingOrder < 1 || item.battingOrder > SCORING_LINEUP_SIZE)) {
    return { ok: false, error: `${label}の打順は1番から9番までで入力してください。` };
  }
  if (new Set(lineup.map((item) => item.battingOrder)).size !== SCORING_LINEUP_SIZE) {
    return { ok: false, error: `${label}の打順が重複しています。` };
  }
  if (lineup.some((item) => !item.playerName || (!allowUnresolvedPlayer && !item.playerId))) {
    return { ok: false, error: `${label}の選手情報が不足しています。` };
  }
  if (lineup.some((item) => !item.position || !PREDICTION_POSITIONS.has(item.position))) {
    return { ok: false, error: `${label}の守備位置が不正です。` };
  }
  if (hasDuplicateNonDhPositions(lineup)) {
    return { ok: false, error: `${label}に同じ守備位置が複数あります。` };
  }

  for (const item of lineup) {
    if (allowUnresolvedPlayer && !item.playerId) continue;
    const expectedTeamId = TEAM_PLAYER_ID_PREFIXES[item.teamCode];
    if (!expectedTeamId || !PREDICTION_TEAM_IDS.has(item.teamId) || item.teamId !== expectedTeamId) {
      return { ok: false, error: `${label}の球団情報が不正です。` };
    }
    if (typeof item.uniformNumber !== "string" || !/^\d{1,3}$/.test(item.uniformNumber)) {
      return { ok: false, error: `${label}の背番号が不正です。` };
    }
    if (item.playerId !== createPlayerId(item.teamCode, item.uniformNumber)) {
      return { ok: false, error: `${label}の選手IDが不正です。` };
    }
  }
  const resolvedPlayerIds = lineup.map((item) => item.playerId).filter(Boolean);
  if (new Set(resolvedPlayerIds).size !== resolvedPlayerIds.length) {
    return { ok: false, error: `${label}に同じ選手が複数います。` };
  }

  return { ok: true, lineup: lineup.sort((left, right) => left.battingOrder - right.battingOrder) };
}

function normalizeScoringPosition(value) {
  const key = String(value || "").normalize("NFKC").replace(/\s+/g, "").toUpperCase();
  return POSITION_ALIASES[key] || "";
}

function hasDuplicateNonDhPositions(lineup) {
  const positions = lineup.map((item) => item.position).filter((position) => position && position !== "指");
  return new Set(positions).size !== positions.length;
}

function scorePredictionLineup(predictionLineup, actualLineup) {
  const actualByPlayerId = new Map(actualLineup.map((item) => [item.playerId, item]));
  let playerHits = 0;
  let orderHits = 0;
  let positionHits = 0;

  for (const prediction of predictionLineup) {
    const actual = actualByPlayerId.get(prediction.playerId);
    if (!actual) {
      continue;
    }
    playerHits += 1;
    if (actual.battingOrder === prediction.battingOrder) {
      orderHits += 1;
    }
    if (actual.position === prediction.position) {
      positionHits += 1;
    }
  }

  const playerScore = playerHits * SCORING_RULES.player.perHit + (playerHits === SCORING_LINEUP_SIZE ? SCORING_RULES.player.bonus : 0);
  const orderScore = orderHits * SCORING_RULES.order.perHit + (orderHits === SCORING_LINEUP_SIZE ? SCORING_RULES.order.bonus : 0);
  const positionScore = positionHits * SCORING_RULES.position.perHit + (positionHits === SCORING_LINEUP_SIZE ? SCORING_RULES.position.bonus : 0);
  return {
    total: Math.min(SCORING_MAX_SCORE, playerScore + orderScore + positionScore),
    counts: { player: playerHits, order: orderHits, position: positionHits }
  };
}

async function handleGetPerfectAchievers(request, env, cors) {
  const gameId = getValidGameId(new URL(request.url).searchParams.get("gameId"));
  if (!gameId) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdを指定してください。" }, 400, cors);
  }

  const session = await getSessionUser(request, env);
  if (!await isGameResultsPublished(env.AUTH_DB, gameId, new Date())) {
    return jsonResponse({
      ...createPerfectAchieverResponse(gameId, {
        totalCount: 0,
        currentUserRegistered: false,
        achievers: []
      }),
      published: false
    }, 200, cors);
  }
  const snapshot = await getPerfectAchieverSnapshot(env.AUTH_DB, gameId, session?.id || "");
  return jsonResponse({ ...createPerfectAchieverResponse(gameId, snapshot), published: true }, 200, cors);
}

async function handlePostPerfectAchiever(request, env, cors) {
  const session = await getSessionUser(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "満点達成者として登録するにはログインしてください。" }, 401, cors);
  }

  const input = await readJson(request);
  const gameId = getValidGameId(input?.gameId);
  const score = input?.score;
  const maxScore = input?.maxScore;

  if (!gameId) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdを指定してください。" }, 400, cors);
  }
  if (!await isGameResultsPublished(env.AUTH_DB, gameId, new Date())) {
    return jsonResponse({ ok: false, error: "満点達成者の公開開始時刻前です。" }, 409, cors);
  }
  if (!Number.isInteger(score) || !Number.isInteger(maxScore) || maxScore <= 0 || score !== maxScore) {
    return jsonResponse({ ok: false, error: "満点を達成した場合のみ登録できます。" }, 400, cors);
  }

  const now = new Date().toISOString();
  const id = randomToken(16);
  let insertResult;
  try {
    insertResult = await env.AUTH_DB.prepare(
    `INSERT INTO perfect_achievers
       (id, user_id, game_id, score, max_score, achieved_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
      `
    ).bind(id, session.id, gameId, score, maxScore, now).run();
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("unique")) {
      return jsonResponse({ ok: false, error: "この試合では既に満点達成者として登録されています。" }, 409, cors);
    }
    throw error;
  }

  if (Number(insertResult?.meta?.changes || 0) !== 1) {
    return jsonResponse({ ok: false, error: "満点達成者の登録に失敗しました。" }, 409, cors);

  }

  const snapshot = await getPerfectAchieverSnapshot(env.AUTH_DB, gameId, session.id);
  return jsonResponse({
    ...createPerfectAchieverResponse(gameId, snapshot),
    registered: true
  }, 201, cors);
}

async function getPerfectAchieverSnapshot(db, gameId, currentUserId) {
  const countRow = await db.prepare(
    "SELECT COUNT(*) AS count FROM perfect_achievers WHERE game_id = ?1"
  ).bind(gameId).first();
  const rows = await db.prepare(
    `SELECT perfect_achievers.user_id, users.username,
            perfect_achievers.achieved_at, perfect_achievers.created_at
       FROM perfect_achievers
       JOIN users ON users.id = perfect_achievers.user_id
      WHERE perfect_achievers.game_id = ?1
      ORDER BY perfect_achievers.created_at ASC, perfect_achievers.achieved_at ASC,
               perfect_achievers.id ASC
      LIMIT ?2`
  ).bind(gameId, PERFECT_ACHIEVERS_DEFAULT_DISPLAY_LIMIT).all();
  const currentUserRow = currentUserId
    ? await db.prepare(
      "SELECT 1 FROM perfect_achievers WHERE user_id = ?1 AND game_id = ?2 LIMIT 1"
    ).bind(currentUserId, gameId).first()
    : null;
  const totalCount = Number(countRow?.count || 0);

  return {
    totalCount,
    currentUserRegistered: Boolean(currentUserRow),
    achievers: (rows?.results || []).map((row, index) => ({
      rank: index + 1,
      username: row.username,
      achievedAt: row.achieved_at
    }))
  };
}

function createPerfectAchieverResponse(gameId, snapshot) {
  return {
    ok: true,
    gameId,
    totalCount: snapshot.totalCount,
    displayLimit: PERFECT_ACHIEVERS_DEFAULT_DISPLAY_LIMIT,
    currentUserRegistered: snapshot.currentUserRegistered,
    achievers: snapshot.achievers
  };
}

async function resolveV3PredictionReference(db, internalGameId) {
  const id = String(internalGameId || "").trim();
  if (!INTERNAL_GAME_ID_PATTERN.test(id)) {
    return { ok: false, code: "INTERNAL_GAME_ID_REQUIRED", diagnostics: createPredictionResolutionDiagnostics({ requestedGameId: id }) };
  }
  const diagnostics = createPredictionResolutionDiagnostics({ requestedGameId: id });
  const row = await db.prepare(
    `SELECT internal_game_id, game_date, start_time, home_team, away_team,
            npb_game_code, game_status
       FROM games
      WHERE internal_game_id = ?1
      LIMIT 1`
  ).bind(id).first();
  if (!row) {
    return {
      ok: false,
      code: "GAME_SCHEDULE_NOT_FOUND",
      diagnostics: { ...diagnostics, internalGameIdFound: true }
    };
  }
  const parsed = {
    gameId: id,
    date: String(row.game_date || ""),
    homeCode: predictionTeamCodeFromStoredName(row.home_team),
    awayCode: predictionTeamCodeFromStoredName(row.away_team),
    gameCode: normalizeNpbGameCode(row.npb_game_code)
  };
  const metadata = createResolvedPredictionGameMetadata({
    parsed,
    row: { ...row, game_id: id, start_at: row.start_time, game_code: row.npb_game_code },
    internalGameId: id,
    homeCode: parsed.homeCode,
    awayCode: parsed.awayCode,
    resolvedBy: "games.internal_game_id"
  });
  if (!metadata) {
    const missingFields = [
      ["gameDate", row.game_date],
      ["startAt", row.start_time],
      ["homeTeam", parsed.homeCode],
      ["awayTeam", parsed.awayCode]
    ].filter(([, value]) => !String(value || "").trim()).map(([name]) => name);
    return {
      ok: false,
      code: "GAME_ID_RESOLUTION_FAILED",
      diagnostics: {
        ...diagnostics,
        internalGameIdFound: true,
        gameRowFound: true,
        startAtFound: Boolean(row.start_time),
        resolvedBy: "games.internal_game_id",
        missingFields
      }
    };
  }
  return {
    ok: true,
    metadata,
    diagnostics: {
      ...diagnostics,
      internalGameIdFound: true,
      gameRowFound: true,
      startAtFound: Boolean(row.start_time),
      resolvedBy: "games.internal_game_id",
      sourceGameKey: ""
    }
  };
}

async function handleGetCurrentPrediction(request, env, cors) {
  // Retired legacy reader: resolveApiGameReference(env.AUTH_DB, requestGameId)
  const session = await getSessionUser(request, env);
  if (!session) {
    return jsonResponse({ ok: false, code: "AUTH_REQUIRED", error: "予想を確認するにはログインしてください。" }, 401, cors);
  }

  const reference = await resolveV3PredictionReference(env.AUTH_DB, new URL(request.url).searchParams.get("internalGameId"));
  if (!reference.ok) return jsonResponse({ ok: false, code: reference.code, error: "対象試合のinternalGameIdが不正です。", resolution: reference.diagnostics || null }, 400, cors);
  const metadata = reference.metadata;

  const testGame = await isTestRankingGame(env.AUTH_DB, metadata.gameId);
  const published = testGame ? false : await isGameResultsPublished(env.AUTH_DB, metadata.gameId, new Date());
  const row = testGame ? null : await getPredictionRow(env.AUTH_DB, session.id, metadata);
  if (!row) {
    return jsonResponse({
      ok: true,
      gameId: metadata.gameId,
      internalGameId: metadata.internalGameId || "",
      legacyGameId: metadata.legacyGameId || metadata.gameId,
      prediction: null,
      status: null,
      submittedAt: null,
      updatedAt: null,
      locked: false,
      score: null,
      maxScore: null,
      scoredAt: null,
      actualLineup: null,
      resultsPublished: published
    }, 200, cors);
  }

  const prediction = parseStoredPrediction(row.prediction_json);
  if (!prediction) {
    return jsonResponse({ ok: false, error: "保存済み予想の読み込みに失敗しました。" }, 500, cors);
  }

  return jsonResponse({
    ok: true,
    gameId: metadata.gameId,
    internalGameId: metadata.internalGameId || "",
    legacyGameId: metadata.legacyGameId || metadata.gameId,
    prediction,
    status: published ? row.status : row.status === "scored" ? "submitted" : row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    locked: isPredictionLocked(row),
    score: published && row.score !== null ? Number(row.score) : null,
    maxScore: published && row.max_score !== null ? Number(row.max_score) : null,
    scoredAt: published ? (row.scored_at || null) : null,
    actualLineup: published && row.actual_lineup_json ? parseStoredActualLineup(row.actual_lineup_json) : null,
    resultsPublished: published
  }, 200, cors);
}

async function isGameResultsPublished(db, gameId, now) {
  const identity = getGameIdentityForPregame(gameId);
  let releaseAt = identity?.resultReleaseAt || null;
  try {
    const resolved = await resolvePredictionGameMetadataDetailed(db, gameId);
    const schedule = resolved?.metadata?.internalGameId
      ? await db.prepare("SELECT start_time FROM games WHERE internal_game_id = ?1 LIMIT 1").bind(resolved.metadata.internalGameId).first()
      : null;
    const startAt = new Date(schedule?.start_time || "");
    if (!Number.isNaN(startAt.getTime())) releaseAt = new Date(startAt.getTime() + RESULT_RELEASE_MINUTES_AFTER_START * 60 * 1000);
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
  }
  if (!releaseAt || now < releaseAt) return false;
  const row = await db.prepare(
    `SELECT is_ranking_eligible, publication_status, is_test_game
       FROM ranking_games WHERE game_id = ?1 LIMIT 1`
  ).bind(gameId).first();
  if (Number(row?.is_test_game || 0) === 1) return false;
  // 0010適用前の正式採点済み試合だけは、publication_statusが存在しない場合に限り過去データとして表示します。
  return row?.publication_status === "published"
    || (row?.publication_status === undefined && Number(row?.is_ranking_eligible || 0) === 1);
}

async function isTestRankingGame(db, gameId) {
  const row = await db.prepare("SELECT is_test_game FROM ranking_games WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
  return Number(row?.is_test_game || 0) === 1;
}

async function handlePutCurrentPrediction(request, env, cors) {
  const session = await getSessionUser(request, env);
  if (!session) {
    return jsonResponse({ ok: false, code: "AUTH_REQUIRED", error: "予想を保存するにはログインしてください。" }, 401, cors);
  }

  const input = await readJson(request);
  let reference;
  try {
    // Retired legacy form: resolveApiGameReference(env.AUTH_DB, input?.gameId).
    // V3 intentionally accepts only input.internalGameId now.
    reference = await resolveV3PredictionReference(env.AUTH_DB, input?.internalGameId);
  } catch (error) {
    const diagnostics = createPredictionResolutionDiagnostics({ requestedGameId: input?.internalGameId });
    await recordPredictionResolutionFailure(env.AUTH_DB, {
      code: isPregameSchemaError(error) ? "GAME_SCHEDULE_SCHEMA_UNAVAILABLE" : "GAME_SCHEDULE_READ_FAILED",
      diagnostics
    });
    return jsonResponse({
      ok: false,
      code: isPregameSchemaError(error) ? "GAME_SCHEDULE_SCHEMA_UNAVAILABLE" : "GAME_SCHEDULE_READ_FAILED",
      error: "試合日程を確認できないため、予想は保存できません。",
      resolution: diagnostics
    }, isPregameSchemaError(error) ? 503 : 500, cors);
  }
  if (!reference.ok) {
    await recordPredictionResolutionFailure(env.AUTH_DB, { code: reference.code, diagnostics: reference.diagnostics });
    if (reference.code === "INTERNAL_GAME_ID_REQUIRED") {
      return jsonResponse({ ok: false, code: "INVALID_GAME_ID", error: "対象試合のinternalGameIdが不正です。", resolution: reference.diagnostics || null }, 400, cors);
    }
    const status = reference.code === "GAME_SCHEDULE_NOT_FOUND" ? 503 : 400;
    return jsonResponse({ ok: false, code: reference.code, error: "対象試合の日程を確認できないため、予想は保存できません。", resolution: reference.diagnostics || null }, status, cors);
  }
  const metadata = reference.metadata;

  const deadlineResponse = createPredictionDeadlineRejection(metadata, cors);
  if (deadlineResponse) {
    const deadline = getResolvedPredictionDeadlineStatus(metadata, new Date());
    const deadlineCode = deadline.code === "PREDICTION_SCHEDULE_UNAVAILABLE"
      ? (metadata.resolution?.gameRowFound || metadata.resolution?.scheduleRowFound ? "GAME_ID_RESOLUTION_FAILED" : "GAME_SCHEDULE_NOT_FOUND")
      : deadline.code;
    await recordPredictionResolutionFailure(env.AUTH_DB, {
      code: deadlineCode,
      diagnostics: metadata.resolution,
      eventType: "prediction_save_validation",
      message: "予想保存前の検証に失敗しました。"
    });
    return deadlineResponse;
  }

  const predictionResult = sanitizePredictionPayload(input?.prediction);
  if (!predictionResult.ok) {
    return jsonResponse({ ok: false, error: predictionResult.error }, 400, cors);
  }

  const predictionJson = JSON.stringify(predictionResult.prediction);
  if (new TextEncoder().encode(predictionJson).byteLength > PREDICTION_MAX_JSON_BYTES) {
    return jsonResponse({ ok: false, error: "予想データが大きすぎます。" }, 413, cors);
  }

  const existing = await getPredictionRow(env.AUTH_DB, session.id, metadata);
  if (existing && isPredictionLocked(existing)) {
    return jsonResponse({ ok: false, error: "この試合の予想受付は終了しています。" }, 409, cors);
  }

  const now = new Date().toISOString();
  const id = existing?.id || randomToken(16);
  // An older prediction can already be linked to the same canonical game via
  // a legacy game_id. Keep that compatibility key instead of inserting a
  // second row for the same user and internal game.
  const storageGameId = metadata.internalGameId && existing?.game_id
    ? existing.game_id
    : metadata.gameId;
  // テスト予想は開発者専用エンドポイントだけが明示的に作成します。
  // 一般の予想保存でクライアント入力をテスト扱いにすることはありません。
  const isTestPrediction = 0;
  const predictionStorage = await getInternalGameIdStorageAvailability(env.AUTH_DB, ["predictions"]);
  if (!predictionStorage.predictions) {
    return jsonResponse({ ok: false, code: "V3_PREDICTIONS_SCHEMA_UNAVAILABLE", error: "V3予想保存先が準備されていません。" }, 503, cors);
  }
  let internalGameId = metadata.internalGameId || "";
  try {
    internalGameId = (await requireInternalGameIdForWrite(env.AUTH_DB, { table: "predictions", gameId: metadata.gameId, internalGameId })).internalGameId;
  } catch (error) {
    return jsonResponse({ ok: false, code: error?.code || "INTERNAL_GAME_ID_REQUIRED", error: "内部試合IDを解決できないため、予想を保存できません。" }, 409, cors);
  }
  const resolvedMetadata = { ...metadata, internalGameId };
  const result = await env.AUTH_DB.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id${predictionStorage.predictions ? ", internal_game_id" : ""}, prediction_json, schema_version,
        game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, locked_at, status,
        score, max_score, scored_at, actual_lineup_json, is_test_prediction)
     VALUES (?1, ?2, ?3${predictionStorage.predictions ? ", ?4" : ""}, ?${predictionStorage.predictions ? 5 : 4}, ?${predictionStorage.predictions ? 6 : 5}, ?${predictionStorage.predictions ? 7 : 6}, ?${predictionStorage.predictions ? 8 : 7}, ?${predictionStorage.predictions ? 9 : 8}, ?${predictionStorage.predictions ? 10 : 9}, ?${predictionStorage.predictions ? 11 : 10}, ?${predictionStorage.predictions ? 12 : 11}, ?${predictionStorage.predictions ? 12 : 11}, NULL, 'submitted', NULL, NULL, NULL, NULL, ?${predictionStorage.predictions ? 13 : 12})
     ON CONFLICT(user_id, game_id) DO UPDATE SET
       ${predictionStorage.predictions ? "internal_game_id = CASE WHEN excluded.internal_game_id IS NULL OR excluded.internal_game_id = '' THEN predictions.internal_game_id ELSE excluded.internal_game_id END," : ""}
       prediction_json = excluded.prediction_json,
       schema_version = excluded.schema_version,
       game_date = excluded.game_date,
       home_team = excluded.home_team,
       away_team = excluded.away_team,
       opponent_code = excluded.opponent_code,
       is_home = excluded.is_home,
       updated_at = excluded.updated_at,
       status = 'submitted',
       is_test_prediction = excluded.is_test_prediction
     WHERE predictions.locked_at IS NULL
       AND predictions.status NOT IN ('locked', 'scored')`
  ).bind(
    id,
    session.id,
    storageGameId,
    ...(predictionStorage.predictions ? [internalGameId || null] : []),
    predictionJson,
    PREDICTION_SCHEMA_VERSION,
    metadata.date,
    metadata.homeCode,
    metadata.awayCode,
    metadata.opponentCode,
    metadata.isHome ? 1 : 0,
    now,
    isTestPrediction
  ).run();

  if (Number(result?.meta?.changes || 0) !== 1) {
    const current = await getPredictionRow(env.AUTH_DB, session.id, resolvedMetadata);
    if (current && isPredictionLocked(current)) {
      return jsonResponse({ ok: false, error: "この試合の予想受付は終了しています。" }, 409, cors);
    }
    return jsonResponse({ ok: false, error: "予想の保存に失敗しました。" }, 409, cors);
  }

  const created = !existing;
  return jsonResponse({
    ok: true,
    gameId: metadata.gameId,
    internalGameId,
    legacyGameId: metadata.legacyGameId || metadata.gameId,
    created,
    updated: !created,
    status: "submitted",
    submittedAt: existing?.submitted_at || now,
    updatedAt: now
  }, 200, cors);
}

async function handleDeleteCurrentPrediction(request, env, cors) {
  // Retired legacy reader: resolveApiGameReference(env.AUTH_DB, requestGameId)
  const session = await getSessionUser(request, env);
  if (!session) {
    return jsonResponse({ ok: false, code: "AUTH_REQUIRED", error: "予想を削除するにはログインしてください。" }, 401, cors);
  }

  const reference = await resolveV3PredictionReference(env.AUTH_DB, new URL(request.url).searchParams.get("internalGameId"));
  if (!reference.ok) return jsonResponse({ ok: false, code: reference.code, error: "対象試合のinternalGameIdが不正です。", resolution: reference.diagnostics || null }, 400, cors);
  const metadata = reference.metadata;

  const deadlineResponse = createPredictionDeadlineRejection(metadata, cors);
  if (deadlineResponse) {
    return deadlineResponse;
  }

  const existing = await getPredictionRow(env.AUTH_DB, session.id, metadata);
  if (existing && isPredictionLocked(existing)) {
    return jsonResponse({ ok: false, error: "この試合の予想受付は終了しています。" }, 409, cors);
  }

  const predictionStorage = await getInternalGameIdStorageAvailability(env.AUTH_DB, ["predictions"]);
  if (!predictionStorage.predictions || !metadata.internalGameId) {
    return jsonResponse({ ok: false, code: "V3_PREDICTIONS_SCHEMA_UNAVAILABLE", error: "V3予想保存先が準備されていません。" }, 503, cors);
  }
  const deleted = await env.AUTH_DB.prepare(
    "DELETE FROM predictions WHERE user_id = ?1 AND internal_game_id = ?2"
  ).bind(session.id, metadata.internalGameId).run();
  return jsonResponse({ ok: true, gameId: metadata.gameId, internalGameId: metadata.internalGameId || "", deleted: Number(deleted?.meta?.changes || 0) > 0 }, 200, cors);
}

async function getPredictionRow(db, userId, gameReference) {
  const metadata = typeof gameReference === "object" && gameReference ? gameReference : null;
  const gameId = String(metadata?.gameId || gameReference || "");
  const internalGameId = String(metadata?.internalGameId || "");
  const storage = await getInternalGameIdStorageAvailability(db, ["predictions"]);
  if (internalGameId && storage.predictions) {
    return db.prepare(
      `SELECT id, user_id, game_id, internal_game_id, prediction_json, status,
            submitted_at, updated_at, locked_at, score, max_score, scored_at, actual_lineup_json
       FROM predictions
      WHERE user_id = ?1 AND internal_game_id = ?2
       LIMIT 1`
    ).bind(userId, internalGameId).first();
  }
  if (internalGameId) return null;
  return db.prepare(
    `SELECT id, user_id, game_id, prediction_json, status,
            submitted_at, updated_at, locked_at, score, max_score, scored_at, actual_lineup_json
       FROM predictions WHERE user_id = ?1 AND game_id = ?2 LIMIT 1`
  ).bind(userId, gameId).first();
}

function parseStoredPrediction(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && parsed.schemaVersion === PREDICTION_SCHEMA_VERSION && Array.isArray(parsed.lineup)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseStoredActualLineup(value) {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) return parsed;
    return parsed && Array.isArray(parsed.lineup) ? parsed.lineup : null;
  } catch {
    return null;
  }
}

function sanitizePredictionPayload(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.lineup)) {
    return { ok: false, error: "予想データが不正です。" };
  }
  if (value.lineup.length !== 9) {
    return { ok: false, error: "予想は9人分入力してください。" };
  }

  const lineup = value.lineup.map((item) => {
    const order = Number(item?.battingOrder ?? item?.order);
    const playerName = String(item?.playerName ?? item?.player ?? "").trim().slice(0, 40);
    const playerId = typeof item?.playerId === "string" ? item.playerId : "";
    const teamId = typeof item?.teamId === "string" ? item.teamId : "";
    const teamCode = typeof item?.teamCode === "string" ? item.teamCode : "";
    // 数値化・trim・桁合わせをせず、先頭ゼロを含む登録背番号をそのまま検証します。
    const uniformNumber = item?.uniformNumber;
    const position = String(item?.position || "").normalize("NFKC").trim();
    return { battingOrder: order, playerId, teamId, teamCode, uniformNumber, playerName, position };
  });

  if (lineup.some((item) => !Number.isInteger(item.battingOrder) || item.battingOrder < 1 || item.battingOrder > 9)) {
    return { ok: false, error: "打順は1番から9番までで入力してください。" };
  }
  if (new Set(lineup.map((item) => item.battingOrder)).size !== 9) {
    return { ok: false, error: "打順が重複しています。" };
  }
  if (lineup.some((item) => !item.playerName || !item.playerId)) {
    return { ok: false, error: "選手情報が不足しています。選手を選び直してください。" };
  }
  for (const item of lineup) {
    const expectedTeamId = TEAM_PLAYER_ID_PREFIXES[item.teamCode];
    if (!expectedTeamId || !PREDICTION_TEAM_IDS.has(item.teamId) || item.teamId !== expectedTeamId) {
      return { ok: false, error: "選手の球団情報が不正です。選手を選び直してください。" };
    }
    if (typeof item.uniformNumber !== "string" || !/^\d{1,3}$/.test(item.uniformNumber)) {
      return { ok: false, error: "選手の背番号が不正です。選手を選び直してください。" };
    }
    if (item.playerId !== createPlayerId(item.teamCode, item.uniformNumber)) {
      return { ok: false, error: "選手IDが不正です。選手を選び直してください。" };
    }
  }
  const playerIds = lineup.map((item) => item.playerId);
  if (new Set(playerIds).size !== 9) {
    return { ok: false, error: "同じ選手を複数登録できません。" };
  }
  if (lineup.some((item) => !PREDICTION_POSITIONS.has(item.position))) {
    return { ok: false, error: "守備位置が不正です。" };
  }

  return {
    ok: true,
    prediction: {
      schemaVersion: PREDICTION_SCHEMA_VERSION,
      lineup: lineup.sort((left, right) => left.battingOrder - right.battingOrder)
    }
  };
}

function createPlayerId(teamCode, uniformNumber) {
  const teamId = TEAM_PLAYER_ID_PREFIXES[teamCode];
  if (!teamId || typeof uniformNumber !== "string" || !/^\d{1,3}$/.test(uniformNumber)) {
    return "";
  }

  return `${teamId}-${uniformNumber}`;
}

export function parsePredictionGameId(value) {
  const gameId = String(value || "").trim();
  const compactMatch = /^(\d{4}-\d{2}-\d{2})-([a-z]{1,2})-([a-z]{1,2})-(\d+)$/i.exec(gameId);
  const teamSlugs = Object.keys(PREDICTION_TEAM_SLUG_CODES).join("|");
  const descriptiveMatch = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})-(${teamSlugs})-(${teamSlugs})-(\\d{3,4})$`, "i").exec(gameId);
  const match = compactMatch || descriptiveMatch;
  if (!match) {
    return null;
  }

  const date = match[1];
  const homeCode = (PREDICTION_TEAM_SLUG_CODES[match[2].toLowerCase()] || match[2]).toLowerCase();
  const awayCode = (PREDICTION_TEAM_SLUG_CODES[match[3].toLowerCase()] || match[3]).toLowerCase();
  const dateValue = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== date || !PREDICTION_TEAM_CODES.has(homeCode) || !PREDICTION_TEAM_CODES.has(awayCode)) {
    return null;
  }
  if (homeCode !== "f" && awayCode !== "f") {
    return null;
  }

  const isHome = homeCode === "f";
  return {
    gameId,
    date,
    homeCode,
    awayCode,
    opponentCode: isHome ? awayCode : homeCode,
    isHome,
    gameCode: compactMatch ? `${homeCode}-${awayCode}-${match[4]}` : "",
    format: descriptiveMatch ? "descriptive" : "compact"
  };
}

function predictionTeamCodeFromStoredName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (PREDICTION_TEAM_SLUG_CODES[name]) return PREDICTION_TEAM_SLUG_CODES[name];
  if (PREDICTION_TEAM_CODES.has(name)) return name;
  const normalizedScheduleCode = normalizeScheduleTeamCode(value);
  return PREDICTION_TEAM_SLUG_CODES[normalizedScheduleCode] || "";
}

function createPredictionResolutionDiagnostics({
  requestedGameId = "",
  sourceGameKey = "",
  internalGameIdFound = false,
  gameRowFound = false,
  scheduleRowFound = false,
  startAtFound = false,
  resolvedBy = "",
  missingFields = [],
  identifierConflicts = []
} = {}) {
  return {
    validationStage: "prediction_schedule_resolution",
    internalGameIdFound: Boolean(internalGameIdFound),
    gameRowFound: Boolean(gameRowFound),
    scheduleRowFound: Boolean(scheduleRowFound),
    legacyGameId: String(requestedGameId || ""),
    sourceGameKey: String(sourceGameKey || ""),
    startAtFound: Boolean(startAtFound),
    resolvedBy: String(resolvedBy || ""),
    missingFields: [...new Set((Array.isArray(missingFields) ? missingFields : []).filter(Boolean))],
    identifierConflicts: (Array.isArray(identifierConflicts) ? identifierConflicts : []).map((row) => ({
      identifierType: String(row?.identifier_type || ""),
      identifierValue: String(row?.identifier_value || ""),
      internalGameId: String(row?.internal_game_id || "")
    }))
  };
}

async function recordPredictionResolutionFailure(db, {
  code = "GAME_SCHEDULE_NOT_FOUND",
  diagnostics = null,
  eventType = "prediction_schedule_resolution",
  message = "予想保存時の日程解決に失敗しました。"
} = {}) {
  const safeDiagnostics = diagnostics && typeof diagnostics === "object" ? diagnostics : {};
  try {
    await recordWorkflowLog(db, {
      eventType,
      status: "error",
      gameId: safeDiagnostics.legacyGameId || "",
      message,
      errorCode: String(code || "GAME_SCHEDULE_NOT_FOUND"),
      metadata: {
        validationStage: safeDiagnostics.validationStage || "prediction_schedule_resolution",
        internalGameIdFound: Boolean(safeDiagnostics.internalGameIdFound),
        gameRowFound: Boolean(safeDiagnostics.gameRowFound),
        scheduleRowFound: Boolean(safeDiagnostics.scheduleRowFound),
        legacyGameId: safeDiagnostics.legacyGameId || "",
        sourceGameKey: safeDiagnostics.sourceGameKey || "",
        startAtFound: Boolean(safeDiagnostics.startAtFound),
        resolvedBy: safeDiagnostics.resolvedBy || "",
        missingFields: Array.isArray(safeDiagnostics.missingFields) ? safeDiagnostics.missingFields : [],
        identifierConflicts: Array.isArray(safeDiagnostics.identifierConflicts) ? safeDiagnostics.identifierConflicts : []
      },
      source: "api"
    });
  } catch (error) {
    console.warn(`[PREDICTION_RESOLUTION] status=log_failed code=${error?.code || "PREDICTION_RESOLUTION_LOG_FAILED"}`);
  }
}

function getPredictionSourceGameKey(parsed) {
  if (!parsed?.date || !parsed.homeCode || !parsed.awayCode) return "";
  const reverseSlugs = Object.entries(PREDICTION_TEAM_SLUG_CODES)
    .reduce((map, [slug, code]) => {
      if (!map.has(code)) map.set(code, slug);
      return map;
    }, new Map());
  const timeValue = /-(\d{3,4})$/.exec(String(parsed.gameId || ""))?.[1] || "";
  if (!timeValue) return "";
  const paddedTime = timeValue.padStart(4, "0");
  return `${parsed.date}:${reverseSlugs.get(parsed.homeCode) || parsed.homeCode}:${reverseSlugs.get(parsed.awayCode) || parsed.awayCode}:${paddedTime.slice(0, 2)}:${paddedTime.slice(2)}`;
}

function getPredictionResolutionMissingFields(row, parsed) {
  return [
    ["gameDate", row?.game_date || parsed?.date],
    ["startAt", row?.start_at || row?.start_time],
    ["homeTeam", row?.home_team || parsed?.homeCode],
    ["awayTeam", row?.away_team || parsed?.awayCode]
  ].filter(([, value]) => !String(value || "").trim()).map(([name]) => name);
}

async function getPredictionGameStartColumn(db) {
  try {
    const columns = await getTableColumnSet(db, "games");
    if (columns.has("start_at")) return "start_at";
    if (columns.has("start_time")) return "start_time";
  } catch (error) {
    console.warn(`[PREDICTION_RESOLUTION] stage=games_schema_read status=failed code=${error?.code || "GAME_SCHEDULE_SCHEMA_READ_FAILED"}`);
  }
  // The registry migration uses start_time. Keep that as the compatibility
  // default for older adapters that do not expose PRAGMA metadata.
  return "start_time";
}

async function resolvePredictionGameMetadataDetailed(db, value) {
  const requestedGameReference = String(value || "").trim();
  const registry = await getGameIdentityRegistryAvailability(db);
  const gamesStartColumn = await getPredictionGameStartColumn(db);
  const gamesStartSelect = `${gamesStartColumn} AS start_time`;
  const parsed = parsePredictionGameId(requestedGameReference);
  const diagnostics = createPredictionResolutionDiagnostics({
    requestedGameId: requestedGameReference,
    sourceGameKey: parsed ? getPredictionSourceGameKey(parsed) : ""
  });
  if (!registry.available && !parsed && !INTERNAL_GAME_ID_PATTERN.test(requestedGameReference)) {
    return { metadata: null, diagnostics };
  }

  // Registryが利用できる環境では、保存処理もCronと同じ永続日程を優先します。
  // games.start_timeを正とし、detected_game_scheduleは不足項目の補完に使います。
  if (registry.available) {
    let internalGameId = INTERNAL_GAME_ID_PATTERN.test(requestedGameReference) ? requestedGameReference : "";
    let identifierRows = [];
    if (!internalGameId) {
      const identifierValues = [...new Set([
        requestedGameReference,
        diagnostics.sourceGameKey,
        parsed?.gameCode || ""
      ].filter(Boolean))];
      if (identifierValues.length) {
        const placeholders = identifierValues.map((_, index) => `?${index + 1}`).join(", ");
        const result = await db.prepare(
          `SELECT internal_game_id, identifier_type, identifier_value
             FROM game_identifiers
            WHERE identifier_value IN (${placeholders})
            ORDER BY identifier_value ASC, internal_game_id ASC`
        ).bind(...identifierValues).all();
        identifierRows = result.results || [];
        const ids = [...new Set(identifierRows.map((row) => String(row.internal_game_id || "").trim()).filter(Boolean))];
        if (ids.length > 1) {
          return {
            metadata: null,
            diagnostics: createPredictionResolutionDiagnostics({
              ...diagnostics,
              identifierConflicts: identifierRows,
              missingFields: ["internalGameId"]
            })
          };
        }
        internalGameId = ids[0] || "";
      }
    }

    if (internalGameId) {
      diagnostics.internalGameIdFound = true;
      const gameRow = await db.prepare(
        `SELECT internal_game_id, game_date, ${gamesStartSelect}, home_team, away_team, game_status
           FROM games WHERE internal_game_id = ?1 LIMIT 1`
      ).bind(internalGameId).first();
      let scheduleRow = null;
      try {
        scheduleRow = await db.prepare(
          `SELECT game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, game_status, internal_game_id
             FROM detected_game_schedule
            WHERE internal_game_id = ?1
            ORDER BY updated_at DESC, game_id ASC LIMIT 1`
        ).bind(internalGameId).first();
      } catch (error) {
        if (!isPregameSchemaError(error)) throw error;
      }
      const row = {
        ...(scheduleRow || {}),
        ...(gameRow ? {
          game_date: gameRow.game_date || scheduleRow?.game_date,
          start_at: gameRow.start_time || scheduleRow?.start_at,
          home_team: gameRow.home_team || scheduleRow?.home_team,
          away_team: gameRow.away_team || scheduleRow?.away_team,
          game_status: gameRow.game_status || scheduleRow?.game_status
        } : {})
      };
      const resolvedParsed = parsePredictionGameId(scheduleRow?.game_id || requestedGameReference) || parsed;
      const homeCode = predictionTeamCodeFromStoredName(row.home_team) || resolvedParsed?.homeCode || "";
      const awayCode = predictionTeamCodeFromStoredName(row.away_team) || resolvedParsed?.awayCode || "";
      const directionMatches = !parsed || (homeCode === parsed.homeCode && awayCode === parsed.awayCode);
      if (gameRow && directionMatches && homeCode && awayCode) {
        const sourceGameKey = row.source_game_key || diagnostics.sourceGameKey;
        const resolved = createResolvedPredictionGameMetadata({
          parsed: resolvedParsed,
          row: { ...row, game_id: row.game_id || requestedGameReference },
          internalGameId,
          homeCode,
          awayCode,
          resolvedBy: gameRow.start_time ? "games.start_time" : "detected_game_schedule.start_at"
        });
        if (resolved) {
          return {
            metadata: resolved,
            diagnostics: createPredictionResolutionDiagnostics({
              ...diagnostics,
              sourceGameKey,
              gameRowFound: true,
              scheduleRowFound: Boolean(scheduleRow),
              startAtFound: Boolean(row.start_at),
              resolvedBy: gameRow.start_time ? "games.start_time" : "detected_game_schedule.start_at",
              missingFields: getPredictionResolutionMissingFields(row, resolvedParsed)
            })
          };
        }
      }
    }

    if (parsed) {
      const expectedStartAt = getPredictionGameExpectedStartAt(parsed);
      const games = await db.prepare(
        `SELECT internal_game_id, game_date, ${gamesStartSelect}, home_team, away_team, game_status
           FROM games WHERE game_date = ?1 ORDER BY ${gamesStartColumn} ASC, internal_game_id ASC LIMIT 50`
      ).bind(parsed.date).all();
      const matches = (games.results || []).filter((row) => {
        const homeCode = predictionTeamCodeFromStoredName(row.home_team);
        const awayCode = predictionTeamCodeFromStoredName(row.away_team);
        const startAt = new Date(row.start_time || "");
        return homeCode === parsed.homeCode && awayCode === parsed.awayCode
          && (!expectedStartAt || startAt.getTime() === expectedStartAt.getTime());
      });
      if (matches.length === 1) {
        const gameRow = matches[0];
        const resolved = createResolvedPredictionGameMetadata({
          parsed,
          row: { ...gameRow, game_id: requestedGameReference, start_at: gameRow.start_time },
          internalGameId: gameRow.internal_game_id,
          resolvedBy: "games.identity"
        });
        if (resolved) {
          return {
            metadata: resolved,
            diagnostics: createPredictionResolutionDiagnostics({
              ...diagnostics,
              internalGameIdFound: true,
              gameRowFound: true,
              startAtFound: Boolean(gameRow.start_time),
              resolvedBy: "games.identity",
              missingFields: getPredictionResolutionMissingFields(gameRow, parsed)
            })
          };
        }
      }
    }
  }

  if (!parsed) return { metadata: null, diagnostics };

  let row = null;
  let scheduleTableAvailable = true;
  const internalGameIdColumn = registry.scheduleColumnAvailable ? ", internal_game_id" : "";
  try {
    row = await db.prepare(
      `SELECT game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, game_status${internalGameIdColumn}
         FROM detected_game_schedule
        WHERE game_id = ?1 OR (?2 <> '' AND game_code = ?2 AND game_date = ?3)
        ORDER BY CASE WHEN game_id = ?1 THEN 0 ELSE 1 END, updated_at DESC
        LIMIT 1`
    ).bind(parsed.gameId, parsed.gameCode || "", parsed.date).first();
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
    scheduleTableAvailable = false;
  }

  if (!row && scheduleTableAvailable) {
    const expectedStartAt = getPredictionGameExpectedStartAt(parsed);
    if (expectedStartAt) {
      const candidates = await db.prepare(
        `SELECT game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, game_status${internalGameIdColumn}
           FROM detected_game_schedule
          WHERE game_date = ?1
          ORDER BY updated_at DESC`
      ).bind(parsed.date).all();
      row = selectPredictionGameIdentityRow(candidates.results || [], parsed, expectedStartAt);
    }
  }

  if (row) {
    const homeCode = predictionTeamCodeFromStoredName(row.home_team) || parsed.homeCode;
    const awayCode = predictionTeamCodeFromStoredName(row.away_team) || parsed.awayCode;
    if (!PREDICTION_TEAM_CODES.has(homeCode) || !PREDICTION_TEAM_CODES.has(awayCode) || (homeCode !== "f" && awayCode !== "f")) {
      return null;
    }
    const internalGameId = await resolveExistingInternalGameId(db, registry, row, parsed.gameId);
    const metadata = createResolvedPredictionGameMetadata({ parsed, row, internalGameId, homeCode, awayCode, resolvedBy: "detected_game_schedule" });
    return {
      metadata,
      diagnostics: createPredictionResolutionDiagnostics({
        ...diagnostics,
        internalGameIdFound: Boolean(internalGameId),
        scheduleRowFound: true,
        startAtFound: Boolean(row.start_at),
        resolvedBy: "detected_game_schedule",
        sourceGameKey: row.source_game_key || diagnostics.sourceGameKey,
        missingFields: getPredictionResolutionMissingFields(row, parsed)
      })
    };
  }

  // 日程同期前にprediction-targetが静的日程を返しても、既知の試合だけは保存対象として解決します。
  const scheduled = findKnownPredictionSchedule(parsed);
  if (!scheduled) return { metadata: null, diagnostics: createPredictionResolutionDiagnostics({ ...diagnostics, missingFields: ["internalGameId", "gameRow", "scheduleRow", "startAt"] }) };
  const startAt = parseJstScheduleStart(scheduled);
  if (!startAt || Number.isNaN(startAt.getTime())) return { metadata: null, diagnostics: createPredictionResolutionDiagnostics({ ...diagnostics, missingFields: ["startAt"] }) };
  return {
    metadata: {
      ...parsed,
      gameId: scheduled.gameId,
      startAt: startAt.toISOString(),
      gameCode: parsePredictionGameId(scheduled.gameId)?.gameCode || parsed.gameCode,
      game: scheduled
    },
    diagnostics: createPredictionResolutionDiagnostics({ ...diagnostics, startAtFound: true, resolvedBy: "static_schedule" })
  };
}

export async function resolvePredictionGameMetadata(db, value) {
  const result = await resolvePredictionGameMetadataDetailed(db, value);
  return result.metadata;
}

function createResolvedPredictionGameMetadata({ parsed, row, internalGameId = "", homeCode = "", awayCode = "", resolvedBy = "" }) {
  const source = parsed || { gameId: String(row?.game_id || "") };
  const resolvedHomeCode = homeCode || predictionTeamCodeFromStoredName(row?.home_team) || source.homeCode;
  const resolvedAwayCode = awayCode || predictionTeamCodeFromStoredName(row?.away_team) || source.awayCode;
  if (!PREDICTION_TEAM_CODES.has(resolvedHomeCode) || !PREDICTION_TEAM_CODES.has(resolvedAwayCode) || (resolvedHomeCode !== "f" && resolvedAwayCode !== "f")) {
    return null;
  }
  return {
    ...source,
    gameId: String(row.game_id),
    legacyGameId: String(row.game_id),
    date: row.game_date || parsed.date,
    homeCode: resolvedHomeCode,
    awayCode: resolvedAwayCode,
    opponentCode: resolvedHomeCode === "f" ? resolvedAwayCode : resolvedHomeCode,
    isHome: resolvedHomeCode === "f",
    startAt: row.start_at || "",
    gameCode: normalizeNpbGameCode(row.game_code) || parsePredictionGameId(row.game_id)?.gameCode || source.gameCode || "",
    internalGameId: String(internalGameId || row.internal_game_id || ""),
    resolvedBy,
    game: { ...row, status: row.game_status }
  };
}

export async function resolveApiGameReference(db, value) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: false, code: "INVALID_GAME_IDENTIFIER_FORMAT", metadata: null };
  const resolution = await resolvePredictionGameMetadataDetailed(db, raw);
  const metadata = resolution.metadata
    ? { ...resolution.metadata, resolution: resolution.diagnostics }
    : null;
  if (!metadata) {
    const diagnostics = resolution.diagnostics || {};
    const resolutionFailed = diagnostics.identifierConflicts?.length > 0
      || diagnostics.internalGameIdFound
      || diagnostics.gameRowFound
      || diagnostics.scheduleRowFound;
    return {
      ok: false,
      code: INTERNAL_GAME_ID_PATTERN.test(raw)
        ? "INTERNAL_GAME_ID_NOT_FOUND"
        : (resolutionFailed ? "GAME_ID_RESOLUTION_FAILED" : "GAME_SCHEDULE_NOT_FOUND"),
      metadata: null,
      diagnostics
    };
  }
  if (!metadata.internalGameId && INTERNAL_GAME_ID_PATTERN.test(raw)) {
    return { ok: false, code: "INTERNAL_GAME_ID_NOT_FOUND", metadata: null, diagnostics: resolution.diagnostics };
  }
  return {
    ok: true,
    code: "",
    metadata: {
      ...metadata,
      legacyGameId: metadata.legacyGameId || metadata.gameId,
      descriptiveGameId: metadata.format === "descriptive" ? metadata.gameId : "",
      npbGameCode: metadata.gameCode || ""
    },
    diagnostics: resolution.diagnostics
  };
}

async function resolveExistingInternalGameId(db, registry, row, requestedGameId) {
  if (row?.internal_game_id) return String(row.internal_game_id);
  if (!registry.available) return "";
  try {
    return await resolveInternalGameId(db, [
      ...createScheduleGameIdentifiers({
        gameId: row?.game_id,
        gameCode: row?.game_code,
        sourceGameKey: row?.source_game_key
      }),
      ...createScheduleGameIdentifiers({ gameId: requestedGameId })
    ]) || "";
  } catch (error) {
    console.warn(`[GAME_IDENTITY_REGISTRY] status=api_resolution_unavailable gameId=${String(row?.game_id || requestedGameId || "")} code=${error?.code || "INTERNAL_GAME_ID_RESOLUTION_FAILED"}`);
    return "";
  }
}

function getPredictionGameExpectedStartAt(parsed) {
  const scheduled = getScheduledGame(parsed.gameId);
  const scheduledStartAt = scheduled ? parseJstScheduleStart(scheduled) : null;
  if (scheduledStartAt && !Number.isNaN(scheduledStartAt.getTime())) {
    return scheduledStartAt;
  }
  if (parsed.format !== "descriptive") return null;

  const timeValue = /-(\d{3,4})$/.exec(parsed.gameId)?.[1] || "";
  const paddedTime = timeValue.padStart(4, "0");
  const hours = Number(paddedTime.slice(0, 2));
  const minutes = Number(paddedTime.slice(2));
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    return null;
  }
  const startAt = new Date(`${parsed.date}T${paddedTime.slice(0, 2)}:${paddedTime.slice(2)}:00+09:00`);
  return Number.isNaN(startAt.getTime()) ? null : startAt;
}

function selectPredictionGameIdentityRow(rows, parsed, expectedStartAt) {
  const expectedTime = expectedStartAt.getTime();
  const matches = (Array.isArray(rows) ? rows : []).filter((candidate) => {
    const homeCode = predictionTeamCodeFromStoredName(candidate?.home_team);
    const awayCode = predictionTeamCodeFromStoredName(candidate?.away_team);
    const startAt = new Date(candidate?.start_at || "");
    return homeCode === parsed.homeCode
      && awayCode === parsed.awayCode
      && !Number.isNaN(startAt.getTime())
      && startAt.getTime() === expectedTime;
  });
  return matches.reduce((selected, candidate) => (
    !selected || shouldPreferDetectedScheduleRow(candidate, selected) ? candidate : selected
  ), null);
}

function findKnownPredictionSchedule(parsed) {
  const direct = getScheduledGame(parsed.gameId);
  if (direct) return direct;

  const expectedStartAt = getPredictionGameExpectedStartAt(parsed);
  if (!expectedStartAt) return null;
  const expectedTime = expectedStartAt.getTime();
  return getScheduledGames().find((candidate) => {
    const homeCode = predictionTeamCodeFromStoredName(candidate?.homeTeam);
    const awayCode = predictionTeamCodeFromStoredName(candidate?.awayTeam);
    const startAt = parseJstScheduleStart(candidate);
    return String(candidate?.date || "") === parsed.date
      && homeCode === parsed.homeCode
      && awayCode === parsed.awayCode
      && startAt
      && !Number.isNaN(startAt.getTime())
      && startAt.getTime() === expectedTime;
  }) || null;
}

export function getResolvedPredictionDeadlineStatus(resolved, now = new Date()) {
  const gameId = resolved?.gameId || "";
  const game = resolved?.game;
  if (isScheduleGameUnavailable(game)) {
    return { ok: false, code: "GAME_NOT_AVAILABLE", message: "この試合は予想を受け付けていません。" };
  }
  const startAt = resolved?.startAt ? new Date(resolved.startAt) : null;
  if (startAt && !Number.isNaN(startAt.getTime())) {
    const currentTime = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(currentTime.getTime())) {
      return { ok: false, code: "PREDICTION_SCHEDULE_UNAVAILABLE", message: "現在時刻を確認できないため、予想は保存できません。" };
    }
    const deadlineAt = new Date(startAt.getTime() - PREDICTION_DEADLINE_MILLISECONDS);
    const isClosed = currentTime.getTime() >= deadlineAt.getTime();
    return {
      ok: true,
      game,
      gameId,
      startAt: startAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      isClosed,
      code: isClosed ? "PREDICTION_DEADLINE_PASSED" : "PREDICTION_DEADLINE_OPEN",
      message: isClosed ? "この試合の予想受付は終了しました。" : "予想を受け付けています。"
    };
  }
  return getPredictionDeadlineStatus(gameId, now);
}

function createPredictionDeadlineRejection(resolved, cors) {
  const deadline = getResolvedPredictionDeadlineStatus(resolved, new Date());
  if (deadline.ok && !deadline.isClosed) {
    return null;
  }

  const resolution = resolved?.resolution || {};
  const code = deadline.code === "PREDICTION_SCHEDULE_UNAVAILABLE"
    ? (resolution.gameRowFound || resolution.scheduleRowFound ? "GAME_ID_RESOLUTION_FAILED" : "GAME_SCHEDULE_NOT_FOUND")
    : deadline.code;
  const status = code === "GAME_SCHEDULE_NOT_FOUND" ? 503 : 409;
  return jsonResponse({
    ok: false,
    code,
    error: deadline.message,
    startAt: deadline.startAt || null,
    deadlineAt: deadline.deadlineAt || null,
    resolution: resolved?.resolution || null
  }, status, cors);
}

function isPredictionLocked(row) {
  return Boolean(row?.locked_at) || row?.status === "locked" || row?.status === "scored";
}

function getValidGameId(value) {
  const gameId = String(value || "").trim();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+(?:-[a-z0-9]+){1,5}$/i.test(gameId)) {
    return "";
  }

  const date = gameId.slice(0, 10);
  const parsedDate = new Date(`${date}T00:00:00Z`);
  return parsedDate.toISOString().slice(0, 10) === date ? gameId : "";
}

async function getSessionUser(request, env) {
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (!token) {
    return null;
  }

  const tokenHash = await sha256Base64Url(token);
  const now = new Date().toISOString();
  return env.AUTH_DB.prepare(
    `SELECT sessions.id AS session_id, users.id, users.username, users.status, users.role
       FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?1
        AND sessions.expires_at > ?2
        AND users.status = 'active'
      LIMIT 1`
  ).bind(tokenHash, now).first().then((row) => row ? { ...row, sessionId: row.session_id } : null);
}

async function requireAuthenticatedUser(request, env, cors) {
  const user = await getSessionUser(request, env);
  if (!user) {
    return {
      ok: false,
      response: jsonResponse({ ok: false, admin: false, error: "ログインが必要です。" }, 401, cors)
    };
  }

  return { ok: true, user };
}

async function requireAdminUser(request, env, cors) {
  const endpoint = new URL(request.url).pathname;
  const authenticated = await requireAuthenticatedUser(request, env, cors);
  if (!authenticated.ok) {
    console.warn(`[ADMIN_AUTH] endpoint=${endpoint} authenticated=false userId= resolvedRole= failureCode=AUTH_REQUIRED`);
    return authenticated;
  }

  const resolvedRole = String(authenticated.user.role || "").trim().toLowerCase();
  if (resolvedRole !== "admin") {
    console.warn(`[ADMIN_AUTH] endpoint=${endpoint} authenticated=true userId=${String(authenticated.user.id || "")} resolvedRole=${resolvedRole || "unknown"} failureCode=ADMIN_ROLE_REQUIRED`);
    return {
      ok: false,
      response: jsonResponse({ ok: false, admin: false, error: "管理者権限がありません。" }, 403, cors)
    };
  }

  console.info(`[ADMIN_AUTH] endpoint=${endpoint} authenticated=true userId=${String(authenticated.user.id || "")} resolvedRole=admin failureCode=`);
  return authenticated;
}

async function createSession(db, userId, env) {
  const token = randomToken(32);
  const tokenHash = await sha256Base64Url(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
  const sessionId = randomToken(16);

  await db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_used_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?4)`
  ).bind(sessionId, userId, tokenHash, now.toISOString(), expiresAt.toISOString()).run();

  return {
    cookie: createSessionCookie(token, expiresAt, getSessionSameSite(env))
  };
}

function validateCredentials(input) {
  if (!input || typeof input.username !== "string" || typeof input.password !== "string") {
    return { ok: false, error: "ユーザー名とパスワードを入力してください。" };
  }
  const username = input.username.trim();
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return { ok: false, error: `ユーザー名は${USERNAME_MIN_LENGTH}〜${USERNAME_MAX_LENGTH}文字で入力してください。` };
  }
  if (!/^[\p{L}\p{N}_-]+$/u.test(username)) {
    return { ok: false, error: "ユーザー名は英数字、日本語、_、-のみ使用できます。" };
  }
  if (input.password.length < PASSWORD_MIN_LENGTH || input.password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, error: `パスワードは${PASSWORD_MIN_LENGTH}〜${PASSWORD_MAX_LENGTH}文字で入力してください。` };
  }
  return { ok: true };
}

function normalizeUsername(username) {
  return String(username).normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function derivePasswordHash(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    PASSWORD_HASH_BITS
  );
  return new Uint8Array(bits);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function constantTimeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomToken(length) {
  return bytesToBase64Url(randomBytes(length));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function readCookie(header, name) {
  if (!header) {
    return "";
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function getSessionSameSite(env) {
  const configured = String(env?.SESSION_SAMESITE || "Lax");
  return ["Strict", "Lax", "None"].includes(configured) ? configured : "Lax";
}

function createSessionCookie(token, expiresAt, sameSite) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Expires=${expiresAt.toUTCString()}; HttpOnly; Secure; Path=/; SameSite=${sameSite}`;
}

function clearSessionCookie(env) {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; Path=/; SameSite=${getSessionSameSite(env)}`;
}

function createCorsHeaders(request, env) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin"
  });
  const origin = request.headers.get("Origin");
  if (origin && isAllowedOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function isAllowedOrigin(origin, env) {
  const configured = String(env.AUTH_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.includes(origin);
}

function withSetCookie(headers, cookie) {
  const result = new Headers(headers);
  result.append("Set-Cookie", cookie);
  return result;
}

function jsonResponse(payload, status, headers) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}

function noStoreJsonResponse(payload, status, headers) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return jsonResponse(payload, status, responseHeaders);
}
