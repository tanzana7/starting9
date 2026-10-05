const TARGET_AUTH_WORKER_ORIGIN = "https://starting9-auth.starting9.workers.dev";
const AUTH_WORKER_ORIGIN_ENV = "STARTING9_AUTH_ORIGIN";
const ASIA_CS_API_ORIGIN_ENV = "ASIA_CS_API_ORIGIN";
const SESSION_COOKIE_NAME = "s9_session";
const AUTH_DIAGNOSTIC_HEADER = "X-S9-Auth-Diagnostic-Id";

function countCookieOccurrences(header, name) {
  return String(header || "").split(";").reduce((count, part) => {
    const separator = part.indexOf("=");
    const cookieName = separator < 0 ? part.trim() : part.slice(0, separator).trim();
    return count + (cookieName === name ? 1 : 0);
  }, 0);
}

function createAuthDiagnosticId(request) {
  return String(request.headers.get("cf-ray") || "").trim() || crypto.randomUUID();
}

export function resolveAuthWorkerOrigin(env = {}) {
  const configured = String(env?.[AUTH_WORKER_ORIGIN_ENV] || "")
    .trim()
    .replace(/\/+$/, "");
  return configured === TARGET_AUTH_WORKER_ORIGIN ? configured : null;
}

export function resolveAsiaCsWorkerOrigin(env = {}) {
  const configured = String(env?.[ASIA_CS_API_ORIGIN_ENV] || "")
    .trim()
    .replace(/\/+$/, "");
  if (!configured) return null;
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash) return parsed.origin;
  const runtime = String(env?.PAGES_RUNTIME || "").trim().toLowerCase();
  if (["development", "test"].includes(runtime)
    && ["http:", "https:"].includes(parsed.protocol)
    && ["localhost", "127.0.0.1"].includes(parsed.hostname)
    && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash) {
    return parsed.origin;
  }
  return null;
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

function createAsiaCsUpstreamRequest(request, upstreamUrl, diagnosticId = "") {
  const upstream = createUpstreamRequest(request, upstreamUrl);
  const cookies = request.headers.get("Cookie") || "";
  const forwarded = cookies.split(";").map((part) => part.trim()).filter((part) => {
    const separator = part.indexOf("=");
    const name = separator < 0 ? part : part.slice(0, separator).trim();
    return name === "s9_session" || name === "s9_asia_cs_session";
  }).join("; ");
  if (forwarded) upstream.headers.set("Cookie", forwarded);
  else upstream.headers.delete("Cookie");
  if (diagnosticId) upstream.headers.set(AUTH_DIAGNOSTIC_HEADER, diagnosticId);
  return upstream;
}

function createAsiaCsGatewayRequest(request, upstreamUrl) {
  const upstream = createUpstreamRequest(request, upstreamUrl);
  const cookies = request.headers.get("Cookie") || "";
  const sessionCookie = cookies.split(";").map((part) => part.trim()).find((part) => part.split("=", 1)[0].trim() === SESSION_COOKIE_NAME);
  if (sessionCookie) upstream.headers.set("Cookie", sessionCookie);
  else upstream.headers.delete("Cookie");
  return upstream;
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

  const isAsiaCsRoute = requestUrl.pathname === "/api/asia-cs" || requestUrl.pathname.startsWith("/api/asia-cs/");
  const isAsiaCsAuthRoute = isAsiaCsRoute && context.request.method === "GET" && requestUrl.pathname === "/api/asia-cs/auth/me";
  const diagnosticId = isAsiaCsAuthRoute ? createAuthDiagnosticId(context.request) : "";
  if (isAsiaCsAuthRoute) {
    const sessionCookieCount = countCookieOccurrences(context.request.headers.get("Cookie"), SESSION_COOKIE_NAME);
    console.info(JSON.stringify({
      scope: "asia-cs-auth-diagnostic",
      phase: "pages",
      diagnosticId,
      requestPath: requestUrl.pathname,
      hasSessionCookie: sessionCookieCount > 0,
      sessionCookieCount
    }));
  }
  // All same-origin Asia requests pass through the existing Auth Worker. It
  // verifies s9_session once and creates the trusted internal assertion for
  // the Asia Worker, so the browser never depends on Worker-to-Worker auth.
  const upstreamOrigin = resolveAuthWorkerOrigin(context.env);
  if (!upstreamOrigin) {
    return jsonError(
      isAsiaCsRoute ? "ASIA_CS_GATEWAY_NOT_CONFIGURED" : "AUTH_PROXY_NOT_CONFIGURED",
      isAsiaCsRoute ? "Asia Edition APIの認証連携が設定されていません。" : "認証サービスの接続先が設定されていません。",
      503
    );
  }

  const upstreamPath = requestUrl.pathname;
  const upstreamUrl = new URL(upstreamPath + requestUrl.search, upstreamOrigin);
  try {
    const upstream = await fetch(isAsiaCsRoute
      ? createAsiaCsGatewayRequest(context.request, upstreamUrl)
      : createUpstreamRequest(context.request, upstreamUrl));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyResponseHeaders(upstream.headers)
    });
  } catch {
    return jsonError(
      isAsiaCsRoute ? "ASIA_CS_GATEWAY_UNAVAILABLE" : "AUTH_PROXY_UNAVAILABLE",
      isAsiaCsRoute ? "Asia Edition APIに接続できません。時間をおいて再試行してください。" : "認証サービスに接続できません。時間をおいて再試行してください。",
      503
    );
  }
}
