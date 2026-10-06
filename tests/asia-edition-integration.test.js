import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createAuthBridgeAssertion, sha256Base64Url, verifyAuthBridgeAssertion } from "../backend/auth-bridge.js";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function loadEdition() {
  const window = { location: { href: "https://starting9.test/" } };
  vm.runInNewContext(read("frontend/shared/edition.js"), { window, URL, Date });
  return window.Starting9Edition;
}

test("Asia Edition resolverは東京時刻の明示windowだけでdefaultを切り替える", () => {
  const edition = loadEdition();
  const window = { activeFrom: "2026-11-10T00:00:00+09:00", activeUntil: "2026-11-16T00:00:00+09:00" };
  assert.equal(edition.resolveDefaultEdition("2026-11-09T23:59:59+09:00", window), "NPB");
  assert.equal(edition.resolveDefaultEdition("2026-11-10T00:00:00+09:00", window), "ASIA_CS");
  assert.equal(edition.resolveDefaultEdition("2026-11-15T23:59:59+09:00", window), "ASIA_CS");
  assert.equal(edition.resolveDefaultEdition("2026-11-16T00:00:00+09:00", window), "NPB");
  assert.equal(edition.resolveDefaultEdition(new Date("2026-11-10T00:00:00Z"), { activeFrom: "", activeUntil: "" }), "NPB");
});

test("明示selectionは期間外でも利用でき、windowはlocal timezoneへ依存しない", () => {
  const edition = loadEdition();
  const location = { href: "https://starting9.test/?edition=asia" };
  assert.equal(edition.explicitEdition(location), "ASIA_CS");
  assert.equal(edition.resolveSelectedEdition(location, new Date("2026-01-01T00:00:00Z")), "ASIA_CS");
  assert.equal(edition.TOKYO_TIME_ZONE, "Asia/Tokyo");
});

test("Asia APIは同一originのAuth gatewayへ通し、旧admin URLは統合先へ案内する", () => {
  const proxy = read("functions/api/[[path]].js");
  const admin = read("admin-v3.html");
  const legacy = read("asia-cs/public/admin.html");
  assert.match(proxy, /All same-origin Asia requests pass through the existing Auth Worker/);
  assert.match(proxy, /const upstreamOrigin = resolveAuthWorkerOrigin\(context\.env\)/);
  assert.match(admin, /data-admin-edition-select="ASIA_CS"/);
  assert.match(admin, /id="asiaAdminEditionContent"/);
  assert.match(legacy, /admin-v3\.html\?edition=asia/);
});

test("Auth bridgeは改ざんされたclient identityを受け付けず、method/pathも束縛する", async () => {
  const secret = "test-only-asia-bridge-secret";
  const bodyDigest = await sha256Base64Url("payload");
  const assertion = await createAuthBridgeAssertion({
    secret,
    user: { id: "user-1", username: "admin", role: "admin" },
    method: "POST",
    path: "/api/admin/competition",
    query: "?competitionId=asia-cs",
    bodyDigest,
    csrfValidated: true,
    now: 1_000_000
  });
  const trusted = await verifyAuthBridgeAssertion(assertion, {
    secret,
    method: "POST",
    path: "/api/admin/competition",
    query: "?competitionId=asia-cs",
    bodyDigest,
    requireCsrf: true,
    now: 1_000_500
  });
  assert.deepEqual(trusted, { id: "user-1", username: "admin", role: "admin", authSource: "starting9", csrfValidated: true });
  assert.equal(await verifyAuthBridgeAssertion(assertion, { secret, method: "GET", path: "/api/admin/competition", query: "?competitionId=asia-cs", bodyDigest, now: 1_000_500 }), null);
  assert.equal(await verifyAuthBridgeAssertion(assertion, { secret, method: "POST", path: "/api/admin/competition", query: "?other=value", bodyDigest, now: 1_000_500 }), null);
  assert.equal(await verifyAuthBridgeAssertion(assertion, { secret, method: "POST", path: "/api/admin/competition", query: "?competitionId=asia-cs", bodyDigest: await sha256Base64Url("changed"), now: 1_000_500 }), null);
  assert.equal(await verifyAuthBridgeAssertion(assertion, { secret: "wrong-secret", method: "POST", path: "/api/admin/competition", query: "?competitionId=asia-cs", bodyDigest, now: 1_000_500 }), null);
  const tampered = `${assertion.slice(0, -1)}${assertion.endsWith("A") ? "B" : "A"}`;
  assert.equal(await verifyAuthBridgeAssertion(tampered, { secret, method: "POST", path: "/api/admin/competition", query: "?competitionId=asia-cs", bodyDigest, now: 1_000_500 }), null);
});

