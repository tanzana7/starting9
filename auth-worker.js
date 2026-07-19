const SESSION_COOKIE_NAME = "s9_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 210000;
const PASSWORD_HASH_BITS = 256;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 16;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 72;
// 開発中は1試合につき先着3人。本番候補は30人です。
const PERFECT_ACHIEVERS_DEFAULT_DISPLAY_LIMIT = 3;
const PREDICTION_SCHEMA_VERSION = 1;
const PREDICTION_MAX_JSON_BYTES = 16 * 1024;
const PREDICTION_POSITIONS = new Set(["捕", "一", "二", "三", "遊", "左", "中", "右", "指"]);
const PREDICTION_TEAM_CODES = new Set(["f", "b", "h", "l", "e", "m", "g", "t", "db", "c", "d", "s"]);
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
  }
};

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
  const passwordHash = await derivePasswordHash(input.password, salt, PASSWORD_ITERATIONS);
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
      PASSWORD_ITERATIONS,
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

  const salt = base64UrlToBytes(user.password_salt);
  const expectedHash = base64UrlToBytes(user.password_hash);
  const actualHash = await derivePasswordHash(input.password, salt, Number(user.password_iterations));
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

async function handleGetPerfectAchievers(request, env, cors) {
  const gameId = getValidGameId(new URL(request.url).searchParams.get("gameId"));
  if (!gameId) {
    return jsonResponse({ ok: false, error: "対象試合のgameIdを指定してください。" }, 400, cors);
  }

  const session = await getSessionUser(request, env);
  const snapshot = await getPerfectAchieverSnapshot(env.AUTH_DB, gameId, session?.id || "");
  return jsonResponse(createPerfectAchieverResponse(gameId, snapshot), 200, cors);
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

  const row = await getPredictionRow(env.AUTH_DB, session.id, metadata.gameId);
  if (!row) {
    return jsonResponse({
      ok: true,
      gameId: metadata.gameId,
      prediction: null,
      status: null,
      submittedAt: null,
      updatedAt: null,
      locked: false
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
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    locked: isPredictionLocked(row)
  }, 200, cors);
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
  const result = await env.AUTH_DB.prepare(
    `INSERT INTO predictions
       (id, user_id, game_id, prediction_json, schema_version,
        game_date, home_team, away_team, opponent_code, is_home,
        submitted_at, updated_at, locked_at, status,
        score, max_score, scored_at, actual_lineup_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, NULL, 'submitted', NULL, NULL, NULL, NULL)
     ON CONFLICT(user_id, game_id) DO UPDATE SET
       prediction_json = excluded.prediction_json,
       schema_version = excluded.schema_version,
       game_date = excluded.game_date,
       home_team = excluded.home_team,
       away_team = excluded.away_team,
       opponent_code = excluded.opponent_code,
       is_home = excluded.is_home,
       updated_at = excluded.updated_at,
       status = 'submitted'
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
    now
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
            submitted_at, updated_at, locked_at
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

  const nickname = typeof value.nickname === "string" ? value.nickname.trim().slice(0, 24) : "";
  return {
    ok: true,
    prediction: {
      schemaVersion: PREDICTION_SCHEMA_VERSION,
      nickname,
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
    `SELECT sessions.id AS session_id, users.id, users.username, users.status
       FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?1
        AND sessions.expires_at > ?2
        AND users.status = 'active'
      LIMIT 1`
  ).bind(tokenHash, now).first().then((row) => row ? { ...row, sessionId: row.session_id } : null);
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
