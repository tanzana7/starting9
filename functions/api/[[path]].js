const TARGET_AUTH_WORKER_ORIGIN = "https://starting9-auth.starting9.workers.dev";
const TEST_AUTH_WORKER_ORIGIN = "https://starting9-test-auth.starting9.workers.dev";
const AUTH_WORKER_ORIGIN_ENV = "STARTING9_AUTH_ORIGIN";
const TEST_TEAM_KEYS = new Set([
  "fighters", "giants", "tigers", "baystars", "carp", "swallows", "dragons",
  "hawks", "marines", "eagles", "buffaloes", "lions"
]);
const INVALID_TEST_TEAM = "__invalid_test_team__";

export function resolveAuthWorkerOrigin(env = {}) {
  const configured = String(env?.[AUTH_WORKER_ORIGIN_ENV] || "")
    .trim()
    .replace(/\/+$/, "");
  const environment = String(env?.SITE_ENVIRONMENT || "production").trim().toLowerCase();
  const expected = environment === "test"
    ? TEST_AUTH_WORKER_ORIGIN
    : environment === "production"
      ? TARGET_AUTH_WORKER_ORIGIN
      : "";
  return expected && configured === expected ? configured : null;
}

export function resolveTestTeam(request, env = {}) {
  if (String(env?.SITE_ENVIRONMENT || "").trim().toLowerCase() !== "test") return "";
  const requestUrl = new URL(request.url);
  const queryTeam = requestUrl.searchParams.get("testTeam");
  if (queryTeam !== null) return TEST_TEAM_KEYS.has(queryTeam) ? queryTeam : INVALID_TEST_TEAM;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)s9_test_team=([^;]*)(?:;|$)/);
  if (!match) return "fighters";
  return TEST_TEAM_KEYS.has(match[1]) ? match[1] : INVALID_TEST_TEAM;
}

const BLOCKED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "origin",
  "referer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto"
]);

function jsonError(code, message, status) {
  return new Response(JSON.stringify({ ok: false, code, error: message }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function createUpstreamRequest(request, upstreamUrl) {
  const headers = new Headers(request.headers);
  for (const name of BLOCKED_REQUEST_HEADERS) headers.delete(name);

  return new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
    duplex: "half"
  });
}

function normalizeSetCookie(cookie) {
  return cookie
    .split(";")
    .filter((part, index) => index === 0 || !/^\s*Domain\s*=/i.test(part))
    .join(";")
    .trim();
}

function readSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const combined = headers.get("Set-Cookie");
  return combined ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/) : [];
}

function copyResponseHeaders(upstreamHeaders) {
  const headers = new Headers();
  for (const [name, value] of upstreamHeaders) {
    if (name.toLowerCase() === "set-cookie") continue;
    headers.append(name, value);
  }
  for (const cookie of readSetCookies(upstreamHeaders)) {
    const normalized = normalizeSetCookie(cookie);
    if (normalized) headers.append("Set-Cookie", normalized);
  }
  return headers;
}

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  if (!requestUrl.pathname.startsWith("/api/")) {
    return new Response("Not Found", { status: 404 });
  }

  const upstreamOrigin = resolveAuthWorkerOrigin(context.env);
  if (!upstreamOrigin) {
    return jsonError(
      "AUTH_PROXY_NOT_CONFIGURED",
      "認証サービスの接続先が設定されていません。",
      503
    );
  }

  const upstreamPath = requestUrl.pathname;
  const upstreamUrl = new URL(upstreamPath + requestUrl.search, upstreamOrigin);
  const testTeam = resolveTestTeam(context.request, context.env);
  if (testTeam === INVALID_TEST_TEAM) {
    return jsonError("INVALID_TEST_TEAM", "対象球団を選び直してください。", 400);
  }
  if (testTeam) upstreamUrl.searchParams.set("testTeam", testTeam);
  try {
    const upstream = await fetch(createUpstreamRequest(context.request, upstreamUrl));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyResponseHeaders(upstream.headers)
    });
  } catch {
    return jsonError(
      "AUTH_PROXY_UNAVAILABLE",
      "認証サービスに接続できません。時間をおいて再試行してください。",
      503
    );
  }
}
