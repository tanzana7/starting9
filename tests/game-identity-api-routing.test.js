import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workerOrigin = "https://starting9-auth.tanzana7.workers.dev";
const auditPath = "/api/admin/audit/game-identities";

test("direct Pages audit URL redirects only the audit route to the existing Auth Worker", async () => {
  const redirects = await readFile(new URL("../_redirects", import.meta.url), "utf8");
  assert.ok(redirects.split(/\r?\n/).includes(`${auditPath} ${workerOrigin}${auditPath} 307`));
  assert.doesNotMatch(redirects, /^\/api\/\*/m);
  assert.doesNotMatch(redirects, /^\/\*/m);
});

test("Auth Worker owns the audit route and keeps the existing admin authentication guard", async () => {
  const worker = await readFile(new URL("../auth-worker.js", import.meta.url), "utf8");
  assert.match(worker, /path === "\/api\/admin\/audit\/game-identities" && request\.method === "GET"/);
  const start = worker.indexOf("async function handleAdminGameIdentityAudit");
  const end = worker.indexOf("export function selectNextPredictionTarget", start);
  assert.match(worker.slice(start, end), /requireAdminUser\(request, env, cors\)/);
});

test("the browser's existing API base remains the Auth Worker rather than the Pages origin", async () => {
  const auth = await readFile(new URL("../auth.js", import.meta.url), "utf8");
  assert.match(auth, /const AUTH_PRODUCTION_API_BASE_URL = "https:\/\/starting9-auth\.tanzana7\.workers\.dev"/);
  assert.match(auth, /fetch\(`\$\{baseUrl\}\$\{path\}`, requestOptions\)/);
});
