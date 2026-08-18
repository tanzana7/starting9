import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const publicScript = fs.readFileSync(path.join(root, "script.js"), "utf8");
const rankingRepositorySource = fs.readFileSync(path.join(root, "backend", "repositories", "ranking-repository.js"), "utf8");
const { default: worker } = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);

function createAuthenticatedReadOnlyDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      calls.push({ kind: "prepare", sql });
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM sessions JOIN users")) {
                return {
                  session_id: "session-1",
                  id: "session-user",
                  username: "session-user-name",
                  status: "active",
                  role: "user"
                };
              }
              return null;
            },
            async all() { return { results: [] }; },
            async run() {
              throw new Error("retired perfect-achiever mutation must not write D1");
            }
          };
        }
      };
    }
  };
}

function createPost(body, authenticated = true) {
  const headers = { "Content-Type": "application/json" };
  if (authenticated) headers.Cookie = "s9_session=test-session";
  return new Request("https://starting9-auth.test/api/perfect-achievers", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

test("perfect-achievers mutation requires authentication before returning the retired contract", async () => {
  const response = await worker.fetch(createPost({ gameId: "fake", score: 99, maxScore: 99 }, false), { AUTH_DB: {} }, {});
  const payload = await response.json();

  assert.equal(response.status, 401);
  assert.equal(payload.ok, false);
});

test("client-provided score, user identity, and game ID cannot create a perfect-achiever row", async () => {
  const db = createAuthenticatedReadOnlyDb();
  const response = await worker.fetch(createPost({
    internalGameId: "00000000-0000-4000-8000-000000000000",
    gameId: "forged-game",
    userId: "other-user",
    nickname: "forged-name",
    score: 99,
    maxScore: 99
  }), { AUTH_DB: db }, {});
  const payload = await response.json();

  assert.equal(response.status, 410);
  assert.equal(payload.code, "PERFECT_ACHIEVER_MUTATION_RETIRED");
  assert.equal(payload.replacement, "/api/rankings/perfect");
  assert.equal(db.calls.filter((call) => /perfect_achievers/i.test(call.sql)).length, 0);
});

test("canonical and legacy IDs share the same write-free retired contract", async () => {
  for (const body of [
    { internalGameId: "c099db0c-da34-425c-bd38-69e29ddc1064" },
    { gameId: "2026-08-12-f-l-19" },
    { gameId: "missing-game" }
  ]) {
    const db = createAuthenticatedReadOnlyDb();
    const response = await worker.fetch(createPost(body), { AUTH_DB: db }, {});
    assert.equal(response.status, 410);
    assert.equal(db.calls.filter((call) => /INSERT|UPDATE|DELETE/i.test(call.sql)).length, 0);
  }
});

test("public perfect ranking remains server-authoritative and the public UI does not call the retired POST", () => {
  assert.match(rankingRepositorySource, /latest_predictions\.status = 'scored'/);
  assert.match(rankingRepositorySource, /latest_predictions\.score = latest_predictions\.max_score/);
  assert.match(rankingRepositorySource, /ranking_games\.game_status = 'scored'/);
  assert.match(workerSource, /\/api\/rankings\/perfect/);
  assert.match(publicScript, /\/api\/results\/daily-best-nine/);
  assert.doesNotMatch(publicScript, /fetch\([^\n]*\/api\/perfect-achievers[^\n]*method:\s*["']POST/);
  assert.doesNotMatch(workerSource.slice(
    workerSource.indexOf("async function handlePostPerfectAchiever"),
    workerSource.indexOf("async function getPerfectAchieverSnapshot")
  ), /INSERT\s+INTO\s+perfect_achievers|input\?\.score|input\?\.maxScore|input\?\.userId|input\?\.nickname/);
});

test("server-side publish and rescore paths retain idempotent perfect-achiever maintenance", () => {
  assert.match(workerSource, /SELECT user_id, score, max_score FROM predictions[\s\S]*status = 'scored' AND score = max_score/);
  assert.match(workerSource, /INSERT OR IGNORE INTO perfect_achievers/);
  assert.match(workerSource, /DELETE FROM perfect_achievers WHERE game_id = \?1/);
});
