import { isPredictionEligible } from "../game-scoring-ranking-v2.js";
import { AUTH_BRIDGE_AUDIENCE, sha256Base64Url, verifyAuthBridgeAssertion } from "../backend/auth-bridge.js";
import {
  LINEUP_SIZE,
  MAX_SCORE,
  POSITIONS,
  scoreLineup,
  validateLineup
} from "./scoring.js";

const SESSION_COOKIE = "s9_asia_cs_session";
const STARTING9_SESSION_COOKIE = "s9_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 100_000;
const MAX_BODY_BYTES = 32 * 1024;
const BEST_NINE_LIMIT = 9;
const COMPETITION_TYPE = "ASIA_CS";
const DEFAULT_COMPETITION_ID = "asia-cs";
const FORMAL_JOB_TYPES = Object.freeze(["prediction_close", "score", "ranking_rebuild", "publish"]);
const COMPETITION_STATUSES = Object.freeze(["draft", "active", "completed"]);
const PLAYER_POSITIONS = Object.freeze([...POSITIONS, "投"]);
const REGISTERED_POSITIONS = Object.freeze(["捕手", "内野手", "外野手"]);
const STARTING9_AUTH_ORIGIN = "https://starting9-auth.starting9.workers.dev";
const AUTH_UPSTREAM_TIMEOUT_MS = 4000;
const AUTH_DIAGNOSTIC_HEADER = "X-S9-Auth-Diagnostic-Id";
const AUTH_FAILURE_REASONS = Object.freeze({
  NONE: "NONE",
  EMPTY_SESSION_TOKEN: "EMPTY_SESSION_TOKEN",
  AUTH_ORIGIN_REJECTED: "AUTH_ORIGIN_REJECTED",
  AUTH_URL_INVALID: "AUTH_URL_INVALID",
  AUTH_FETCH_FAILED: "AUTH_FETCH_FAILED",
  AUTH_UPSTREAM_TIMEOUT: "AUTH_UPSTREAM_TIMEOUT",
  AUTH_UPSTREAM_NON_2XX: "AUTH_UPSTREAM_NON_2XX",
  AUTH_UPSTREAM_INVALID_JSON: "AUTH_UPSTREAM_INVALID_JSON",
  AUTH_UPSTREAM_ANONYMOUS: "AUTH_UPSTREAM_ANONYMOUS",
  AUTH_IDENTITY_INVALID: "AUTH_IDENTITY_INVALID"
});
const CANONICAL_TEST_USERS = Object.freeze(
  Array.from({ length: 9 }, (_, index) => `S9_TEST_${index + 1}`)
);
const APBC_PLACEMENT_GAME_DEFINITIONS = Object.freeze({
  final: Object.freeze({ gameNumber: "8", title: "決勝", startAt: "2026-11-15T10:00:00.000Z" }),
  third_place: Object.freeze({ gameNumber: "7", title: "3位決定戦", startAt: "2026-11-15T02:00:00.000Z" })
});
const APBC_PLACEMENT_DATE = "2026-11-15";
const DRYRUN_FIXTURE_ID = "apbc-switch-test-2026-10-16";
const DRYRUN_SOURCE_COMPETITION_ID = "apbc-2026";
const DRYRUN_SOURCE_GAME_ID = "apbc-2026-g2";
const DRYRUN_FIXTURE_TEAM_DEFINITIONS = Object.freeze([
  Object.freeze({ teamKey: "jpn", displayName: "日本", shortName: "JPN", countryCode: "JPN" }),
  Object.freeze({ teamKey: "kor", displayName: "韓国", shortName: "KOR", countryCode: "KOR" }),
  Object.freeze({ teamKey: "aus", displayName: "オーストラリア", shortName: "AUS", countryCode: "AUS" }),
  Object.freeze({ teamKey: "tpe", displayName: "チャイニーズ・タイペイ", shortName: "TPE", countryCode: "TPE" })
]);
const DRYRUN_FIXTURE_GAME_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "TEST1", title: "TEST1 日本 vs 韓国", gameDate: "2026-10-16", startAt: "2026-10-16T09:00:00.000Z", homeTeamId: "jpn", awayTeamId: "kor" }),
  Object.freeze({ id: "TEST2", title: "TEST2 オーストラリア vs 日本", gameDate: "2026-10-16", startAt: "2026-10-16T13:00:00.000Z", homeTeamId: "aus", awayTeamId: "jpn" })
]);
const DRYRUN_FIXTURE_COMPETITION = Object.freeze({
  id: DRYRUN_FIXTURE_ID,
  displayName: "APBC予想切替テスト 2026-10-16",
  shortName: "APBC Switch Test",
  startDate: "2026-10-16",
  endDate: "2026-10-16",
  description: "APBC本大会とは独立した2026-10-16仮運用テスト（Asia/Tokyo）"
});

function allowedOrigins(env) {
  return String(env?.ALLOWED_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function json(data, status = 200, request = null, env = {}) {
  const requestedOrigin = request?.headers.get("Origin") || "";
  const configuredOrigins = allowedOrigins(env);
  const origin = configuredOrigins.length
    ? (requestedOrigin ? (configuredOrigins.includes(requestedOrigin) ? requestedOrigin : "") : configuredOrigins[0])
    : (requestedOrigin || "*");
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Bootstrap-Token",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Vary": "Origin"
  });
  if (!origin) headers.delete("Access-Control-Allow-Origin");
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(request, env, status, code, message, details = {}) {
  return json({ ok: false, code, error: message, ...details }, status, request, env);
}

function databaseOrError(env, request) {
  if (env?.DB) return env.DB;
  return errorResponse(request, env, 503, "DATABASE_UNAVAILABLE", "Asia CS用データベースが準備されていません。");
}

function prepared(db, sql, ...values) {
  const statement = db.prepare(sql);
  return values.length ? statement.bind(...values) : statement;
}

async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY_BYTES) throw new RequestError(413, "REQUEST_TOO_LARGE", "入力が大きすぎます。");
  let raw;
  try {
    raw = await request.text();
  } catch {
    throw new RequestError(400, "REQUEST_BODY_INVALID", "入力を読み取れませんでした。");
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    throw new RequestError(413, "REQUEST_TOO_LARGE", "入力が大きすぎます。");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new RequestError(400, "JSON_INVALID", "入力形式が不正です。");
  }
}

class RequestError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function validId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) ? id : "";
}

function validDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date;
}

function validIsoDateTime(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

const PREDICTION_DEADLINE_OFFSET_MS = 60 * 60 * 1000;

function derivePredictionDeadline(startAt) {
  const start = startAt instanceof Date ? startAt : validIsoDateTime(startAt);
  return start ? new Date(start.getTime() - PREDICTION_DEADLINE_OFFSET_MS) : null;
}

function normalizePredictionDeadline(startAt, suppliedDeadline) {
  const derived = derivePredictionDeadline(startAt);
  if (!derived) return null;
  const supplied = suppliedDeadline === undefined || suppliedDeadline === null
    ? ""
    : String(suppliedDeadline).trim();
  if (!supplied) return derived;
  const explicit = validIsoDateTime(supplied);
  if (!explicit || explicit.getTime() !== derived.getTime()) {
    throw new RequestError(400, "INVALID_PREDICTION_DEADLINE", "予想締切は試合開始の60分前に設定してください。");
  }
  return derived;
}

function tokyoCalendarDate(value) {
  const date = value instanceof Date ? value : new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function uuid() {
  return crypto.randomUUID();
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomBase64(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

async function sha256Base64(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltBase64, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: base64ToBytes(saltBase64), iterations, hash: "SHA-256" }, key, 256);
  return bytesToBase64(new Uint8Array(bits));
}

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function rawCookieValue(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key === name) return part.slice(separator + 1).trim();
  }
  return "";
}

function countCookieOccurrences(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  return cookies.split(";").reduce((count, part) => {
    const separator = part.indexOf("=");
    const cookieName = separator < 0 ? part.trim() : part.slice(0, separator).trim();
    return count + (cookieName === name ? 1 : 0);
  }, 0);
}

function cookieValue(request, name) {
  const raw = rawCookieValue(request, name);
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function withSetCookie(response, cookie) {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

function normalizedUsername(value) {
  return String(value || "").trim().normalize("NFKC").toLowerCase();
}

function mutationOriginError(request, env, user = null) {
  if (user?.authSource === "starting9") {
    return user.csrfValidated === true
      ? null
      : errorResponse(request, env, 403, "CSRF_CONTEXT_REQUIRED", "操作元を確認できません。");
  }
  const configuredOrigins = allowedOrigins(env);
  const requestedOrigin = String(request.headers.get("Origin") || "").trim();
  const fetchSite = String(request.headers.get("Sec-Fetch-Site") || "").trim().toLowerCase();
  if (fetchSite === "cross-site") return errorResponse(request, env, 403, "CROSS_SITE_MUTATION", "許可されていない操作です。");
  if (requestedOrigin && (!configuredOrigins.length || !configuredOrigins.includes(requestedOrigin))) {
    return errorResponse(request, env, configuredOrigins.length ? 403 : 503, configuredOrigins.length ? "ORIGIN_NOT_ALLOWED" : "ORIGIN_NOT_CONFIGURED", configuredOrigins.length ? "許可されていない操作です。" : "許可Originが設定されていません。");
  }
  return null;
}

function legacyAuthFallbackEnabled(env) {
  const runtime = String(env?.ASIA_CS_ENV || "").trim().toLowerCase();
  return ["development", "test"].includes(runtime)
    && String(env?.ASIA_CS_ALLOW_LEGACY_AUTH || "").trim().toLowerCase() === "true";
}

function bridgeRequired(env) {
  return !legacyAuthFallbackEnabled(env);
}

async function getSessionUser(request, db) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Base64(token);
  const row = await prepared(db, `
    SELECT users.id, users.username, users.role, users.status
      FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ?1
       AND sessions.expires_at > ?2
       AND users.status = 'active'
     LIMIT 1`, tokenHash, nowIso()).first();
  return row || null;
}

function localAuthEnabled(env) {
  return String(env?.ASIA_CS_LOCAL_AUTH || "").toLowerCase() === "true";
}

function externalAuthConfigured(env) {
  return typeof env?.AUTH_VERIFY === "function" || Boolean(String(env?.STARTING9_AUTH_BASE_URL || "").trim());
}

function localAuthRuntime(env) {
  const runtime = String(env?.ASIA_CS_ENV || "").trim().toLowerCase();
  return runtime === "development" || runtime === "test";
}

function isValidExternalUserId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.trim());
}

function allowedAuthOrigin(value, env) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    return "";
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) return "";
  const origin = parsed.origin;
  if (origin === STARTING9_AUTH_ORIGIN && parsed.protocol === "https:") return origin;
  if (localAuthRuntime(env) && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") && ["http:", "https:"].includes(parsed.protocol)) return origin;
  return "";
}

function normalizeExternalUser(value, roleOverride = "") {
  const source = value?.user || value;
  const id = isValidExternalUserId(source?.id) ? source.id.trim() : "";
  if (!id) return null;
  const username = String(source?.username || source?.name || id).trim().slice(0, 80);
  if (!username) return null;
  const role = String(roleOverride || source?.role || "user").trim().toLowerCase();
  return {
    id,
    username,
    role: role === "admin" ? "admin" : "user",
    status: "active",
    authSource: source?.authSource || "external",
    csrfValidated: source?.csrfValidated === true
  };
}

function parseAsiaCsAdminUserIds(value) {
  const raw = String(value || "").trim();
  if (!raw) return new Set();

  let values;
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      values = Array.isArray(parsed) ? parsed : [];
    } catch {
      values = [];
    }
  } else {
    values = raw.split(",");
  }

  return new Set(values
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)));
}

function isAsiaCsAdmin(user, env) {
  if (!user || typeof user.id !== "string" || !user.id) return false;
  // The formal gateway assertion is the sole privilege source for the
  // integrated path. Do not let a legacy allowlist turn a signed normal user
  // into an admin when the Auth Worker explicitly asserted role=user.
  if (user.authSource === "starting9") return user.role === "admin";
  const configuredIds = parseAsiaCsAdminUserIds(env?.ASIA_CS_ADMIN_USER_IDS);
  if (configuredIds.size > 0) return configuredIds.has(user.id);
  // Local password auth is only a development/test fixture. Production uses
  // the external Starting9 identity and therefore fails closed without the
  // explicit environment allowlist.
  return localAuthRuntime(env) && localAuthEnabled(env) && user.role === "admin";
}

function createAuthDiagnostic(request) {
  const sessionCookieCount = countCookieOccurrences(request, STARTING9_SESSION_COOKIE);
  return {
    diagnosticId: String(request.headers.get(AUTH_DIAGNOSTIC_HEADER) || "").trim(),
    requestPath: new URL(request.url).pathname,
    hasSessionCookie: sessionCookieCount > 0,
    sessionCookieCount,
    authFetchAttempted: false,
    authUpstreamReached: false,
    authUpstreamStatus: null,
    authUpstreamAuthenticated: null,
    authUpstreamUserPresent: false,
    authUpstreamUserIdTypeValid: false,
    authFailureReason: AUTH_FAILURE_REASONS.NONE,
    finalAuthenticated: false,
    finalIsAdmin: false
  };
}

function setAuthFailureReason(diagnostic, reason) {
  if (diagnostic) diagnostic.authFailureReason = reason;
}

function emitAuthDiagnostic(diagnostic) {
  if (!diagnostic) return;
  console.info(JSON.stringify({ scope: "asia-cs-auth-diagnostic", phase: "asia_cs_worker", ...diagnostic }));
}

