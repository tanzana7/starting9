const TARGET_AUTH_WORKER_ORIGIN = "https://starting9-auth.starting9.workers.dev";
const AUTH_WORKER_ORIGIN_ENV = "STARTING9_AUTH_ORIGIN";
const ASIA_CS_API_ORIGIN_ENV = "ASIA_CS_API_ORIGIN";

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

function createAsiaCsUpstreamRequest(request, upstreamUrl) {
  const upstream = createUpstreamRequest(request, upstreamUrl);
  const cookies = request.headers.get("Cookie") || "";
  const forwarded = cookies.split(";").map((part) => part.trim()).filter((part) => {
    const separator = part.indexOf("=");
    const name = separator < 0 ? part : part.slice(0, separator).trim();
    return name === "s9_session" || name === "s9_asia_cs_session";
  }).join("; ");
  if (forwarded) upstream.headers.set("Cookie", forwarded);
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
  const upstreamOrigin = isAsiaCsRoute
    ? resolveAsiaCsWorkerOrigin(context.env)
    : resolveAuthWorkerOrigin(context.env);
  if (!upstreamOrigin) {
    return jsonError(
      isAsiaCsRoute ? "ASIA_CS_PROXY_NOT_CONFIGURED" : "AUTH_PROXY_NOT_CONFIGURED",
      isAsiaCsRoute ? "Asia CS APIの接続先が設定されていません。" : "認証サービスの接続先が設定されていません。",
      503
    );
  }

  const upstreamPath = isAsiaCsRoute
    ? `/api${requestUrl.pathname.slice("/api/asia-cs".length) || "/"}`
    : requestUrl.pathname;
  const upstreamUrl = new URL(upstreamPath + requestUrl.search, upstreamOrigin);
  try {
    const upstream = await fetch(isAsiaCsRoute
      ? createAsiaCsUpstreamRequest(context.request, upstreamUrl)
      : createUpstreamRequest(context.request, upstreamUrl));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyResponseHeaders(upstream.headers)
    });
  } catch {
    return jsonError(
      isAsiaCsRoute ? "ASIA_CS_PROXY_UNAVAILABLE" : "AUTH_PROXY_UNAVAILABLE",
      isAsiaCsRoute ? "Asia CS APIに接続できません。時間をおいて再試行してください。" : "認証サービスに接続できません。時間をおいて再試行してください。",
      503
    );
  }
}
