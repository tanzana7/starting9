import { getPredictionDeadlineStatus } from "./prediction-deadline.js";
import {
  getDueLineupAttemptAt,
  getJstDateString,
  getNoticePollingPlan,
  getPregameTimeline,
  getPregameTimelines
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
const SCORING_LINEUP_SIZE = 9;
const SCORING_MAX_SCORE = 100;
const AUTO_SCORING_DEFAULT_DELAY_SECONDS = 300;
const AUTO_SCORING_MAX_DELAY_SECONDS = 24 * 60 * 60;
const AUTO_SCORING_MAX_ATTEMPTS = 3;
const AUTO_SCORING_CRON_BATCH_SIZE = 10;
const AUTO_SCORING_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const NPB_FETCH_WORKER_PRODUCTION_URL = "https://starting9-npb-fetch.tanzana7.workers.dev/";
const NPB_FETCH_TIMEOUT_MS = 15_000;
const ROSTER_MINIMUM_PLAYER_COUNT = 20;
const GAME_DAY_NOTICE_SOURCE = "https://npb.jp/announcement/roster/";
const GAME_DAY_NOTICE_STATUS = Object.freeze({
  WAITING: "waiting",
  DETECTED: "detected",
  CLOSED: "closed_without_notice",
  ERROR: "error"
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
      if (path === "/api/admin/me" && request.method === "GET") {
        return await handleAdminMe(request, env, cors);
      }
      if (path === "/api/admin/mode-capabilities" && request.method === "GET") {
        return await handleAdminModeCapabilities(request, env, cors);
      }
      const adminScoringRoute = parseAdminScoringRoute(path);
      if (adminScoringRoute) {
        return await handleAdminScoringRoute(request, env, cors, adminScoringRoute);
      }
      const adminTestRoute = parseAdminTestRoute(path);
      if (adminTestRoute) {
        return await handleAdminTestRoute(request, env, cors, adminTestRoute);
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

async function runScheduledGameAutomation(env, now) {
  let pregame = null;
  let scoring = null;
  try {
    pregame = await runDueGameDayScheduleJobs(env, now);
  } catch (error) {
    console.error(`game-day schedule cron failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  try {
    const lineup = await runDuePregameAutomationJobs(env, now);
    pregame = { ...(pregame || {}), lineup };
  } catch (error) {
    console.error(`pregame automation cron failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  try {
    scoring = await runDueAutoScoringJobs(env, now);
  } catch (error) {
    console.error(`auto scoring cron failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  try {
    const published = await runDueGameDayPublicationJobs(env, now);
    scoring = { ...(scoring || {}), published };
  } catch (error) {
    console.error(`game-day publication cron failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return { pregame, scoring };
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

async function handleMyAchievements(request, env, cors) {
  const access = await requireAuthenticatedUser(request, env, cors);
  if (!access.ok) return access.response;
  const achievements = await getUserAchievements(env.AUTH_DB, access.user.id);
  return jsonResponse({ ok: true, achievements: achievements.map(toPublicAchievement) }, 200, cors);
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
  const match = /^\/api\/admin\/games\/([^/]+)\/(predictions\/(?:summary|score-predictions(?:\/preview)?)|actual-lineup|auto-scoring\/(?:status|run-now|retry|cancel)|pregame-automation\/(?:run-roster|run-lineup|run-notice|distribute-notice|fix-roster|publish))$/.exec(path);
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

  if (route.action === "summary" && request.method === "GET") {
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
  if (route.action === "auto-scoring/status" && request.method === "GET") {
    return await handleAdminAutoScoringStatus(env, cors, metadata.gameId);
  }
  if (route.action === "auto-scoring/run-now" && request.method === "POST") {
    return await handleAdminAutoScoringRunNow(env, cors, metadata.gameId);
  }
  if (route.action === "auto-scoring/retry" && request.method === "POST") {
    return await handleAdminAutoScoringRetry(env, cors, metadata.gameId);
  }
  if (route.action === "auto-scoring/cancel" && request.method === "POST") {
    return await handleAdminAutoScoringCancel(env, cors, metadata.gameId);
  }
  if (route.action === "pregame-automation/run-roster" && request.method === "POST") {
    return await handleAdminPregameRosterCapture(env, cors, metadata.gameId);
  }
  if (route.action === "pregame-automation/run-lineup" && request.method === "POST") {
    return await handleAdminPregameLineupCapture(env, cors, metadata.gameId);
  }
  if (route.action === "pregame-automation/run-notice" && request.method === "POST") {
    const result = await runGameDayNoticeOnce(env, new Date(), metadata.gameId);
    return jsonResponse({ ok: true, gameId: metadata.gameId, result, pregame: await getPregameAutomationStatus(env.AUTH_DB, metadata.gameId) }, 200, cors);
  }
  if (route.action === "pregame-automation/distribute-notice" && request.method === "POST") {
    const result = await distributeStoredGameDayNotice(env, metadata.gameId, new Date());
    return jsonResponse({ ok: true, gameId: metadata.gameId, result, pregame: await getPregameAutomationStatus(env.AUTH_DB, metadata.gameId) }, 200, cors);
  }
  if (route.action === "pregame-automation/fix-roster" && request.method === "POST") {
    const result = await fixGameRosterAtDeadline(env, metadata.gameId, new Date());
    return jsonResponse({ ok: true, gameId: metadata.gameId, result, pregame: await getPregameAutomationStatus(env.AUTH_DB, metadata.gameId) }, 200, cors);
  }
  if (route.action === "pregame-automation/publish" && request.method === "POST") {
    const result = await publishGameResults(env, metadata.gameId, new Date());
    return jsonResponse({ ok: true, gameId: metadata.gameId, result, pregame: await getPregameAutomationStatus(env.AUTH_DB, metadata.gameId) }, 200, cors);
  }

  return jsonResponse({ ok: false, error: "管理者採点APIのHTTPメソッドが不正です。" }, 405, cors);
}

async function handleAdminPregameRosterCapture(env, cors, gameId) {
  const result = await captureGameRosterSnapshot(env, gameId, new Date(), { force: true });
  return jsonResponse({ ok: true, gameId, result, pregame: await getPregameAutomationStatus(env.AUTH_DB, gameId) }, 200, cors);
}

async function handleAdminPregameLineupCapture(env, cors, gameId) {
  const result = await captureOfficialLineup(env, gameId, new Date(), { force: true });
  return jsonResponse({ ok: true, gameId, result, pregame: await getPregameAutomationStatus(env.AUTH_DB, gameId) }, 200, cors);
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

async function runDueGameDayScheduleJobs(env, now) {
  const timelines = getPregameTimelines();
  const plan = getNoticePollingPlan(timelines, now);
  if (!plan.date) return { notice: { due: false }, rosterFixed: 0 };
  await ensureGameDayNoticeRows(env.AUTH_DB, timelines, plan.date, now);
  let notice = { due: plan.due, skipped: true, slotKey: plan.slotKey };
  if (plan.due && await claimGameDayNoticeSlot(env.AUTH_DB, plan.date, plan.slotKey, now)) {
    try {
      notice = await runGameDayNoticeOnce(env, now);
    } catch (error) {
      await recordGameDayNoticeError(env.AUTH_DB, plan.date, error, now);
      notice = { due: true, status: "error", errorCode: String(error?.code || "NOTICE_FETCH_FAILED") };
      console.error(`game-day notice failed: date=${plan.date} code=${error?.code || "unknown"}`);
    }
  }
  const rosterFixed = await fixDueGameRosters(env, timelines, now);
  return { notice, rosterFixed };
}

async function runGameDayNoticeOnce(env, now, requestedGameId = "") {
  const date = getJstDateString(now);
  await ensureGameDayNoticeRows(env.AUTH_DB, getPregameTimelines(), date, now);
  const payload = await fetchNpbWorkerJson(env, { mode: "notice", date });
  const noticeDate = String(payload.noticeDate || "");
  if (noticeDate !== date) throw createPregameError("NOTICE_DATE_MISMATCH", "NPB公示の日付を確認できませんでした。");
  console.log(`game-day notice fetched: date=${date} http=${payload.httpStatus || "unknown"} registered=${Number(payload.registeredCount || 0)} removed=${Number(payload.removedCount || 0)} hash=${String(payload.contentHash || "").slice(0, 12)}`);
  const stored = await storeGameDayNotice(env.AUTH_DB, payload, now);
  const applied = await applyGameDayNoticeToGames(env, date, payload, now);
  return {
    status: stored.status,
    date,
    slotKey: payload.contentHash || "",
    registeredCount: Number(payload.registeredCount || 0),
    removedCount: Number(payload.removedCount || 0),
    appliedGameIds: applied,
    requestedGameId: requestedGameId || null
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

async function storeGameDayNotice(db, payload, now) {
  const date = String(payload.noticeDate || "");
  const existing = await db.prepare("SELECT content_hash FROM game_day_notices WHERE notice_date = ?1 LIMIT 1").bind(date).first();
  if (existing?.content_hash && existing.content_hash === payload.contentHash) {
    return { status: "unchanged" };
  }
  await db.prepare(
    `INSERT INTO game_day_notices
       (notice_date, source_url, content_hash, fetched_at, registered_json, removed_json, rosters_json,
        registered_count, removed_count, status, last_error_code, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'success', NULL, ?4)
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
    JSON.stringify(payload.rosters && typeof payload.rosters === "object" ? payload.rosters : {}),
    Number(payload.registeredCount || 0),
    Number(payload.removedCount || 0)
  ).run();
  return { status: existing ? "updated" : "captured" };
}

async function applyGameDayNoticeToGames(env, date, payload, now) {
  const rows = await env.AUTH_DB.prepare(
    "SELECT * FROM game_day_notice_games WHERE notice_date = ?1"
  ).bind(date).all();
  const registrations = Array.isArray(payload.registrations) ? payload.registrations : [];
  const removals = Array.isArray(payload.removals) ? payload.removals : [];
  const applied = [];
  for (const row of rows.results || []) {
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
  for (const timeline of timelines) {
    if (now < timeline.predictionDeadlineAt || now > timeline.startAt) continue;
    const result = await fixGameRosterAtDeadline(env, timeline.gameId, now);
    if (result.status.startsWith("fixed")) fixed += 1;
  }
  return fixed;
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
  const gameCode = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(timeline.gameId)?.[1] || "";
  if (!/^[a-z0-9]+-[a-z0-9]+-\d+$/i.test(gameCode)) return null;
  return { ...timeline, gameCode: gameCode.toLowerCase() };
}

function getNpbFetchWorkerBaseUrl(env) {
  const value = String(env?.NPB_FETCH_WORKER_URL || NPB_FETCH_WORKER_PRODUCTION_URL).trim();
  try {
    const url = new URL(value);
    const isOfficialWorker = url.protocol === "https:" && url.hostname === "starting9-npb-fetch.tanzana7.workers.dev";
    const isLocal = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
    return (isOfficialWorker || isLocal) ? url : null;
  } catch {
    return null;
  }
}

async function fetchNpbWorkerJson(env, params) {
  const url = getNpbFetchWorkerBaseUrl(env);
  if (!url) throw createPregameError("NPB_WORKER_URL_INVALID", "NPB取得Workerの接続先が不正です。");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NPB_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { signal: controller.signal, headers: { "Cache-Control": "no-store" } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw createPregameError(payload?.code || "NPB_HTTP_ERROR", payload?.error || `NPB取得Worker HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error?.code) throw error;
    throw createPregameError(error?.name === "AbortError" ? "TIMEOUT" : "NPB_HTTP_ERROR", "NPB公式データを取得できませんでした。");
  } finally {
    clearTimeout(timer);
  }
}

function createPregameError(code, message) {
  const error = new Error(message);
  error.code = code;
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
  if (!Array.isArray(lineup) || lineup.length !== SCORING_LINEUP_SIZE) return { ok: false, error: "NPBのスタメン人数が9人ではありません。" };
  const result = [];
  for (const row of lineup) {
    const player = findFightersPlayerByName(row?.playerName);
    const battingOrder = Number(row?.order);
    const position = normalizePosition(row?.position);
    if (!player || !Number.isInteger(battingOrder) || battingOrder < 1 || battingOrder > 9 || !position) {
      return { ok: false, error: "NPBの選手名または守備位置を選手マスタへ安全に照合できません。" };
    }
    result.push({
      playerId: createFightersPlayerId(player.uniformNumber),
      teamId: FIGHTERS_TEAM_ID,
      teamCode: FIGHTERS_TEAM_CODE,
      uniformNumber: player.uniformNumber,
      playerName: player.name,
      battingOrder,
      position
    });
  }
  const sanitized = sanitizeActualLineupForScoring(result);
  return sanitized.ok ? { ok: true, lineup: sanitized.lineup } : sanitized;
}

async function ensurePregameAutomationRow(db, identity, now) {
  const nowIso = now.toISOString();
  await db.prepare(
    `INSERT INTO game_pregame_automation (game_id, game_date, start_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(game_id) DO UPDATE SET game_date = excluded.game_date, start_at = excluded.start_at, updated_at = excluded.updated_at`
  ).bind(identity.gameId, identity.game.date, identity.startAt.toISOString(), nowIso).run();
}

async function captureGameRosterSnapshot(env, gameId, now, { force = false } = {}) {
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
    return { status: "captured", playerCount: roster.length, capturedAt };
  } catch (error) {
    await recordPregameError(env.AUTH_DB, gameId, "roster", error, now);
    throw error;
  }
}

async function captureOfficialLineup(env, gameId, now, { force = false } = {}) {
  const identity = getGameIdentityForPregame(gameId);
  if (!identity) throw createPregameError("SCHEDULE_UNAVAILABLE", "試合日程を確認できません。");
  // 手動テストでも試合開始後のNPB内容を正式スタメンとして取り込まない。
  if (now.getTime() > identity.startAt.getTime()) return { status: "skipped_after_start" };
  await ensurePregameAutomationRow(env.AUTH_DB, identity, now);
  const existing = await getGameLineup(env.AUTH_DB, gameId);
  if (existing) return { status: existing.lineup_source === "manual" ? "manual_lineup_exists" : "already_captured" };
  try {
    const payload = await fetchNpbWorkerJson(env, { mode: "lineup", date: identity.game.date, gameCode: identity.gameCode });
    const actual = createOfficialLineupFromNpb(payload.lineup);
    if (!actual.ok) throw createPregameError("INVALID_LINEUP", actual.error);
    const detectedAt = new Date(payload.fetchedAt || now);
    const record = await saveActualLineupForAutoScoring(env.AUTH_DB, gameId, actual.lineup, detectedAt, {
      source: "npb-auto",
      scoringDueAt: detectedAt,
      preventOverwrite: true
    });
    await env.AUTH_DB.prepare(
      `UPDATE game_pregame_automation
          SET lineup_status = 'captured', lineup_captured_at = ?1, last_lineup_attempt_at = ?1,
              lineup_attempt_count = lineup_attempt_count + 1, next_lineup_attempt_at = NULL,
              last_error_code = NULL, last_error_message = NULL, updated_at = ?1
        WHERE game_id = ?2`
    ).bind(now.toISOString(), gameId).run();
    return { status: "captured", sourceUrl: payload.sourceUrl, autoScoring: serializeGameLineup(record) };
  } catch (error) {
    await recordPregameLineupAttempt(env.AUTH_DB, gameId, identity, now, error);
    throw error;
  }
}

async function recordPregameError(db, gameId, area, error, now) {
  const code = String(error?.code || "NPB_HTTP_ERROR").slice(0, 80);
  const message = String(error?.message || "取得に失敗しました。").slice(0, 240);
  const column = area === "roster" ? "roster_status" : "lineup_status";
  await db.prepare(
    `UPDATE game_pregame_automation SET ${column} = 'failed', last_error_code = ?1, last_error_message = ?2, updated_at = ?3 WHERE game_id = ?4`
  ).bind(code, message, now.toISOString(), gameId).run();
}

async function recordPregameLineupAttempt(db, gameId, identity, now, error) {
  const next = new Date(now.getTime() + 10 * 60 * 1000);
  await db.prepare(
    `UPDATE game_pregame_automation
        SET lineup_status = 'failed', lineup_attempt_count = lineup_attempt_count + 1, last_lineup_attempt_at = ?1,
            next_lineup_attempt_at = ?2, last_error_code = ?3, last_error_message = ?4, updated_at = ?1
      WHERE game_id = ?5`
  ).bind(now.toISOString(), next <= identity.startAt ? next.toISOString() : null, String(error?.code || "NPB_HTTP_ERROR").slice(0, 80), String(error?.message || "取得に失敗しました。").slice(0, 240), gameId).run();
}

async function runDuePregameAutomationJobs(env, now) {
  const summary = { lineupCaptured: 0, lineupFailed: 0 };
  for (const timeline of getPregameTimelines()) {
    const gameId = timeline.gameId;
    if (now < timeline.lineupFetchStartAt || now > timeline.startAt) continue;
    const currentLineup = await getGameLineup(env.AUTH_DB, gameId);
    if (currentLineup || now > timeline.startAt) continue;
    const dueAt = getDueLineupAttemptAt(timeline, now);
    if (!dueAt) continue;
    const job = await env.AUTH_DB.prepare("SELECT last_lineup_attempt_at FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1").bind(gameId).first();
    if (job?.last_lineup_attempt_at && new Date(job.last_lineup_attempt_at) >= dueAt) continue;
    try { await captureOfficialLineup(env, gameId, now); summary.lineupCaptured += 1; }
    catch (error) { summary.lineupFailed += 1; console.error(`pregame lineup failed: game=${gameId} code=${error?.code || "unknown"}`); }
  }
  return summary;
}

async function getPregameAutomationStatus(db, gameId) {
  const identity = getGameIdentityForPregame(gameId);
  const [job, snapshot, lineup, noticeResult, dailyNoticeResult] = await db.batch([
    db.prepare("SELECT * FROM game_pregame_automation WHERE game_id = ?1 LIMIT 1").bind(gameId),
    db.prepare("SELECT captured_at, player_count FROM game_roster_snapshots WHERE game_id = ?1 LIMIT 1").bind(gameId),
    db.prepare("SELECT lineup_source, lineup_detected_at, scoring_status, scoring_due_at, scored_at, publication_status, published_at FROM game_lineups WHERE game_id = ?1 LIMIT 1").bind(gameId),
    db.prepare("SELECT notice_status, registered_count, removed_count, last_checked_at, detected_at, roster_fixed_at, after_deadline_notice, last_error_code FROM game_day_notice_games WHERE game_id = ?1 LIMIT 1").bind(gameId),
    db.prepare("SELECT content_hash, fetched_at, source_url, last_slot_key, status, last_error_code FROM game_day_notices WHERE notice_date = ?1 LIMIT 1").bind(identity?.game?.date || "")
  ]);
  const notice = noticeResult?.results?.[0] || null;
  const dailyNotice = dailyNoticeResult?.results?.[0] || null;
  const nextNoticeAt = getNextGameDayNoticeAt(getPregameTimelines(), new Date());
  const nextAttempt = identity && !lineup?.results?.[0] ? getNextPregameLineupAttempt(identity, job?.results?.[0]?.last_lineup_attempt_at) : null;
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
      lineupFetchStartAt: identity.lineupFetchStartAt.toISOString(), resultReleaseAt: identity.resultReleaseAt.toISOString()
    } : null,
    roster: snapshot?.results?.[0] ? { status: "captured", capturedAt: snapshot.results[0].captured_at, playerCount: Number(snapshot.results[0].player_count), fixedAt: job?.results?.[0]?.roster_fixed_at || notice?.roster_fixed_at || null } : { status: job?.results?.[0]?.roster_status || "pending", fixedAt: job?.results?.[0]?.roster_fixed_at || notice?.roster_fixed_at || null },
    lineup: lineup?.results?.[0] ? { status: "captured", source: lineup.results[0].lineup_source, detectedAt: lineup.results[0].lineup_detected_at } : {
      status: job?.results?.[0]?.lineup_status || "pending", attempts: Number(job?.results?.[0]?.lineup_attempt_count || 0), lastAttemptAt: job?.results?.[0]?.last_lineup_attempt_at || null, nextAttemptAt: nextAttempt
    },
    scoring: lineup?.results?.[0] ? { status: lineup.results[0].scoring_status, dueAt: lineup.results[0].scoring_due_at, scoredAt: lineup.results[0].scored_at, publicationStatus: lineup.results[0].publication_status || "pending", publishedAt: lineup.results[0].published_at || null } : { status: job?.results?.[0]?.scoring_status || "pending", publicationStatus: "pending", publishedAt: null },
    publishing: lineup?.results?.[0] ? { status: lineup.results[0].publication_status || "pending", publishedAt: lineup.results[0].published_at || null } : { status: "pending", publishedAt: null },
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
    lastErrorCode: job?.results?.[0]?.last_error_code || dailyNotice?.last_error_code || ""
  };
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
  const input = await readJson(request);
  const actualResult = sanitizeActualLineupForScoring(input?.actualLineup);
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
    validationErrors: scoring.validationErrors
  }, 200, cors);
}

async function handleAdminScorePredictions(request, env, cors, gameId) {
  const input = await readJson(request);
  const actualResult = sanitizeActualLineupForScoring(input?.actualLineup);
  if (!actualResult.ok) {
    return jsonResponse({ ok: false, error: actualResult.error }, 400, cors);
  }

  // 手動採点も同じ実スタメン保存・採点コアを使い、Cronとの結果差を作りません。
  const scoringStartedAt = new Date();
  await markGameRankingPending(env.AUTH_DB, gameId, scoringStartedAt, env);
  await saveActualLineupForAutoScoring(env.AUTH_DB, gameId, actualResult.lineup, scoringStartedAt, {
    forceReschedule: true,
    delaySeconds: 0,
    source: "manual"
  });
  const claimed = await claimGameLineupForScoring(env.AUTH_DB, gameId, scoringStartedAt, { force: true });
  if (!claimed) {
    return jsonResponse({ ok: false, error: "この試合は現在採点処理中です。" }, 409, cors);
  }

  try {
    const result = await scoreClaimedGameLineup(env.AUTH_DB, claimed, new Date());
    await markGameRankingScoredPrivate(env.AUTH_DB, gameId, result.scoredAt, env);
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

async function prepareGamePredictionScoring(db, gameId, actualLineup) {
  const rows = await db.prepare(
    "SELECT id, user_id, prediction_json FROM predictions WHERE game_id = ?1 AND is_test_prediction = 0 ORDER BY submitted_at ASC, id ASC"
  ).bind(gameId).all();
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

  const detectedAt = parseLineupDetectedAt(input?.lineupDetectedAt) || new Date();
  await markGameRankingPending(env.AUTH_DB, gameId, detectedAt, env);
  const record = await saveActualLineupForAutoScoring(env.AUTH_DB, gameId, actualResult.lineup, detectedAt, {
    scoringDueAt: detectedAt,
    source: "manual"
  });
  console.log(`auto scoring scheduled: game=${gameId} due=${record.scoring_due_at}`);
  return jsonResponse({
    ok: true,
    gameId,
    autoScoring: serializeGameLineup(record)
  }, 200, cors);
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
  const record = await getGameLineup(env.AUTH_DB, gameId);
  if (!record) {
    return jsonResponse({ ok: false, error: "先に実スタメンをサーバーへ保存してください。" }, 409, cors);
  }

  const now = new Date();
  await markGameRankingPending(env.AUTH_DB, gameId, now, env);
  const claimed = await claimGameLineupForScoring(env.AUTH_DB, gameId, now, { force: true, resetAttempts: true });
  if (!claimed) {
    return jsonResponse({ ok: false, error: "この試合は現在採点処理中です。" }, 409, cors);
  }

  try {
    const result = await scoreClaimedGameLineup(env.AUTH_DB, claimed, now);
    await markGameRankingScoredPrivate(env.AUTH_DB, gameId, result.scoredAt, env);
    return jsonResponse({ ok: true, gameId, ...result, autoScoring: serializeGameLineup(await getGameLineup(env.AUTH_DB, gameId)) }, 200, cors);
  } catch (error) {
    await markGameLineupFailed(env.AUTH_DB, gameId, error, now);
    throw error;
  }
}

async function handleAdminAutoScoringRetry(env, cors, gameId) {
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

async function saveActualLineupForAutoScoring(db, gameId, actualLineup, detectedAt, options = {}) {
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

async function runDueAutoScoringJobs(env, now) {
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - AUTO_SCORING_PROCESSING_TIMEOUT_MS).toISOString();
  await env.AUTH_DB.prepare(
    `UPDATE game_lineups
        SET scoring_status = CASE WHEN scoring_attempts >= ?3 THEN 'failed' ELSE 'pending' END,
            scoring_started_at = NULL, scoring_due_at = ?1,
            last_error = '採点処理がタイムアウトしたため再試行します。', updated_at = ?1
      WHERE scoring_status = 'processing' AND scoring_started_at IS NOT NULL AND scoring_started_at <= ?2`
  ).bind(nowIso, staleBefore, AUTO_SCORING_MAX_ATTEMPTS).run();

  const due = await env.AUTH_DB.prepare(
    `SELECT game_id FROM game_lineups
      WHERE scoring_status IN ('pending', 'failed')
        AND scoring_due_at <= ?1
        AND scoring_attempts < ?2
      ORDER BY scoring_due_at ASC, game_id ASC
      LIMIT ?3`
  ).bind(nowIso, AUTO_SCORING_MAX_ATTEMPTS, AUTO_SCORING_CRON_BATCH_SIZE).all();

  if ((due?.results || []).length > 0) {
    console.log(`auto scoring cron started: due=${due.results.length}`);
  }

  const summary = { considered: (due?.results || []).length, processed: 0, succeeded: 0, failed: 0 };
  for (const row of due?.results || []) {
    const claimed = await claimGameLineupForScoring(env.AUTH_DB, row.game_id, now);
    if (!claimed) {
      continue;
    }
    summary.processed += 1;
    try {
      console.log(`auto scoring claimed: game=${claimed.game_id} attempt=${claimed.scoring_attempts}`);
      const result = await scoreClaimedGameLineup(env.AUTH_DB, claimed, now);
      await markGameRankingScoredPrivate(env.AUTH_DB, claimed.game_id, result.scoredAt, env);
      summary.succeeded += 1;
      console.log(`auto scoring complete: game=${claimed.game_id} processed=${result.processed} perfect=${result.perfectCount}`);
    } catch (error) {
      summary.failed += 1;
      await markGameLineupFailed(env.AUTH_DB, claimed.game_id, error, now);
      console.error(`auto scoring failed: game=${claimed.game_id} reason=${toSafeAutoScoringError(error)}`);
    }
  }
  return summary;
}

async function scoreClaimedGameLineup(db, record, now) {
  const storedLineup = parseStoredActualLineup(record.actual_lineup_json);
  const actualResult = sanitizeActualLineupForScoring(storedLineup);
  if (!actualResult.ok) {
    throw new Error(`stored actual lineup is invalid: ${actualResult.error}`);
  }
  const scoring = await prepareGamePredictionScoring(db, record.game_id, actualResult.lineup);
  if (scoring.failed > 0) {
    const error = new Error("stored predictions include validation errors");
    error.code = "prediction_validation_failed";
    error.processed = scoring.processed;
    error.failed = scoring.failed;
    error.validationErrors = scoring.validationErrors;
    throw error;
  }
  return await persistGamePredictionScoring(db, record.game_id, actualResult.lineup, scoring, now);
}

function parseStoredActualLineup(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function persistGamePredictionScoring(db, gameId, actualLineup, scoring, now) {
  const scoredAt = now.toISOString();
  const actualLineupJson = JSON.stringify(actualLineup);
  const statements = scoring.outcomes.map((outcome) => db.prepare(
    `UPDATE predictions
        SET score = ?1, max_score = ?2, scored_at = ?3, status = 'scored', actual_lineup_json = ?4
      WHERE id = ?5 AND game_id = ?6`
  ).bind(outcome.score.total, SCORING_MAX_SCORE, scoredAt, actualLineupJson, outcome.id, gameId));
  statements.push(db.prepare(
    `UPDATE game_lineups
        SET scoring_status = 'scored', scored_at = ?1, scoring_started_at = NULL,
            last_error = NULL, processed_predictions = ?2, perfect_count = ?3,
            new_perfect_achievers = ?4, updated_at = ?1
      WHERE game_id = ?5 AND scoring_status = 'processing'`
  ).bind(scoredAt, scoring.processed, scoring.perfectCount, 0, gameId));

  const results = await db.batch(statements);
  const predictionResults = results.slice(0, scoring.outcomes.length);
  if (predictionResults.some((result) => Number(result?.meta?.changes || 0) !== 1)) {
    throw new Error("prediction score update count mismatch");
  }
  const gameLineupResult = results[results.length - 1];
  if (Number(gameLineupResult?.meta?.changes || 0) !== 1) {
    throw new Error("game lineup scoring state update mismatch");
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

function toIsoString(value) {
  if (typeof value === "string") return value;
  return value instanceof Date ? value.toISOString() : new Date().toISOString();
}

// テスト用として保存した試合は、正式なランキング分母へ登録しません。
async function markGameRankingPending(db, gameId, at, env) {
  const metadata = parsePredictionGameId(gameId);
  if (!metadata) return;
  const now = toIsoString(at);
  await db.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
        publication_status, scored_private_at, published_at, created_at, updated_at)
     VALUES (?1, ?2, 0, NULL, 'pending', 0, 'pending', NULL, NULL, ?3, ?3)
     ON CONFLICT(game_id) DO UPDATE SET
       game_date = excluded.game_date,
       is_ranking_eligible = 0,
       ranking_eligible_at = NULL,
       game_status = 'pending',
       is_test_game = 0,
       publication_status = 'pending',
       scored_private_at = NULL,
       published_at = NULL,
       updated_at = excluded.updated_at`
  ).bind(gameId, metadata.date, now).run();
}

async function markGameRankingScoredPrivate(db, gameId, scoredAt, env) {
  const metadata = parsePredictionGameId(gameId);
  if (!metadata) return;
  const now = toIsoString(scoredAt);
  await db.prepare(
    `INSERT INTO ranking_games
       (game_id, game_date, is_ranking_eligible, ranking_eligible_at, game_status, is_test_game,
        publication_status, scored_private_at, published_at, created_at, updated_at)
     VALUES (?1, ?2, 0, NULL, 'pending', 0, 'scored_private', ?3, NULL, ?3, ?3)
     ON CONFLICT(game_id) DO UPDATE SET
       game_date = excluded.game_date,
       is_ranking_eligible = 0,
       ranking_eligible_at = NULL,
       game_status = 'pending',
       is_test_game = 0,
       publication_status = 'scored_private',
       scored_private_at = excluded.scored_private_at,
       published_at = NULL,
       updated_at = excluded.updated_at`
  ).bind(gameId, metadata.date, now).run();
}

async function runDueGameDayPublicationJobs(env, now) {
  const summary = { considered: 0, published: 0, skipped: 0, failed: 0 };
  for (const timeline of getPregameTimelines()) {
    if (now < timeline.startAt) continue;
    const lineup = await getGameLineup(env.AUTH_DB, timeline.gameId);
    if (!lineup || lineup.scoring_status !== "scored") {
      summary.skipped += 1;
      continue;
    }
    if (lineup.publication_status === "published") continue;
    summary.considered += 1;
    try {
      const result = await publishGameResults(env, timeline.gameId, now);
      if (result.published) summary.published += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`game-day publication failed: game=${timeline.gameId} code=${error?.code || "unknown"}`);
    }
  }
  return summary;
}

async function publishGameResults(env, gameId, now) {
  const identity = getGameIdentityForPregame(gameId);
  if (!identity) throw createPregameError("SCHEDULE_UNAVAILABLE", "試合日程を確認できません。");
  if (now < identity.startAt) return { published: false, status: "not_due", publishedAt: null };
  const lineup = await getGameLineup(env.AUTH_DB, gameId);
  if (!lineup || lineup.scoring_status !== "scored") {
    return { published: false, status: "not_ready", publishedAt: null };
  }
  if (lineup.publication_status === "published") {
    return { published: false, status: "already_published", publishedAt: lineup.published_at || null };
  }

  await markGameRankingScoredPrivate(env.AUTH_DB, gameId, lineup.scored_at || now.toISOString(), env);
  const perfectRows = await env.AUTH_DB.prepare(
    `SELECT user_id, score, max_score
       FROM predictions
      WHERE game_id = ?1 AND is_test_prediction = 0
        AND status = 'scored' AND score = max_score`
  ).bind(gameId).all();
  const publishedAt = now.toISOString();
  const statements = [env.AUTH_DB.prepare(
    `UPDATE ranking_games
        SET is_ranking_eligible = 1, ranking_eligible_at = ?1, game_status = 'scored',
            publication_status = 'published', published_at = ?1, updated_at = ?1
      WHERE game_id = ?2 AND publication_status = 'scored_private'`
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

  const metadata = parsePredictionGameId(new URL(request.url).searchParams.get("gameId"));
  if (!metadata) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdが不正です。" }, 400, cors);
  }

  const published = await isGameResultsPublished(env.AUTH_DB, metadata.gameId, new Date());
  const row = await getPredictionRow(env.AUTH_DB, session.id, metadata.gameId);
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
  if (!identity || now < identity.startAt) return false;
  const row = await db.prepare(
    `SELECT is_ranking_eligible, publication_status
       FROM ranking_games WHERE game_id = ?1 LIMIT 1`
  ).bind(gameId).first();
  // 0010適用前の正式採点済み試合は、過去データとして引き続き表示します。
  return row?.publication_status === "published" || Number(row?.is_ranking_eligible || 0) === 1;
}

async function handlePutCurrentPrediction(request, env, cors) {
  const session = await getSessionUser(request, env);
  if (!session) {
    return jsonResponse({ ok: false, error: "予想を保存するにはログインしてください。" }, 401, cors);
  }

  const input = await readJson(request);
  const metadata = parsePredictionGameId(input?.gameId);
  if (!metadata) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdが不正です。" }, 400, cors);
  }

  const deadlineResponse = createPredictionDeadlineRejection(metadata.gameId, cors);
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

  const metadata = parsePredictionGameId(new URL(request.url).searchParams.get("gameId"));
  if (!metadata) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdが不正です。" }, 400, cors);
  }

  const deadlineResponse = createPredictionDeadlineRejection(metadata.gameId, cors);
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

function parsePredictionGameId(value) {
  const gameId = String(value || "").trim();
  const match = /^(\d{4}-\d{2}-\d{2})-([a-z]{1,2})-([a-z]{1,2})-(\d+)$/i.exec(gameId);
  if (!match) {
    return null;
  }

  const date = match[1];
  const homeCode = match[2].toLowerCase();
  const awayCode = match[3].toLowerCase();
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
    isHome
  };
}

function createPredictionDeadlineRejection(gameId, cors) {
  const deadline = getPredictionDeadlineStatus(gameId, new Date());
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
