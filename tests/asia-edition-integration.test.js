import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createAuthBridgeAssertion, verifyAuthBridgeAssertion } from "../backend/auth-bridge.js";

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
  const assertion = await createAuthBridgeAssertion({
    secret,
    user: { id: "user-1", username: "admin", role: "admin" },
    method: "POST",
    path: "/api/admin/competition",
    now: 1_000_000
  });
  const trusted = await verifyAuthBridgeAssertion(assertion, { secret, method: "POST", path: "/api/admin/competition", now: 1_000_500 });
  assert.deepEqual(trusted, { id: "user-1", username: "admin", role: "admin", authSource: "starting9" });
  assert.equal(await verifyAuthBridgeAssertion(assertion, { secret, method: "GET", path: "/api/admin/competition", now: 1_000_500 }), null);
  const tampered = `${assertion.slice(0, -1)}${assertion.endsWith("A") ? "B" : "A"}`;
  assert.equal(await verifyAuthBridgeAssertion(tampered, { secret, method: "POST", path: "/api/admin/competition", now: 1_000_500 }), null);
});

test("Asia Workerはtrusted bridgeを使い、admin判定を既存Starting9 roleへ束縛する", () => {
  const worker = read("asia-cs/worker.js");
  const auth = read("auth-worker.js");
  assert.match(worker, /verifyAuthBridgeAssertion/);
  assert.match(worker, /user\.authSource === "starting9" && user\.role === "admin"/);
  assert.match(auth, /createAuthBridgeAssertion/);
  assert.match(auth, /ASIA_CS_AUTH_BRIDGE_NOT_CONFIGURED/);
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
      headers: { Cookie: "s9_session=browser-secret", "X-S9-Auth-Bridge": "client-spoof" }
    }), {
      AUTH_DB: db,
      ASIA_CS_API_ORIGIN: "https://starting9-asia-cs-api.starting9.workers.dev",
      ASIA_CS_AUTH_BRIDGE_SECRET: "test-only-asia-bridge-secret"
    }, {});
    assert.equal(response.status, 200);
    assert.equal(new URL(forwarded.url).pathname, "/api/admin/overview");
    assert.equal(forwarded.headers.get("Cookie"), null);
    assert.match(forwarded.headers.get("X-S9-Auth-Bridge") || "", /^v1\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