async function getExternalAuthUser(request, env, diagnostic = null) {
  const bridgeSecret = String(env?.ASIA_CS_AUTH_BRIDGE_SECRET || "").trim();
  const bridgeAssertion = request.headers.get("X-S9-Auth-Bridge") || "";
  if (bridgeAssertion) {
    if (!bridgeSecret) {
      setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.AUTH_IDENTITY_INVALID);
      return null;
    }
    let bodyDigest;
    try {
      bodyDigest = await sha256Base64Url(["GET", "HEAD"].includes(request.method) ? new Uint8Array() : await request.clone().arrayBuffer());
    } catch {
      setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.AUTH_IDENTITY_INVALID);
      return null;
    }
    const trusted = await verifyAuthBridgeAssertion(bridgeAssertion, {
      secret: bridgeSecret,
      method: request.method,
      path: new URL(request.url).pathname,
      query: new URL(request.url).search,
      bodyDigest,
      audience: AUTH_BRIDGE_AUDIENCE,
      requireCsrf: ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
    });
    if (trusted) {
      setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.NONE);
      if (diagnostic) {
        diagnostic.authUpstreamReached = false;
        diagnostic.authUpstreamAuthenticated = true;
        diagnostic.authUpstreamUserPresent = true;
        diagnostic.authUpstreamUserIdTypeValid = true;
      }
      return normalizeExternalUser(trusted, trusted.role);
    }
    setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.AUTH_IDENTITY_INVALID);
    return null;
  }
  if (bridgeRequired(env)) {
    setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.AUTH_IDENTITY_INVALID);
    return null;
  }
  if (typeof env?.AUTH_VERIFY === "function") {
    if (diagnostic) diagnostic.authFetchAttempted = true;
    if (diagnostic) diagnostic.authUpstreamReached = true;
    try {
      const value = await env.AUTH_VERIFY(request);
      const user = normalizeExternalUser(value);
      if (diagnostic) {
        diagnostic.authUpstreamStatus = 200;
        diagnostic.authUpstreamAuthenticated = Boolean(user);
        diagnostic.authUpstreamUserPresent = Boolean(value?.user || value);
        diagnostic.authUpstreamUserIdTypeValid = isValidExternalUserId(value?.user?.id || value?.id);
      }
      setAuthFailureReason(diagnostic, user ? AUTH_FAILURE_REASONS.NONE : AUTH_FAILURE_REASONS.AUTH_IDENTITY_INVALID);
      return user;
    } catch (error) {
      setAuthFailureReason(diagnostic, error?.name === "AbortError" ? AUTH_FAILURE_REASONS.AUTH_UPSTREAM_TIMEOUT : AUTH_FAILURE_REASONS.AUTH_FETCH_FAILED);
      console.warn(JSON.stringify({ scope: "asia-cs-auth", code: "AUTH_VERIFY_FAILED", message: String(error?.message || error) }));
      return null;
    }
  }
  // Auth Worker owns the cookie serializer and decodes the value once. Keep
  // the browser's encoded value byte-for-byte so this boundary never turns
  // `%3D` into `%253D` or otherwise changes the session token.
  const token = rawCookieValue(request, STARTING9_SESSION_COOKIE);
  if (!token) {
    setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.EMPTY_SESSION_TOKEN);
    return null;
  }
  const baseUrl = allowedAuthOrigin(env?.STARTING9_AUTH_BASE_URL, env);
  if (!baseUrl) {
    setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.AUTH_ORIGIN_REJECTED);
    return null;
  }
  let endpoint;
  try {
    endpoint = new URL("/api/auth/me", baseUrl).toString();
  } catch {
    setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.AUTH_URL_INVALID);
    return null;
  }
  const controller = new AbortController();
  const configuredTimeout = Number(env?.AUTH_UPSTREAM_TIMEOUT_MS);
  const timeoutMs = localAuthRuntime(env) && Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, AUTH_UPSTREAM_TIMEOUT_MS)
    : AUTH_UPSTREAM_TIMEOUT_MS;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort("auth upstream timeout");
  }, timeoutMs);
  try {
    if (diagnostic) diagnostic.authFetchAttempted = true;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { Cookie: `${STARTING9_SESSION_COOKIE}=${token}` },
      redirect: "error",
      signal: controller.signal
    });
    if (diagnostic) {
      diagnostic.authUpstreamReached = true;
      diagnostic.authUpstreamStatus = response.status;
    }
    if (!response.ok) {
      setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.AUTH_UPSTREAM_NON_2XX);
      return null;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.AUTH_UPSTREAM_INVALID_JSON);
      return null;
    }
    if (diagnostic) {
      diagnostic.authUpstreamAuthenticated = payload?.authenticated === true;
      diagnostic.authUpstreamUserPresent = Boolean(payload?.user);
      diagnostic.authUpstreamUserIdTypeValid = isValidExternalUserId(payload?.user?.id);
    }
    if (!payload?.ok || !payload.user || payload.authenticated !== true) {
      setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.AUTH_UPSTREAM_ANONYMOUS);
      return null;
    }
    const user = normalizeExternalUser(payload.user, "user");
    if (!user) {
      setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.AUTH_IDENTITY_INVALID);
      return null;
    }
    setAuthFailureReason(diagnostic, AUTH_FAILURE_REASONS.NONE);
    return user;
  } catch (error) {
    setAuthFailureReason(diagnostic, timedOut || error?.name === "AbortError"
      ? AUTH_FAILURE_REASONS.AUTH_UPSTREAM_TIMEOUT
      : AUTH_FAILURE_REASONS.AUTH_FETCH_FAILED);
    console.warn(JSON.stringify({ scope: "asia-cs-auth", code: "AUTH_ENDPOINT_UNAVAILABLE", message: String(error?.message || error) }));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureExternalIdentity(db, user) {
  const now = nowIso();
  await prepared(db, `INSERT INTO users
    (id, username, username_normalized, password_hash, password_salt, password_iterations, role, status, created_at, updated_at, auth_source, external_id)
    VALUES (?1, ?2, ?3, 'external-auth', 'external-auth', 0, ?4, 'active', ?5, ?5, 'starting9', ?1)
    ON CONFLICT(id) DO UPDATE SET username = excluded.username, username_normalized = excluded.username_normalized,
      role = excluded.role, status = 'active', updated_at = excluded.updated_at, auth_source = 'starting9', external_id = excluded.external_id`,
    user.id, user.username, normalizedUsername(user.username), user.role, now).run();
  return user;
}

async function resolveUser(request, env, db, options = {}) {
  if (externalAuthConfigured(env)) {
    const external = await getExternalAuthUser(request, env, options.diagnostic || null);
    return external ? ensureExternalIdentity(db, external) : null;
  }
  return localAuthEnabled(env) ? getSessionUser(request, db) : null;
}

async function requireUser(request, env, db) {
  const user = await resolveUser(request, env, db);
  return user || errorResponse(request, env, 401, "AUTH_REQUIRED", "ログインしてください。");
}

async function requireAdmin(request, env, db) {
  const user = await resolveUser(request, env, db);
  if (!user) return errorResponse(request, env, 401, "AUTH_REQUIRED", "ログインしてください。");
  // Admin reads are authenticated and read-only. The Auth Worker marks
  // mutation CSRF validation only for state-changing methods, so requiring
  // that marker here would reject a valid same-origin overview GET before the
  // role check. Keep the existing origin/CSRF gate for every mutation.
  if (!["GET", "HEAD"].includes(String(request.method || "").toUpperCase())) {
    const originError = mutationOriginError(request, env, user);
    if (originError) return originError;
  }
  if (!isAsiaCsAdmin(user, env)) return errorResponse(request, env, 403, "ADMIN_REQUIRED", "管理者権限が必要です。");
  return { ...user, role: "admin" };
}

async function register(request, env, db) {
  const input = await readJson(request);
  const username = String(input.username || "").trim().slice(0, 32);
  const normalized = normalizedUsername(username);
  const password = String(input.password || "");
  if (!/^[^\s]{1,32}$/.test(username) || normalized.length < 1) {
    throw new RequestError(400, "USERNAME_INVALID", "ユーザー名を入力してください。");
  }
  if (password.length < 8 || password.length > 72) {
    throw new RequestError(400, "PASSWORD_INVALID", "パスワードは8〜72文字で入力してください。");
  }
  const now = nowIso();
  const salt = randomBase64(16);
  const token = randomBase64(32);
  // Public registration can only create regular users. Admin role assignment is
  // deliberately isolated in bootstrapAdmin so a reserved username cannot
  // become a privilege-escalation mechanism.
  const role = "user";
  const userId = uuid();
  try {
    await db.batch([
      prepared(db, `INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, role, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`, userId, username, normalized, await hashPassword(password, salt), salt, PASSWORD_ITERATIONS, role, now),
      prepared(db, `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`, uuid(), userId, await sha256Base64(token), new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString(), now)
    ]);
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("unique")) {
      throw new RequestError(409, "USERNAME_TAKEN", "そのユーザー名は使用されています。");
    }
    throw error;
  }
  return withSetCookie(json({ ok: true, user: { id: userId, username, role } }, 201, request, env), sessionCookie(token));
}