test("Auth bridgeはaudience・期限・future skew・型をfail closedする", async () => {
  const secret = "test-only-asia-bridge-secret";
  const valid = await createAuthBridgeAssertion({ secret, user: { id: "user-1", username: "user", role: "user" }, method: "GET", path: "/api/competition", now: 1_000_000 });
  assert.equal(await verifyAuthBridgeAssertion(valid, { secret, method: "GET", path: "/api/competition", now: 1_031_000 }), null);
  assert.equal(await verifyAuthBridgeAssertion(valid, { secret, method: "GET", path: "/api/competition", audience: "other", now: 1_000_000 }), null);
  assert.equal(await verifyAuthBridgeAssertion(valid, { secret, method: "GET", path: "/api/competition", now: 994_000 }), null);
  for (const id of [["user-1"], { id: "user-1" }, 1, true, null, new String("user-1")]) {
    assert.equal(await createAuthBridgeAssertion({ secret, user: { id, username: "user", role: "user" }, method: "GET", path: "/api/competition" }), "");
  }
  for (const role of [["admin"], { role: "admin" }, 1, true, null]) {
    assert.equal(await createAuthBridgeAssertion({ secret, user: { id: "user-1", username: "user", role }, method: "GET", path: "/api/competition" }), "");
  }
});

test("Asia Workerはtrusted bridgeを使い、admin判定を既存Starting9 roleへ束縛する", () => {
  const worker = read("asia-cs/worker.js");
  const auth = read("auth-worker.js");
  assert.match(worker, /verifyAuthBridgeAssertion/);
  assert.match(worker, /user\.authSource === "starting9"\) return user\.role === "admin"/);
  assert.match(auth, /createAuthBridgeAssertion/);
  assert.match(auth, /ASIA_CS_AUTH_BRIDGE_NOT_CONFIGURED/);
});

test("Asia Workerのproduction formal pathはbridgeなしでlegacy authへdowngradeしない", async () => {
  const { default: worker } = await import(pathToFileURL(path.join(ROOT, "asia-cs/worker.js")).href);
  let legacyCalls = 0;
  const response = await worker.fetch(new Request("https://asia-cs.test/api/admin/teams", {
    method: "POST",
    headers: { Origin: "https://asia-cs.test" },
    body: "{}"
  }), {
    DB: { prepare() { return { bind() { return { async first() { return null; } }; } }; } },
    ASIA_CS_ENV: "production",
    ASIA_CS_AUTH_BRIDGE_SECRET: "bridge-secret",
    ASIA_CS_ADMIN_USER_IDS: "admin-1",
    AUTH_VERIFY: async () => { legacyCalls += 1; return { id: "admin-1", username: "admin", role: "admin" }; }
  }, {});
  assert.equal(response.status, 401);
  assert.equal(legacyCalls, 0);
});

test("Asia Workerはmissing secretとsigned non-adminをfail closedする", async () => {
  const { default: worker } = await import(pathToFileURL(path.join(ROOT, "asia-cs/worker.js")).href);
  const body = "{}";
  const assertion = await createAuthBridgeAssertion({
    secret: "bridge-secret",
    user: { id: "user-1", username: "user", role: "user" },
    method: "POST",
    path: "/api/admin/teams",
    bodyDigest: await sha256Base64Url(body),
    csrfValidated: true
  });
  const baseRequest = { method: "POST", headers: { "X-S9-Auth-Bridge": assertion, Origin: "https://starting9.pages.dev" }, body };
  const db = { prepare() { return { bind() { return { async first() { return null; }, async run() { return { meta: { changes: 1 } }; } }; } }; } };
  const missingSecret = await worker.fetch(new Request("https://asia-cs.test/api/admin/teams", baseRequest), { DB: db, ASIA_CS_ENV: "production", AUTH_VERIFY: async () => ({ id: "legacy-admin", username: "legacy", role: "admin" }) }, {});
  assert.equal(missingSecret.status, 401);
  const nonAdmin = await worker.fetch(new Request("https://asia-cs.test/api/admin/teams", baseRequest), { DB: db, ASIA_CS_ENV: "production", ASIA_CS_AUTH_BRIDGE_SECRET: "bridge-secret", ASIA_CS_ADMIN_USER_IDS: "user-1", AUTH_VERIFY: async () => ({ id: "legacy-admin", username: "legacy", role: "admin" }) }, {});
  assert.equal(nonAdmin.status, 403);
});

