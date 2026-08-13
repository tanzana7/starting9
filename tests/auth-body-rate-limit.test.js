import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const { default: worker, resetAuthRateLimitsForTests, verifyDummyPassword } = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);

function createDb() {
  return {
    prepare() {
      const statement = {
        bind() { return statement; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 0 } }; }
      };
      return statement;
    }
  };
}

function request(pathname, { body = "{}", contentType = "application/json", ip = "198.51.100.10" } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (contentType !== null) headers["Content-Type"] = contentType;
  return new Request(`https://starting9.test${pathname}`, {
    method: "POST",
    headers,
    body
  });
}

async function fetchRequest(req) {
  return worker.fetch(req, { AUTH_DB: createDb() }, {});
}

test("JSON POST with application/json reaches the endpoint", async () => {
  resetAuthRateLimitsForTests();
  const response = await fetchRequest(request("/api/auth/login", {
    body: JSON.stringify({ username: "unknown-user", password: "password123" }),
    ip: "198.51.100.11"
  }));
  assert.equal(response.status, 401);
});

test("missing or unsupported JSON content type returns 415", async () => {
  resetAuthRateLimitsForTests();
  const missing = await fetchRequest(request("/api/auth/login", { contentType: null, ip: "198.51.100.12" }));
  const unsupported = await fetchRequest(request("/api/auth/login", { contentType: "text/plain", ip: "198.51.100.13" }));
  assert.equal(missing.status, 415);
  assert.equal(unsupported.status, 415);
});

test("invalid JSON returns 400", async () => {
  resetAuthRateLimitsForTests();
  const response = await fetchRequest(request("/api/auth/login", { body: "{", ip: "198.51.100.14" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_JSON_BODY");
});

test("body over the default limit returns 413", async () => {
  resetAuthRateLimitsForTests();
  const oversized = JSON.stringify({ username: "unknown-user", password: "x".repeat(70_000) });
  const response = await fetchRequest(request("/api/auth/login", { body: oversized, ip: "198.51.100.15" }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "REQUEST_BODY_TOO_LARGE");
});

test("login and register rate limits return 429 after the short window budget", async () => {
  resetAuthRateLimitsForTests();
  const loginResponses = [];
  for (let index = 0; index < 11; index += 1) {
    loginResponses.push(await fetchRequest(request("/api/auth/login", {
      contentType: "text/plain",
      ip: "198.51.100.16"
    })));
  }
  assert.deepEqual(loginResponses.slice(0, 10).map((response) => response.status), Array(10).fill(415));
  assert.equal(loginResponses[10].status, 429);

  resetAuthRateLimitsForTests();
  const registerResponses = [];
  for (let index = 0; index < 6; index += 1) {
    registerResponses.push(await fetchRequest(request("/api/auth/register", {
      contentType: "text/plain",
      ip: "198.51.100.17"
    })));
  }
  assert.deepEqual(registerResponses.slice(0, 5).map((response) => response.status), Array(5).fill(415));
  assert.equal(registerResponses[5].status, 429);
});

test("rate limit reset permits a new attempt", async () => {
  resetAuthRateLimitsForTests();
  for (let index = 0; index < 10; index += 1) {
    await fetchRequest(request("/api/auth/login", { contentType: "text/plain", ip: "198.51.100.18" }));
  }
  assert.equal((await fetchRequest(request("/api/auth/login", { contentType: "text/plain", ip: "198.51.100.18" }))).status, 429);
  resetAuthRateLimitsForTests();
  assert.equal((await fetchRequest(request("/api/auth/login", { contentType: "text/plain", ip: "198.51.100.18" }))).status, 415);
});

test("unknown users still execute the dummy PBKDF2 verification", async () => {
  assert.equal(await verifyDummyPassword("password123"), false);
  assert.match(workerSource, /if \(!user \|\| user\.status !== "active"\) \{\s*await verifyDummyPassword\(input\.password\);/);
});

test("prediction and admin preview use explicit larger payload budgets", () => {
  assert.match(workerSource, /const PREDICTION_JSON_BODY_MAX_BYTES = 128 \* 1024/);
  assert.match(workerSource, /const ADMIN_PREVIEW_JSON_BODY_MAX_BYTES = 256 \* 1024/);
  assert.match(workerSource, /readJson\(request, \{ maxBytes: PREDICTION_JSON_BODY_MAX_BYTES \}\)/);
  assert.match(workerSource, /readJson\(request, \{ maxBytes: ADMIN_PREVIEW_JSON_BODY_MAX_BYTES \}\)/);
});

test("existing dangerous boundaries remain explicit", () => {
  assert.match(workerSource, /path === "\/api\/admin\/v3\/ranking-resets\/execute" && request\.method === "POST"/);
  assert.match(workerSource, /RANKING_RESET_CONFIRMATION_REQUIRED/);
  assert.match(workerSource, /PERFECT_ACHIEVER_MUTATION_RETIRED_CODE/);
});