async function bootstrapAdmin(request, env, db) {
  const originError = mutationOriginError(request, env);
  if (originError) return originError;
  const configuredToken = String(env.ADMIN_BOOTSTRAP_TOKEN || "");
  if (!configuredToken) throw new RequestError(503, "ADMIN_BOOTSTRAP_UNAVAILABLE", "管理者初期化が設定されていません。");
  if (!constantTimeEqual(request.headers.get("X-Admin-Bootstrap-Token") || "", configuredToken)) {
    throw new RequestError(403, "ADMIN_BOOTSTRAP_INVALID", "管理者初期化トークンが不正です。");
  }
  const input = await readJson(request);
  const username = String(input.username || "").trim().slice(0, 32);
  const normalized = normalizedUsername(username);
  const password = String(input.password || "");
  if (!/^[^\s]{1,32}$/.test(username) || normalized.length < 1) {
    throw new RequestError(400, "USERNAME_INVALID", "ユーザー名を入力してください。");
  }
  if (password.length < 8 || password.length > 72) {
    throw new RequestError(400, "PASSWORD_INVALID", "パスワードは8〜72文字で入力してください。");
  }

  const userId = uuid();
  const now = nowIso();
  const salt = randomBase64(16);
  const result = await prepared(db, `INSERT INTO users (id, username, username_normalized, password_hash, password_salt, password_iterations, role, created_at, updated_at)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'admin', ?7, ?7
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
    userId, username, normalized, await hashPassword(password, salt), salt, PASSWORD_ITERATIONS, now).run();
  if (!Number(result?.meta?.changes || 0)) throw new RequestError(409, "ADMIN_ALREADY_INITIALIZED", "管理者は初期化済みです。");
  return json({ ok: true, user: { id: userId, username, role: "admin" } }, 201, request, env);
}

async function login(request, env, db) {
  const input = await readJson(request);
  const normalized = normalizedUsername(input.username);
  const password = String(input.password || "");
  const user = await prepared(db, "SELECT * FROM users WHERE username_normalized = ?1 AND status = 'active' LIMIT 1", normalized).first();
  if (!user) throw new RequestError(401, "LOGIN_FAILED", "ユーザー名またはパスワードが違います。");
  const passwordHash = await hashPassword(password, user.password_salt, Number(user.password_iterations));
  if (!constantTimeEqual(passwordHash, user.password_hash)) throw new RequestError(401, "LOGIN_FAILED", "ユーザー名またはパスワードが違います。");
  const token = randomBase64(32);
  const now = nowIso();
  await prepared(db, "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", uuid(), user.id, await sha256Base64(token), new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString(), now).run();
  return withSetCookie(json({ ok: true, user: { id: user.id, username: user.username, role: user.role } }, 200, request, env), sessionCookie(token));
}

async function logout(request, env, db) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await prepared(db, "DELETE FROM sessions WHERE token_hash = ?1", await sha256Base64(token)).run();
  return withSetCookie(json({ ok: true }, 200, request, env), expiredSessionCookie());
}

async function getGame(db, gameId) {
  return prepared(db, "SELECT * FROM games WHERE id = ?1 LIMIT 1", gameId).first();
}

async function getCompetition(db, competitionId) {
  return prepared(db, `SELECT id, competition_type, display_name, short_name,
      start_date, end_date, status, description, created_at, updated_at
    FROM competitions WHERE id = ?1 LIMIT 1`, competitionId).first();
}

async function assertCompetitionMutable(db, competitionId) {
  const competition = await getCompetition(db, competitionId || DEFAULT_COMPETITION_ID);
  if (!competition) throw new RequestError(404, "COMPETITION_NOT_FOUND", "対象大会がありません。");
  if (competition.status === "completed") throw new RequestError(409, "COMPETITION_COMPLETED", "完了した大会は変更できません。");
  return competition;
}

async function assertGameCompetitionMutable(db, game) {
  if (!game) throw new RequestError(404, "GAME_NOT_FOUND", "対象試合がありません。");
  return assertCompetitionMutable(db, game.competition_id || DEFAULT_COMPETITION_ID);
}

async function ensureCompetition(db, competitionId, now = nowIso()) {
  const id = validId(competitionId) || DEFAULT_COMPETITION_ID;
  // Read first so an existing completed competition stays truly read-only;
  // only the bootstrap path is allowed to create a missing competition row.
  const existing = await getCompetition(db, id);
  if (existing) return existing;
  await prepared(db, `INSERT OR IGNORE INTO competitions
    (id, competition_type, display_name, short_name, status, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?3, 'draft', ?4, ?4)`, id, COMPETITION_TYPE, id, now).run();
  return getCompetition(db, id);
}

function serializeCompetition(competition) {
  if (!competition) return null;
  return {
    id: competition.id,
    competitionType: competition.competition_type,
    displayName: competition.display_name,
    shortName: competition.short_name,
    startDate: competition.start_date || null,
    endDate: competition.end_date || null,
    status: competition.status,
    description: competition.description || null
  };
}

function competitionAllowsPrediction(competition, game, now) {
  // A competition must be explicitly activated before any prediction can be
  // accepted. This keeps draft data publicly readable while failing closed
  // for draft, completed, and future/unknown competition states.
  if (competition?.status !== "active") return false;
  const deadline = validDate(game?.prediction_deadline_at);
  return Boolean(competition && deadline && now < deadline.getTime() && game?.status === "open");
}

function isPublishedPredictionGame(game) {
  return game?.status === "published" && game?.publication_status === "published";
}

async function firstUnpublishedPredictionGame(db, competitionId, teams = null, games = null) {
  const competitionGames = games || (await prepared(db, `SELECT * FROM games
      WHERE competition_type = ?1 AND competition_id = ?2
     ORDER BY game_date ASC, start_at ASC, id ASC`, COMPETITION_TYPE, competitionId).all()).results || [];
  const competitionTeams = teams || await getTeams(db, competitionId);
  return competitionGames
    .filter((game) => isGamePredictionEligible(game, competitionTeams))
    .find((game) => !isPublishedPredictionGame(game)) || null;
}

const JAPAN_TEAM_ALIASES = new Set([
  "jpn",
  "jp",
  "japan",
  "日本",
  "日本代表",
  "japan national team",
  "team jpn"
]);

function normalizeTeamIdentity(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

function isJapanTeam(team = {}) {
  return [team.id, team.team_key, team.display_name, team.short_name, team.country_code]
    .some((value) => JAPAN_TEAM_ALIASES.has(normalizeTeamIdentity(value)) || normalizeTeamIdentity(value) === "jpn");
}

function teamMatchesGameReference(team, rawId, rawName) {
  return [team.id, team.team_key, team.display_name, team.short_name]
    .filter(Boolean)
    .some((value) => String(value) === String(rawId) || String(value) === String(rawName));
}

function gameHasJapanTeam(game, teams = []) {
  return [
    [game?.home_team_id, game?.home_team_name],
    [game?.away_team_id, game?.away_team_name]
  ].some(([rawId, rawName]) => {
    const team = teams.find((candidate) => teamMatchesGameReference(candidate, rawId, rawName));
    return isJapanTeam(team || { id: rawId, display_name: rawName });
  });
}

function isGamePredictionEligible(game, teams = []) {
  // Generic/local Asia fixtures created before Japan-only APBC support do not
  // carry country identity. Keep those fixtures backward-compatible; once a
  // competition has a resolvable Japan team, every prediction target must
  // explicitly include it.
  const japanOnlyCompetition = teams.some(isJapanTeam);
  return !japanOnlyCompetition || gameHasJapanTeam(game, teams);
}

function derivePublicPredictionState(competition, game, teams, firstUnpublished, now) {
  // Both read boundaries use the same eligibility, publication priority and
  // waiting vocabulary. The caller selects the first unpublished eligible
  // game once and supplies its clock; this derivation never queries or mutates.
  // An expired current game still blocks the next game until fully published.
  const predictionEligible = isGamePredictionEligible(game, teams);
  const canPredict = Boolean(predictionEligible && firstUnpublished && game.id === firstUnpublished.id
    && competitionAllowsPrediction(competition, firstUnpublished, now));
  const predictionState = !predictionEligible
    ? "ineligible"
    : isPublishedPredictionGame(game)
      ? "published"
      : firstUnpublished && firstUnpublished.id !== game.id
        ? "waiting_for_previous_publish"
        : canPredict ? "open" : "closed";
  return { predictionEligible, canPredict, predictionState };
}

async function persistedGamePredictionEligible(db, game) {
  return isGamePredictionEligible(game, await getTeams(db, game?.competition_id || DEFAULT_COMPETITION_ID));
}

function predictionNotEligibleResponse(request, env) {
  return errorResponse(request, env, 409, "PREDICTION_NOT_ELIGIBLE", "日本代表が出場しない試合は予想処理の対象外です。");
}

async function listCompetitionGames(request, env, db, competitionId, { includePredictionState = true, userVisibleOnly = false } = {}) {
  const result = await prepared(db, `SELECT g.*, COUNT(DISTINCT p.id) AS prediction_count
      FROM games g LEFT JOIN predictions p ON p.game_id = g.id
     WHERE g.competition_type = ?1 AND g.competition_id = ?2
     GROUP BY g.id
     ORDER BY g.game_date ASC, g.start_at ASC, g.id ASC`, COMPETITION_TYPE, competitionId).all();
  const allGames = result.results || [];
  const teams = await getTeams(db, competitionId);
  const games = userVisibleOnly
    ? allGames.filter((game) => isGamePredictionEligible(game, teams))
    : allGames;
  let userId = "";
  const competition = await getCompetition(db, competitionId);
  if (includePredictionState) {
    const user = await resolveUser(request, env, db);
    userId = user?.id || "";
  }
  let submitted = new Set();
  if (userId && games.length) {
    const rows = await prepared(db, `SELECT game_id FROM predictions
      WHERE user_id = ?1 AND game_id IN (${games.map((_, index) => `?${index + 2}`).join(",")})`, userId, ...games.map((game) => game.id)).all();
    submitted = new Set((rows.results || []).map((row) => row.game_id));
  }
  const firstUnpublished = await firstUnpublishedPredictionGame(db, competitionId, teams, allGames);
  const now = Date.now();
  return games.map((game) => {
    return {
    id: game.id,
    title: game.title,
    gameDate: game.game_date,
    startAt: game.start_at,
    predictionDeadlineAt: game.prediction_deadline_at,
    venue: game.venue || null,
    externalGameCode: game.external_game_code || null,
    homeTeam: game.home_team_id ? { id: game.home_team_id, name: game.home_team_name || game.home_team_id } : null,
    awayTeam: game.away_team_id ? { id: game.away_team_id, name: game.away_team_name || game.away_team_id } : null,
    status: game.status,
    publicationStatus: game.publication_status,
    predictionCount: Number(game.prediction_count || 0),
    predictionSubmitted: submitted.has(game.id),
    ...derivePublicPredictionState(competition, game, teams, firstUnpublished, now),
    archived: competition?.status === "completed"
    };
  });
}

async function getPlayers(db, gameId, activeOnly = false) {
  const suffix = activeOnly ? " AND active = 1" : "";
  const result = await prepared(db, `SELECT id, game_id, name, uniform_number, team, team_id, position, bat, throw, active, created_at, updated_at FROM players WHERE game_id = ?1${suffix} ORDER BY name ASC, id ASC`, gameId).all();
  return result.results || [];
}

async function getTeams(db, competitionId = DEFAULT_COMPETITION_ID) {
  const result = await prepared(db, "SELECT id, competition_id, team_key, display_name, short_name, country_code FROM teams WHERE competition_id = ?1 ORDER BY display_name ASC, id ASC", competitionId).all();
  return result.results || [];
}

async function findTeam(db, competitionId, teamId) {
  const normalized = validId(teamId);
  if (!normalized) return null;
  return prepared(db, `SELECT id, competition_id, team_key, display_name, short_name, country_code
    FROM teams WHERE competition_id = ?1 AND (id = ?2 OR team_key = ?2) LIMIT 1`, competitionId, normalized).first();
}

async function validateGameTeams(db, competitionId, homeTeamId, awayTeamId) {
  if (!homeTeamId && !awayTeamId) return { home: null, away: null };
  if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId) {
    throw new RequestError(400, "TEAM_INPUT_INVALID", "ホーム・ビジターのチームを確認してください。");
  }
  const home = await findTeam(db, competitionId, homeTeamId);
  const away = await findTeam(db, competitionId, awayTeamId);
  if (!home || !away || home.id === away.id) {
    throw new RequestError(409, "TEAM_NOT_IN_COMPETITION", "大会に登録された対戦チームを指定してください。");
  }
  return { home, away };
}

async function validatePlayerTeam(db, game, teamId) {
  if (!game.home_team_id && !game.away_team_id) return null;
  const team = await findTeam(db, game.competition_id, teamId);
  if (!team) {
    throw new RequestError(409, "TEAM_NOT_IN_COMPETITION", "大会に登録されたチームを指定してください。");
  }
  const gameTeamIds = [game.home_team_id, game.away_team_id].filter(Boolean);
  // Older Asia CS rows stored team_key in games. New rows may use the
  // canonical teams.id, so accept either only after resolving the identifier
  // through the competition-scoped teams table. A client-provided string is
  // never trusted as ownership proof by itself.
  const belongsToGame = gameTeamIds.includes(team.id) || gameTeamIds.includes(team.team_key);
  if (!belongsToGame) {
    throw new RequestError(409, "PLAYER_TEAM_MISMATCH", "選手の所属チームが試合の対戦チームと一致しません。");
  }
  return team;
}

async function validateLineupTeamOwnership(db, game, lineup, teamId) {
  if (!game.home_team_id && !game.away_team_id) return;
  const team = await validatePlayerTeam(db, game, teamId);
  const ids = lineup.map((item) => item.playerId);
  if (new Set(ids).size !== ids.length) {
    throw new RequestError(400, "DUPLICATE_PLAYER", "正式スタメンに同じ選手が複数います。");
  }
  const result = await prepared(db, `SELECT id, team_id, active FROM players WHERE game_id = ?1 AND id IN (${ids.map((_, index) => `?${index + 2}`).join(",")})`, game.id, ...ids).all();
  const playersById = new Map((result.results || []).map((player) => [player.id, player]));
  for (const id of ids) {
    const player = playersById.get(id);
    if (!player || Number(player.active) !== 1 || (player.team_id !== team.id && player.team_id !== team.team_key)) {
      throw new RequestError(409, "LINEUP_TEAM_MISMATCH", "正式スタメンの所属チームが一致しません。");
    }
  }
}

function serializePlayer(player) {
  return {
    id: player.id,
    gameId: player.game_id,
    name: player.name,
    uniformNumber: player.uniform_number,
    team: player.team,
    club: player.team || null,
    teamId: player.team_id || null,
    // The roster registration category is metadata only. Prediction and
    // official lineup positions remain in the lineup payload and are never
    // inferred from this field.
    registeredPosition: player.position || null,
    // Keep the legacy field for existing admin/staging consumers. New UI code
    // must use registeredPosition so the two position contracts stay distinct.
    position: player.position || null,
    bat: player.bat || null,
    throw: player.throw || null,
    active: Boolean(player.active)
  };
}

function serializePlayers(players = []) {
  return players.map(serializePlayer);
}

function serializeGame(game, players = [], teams = []) {
  if (!game) return null;
  const serializedPlayers = serializePlayers(players);
  const teamScope = (rawId, rawName) => {
    const team = teams.find((candidate) => [candidate.id, candidate.team_key, candidate.display_name, candidate.short_name]
      .filter(Boolean)
      .some((value) => String(value) === String(rawId) || String(value) === String(rawName)));
    return new Set([rawId, rawName, team?.id, team?.team_key, team?.display_name, team?.short_name].filter(Boolean));
  };
  const homeIds = teamScope(game.home_team_id, game.home_team_name);
  const awayIds = teamScope(game.away_team_id, game.away_team_name);
  return {
    id: game.id,
    title: game.title,
    competitionType: game.competition_type || COMPETITION_TYPE,
    competitionId: game.competition_id || DEFAULT_COMPETITION_ID,
    gameSource: game.game_source || "manual",
    externalGameCode: game.external_game_code || null,
    gameDate: game.game_date,
    startAt: game.start_at,
    predictionDeadlineAt: game.prediction_deadline_at,
    venue: game.venue || null,
    homeTeam: game.home_team_id ? { id: game.home_team_id, name: game.home_team_name || game.home_team_id } : null,
    awayTeam: game.away_team_id ? { id: game.away_team_id, name: game.away_team_name || game.away_team_id } : null,
    status: game.status,
    publicationStatus: game.publication_status,
    currentLineupRevision: game.current_lineup_revision === null ? null : Number(game.current_lineup_revision),
    players: serializedPlayers,
    playersByTeam: {
      home: serializedPlayers.filter((player) => homeIds.has(player.teamId) || homeIds.has(player.team)),
      away: serializedPlayers.filter((player) => awayIds.has(player.teamId) || awayIds.has(player.team))
    }
  };
}

async function publicGame(request, env, db, gameId) {
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  const teams = await getTeams(db, game.competition_id);
  const competition = await getCompetition(db, game.competition_id);
  if (!isGamePredictionEligible(game, teams)) return errorResponse(request, env, 404, "GAME_NOT_AVAILABLE", "日本代表が出場する試合ではありません。");
  const firstUnpublished = await firstUnpublishedPredictionGame(db, game.competition_id, teams);
  const predictionAvailability = derivePublicPredictionState(competition, game, teams, firstUnpublished, Date.now());
  return json({ ok: true, game: {
    ...serializeGame(game, await getPlayers(db, gameId, true), teams),
    ...predictionAvailability
  } }, 200, request, env);
}

async function publicCompetition(request, env, db) {
  const competitionId = validId(new URL(request.url).searchParams.get("competitionId")) || DEFAULT_COMPETITION_ID;
  const competition = await getCompetition(db, competitionId);
  if (!competition) return errorResponse(request, env, 404, "COMPETITION_NOT_FOUND", "対象大会がありません。");
  const games = await listCompetitionGames(request, env, db, competitionId, { userVisibleOnly: true });
  const now = Date.now();
  const nextGame = games.find((game) => game.predictionEligible && game.canPredict && game.status === "open" && new Date(game.startAt).getTime() >= now) || null;
  return json({
    ok: true,
    competition: serializeCompetition(competition),
    games,
    nextGame,
    acceptingGames: games.filter((game) => game.canPredict)
  }, 200, request, env);
}

async function publicGames(request, env, db) {
  const competitionId = validId(new URL(request.url).searchParams.get("competitionId")) || DEFAULT_COMPETITION_ID;
  if (!await getCompetition(db, competitionId)) return errorResponse(request, env, 404, "COMPETITION_NOT_FOUND", "対象大会がありません。");
  return json({ ok: true, competitionId, games: await listCompetitionGames(request, env, db, competitionId, { userVisibleOnly: true }) }, 200, request, env);
}

async function publicResult(request, env, db, gameId) {
  const game = await getGame(db, gameId);
  if (!game || game.status !== "published" || game.publication_status !== "published") {
    return errorResponse(request, env, 404, "RESULT_NOT_PUBLISHED", "この試合の結果はまだ公開されていません。");
  }
  if (!await persistedGamePredictionEligible(db, game)) {
    return errorResponse(request, env, 404, "RESULT_NOT_PUBLISHED", "この試合の結果はまだ公開されていません。");
  }
  const lineup = await currentLineup(db, gameId);
  const players = await getPlayers(db, gameId);
  const playerById = new Map(players.map((player) => [player.id, player]));
  const officialLineup = (lineup?.lineup || []).map((item) => ({
    ...item,
    playerName: playerById.get(item.playerId)?.name || item.playerName,
    team: playerById.get(item.playerId)?.team || null
  }));
  const user = await resolveUser(request, env, db);
  let prediction = null;
  if (user) {
    const row = await prepared(db, `SELECT prediction_json, score, max_score, scored_revision,
        submitted_at, updated_at, scored_at, status
      FROM predictions WHERE user_id = ?1 AND game_id = ?2 LIMIT 1`, user.id, gameId).first();
    if (row) {
      const predictedLineup = JSON.parse(row.prediction_json);
      const score = scoreLineup(predictedLineup, officialLineup);
      prediction = {
        lineup: predictedLineup,
        status: row.status,
        score: row.score === null ? null : Number(row.score),
        maxScore: row.max_score === null ? null : Number(row.max_score),
        scoredRevision: row.scored_revision,
        submittedAt: row.submitted_at,
        updatedAt: row.updated_at,
        scoredAt: row.scored_at,
        breakdown: {
          player: { hits: score.counts.player, points: score.counts.player * 5, max: 45 },
          order: { hits: score.counts.order, points: score.counts.order * 3, max: 27 },
          position: { hits: score.counts.position, points: score.counts.position * 2, max: 18 },
          perfect: { hits: score.counts.perfect, points: score.counts.perfect, max: 9 },
          total: score.total
        }
      };
    }
  }
  return json({ ok: true, game: serializeGame(game, []), officialLineup, prediction }, 200, request, env);
}

async function currentPrediction(request, env, db, gameId) {
  const user = await requireUser(request, env, db);
  if (user instanceof Response) return user;
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  if (!await persistedGamePredictionEligible(db, game)) return predictionNotEligibleResponse(request, env);
  const row = await prepared(db, "SELECT prediction_json, status, score, max_score, scored_revision, submitted_at, updated_at, scored_at, actual_lineup_json FROM predictions WHERE user_id = ?1 AND game_id = ?2 LIMIT 1", user.id, gameId).first();
  const published = game.status === "published" && game.publication_status === "published";
  const prediction = row ? {
    lineup: JSON.parse(row.prediction_json),
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    ...(published ? {
      score: row.score === null ? null : Number(row.score),
      maxScore: row.max_score === null ? null : Number(row.max_score),
      scoredRevision: row.scored_revision,
      scoredAt: row.scored_at,
      actualLineup: row.actual_lineup_json ? JSON.parse(row.actual_lineup_json) : null
    } : {})
  } : null;
  return json({ ok: true, prediction }, 200, request, env);
}

async function savePrediction(request, env, db, gameId) {
  const user = await requireUser(request, env, db);
  if (user instanceof Response) return user;
  const originError = mutationOriginError(request, env, user);
  if (originError) return originError;
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  const competition = await assertGameCompetitionMutable(db, game);
  if (competition.status !== "active") {
    return errorResponse(request, env, 409, "PREDICTION_NOT_OPEN", "予想受付開始前です。");
  }
  if (!await persistedGamePredictionEligible(db, game)) return predictionNotEligibleResponse(request, env);
  const currentTarget = await firstUnpublishedPredictionGame(db, game.competition_id);
  if (!currentTarget || currentTarget.id !== game.id) {
    return errorResponse(request, env, 409, "PREDICTION_NOT_OPEN", "前の日本戦の公開完了後に予想受付を開始します。");
  }
  const now = new Date();
  const deadline = validDate(game.prediction_deadline_at);
  if (!deadline || now.getTime() >= deadline.getTime() || game.status !== "open") {
    return errorResponse(request, env, 409, "PREDICTION_DEADLINE_PASSED", "予想受付を終了しています。");
  }
  const input = await readJson(request);
  const players = await getPlayers(db, gameId, true);
  const rosterIds = new Set(players.map((player) => player.id));
  const candidate = validateLineup(input.lineup, { label: "予想", rosterIds });
  if (!candidate.ok) return errorResponse(request, env, 400, candidate.code, candidate.error);
  await validateLineupTeamOwnership(db, game, candidate.lineup, input.teamId || input.lineupTeamId);
  const nowValue = now.toISOString();
  const existing = await prepared(db, "SELECT id, submitted_at FROM predictions WHERE user_id = ?1 AND game_id = ?2 LIMIT 1", user.id, gameId).first();
  const id = existing?.id || uuid();
  await prepared(db, `INSERT INTO predictions (id, user_id, game_id, prediction_json, submitted_at, updated_at, status, score, max_score, scored_revision, actual_lineup_json, scored_at, is_test_prediction)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'submitted', NULL, NULL, NULL, NULL, NULL, 0)
    ON CONFLICT(user_id, game_id) DO UPDATE SET prediction_json = excluded.prediction_json, updated_at = excluded.updated_at, status = 'submitted', score = NULL, max_score = NULL, scored_revision = NULL, actual_lineup_json = NULL, scored_at = NULL`,
    id, user.id, gameId, JSON.stringify(candidate.lineup), existing?.submitted_at || nowValue, nowValue).run();
  return json({ ok: true, prediction: { lineup: candidate.lineup, submittedAt: existing?.submitted_at || nowValue, updatedAt: nowValue } }, 200, request, env);
}

async function deletePrediction(request, env, db, gameId) {
  const user = await requireUser(request, env, db);
  if (user instanceof Response) return user;
  const originError = mutationOriginError(request, env, user);
  if (originError) return originError;
  const game = await getGame(db, gameId);
  const competition = game ? await assertGameCompetitionMutable(db, game) : null;
  if (competition && competition.status !== "active") {
    return errorResponse(request, env, 409, "PREDICTION_NOT_OPEN", "予想受付開始前です。");
  }
  if (game && !await persistedGamePredictionEligible(db, game)) return predictionNotEligibleResponse(request, env);
  if (game) {
    const currentTarget = await firstUnpublishedPredictionGame(db, game.competition_id);
    if (!currentTarget || currentTarget.id !== game.id) {
      return errorResponse(request, env, 409, "PREDICTION_NOT_OPEN", "前の日本戦の公開完了後に予想受付を開始します。");
    }
  }
  const deadline = validDate(game?.prediction_deadline_at);
  if (!game || !deadline || new Date().getTime() >= deadline.getTime() || game.status !== "open") {
    return errorResponse(request, env, 409, "PREDICTION_DEADLINE_PASSED", "予想受付を終了しています。");
  }
  await prepared(db, "DELETE FROM predictions WHERE user_id = ?1 AND game_id = ?2", user.id, gameId).run();
  return json({ ok: true }, 200, request, env);
}

function formalJobTypesForGame(game, teams = []) {
  return isGamePredictionEligible(game, teams) ? FORMAL_JOB_TYPES : [];
}

function buildFormalJobStatements(db, gameId, predictionDeadlineAt, competitionId, now, jobTypes = FORMAL_JOB_TYPES) {
  return jobTypes.map((jobType) => prepared(db, `INSERT OR IGNORE INTO formal_jobs
    (id, game_id, competition_type, competition_id, job_type, status, revision_number, due_at, attempts, completed_at, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'scheduled', NULL, ?6, 0, NULL, ?7, ?7)`,
    uuid(), gameId, COMPETITION_TYPE, competitionId, jobType, predictionDeadlineAt, now));
}

async function ensureFormalJobs(db, game) {
  if (!game) return;
  const teams = await getTeams(db, game.competition_id || DEFAULT_COMPETITION_ID);
  const jobTypes = formalJobTypesForGame(game, teams);
  // A non-Japan fixture is still a real tournament game, but it is outside
  // Starting9's prediction pipeline. In particular, an admin GET must not
  // recreate legacy prediction jobs after they have been reconciled away.
  if (!jobTypes.length) return;
  const existing = await prepared(db, "SELECT COUNT(*) AS count FROM formal_jobs WHERE game_id = ?1", game.id).first();
  if (Number(existing?.count || 0) >= jobTypes.length) return;
  await db.batch(buildFormalJobStatements(db, game.id, game.prediction_deadline_at, game.competition_id || DEFAULT_COMPETITION_ID, nowIso(), jobTypes));
}

function dryRunPlayerCopyId(gameId, sourcePlayerId) {
  // players.id is the existing per-game table's global primary key. A source
  // player therefore cannot be inserted into both TEST1 and TEST2 under the
  // same database id without moving or overwriting APBC data. Keep a stable,
  // fixture-scoped alias so retries are idempotent and expose the original id
  // in the read-back mapping instead of mutating the canonical APBC roster.
  return `dryrun-${gameId.toLowerCase()}-${sourcePlayerId}`.slice(0, 64);
}

async function dryRunSourceRoster(db) {
  const sourceGame = await getGame(db, DRYRUN_SOURCE_GAME_ID);
  const sourceTeams = await getTeams(db, DRYRUN_SOURCE_COMPETITION_ID);
  if (!sourceGame || sourceGame.competition_id !== DRYRUN_SOURCE_COMPETITION_ID) {
    throw new RequestError(409, "DRYRUN_SOURCE_ROSTER_UNAVAILABLE", "APBC GAME2のロースターを確認できません。");
  }
  const japanTeam = sourceTeams.find(isJapanTeam);
  if (!japanTeam) throw new RequestError(409, "DRYRUN_SOURCE_ROSTER_UNAVAILABLE", "APBC GAME2の日本代表チームを確認できません。");
  const roster = (await getPlayers(db, sourceGame.id, true)).filter((player) =>
    teamMatchesGameReference(japanTeam, player.team_id, player.team)
  );
  const ids = roster.map((player) => String(player.id || ""));
  const duplicateIds = ids.length - new Set(ids).size;
  const unknown = roster.filter((player) => !validId(player.id) || !String(player.name || "").trim()
    || !String(player.team || "").trim() || !REGISTERED_POSITIONS.includes(String(player.position || "").trim())).length;
  if (roster.length !== 15 || duplicateIds !== 0 || unknown !== 0) {
    throw new RequestError(409, "DRYRUN_SOURCE_ROSTER_INVALID", "APBC GAME2の日本代表ロースターが15名として確定していません。", {
      sourceRoster: { count: roster.length, duplicatePlayerIds: duplicateIds, unknown }
    });
  }
  return { sourceGame, sourceTeam: japanTeam, roster };
}

async function dryRunFixtureReadback(db) {
  const competition = await getCompetition(db, DRYRUN_FIXTURE_ID);
  if (!competition) return { exists: false, ready: false, status: "missing", competition: null, teams: [], games: [], formalJobs: [] };
  const teams = await getTeams(db, DRYRUN_FIXTURE_ID);
  const games = [];
  const formalJobs = [];
  for (const definition of DRYRUN_FIXTURE_GAME_DEFINITIONS) {
    const game = await getGame(db, definition.id);
    if (!game || game.competition_id !== DRYRUN_FIXTURE_ID) continue;
    const players = await getPlayers(db, game.id, true);
    const jobs = await listFormalJobs(db, game.id);
    games.push({
      id: game.id,
      title: game.title,
      gameDate: game.game_date,
      startAt: game.start_at,
      predictionDeadlineAt: game.prediction_deadline_at,
      homeTeamId: game.home_team_id,
      awayTeamId: game.away_team_id,
      status: game.status,
      publicationStatus: game.publication_status,
      rosterCount: players.length,
      duplicatePlayerIds: players.length - new Set(players.map((player) => player.id)).size,
      players: players.map((player) => ({
        id: player.id,
        sourcePlayerId: player.id.startsWith(`dryrun-${game.id.toLowerCase()}-`) ? player.id.slice(`dryrun-${game.id.toLowerCase()}-`.length) : null,
        name: player.name,
        club: player.team || null,
        registeredPosition: player.position || null,
        active: Boolean(player.active)
      })),
      formalJobs: jobs
    });
    formalJobs.push(...jobs.map((job) => ({ ...job, gameId: game.id })));
  }
  const gamesReady = games.length === DRYRUN_FIXTURE_GAME_DEFINITIONS.length
    && games.every((game) => {
      const definition = DRYRUN_FIXTURE_GAME_DEFINITIONS.find((item) => item.id === game.id);
      const expectedDeadline = derivePredictionDeadline(definition.startAt)?.toISOString();
      return game.title === definition.title
        && game.gameDate === definition.gameDate
        && game.startAt === new Date(definition.startAt).toISOString()
        && game.predictionDeadlineAt === expectedDeadline
        && game.homeTeamId === definition.homeTeamId
        && game.awayTeamId === definition.awayTeamId
        && game.rosterCount === 15
        && game.duplicatePlayerIds === 0
        && game.formalJobs.length === FORMAL_JOB_TYPES.length
        && new Set(game.formalJobs.map((job) => job.job_type)).size === FORMAL_JOB_TYPES.length
        && game.formalJobs.every((job) => job.status === "scheduled"
          && job.due_at === expectedDeadline);
    });
  const ready = teams.length === DRYRUN_FIXTURE_TEAM_DEFINITIONS.length
    && DRYRUN_FIXTURE_TEAM_DEFINITIONS.every((definition) => teams.some((team) => team.team_key === definition.teamKey
      && team.display_name === definition.displayName && team.short_name === definition.shortName))
    && gamesReady;
  return {
    exists: true,
    ready,
    status: competition.status,
    competition: serializeCompetition(competition),
    teams,
    games,
    formalJobs,
    expected: { teams: 4, games: 2, rosterPerGame: 15, formalJobsPerGame: 4 },
    source: { competitionId: DRYRUN_SOURCE_COMPETITION_ID, gameId: DRYRUN_SOURCE_GAME_ID }
  };
}

async function prepareDryRunFixture(request, env, db) {
  const existing = await getCompetition(db, DRYRUN_FIXTURE_ID);
  if (existing?.status === "completed") throw new RequestError(409, "DRYRUN_COMPETITION_COMPLETED", "完了したテスト大会は準備し直せません。");
  const source = await dryRunSourceRoster(db);
  const now = nowIso();
  const statements = [];
  const targetTeams = new Map();
  for (const team of DRYRUN_FIXTURE_TEAM_DEFINITIONS) {
    const existingTeam = await findTeam(db, DRYRUN_FIXTURE_ID, team.teamKey);
    targetTeams.set(team.teamKey, {
      id: existingTeam?.id || uuid(),
      competition_id: DRYRUN_FIXTURE_ID,
      team_key: team.teamKey,
      display_name: team.displayName,
      short_name: team.shortName,
      country_code: team.countryCode
    });
  }
  statements.push(prepared(db, `INSERT INTO competitions
    (id, competition_type, display_name, short_name, start_date, end_date, status, description, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7, ?8, ?8)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
      short_name = excluded.short_name, start_date = excluded.start_date,
      end_date = excluded.end_date, description = excluded.description,
      updated_at = excluded.updated_at
    WHERE competitions.status <> 'completed'`,
    DRYRUN_FIXTURE_ID, COMPETITION_TYPE, DRYRUN_FIXTURE_COMPETITION.displayName,
    DRYRUN_FIXTURE_COMPETITION.shortName, DRYRUN_FIXTURE_COMPETITION.startDate,
    DRYRUN_FIXTURE_COMPETITION.endDate, DRYRUN_FIXTURE_COMPETITION.description, now));
  for (const team of DRYRUN_FIXTURE_TEAM_DEFINITIONS) {
    statements.push(prepared(db, `INSERT INTO teams
      (id, competition_id, team_key, display_name, short_name, country_code, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
      ON CONFLICT(competition_id, team_key) DO UPDATE SET display_name = excluded.display_name,
        short_name = excluded.short_name, country_code = excluded.country_code, updated_at = excluded.updated_at`,
      targetTeams.get(team.teamKey).id, DRYRUN_FIXTURE_ID, team.teamKey, team.displayName, team.shortName, team.countryCode, now));
  }
  for (const definition of DRYRUN_FIXTURE_GAME_DEFINITIONS) {
    const startAt = validIsoDateTime(definition.startAt);
    const deadline = normalizePredictionDeadline(startAt);
    const teams = {
      home: targetTeams.get(definition.homeTeamId),
      away: targetTeams.get(definition.awayTeamId)
    };
    const existingGame = await getGame(db, definition.id);
    if (existingGame && (existingGame.competition_id !== DRYRUN_FIXTURE_ID
      || existingGame.status !== "open" || existingGame.publication_status !== "pending")) {
      throw new RequestError(409, "DRYRUN_GAME_STATE_CONFLICT", `${definition.id}はテスト準備可能な状態ではありません。`);
    }
    statements.push(prepared(db, `INSERT INTO games
      (id, title, competition_type, competition_id, game_source, external_game_code, game_date, start_at,
       prediction_deadline_at, venue, home_team_id, home_team_name, away_team_id, away_team_name,
       status, publication_status, current_lineup_revision, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'manual', NULL, ?5, ?6, ?7, NULL, ?8, ?9, ?10, ?11, 'open', 'pending', NULL, ?12, ?12)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, competition_id = excluded.competition_id,
        game_date = excluded.game_date, start_at = excluded.start_at,
        prediction_deadline_at = excluded.prediction_deadline_at, home_team_id = excluded.home_team_id,
        home_team_name = excluded.home_team_name, away_team_id = excluded.away_team_id,
        away_team_name = excluded.away_team_name, updated_at = excluded.updated_at`,
      definition.id, definition.title, COMPETITION_TYPE, DRYRUN_FIXTURE_ID, definition.gameDate,
      startAt.toISOString(), deadline.toISOString(), teams.home.team_key, teams.home.display_name,
      teams.away.team_key, teams.away.display_name, now));
    statements.push(...buildFormalJobStatements(db, definition.id, deadline.toISOString(), DRYRUN_FIXTURE_ID, now));
  }
  // Validate and prepare all copies before the first batch write. The target
  // IDs are deterministic aliases because players.id is globally unique in
  // the existing per-game schema; APBC source rows are never overwritten.
  for (const definition of DRYRUN_FIXTURE_GAME_DEFINITIONS) {
    const targetTeam = targetTeams.get("jpn");
    for (const player of source.roster) {
      const targetId = dryRunPlayerCopyId(definition.id, player.id);
      const existingPlayer = await prepared(db, "SELECT game_id FROM players WHERE id = ?1 LIMIT 1", targetId).first();
      if (existingPlayer && existingPlayer.game_id !== definition.id) {
        throw new RequestError(409, "DRYRUN_PLAYER_ID_CONFLICT", "テスト選手IDが別試合で使用されています。");
      }
      statements.push(prepared(db, `INSERT INTO players
        (id, game_id, name, uniform_number, team, team_id, position, bat, throw, active, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)
        ON CONFLICT(id) DO UPDATE SET game_id = excluded.game_id, name = excluded.name,
          uniform_number = excluded.uniform_number, team = excluded.team, team_id = excluded.team_id,
          position = excluded.position, bat = excluded.bat, throw = excluded.throw,
          active = excluded.active, updated_at = excluded.updated_at`,
        targetId, definition.id, player.name, player.uniform_number || "", player.team,
        targetTeam.id, player.position, player.bat || null, player.throw || null, now));
    }
  }
  await db.batch(statements);
  const fixture = await dryRunFixtureReadback(db);
  if (!fixture.ready) throw new RequestError(409, "DRYRUN_READBACK_INCOMPLETE", "10/16テスト大会の準備結果を確認できません。", { fixture });
  return json({ ok: true, ready: true, fixture }, 200, request, env);
}

async function activateDryRunFixture(request, env, db) {
  const fixture = await dryRunFixtureReadback(db);
  if (!fixture.exists || !fixture.ready) throw new RequestError(409, "DRYRUN_NOT_READY", "テスト大会の準備が完了していません。");
  if (fixture.status === "completed") throw new RequestError(409, "DRYRUN_COMPETITION_COMPLETED", "完了したテスト大会は変更できません。");
  if (fixture.status === "draft") {
    await prepared(db, "UPDATE competitions SET status = 'active', updated_at = ?1 WHERE id = ?2 AND status = 'draft'", nowIso(), DRYRUN_FIXTURE_ID).run();
  }
  const readback = await dryRunFixtureReadback(db);
  if (readback.status !== "active") throw new RequestError(409, "DRYRUN_ACTIVATION_READBACK_FAILED", "テスト大会の状態を確認できません。");
  return json({ ok: true, fixture: readback }, 200, request, env);
}

function completeFormalJobStatement(db, gameId, jobType, revision, now) {
  return prepared(db, `UPDATE formal_jobs
     SET status = 'completed', revision_number = ?1, artifact_generation = COALESCE(?2, artifact_generation), completed_at = ?3, updated_at = ?3, attempts = attempts + 1
   WHERE game_id = ?4 AND job_type = ?5 AND status <> 'completed'`, revision, null, now, gameId, jobType);
}

function completeRankingJobStatement(db, gameId, revision, generation, now) {
  return prepared(db, `UPDATE formal_jobs
     SET status = 'completed', revision_number = ?1, artifact_generation = ?2, completed_at = ?3, updated_at = ?3, attempts = attempts + 1
   WHERE game_id = ?4 AND job_type = 'ranking_rebuild'
     AND (status <> 'completed' OR artifact_generation IS NULL OR artifact_generation <> ?2)`, revision, generation, now, gameId);
}

function resetFormalJobStatement(db, gameId, jobType, revision, dueAt, now) {
  return prepared(db, `UPDATE formal_jobs
     SET status = 'scheduled', revision_number = ?1, artifact_generation = NULL, completed_at = NULL, due_at = ?2, updated_at = ?3
   WHERE game_id = ?4 AND job_type = ?5`, revision, dueAt, now, gameId, jobType);
}

async function listFormalJobs(db, gameId) {
  const result = await prepared(db, "SELECT id, competition_type, competition_id, job_type, status, revision_number, artifact_generation, due_at, attempts, completed_at, created_at, updated_at FROM formal_jobs WHERE game_id = ?1 ORDER BY due_at ASC, job_type ASC", gameId).all();
  return result.results || [];
}

async function createTeam(request, env, db, admin) {
  const input = await readJson(request);
  const competitionId = validId(input.competitionId) || DEFAULT_COMPETITION_ID;
  const competition = await ensureCompetition(db, competitionId);
  await assertCompetitionMutable(db, competition.id);
  const teamKey = validId(input.teamKey || input.id);
  const displayName = String(input.displayName || input.name || "").trim().slice(0, 80);
  const shortName = String(input.shortName || displayName).trim().slice(0, 40);
  const countryCode = String(input.countryCode || "").trim().toUpperCase().slice(0, 3) || null;
  if (!teamKey || !displayName || !shortName) throw new RequestError(400, "TEAM_INPUT_INVALID", "チームID・表示名・短縮名を確認してください。");
  const now = nowIso();
  try {
    await prepared(db, `INSERT INTO teams (id, competition_id, team_key, display_name, short_name, country_code, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
      ON CONFLICT(competition_id, team_key) DO UPDATE SET display_name = excluded.display_name, short_name = excluded.short_name, country_code = excluded.country_code, updated_at = excluded.updated_at`,
      uuid(), competitionId, teamKey, displayName, shortName, countryCode, now).run();
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("unique")) throw new RequestError(409, "TEAM_DUPLICATE", "同じ大会に同じチームIDがあります。");
    throw error;
  }
  const team = await prepared(db, "SELECT id, competition_id, team_key, display_name, short_name, country_code FROM teams WHERE competition_id = ?1 AND team_key = ?2 LIMIT 1", competitionId, teamKey).first();
  return json({ ok: true, team }, 201, request, env);
}

async function updateCompetition(request, env, db) {
  const input = await readJson(request);
  const id = validId(input.id || input.competitionId) || DEFAULT_COMPETITION_ID;
  const existing = await getCompetition(db, id);
  const displayName = String(input.displayName || input.name || "").trim().slice(0, 120);
  const shortName = String(input.shortName || displayName).trim().slice(0, 60);
  const startDate = input.startDate ? String(input.startDate).trim() : null;
  const endDate = input.endDate ? String(input.endDate).trim() : null;
  const status = Object.prototype.hasOwnProperty.call(input, "status")
    ? String(input.status ?? "").trim().toLowerCase()
    : (existing?.status || "draft");
  const description = String(input.description || "").trim().slice(0, 500) || null;
  if (!displayName || !shortName || !COMPETITION_STATUSES.includes(status)
    || (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate))
    || (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate))
    || (startDate && endDate && startDate > endDate)) {
    throw new RequestError(400, "COMPETITION_INPUT_INVALID", "大会名・期間・状態を確認してください。");
  }
  if (existing?.status === "completed") {
    throw new RequestError(409, "COMPETITION_COMPLETED", "完了した大会は変更できません。");
  }
  const now = nowIso();
  await prepared(db, `INSERT INTO competitions
    (id, competition_type, display_name, short_name, start_date, end_date, status, description, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
      short_name = excluded.short_name, start_date = excluded.start_date,
      end_date = excluded.end_date, status = excluded.status,
      description = excluded.description, updated_at = excluded.updated_at`,
    id, COMPETITION_TYPE, displayName, shortName, startDate, endDate, status, description, now).run();
  return json({ ok: true, competition: serializeCompetition(await getCompetition(db, id)) }, 200, request, env);
}

async function adminCompetitionOverview(request, env, db) {
  const competitionId = validId(new URL(request.url).searchParams.get("competitionId")) || DEFAULT_COMPETITION_ID;
  const competition = await getCompetition(db, competitionId);
  if (!competition) return errorResponse(request, env, 404, "COMPETITION_NOT_FOUND", "対象大会がありません。");
  const games = await listCompetitionGames(request, env, db, competitionId, { includePredictionState: false });
  const teamRows = await getTeams(db, competitionId);
  const jobRows = await prepared(db, `SELECT fj.game_id, fj.job_type, fj.status, fj.revision_number,
      fj.artifact_generation, fj.due_at, fj.attempts, fj.completed_at
    FROM formal_jobs fj JOIN games g ON g.id = fj.game_id
   WHERE fj.competition_type = ?1 AND fj.competition_id = ?2
   ORDER BY g.game_date ASC, g.start_at ASC, fj.due_at ASC, fj.job_type ASC`, COMPETITION_TYPE, competitionId).all();
  return json({ ok: true, competition: serializeCompetition(competition), teams: teamRows, games, formalJobs: jobRows.results || [] }, 200, request, env);
}

function csvRows(value) {
  const text = String(value || "").replace(/^\uFEFF/, "");
  const records = [];
  let row = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  let fieldStarted = false;

  const invalidCsv = () => { throw new RequestError(400, "CSV_INVALID", "CSVの引用符が不正です。"); };

  const pushCell = () => { row.push(cell.trim()); cell = ""; afterQuote = false; fieldStarted = false; };
  const pushRow = () => {
    pushCell();
    if (row.some((value) => value !== "")) records.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; continue; }
      if (char === '"') { quoted = false; afterQuote = true; continue; }
      cell += char;
      continue;
    }
    if (afterQuote) {
      if (char !== "," && char !== "\r" && char !== "\n") invalidCsv();
    }
    if (char === '"') {
      if (fieldStarted) invalidCsv();
      quoted = true;
      fieldStarted = true;
      continue;
    }
    if (char === ",") { pushCell(); continue; }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      pushRow();
      continue;
    }
    cell += char;
    fieldStarted = true;
  }
  if (quoted) throw new RequestError(400, "CSV_INVALID", "CSVの引用符が閉じていません。");
  if (cell !== "" || row.length) pushRow();
  if (!records.length) return [];
  const headers = records[0].map((header) => header.trim());
  return records.slice(1).map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] ?? ""])));
}

function importRows(input, key) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.[key])) return input[key];
  if (typeof input?.csv === "string") return csvRows(input.csv);
  return [];
}

function validUniformNumber(value) {
  const text = String(value ?? "").trim();
  return text === "" || /^(?:0|[1-9]\d{0,2})$/.test(text) ? text : null;
}

function normalizePlayerMetadata(value = {}, existing = null) {
  const has = (key, alias) => Object.prototype.hasOwnProperty.call(value, key) || (alias && Object.prototype.hasOwnProperty.call(value, alias));
  const rawRegisteredPosition = value.registeredPosition
    ?? value.registered_position
    ?? value.position
    ?? value.primaryPosition;
  const hasRegisteredPosition = ["registeredPosition", "registered_position", "position", "primaryPosition"]
    .some((key) => Object.prototype.hasOwnProperty.call(value, key));
  const registeredPosition = hasRegisteredPosition ? String(rawRegisteredPosition || "").trim() : String(existing?.position || "").trim();
  const uniformValue = has("uniformNumber", "uniform_number") ? (value.uniformNumber ?? value.uniform_number) : existing?.uniform_number;
  const uniformNumber = validUniformNumber(uniformValue);
  const bat = has("bat", "battingHand") ? String(value.bat ?? value.battingHand ?? "").trim().slice(0, 12) || null : (existing?.bat || null);
  const throwing = has("throw", "throwingHand") ? String(value.throw ?? value.throwingHand ?? "").trim().slice(0, 12) || null : (existing?.throw || null);
  const active = has("active") ? (value.active === false || String(value.active).toLowerCase() === "false" ? 0 : 1) : Number(existing?.active ?? 1) ? 1 : 0;
  const rawClub = value.club ?? value.affiliation ?? value.teamName ?? (Object.prototype.hasOwnProperty.call(value, "team") ? value.team : existing?.team);
  const club = String(rawClub || "").trim().slice(0, 40) || null;
  if (uniformNumber === null || (registeredPosition && !PLAYER_POSITIONS.includes(registeredPosition) && !REGISTERED_POSITIONS.includes(registeredPosition))) {
    throw new RequestError(400, "PLAYER_METADATA_INVALID", "登録区分・背番号・選手metadataを確認してください。");
  }
  return { position: registeredPosition, registeredPosition, club, uniformNumber: uniformNumber ?? "", bat, throwing, active };
}

async function bulkImportPlayers(request, env, db) {
  const input = await readJson(request);
  const gameId = validId(input.gameId || input.id);
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  await assertGameCompetitionMutable(db, game);
  const rows = importRows(input, "players");
  if (!rows.length || rows.length > 200) throw new RequestError(400, "PLAYERS_INVALID", "選手データを確認してください。");
  const preparedRows = [];
  const seenNames = new Set();
  const seenIds = new Set();
  for (const value of rows) {
    const name = String(value.name || value.playerName || value.player_name || "").trim().slice(0, 80);
    const requestedId = validId(value.id || value.playerId || value.player_id);
    const team = await validatePlayerTeam(db, game, value.teamId || value.team_id || value.teamKey || value.team_key || value.team);
    const metadata = normalizePlayerMetadata(value);
    if (!name || !team || !metadata.position || seenNames.has(name) || (requestedId && seenIds.has(requestedId))) {
      throw new RequestError(400, "PLAYERS_INVALID", "選手名・チーム・守備位置・背番号の重複または不正を確認してください。");
    }
    if (requestedId) {
      const existing = await prepared(db, "SELECT game_id FROM players WHERE id = ?1 LIMIT 1", requestedId).first();
      if (existing && existing.game_id !== gameId) throw new RequestError(409, "PLAYER_ID_CONFLICT", "別試合の選手IDは再利用できません。");
      seenIds.add(requestedId);
    }
    seenNames.add(name);
    preparedRows.push({ id: requestedId || uuid(), name, team, ...metadata });
  }
  const now = nowIso();
  await db.batch(preparedRows.map((row) => prepared(db, `INSERT INTO players
    (id, game_id, name, uniform_number, team, team_id, position, bat, throw, active, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, uniform_number = excluded.uniform_number,
      team = excluded.team, team_id = excluded.team_id, position = excluded.position, bat = excluded.bat,
      throw = excluded.throw, active = excluded.active, updated_at = excluded.updated_at`,
    row.id, gameId, row.name, row.uniformNumber, row.club || row.team.display_name, row.team.id, row.position, row.bat, row.throwing, row.active, now)));
  return json({ ok: true, imported: preparedRows.length, players: serializePlayers(await getPlayers(db, gameId)) }, 200, request, env);
}

async function bulkImportGames(request, env, db) {
  const input = await readJson(request);
  const competitionId = validId(input.competitionId) || DEFAULT_COMPETITION_ID;
  const rows = importRows(input, "games");
  if (!rows.length || rows.length > 100) throw new RequestError(400, "GAMES_INVALID", "試合データを確認してください。");
  // Bulk import is a commit boundary: an invalid payload must not bootstrap a
  // competition as a side effect. Existing competitions are checked read-only;
  // a missing competition is bootstrapped only after every row is validated.
  const competition = await getCompetition(db, competitionId);
  if (competition?.status === "completed") throw new RequestError(409, "COMPETITION_COMPLETED", "完了した大会は変更できません。");
  const preparedRows = [];
  const seenIds = new Set();
  const competitionTeams = await getTeams(db, competitionId);
  for (const value of rows) {
    const id = validId(value.id || value.gameId) || uuid();
    const title = String(value.title || value.name || "Asia CS").trim().slice(0, 120);
    const gameDate = String(value.gameDate || value.game_date || "").trim();
    const startAt = validIsoDateTime(value.startAt || value.start_at);
    let deadline = null;
    let deadlineError = null;
    try {
      deadline = normalizePredictionDeadline(startAt, value.predictionDeadlineAt ?? value.prediction_deadline_at);
    } catch (error) {
      deadlineError = error;
    }
    const homeTeamId = validId(value.homeTeamId || value.home_team_id || value.homeTeam || value.home_team);
    const awayTeamId = validId(value.awayTeamId || value.away_team_id || value.awayTeam || value.away_team);
    const exists = await getGame(db, id);
    const invalidShape = !title || !/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || !startAt || !deadline
      || deadline.getTime() >= startAt.getTime() || tokyoCalendarDate(startAt) !== gameDate;
    if (invalidShape) {
      // Preserve the established missing-competition error precedence without
      // creating the competition before the payload has passed validation.
      if (!competition) throw new RequestError(404, "COMPETITION_NOT_FOUND", "対象大会がありません。");
      if (deadlineError) throw deadlineError;
      throw new RequestError(400, "GAMES_INVALID", "試合日・開始日時・締切・対戦チームのいずれかが不正です。");
    }
    const teams = await validateGameTeams(db, competitionId, homeTeamId, awayTeamId);
    if (exists || seenIds.has(id) || !teams.home || !teams.away) {
      throw new RequestError(400, "GAMES_INVALID", "試合日・開始日時・締切・対戦チームのいずれかが不正です。");
    }
    seenIds.add(id);
    preparedRows.push({
      id,
      title,
      gameDate,
      startAt,
      deadline,
      teams,
      venue: String(value.venue || "").trim().slice(0, 120) || null,
      externalGameCode: String(value.externalGameCode || value.external_game_code || "").trim().slice(0, 80) || null
    });
  }
  const now = nowIso();
  const statements = [];
  if (!competition) {
    statements.push(prepared(db, `INSERT OR IGNORE INTO competitions
      (id, competition_type, display_name, short_name, status, created_at, updated_at)
      VALUES (?1, ?2, ?1, ?1, 'draft', ?3, ?3)`, competitionId, COMPETITION_TYPE, now));
  }
  for (const row of preparedRows) {
    const jobTypes = formalJobTypesForGame({
      home_team_id: row.teams.home.team_key,
      home_team_name: row.teams.home.display_name,
      away_team_id: row.teams.away.team_key,
      away_team_name: row.teams.away.display_name
    }, competitionTeams);
    statements.push(prepared(db, `INSERT INTO games
      (id, title, competition_type, competition_id, game_source, external_game_code, game_date, start_at, prediction_deadline_at, venue, home_team_id, home_team_name, away_team_id, away_team_name, status, publication_status, current_lineup_revision, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'open', 'pending', NULL, ?14, ?14)`, row.id, row.title, COMPETITION_TYPE, competitionId, row.externalGameCode, row.gameDate, row.startAt.toISOString(), row.deadline.toISOString(), row.venue, row.teams.home.team_key, row.teams.home.display_name, row.teams.away.team_key, row.teams.away.display_name, now));
    statements.push(...buildFormalJobStatements(db, row.id, row.deadline.toISOString(), competitionId, now, jobTypes));
  }
  await db.batch(statements);
  return json({ ok: true, imported: preparedRows.length, games: await listCompetitionGames(request, env, db, competitionId, { includePredictionState: false }) }, 200, request, env);
}

async function listTeams(request, env, db) {
  const competitionId = validId(new URL(request.url).searchParams.get("competitionId")) || DEFAULT_COMPETITION_ID;
  return json({ ok: true, competitionType: COMPETITION_TYPE, competitionId, teams: await getTeams(db, competitionId) }, 200, request, env);
}

async function createGame(request, env, db, admin) {
  const input = await readJson(request);
  const title = String(input.title || "Asia CS").trim().slice(0, 120);
  const startAt = validIsoDateTime(input.startAt);
  const gameDate = String(input.gameDate || "").trim();
  const deadline = normalizePredictionDeadline(startAt, input.predictionDeadlineAt);
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || !startAt || !deadline || deadline.getTime() >= startAt.getTime() || tokyoCalendarDate(startAt) !== gameDate) {
    throw new RequestError(400, "GAME_INPUT_INVALID", "試合名・試合日・開始日時・締切日時を確認してください。");
  }
  const competitionId = validId(input.competitionId) || DEFAULT_COMPETITION_ID;
  const competition = await ensureCompetition(db, competitionId);
  await assertCompetitionMutable(db, competition.id);
  const homeTeamId = validId(input.homeTeamId || input.homeTeam?.id);
  const awayTeamId = validId(input.awayTeamId || input.awayTeam?.id);
  const homeTeamName = String(input.homeTeamName || input.homeTeam?.name || "").trim().slice(0, 80) || null;
  const awayTeamName = String(input.awayTeamName || input.awayTeam?.name || "").trim().slice(0, 80) || null;
  if ((homeTeamId && !homeTeamName) || (awayTeamId && !awayTeamName)) throw new RequestError(400, "TEAM_INPUT_INVALID", "対戦チーム名を確認してください。");
  const teams = await validateGameTeams(db, competitionId, homeTeamId, awayTeamId);
  const competitionTeams = await getTeams(db, competitionId);
  const id = validId(input.id) || uuid();
  const now = nowIso();
  const game = {
    id,
    competitionId,
    predictionDeadlineAt: deadline.toISOString()
  };
  const jobTypes = formalJobTypesForGame({
    home_team_id: teams.home?.team_key || null,
    home_team_name: teams.home?.display_name || homeTeamName,
    away_team_id: teams.away?.team_key || null,
    away_team_name: teams.away?.display_name || awayTeamName
  }, competitionTeams);
  await db.batch([
    prepared(db, `INSERT INTO games (id, title, competition_type, competition_id, game_source, external_game_code, game_date, start_at, prediction_deadline_at, venue, home_team_id, home_team_name, away_team_id, away_team_name, status, publication_status, current_lineup_revision, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'open', 'pending', NULL, ?14, ?14)`, id, title, COMPETITION_TYPE, competitionId, String(input.externalGameCode || "").trim().slice(0, 80) || null, gameDate, startAt.toISOString(), deadline.toISOString(), String(input.venue || "").trim().slice(0, 120) || null, teams.home ? teams.home.team_key : null, teams.home ? teams.home.display_name : null, teams.away ? teams.away.team_key : null, teams.away ? teams.away.display_name : null, now),
    ...buildFormalJobStatements(db, id, deadline.toISOString(), competitionId, now, jobTypes)
  ]);
  return json({ ok: true, game: serializeGame(await getGame(db, id), []) }, 201, request, env);
}

function placementGameDefinition(placementType) {
  const definition = APBC_PLACEMENT_GAME_DEFINITIONS[String(placementType || "").trim()];
  if (!definition) throw new RequestError(400, "PLACEMENT_TYPE_INVALID", "順位決定戦の種類を確認してください。");
  return definition;
}

async function latestJapanRoster(db, games, teams) {
  const japanTeam = teams.find(isJapanTeam);
  if (!japanTeam) return null;
  const japanGames = games
    .filter((game) => gameHasJapanTeam(game, teams))
    .sort((left, right) => `${right.game_date}|${right.start_at}|${right.id}`.localeCompare(`${left.game_date}|${left.start_at}|${left.id}`));
  for (const game of japanGames) {
    const roster = (await getPlayers(db, game.id, true)).filter((player) =>
      teamMatchesGameReference(japanTeam, player.team_id, player.team)
    );
    if (roster.length === 15) return { game, roster, japanTeam };
  }
  return null;
}

async function createPlacementGame(request, env, db, admin) {
  const input = await readJson(request);
  const competitionId = validId(input.competitionId) || "apbc-2026";
  if (competitionId !== "apbc-2026") throw new RequestError(400, "PLACEMENT_COMPETITION_INVALID", "APBC 2026を指定してください。");
  const competition = await assertCompetitionMutable(db, competitionId);
  const definition = placementGameDefinition(input.placementType || "final");
  const teams = await getTeams(db, competitionId);
  const japanTeam = teams.find(isJapanTeam);
  const opponent = await findTeam(db, competitionId, input.opponentTeamId);
  const japanSide = String(input.japanSide || "").trim().toLowerCase();
  if (!japanTeam || !opponent || opponent.id === japanTeam.id || isJapanTeam(opponent) || !["home", "away"].includes(japanSide)) {
    throw new RequestError(400, "PLACEMENT_TEAMS_INVALID", "日本代表・対戦相手・ホーム／ビジターを確認してください。");
  }
  const gamesResult = await prepared(db, "SELECT * FROM games WHERE competition_type = ?1 AND competition_id = ?2", COMPETITION_TYPE, competitionId).all();
  const games = gamesResult.results || [];
  if (games.some((game) => game.game_date === APBC_PLACEMENT_DATE && gameHasJapanTeam(game, teams))) {
    throw new RequestError(409, "PLACEMENT_GAME_EXISTS", "順位決定戦はすでに登録されています。");
  }
  const id = `apbc-2026-g${definition.gameNumber}`;
  if (games.some((game) => game.id === id)) {
    throw new RequestError(409, "PLACEMENT_GAME_EXISTS", "順位決定戦はすでに登録されています。");
  }
  const source = await latestJapanRoster(db, games, teams);
  if (!source) throw new RequestError(409, "JAPAN_ROSTER_REQUIRED", "最新の日本代表15名ロースターが必要です。");
  const startAt = validIsoDateTime(definition.startAt);
  const deadline = normalizePredictionDeadline(startAt);
  const home = japanSide === "home" ? japanTeam : opponent;
  const away = japanSide === "home" ? opponent : japanTeam;
  const now = nowIso();
  const title = `GAME${definition.gameNumber} ${definition.title}: ${home.display_name} vs ${away.display_name}`;
  const jobStatements = buildFormalJobStatements(db, id, deadline.toISOString(), competition.id, now, FORMAL_JOB_TYPES);
  const rosterStatements = source.roster.map((player) => prepared(db, `INSERT INTO players
      (id, game_id, name, uniform_number, team, team_id, position, bat, throw, active, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)`,
    uuid(), id, player.name, player.uniform_number, player.team, japanTeam.id, player.position, player.bat, player.throw, now));
  await db.batch([
    prepared(db, `INSERT INTO games
      (id, title, competition_type, competition_id, game_source, external_game_code, game_date, start_at, prediction_deadline_at,
       home_team_id, home_team_name, away_team_id, away_team_name, status, publication_status, current_lineup_revision, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'manual', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'open', 'pending', NULL, ?13, ?13)`,
    id, title, COMPETITION_TYPE, competition.id, `GAME${definition.gameNumber}`, APBC_PLACEMENT_DATE, startAt.toISOString(), deadline.toISOString(),
    home.team_key, home.display_name, away.team_key, away.display_name, now),
    ...rosterStatements,
    ...jobStatements
  ]);
  const game = await getGame(db, id);
  return json({
    ok: true,
    game: serializeGame(game, await getPlayers(db, id), teams),
    placementType: input.placementType || "final",
    rosterCopiedFromGameId: source.game.id,
    rosterCount: source.roster.length,
    formalJobTypes: FORMAL_JOB_TYPES
  }, 201, request, env);
}

async function upsertPlayers(request, env, db, gameId) {
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  await assertGameCompetitionMutable(db, game);
  const input = await readJson(request);
  const players = Array.isArray(input.players) ? input.players : [input];
  if (!players.length || players.length > 200) throw new RequestError(400, "PLAYERS_INVALID", "出場選手を確認してください。");
  const now = nowIso();
  const statements = [];
  for (const value of players) {
    const requestedId = validId(value.id || value.playerId);
    let id = requestedId || uuid();
    let existing = null;
    if (requestedId) {
      existing = await prepared(db, "SELECT * FROM players WHERE id = ?1 LIMIT 1", requestedId).first();
      // Player rows are intentionally scoped to a game. Reusing a client-side
      // player ID from another game must create a new row instead of letting
      // SQLite's global primary key redirect an upsert into the old roster.
      if (existing && existing.game_id !== gameId) id = uuid();
    }
    const name = String(value.name || value.playerName || "").trim().slice(0, 80);
    if (!name) throw new RequestError(400, "PLAYER_NAME_REQUIRED", "選手名を入力してください。");
    const team = await validatePlayerTeam(db, game, value.teamId || value.team_id);
    const metadata = normalizePlayerMetadata(value, existing?.game_id === gameId ? existing : null);
    const teamId = team?.id || null;
    statements.push(prepared(db, `INSERT INTO players (id, game_id, name, uniform_number, team, team_id, position, bat, throw, active, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, uniform_number = excluded.uniform_number, team = excluded.team, team_id = excluded.team_id, position = excluded.position, bat = excluded.bat, throw = excluded.throw, active = excluded.active, updated_at = excluded.updated_at`,
      id, gameId, name, metadata.uniformNumber, metadata.club || team?.display_name || String(value.team || existing?.team || "").trim().slice(0, 40), teamId, metadata.position, metadata.bat, metadata.throwing, metadata.active, now));
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("unique")) throw new RequestError(409, "PLAYER_DUPLICATE", "同じ試合に同名の選手があります。");
    throw error;
  }
  return json({ ok: true, players: serializePlayers(await getPlayers(db, gameId)) }, 200, request, env);
}

async function updatePlayer(request, env, db, gameId, playerId) {
  const id = validId(playerId);
  if (!id) throw new RequestError(400, "PLAYER_ID_INVALID", "選手IDが不正です。");
  const input = await readJson(request);
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  await assertGameCompetitionMutable(db, game);
  const name = String(input.name || input.playerName || "").trim().slice(0, 80);
  if (!name) throw new RequestError(400, "PLAYER_NAME_REQUIRED", "選手名を入力してください。");
  const existing = await prepared(db, "SELECT * FROM players WHERE id = ?1 AND game_id = ?2 LIMIT 1", id, gameId).first();
  if (!existing) return errorResponse(request, env, 404, "PLAYER_NOT_FOUND", "選手がありません。");
  const team = await validatePlayerTeam(db, game, input.teamId || input.team_id);
  const metadata = normalizePlayerMetadata(input, existing);
  const teamId = team?.id || null;
  const result = await prepared(db, `UPDATE players SET name = ?1, uniform_number = ?2, team = ?3, team_id = ?4, position = ?5, bat = ?6, throw = ?7, active = ?8, updated_at = ?9 WHERE id = ?10 AND game_id = ?11`, name, metadata.uniformNumber, metadata.club || team?.display_name || String(input.team || existing.team || "").trim().slice(0, 40), teamId, metadata.position, metadata.bat, metadata.throwing, metadata.active, nowIso(), id, gameId).run();
  if (!Number(result?.meta?.changes || 0)) return errorResponse(request, env, 404, "PLAYER_NOT_FOUND", "選手がありません。");
  return json({ ok: true, player: serializePlayer(await prepared(db, "SELECT id, game_id, name, uniform_number, team, team_id, position, bat, throw, active FROM players WHERE id = ?1", id).first()) }, 200, request, env);
}

async function getRosterIds(db, gameId) {
  return new Set((await getPlayers(db, gameId, true)).map((player) => player.id));
}

async function saveInitialLineup(request, env, db, gameId, admin) {
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  await assertGameCompetitionMutable(db, game);
  if (["scored", "published"].includes(game.status)) return errorResponse(request, env, 409, "LINEUP_REVISION_REQUIRED", "採点済みの正式スタメンは修正操作を使用してください。");
  const input = await readJson(request);
  const candidate = validateLineup(input.lineup, { label: "正式スタメン", rosterIds: await getRosterIds(db, gameId) });
  if (!candidate.ok) return errorResponse(request, env, 400, candidate.code, candidate.error);
  await validateLineupTeamOwnership(db, game, candidate.lineup, input.teamId || input.lineupTeamId);
  const previous = await prepared(db, "SELECT COALESCE(MAX(revision_number), 0) AS revision FROM lineup_revisions WHERE game_id = ?1", gameId).first();
  const revision = Number(previous?.revision || 0) + 1;
  const now = nowIso();
  const fingerprint = await sha256Hex(JSON.stringify(candidate.lineup));
  const current = await prepared(db, "SELECT revision_number, lineup_json, fingerprint FROM lineup_revisions WHERE game_id = ?1 AND is_current = 1 LIMIT 1", gameId).first();
  if (current?.fingerprint === fingerprint) {
    return json({ ok: true, noop: true, game: serializeGame(game, await getPlayers(db, gameId)), lineupRevision: { revision: Number(current.revision_number), lineup: JSON.parse(current.lineup_json), fingerprint } }, 200, request, env);
  }
  await db.batch([
    prepared(db, "UPDATE lineup_revisions SET is_current = 0 WHERE game_id = ?1 AND is_current = 1", gameId),
    prepared(db, `INSERT INTO lineup_revisions (id, game_id, revision_number, lineup_json, fingerprint, is_current, confirmed_at, confirmed_by, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?6)`, uuid(), gameId, revision, JSON.stringify(candidate.lineup), fingerprint, now, admin.id),
    prepared(db, "UPDATE games SET status = 'lineup_confirmed', current_lineup_revision = ?1, updated_at = ?2 WHERE id = ?3", revision, now, gameId)
  ]);
  return json({ ok: true, game: serializeGame(await getGame(db, gameId), await getPlayers(db, gameId)), lineupRevision: { revision, lineup: candidate.lineup, fingerprint } }, 200, request, env);
}

async function currentLineup(db, gameId) {
  const row = await prepared(db, "SELECT revision_number, lineup_json, fingerprint, confirmed_at FROM lineup_revisions WHERE game_id = ?1 AND is_current = 1 LIMIT 1", gameId).first();
  if (!row) return null;
  return { revision: Number(row.revision_number), lineup: JSON.parse(row.lineup_json), fingerprint: row.fingerprint, confirmedAt: row.confirmed_at };
}

function scoringLockInsert(db, { lockId, gameId, revision, kind, adminId, startedAt }) {
  return prepared(db, `INSERT INTO scoring_runs (id, game_id, revision_number, kind, processed_count, score_changed_count, started_at, completed_at, created_by)
    SELECT ?1, ?2, ?3, ?4, 0, 0, ?5, NULL, ?6
      WHERE NOT EXISTS (
        SELECT 1 FROM scoring_runs
         WHERE game_id = ?2 AND revision_number = ?3 AND kind = ?4
      )`, lockId, gameId, revision, kind, startedAt, adminId);
}

function scoringLockPredicate(startIndex) {
  return `EXISTS (
    SELECT 1 FROM scoring_runs
     WHERE id = ?${startIndex}
       AND game_id = ?${startIndex + 1}
       AND revision_number = ?${startIndex + 2}
       AND kind = ?${startIndex + 3}
       AND completed_at IS NULL
  )`;
}

async function completedScoringRun(db, lockId) {
  return prepared(db, "SELECT id, game_id, revision_number, kind, processed_count, score_changed_count, completed_at FROM scoring_runs WHERE id = ?1 AND completed_at IS NOT NULL LIMIT 1", lockId).first();
}

async function prepareScoring(db, gameId, game, lineup, revision, admin, kind, lockId) {
  const rowsResult = await prepared(db, "SELECT * FROM predictions WHERE game_id = ?1 ORDER BY updated_at ASC, id ASC", gameId).all();
  const rows = rowsResult.results || [];
  const updates = [];
  let changed = 0;
  let scored = 0;
  let invalid = 0;
  const outcomes = [];
  for (const row of rows) {
    let parsed;
    try { parsed = JSON.parse(row.prediction_json); } catch { parsed = null; }
    const candidate = validateLineup(Array.isArray(parsed) ? parsed : parsed?.lineup, { label: "予想" });
    const eligible = isPredictionEligible({ valid: candidate.ok, complete: candidate.ok, duplicatePlayer: candidate.code === "DUPLICATE_PLAYER", duplicateOrder: candidate.code === "DUPLICATE_BATTING_ORDER", savedBeforeDeadline: new Date(row.submitted_at).getTime() < new Date(game.prediction_deadline_at).getTime(), isTestPrediction: Number(row.is_test_prediction) === 1, userEligible: true });
    let score = null;
    let status = "invalid";
    if (eligible.eligible && candidate.ok) {
      score = scoreLineup(candidate.lineup, lineup).total;
      status = "scored";
      scored += 1;
    } else {
      invalid += 1;
    }
    if (row.score !== score || row.status !== status || Number(row.scored_revision || 0) !== revision) changed += 1;
    outcomes.push({ id: row.id, score, status });
    const lockPredicate = scoringLockPredicate(8);
    updates.push(prepared(db, `UPDATE predictions SET status = ?1, score = ?2, max_score = ?3, scored_revision = ?4, actual_lineup_json = ?5, scored_at = ?6 WHERE id = ?7 AND ${lockPredicate}`, status, score, score === null ? null : MAX_SCORE, revision, JSON.stringify(lineup), nowIso(), row.id, lockId, gameId, revision, kind));
  }
  return { updates, rows, outcomes, scored, invalid, changed, revision, gameId, adminId: admin.id, kind, lockId };
}

async function commitScoring(db, game, plan) {
  const now = nowIso();
  const lockPredicate = scoringLockPredicate(3);
  const statements = [
    scoringLockInsert(db, { ...plan, startedAt: now }),
    ...plan.updates,
    prepared(db, `UPDATE games SET status = 'scored', publication_status = 'pending', updated_at = ?1
       WHERE id = ?2 AND status = 'lineup_confirmed' AND ${lockPredicate}`, now, plan.gameId, plan.lockId, plan.gameId, plan.revision, plan.kind),
    completeFormalJobStatement(db, plan.gameId, "prediction_close", plan.revision, now),
    completeFormalJobStatement(db, plan.gameId, "score", plan.revision, now),
    prepared(db, `UPDATE scoring_runs SET processed_count = ?1, score_changed_count = ?2, completed_at = ?3
       WHERE id = ?4 AND completed_at IS NULL`, plan.rows.length, plan.changed, now, plan.lockId)
  ];
  await db.batch(statements);
  const completed = await completedScoringRun(db, plan.lockId);
  if (!completed) throw new RequestError(409, "SCORING_CONFLICT", "別の採点処理が先に完了しました。");
  return { processed: plan.rows.length, scored: plan.scored, invalid: plan.invalid, scoreChangedCount: plan.changed, revision: plan.revision, completedAt: now };
}

async function scoreGame(request, env, db, gameId, admin) {
  const game = await getGame(db, gameId);
  if (game) await assertGameCompetitionMutable(db, game);
  if (game && !await persistedGamePredictionEligible(db, game)) return predictionNotEligibleResponse(request, env);
  const lineup = await currentLineup(db, gameId);
  if (!game || !lineup) return errorResponse(request, env, 409, "LINEUP_REQUIRED", "正式スタメンを先に確定してください。");
  await ensureFormalJobs(db, game);
  if (game.status !== "lineup_confirmed") return errorResponse(request, env, 409, "INITIAL_SCORING_NOT_ALLOWED", "初回採点は正式スタメン確定後に一度だけ実行できます。");
  if (new Date().getTime() < new Date(game.prediction_deadline_at).getTime()) return errorResponse(request, env, 409, "PREDICTION_OPEN", "締切前は採点できません。");
  const plan = await prepareScoring(db, gameId, game, lineup.lineup, lineup.revision, admin, "initial", uuid());
  const result = await commitScoring(db, game, plan);
  return json({ ok: true, gameId, ...result }, 200, request, env);
}

async function rebuildCompetitionRanking(db, game, revision, now) {
  const competitionTeams = await getTeams(db, game.competition_id);
  let eligibleGameIds = null;
  if (competitionTeams.some(isJapanTeam)) {
    const competitionGames = await prepared(db, `SELECT id, home_team_id, home_team_name, away_team_id, away_team_name
      FROM games WHERE competition_type = ?1 AND competition_id = ?2`, COMPETITION_TYPE, game.competition_id).all();
    eligibleGameIds = (competitionGames.results || [])
      .filter((candidate) => isGamePredictionEligible(candidate, competitionTeams))
      .map((candidate) => candidate.id);
  }
  const eligibleGameFilter = eligibleGameIds
    ? `AND g.id IN (${eligibleGameIds.map((_, index) => `?${index + 4}`).join(",")})`
    : "";
  const rowsResult = await prepared(db, `SELECT p.user_id, u.username,
      SUM(p.score) AS score_total, COUNT(DISTINCT p.game_id) AS games_count
    FROM predictions p
    JOIN games g ON g.id = p.game_id
    JOIN users u ON u.id = p.user_id
   WHERE g.competition_type = ?1 AND g.competition_id = ?2
     AND g.status IN ('scored', 'published')
      AND (g.id = ?3 OR g.publication_status = 'published')
      AND p.status = 'scored' AND p.score IS NOT NULL
      AND p.scored_revision = g.current_lineup_revision
      AND u.status = 'active'
      ${eligibleGameFilter}
    GROUP BY p.user_id, u.username
     ORDER BY score_total DESC, games_count DESC, p.user_id ASC`, COMPETITION_TYPE, game.competition_id, game.id, ...(eligibleGameIds || [])).all();
  const rows = rowsResult.results || [];
  const publicationState = await prepared(db, "SELECT publication_revision FROM competition_publication_state WHERE competition_id = ?1 LIMIT 1", game.competition_id).first();
  const basePublicationRevision = Number(publicationState?.publication_revision || 0);
  const generation = uuid();
  const statements = [
    prepared(db, `INSERT INTO competition_publication_state (competition_id, publication_revision, updated_at)
      VALUES (?1, 0, ?2)
      ON CONFLICT(competition_id) DO NOTHING`, game.competition_id, now),
    prepared(db, `INSERT INTO competition_ranking_generations
      (competition_id, generation, target_game_id, base_publication_revision, status, created_at, published_at)
      VALUES (?1, ?2, ?3, ?4, 'built', ?5, NULL)`, game.competition_id, generation, game.id, basePublicationRevision, now)
  ];
  rows.forEach((row, index) => statements.push(prepared(db, `INSERT INTO competition_ranking_entries
    (competition_id, generation, user_id, score_total, games_count, rank, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`, game.competition_id, generation, row.user_id, Number(row.score_total || 0), Number(row.games_count || 0), index + 1, now)));
  // Bind the generation to the exact ranking job in the same D1 batch. A
  // failed rebuild therefore cannot leave a completed job pointing at a
  // partial or unrelated artifact.
  statements.push(completeRankingJobStatement(db, game.id, revision, generation, now));
  await db.batch(statements);
  return { generation, rows };
}

async function rankingGame(request, env, db, gameId) {
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  await assertGameCompetitionMutable(db, game);
  if (!await persistedGamePredictionEligible(db, game)) return predictionNotEligibleResponse(request, env);
  if (!["scored", "published"].includes(game.status)) return errorResponse(request, env, 409, "SCORING_REQUIRED", "採点済みの試合だけランキングを更新できます。");
  await ensureFormalJobs(db, game);
  const revision = Number(game.current_lineup_revision);
  const completed = await prepared(db, "SELECT 1 FROM scoring_runs WHERE game_id = ?1 AND revision_number = ?2 AND completed_at IS NOT NULL LIMIT 1", gameId, revision).first();
  if (!completed) return errorResponse(request, env, 409, "SCORING_INCOMPLETE", "採点処理が完了していません。");
  const job = await prepared(db, "SELECT status, revision_number, artifact_generation FROM formal_jobs WHERE game_id = ?1 AND job_type = 'ranking_rebuild' LIMIT 1", gameId).first();
  const artifactGeneration = String(job?.artifact_generation || "").trim();
  if (job?.status === "completed" && Number(job.revision_number) === revision && artifactGeneration) {
    const state = await prepared(db, "SELECT publication_revision FROM competition_publication_state WHERE competition_id = ?1 LIMIT 1", game.competition_id).first();
    const artifact = await prepared(db, `SELECT base_publication_revision
      FROM competition_ranking_generations
     WHERE competition_id = ?1 AND generation = ?2 AND target_game_id = ?3`, game.competition_id, artifactGeneration, gameId).first();
    if (state && artifact && Number(artifact.base_publication_revision || 0) === Number(state.publication_revision || 0)) {
      return json({ ok: true, gameId, revision, noop: true, generation: artifactGeneration, ranking: await listCompetitionRanking(db, game.competition_id, false, true, artifactGeneration) }, 200, request, env);
    }
  }
  const now = nowIso();
  const rebuilt = await rebuildCompetitionRanking(db, game, revision, now);
  return json({ ok: true, gameId, revision, generation: rebuilt.generation, rows: rebuilt.rows.length }, 200, request, env);
}

async function listCompetitionRanking(db, competitionId, publicOnly = true, includeGeneration = false, generation = null) {
  const selectedGeneration = generation === null || generation === undefined ? "" : String(generation).trim();
  const generationFilter = selectedGeneration
    ? "JOIN competition_ranking_generations selected ON selected.competition_id = r.competition_id AND selected.generation = r.generation AND selected.generation = ?2"
    : "JOIN competition_ranking_publications rp ON rp.competition_id = r.competition_id AND rp.generation = r.generation";
  const result = await prepared(db, `SELECT r.rank, r.user_id, u.username, r.score_total, r.games_count, r.generation
    FROM competition_ranking_entries r JOIN users u ON u.id = r.user_id
    ${generationFilter}
   WHERE r.competition_id = ?1
   ORDER BY r.rank ASC, r.user_id ASC`, ...(selectedGeneration ? [competitionId, selectedGeneration] : [competitionId])).all();
  return (result.results || []).map((row) => ({
    rank: Number(row.rank), username: row.username,
    score: Number(row.score_total), gamesCount: Number(row.games_count),
    ...(publicOnly ? {} : { userId: row.user_id }),
    ...(includeGeneration ? { generation: String(row.generation) } : {})
  }));
}

async function publicRanking(request, env, db) {
  const rawCompetitionId = new URL(request.url).searchParams.get("competitionId");
  const competitionId = validId(rawCompetitionId);
  if (!competitionId) return errorResponse(request, env, 400, "COMPETITION_REQUIRED", "competitionIdを指定してください。");
  return json({ ok: true, competitionType: COMPETITION_TYPE, competitionId, ranking: await listCompetitionRanking(db, competitionId, true) }, 200, request, env);
}

async function publicBestNine(request, env, db) {
  const competitionId = validId(new URL(request.url).searchParams.get("competitionId")) || DEFAULT_COMPETITION_ID;
  if (!await getCompetition(db, competitionId)) return errorResponse(request, env, 404, "COMPETITION_NOT_FOUND", "対象大会がありません。");
  const teams = await getTeams(db, competitionId);
  const result = await prepared(db, `SELECT id, current_lineup_revision
      FROM games
     WHERE competition_type = ?1 AND competition_id = ?2
       AND status = 'published' AND publication_status = 'published'
       AND current_lineup_revision IS NOT NULL
    ORDER BY game_date ASC, start_at ASC, id ASC`, COMPETITION_TYPE, competitionId).all();
  const playersByGame = new Map();
  const selections = new Map();
  const eligibleGames = [];
  for (const game of result.results || []) {
    const sourceGame = await getGame(db, game.id);
    if (isGamePredictionEligible(sourceGame, teams)) eligibleGames.push(game);
  }
  for (const game of eligibleGames) {
    const lineup = await currentLineup(db, game.id);
    const players = await getPlayers(db, game.id);
    const playerById = new Map(players.map((player) => [player.id, player]));
    for (const item of lineup?.lineup || []) {
      const player = playerById.get(item.playerId);
      if (!player) continue;
      // Player records are scoped to a game in the Phase 1 schema. Include the
      // team scope so same-name players from separate games cannot collapse
      // into one tournament Best Nine entry.
      const key = `${player.team_id || player.team}\u0000${player.name}\u0000${item.position}`;
      const current = selections.get(key) || { playerId: player.id, player: player.name, team: player.team || player.team_id || "", position: item.position, selectionCount: 0, gamesCount: 0 };
      current.selectionCount += 1;
      current.gamesCount += 1;
      selections.set(key, current);
    }
    playersByGame.set(game.id, true);
  }
  const bestNine = [...selections.values()]
    .sort((left, right) => right.selectionCount - left.selectionCount || left.position.localeCompare(right.position, "ja") || left.player.localeCompare(right.player, "ja") || left.playerId.localeCompare(right.playerId))
    .slice(0, BEST_NINE_LIMIT)
    .map((row, index) => ({ rank: index + 1, ...row }));
  return json({ ok: true, competitionType: COMPETITION_TYPE, competitionId, publishedGameCount: playersByGame.size, bestNine }, 200, request, env);
}

async function publishGame(request, env, db, gameId) {
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  await assertGameCompetitionMutable(db, game);
  if (!await persistedGamePredictionEligible(db, game)) return predictionNotEligibleResponse(request, env);
  await ensureFormalJobs(db, game);
  if (game.status === "published" && game.publication_status === "published") {
    const completedPublish = await prepared(db, "SELECT 1 FROM formal_jobs WHERE game_id = ?1 AND job_type = 'publish' AND status = 'completed' AND revision_number = ?2 LIMIT 1", gameId, game.current_lineup_revision).first();
    if (completedPublish) return json({ ok: true, gameId, noop: true, publishedAt: game.updated_at }, 200, request, env);
  }
  if (game.status !== "scored") return errorResponse(request, env, 409, "SCORING_REQUIRED", "採点済みの試合だけ公開できます。");
  const completed = await prepared(db, "SELECT 1 FROM scoring_runs WHERE game_id = ?1 AND revision_number = ?2 AND completed_at IS NOT NULL LIMIT 1", gameId, game.current_lineup_revision).first();
  if (!completed) return errorResponse(request, env, 409, "SCORING_INCOMPLETE", "採点処理が完了していません。");
  const rankingJob = await prepared(db, "SELECT status, revision_number, artifact_generation FROM formal_jobs WHERE game_id = ?1 AND job_type = 'ranking_rebuild' LIMIT 1", gameId).first();
  const generationId = String(rankingJob?.artifact_generation || "").trim();
  if (!rankingJob || rankingJob.status !== "completed" || Number(rankingJob.revision_number) !== Number(game.current_lineup_revision) || !generationId) {
    return errorResponse(request, env, 409, "RANKING_INCOMPLETE", "ランキング更新が完了していません。");
  }
  const generation = await prepared(db, `SELECT competition_id, generation, target_game_id, base_publication_revision, status
    FROM competition_ranking_generations
   WHERE competition_id = ?1 AND generation = ?2 AND target_game_id = ?3 AND status = 'built'`, game.competition_id, generationId, gameId).first();
  if (!generation) return errorResponse(request, env, 409, "RANKING_INCOMPLETE", "ランキング更新が完了していません。");
  const state = await prepared(db, "SELECT publication_revision FROM competition_publication_state WHERE competition_id = ?1 LIMIT 1", game.competition_id).first();
  const expectedPublicationRevision = Number(state?.publication_revision || 0);
  if (Number(generation.base_publication_revision || 0) !== expectedPublicationRevision) {
    return errorResponse(request, env, 409, "RANKING_GENERATION_STALE", "公開ランキングが更新されたため、ランキングを再集計してください。");
  }
  const now = nowIso();
  const nextPublicationRevision = expectedPublicationRevision + 1;
  const results = await db.batch([
    prepared(db, `UPDATE competition_publication_state
       SET publication_revision = ?1, updated_at = ?2, last_publication_generation = ?3
     WHERE competition_id = ?4 AND publication_revision = ?5
       AND EXISTS (SELECT 1 FROM games WHERE id = ?6 AND status = 'scored' AND publication_status = 'pending')
       AND EXISTS (SELECT 1 FROM competition_ranking_generations
                    WHERE competition_id = ?4 AND generation = ?7 AND target_game_id = ?6
                      AND status = 'built' AND base_publication_revision = ?5)`, nextPublicationRevision, now, generation.generation, game.competition_id, expectedPublicationRevision, gameId, generation.generation),
    prepared(db, `UPDATE games SET status = 'published', publication_status = 'published', updated_at = ?1
     WHERE id = ?2 AND status = 'scored'
       AND EXISTS (SELECT 1 FROM competition_publication_state WHERE competition_id = ?3 AND publication_revision = ?4 AND last_publication_generation = ?5)`, now, gameId, game.competition_id, nextPublicationRevision, generation.generation),
    prepared(db, `UPDATE competition_ranking_generations SET status = 'published', published_at = ?1
     WHERE competition_id = ?2 AND generation = ?3 AND target_game_id = ?4
       AND status = 'built' AND base_publication_revision = ?5
       AND EXISTS (SELECT 1 FROM competition_publication_state WHERE competition_id = ?2 AND publication_revision = ?6 AND last_publication_generation = ?3)`, now, game.competition_id, generation.generation, gameId, expectedPublicationRevision, nextPublicationRevision),
    prepared(db, `INSERT INTO competition_ranking_publications (competition_id, generation, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(competition_id) DO UPDATE SET generation = excluded.generation, updated_at = excluded.updated_at
     WHERE EXISTS (SELECT 1 FROM competition_publication_state WHERE competition_id = ?1 AND publication_revision = ?4 AND last_publication_generation = ?2)
       AND EXISTS (SELECT 1 FROM competition_ranking_generations WHERE competition_id = ?1 AND generation = ?2 AND status = 'published')`, game.competition_id, generation.generation, now, nextPublicationRevision),
    prepared(db, `UPDATE formal_jobs SET status = 'completed', revision_number = ?1, completed_at = ?2, updated_at = ?2, attempts = attempts + 1
     WHERE game_id = ?3 AND job_type = 'publish' AND status <> 'completed'
       AND EXISTS (SELECT 1 FROM competition_publication_state WHERE competition_id = ?4 AND publication_revision = ?5 AND last_publication_generation = ?6)`, game.current_lineup_revision, now, gameId, game.competition_id, nextPublicationRevision, generation.generation)
  ]);
  if (!Number(results?.[0]?.meta?.changes || 0)) {
    return errorResponse(request, env, 409, "RANKING_GENERATION_STALE", "公開ランキングが更新されたため、ランキングを再集計してください。");
  }
  const published = await getGame(db, gameId);
  if (!published || published.status !== "published") return errorResponse(request, env, 409, "PUBLICATION_CONFLICT", "別の公開処理が先に完了しました。");
  return json({ ok: true, gameId, publishedAt: now }, 200, request, env);
}

async function rescoreGame(request, env, db, gameId, admin) {
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  await assertGameCompetitionMutable(db, game);
  if (!await persistedGamePredictionEligible(db, game)) return predictionNotEligibleResponse(request, env);
  if (!["scored", "published"].includes(game.status)) return errorResponse(request, env, 409, "RESCORE_NOT_READY", "採点済みの試合だけ正式スタメンを修正できます。");
  await ensureFormalJobs(db, game);
  if (game.current_lineup_revision === null || game.current_lineup_revision === undefined) return errorResponse(request, env, 409, "REVISION_REQUIRED", "現行revisionがありません。");
  const input = await readJson(request);
  const candidate = validateLineup(input.lineup, { label: "訂正版正式スタメン", rosterIds: await getRosterIds(db, gameId) });
  if (!candidate.ok) return errorResponse(request, env, 400, candidate.code, candidate.error);
  await validateLineupTeamOwnership(db, game, candidate.lineup, input.teamId || input.lineupTeamId);
  const fingerprint = await sha256Hex(JSON.stringify(candidate.lineup));
  const current = await prepared(db, "SELECT revision_number, lineup_json, fingerprint FROM lineup_revisions WHERE game_id = ?1 AND is_current = 1 LIMIT 1", gameId).first();
  if (current?.fingerprint === fingerprint) {
    return json({ ok: true, noop: true, gameId, revision: Number(current.revision_number), published: false }, 200, request, env);
  }
  const previous = await prepared(db, "SELECT COALESCE(MAX(revision_number), 0) AS revision FROM lineup_revisions WHERE game_id = ?1", gameId).first();
  const revision = Number(previous?.revision || 0) + 1;
  const now = nowIso();
  const plan = await prepareScoring(db, gameId, game, candidate.lineup, revision, admin, "rescore", uuid());
  const lineupLockPredicate = scoringLockPredicate(2);
  const insertLockPredicate = scoringLockPredicate(8);
  const gameLockPredicate = scoringLockPredicate(7);
  const statements = [
    scoringLockInsert(db, { ...plan, startedAt: now }),
    prepared(db, `UPDATE lineup_revisions SET is_current = 0 WHERE game_id = ?1 AND is_current = 1 AND ${lineupLockPredicate}`, gameId, plan.lockId, gameId, revision, plan.kind),
    prepared(db, `INSERT INTO lineup_revisions (id, game_id, revision_number, lineup_json, fingerprint, is_current, confirmed_at, confirmed_by, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?6
       WHERE ${insertLockPredicate}`, uuid(), gameId, revision, JSON.stringify(candidate.lineup), fingerprint, now, admin.id, plan.lockId, gameId, revision, plan.kind),
    ...plan.updates,
    prepared(db, `UPDATE games SET status = 'scored', publication_status = 'pending', current_lineup_revision = ?1, updated_at = ?2
       WHERE id = ?3 AND status = ?4 AND publication_status = ?5 AND current_lineup_revision = ?6 AND ${gameLockPredicate}`, revision, now, gameId, game.status, game.publication_status, game.current_lineup_revision, plan.lockId, gameId, revision, plan.kind),
    completeFormalJobStatement(db, gameId, "prediction_close", revision, now),
    completeFormalJobStatement(db, gameId, "score", revision, now),
    resetFormalJobStatement(db, gameId, "ranking_rebuild", revision, game.prediction_deadline_at, now),
    resetFormalJobStatement(db, gameId, "publish", revision, game.prediction_deadline_at, now),
    prepared(db, `UPDATE scoring_runs SET processed_count = ?1, score_changed_count = ?2, completed_at = ?3
       WHERE id = ?4 AND completed_at IS NULL`, plan.rows.length, plan.changed, now, plan.lockId)
  ];
  try {
    await db.batch(statements);
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("unique")) throw new RequestError(409, "RESCORE_CONFLICT", "別の正式スタメン修正が先に完了しました。");
    throw error;
  }
  if (!await completedScoringRun(db, plan.lockId)) throw new RequestError(409, "RESCORE_CONFLICT", "別の正式スタメン修正が先に完了しました。");
  return json({ ok: true, gameId, revision, scoreChangedCount: plan.changed, processed: plan.rows.length, scored: plan.scored, invalid: plan.invalid, published: false, reason: String(input.reason || "正式スタメン修正").trim().slice(0, 240) }, 200, request, env);
}

async function bestNine(request, env, db, gameId) {
  const game = await getGame(db, gameId);
  if (!game || game.status !== "published" || game.publication_status !== "published") {
    return json({ ok: true, published: false, bestNine: [], totalCount: 0 }, 200, request, env);
  }
  const currentRevision = Number(game.current_lineup_revision);
  if (!Number.isInteger(currentRevision)) return json({ ok: true, published: false, bestNine: [], totalCount: 0 }, 200, request, env);
  const completed = await prepared(db, "SELECT 1 FROM scoring_runs WHERE game_id = ?1 AND revision_number = ?2 AND completed_at IS NOT NULL LIMIT 1", gameId, currentRevision).first();
  if (!completed) return json({ ok: true, published: false, bestNine: [], totalCount: 0 }, 200, request, env);
  const candidates = `WITH latest_predictions AS (
    SELECT predictions.*, ROW_NUMBER() OVER (PARTITION BY user_id, game_id ORDER BY updated_at DESC, submitted_at DESC, id DESC) AS submission_rank
      FROM predictions WHERE game_id = ?1
  ), candidate_rows AS (
    SELECT users.username, latest_predictions.user_id, latest_predictions.score, latest_predictions.max_score, latest_predictions.submitted_at
      FROM latest_predictions JOIN users ON users.id = latest_predictions.user_id
     WHERE latest_predictions.submission_rank = 1
        AND latest_predictions.status = 'scored'
        AND latest_predictions.score IS NOT NULL
        AND latest_predictions.max_score IS NOT NULL
        AND latest_predictions.scored_revision = (SELECT current_lineup_revision FROM games WHERE id = ?1)
        AND (latest_predictions.is_test_prediction = 0 OR users.username IN (${CANONICAL_TEST_USERS.map((_, index) => `?${index + 2}`).join(", ")}))
       AND users.status = 'active'
  )`;
  const binds = [gameId, ...CANONICAL_TEST_USERS];
  const count = await prepared(db, `${candidates} SELECT COUNT(*) AS total_count FROM candidate_rows`, ...binds).first();
  const rows = await prepared(db, `${candidates} SELECT username, score, max_score, submitted_at FROM candidate_rows ORDER BY score DESC, submitted_at ASC, username ASC, user_id ASC LIMIT ?${CANONICAL_TEST_USERS.length + 2}`, ...binds, BEST_NINE_LIMIT).all();
  return json({ ok: true, published: true, totalCount: Number(count?.total_count || 0), bestNine: (rows.results || []).map((row, index) => ({ rank: index + 1, username: row.username, score: Number(row.score), maxScore: Number(row.max_score), isPerfect: Number(row.score) === Number(row.max_score) })) }, 200, request, env);
}

async function adminGameDetail(request, env, db, gameId) {
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  const lineup = await currentLineup(db, gameId);
  const predictions = await prepared(db, `SELECT users.username, predictions.status, predictions.score, predictions.max_score, predictions.scored_revision, predictions.updated_at FROM predictions JOIN users ON users.id = predictions.user_id WHERE predictions.game_id = ?1 ORDER BY predictions.updated_at DESC`, gameId).all();
  const revisions = await prepared(db, "SELECT revision_number, fingerprint, is_current, confirmed_at, confirmed_by FROM lineup_revisions WHERE game_id = ?1 ORDER BY revision_number DESC", gameId).all();
  const competition = await getCompetition(db, game.competition_id || DEFAULT_COMPETITION_ID);
  const formalJobs = await listFormalJobs(db, gameId);
  const requiredFormalJobTypes = formalJobTypesForGame(game, await getTeams(db, game.competition_id || DEFAULT_COMPETITION_ID));
  const existingFormalJobTypes = new Set(formalJobs.map((job) => job.job_type));
  const missingFormalJobTypes = requiredFormalJobTypes.filter((jobType) => !existingFormalJobTypes.has(jobType));
  return json({ ok: true, competition: serializeCompetition(competition), game: serializeGame(game, await getPlayers(db, gameId)), currentLineup: lineup, revisions: revisions.results || [], formalJobs, requiredFormalJobTypes, missingFormalJobTypes, ranking: await listCompetitionRanking(db, game.competition_id || DEFAULT_COMPETITION_ID, false, true), predictions: predictions.results || [] }, 200, request, env);
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  // Keep health independent from D1 so deployment and routing can be checked
  // before the target account has received production data.
  if (["/health", "/api/health"].includes(path) && request.method === "GET") {
    return json({ ok: true, service: "starting9-asia-cs-api" }, 200, request, env);
  }
  const db = databaseOrError(env, request);
  if (db instanceof Response) return db;
  if (request.method === "OPTIONS") return json({ ok: true }, 200, request, env);
  if (path === "/api/auth/register" && request.method === "POST") return localAuthEnabled(env) ? register(request, env, db) : errorResponse(request, env, 404, "EXTERNAL_AUTH_REQUIRED", "Starting9の認証を使用してください。");
  if (path === "/api/auth/admin/bootstrap" && request.method === "POST") return localAuthEnabled(env) ? bootstrapAdmin(request, env, db) : errorResponse(request, env, 404, "EXTERNAL_AUTH_REQUIRED", "Starting9の認証を使用してください。");
  if (path === "/api/auth/login" && request.method === "POST") return localAuthEnabled(env) ? login(request, env, db) : errorResponse(request, env, 404, "EXTERNAL_AUTH_REQUIRED", "Starting9の認証を使用してください。");
  if (path === "/api/auth/logout" && request.method === "POST") return localAuthEnabled(env) ? logout(request, env, db) : errorResponse(request, env, 404, "EXTERNAL_AUTH_REQUIRED", "Starting9の認証を使用してください。");
  if (path === "/api/auth/me" && request.method === "GET") {
    const diagnostic = createAuthDiagnostic(request);
    const user = await resolveUser(request, env, db, { diagnostic });
    const isAdmin = isAsiaCsAdmin(user, env);
    diagnostic.finalAuthenticated = Boolean(user);
    diagnostic.finalIsAdmin = isAdmin;
    emitAuthDiagnostic(diagnostic);
    return json({
      ok: true,
      authenticated: Boolean(user),
      isAdmin,
      user: user ? { id: user.id, username: user.username, role: user.role } : null
    }, 200, request, env);
  }
  if (path === "/api/competition" && request.method === "GET") return publicCompetition(request, env, db);
  if (path === "/api/games" && request.method === "GET") return publicGames(request, env, db);
  if (path === "/api/best-nine" && request.method === "GET") return publicBestNine(request, env, db);
  if (path === "/api/rankings" && request.method === "GET") return publicRanking(request, env, db);

  if (path === "/api/admin/competition" && ["POST", "PUT"].includes(request.method)) {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return updateCompetition(request, env, db);
  }
  if (path === "/api/admin/overview" && request.method === "GET") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return adminCompetitionOverview(request, env, db);
  }
  if (path === "/api/admin/dry-run/fixture" && ["GET", "POST"].includes(request.method)) {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return request.method === "GET"
      ? json({ ok: true, fixture: await dryRunFixtureReadback(db) }, 200, request, env)
      : prepareDryRunFixture(request, env, db);
  }
  if (path === "/api/admin/dry-run/fixture/activate" && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return activateDryRunFixture(request, env, db);
  }
  if (path === "/api/admin/players/import" && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return bulkImportPlayers(request, env, db);
  }
  if (path === "/api/admin/games/import" && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return bulkImportGames(request, env, db);
  }

  if (path === "/api/admin/teams" && request.method === "GET") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return listTeams(request, env, db);
  }
  if (path === "/api/admin/teams" && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return createTeam(request, env, db, admin);
  }

  if (path === "/api/admin/placement-games" && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return createPlacementGame(request, env, db, admin);
  }

  let match = path.match(/^\/api\/games\/([^/]+)$/);
  if (match && request.method === "GET") return publicGame(request, env, db, validId(match[1]));
  match = path.match(/^\/api\/games\/([^/]+)\/result$/);
  if (match && request.method === "GET") return publicResult(request, env, db, validId(match[1]));
  match = path.match(/^\/api\/games\/([^/]+)\/prediction$/);
  if (match && request.method === "GET") return currentPrediction(request, env, db, validId(match[1]));
  if (match && request.method === "PUT") return savePrediction(request, env, db, validId(match[1]));
  if (match && request.method === "DELETE") return deletePrediction(request, env, db, validId(match[1]));
  match = path.match(/^\/api\/games\/([^/]+)\/best-nine$/);
  if (match && request.method === "GET") return bestNine(request, env, db, validId(match[1]));

  if (path === "/api/admin/games" && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return createGame(request, env, db, admin);
  }
  match = path.match(/^\/api\/admin\/games\/([^/]+)$/);
  if (match && request.method === "GET") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return adminGameDetail(request, env, db, validId(match[1]));
  }
  match = path.match(/^\/api\/admin\/games\/([^/]+)\/players$/);
  if (match && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return upsertPlayers(request, env, db, validId(match[1]));
  }
  match = path.match(/^\/api\/admin\/games\/([^/]+)\/players\/([^/]+)$/);
  if (match && request.method === "PUT") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return updatePlayer(request, env, db, validId(match[1]), validId(match[2]));
  }
  match = path.match(/^\/api\/admin\/games\/([^/]+)\/lineup$/);
  if (match && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return saveInitialLineup(request, env, db, validId(match[1]), admin);
  }
  match = path.match(/^\/api\/admin\/games\/([^/]+)\/score$/);
  if (match && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return scoreGame(request, env, db, validId(match[1]), admin);
  }
  match = path.match(/^\/api\/admin\/games\/([^/]+)\/ranking$/);
  if (match && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return rankingGame(request, env, db, validId(match[1]));
  }
  match = path.match(/^\/api\/admin\/games\/([^/]+)\/publish$/);
  if (match && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return publishGame(request, env, db, validId(match[1]));
  }
  match = path.match(/^\/api\/admin\/games\/([^/]+)\/rescore$/);
  if (match && request.method === "POST") {
    const admin = await requireAdmin(request, env, db);
    if (admin instanceof Response) return admin;
    return rescoreGame(request, env, db, validId(match[1]), admin);
  }
  return errorResponse(request, env, 404, "NOT_FOUND", "対象のAPIがありません。");
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(JSON.stringify({ scope: "asia-cs-worker", code: error?.code || "UNHANDLED_ERROR", message: String(error?.message || error) }));
      if (error instanceof RequestError) return errorResponse(request, env, error.status, error.code, error.message, error.details);
      return errorResponse(request, env, 500, "INTERNAL_ERROR", "処理に失敗しました。");
    }
  }
};

export {
  BEST_NINE_LIMIT,
  getSessionUser,
  isAsiaCsAdmin,
  parseAsiaCsAdminUserIds,
  prepareScoring,
  scoreLineup,
  isGamePredictionEligible,
  formalJobTypesForGame,
  isJapanTeam,
  placementGameDefinition,
  serializeGame,
  validateLineup
};