test("Auth gatewayは既存sessionを検証してからだけAsiaへassertionを渡し、Cookieを再転送しない", async () => {
  const { default: worker } = await import(pathToFileURL(path.join(ROOT, "auth-worker.js")).href);
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (request) => {
    forwarded = request;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              return sql.includes("FROM sessions JOIN users")
                ? { session_id: "session-1", id: "admin-1", username: "operator", status: "active", role: "admin" }
                : null;
            }
          };
        }
      };
    }
  };
  try {
    const response = await worker.fetch(new Request("https://starting9.test/api/asia-cs/admin/overview?competitionId=asia-cs", {
      method: "POST",
      headers: {
        Cookie: "s9_session=browser-secret",
        Origin: "https://starting9.pages.dev",
        "X-S9-Auth-Bridge": "client-spoof",
        Authorization: "Bearer browser-token",
        "Content-Type": "application/json"
      },
      body: "{\"value\":1}"
    }), {
      AUTH_DB: db,
      ASIA_CS_API_ORIGIN: "https://starting9-asia-cs-api.starting9.workers.dev",
      ASIA_CS_AUTH_BRIDGE_SECRET: "test-only-asia-bridge-secret",
      AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev"
    }, {});
    assert.equal(response.status, 200);
    assert.equal(new URL(forwarded.url).pathname, "/api/admin/overview");
    assert.equal(new URL(forwarded.url).search, "?competitionId=asia-cs");
    assert.equal(forwarded.headers.get("Cookie"), null);
    assert.equal(forwarded.headers.get("Authorization"), null);
    assert.equal(await forwarded.text(), "{\"value\":1}");
    assert.match(forwarded.headers.get("X-S9-Auth-Bridge") || "", /^v1\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Auth gatewayの公開healthはCookieなしGETをAsiaの/api/healthへ転送する", async () => {
  const { default: worker } = await import(pathToFileURL(path.join(ROOT, "auth-worker.js")).href);
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (request) => {
    forwarded = request;
    return new Response(JSON.stringify({ ok: true, service: "starting9-asia-cs-api" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const response = await worker.fetch(new Request("https://starting9.test/api/asia-cs/health"), {
      ASIA_CS_API_ORIGIN: "https://starting9-asia-cs-api.starting9.workers.dev",
      AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev"
    }, {});
    assert.equal(response.status, 200);
    assert.equal(new URL(forwarded.url).pathname, "/api/health");
    assert.equal(forwarded.headers.get("Cookie"), null);
    assert.equal(forwarded.headers.get("X-S9-Auth-Bridge"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Auth gatewayのhealthはD1/sessionがなくてもpublic probeとして動作する", async () => {
  const { default: worker } = await import(pathToFileURL(path.join(ROOT, "auth-worker.js")).href);
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (request) => {
    forwarded = request;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const response = await worker.fetch(new Request("https://starting9.test/api/asia-cs/health"), {
      ASIA_CS_API_ORIGIN: "https://starting9-asia-cs-api.starting9.workers.dev"
    }, {});
    assert.equal(response.status, 200);
    assert.equal(new URL(forwarded.url).pathname, "/api/health");
    assert.equal(forwarded.headers.get("Cookie"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Auth gatewayのhealthはGET以外をpublic healthとして扱わない", async () => {
  const { default: worker } = await import(pathToFileURL(path.join(ROOT, "auth-worker.js")).href);
  const response = await worker.fetch(new Request("https://starting9.test/api/asia-cs/health", {
    method: "POST",
    headers: { Origin: "https://starting9.pages.dev", "Sec-Fetch-Site": "same-origin" },
    body: "{}"
  }), {
    AUTH_DB: { prepare() { return { bind() { return { async first() { return null; } }; } }; } },
    ASIA_CS_API_ORIGIN: "https://starting9-asia-cs-api.starting9.workers.dev",
    ASIA_CS_AUTH_BRIDGE_SECRET: "test-secret",
    AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev"
  }, {});
  assert.equal(response.status, 401);
});

test("Auth gatewayはmutationのCSRF context欠落・cross-site・secret欠落をfail closedする", async () => {
  const { default: worker } = await import(pathToFileURL(path.join(ROOT, "auth-worker.js")).href);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const db = {
    prepare(sql) {
      return {
        bind() {
          return { async first() { return sql.includes("FROM sessions JOIN users") ? { id: "admin-1", username: "operator", status: "active", role: "admin" } : null; } };
        }
      };
    }
  };
  try {
    const base = { AUTH_DB: db, ASIA_CS_API_ORIGIN: "https://starting9-asia-cs-api.starting9.workers.dev", ASIA_CS_AUTH_BRIDGE_SECRET: "test-secret", AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev" };
    const missingContext = await worker.fetch(new Request("https://starting9.test/api/asia-cs/admin/overview", { method: "POST", headers: { Cookie: "s9_session=valid" }, body: "{}" }), base, {});
    assert.equal(missingContext.status, 403);
    const crossSite = await worker.fetch(new Request("https://starting9.test/api/asia-cs/admin/overview", { method: "POST", headers: { Cookie: "s9_session=valid", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }, body: "{}" }), base, {});
    assert.equal(crossSite.status, 403);
    const missingSecret = await worker.fetch(new Request("https://starting9.test/api/asia-cs/admin/overview", { method: "POST", headers: { Cookie: "s9_session=valid", Origin: "https://starting9.pages.dev" }, body: "{}" }), { ...base, ASIA_CS_AUTH_BRIDGE_SECRET: "" }, {});
    assert.equal(missingSecret.status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
