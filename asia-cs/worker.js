import { isPredictionEligible } from "../game-scoring-ranking-v2.js";
import {
  LINEUP_SIZE,
  MAX_SCORE,
  scoreLineup,
  validateLineup
} from "./scoring.js";

const SESSION_COOKIE = "s9_asia_cs_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 100_000;
const MAX_BODY_BYTES = 32 * 1024;
const BEST_NINE_LIMIT = 9;
const CANONICAL_TEST_USERS = Object.freeze(
  Array.from({ length: 9 }, (_, index) => `S9_TEST_${index + 1}`)
);

function json(data, status = 200, request = null, env = {}) {
  const requestedOrigin = request?.headers.get("Origin") || "";
  const configuredOrigin = String(env.ALLOWED_ORIGIN || "").trim();
  const origin = configuredOrigin
    ? (requestedOrigin === configuredOrigin ? requestedOrigin : configuredOrigin)
    : (requestedOrigin || "*");
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Bootstrap-Token",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
  });
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
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
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

function cookieValue(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
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

function mutationOriginError(request, env) {
  const configuredOrigin = String(env.ALLOWED_ORIGIN || "").trim();
  const requestedOrigin = String(request.headers.get("Origin") || "").trim();
  const fetchSite = String(request.headers.get("Sec-Fetch-Site") || "").trim().toLowerCase();
  if (fetchSite === "cross-site") return errorResponse(request, env, 403, "CROSS_SITE_MUTATION", "許可されていない操作です。");
  if (requestedOrigin && (!configuredOrigin || requestedOrigin !== configuredOrigin)) {
    return errorResponse(request, env, configuredOrigin ? 403 : 503, configuredOrigin ? "ORIGIN_NOT_ALLOWED" : "ORIGIN_NOT_CONFIGURED", configuredOrigin ? "許可されていない操作です。" : "許可Originが設定されていません。");
  }
  return null;
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

async function requireUser(request, env, db) {
  const user = await getSessionUser(request, db);
  return user || errorResponse(request, env, 401, "AUTH_REQUIRED", "ログインしてください。");
}

async function requireAdmin(request, env, db) {
  const originError = mutationOriginError(request, env);
  if (originError) return originError;
  const user = await getSessionUser(request, db);
  if (!user) return errorResponse(request, env, 401, "AUTH_REQUIRED", "ログインしてください。");
  if (user.role !== "admin") return errorResponse(request, env, 403, "ADMIN_REQUIRED", "管理者権限が必要です。");
  return user;
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

async function getPlayers(db, gameId, activeOnly = false) {
  const suffix = activeOnly ? " AND active = 1" : "";
  const result = await prepared(db, `SELECT id, game_id, name, uniform_number, team, active, created_at, updated_at FROM players WHERE game_id = ?1${suffix} ORDER BY name ASC, id ASC`, gameId).all();
  return result.results || [];
}

function serializeGame(game, players = []) {
  if (!game) return null;
  return {
    id: game.id,
    title: game.title,
    gameDate: game.game_date,
    startAt: game.start_at,
    predictionDeadlineAt: game.prediction_deadline_at,
    status: game.status,
    publicationStatus: game.publication_status,
    currentLineupRevision: game.current_lineup_revision === null ? null : Number(game.current_lineup_revision),
    players: players.map((player) => ({
      id: player.id,
      name: player.name,
      uniformNumber: player.uniform_number,
      team: player.team,
      active: Boolean(player.active)
    }))
  };
}

async function publicGame(request, env, db, gameId) {
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  return json({ ok: true, game: serializeGame(game, await getPlayers(db, gameId, true)) }, 200, request, env);
}

async function currentPrediction(request, env, db, gameId) {
  const user = await requireUser(request, env, db);
  if (user instanceof Response) return user;
  const row = await prepared(db, "SELECT prediction_json, status, score, max_score, scored_revision, submitted_at, updated_at, scored_at, actual_lineup_json FROM predictions WHERE user_id = ?1 AND game_id = ?2 LIMIT 1", user.id, gameId).first();
  return json({ ok: true, prediction: row ? {
    lineup: JSON.parse(row.prediction_json), status: row.status, score: row.score === null ? null : Number(row.score), maxScore: row.max_score === null ? null : Number(row.max_score), scoredRevision: row.scored_revision, submittedAt: row.submitted_at, updatedAt: row.updated_at, scoredAt: row.scored_at,
    actualLineup: row.actual_lineup_json ? JSON.parse(row.actual_lineup_json) : null
  } : null }, 200, request, env);
}

async function savePrediction(request, env, db, gameId) {
  const user = await requireUser(request, env, db);
  if (user instanceof Response) return user;
  const originError = mutationOriginError(request, env);
  if (originError) return originError;
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
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
  const originError = mutationOriginError(request, env);
  if (originError) return originError;
  const game = await getGame(db, gameId);
  const deadline = validDate(game?.prediction_deadline_at);
  if (!game || !deadline || new Date().getTime() >= deadline.getTime() || game.status !== "open") {
    return errorResponse(request, env, 409, "PREDICTION_DEADLINE_PASSED", "予想受付を終了しています。");
  }
  await prepared(db, "DELETE FROM predictions WHERE user_id = ?1 AND game_id = ?2", user.id, gameId).run();
  return json({ ok: true }, 200, request, env);
}

async function createGame(request, env, db, admin) {
  const input = await readJson(request);
  const title = String(input.title || "Asia CS").trim().slice(0, 120);
  const startAt = validDate(input.startAt);
  const gameDate = String(input.gameDate || (startAt ? startAt.toISOString().slice(0, 10) : "")).trim();
  const deadline = validDate(input.predictionDeadlineAt || (startAt ? new Date(startAt.getTime() - 60 * 60 * 1000).toISOString() : ""));
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(gameDate) || !startAt || !deadline) {
    throw new RequestError(400, "GAME_INPUT_INVALID", "試合名・試合日・開始日時・締切日時を確認してください。");
  }
  const id = validId(input.id) || uuid();
  const now = nowIso();
  await prepared(db, `INSERT INTO games (id, title, game_date, start_at, prediction_deadline_at, status, publication_status, current_lineup_revision, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, 'open', 'pending', NULL, ?6, ?6)`, id, title, gameDate, startAt.toISOString(), deadline.toISOString(), now).run();
  return json({ ok: true, game: serializeGame(await getGame(db, id), []) }, 201, request, env);
}

async function upsertPlayers(request, env, db, gameId) {
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  const input = await readJson(request);
  const players = Array.isArray(input.players) ? input.players : [input];
  if (!players.length || players.length > 200) throw new RequestError(400, "PLAYERS_INVALID", "出場選手を確認してください。");
  const now = nowIso();
  const statements = [];
  for (const value of players) {
    const id = validId(value.id || value.playerId) || uuid();
    const name = String(value.name || value.playerName || "").trim().slice(0, 80);
    if (!name) throw new RequestError(400, "PLAYER_NAME_REQUIRED", "選手名を入力してください。");
    statements.push(prepared(db, `INSERT INTO players (id, game_id, name, uniform_number, team, active, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, uniform_number = excluded.uniform_number, team = excluded.team, active = excluded.active, updated_at = excluded.updated_at`,
      id, gameId, name, String(value.uniformNumber || value.uniform_number || "").trim().slice(0, 3), String(value.team || "").trim().slice(0, 40), value.active === false ? 0 : 1, now));
  }
  try {
    await db.batch(statements);
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("unique")) throw new RequestError(409, "PLAYER_DUPLICATE", "同じ試合に同名の選手があります。");
    throw error;
  }
  return json({ ok: true, players: await getPlayers(db, gameId) }, 200, request, env);
}

async function updatePlayer(request, env, db, gameId, playerId) {
  const id = validId(playerId);
  if (!id) throw new RequestError(400, "PLAYER_ID_INVALID", "選手IDが不正です。");
  const input = await readJson(request);
  const name = String(input.name || input.playerName || "").trim().slice(0, 80);
  if (!name) throw new RequestError(400, "PLAYER_NAME_REQUIRED", "選手名を入力してください。");
  const result = await prepared(db, `UPDATE players SET name = ?1, uniform_number = ?2, team = ?3, active = ?4, updated_at = ?5 WHERE id = ?6 AND game_id = ?7`, name, String(input.uniformNumber || input.uniform_number || "").trim().slice(0, 3), String(input.team || "").trim().slice(0, 40), input.active === false ? 0 : 1, nowIso(), id, gameId).run();
  if (!Number(result?.meta?.changes || 0)) return errorResponse(request, env, 404, "PLAYER_NOT_FOUND", "選手がありません。");
  return json({ ok: true, player: (await prepared(db, "SELECT id, game_id, name, uniform_number, team, active FROM players WHERE id = ?1", id).first()) }, 200, request, env);
}

async function getRosterIds(db, gameId) {
  return new Set((await getPlayers(db, gameId, true)).map((player) => player.id));
}

async function saveInitialLineup(request, env, db, gameId, admin) {
  const game = await getGame(db, gameId);
  if (!game) return errorResponse(request, env, 404, "GAME_NOT_FOUND", "対象試合がありません。");
  if (["scored", "published"].includes(game.status)) return errorResponse(request, env, 409, "LINEUP_REVISION_REQUIRED", "採点済みの正式スタメンは修正操作を使用してください。");
  const input = await readJson(request);
  const candidate = validateLineup(input.lineup, { label: "正式スタメン", rosterIds: await getRosterIds(db, gameId) });
  if (!candidate.ok) return errorResponse(request, env, 400, candidate.code, candidate.error);
  const previous = await prepared(db, "SELECT COALESCE(MAX(revision_number), 0) AS revision FROM lineup_revisions WHERE game_id = ?1", gameId).first();
  const revision = Number(previous?.revision || 0) + 1;
  const now = nowIso();
  const fingerprint = await sha256Hex(JSON.stringify(candidate.lineup));
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
  const lineup = await currentLineup(db, gameId);
  if (!game || !lineup) return errorResponse(request, env, 409, "LINEUP_REQUIRED", "正式スタメンを先に確定してください。");
  if (game.status !== "lineup_confirmed") return errorResponse(request, env, 409, "INITIAL_SCORING_NOT_ALLOWED", "初回採点は正式スタメン確定後に一度だけ実行できます。");
  if (new Date().getTime() < new Date(game.prediction_deadline_at).getTime()) return errorResponse(request, env, 409, "PREDICTION_OPEN", "締切前は採点できません。");
  const plan = await prepareScoring(db, gameId, game, lineup.lineup, lineup.revision, admin, "initial", uuid());
  const result = await commitScoring(db, game, plan);
  return json({ ok: true, gameId, ...result }, 200, request, env);
}

async function publishGame(request, env, db, gameId) {
  const game = await getGame(db, gameId);
  if (!game || game.status !== "scored") return errorResponse(request, env, 409, "SCORING_REQUIRED", "採点済みの試合だけ公開できます。");
  const completed = await prepared(db, "SELECT 1 FROM scoring_runs WHERE game_id = ?1 AND revision_number = ?2 AND completed_at IS NOT NULL LIMIT 1", gameId, game.current_lineup_revision).first();
  if (!completed) return errorResponse(request, env, 409, "SCORING_INCOMPLETE", "採点処理が完了していません。");
  const now = nowIso();
  const result = await prepared(db, "UPDATE games SET status = 'published', publication_status = 'published', updated_at = ?1 WHERE id = ?2 AND status = 'scored'", now, gameId).run();
  if (!Number(result?.meta?.changes || 0)) return errorResponse(request, env, 409, "PUBLICATION_CONFLICT", "別の公開処理が先に完了しました。");
  return json({ ok: true, gameId, publishedAt: now }, 200, request, env);
}

async function rescoreGame(request, env, db, gameId, admin) {
  const game = await getGame(db, gameId);
  if (!game || !["scored", "published"].includes(game.status)) return errorResponse(request, env, 409, "RESCORE_NOT_READY", "採点済みの試合だけ正式スタメンを修正できます。");
  if (game.current_lineup_revision === null || game.current_lineup_revision === undefined) return errorResponse(request, env, 409, "REVISION_REQUIRED", "現行revisionがありません。");
  const input = await readJson(request);
  const candidate = validateLineup(input.lineup, { label: "訂正版正式スタメン", rosterIds: await getRosterIds(db, gameId) });
  if (!candidate.ok) return errorResponse(request, env, 400, candidate.code, candidate.error);
  const previous = await prepared(db, "SELECT COALESCE(MAX(revision_number), 0) AS revision FROM lineup_revisions WHERE game_id = ?1", gameId).first();
  const revision = Number(previous?.revision || 0) + 1;
  const now = nowIso();
  const fingerprint = await sha256Hex(JSON.stringify(candidate.lineup));
  const plan = await prepareScoring(db, gameId, game, candidate.lineup, revision, admin, "rescore", uuid());
  const lineupLockPredicate = scoringLockPredicate(2);
  const insertLockPredicate = scoringLockPredicate(8);
  const gameLockPredicate = scoringLockPredicate(9);
  const statements = [
    scoringLockInsert(db, { ...plan, startedAt: now }),
    prepared(db, `UPDATE lineup_revisions SET is_current = 0 WHERE game_id = ?1 AND is_current = 1 AND ${lineupLockPredicate}`, gameId, plan.lockId, gameId, revision, plan.kind),
    prepared(db, `INSERT INTO lineup_revisions (id, game_id, revision_number, lineup_json, fingerprint, is_current, confirmed_at, confirmed_by, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?6
       WHERE ${insertLockPredicate}`, uuid(), gameId, revision, JSON.stringify(candidate.lineup), fingerprint, now, admin.id, plan.lockId, gameId, revision, plan.kind),
    ...plan.updates,
    prepared(db, `UPDATE games SET status = ?1, publication_status = ?2, current_lineup_revision = ?3, updated_at = ?4
       WHERE id = ?5 AND status = ?6 AND publication_status = ?7 AND current_lineup_revision = ?8 AND ${gameLockPredicate}`, game.status, game.publication_status, revision, now, gameId, game.status, game.publication_status, game.current_lineup_revision, plan.lockId, gameId, revision, plan.kind),
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
  return json({ ok: true, gameId, revision, scoreChangedCount: plan.changed, processed: plan.rows.length, scored: plan.scored, invalid: plan.invalid, published: game.publication_status === "published", reason: String(input.reason || "正式スタメン修正").trim().slice(0, 240) }, 200, request, env);
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
  return json({ ok: true, game: serializeGame(game, await getPlayers(db, gameId)), currentLineup: lineup, revisions: revisions.results || [], predictions: predictions.results || [] }, 200, request, env);
}

async function route(request, env) {
  const db = databaseOrError(env, request);
  if (db instanceof Response) return db;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (request.method === "OPTIONS") return json({ ok: true }, 200, request, env);
  if (path === "/api/auth/register" && request.method === "POST") return register(request, env, db);
  if (path === "/api/auth/admin/bootstrap" && request.method === "POST") return bootstrapAdmin(request, env, db);
  if (path === "/api/auth/login" && request.method === "POST") return login(request, env, db);
  if (path === "/api/auth/logout" && request.method === "POST") return logout(request, env, db);
  if (path === "/api/auth/me" && request.method === "GET") return json({ ok: true, user: await getSessionUser(request, db) }, 200, request, env);

  let match = path.match(/^\/api\/games\/([^/]+)$/);
  if (match && request.method === "GET") return publicGame(request, env, db, validId(match[1]));
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
      if (error instanceof RequestError) return errorResponse(request, env, error.status, error.code, error.message);
      return errorResponse(request, env, 500, "INTERNAL_ERROR", "処理に失敗しました。");
    }
  }
};

export {
  BEST_NINE_LIMIT,
  getSessionUser,
  prepareScoring,
  scoreLineup,
  serializeGame,
  validateLineup
};
