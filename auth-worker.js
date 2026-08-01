import { getPredictionDeadlineStatus, PREDICTION_DEADLINE_MILLISECONDS } from "./prediction-deadline.js";
import {
  getDueFinalLineupAttemptAt,
  getFinalLineupRetryDeadline,
  getDueLineupAttemptAt,
  getJstDateString,
  getNoticePollingPlan,
  buildPregameTimeline,
  getPregameTimeline,
  getPregameTimelines,
  getRosterFetchDecision,
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
const SCORING_LINEUP_SIZE = 9;
const SCORING_MAX_SCORE = 100;
const AUTO_SCORING_DEFAULT_DELAY_SECONDS = 300;
const AUTO_SCORING_MAX_DELAY_SECONDS = 24 * 60 * 60;
const AUTO_SCORING_MAX_ATTEMPTS = 3;
const AUTO_SCORING_CRON_BATCH_SIZE = 10;
const AUTO_SCORING_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const MANUAL_RESCORE_RETENTION_DAYS = 7;
const MANUAL_RESCORE_PREVIEW_TTL_MS = 15 * 60 * 1000;
const AUTOMATION_HEALTH_STATE_KEY = "cron";
const AUTO_APPROVE_SETTING_KEY = "auto_approve_enabled";
const AUTOMATION_SCHEDULE_LOOKAHEAD_DAYS = 1;
const AUTOMATION_SCHEDULE_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const WORKFLOW_LOG_RETENTION_HOURS = 48;
const WORKFLOW_LOG_DEFAULT_LIMIT = 50;
const WORKFLOW_LOG_MAX_LIMIT = 200;
const WORKFLOW_LOG_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const WORKFLOW_LOG_CLEANUP_KEY = "workflow_logs_48h";
const NPB_SERVICE_BINDING_INTERNAL_ORIGIN = "https://npb-fetch.internal";
const NPB_FETCH_TIMEOUT_MS = 15_000;
const PROBABLE_STARTER_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const ROSTER_MINIMUM_PLAYER_COUNT = 20;
const ROSTER_AUTO_FETCH_RETRY_INTERVAL_MS = 30 * 60 * 1000;
const ROSTER_AUTO_FETCH_INTERVAL_MS = 6 * 60 * 60 * 1000;
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
  { id: "final_lineup", offsetMinutes: 1, retryMinutes: 10 },
  { id: "score", offsetMinutes: 2 },
  { id: "publish", offsetMinutes: 5 }
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
      if (path === "/api/admin/mode-capabilities" && request.method === "GET") {
        return await handleAdminModeCapabilities(request, env, cors);
      }
      if (path === "/api/admin/automation/health" && request.method === "GET") {
        return await handleAdminAutomationHealth(request, env, cors);
      }
      if (path === "/api/admin/game-progress-status" && request.method === "GET") {
        return await handleAdminGameProgressStatus(request, env, cors);
      }
      if (path === "/api/admin/workflow-logs" && request.method === "GET") {
        return await handleAdminWorkflowLogs(request, env, cors);
      }
      const probableStarterRefreshRoute = parseProbableStarterRefreshRoute(path);
      if (probableStarterRefreshRoute && request.method === "POST") {
        return await handleAdminProbableStarterRefresh(request, env, cors, probableStarterRefreshRoute.gameId);
      }
      if (path === "/api/admin/automation/settings" && request.method === "GET") {
        return await handleAdminAutomationSettingsGet(request, env, cors);
      }
      if (path === "/api/admin/automation/settings" && request.method === "PUT") {
        return await handleAdminAutomationSettingsPut(request, env, cors);
      }
      const adminScoringRoute = parseAdminScoringRoute(path);
      if (adminScoringRoute) {
        return await handleAdminScoringRoute(request, env, cors, adminScoringRoute);
      }
      const autoScoringTestRoute = parseAutoScoringTestRoute(path);
      if (autoScoringTestRoute) {
        return await handleAutoScoringTestRoute(request, env, cors, autoScoringTestRoute);
      }
      const adminTestRoute = parseAdminTestRoute(path);
      if (adminTestRoute) {
        return await handleAdminTestRoute(request, env, cors, adminTestRoute);
      }
      const adminTestGameRoute = parseAdminTestGameRoute(path);
      if (adminTestGameRoute) {
        return await handleAdminTestGameRoute(request, env, cors, adminTestGameRoute);
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
      console.error("認証API処理に失敗しました", error instanceof Error ? error.message : "unknown error");
      return jsonResponse({ ok: false, error: "認証処理に失敗しました。" }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.AUTH_DB) {
      console.error("auto scoring skipped: AUTH_DB binding is unavailable");
      return;
    }

    const scheduledAt = new Date(Number(event?.scheduledTime) || Date.now());
    ctx.waitUntil(runScheduledGameAutomation(env, scheduledAt));
  }
};

