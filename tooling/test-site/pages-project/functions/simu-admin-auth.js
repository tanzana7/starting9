const TEST_AUTH_WORKER_ORIGIN = "https://starting9-test-auth.starting9.workers.dev";

function resolveTestAuthWorkerOrigin(env) {
  const configured = String(env?.STARTING9_AUTH_ORIGIN || "").trim().replace(/\/+$/, "");
  return String(env?.SITE_ENVIRONMENT || "").trim().toLowerCase() === "test"
    && configured === TEST_AUTH_WORKER_ORIGIN
    ? TEST_AUTH_WORKER_ORIGIN
    : null;
}

function sessionCookie(request) {
  const pair = (request.headers.get("Cookie") || "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith("s9_session="));
  return pair && pair.length > "s9_session=".length ? pair : "";
}

export async function authorizeTestAdmin(request, env = {}) {
  if (String(env?.SITE_ENVIRONMENT || "").trim().toLowerCase() !== "test") {
    return { ok: false, code: "TEST_ENVIRONMENT_REQUIRED", status: 503 };
  }
  const origin = resolveTestAuthWorkerOrigin(env);
  const cookie = sessionCookie(request);
  if (!origin) return { ok: false, code: "TEST_AUTH_NOT_CONFIGURED", status: 503 };
  if (!cookie) return { ok: false, code: "ADMIN_REQUIRED", status: 401 };
  try {
    // Validate the existing session only against the allowlisted Test Auth Worker; never decode or log its value here.
    const response = await fetch(new Request(new URL("/api/admin/me", origin), {
      method: "GET",
      headers: { Accept: "application/json", Cookie: cookie }
    }));
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: response.status === 401 ? "ADMIN_REQUIRED" : "ADMIN_ROLE_REQUIRED", status: response.status };
    }
    if (!response.ok) return { ok: false, code: "TEST_AUTH_UNAVAILABLE", status: 503 };
    const result = await response.json().catch(() => null);
    return result?.ok === true && result?.admin === true
      ? { ok: true }
      : { ok: false, code: "ADMIN_ROLE_REQUIRED", status: 403 };
  } catch {
    return { ok: false, code: "TEST_AUTH_UNAVAILABLE", status: 503 };
  }
}
