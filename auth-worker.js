const SESSION_COOKIE_NAME = "s9_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 210000;
const PASSWORD_HASH_BITS = 256;
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 16;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 72;

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