export async function runScheduledGameAutomation(env, now) {
  await cleanupExpiredManualRescorePreviews(env.AUTH_DB, now);
  let scheduleSync = { status: "failed", games: [], failedDates: [getJstDateString(now)] };
  try {
    scheduleSync = await syncTodayFightersSchedule(env, now);
  } catch (error) {
    console.error(`[GAME_DETECTION] date=${getJstDateString(now)} team=fighters status=failed code=${error?.code || "SCHEDULE_SYNC_FAILED"}`);
  }
  await recordScheduleSyncOutcome(env.AUTH_DB, scheduleSync, now);
  try {
    // 対象試合は保存値ではなく、最新日程と開始時刻から導出します。
    // そのため、Cronが再実行されても同じ試合を再切替する副作用はありません。
    scheduleSync.predictionTarget = await getServerPredictionTarget(env.AUTH_DB, now);
    await updatePredictionTargetState(env.AUTH_DB, scheduleSync.predictionTarget, now);
  } catch (error) {
    console.warn(`[GAME_WORKFLOW] step=target action=evaluated status=failed code=${error?.code || "PREDICTION_TARGET_FAILED"}`);
    await recordCronStepFailure(env.AUTH_DB, "prediction_target", now, error);
  }
  const workflowResult = await runGameWorkflows(env, now, scheduleSync.games);
  const summary = summarizeGameAutomationRun({
    date: getJstDateString(now),
    scheduleSync: scheduleSync.status,
    workflows: workflowResult.workflows,
    shared: workflowResult.shared
  });
  await recordAutomationHealth(env.AUTH_DB, { now, summary });
  await cleanupWorkflowLogs(env.AUTH_DB, now);
  logGameAutomationSummary(summary);
  logCancelledGameWorkflows(workflowResult.workflows, summary.scheduleSync);
  return { ...workflowResult, summary };
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

async function recordAutomationHealth(db, { now, summary, error = null }) {
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const failed = Boolean(error) || Number(summary?.failed || 0) > 0;
  const errorCode = failed ? String(error?.code || "GAME_AUTOMATION_FAILED").slice(0, 80) : null;
  try {
    await db.prepare(
      `INSERT INTO game_automation_health
         (state_key, cron_last_run_at, cron_last_success_at, cron_last_error_at, cron_last_error_code, processed_game_count, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?2)
       ON CONFLICT(state_key) DO UPDATE SET
         cron_last_run_at = excluded.cron_last_run_at,
         cron_last_success_at = CASE WHEN excluded.cron_last_success_at IS NULL THEN game_automation_health.cron_last_success_at ELSE excluded.cron_last_success_at END,
         cron_last_error_at = CASE WHEN excluded.cron_last_error_at IS NULL THEN game_automation_health.cron_last_error_at ELSE excluded.cron_last_error_at END,
         cron_last_error_code = CASE WHEN excluded.cron_last_error_code IS NULL THEN NULL ELSE excluded.cron_last_error_code END,
         processed_game_count = excluded.processed_game_count,
         updated_at = excluded.updated_at`
    ).bind(
      AUTOMATION_HEALTH_STATE_KEY,
      timestamp,
      failed ? null : timestamp,
      failed ? timestamp : null,
      errorCode,
      Number(summary?.games || 0)
    ).run();
  } catch (healthError) {
    console.warn(`[GAME_AUTOMATION] state=health action=record status=failed code=${healthError?.code || "AUTOMATION_HEALTH_RECORD_FAILED"}`);
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

async function runGameWorkflows(env, now, syncedGames = []) {
  const timelines = await getCronPregameTimelines(env.AUTH_DB, now, syncedGames);
  const pausedGameIds = await getPausedWorkflowGameIds(env.AUTH_DB);
  const activeTimelines = timelines.filter((timeline) => !pausedGameIds.has(timeline.gameId));
  const cancelledTimelines = getScheduledGames()
    .filter((game) => isScheduleGameUnavailable(game))
    .map((game) => ({ game, gameId: game.gameId, gameCode: game.gameCode || "" }));
  const shared = { notice: null, roster: null, lineup: null, probableStarter: null, scoring: null, publishing: null, errors: 0, paused: pausedGameIds.size };
  try { shared.notice = await runDueGameDayScheduleJobs(env, now, activeTimelines); }
  catch (error) { shared.errors += 1; await recordCronStepFailure(env.AUTH_DB, "game_day_schedule", now, error); console.error(`game-day schedule cron failed: code=${error?.code || "unknown"}`); }
  try { shared.roster = await runDueRosterCaptureJobs(env, now, activeTimelines); }
  catch (error) { shared.errors += 1; await recordCronStepFailure(env.AUTH_DB, "roster", now, error); console.error(`roster cron failed: code=${error?.code || "unknown"}`); }
  try { shared.probableStarter = await runDueProbableStarterJob(env, now); }
  catch (error) { shared.errors += 1; await recordCronStepFailure(env.AUTH_DB, "probable_starter", now, error); console.error(`probable starter cron failed: code=${error?.code || "unknown"}`); }
  try { shared.lineup = await runDuePregameAutomationJobs(env, now, activeTimelines); }
  catch (error) { shared.errors += 1; await recordCronStepFailure(env.AUTH_DB, "lineup", now, error); console.error(`pregame automation cron failed: code=${error?.code || "unknown"}`); }
  try { shared.scoring = await runDueAutoScoringJobs(env, now, pausedGameIds); }
  catch (error) { shared.errors += 1; await recordCronStepFailure(env.AUTH_DB, "scoring", now, error); console.error(`auto scoring cron failed: code=${error?.code || "unknown"}`); }
  try { shared.autoScoringTests = await runDueAutoScoringTestJobs(env, now); }
  catch (error) { shared.errors += 1; console.error(`auto scoring test cron failed: code=${error?.code || "unknown"}`); }
  try { shared.publishing = await runDueGameDayPublicationJobs(env, now, activeTimelines); }
  catch (error) { shared.errors += 1; await recordCronStepFailure(env.AUTH_DB, "publication", now, error); console.error(`game-day publication cron failed: code=${error?.code || "unknown"}`); }
  const workflows = [...timelines, ...cancelledTimelines].map((timeline) => runGameWorkflow(timeline, now, pausedGameIds.has(timeline.gameId)));
  return { shared, workflows };
}

// Cron実行はブラウザの状態に依存せず、毎回D1の日程をタイムラインへ復元します。
// 同一Workerインスタンスが再利用されても、前回の検出日程を誤って引き継ぎません。
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
  if (exact) return exact;
  return (Array.isArray(games) ? games : []).find((game) => {
    const teams = new Set([normalizeProbableStarterTeam(game?.homeTeam), normalizeProbableStarterTeam(game?.awayTeam)]);
    return (!expectedDate || String(game?.date || "") === expectedDate)
      && teams.has(expectedHome)
      && teams.has(expectedAway);
  }) || null;
}

function serializeProbableStarterRow(row) {
  if (!row) return null;
  return {
    gameId: String(row.game_id || ""),
    status: String(row.status || "error"),
    homePitcherName: row.home_pitcher_name || "",
    awayPitcherName: row.away_pitcher_name || "",
    fetchedAt: row.fetched_at || null,
    announcedAt: row.announced_at || null,
    nextCheckAt: row.next_check_at || null,
    sourceUrl: row.source_url || "",
    errorCode: row.error_code || "",
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
  await db.prepare(
    `INSERT INTO probable_starters
       (game_id, status, home_pitcher_name, away_pitcher_name, fetched_at, announced_at, next_check_at, source_url, error_code, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(game_id) DO UPDATE SET
       status = excluded.status,
       home_pitcher_name = excluded.home_pitcher_name,
       away_pitcher_name = excluded.away_pitcher_name,
       fetched_at = excluded.fetched_at,
       announced_at = excluded.announced_at,
       next_check_at = excluded.next_check_at,
       source_url = excluded.source_url,
       error_code = excluded.error_code,
       updated_at = excluded.updated_at`
  ).bind(
    gameId,
    status,
    homePitcherName || null,
    awayPitcherName || null,
    fetchedAt,
    announcedAt,
    nextCheckAt,
    sourceUrl || null,
    errorCode || null,
    updatedAt
  ).run();
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
  return row?.status === "announced"
    && Boolean(String(row?.home_pitcher_name || "").trim())
    && Boolean(String(row?.away_pitcher_name || "").trim());
}

async function runProbableStarterFetch(env, target, now, { source = "cron" } = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const gameId = String(target?.gameId || "");
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
  if (await isProbableStarterTestGame(env.AUTH_DB, gameId)) {
    return { status: "skipped", reason: "test_game", gameId };
  }

  const fetchedAt = current.toISOString();
  await recordWorkflowLog(env.AUTH_DB, {
    eventType: "probable_starter_fetch_started",
    status: "info",
    gameId,
    occurredAt: current,
    message: "予告先発の取得を開始しました。",
    metadata: { source },
    source
  });

  let previous = null;
  let terminalLogged = false;
  const recordTerminal = async (details) => {
    const result = await recordProbableStarterDecision(env.AUTH_DB, details);
    // null means the equivalent terminal log was deduplicated; it is still a recorded outcome.
    terminalLogged = result !== false;
    return result;
  };
  try {
    previous = await env.AUTH_DB.prepare("SELECT * FROM probable_starters WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
    const payload = await fetchNpbWorkerJson(env, { mode: "starter" });
    const matched = findProbableStarterGame(target, payload.games);
    const homePitcherName = String(matched?.homeStarter?.name || "").trim();
    const awayPitcherName = String(matched?.awayStarter?.name || "").trim();
    const announced = Boolean(homePitcherName && awayPitcherName);
    const normalizedFetchedAt = String(payload.fetchedAt || fetchedAt);
    const announcedAt = announced ? (previous?.announced_at || normalizedFetchedAt) : null;
    const nextCheckAt = announced ? null : new Date(current.getTime() + PROBABLE_STARTER_RETRY_INTERVAL_MS).toISOString();
    const status = announced ? "announced" : "unannounced";
    await saveProbableStarterRow(env.AUTH_DB, {
      gameId,
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
    await recordTerminal({
      eventType: announced ? "probable_starter_announced" : "probable_starter_unannounced",
      status: announced ? "success" : "warning",
      gameId,
      occurredAt: current,
      message: announced ? "予告先発を保存しました。" : "予告先発はまだ発表されていません。",
      errorCode: announced ? "" : "PROBABLE_STARTER_UNANNOUNCED",
      metadata: { source, matched: Boolean(matched), nextCheckAt },
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
        updated_at: fetchedAt
      })
    };
  } catch (error) {
    const errorCode = String(error?.code || "PROBABLE_STARTER_FETCH_FAILED").slice(0, 80);
    const nextCheckAt = new Date(current.getTime() + PROBABLE_STARTER_RETRY_INTERVAL_MS).toISOString();
    try {
      await saveProbableStarterRow(env.AUTH_DB, {
        gameId,
        status: "error",
        homePitcherName: previous?.home_pitcher_name || "",
        awayPitcherName: previous?.away_pitcher_name || "",
        fetchedAt,
        announcedAt: previous?.announced_at || null,
        nextCheckAt,
        sourceUrl: previous?.source_url || "https://npb.jp/announcement/starter/",
        errorCode,
        updatedAt: fetchedAt
      });
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
      metadata: { source, nextCheckAt },
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
        metadata: { source },
        source
      });
    }
  }
}

export async function selectProbableStarterCronTarget(db, now = new Date()) {
  const target = await getServerPredictionTarget(db, now);
  if (!target?.gameId) return { target: null, row: null, reason: "no_target", gameId: "" };
  const row = await db.prepare(
    "SELECT status, home_pitcher_name, away_pitcher_name, next_check_at FROM probable_starters WHERE game_id = ?1 LIMIT 1"
  ).bind(target.gameId).first();
  if (isProbableStarterComplete(row)) {
    return { target: null, row, reason: "already_announced", gameId: target.gameId };
  }
  return { target, row, reason: "candidate", gameId: target.gameId };
}

async function runDueProbableStarterJob(env, now) {
  const selection = await selectProbableStarterCronTarget(env.AUTH_DB, now);
  const target = selection.target;
  if (selection.reason === "already_announced") {
    // 完了済み試合はCron対象から除外し、取得関数・スキップログへ進めません。
    return { status: "already_announced", gameId: selection.gameId, reason: "already_announced" };
  }
  if (!target?.gameId || !target.startAt || new Date(now).getTime() >= new Date(target.startAt).getTime()) {
    const gameId = target?.gameId || "";
    const started = Boolean(gameId && target?.startAt && new Date(now).getTime() >= new Date(target.startAt).getTime());
    await recordProbableStarterDecision(env.AUTH_DB, {
      eventType: started ? "probable_starter_fetch_skipped" : "probable_starter_no_target",
      status: "info",
      gameId,
      occurredAt: now,
      message: started ? "試合開始後のため予告先発取得をスキップしました。" : "予告先発の取得対象試合がありません。",
      errorCode: started ? "PROBABLE_STARTER_AFTER_START" : "PROBABLE_STARTER_NO_TARGET",
      metadata: { source: "cron", gameDate: target?.date || getJstDateString(now) },
      source: "cron"
    });
    return { status: started ? "not_due" : "noTarget", gameId };
  }
  if (await isProbableStarterTestGame(env.AUTH_DB, target.gameId)) {
    await recordProbableStarterDecision(env.AUTH_DB, {
      eventType: "probable_starter_fetch_skipped",
      status: "info",
      gameId: target.gameId,
      occurredAt: now,
      message: "テスト試合のため予告先発取得をスキップしました。",
      errorCode: "PROBABLE_STARTER_TEST_GAME",
      metadata: { source: "cron", gameDate: target.date || getJstDateString(now) },
      source: "cron"
    });
    return { status: "skipped", gameId: target.gameId, reason: "test_game" };
  }
  const row = selection.row;
  if (row?.next_check_at && new Date(row.next_check_at).getTime() > new Date(now).getTime()) {
    await recordProbableStarterDecision(env.AUTH_DB, {
      eventType: "probable_starter_fetch_skipped",
      status: "info",
      gameId: target.gameId,
      occurredAt: now,
      message: "予告先発の再取得待機中のためスキップしました。",
      errorCode: "PROBABLE_STARTER_RETRY_WAIT",
      metadata: { source: "cron", gameDate: target.date || getJstDateString(now), nextCheckAt: row.next_check_at },
      source: "cron"
    });
    return { status: "retry_wait", gameId: target.gameId, nextCheckAt: row.next_check_at };
  }
  try {
    return await runProbableStarterFetch(env, target, now, { source: "cron" });
  } catch (error) {
    return { status: "error", gameId: target.gameId, errorCode: error?.code || "PROBABLE_STARTER_FETCH_FAILED" };
  }
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
    const existingResult = await env.AUTH_DB.prepare(
      `SELECT game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, venue, game_status
         FROM detected_game_schedule WHERE game_date = ?1 ORDER BY updated_at DESC`
    ).bind(date).all();
    const existingByIdentity = new Map();
    for (const row of existingResult.results || []) {
      const key = createScheduleIdentityKey({
        date: row.game_date,
        startAt: row.start_at,
        homeTeam: row.home_team,
        awayTeam: row.away_team
      });
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
        sourceGameKey: String(game.gameCode || `${date}:${game.homeTeam}:${game.awayTeam}:${game.startTime}`),
        gameStatus: game.status === "cancelled" ? "cancelled" : "scheduled"
      };
    });
    const changed = await hasScheduleDataChanged(env.AUTH_DB, date, normalizedGames);
    const statements = [];
    for (const item of normalizedGames) {
      const { game, startAt, sourceGameKey, gameStatus, existingRow } = item;
      if (existingRow) {
        // 公式gameCodeが後から得られても、予想・採点に紐づく既存game_idは維持します。
        statements.push(env.AUTH_DB.prepare(
          `UPDATE detected_game_schedule
              SET start_at = ?1, home_team = ?2, away_team = ?3, game_code = ?4,
                  venue = ?5, game_status = ?6, schedule_checked_at = ?7, updated_at = ?7
            WHERE game_id = ?8`
        ).bind(startAt.toISOString(), game.homeTeam, game.awayTeam, game.gameCode || null, game.venue || null, gameStatus, now.toISOString(), existingRow.game_id));
      } else {
        statements.push(env.AUTH_DB.prepare(
          `INSERT INTO detected_game_schedule (game_id, source_game_key, game_date, start_at, home_team, away_team, game_code, venue, game_status, detected_at, schedule_checked_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?10, ?10)
           ON CONFLICT(source_game_key) DO UPDATE SET start_at=excluded.start_at, venue=excluded.venue, game_status=excluded.game_status, schedule_checked_at=excluded.schedule_checked_at, updated_at=excluded.updated_at`
        ).bind(game.gameId, sourceGameKey, date, startAt.toISOString(), game.homeTeam, game.awayTeam, game.gameCode || null, game.venue || null, gameStatus, now.toISOString()));
      }
    }
    const nextCheck = new Date(now.getTime() + AUTOMATION_SCHEDULE_SYNC_INTERVAL_MS).toISOString();
    statements.push(env.AUTH_DB.prepare(
      `INSERT INTO game_schedule_check_state (schedule_date, next_check_at, last_checked_at, last_error_code, updated_at)
       VALUES (?1, ?2, ?3, NULL, ?3)
       ON CONFLICT(schedule_date) DO UPDATE SET next_check_at=excluded.next_check_at, last_checked_at=excluded.last_checked_at, last_error_code=NULL, updated_at=excluded.updated_at`
    ).bind(date, nextCheck, now.toISOString()));
    if (statements.length) await env.AUTH_DB.batch(statements);
    console.log(`[GAME_DETECTION] date=${date} team=fighters gamesFound=${payload.games.length} status=success`);
    return { status: changed ? "success_changed" : "success_no_change", date, gameCount: payload.games.length };
  }
  return { status: "skipped", date };
}

function normalizeNpbGameCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9]{1,2}-[a-z0-9]{1,2}-\d+$/.test(normalized) ? normalized : "";
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
  const stored = await db.prepare(
    "SELECT * FROM detected_game_schedule WHERE game_date >= ?1 AND game_date <= ?2 AND game_status = 'scheduled' ORDER BY start_at"
  ).bind(sortedDates[0], sortedDates[sortedDates.length - 1]).all();
  return (stored.results || []).map((row) => ({
    gameId: row.game_id,
    date: row.game_date,
    startTime: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(row.start_at)),
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    venue: row.venue || "",
    gameCode: row.game_code || "",
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

async function handleAdminModeCapabilities(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) {
    return access.response;
  }
  return jsonResponse({
    ok: true,
    authenticated: true,
    role: "admin",
    adminModeAvailable: true
  }, 200, cors);
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

async function runDueAutoScoringTestJobs(env, now) {
  const summary = { considered: 0, processed: 0, succeeded: 0, failed: 0 };
  try {
    const result = await env.AUTH_DB.prepare(
      `SELECT game_id FROM auto_scoring_tests
        WHERE mode = 'auto_scoring' AND status IN ('ready', 'waiting') AND prediction_deadline_at <= ?1
        ORDER BY prediction_deadline_at ASC LIMIT 10`
    ).bind(now.toISOString()).all();
    for (const row of result.results || []) {
      summary.considered += 1;
      const outcome = await runSingleAutoScoringTest(env, row.game_id, now);
      if (outcome.ok) summary.succeeded += 1;
      else summary.failed += 1;
      summary.processed += 1;
    }
  } catch (error) {
    if (!isPregameSchemaError(error)) throw error;
    console.warn("[AUTO_SCORING_TEST] migration is not applied; test jobs skipped");
  }
  return summary;
}

function parseAdminTestRoute(path) {
  if (path === "/api/dev/status" || path === "/api/dev/cron/run-auto-scoring" || path === "/api/dev/achievements") {
    return { action: path.slice("/api/dev/".length) };
  }
  if (path === "/api/dev/achievements/grant-test") {
    return { action: "achievements/grant-test" };
  }
  const match = /^\/api\/dev\/games\/([^/]+)\/create-perfect-prediction$/.exec(path);
  if (match) {
    try {
      return { action: "create-perfect-prediction", gameId: decodeURIComponent(match[1]) };
    } catch {
      return { invalid: true };
    }
  }
  const achievementMatch = /^\/api\/dev\/achievements\/([^/]+)\/test-grant$/.exec(path);
  if (!achievementMatch) return null;
  try {
    return { action: "achievements/delete-test-grant", code: decodeURIComponent(achievementMatch[1]) };
  } catch {
    return { invalid: true };
  }
}

async function handleAdminTestRoute(request, env, cors, route) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) {
    return access.response;
  }
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
  if (route.action === "cron/run-auto-scoring" && request.method === "POST") {
    const summary = await runDueAutoScoringJobs(env, new Date());
    return jsonResponse({ ok: true, ...summary }, 200, cors);
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

function parseAdminScoringRoute(path) {
  const match = /^\/api\/admin\/games\/([^/]+)\/(predictions\/(?:summary|score-predictions(?:\/preview)?)|actual-lineup|lineup-history|lineup-revisions|rescore-preview|rescore-confirm|restore-lineup-version|rescore-history|service-unavailable|restore-service-unavailable|auto-scoring\/(?:status|run-now|retry|cancel)|pregame-automation\/(?:run-roster|run-lineup|run-notice|distribute-notice|fix-roster|publish|workflow-status|pause-workflow|resume-workflow))$/.exec(path);
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

  const metadata = parsePredictionGameId(route.gameId);
  if (route.invalid || !metadata) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdが不正です。" }, 400, cors);
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
    return await handleAdminActualLineupSave(request, env, cors, metadata.gameId);
  }
  if (route.action === "service-unavailable" && request.method === "POST") {
    return await handleAdminServiceUnavailable(env, cors, metadata.gameId, true);
  }
  if (route.action === "restore-service-unavailable" && request.method === "POST") {
    return await handleAdminServiceUnavailable(env, cors, metadata.gameId, false);
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
  if (route.action === "pregame-automation/workflow-status" && request.method === "GET") {
    return await handleAdminGameWorkflowStatus(env, cors, metadata.gameId);
  }
  if (route.action === "pregame-automation/pause-workflow" && request.method === "POST") {
    return await handleAdminGameWorkflowPause(env, cors, metadata.gameId, true);
  }
  if (route.action === "pregame-automation/resume-workflow" && request.method === "POST") {
    return await handleAdminGameWorkflowPause(env, cors, metadata.gameId, false);
  }
  if (route.action === "pregame-automation/run-roster" && request.method === "POST") {
    return await executePregameTool(env, cors, metadata.gameId, "run-roster", () => captureGameRosterSnapshot(env, metadata.gameId, new Date(), { force: true, source: "admin" }));
  }
  if (route.action === "pregame-automation/run-lineup" && request.method === "POST") {
    return await executePregameTool(env, cors, metadata.gameId, "run-lineup", () => captureOfficialLineup(env, metadata.gameId, new Date(), { force: true }));
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

async function handleAdminGameWorkflowStatus(env, cors, gameId) {
  try {
    const status = await getPregameAutomationStatus(env.AUTH_DB, gameId);
    const response = jsonResponse({ ok: true, gameId, ...status }, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=status action=read status=failed code=${error?.code || "GAME_WORKFLOW_STATUS_UNAVAILABLE"}`);
    return jsonResponse({
      ok: false,
      gameId,
      code: isPregameSchemaError(error) ? "GAME_WORKFLOW_SCHEMA_NOT_READY" : "GAME_WORKFLOW_STATUS_UNAVAILABLE",
      error: "自動運転の状態を取得できませんでした。"
    }, isPregameSchemaError(error) ? 503 : 500, cors);
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
    return await handleAdminGameWorkflowStatus(env, cors, gameId);
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

async function handleGetGameDayStatus(request, env, cors) {
  const gameId = getValidGameId(new URL(request.url).searchParams.get("gameId"));
  const identity = gameId ? getGameIdentityForPregame(gameId) : null;
  if (!identity) return jsonResponse({ ok: false, error: "対象試合を指定してください。" }, 400, cors);
  const status = await getGameDayStatus(env.AUTH_DB, identity);
  return jsonResponse({ ok: true, gameId, ...status }, 200, cors);
}

async function handleGetGameDayRoster(request, env, cors) {
  const gameId = getValidGameId(new URL(request.url).searchParams.get("gameId"));
  const identity = gameId ? getGameIdentityForPregame(gameId) : null;
  if (!identity) return jsonResponse({ ok: false, error: "対象試合を指定してください。" }, 400, cors);
  const row = await env.AUTH_DB.prepare(
    `SELECT captured_at, roster_json, player_count, source
       FROM game_roster_snapshots WHERE game_id = ?1 LIMIT 1`
  ).bind(gameId).first();
  const players = row ? parseJsonArray(row.roster_json).filter((player) => player && player.name && player.number && player.position) : [];
  return jsonResponse({
    ok: true,
    gameId,
    status: players.length ? "captured" : "pending",
    capturedAt: row?.captured_at || null,
    source: row?.source || "",
    playerCount: players.length || Number(row?.player_count || 0),
    players
  }, 200, cors);
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

async function runDueGameDayScheduleJobs(env, now, timelines = getPregameTimelines()) {
  const plan = getNoticePollingPlan(timelines, now);
  if (!plan.date) return { notice: { due: false }, rosterFixed: 0 };
  await ensureGameDayNoticeRows(env.AUTH_DB, timelines, plan.date, now);
  let notice = { due: plan.due, skipped: true, slotKey: plan.slotKey };
  if (plan.due && await claimGameDayNoticeSlot(env.AUTH_DB, plan.date, plan.slotKey, now)) {
    try {
      notice = await runGameDayNoticeOnce(env, now, "", timelines);
      console.log(`[GAME_WORKFLOW] gameId=${notice.appliedGameIds?.join(",") || `day-${plan.date}`} step=notice action=executed status=success`);
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "notice_fetch",
        status: "success",
        gameId: notice.appliedGameIds?.[0] || `day-${plan.date}`,
        occurredAt: now,
        message: notice.isEmpty ? "指定日の公示はありません。" : "公示取得が完了しました。",
        errorCode: "",
        metadata: {
          date: plan.date,
          noticeDate: notice.noticeDate,
          pageDate: notice.pageDate,
          registrationCount: notice.registrationCount,
          removalCount: notice.removalCount,
          isEmpty: notice.isEmpty,
          appliedGameCount: Array.isArray(notice.appliedGameIds) ? notice.appliedGameIds.length : 0
        },
        source: "cron"
      });
    } catch (error) {
      await recordGameDayNoticeError(env.AUTH_DB, plan.date, error, now);
      notice = { due: true, status: "error", errorCode: String(error?.code || "NOTICE_FETCH_FAILED") };
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "notice_fetch",
        status: "error",
        gameId: `day-${plan.date}`,
        occurredAt: now,
        message: "公示取得に失敗しました。",
        errorCode: String(error?.code || "NOTICE_FETCH_FAILED"),
        metadata: { date: plan.date },
        source: "cron"
      });
      console.warn(`[GAME_WORKFLOW] gameId=day-${plan.date} step=notice action=executed status=failed code=${error?.code || "unknown"}`);
    }
  }
  const rosterResult = await fixDueGameRosters(env, timelines, now);
  if (rosterResult.fixed > 0) {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "roster_fixed",
      status: "success",
      gameId: `day-${plan.date}`,
      occurredAt: now,
      message: "ロースターを固定しました。",
      metadata: { date: plan.date, fixedCount: rosterResult.fixed },
      source: "cron"
    });
    console.log(`[GAME_WORKFLOW] gameId=day-${plan.date} step=close_predictions action=executed status=success rosterFixed=${rosterResult.fixed}`);
  }
  return { notice, rosterFixed: rosterResult.fixed, rosterFailed: rosterResult.failed };
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
  await db.batch([
    db.prepare(
      `INSERT INTO game_roster_snapshots
         (game_id, game_date, captured_at, roster_json, source, player_count, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'npb-roster', ?5, 'captured', ?3, ?3)
       ON CONFLICT(game_id) DO UPDATE SET
         captured_at = excluded.captured_at, roster_json = excluded.roster_json,
         player_count = excluded.player_count, updated_at = excluded.updated_at`
    ).bind(identity.gameId, identity.game.date, capturedAtIso, rosterJson, players.length),
    db.prepare(
      `UPDATE game_pregame_automation
          SET roster_status = 'captured', roster_captured_at = ?1,
              last_error_code = NULL, last_error_message = NULL, updated_at = ?1
        WHERE game_id = ?2`
    ).bind(capturedAtIso, identity.gameId)
  ]);
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

async function runDueRosterCaptureJobs(env, now, timelines = getPregameTimelines()) {
  const target = await getServerPredictionTarget(env.AUTH_DB, now);
  const timeline = (Array.isArray(timelines) ? timelines : [])
    .find((item) => isNormalRosterTimeline(item) && item.gameId === target?.gameId);
  if (!timeline || now >= timeline.startAt) return { due: false, status: "idle", gameId: timeline?.gameId || "" };

  await ensurePregameAutomationRow(env.AUTH_DB, timeline, now);
  const storedState = await readRosterFetchState(env.AUTH_DB, timeline.gameId) || {};
  const previousSnapshot = await readRosterSnapshot(env.AUTH_DB, timeline.gameId);
  const decisionState = {
    lastSuccessfulFetchAt: storedState.last_successful_roster_fetch_at || previousSnapshot.capturedAt,
    nextCheckAt: storedState.roster_next_check_at,
    lastPregameCheckGameId: storedState.last_pregame_check_game_id
  };
  const decision = getRosterFetchDecision(timeline, decisionState, now);
  if (!decision.due) return { due: false, status: decision.reason, gameId: timeline.gameId };

  try {
    const result = await captureGameRosterSnapshot(env, timeline.gameId, now, {
      force: true,
      source: "cron",
      pregame: decision.kind === "pregame"
    });
    if (result.status !== "captured") return { due: true, status: result.status, gameId: timeline.gameId };

    const changed = rosterFingerprint(previousSnapshot.players) !== rosterFingerprint(result.roster);
    if (changed || !previousSnapshot.players.length) {
      const message = previousSnapshot.players.length ? "ロースターに変更がありました。" : "ロースターを初回取得しました。";
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "roster_fetch",
        status: "success",
        gameId: timeline.gameId,
        occurredAt: now,
        message,
        metadata: { source: "cron", kind: decision.kind, playerCount: result.playerCount, changed },
        source: "cron"
      });
      console.log(`[GAME_WORKFLOW] gameId=${timeline.gameId} step=roster action=executed status=success source=cron changed=${changed}`);
    }
    return { due: true, status: "success", gameId: timeline.gameId, changed };
  } catch (error) {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "roster_fetch",
      status: "error",
      gameId: timeline.gameId,
      occurredAt: now,
      message: "ロースター取得に失敗しました。",
      errorCode: String(error?.code || "ROSTER_FETCH_FAILED"),
      metadata: { source: "cron", kind: decision.kind, retryAfterMinutes: 30 },
      source: "cron"
    });
    console.warn(`[GAME_WORKFLOW] gameId=${timeline.gameId} step=roster action=executed status=failed source=cron code=${error?.code || "ROSTER_FETCH_FAILED"}`);
    return { due: true, status: "error", gameId: timeline.gameId, errorCode: String(error?.code || "ROSTER_FETCH_FAILED") };
  }
}

async function handleAdminAutomationHealth(request, env, cors) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const response = jsonResponse({ ok: true, automation: await getAutomationHealth(env.AUTH_DB) }, 200, cors);
  response.headers.set("Cache-Control", "no-store");
  return response;
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

async function getAutomationHealth(db) {
  try {
    const row = await db.prepare(
      `SELECT cron_last_run_at, cron_last_success_at, cron_last_error_at,
              cron_last_error_code, processed_game_count
         FROM game_automation_health
        WHERE state_key = ?1 LIMIT 1`
    ).bind(AUTOMATION_HEALTH_STATE_KEY).first();
    return {
      available: true,
      cronLastRunAt: row?.cron_last_run_at || null,
      cronLastSuccessAt: row?.cron_last_success_at || null,
      cronLastErrorAt: row?.cron_last_error_at || null,
      cronLastError: row?.cron_last_error_code || "",
      processedGameCount: Number(row?.processed_game_count || 0)
    };
  } catch (error) {
    if (isPregameSchemaError(error)) {
      return { available: false, cronLastRunAt: null, cronLastSuccessAt: null, cronLastErrorAt: null, cronLastError: "", processedGameCount: 0 };
    }
    throw error;
  }
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

function getGameIdentityForPregame(gameId) {
  const timeline = getPregameTimeline(gameId);
  if (!timeline) return null;
  const storedGameCode = normalizeNpbGameCode(timeline.game?.gameCode);
  const idGameCode = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(timeline.gameId)?.[1] || "";
  const gameCode = storedGameCode || normalizeNpbGameCode(idGameCode);
  if (!gameCode) return null;
  return { ...timeline, gameCode };
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
        ...upstreamDetails
      });
    }
    if (!response.ok || !payload?.ok) {
      const upstreamCode = payload?.code || (response.status === 422 ? "NPB_RESPONSE_INVALID" : "NPB_HTTP_ERROR");
      throw createPregameError(upstreamCode, payload?.error || "NPB取得Workerがエラーを返しました。", {
        httpStatus: response.status,
        upstreamStatus: response.status,
        externalStatus: payload?.httpStatus,
        upstreamUrl: payload?.sourceUrl,
        ...upstreamDetails
      });
    }
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
  if (Number(details.httpStatus) > 0) error.httpStatus = Number(details.httpStatus);
  if (Number(details.upstreamStatus) > 0) error.upstreamStatus = Number(details.upstreamStatus);
  if (Number(details.externalStatus) > 0) error.externalStatus = Number(details.externalStatus);
  if (typeof details.upstreamUrl === "string" && /^https:\/\/npb\.jp\//i.test(details.upstreamUrl)) error.upstreamUrl = details.upstreamUrl;
  if (details.upstreamPath === "/") error.upstreamPath = "/";
  if (typeof details.upstreamMode === "string" && details.upstreamMode) error.upstreamMode = details.upstreamMode;
  if (typeof details.upstreamTransport === "string" && details.upstreamTransport) error.upstreamTransport = details.upstreamTransport;
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
  if (!Array.isArray(lineup) || lineup.length !== SCORING_LINEUP_SIZE) {
    return { ok: false, code: "LINEUP_INVALID_PLAYER_COUNT", error: "NPBのスタメン人数が9人ではありません。" };
  }
  const result = [];
  const orders = new Set();
  const players = new Set();
  for (const row of lineup) {
    const player = findFightersPlayerByName(row?.playerName);
    const battingOrder = Number(row?.order);
    const position = normalizeScoringPosition(row?.position);
    if (!player) {
      return { ok: false, code: "LINEUP_PLAYER_RESOLUTION_FAILED", error: "NPBの選手名を選手マスタへ安全に照合できません。" };
    }
    if (!Number.isInteger(battingOrder) || battingOrder < 1 || battingOrder > 9 || orders.has(battingOrder)) {
      return { ok: false, code: "LINEUP_PARSE_FAILED", error: "NPBの打順を安全に解析できません。" };
    }
    if (!position) {
      return { ok: false, code: "LINEUP_INVALID_POSITION", error: "NPBの守備位置を正規化できません。" };
    }
    const playerId = createFightersPlayerId(player.uniformNumber);
    if (players.has(playerId)) {
      return { ok: false, code: "LINEUP_DUPLICATE_PLAYER", error: "NPBのスタメンに同一選手が重複しています。" };
    }
    orders.add(battingOrder);
    players.add(playerId);
    result.push({
      playerId,
      teamId: FIGHTERS_TEAM_ID,
      teamCode: FIGHTERS_TEAM_CODE,
      uniformNumber: player.uniformNumber,
      playerName: player.name,
      battingOrder,
      position
    });
  }
  const sanitized = sanitizeActualLineupForScoring(result);
  return sanitized.ok ? { ok: true, lineup: sanitized.lineup } : {
    ok: false,
    code: "LINEUP_INVALID_POSITION",
    error: sanitized.error || "NPBの守備位置を検証できません。"
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
  await db.prepare(
    `INSERT INTO game_pregame_automation (game_id, game_date, start_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(game_id) DO UPDATE SET game_date = excluded.game_date, start_at = excluded.start_at, updated_at = excluded.updated_at`
  ).bind(identity.gameId, identity.game.date, identity.startAt.toISOString(), nowIso).run();
}

async function readRosterFetchState(db, gameId) {
  try {
    return await db.prepare(
      `SELECT last_successful_roster_fetch_at, roster_next_check_at, last_pregame_check_game_id,
              last_roster_attempt_at, last_roster_error_code, last_roster_fetch_source
         FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1`
    ).bind(gameId).first();
  } catch (error) {
    if (isPregameSchemaError(error)) return null;
    throw error;
  }
}

async function updateRosterFetchState(db, gameId, now, { source = "cron", success = false, pregame = false, errorCode = "" } = {}) {
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
              last_pregame_check_game_id = CASE WHEN ?4 THEN game_id ELSE last_pregame_check_game_id END,
              last_roster_error_code = ?5,
              last_roster_fetch_source = ?6,
              updated_at = ?1
        WHERE game_id = ?7`
    ).bind(nowIso, success ? 1 : 0, nextCheckAt, pregame ? 1 : 0, errorCode || null, source === "admin" ? "admin" : "cron", gameId).run();
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

async function captureGameRosterSnapshot(env, gameId, now, { force = false, source = "admin", pregame = false } = {}) {
  const identity = getGameIdentityForPregame(gameId);
  if (!identity) throw createPregameError("SCHEDULE_UNAVAILABLE", "試合日程を確認できません。");
  await ensurePregameAutomationRow(env.AUTH_DB, identity, now);
  const frozen = await env.AUTH_DB.prepare("SELECT roster_fixed_at FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
  if (frozen?.roster_fixed_at) return { status: "frozen", fixedAt: frozen.roster_fixed_at };
  const existing = await env.AUTH_DB.prepare("SELECT game_id FROM game_roster_snapshots WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
  if (existing && !force) return { status: "already_captured" };
  try {
    const payload = await fetchNpbWorkerJson(env, { mode: "roster" });
    const roster = normalizeRosterForSnapshot(payload.players);
    if (!roster || payload.warning) throw createPregameError("INVALID_ROSTER", "NPBロースターの解析結果が不完全です。");
    const capturedAt = String(payload.fetchedAt || now.toISOString());
    const rosterJson = JSON.stringify(roster);
    await env.AUTH_DB.batch([
      env.AUTH_DB.prepare(
        `INSERT INTO game_roster_snapshots (game_id, game_date, captured_at, roster_json, source, player_count, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'npb-roster', ?5, 'captured', ?3, ?3)
         ON CONFLICT(game_id) DO UPDATE SET captured_at = excluded.captured_at, roster_json = excluded.roster_json, player_count = excluded.player_count, updated_at = excluded.updated_at`
      ).bind(gameId, identity.game.date, capturedAt, rosterJson, roster.length),
      env.AUTH_DB.prepare(
        `UPDATE game_pregame_automation SET roster_status = 'captured', roster_captured_at = ?1, last_error_code = NULL, last_error_message = NULL, updated_at = ?1 WHERE game_id = ?2`
      ).bind(capturedAt, gameId)
    ]);
    await updateRosterFetchState(env.AUTH_DB, gameId, now, { source, success: true, pregame });
    return { status: "captured", playerCount: roster.length, capturedAt, roster };
  } catch (error) {
    await updateRosterFetchState(env.AUTH_DB, gameId, now, { source, errorCode: String(error?.code || "ROSTER_FETCH_FAILED") });
    try {
      await recordPregameError(env.AUTH_DB, gameId, "roster", error, now);
    } catch (recordError) {
      console.error(`pregame roster error record failed: game=${gameId} code=${recordError?.code || "schema"}`);
    }
    throw error;
  }
}

async function captureOfficialLineup(env, gameId, now, { force = false, phase = "provisional", autoApproveEnabled = true } = {}) {
  const identity = getGameIdentityForPregame(gameId);
  if (!identity) throw createPregameError("LINEUP_URL_BUILD_FAILED", "NPB公式スタメンURLを生成できません。試合の日程コードを確認してください。");
  const isFinalCapture = phase === "final";
  if (isFinalCapture ? now < identity.finalLineupFetchAt : !isBeforeGameStart(identity.startAt, now)) {
    return { status: isFinalCapture ? "not_due" : "skipped_after_start" };
  }
  await ensurePregameAutomationRow(env.AUTH_DB, identity, now);
  const existing = await getGameLineup(env.AUTH_DB, gameId);
  if (existing) return { status: existing.lineup_source === "manual" ? "manual_lineup_exists" : "already_captured" };
  try {
    const payload = await fetchNpbWorkerJson(env, { mode: "lineup", date: identity.game.date, gameCode: identity.gameCode });
    const actual = createOfficialLineupFromNpb(payload.lineup);
    if (!actual.ok) throw createPregameError(actual.code || "LINEUP_PARSE_FAILED", actual.error);
    const detectedAt = new Date(payload.fetchedAt || now);
    if (!isFinalCapture) {
      await saveProvisionalOfficialLineup(env.AUTH_DB, gameId, actual.lineup, detectedAt, now);
      return { status: "provisional", sourceUrl: payload.sourceUrl, lineup: actual.lineup, detectedAt: detectedAt.toISOString() };
    }
    const record = await approveActualLineupForAutoScoring(env, gameId, actual.lineup, detectedAt, {
      source: "npb-auto",
      scoringDueAt: new Date(identity.startAt.getTime() + 2 * 60 * 1000),
      now,
      allowAfterStart: true,
      preventOverwrite: true
    });
    await env.AUTH_DB.prepare(
      `UPDATE game_pregame_automation
          SET lineup_status = 'captured', lineup_captured_at = ?1, final_lineup_attempt_at = ?1,
              last_lineup_attempt_at = ?1, lineup_attempt_count = lineup_attempt_count + 1,
              next_lineup_attempt_at = NULL,
              last_error_code = NULL, last_error_message = NULL, updated_at = ?1
        WHERE game_id = ?2`
    ).bind(now.toISOString(), gameId).run();
    return { status: "captured", sourceUrl: payload.sourceUrl, autoScoring: serializeGameLineup(record) };
  } catch (error) {
    try {
      await recordPregameLineupAttempt(env.AUTH_DB, gameId, identity, now, error, phase);
    } catch (recordError) {
      console.error(`pregame lineup error record failed: game=${gameId} code=${recordError?.code || "schema"}`);
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

async function updatePredictionTargetState(db, target, now) {
  try {
    const current = await db.prepare(
      "SELECT prediction_target_game_id, prediction_target_no_next_logged_at FROM game_automation_health WHERE state_key = ?1 LIMIT 1"
    ).bind(AUTOMATION_HEALTH_STATE_KEY).first();
    const previousGameId = String(current?.prediction_target_game_id || "");
    const nextGameId = String(target?.gameId || "");
    if (!nextGameId) {
      const noNextLoggedAt = current?.prediction_target_no_next_logged_at ? new Date(current.prediction_target_no_next_logged_at) : null;
      const noNextLoggedToday = noNextLoggedAt && !Number.isNaN(noNextLoggedAt.getTime())
        ? getJstDateString(noNextLoggedAt) === getJstDateString(now)
        : false;
      if (previousGameId && !noNextLoggedToday) {
        await db.prepare(
          "UPDATE game_automation_health SET prediction_target_no_next_logged_at = ?1 WHERE state_key = ?2"
        ).bind(now.toISOString(), AUTOMATION_HEALTH_STATE_KEY).run();
        await recordWorkflowLog(db, {
          eventType: "prediction_target_switch_skipped",
          status: "warning",
          gameId: previousGameId,
          occurredAt: now,
          message: "次の対象試合がないため、現在の予想対象を維持しました。",
          metadata: { previousGameId, reason: "no_next_game" },
          source: "cron"
        });
      }
      return { changed: false, previousGameId, nextGameId: previousGameId, skipped: Boolean(previousGameId) };
    }
    if (previousGameId === nextGameId) return { changed: false, previousGameId, nextGameId };
    await db.prepare(
      `INSERT INTO game_automation_health
         (state_key, prediction_target_game_id, prediction_target_no_next_logged_at, updated_at)
       VALUES (?1, ?2, NULL, ?3)
       ON CONFLICT(state_key) DO UPDATE SET
         prediction_target_game_id = excluded.prediction_target_game_id,
         prediction_target_no_next_logged_at = NULL,
         updated_at = excluded.updated_at`
    ).bind(AUTOMATION_HEALTH_STATE_KEY, nextGameId, now.toISOString()).run();
    await recordWorkflowLog(db, {
      eventType: "prediction_target_switched",
      status: "success",
      gameId: nextGameId,
      occurredAt: now,
      message: "予想対象試合を次の試合へ切り替えました。",
      metadata: { previousGameId: previousGameId || null, nextGameId },
      source: "cron"
    });
    return { changed: true, previousGameId, nextGameId };
  } catch (error) {
    console.warn(`[GAME_WORKFLOW_LOG] action=target_state status=failed code=${error?.code || "PREDICTION_TARGET_STATE_FAILED"}`);
    return { changed: false, previousGameId: "", nextGameId: String(target?.gameId || ""), error };
  }
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
  try {
    const rows = await db.prepare(
      `SELECT game_id, game_date, start_at, home_team, away_team, game_code, venue, game_status
         FROM detected_game_schedule
        WHERE game_status = 'scheduled' AND start_at > ?1
        ORDER BY start_at ASC LIMIT 50`
    ).bind(now.toISOString()).all();
    detectedGames = (rows.results || []).map((row) => ({
      gameId: row.game_id,
      date: row.game_date,
      startAt: new Date(row.start_at),
      homeTeam: row.home_team,
      awayTeam: row.away_team,
      gameCode: row.game_code || "",
      venue: row.venue || "",
      status: row.game_status
    }));
  } catch {
    // 既存D1に検出日程テーブルがない環境では、静的日程へ安全にフォールバックします。
  }
  const target = selectNextPredictionTarget([...detectedGames, ...getScheduledGames()], now);
  return target ? serializePredictionTarget(target) : null;
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
    venue: game.venue || ""
  };
}

async function handleGetPredictionTarget(request, env, cors) {
  const target = await getServerPredictionTarget(env.AUTH_DB, new Date());
  const response = jsonResponse({ ok: true, target, generatedAt: new Date().toISOString() }, 200, cors);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

async function handleGetProbableStarter(request, env, cors) {
  const gameId = getValidGameId(new URL(request.url).searchParams.get("gameId"));
  if (!gameId) return jsonResponse({ ok: false, code: "GAME_ID_INVALID", error: "対象試合を指定してください。" }, 400, cors);
  try {
    const row = await env.AUTH_DB.prepare("SELECT * FROM probable_starters WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
    const response = jsonResponse({ ok: true, gameId, probableStarter: serializeProbableStarterRow(row) }, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    return jsonResponse({
      ok: false,
      code: isPregameSchemaError(error) ? "PROBABLE_STARTER_SCHEMA_NOT_READY" : "PROBABLE_STARTER_READ_FAILED",
      error: "予告先発情報を取得できませんでした。"
    }, isPregameSchemaError(error) ? 503 : 500, cors);
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

async function handleAdminProbableStarterRefresh(request, env, cors, gameId) {
  const access = await requireAdminUser(request, env, cors);
  if (!access.ok) return access.response;
  const validGameId = getValidGameId(gameId);
  const metadata = validGameId ? await getResultGameMetadata(env.AUTH_DB, validGameId) : null;
  const startAt = metadata?.startAt ? new Date(metadata.startAt) : null;
  if (!metadata || !startAt || Number.isNaN(startAt.getTime()) || !metadata.homeTeam || !metadata.awayTeam) {
    return jsonResponse({ ok: false, code: "GAME_NOT_FOUND", error: "対象試合が見つかりません。" }, 404, cors);
  }
  const target = { ...metadata, gameId: validGameId, startAt };
  try {
    const result = await runProbableStarterFetch(env, target, new Date(), { source: "admin" });
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "probable_starter_manual_refresh",
      status: "success",
      gameId: validGameId,
      message: "予告先発を手動で再取得しました。",
      metadata: { status: result?.probableStarter?.status || "unknown" },
      source: "admin"
    });
    const response = jsonResponse(result, 200, cors);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "probable_starter_manual_refresh",
      status: "error",
      gameId: validGameId,
      message: "予告先発の手動再取得に失敗しました。",
      errorCode: String(error?.code || "PROBABLE_STARTER_FETCH_FAILED"),
      source: "admin"
    });
    return jsonResponse({
      ok: false,
      code: String(error?.code || "PROBABLE_STARTER_FETCH_FAILED"),
      error: "予告先発を取得できませんでした。"
    }, Number(error?.httpStatus) >= 400 ? Number(error.httpStatus) : 502, cors);
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
      `SELECT game_id, game_date, start_at, home_team, away_team, game_code, venue
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
            ranking_games.game_date, ranking_games.game_status, ranking_games.publication_status
       FROM latest_predictions
       JOIN ranking_games ON ranking_games.game_id = latest_predictions.game_id
      WHERE latest_predictions.submission_rank = 1
        AND (
          (latest_predictions.status = 'scored'
           AND ranking_games.game_status = 'scored'
           AND ranking_games.is_ranking_eligible = 1)
          OR ranking_games.game_status = 'service_unavailable'
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
    games.push({
      ...metadata,
      gameDate: row.game_date || metadata.date,
      resultsPublished,
      score: !serviceUnavailable && resultsPublished && row.score !== null ? Number(row.score) : null,
      maxScore: !serviceUnavailable && resultsPublished && row.max_score !== null ? Number(row.max_score) : null,
      scoredAt: !serviceUnavailable ? (row.scored_at || null) : null,
      publicationStatus: row.publication_status || "scored_private",
      serviceUnavailable,
      serviceUnavailableReason: serviceUnavailable ? SCORING_RETRY_EXPIRED_CODE : null,
      serviceUnavailableMessage: serviceUnavailable ? SERVICE_UNAVAILABLE_MESSAGE : null
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
      serviceUnavailable: true,
      serviceUnavailableReason: SCORING_RETRY_EXPIRED_CODE,
      serviceUnavailableMessage: SERVICE_UNAVAILABLE_MESSAGE
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

async function saveProvisionalOfficialLineup(db, gameId, lineup, detectedAt, now) {
  await db.prepare(
    `UPDATE game_pregame_automation
        SET lineup_status = 'captured', provisional_lineup_json = ?1,
            provisional_lineup_detected_at = ?2, lineup_attempt_count = lineup_attempt_count + 1,
            last_lineup_attempt_at = ?3, next_lineup_attempt_at = NULL,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?3
      WHERE game_id = ?4`
  ).bind(JSON.stringify(lineup), detectedAt.toISOString(), now.toISOString(), gameId).run();
}

async function useProvisionalLineupFallback(env, gameId, identity, now, finalError) {
  const job = await env.AUTH_DB.prepare(
    "SELECT provisional_lineup_json, provisional_lineup_detected_at FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1"
  ).bind(gameId).first();
  const provisional = parseStoredActualLineup(job?.provisional_lineup_json);
  const actualResult = sanitizeActualLineupForScoring(provisional);
  if (!actualResult.ok) return { used: false };

  const detectedAt = parseLineupDetectedAt(job?.provisional_lineup_detected_at) || now;
  const record = await approveActualLineupForAutoScoring(env, gameId, actualResult.lineup, detectedAt, {
    source: "npb-auto",
    scoringDueAt: new Date(identity.startAt.getTime() + 2 * 60 * 1000),
    now,
    allowAfterStart: true,
    preventOverwrite: true
  });
  const errorCode = classifyLineupErrorCode(finalError);
  await env.AUTH_DB.prepare(
    `UPDATE game_pregame_automation
        SET lineup_status = 'captured', lineup_captured_at = ?1,
            final_lineup_attempt_at = ?1, next_lineup_attempt_at = NULL,
            final_lineup_fallback_used = 1, final_lineup_error_code = ?2,
            last_error_code = NULL, last_error_message = NULL, updated_at = ?1
      WHERE game_id = ?3`
  ).bind(now.toISOString(), errorCode, gameId).run();
  return { used: true, record, errorCode };
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

async function getRankingGameState(db, gameId) {
  return db.prepare(
    `SELECT game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status,
            is_test_game, publication_status, scored_private_at, published_at
       FROM ranking_games WHERE game_id = ?1 LIMIT 1`
  ).bind(gameId).first();
}

async function isServiceUnavailableGame(db, gameId) {
  const row = await getRankingGameState(db, gameId);
  return isServiceUnavailableGameStatus(row?.game_status);
}

async function markGameServiceUnavailable(db, gameId, at, reasonCode = SCORING_RETRY_EXPIRED_CODE) {
  const metadata = parsePredictionGameId(gameId);
  if (!metadata) return false;
  const now = toIsoString(at);
  const existing = await getRankingGameState(db, gameId);
  if (Number(existing?.is_test_game || 0) === 1 || ["scored", "cancelled"].includes(existing?.game_status)) return false;
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
       is_test_game = 0,
       publication_status = 'pending',
       scored_private_at = NULL,
       published_at = NULL,
       updated_at = excluded.updated_at`
  ).bind(gameId, metadata.date, SERVICE_UNAVAILABLE_GAME_STATUS, now).run();
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

async function runDuePregameAutomationJobs(env, now, timelines = getPregameTimelines()) {
  const summary = { lineupCaptured: 0, provisionalCaptured: 0, finalLineupCaptured: 0, finalLineupFallbackUsed: 0, lineupAwaitingApproval: 0, lineupFailed: 0, lineupRetryWait: 0 };
  for (const timeline of timelines) {
    const gameId = timeline.gameId;
    try {
      const currentLineup = await getGameLineup(env.AUTH_DB, gameId);
      if (currentLineup) continue;
      const finalLineupFetchAt = timeline.finalLineupFetchAt || new Date(timeline.startAt.getTime() + 60 * 1000);
      const isFinalPhase = now >= finalLineupFetchAt;
      const dueAt = isFinalPhase ? getDueFinalLineupAttemptAt(timeline, now) : getDueLineupAttemptAt(timeline, now);
      if (!dueAt) continue;
      const job = await env.AUTH_DB.prepare("SELECT last_lineup_attempt_at, final_lineup_attempt_at, last_error_code FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
      const lastAttemptAt = isFinalPhase ? job?.final_lineup_attempt_at : job?.last_lineup_attempt_at;
      if (isFinalPhase && isFinalLineupRetryExpired(timeline, now)) {
        if (!job) await ensurePregameAutomationRow(env.AUTH_DB, timeline, now);
        await recordScoringRetryExpiredOnce(env.AUTH_DB, timeline, now, job?.last_error_code || "LINEUP_FETCH_FAILED");
        continue;
      }
      if (lastAttemptAt && new Date(lastAttemptAt) >= dueAt) {
        // 同じ10分枠での待機を毎分出力しないため、枠の開始時だけ記録します。
        if (now.getTime() === dueAt.getTime()) {
          summary.lineupRetryWait += 1;
          await recordWorkflowLog(env.AUTH_DB, {
            eventType: "lineup_retry_wait",
            status: "info",
            gameId,
            occurredAt: now,
            message: "次回の実スタメン取得を待っています。",
            metadata: { phase: isFinalPhase ? "final" : "provisional", nextRetryAt: new Date(dueAt.getTime() + 10 * 60 * 1000).toISOString() },
            source: "cron"
          });
          console.log(`[GAME_WORKFLOW] gameId=${gameId} step=lineup action=skipped status=retry_wait nextRetryAt=${new Date(dueAt.getTime() + 10 * 60 * 1000).toISOString()}`);
        }
        continue;
      }
      const result = await captureOfficialLineup(env, gameId, now, { phase: isFinalPhase ? "final" : "provisional" });
      if (result.status === "provisional") {
        summary.provisionalCaptured += 1;
        await recordWorkflowLog(env.AUTH_DB, {
          eventType: "lineup_fetch",
          status: "success",
          gameId,
          occurredAt: now,
          message: "仮スタメンを取得しました。",
          metadata: { phase: "provisional", playerCount: Array.isArray(result.lineup) ? result.lineup.length : null },
          source: "cron"
        });
        console.log(`[GAME_WORKFLOW] gameId=${gameId} step=lineup action=executed status=provisional`);
      } else {
        summary.lineupCaptured += 1;
        if (isFinalPhase) summary.finalLineupCaptured += 1;
        await recordWorkflowLog(env.AUTH_DB, {
          eventType: isFinalPhase ? "final_lineup_fetch" : "lineup_fetch",
          status: "success",
          gameId,
          occurredAt: now,
          message: isFinalPhase ? "最終スタメンを取得しました。" : "実スタメンを取得しました。",
          metadata: { phase: isFinalPhase ? "final" : "provisional", playerCount: Array.isArray(result.lineup) ? result.lineup.length : null },
          source: "cron"
        });
        console.log(`[GAME_WORKFLOW] gameId=${gameId} step=${isFinalPhase ? "final_lineup" : "lineup"} action=executed status=success`);
      }
    } catch (error) {
      const isFinalPhase = now >= (timeline.finalLineupFetchAt || new Date(timeline.startAt.getTime() + 60 * 1000));
      if (isFinalPhase) {
        try {
          const fallback = await useProvisionalLineupFallback(env, gameId, timeline, now, error);
          if (fallback.used) {
            summary.lineupCaptured += 1;
            summary.finalLineupFallbackUsed += 1;
            await recordGameWorkflowOutcome(env.AUTH_DB, gameId, "final_lineup", "fallback", error, now);
            await recordWorkflowLog(env.AUTH_DB, {
              eventType: "lineup_fallback",
              status: "warning",
              gameId,
              occurredAt: now,
              message: "最終取得失敗・直前取得データを使用しました。",
              errorCode: fallback.errorCode,
              metadata: {
                phase: "final",
                fallbackUsed: true,
                playerCount: parseStoredActualLineup(fallback.record?.actual_lineup_json)?.length || null,
                rawErrorCode: String(error?.code || "LINEUP_FETCH_FAILED"),
                upstreamStatus: Number(error?.upstreamStatus || 0) || null,
                externalStatus: Number(error?.externalStatus || 0) || null,
                upstreamUrl: error?.upstreamUrl || null
              },
              source: "cron"
            });
            console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=final_lineup action=fallback status=success code=${fallback.errorCode}`);
            continue;
          }
        } catch (fallbackError) {
          console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=final_lineup action=fallback status=failed code=${fallbackError?.code || "LINEUP_FALLBACK_FAILED"}`);
        }
      }
      summary.lineupFailed += 1;
      await recordGameWorkflowOutcome(env.AUTH_DB, gameId, "lineup", "failed", error, now);
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: isFinalPhase ? "final_lineup_fetch" : "lineup_fetch",
        status: "error",
        gameId,
        occurredAt: now,
        message: isFinalPhase ? "最終スタメンを取得できず、採点を見送りました。" : "実スタメンを取得できませんでした。",
        errorCode: classifyLineupErrorCode(error),
        metadata: {
          phase: isFinalPhase ? "final" : "provisional",
          fallbackUsed: false,
          rawErrorCode: String(error?.code || "LINEUP_FETCH_FAILED"),
          upstreamStatus: Number(error?.upstreamStatus || 0) || null,
          externalStatus: Number(error?.externalStatus || 0) || null,
          upstreamUrl: error?.upstreamUrl || null
        },
        source: "cron"
      });
      console.warn(`[GAME_WORKFLOW] gameId=${gameId} step=${isFinalPhase ? "final_lineup" : "lineup"} action=executed status=failed code=${error?.code || "unknown"} retryable=true`);
    }
  }
  return summary;
}

function makeGameProgressStatus(status, { completedAt = null, scheduledAt = null, detail = "", errorCode = "" } = {}) {
  return { status, completedAt, scheduledAt, detail, errorCode };
}

function latestProgressLog(logs, eventTypes, status = "") {
  const types = new Set(Array.isArray(eventTypes) ? eventTypes : [eventTypes]);
  return (Array.isArray(logs) ? logs : []).find((log) => types.has(log.eventType) && (!status || log.status === status)) || null;
}

function progressLogHasCurrentError(logs, failureTypes, successTypes = []) {
  const failure = latestProgressLog(logs, failureTypes, "error");
  if (!failure) return false;
  const success = latestProgressLog(logs, successTypes, "success");
  if (!success) return true;
  return new Date(failure.occurredAt).getTime() > new Date(success.occurredAt).getTime();
}

export function deriveGameProgressStatuses({
  gameId = "",
  game = null,
  schedule = null,
  probableStarter = null,
  lineup = null,
  scoring = null,
  ranking = null,
  logs = [],
  now = new Date(),
  scheduleSource = "",
  checkedScheduleSources = []
} = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const startAt = schedule?.startAt ? new Date(schedule.startAt) : null;
  const deadlineAt = schedule?.predictionDeadlineAt ? new Date(schedule.predictionDeadlineAt) : null;
  const lineupAt = schedule?.lineupFetchStartAt ? new Date(schedule.lineupFetchStartAt) : null;
  const releaseAt = schedule?.resultReleaseAt ? new Date(schedule.resultReleaseAt) : null;
  const validDate = (value) => value && !Number.isNaN(value.getTime());
  const deadlineUnavailableDetail = scheduleSource
    ? `締切時刻を取得できません（確認済み: ${[...new Set([scheduleSource, ...checkedScheduleSources])].join(", ")}）`
    : "締切時刻を取得できません";
  const probableError = probableStarter?.status === "error"
    || progressLogHasCurrentError(logs, ["probable_starter_fetch_failed"], ["probable_starter_announced"]);
  const lineupError = lineup?.status === "failed"
    || progressLogHasCurrentError(logs, ["lineup_fetch", "final_lineup_fetch"], ["lineup_fetch", "final_lineup_fetch"]);
  const scoringError = scoring?.status === "failed"
    || progressLogHasCurrentError(logs, ["scoring_failed"], ["scoring_succeeded"]);
  const rankingError = progressLogHasCurrentError(logs, ["ranking_reflected"], ["ranking_reflected"]);
  const publishError = scoring?.publicationStatus === "failed"
    || progressLogHasCurrentError(logs, ["result_publish_failed"], ["result_published"]);
  const probableSuccess = probableStarter?.status === "announced";
  const lineupSuccess = Boolean(lineup?.detectedAt) || lineup?.status === "captured";
  const scoringSuccess = scoring?.status === "scored";
  const rankingSuccess = ranking?.isRankingEligible === true || latestProgressLog(logs, ["ranking_reflected"], "success") !== null;
  const publicationSuccess = scoring?.publicationStatus === "published" || ranking?.publicationStatus === "published";
  const progressErrorResolved = (log) => {
    const successTypes = {
      probable_starter_fetch_failed: ["probable_starter_announced"],
      lineup_fetch: ["lineup_fetch", "final_lineup_fetch"],
      final_lineup_fetch: ["lineup_fetch", "final_lineup_fetch"],
      scoring_failed: ["scoring_succeeded"],
      result_publish_failed: ["result_published"],
      ranking_reflected: ["ranking_reflected"]
    }[log.eventType] || [];
    return successTypes.some((eventType) => (Array.isArray(logs) ? logs : []).some((candidate) => candidate.status === "success"
      && candidate.eventType === eventType
      && new Date(candidate.occurredAt).getTime() > new Date(log.occurredAt).getTime()));
  };
  const errors = (Array.isArray(logs) ? logs : [])
    .filter((log) => log.status === "error" && !progressErrorResolved(log))
    .slice(0, 5)
    .map((log) => ({ eventType: log.eventType, occurredAt: log.occurredAt, message: log.message, errorCode: log.errorCode || "" }));

  const statuses = {
    targetSelected: makeGameProgressStatus(gameId ? "completed" : "error", { detail: gameId ? "管理対象gameIdを取得済み" : "対象試合なし" }),
    probableStarter: makeGameProgressStatus(probableError ? "error" : probableSuccess ? "completed" : "waiting", {
      completedAt: probableSuccess ? (probableStarter.announcedAt || probableStarter.fetchedAt) : null,
      scheduledAt: startAt?.toISOString() || null,
      detail: probableSuccess ? `${probableStarter.home_pitcher_name || probableStarter.homePitcherName || ""} / ${probableStarter.away_pitcher_name || probableStarter.awayPitcherName || ""}`.replace(/^\s*\/\s*|\s*\/\s*$/g, "") : "発表待ち",
      errorCode: probableStarter?.error_code || probableStarter?.errorCode || (probableError ? "PROBABLE_STARTER_FETCH_FAILED" : "")
    }),
    predictionOpen: !validDate(deadlineAt) ? makeGameProgressStatus("error", { detail: deadlineUnavailableDetail, errorCode: "PREDICTION_DEADLINE_UNAVAILABLE" }) : current < deadlineAt
      ? makeGameProgressStatus("completed", { detail: "受付中" })
      : makeGameProgressStatus("out_of_scope", { completedAt: deadlineAt.toISOString(), detail: "締切済み" }),
    predictionClosed: !validDate(deadlineAt) ? makeGameProgressStatus("error", { detail: deadlineUnavailableDetail, errorCode: "PREDICTION_DEADLINE_UNAVAILABLE" }) : current >= deadlineAt
      ? makeGameProgressStatus("completed", { completedAt: deadlineAt.toISOString(), detail: "受付終了" })
      : makeGameProgressStatus("waiting", { scheduledAt: deadlineAt.toISOString(), detail: "締切前" }),
    lineupFetched: makeGameProgressStatus(lineupError ? "error" : lineupSuccess ? "completed" : validDate(lineupAt) && current < lineupAt ? "waiting" : "not_started", {
      completedAt: lineup?.detectedAt || null,
      scheduledAt: lineupAt?.toISOString() || null,
      detail: lineupSuccess ? "正式スタメン保存済み" : "取得待ち",
      errorCode: lineup?.finalLineupErrorCode || (lineupError ? "LINEUP_FETCH_FAILED" : "")
    }),
    scoringCompleted: makeGameProgressStatus(scoringError ? "error" : scoringSuccess ? "completed" : "waiting", {
      completedAt: scoring?.scoredAt || null,
      scheduledAt: scoring?.dueAt || (validDate(startAt) ? new Date(startAt.getTime() + 2 * 60 * 1000).toISOString() : null),
      detail: scoringSuccess ? "採点完了" : "採点待ち",
      errorCode: scoring?.lastError || (scoringError ? "SCORING_FAILED" : "")
    }),
    rankingUpdated: makeGameProgressStatus(rankingError ? "error" : rankingSuccess ? "completed" : scoringSuccess ? "waiting" : "not_started", {
      completedAt: ranking?.rankingEligibleAt || latestProgressLog(logs, ["ranking_reflected"], "success")?.occurredAt || null,
      detail: rankingSuccess ? "ランキング反映済み" : "採点後に反映"
    }),
    resultPublished: makeGameProgressStatus(publishError ? "error" : publicationSuccess ? "completed" : validDate(releaseAt) && current < releaseAt ? "waiting" : "not_started", {
      completedAt: scoring?.publishedAt || ranking?.publishedAt || null,
      scheduledAt: releaseAt?.toISOString() || null,
      detail: publicationSuccess ? "正式結果公開済み" : "公開待ち",
      errorCode: publishError ? "RESULT_PUBLISH_FAILED" : ""
    })
  };

  const timestamps = [
    ...Object.values(statuses).map((item) => item.completedAt),
    ...(Array.isArray(logs) ? logs.map((log) => log.occurredAt) : [])
  ].filter(Boolean).map((value) => new Date(value)).filter(validDate);
  const lastUpdatedAt = timestamps.length ? new Date(Math.max(...timestamps.map((value) => value.getTime()))).toISOString() : null;
  const latestError = errors[0] || null;
  statuses.errorState = makeGameProgressStatus(latestError ? "error" : "completed", {
    completedAt: latestError?.occurredAt || null,
    detail: latestError ? latestError.message : "エラーはありません",
    errorCode: latestError?.errorCode || ""
  });
  return { statuses, errors, lastUpdatedAt, game: game || null, scheduleSource, checkedScheduleSources };
}

const GAME_PROGRESS_TEAM_LABELS = Object.freeze({
  fighters: "日本ハム",
  marines: "ロッテ",
  buffaloes: "オリックス",
  hawks: "ソフトバンク",
  lions: "西武",
  eagles: "楽天",
  giants: "巨人",
  tigers: "阪神",
  baystars: "DeNA",
  carp: "広島",
  dragons: "中日",
  swallows: "ヤクルト"
});

function formatGameProgressTeam(value) {
  const text = String(value || "").trim();
  return GAME_PROGRESS_TEAM_LABELS[text.toLowerCase()] || text;
}

export function formatGameProgressLabel(game = {}) {
  if (String(game.matchupLabel || "").trim()) return String(game.matchupLabel).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(game.date || ""))
    ? String(game.date).replace(/-/g, "/")
    : String(game.date || "");
  const away = formatGameProgressTeam(game.awayTeam);
  const home = formatGameProgressTeam(game.homeTeam);
  return `${date} ${away}${away && home ? " vs " : ""}${home}`.trim();
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
  if (!gameId) {
    target = await getServerPredictionTarget(env.AUTH_DB, new Date());
    gameId = getValidGameId(target?.gameId);
  }
  if (!gameId) return jsonResponse({ ok: true, game: null, gameId: "", statuses: null, errors: [], updatedAt: null }, 200, cors);
  if (await isTestRankingGame(env.AUTH_DB, gameId)) {
    return jsonResponse({ ok: true, game: null, gameId: "", statuses: null, errors: [], updatedAt: null, excluded: "test_game" }, 200, cors);
  }
  try {
    const record = await getPregameAutomationStatus(env.AUTH_DB, gameId);
    const detectedGame = await getDetectedScheduleGame(env.AUTH_DB, gameId);
    const identity = getGameIdentityForPregame(gameId);
    const context = resolveGameProgressContext({
      gameId,
      target: target?.gameId === gameId ? target : null,
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
      metadata: { scheduleSource: context.scheduleSource, checkedScheduleSources: context.checkedScheduleSources }
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

export function deriveGameWorkflowProgress({ identity = null, job = null, lineup = null, notice = null, dailyNotice = null, now = new Date() } = {}) {
  const lineupError = lineup?.scoring_status === "failed" ? "SCORING_FAILED" : "";
  const lastErrorCode = String(job?.last_error_code || dailyNotice?.last_error_code || lineupError || "");
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

async function prepareGamePredictionScoring(db, gameId, actualLineup, isTestPrediction = 0) {
  const productionQuery = "SELECT id, user_id, prediction_json FROM predictions WHERE game_id = ?1 AND is_test_prediction = 0 ORDER BY submitted_at ASC, id ASC";
  const testQuery = "SELECT id, user_id, prediction_json FROM predictions WHERE game_id = ?1 AND is_test_prediction = 1 ORDER BY submitted_at ASC, id ASC";
  const rows = await db.prepare(isTestPrediction ? testQuery : productionQuery).bind(gameId).all();

  const outcomes = [];
  const validationErrors = [];
  const distribution = new Map();

  for (const row of rows?.results || []) {
    const prediction = parseStoredPrediction(row.prediction_json);
    const sanitized = prediction ? sanitizePredictionPayload(prediction) : { ok: false, error: "保存済み予想の形式が不正です。" };
    if (!sanitized.ok) {
      validationErrors.push(sanitized.error);
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
    failed: validationErrors.length,
    outcomes,
    validationErrors: Array.from(new Set(validationErrors)).slice(0, 10),
    averageScore: scored ? Number((totalScore / scored).toFixed(2)) : 0,
    perfectCount: outcomes.filter((outcome) => outcome.score.total === SCORING_MAX_SCORE).length,
    scoreDistribution: Object.fromEntries(
      Array.from(distribution.entries()).sort((left, right) => left[0] - right[0]).map(([score, count]) => [String(score), count])
    )
  };
}

async function handleAdminActualLineupSave(request, env, cors, gameId) {
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
    const record = await approveActualLineupForAutoScoring(env, gameId, actualResult.lineup, detectedAt, {
      scoringDueAt: detectedAt,
      now,
      source: "manual"
    });
    await recordWorkflowLog(env.AUTH_DB, {
      eventType: "admin_lineup_approved",
      status: "success",
      gameId,
      occurredAt: now,
      message: "管理者が正式スタメンを登録しました。",
      metadata: { source: "manual", playerCount: actualResult.lineup.length },
      source: "admin"
    });
    console.log(`auto scoring scheduled: game=${gameId} due=${record.scoring_due_at}`);
    return jsonResponse({
      ok: true,
      gameId,
      autoScoring: serializeGameLineup(record)
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
    source: row.source,
    createdAt: row.created_at,
    createdBy: row.created_by === null ? null : Number(row.created_by),
    reason: row.reason,
    isCurrent: Number(row.is_current) === 1,
    supersededAt: row.superseded_at || null
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
  const version = Number(current.version) + 1;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(
      "UPDATE game_lineup_revisions SET is_current = 0, superseded_at = ?1 WHERE game_id = ?2 AND is_current = 1"
    ).bind(now, metadata.gameId),
    db.prepare(
      `INSERT INTO game_lineup_revisions
         (game_id, version, actual_lineup_json, lineup_fingerprint, source, created_at, created_by, reason, is_current, superseded_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, NULL)`
    ).bind(metadata.gameId, version, JSON.stringify(actualLineup), fingerprint, source, now, userId, reason)
  ]);
  return getLineupRevision(db, metadata.gameId, version);
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
    await env.AUTH_DB.batch([
      env.AUTH_DB.prepare(
        `INSERT INTO game_rescore_previews
         (id, game_id, lineup_version, created_by, reason, summary_json, expected_prediction_count, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(previewId, metadata.gameId, version, user.id, reason, JSON.stringify(summary), summary.processed, previewExpiresAt.toISOString(), now.toISOString()),
      env.AUTH_DB.prepare(
        `INSERT INTO game_rescore_jobs (id, game_id, lineup_version, status, error_code, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'previewed', NULL, ?4, ?4)`
      ).bind(previewId, metadata.gameId, version, now.toISOString())
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

async function handleAdminRescoreConfirm(request, env, cors, metadata, user) {
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
    const result = await applyManualRescore(env.AUTH_DB, metadata, current, preview, user.id, reason, now);
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

async function applyManualRescore(db, metadata, revision, preview, userId, reason, now, isTestPrediction = 0) {
  const lineup = sanitizeActualLineupForScoring(parseStoredActualLineup(revision.actual_lineup_json));
  if (!lineup.ok) throw createPregameError("RESCORE_LINEUP_REQUIRED", lineup.error, { httpStatus: 409 });
  const gameLineup = await getGameLineup(db, metadata.gameId);
  if (!gameLineup || gameLineup.scoring_status === "processing") {
    throw createPregameError("RESCORE_LINEUP_REQUIRED", "この試合は現在再採点できません。", { httpStatus: 409 });
  }
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
  statements.push(db.prepare(
    `UPDATE game_lineups
        SET actual_lineup_json = ?1, lineup_fingerprint = ?2, lineup_detected_at = ?3,
            scoring_status = 'scored', scoring_started_at = NULL, scored_at = ?3,
            last_error = NULL, processed_predictions = ?4, perfect_count = ?5,
            new_perfect_achievers = ?5, lineup_source = 'manual-revision', updated_at = ?3
      WHERE game_id = ?6 AND scoring_status <> 'processing'`
  ).bind(actualLineupJson, revision.lineup_fingerprint, nowIso, scoring.processed, scoring.perfectCount, metadata.gameId));
  statements.push(db.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
        publication_status, scored_private_at, published_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'scored', ?5, ?6, ?7, ?4, ?7, ?7)
     ON CONFLICT(game_id) DO UPDATE SET
       game_date = excluded.game_date,
       is_ranking_eligible = excluded.is_ranking_eligible,
       ranking_eligible_at = excluded.ranking_eligible_at,
       game_status = 'scored',
       is_test_game = excluded.is_test_game,
       publication_status = excluded.publication_status,
       scored_private_at = excluded.scored_private_at,
       published_at = CASE WHEN excluded.publication_status = 'published' THEN excluded.published_at ELSE ranking_games.published_at END,
       updated_at = excluded.updated_at`
  ).bind(metadata.gameId, metadata.date, isTestPrediction ? 0 : (published ? 1 : 0), isTestPrediction ? 1 : 0, published ? "published" : "scored_private", published ? (gameLineup.published_at || nowIso) : null, nowIso));
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
  return {
    processed: scoring.processed,
    scored: scoring.scored,
    changedScoreCount,
    perfectCount: scoring.perfectCount,
    perfectCountDelta,
    scoredAt: nowIso,
    publicationStatus: published ? "published" : "scored_private"
  };
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
  const record = await saveActualLineupForAutoScoring(env.AUTH_DB, gameId, actualLineup, detectedAt, options);
  await markGameRankingPending(env.AUTH_DB, gameId, detectedAt, env, options.isTestGame ? 1 : 0);
  return record;
}

async function saveActualLineupForAutoScoring(db, gameId, actualLineup, detectedAt, options = {}) {
  if (!options.allowTestGame && !options.allowAfterStart) assertOfficialLineupSaveAllowed(gameId, options.now || new Date());
  const actualLineupJson = JSON.stringify(actualLineup);
  if (new TextEncoder().encode(actualLineupJson).byteLength > PREDICTION_MAX_JSON_BYTES) {
    throw new Error("actual lineup payload exceeds the allowed size");
  }
  const fingerprint = await sha256Base64Url(actualLineupJson);
  const existing = await getGameLineup(db, gameId);
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
       (id, game_id, actual_lineup_json, lineup_fingerprint, schema_version,
        lineup_detected_at, scoring_due_at, scoring_started_at, scored_at,
        scoring_status, scoring_attempts, last_error, processed_predictions,
        perfect_count, new_perfect_achievers, lineup_source, publication_status, published_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, 'pending', 0, NULL, NULL, NULL, NULL, ?8, 'pending', NULL, ?6, ?6)
     ON CONFLICT(game_id) DO UPDATE SET
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
  ).bind(id, gameId, actualLineupJson, fingerprint, PREDICTION_SCHEMA_VERSION, detectedAtIso, scoringDueAt, lineupSource).run();
  return await getGameLineup(db, gameId);
}

async function getGameLineup(db, gameId) {
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

async function runDueAutoScoringJobs(env, now, pausedGameIds = new Set()) {
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - AUTO_SCORING_PROCESSING_TIMEOUT_MS).toISOString();
  await env.AUTH_DB.prepare(
    `UPDATE game_lineups
        SET scoring_status = CASE WHEN scoring_attempts >= ?3 THEN 'failed' ELSE 'pending' END,
            scoring_started_at = NULL, scoring_due_at = ?1,
            last_error = '採点処理がタイムアウトしたため再試行します。', updated_at = ?1
      WHERE scoring_status = 'processing' AND scoring_started_at IS NOT NULL AND scoring_started_at <= ?2
        AND game_id NOT IN (SELECT game_id FROM ranking_games WHERE is_test_game = 1)
        AND game_id NOT IN (SELECT game_id FROM ranking_games WHERE game_status = 'service_unavailable')`
  ).bind(nowIso, staleBefore, AUTO_SCORING_MAX_ATTEMPTS).run();

  const pausedIds = [...pausedGameIds].filter(Boolean).slice(0, 100);
  const pausedFilter = pausedIds.length
    ? ` AND game_id NOT IN (${pausedIds.map((_, index) => `?${index + 3}`).join(", ")})`
    : "";
  const due = await env.AUTH_DB.prepare(
    `SELECT game_id FROM game_lineups
      WHERE scoring_status IN ('pending', 'failed')
        AND scoring_due_at <= ?1
        AND game_id NOT IN (SELECT game_id FROM ranking_games WHERE is_test_game = 1)
        AND game_id NOT IN (SELECT game_id FROM ranking_games WHERE game_status = 'service_unavailable')
        AND scoring_attempts < ?2${pausedFilter}

      ORDER BY scoring_due_at ASC, game_id ASC
      LIMIT ?${pausedIds.length + 3}`
  ).bind(nowIso, AUTO_SCORING_MAX_ATTEMPTS, ...pausedIds, AUTO_SCORING_CRON_BATCH_SIZE).all();

  if ((due?.results || []).length > 0) {
    console.log(`auto scoring cron started: due=${due.results.length}`);
  }

  const summary = { considered: (due?.results || []).length, processed: 0, succeeded: 0, failed: 0 };
  for (const row of due?.results || []) {
    let claimed = null;
    try {
      if (await isManualRescoreLocked(env.AUTH_DB, row.game_id)) {
        continue;
      }
      claimed = await claimGameLineupForScoring(env.AUTH_DB, row.game_id, now);
      if (!claimed) continue;
      summary.processed += 1;
      console.log(`auto scoring claimed: game=${claimed.game_id} attempt=${claimed.scoring_attempts}`);
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "scoring_started",
        status: "info",
        gameId: claimed.game_id,
        occurredAt: now,
        message: "採点を開始しました。",
        metadata: { attempt: claimed.scoring_attempts },
        source: "cron"
      });
      const result = await scoreClaimedGameLineup(env.AUTH_DB, claimed, now);
      await recordGameWorkflowOutcome(env.AUTH_DB, claimed.game_id, "score", "success", null, now);
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "scoring_succeeded",
        status: "success",
        gameId: claimed.game_id,
        occurredAt: now,
        message: "採点が完了しました。",
        metadata: { processed: result.processed, perfectCount: result.perfectCount },
        source: "cron"
      });
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "ranking_reflected",
        status: "success",
        gameId: claimed.game_id,
        occurredAt: now,
        message: "採点結果をランキング集計対象へ反映しました。",
        metadata: { processed: result.processed, perfectCount: result.perfectCount, publicationStatus: "scored_private" },
        source: "cron"
      });
      summary.succeeded += 1;
      console.log(`auto scoring complete: game=${claimed.game_id} processed=${result.processed} perfect=${result.perfectCount}`);
      console.log(`[GAME_WORKFLOW] gameId=${claimed.game_id} step=score action=executed status=success`);
    } catch (error) {
      summary.failed += 1;
      if (claimed) {
        await markGameLineupFailed(env.AUTH_DB, claimed.game_id, error, now);
        await recordGameWorkflowOutcome(env.AUTH_DB, claimed.game_id, "score", "failed", error, now);
        await recordWorkflowLog(env.AUTH_DB, {
          eventType: "scoring_failed",
          status: "error",
          gameId: claimed.game_id,
          occurredAt: now,
          message: "採点に失敗しました。",
          errorCode: String(error?.code || "SCORING_FAILED"),
          metadata: { attempt: claimed.scoring_attempts },
          source: "cron"
        });
        console.warn(`[GAME_WORKFLOW] gameId=${claimed.game_id} step=score action=executed status=failed code=${error?.code || "SCORING_FAILED"}`);
      } else {
        await recordGameWorkflowOutcome(env.AUTH_DB, row.game_id, "score", "failed", error, now);
        await recordWorkflowLog(env.AUTH_DB, {
          eventType: "scoring_failed",
          status: "error",
          gameId: row.game_id,
          occurredAt: now,
          message: "採点の開始に失敗しました。",
          errorCode: String(error?.code || "SCORING_FAILED"),
          source: "cron"
        });
        console.warn(`[GAME_WORKFLOW] gameId=${row.game_id} step=score action=executed status=failed code=${error?.code || "SCORING_FAILED"}`);
      }
    }
  }
  return summary;
}

async function scoreClaimedGameLineup(db, record, now, isTestPrediction = 0) {
  const storedLineup = parseStoredActualLineup(record.actual_lineup_json);
  const actualResult = sanitizeActualLineupForScoring(storedLineup);
  if (!actualResult.ok) {
    throw new Error(`stored actual lineup is invalid: ${actualResult.error}`);
  }
  const scoring = await prepareGamePredictionScoring(db, record.game_id, actualResult.lineup, isTestPrediction);
  if (scoring.failed > 0) {
    const error = new Error("stored predictions include validation errors");
    error.code = "prediction_validation_failed";
    error.processed = scoring.processed;
    error.failed = scoring.failed;
    error.validationErrors = scoring.validationErrors;
    throw error;
  }
  return await persistGamePredictionScoring(db, record.game_id, actualResult.lineup, scoring, now, isTestPrediction);
}

function parseStoredActualLineup(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function persistGamePredictionScoring(db, gameId, actualLineup, scoring, now, isTestPrediction = 0) {
  const scoredAt = now.toISOString();
  const actualLineupJson = JSON.stringify(actualLineup);
  const scoreSql = isTestPrediction
    ? `UPDATE predictions
        SET score = ?1, max_score = ?2, scored_at = ?3, status = 'scored', actual_lineup_json = ?4
      WHERE id = ?5 AND game_id = ?6 AND is_test_prediction = 1`
    : `UPDATE predictions
        SET score = ?1, max_score = ?2, scored_at = ?3, status = 'scored', actual_lineup_json = ?4
      WHERE id = ?5 AND game_id = ?6`;
  const statements = scoring.outcomes.map((outcome) => db.prepare(scoreSql).bind(outcome.score.total, SCORING_MAX_SCORE, scoredAt, actualLineupJson, outcome.id, gameId));
  statements.push(db.prepare(
    `UPDATE game_lineups
        SET scoring_status = 'scored', scored_at = ?1, scoring_started_at = NULL,
            last_error = NULL, processed_predictions = ?2, perfect_count = ?3,
            new_perfect_achievers = ?4, updated_at = ?1
      WHERE game_id = ?5 AND scoring_status = 'processing'`
  ).bind(scoredAt, scoring.processed, scoring.perfectCount, 0, gameId));
  const rankingStatement = createGameRankingScoredPrivateStatement(db, gameId, scoredAt);
  const effectiveRankingStatement = isTestPrediction
    ? createGameRankingScoredPrivateStatement(db, gameId, scoredAt, 1)
    : rankingStatement;
  if (isTestPrediction && effectiveRankingStatement) {
    statements.push(effectiveRankingStatement);
  } else if (rankingStatement) {
    statements.push(rankingStatement);
  }

  const results = await db.batch(statements);
  const predictionResults = results.slice(0, scoring.outcomes.length);
  if (predictionResults.some((result) => Number(result?.meta?.changes || 0) !== 1)) {
    throw new Error("prediction score update count mismatch");
  }
  const gameLineupResult = results[scoring.outcomes.length];
  if (Number(gameLineupResult?.meta?.changes || 0) !== 1) {
    throw new Error("game lineup scoring state update mismatch");
  }
  if (effectiveRankingStatement && Number(results[results.length - 1]?.meta?.changes || 0) !== 1) {
    throw new Error("game ranking private state update mismatch");
  }

  return {
    processed: scoring.processed,
    scored: scoring.scored,
    failed: 0,
    maxScore: SCORING_MAX_SCORE,
    perfectCount: scoring.perfectCount,
    newPerfectAchievers: 0,
    scoredAt
  };
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
async function markGameRankingPending(db, gameId, at, env, isTestGame = 0) {
  const metadata = parsePredictionGameId(gameId);
  if (!metadata) return;
  const now = toIsoString(at);
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

function createGameRankingScoredPrivateStatement(db, gameId, scoredAt, isTestGame = 0) {
  const metadata = parsePredictionGameId(gameId);
  if (!metadata) return null;
  const now = toIsoString(scoredAt);
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

async function markGameRankingScoredPrivate(db, gameId, scoredAt, env, isTestGame = 0) {
  const statement = createGameRankingScoredPrivateStatement(db, gameId, scoredAt, isTestGame);
  if (statement) await statement.run();
}

async function runDueGameDayPublicationJobs(env, now, timelines = getPregameTimelines()) {
  const summary = { considered: 0, published: 0, skipped: 0, failed: 0 };
  for (const timeline of timelines) {
    if (now < timeline.resultReleaseAt) continue;
    try {
      if (await isServiceUnavailableGame(env.AUTH_DB, timeline.gameId)) {
        summary.skipped += 1;
        continue;
      }
      if (await isManualRescoreLocked(env.AUTH_DB, timeline.gameId)) {
        summary.skipped += 1;
        continue;
      }
      const lineup = await getGameLineup(env.AUTH_DB, timeline.gameId);
      if (!lineup || lineup.scoring_status !== "scored") {
        summary.skipped += 1;
        continue;
      }
      if (lineup.publication_status === "published") continue;
      summary.considered += 1;
      const result = await publishScoredGameResults(env, timeline.gameId, now);
      if (result.published) {
        summary.published += 1;
        await recordWorkflowLog(env.AUTH_DB, {
          eventType: "result_published",
          status: "success",
          gameId: timeline.gameId,
          occurredAt: now,
          message: "正式結果を公開しました。",
          metadata: { publishedAt: result.publishedAt || now.toISOString() },
          source: "cron"
        });
        await recordWorkflowLog(env.AUTH_DB, {
          eventType: "ranking_reflected",
          status: "success",
          gameId: timeline.gameId,
          occurredAt: now,
          message: "公開結果をランキングへ反映しました。",
          metadata: { publicationStatus: "published" },
          source: "cron"
        });
        console.log(`[GAME_WORKFLOW] gameId=${timeline.gameId} step=publish action=executed status=success`);
      }
    } catch (error) {
      summary.failed += 1;
      await recordWorkflowLog(env.AUTH_DB, {
        eventType: "result_publish_failed",
        status: "error",
        gameId: timeline.gameId,
        occurredAt: now,
        message: "正式結果の公開に失敗しました。",
        errorCode: String(error?.code || "RESULT_PUBLISH_FAILED"),
        source: "cron"
      });
      console.warn(`[GAME_WORKFLOW] gameId=${timeline.gameId} step=publish action=executed status=failed code=${error?.code || "unknown"}`);
    }
  }
  return summary;
}

async function publishScoredGameResults(env, gameId, now) {
  try {
    const result = await publishGameResults(env, gameId, now);
    if (result.published) {
      await recordGameWorkflowOutcome(env.AUTH_DB, gameId, "publish", "success", null, now);
    }
    return result;
  } catch (error) {
    await recordGameWorkflowOutcome(env.AUTH_DB, gameId, "publish", "failed", error, now);
    throw error;
  }
}

async function publishGameResults(env, gameId, now, { isTestGame = false } = {}) {
  const testGame = isTestGame ? await getAutoScoringTest(env.AUTH_DB, gameId) : null;
  if (!isTestGame && await isServiceUnavailableGame(env.AUTH_DB, gameId)) {
    return { published: false, status: SERVICE_UNAVAILABLE_GAME_STATUS, publishedAt: null };
  }
  const identity = getGameIdentityForPregame(gameId);
  if (!isTestGame) {
    if (!identity) throw createPregameError("SCHEDULE_UNAVAILABLE", "試合日程を確認できません。");
    if (now < identity.resultReleaseAt) return { published: false, status: "not_due", publishedAt: null };
  } else if (!testGame) {
    throw createPregameError("TEST_GAME_NOT_FOUND", "自動採点テストが見つかりません。");
  }
  const lineup = await getGameLineup(env.AUTH_DB, gameId);
  if (!lineup || lineup.scoring_status !== "scored") {
    return { published: false, status: "not_ready", publishedAt: null };
  }
  if (lineup.publication_status === "published") {
    return { published: false, status: "already_published", publishedAt: lineup.published_at || null };
  }

  await markGameRankingScoredPrivate(env.AUTH_DB, gameId, lineup.scored_at || now.toISOString(), env, isTestGame ? 1 : 0);
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
      WHERE game_id = ?3 AND scoring_status = 'scored' AND publication_status <> 'published'`
  ).bind(publishedAt, (perfectRows.results || []).length, gameId));
  const results = await env.AUTH_DB.batch(statements);
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
}

function toSafeAutoScoringError(error) {
  const message = error instanceof Error ? error.message : "unknown error";
  return message.slice(0, 180);
}

function sanitizeActualLineupForScoring(value) {
  return sanitizeScoringLineup(value, "実スタメン");
}

function sanitizeScoringLineup(value, label) {
  if (!Array.isArray(value) || value.length !== SCORING_LINEUP_SIZE) {
    return { ok: false, error: `${label}は9人分入力してください。` };
  }

  const lineup = value.map((item) => {
    const battingOrder = Number(item?.battingOrder ?? item?.order);
    const teamCode = typeof item?.teamCode === "string" ? item.teamCode.trim().toLowerCase() : "";
    const teamId = typeof item?.teamId === "string" ? item.teamId : "";
    const uniformNumber = item?.uniformNumber;
    const playerId = typeof item?.playerId === "string" ? item.playerId : "";
    const playerName = typeof item?.playerName === "string" ? item.playerName.trim().slice(0, 40) : "";
    const position = normalizeScoringPosition(item?.position);
    return { battingOrder, teamCode, teamId, uniformNumber, playerId, playerName, position };
  });

  if (lineup.some((item) => !Number.isInteger(item.battingOrder) || item.battingOrder < 1 || item.battingOrder > SCORING_LINEUP_SIZE)) {
    return { ok: false, error: `${label}の打順は1番から9番までで入力してください。` };
  }
  if (new Set(lineup.map((item) => item.battingOrder)).size !== SCORING_LINEUP_SIZE) {
    return { ok: false, error: `${label}の打順が重複しています。` };
  }
  if (lineup.some((item) => !item.playerName || !item.playerId)) {
    return { ok: false, error: `${label}の選手情報が不足しています。` };
  }
  if (lineup.some((item) => !item.position || !PREDICTION_POSITIONS.has(item.position))) {
    return { ok: false, error: `${label}の守備位置が不正です。` };
  }
  if (hasDuplicateNonDhPositions(lineup)) {
    return { ok: false, error: `${label}に同じ守備位置が複数あります。` };
  }

  for (const item of lineup) {
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
  if (new Set(lineup.map((item) => item.playerId)).size !== SCORING_LINEUP_SIZE) {
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

async function handleGetCurrentPrediction(request, env, cors) {
  const session = await getSessionUser(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "予想を確認するにはログインしてください。" }, 401, cors);
  }

  const metadata = await resolvePredictionGameMetadata(
    env.AUTH_DB,
    new URL(request.url).searchParams.get("gameId")
  );
  if (!metadata) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdが不正です。" }, 400, cors);
  }

  const testGame = await isTestRankingGame(env.AUTH_DB, metadata.gameId);
  const published = testGame ? false : await isGameResultsPublished(env.AUTH_DB, metadata.gameId, new Date());
  const row = testGame ? null : await getPredictionRow(env.AUTH_DB, session.id, metadata.gameId);
  if (!row) {
    return jsonResponse({
      ok: true,
      gameId: metadata.gameId,
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
  if (!identity || now < identity.resultReleaseAt) return false;
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
    return jsonResponse({ ok: false, error: "予想を保存するにはログインしてください。" }, 401, cors);
  }

  const input = await readJson(request);
  const metadata = await resolvePredictionGameMetadata(env.AUTH_DB, input?.gameId);
  if (!metadata) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdが不正です。" }, 400, cors);
  }

  const deadlineResponse = createPredictionDeadlineRejection(metadata, cors);
  if (deadlineResponse) {
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

  const existing = await getPredictionRow(env.AUTH_DB, session.id, metadata.gameId);
  if (existing && isPredictionLocked(existing)) {
    return jsonResponse({ ok: false, error: "この試合の予想受付は終了しています。" }, 409, cors);
  }

  const now = new Date().toISOString();
  const id = existing?.id || randomToken(16);
  // テスト予想は開発者専用エンドポイントだけが明示的に作成します。
  // 一般の予想保存でクライアント入力をテスト扱いにすることはありません。
  const isTestPrediction = 0;
  const result = await env.AUTH_DB.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version,
        game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, locked_at, status,
        score, max_score, scored_at, actual_lineup_json, is_test_prediction)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, NULL, 'submitted', NULL, NULL, NULL, NULL, ?12)
     ON CONFLICT(user_id, game_id) DO UPDATE SET
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
    metadata.gameId,
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
    const current = await getPredictionRow(env.AUTH_DB, session.id, metadata.gameId);
    if (current && isPredictionLocked(current)) {
      return jsonResponse({ ok: false, error: "この試合の予想受付は終了しています。" }, 409, cors);
    }
    return jsonResponse({ ok: false, error: "予想の保存に失敗しました。" }, 409, cors);
  }

  const created = !existing;
  return jsonResponse({
    ok: true,
    gameId: metadata.gameId,
    created,
    updated: !created,
    status: "submitted",
    submittedAt: existing?.submitted_at || now,
    updatedAt: now
  }, 200, cors);
}

async function handleDeleteCurrentPrediction(request, env, cors) {
  const session = await getSessionUser(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "予想を削除するにはログインしてください。" }, 401, cors);
  }

  const metadata = await resolvePredictionGameMetadata(
    env.AUTH_DB,
    new URL(request.url).searchParams.get("gameId")
  );
  if (!metadata) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdが不正です。" }, 400, cors);
  }

  const deadlineResponse = createPredictionDeadlineRejection(metadata, cors);
  if (deadlineResponse) {
    return deadlineResponse;
  }

  const existing = await getPredictionRow(env.AUTH_DB, session.id, metadata.gameId);
  if (existing && isPredictionLocked(existing)) {
    return jsonResponse({ ok: false, error: "この試合の予想受付は終了しています。" }, 409, cors);
  }

  await env.AUTH_DB.prepare(
    "DELETE FROM predictions WHERE user_id = ?1 AND game_id = ?2"
  ).bind(session.id, metadata.gameId).run();
  return jsonResponse({ ok: true, gameId: metadata.gameId, deleted: Boolean(existing) }, 200, cors);
}

async function getPredictionRow(db, userId, gameId) {
  return db.prepare(
    `SELECT id, user_id, game_id, prediction_json, status,
            submitted_at, updated_at, locked_at, score, max_score, scored_at, actual_lineup_json
       FROM predictions
      WHERE user_id = ?1 AND game_id = ?2
      LIMIT 1`
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
  return PREDICTION_TEAM_SLUG_CODES[name] || "";
}

export async function resolvePredictionGameMetadata(db, value) {
  const parsed = parsePredictionGameId(value);
  if (!parsed) return null;

  let row = null;
  let scheduleTableAvailable = true;
  try {
    row = await db.prepare(
      `SELECT game_id, game_date, start_at, home_team, away_team, game_code, game_status
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
        `SELECT game_id, game_date, start_at, home_team, away_team, game_code, game_status
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
    return {
      ...parsed,
      gameId: String(row.game_id),
      date: row.game_date || parsed.date,
      homeCode,
      awayCode,
      opponentCode: homeCode === "f" ? awayCode : homeCode,
      isHome: homeCode === "f",
      startAt: row.start_at || "",
      gameCode: normalizeNpbGameCode(row.game_code) || parsePredictionGameId(row.game_id)?.gameCode || parsed.gameCode,
      game: { ...row, status: row.game_status }
    };
  }

  // 日程同期前にprediction-targetが静的日程を返しても、既知の試合だけは保存対象として解決します。
  const scheduled = findKnownPredictionSchedule(parsed);
  if (!scheduled) return null;
  const startAt = parseJstScheduleStart(scheduled);
  if (!startAt || Number.isNaN(startAt.getTime())) return null;
  return {
    ...parsed,
    gameId: scheduled.gameId,
    startAt: startAt.toISOString(),
    gameCode: parsePredictionGameId(scheduled.gameId)?.gameCode || parsed.gameCode,
    game: scheduled
  };
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

  const status = deadline.code === "PREDICTION_SCHEDULE_UNAVAILABLE" ? 503 : 409;
  return jsonResponse({
    ok: false,
    code: deadline.code,
    error: deadline.message,
    startAt: deadline.startAt || null,
    deadlineAt: deadline.deadlineAt || null
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
  const authenticated = await requireAuthenticatedUser(request, env, cors);
  if (!authenticated.ok) {
    return authenticated;
  }

  if (authenticated.user.role !== "admin") {
    return {
      ok: false,
      response: jsonResponse({ ok: false, admin: false, error: "管理者権限がありません。" }, 403, cors)
    };
  }

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
