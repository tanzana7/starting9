const AUTH_WORKER_ORIGIN = "https://starting9-auth.tanzana7.workers.dev";
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

  const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, AUTH_WORKER_ORIGIN);
  try {
    const upstream = await fetch(createUpstreamRequest(context.request, upstreamUrl));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: copyResponseHeaders(upstream.headers)
    });
  } catch {
    return jsonError("AUTH_PROXY_UNAVAILABLE", "認証サービスに接続できません。時間をおいて再試行してください。", 503);
  }
}
