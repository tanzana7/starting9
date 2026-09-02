import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import worker, { classifyD1ReadError } from "../auth-worker.js";
import { listV3Games } from "../backend/automation-v3/repository.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const authSource = fs.readFileSync(path.join(root, "auth.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

function readLimitError() {
  return Object.assign(new Error("Your account has exceeded D1's free tier daily row read limit"), { code: 7500 });
}

function failingD1(error) {
  return {
    prepare() {
      return {
        bind() {
          return {
            all: async () => { throw error; },
            first: async () => { throw error; }
          };
        }
      };
    }
  };
}

test("D1 row read limitは公開ゲームAPIで503と再試行情報へ分類される", async () => {
  const response = await worker.fetch(
    new Request("https://starting9-auth.test/api/public/games", {
      headers: { Origin: "https://starting9.pages.dev" }
    }),
    { AUTH_DB: failingD1(readLimitError()), AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev" },
    {}
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.code, "D1_READ_LIMIT_EXCEEDED");
  assert.equal(body.retryAt, "next_utc_day");
  assert.match(response.headers.get("Retry-After") || "", /^\d+$/);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://starting9.pages.dev");
});

test("D1 row read limitは前回結果APIでもfallback再試行せず503になる", async () => {
  let prepareCount = 0;
  const error = readLimitError();
  const db = {
    prepare() {
      prepareCount += 1;
      return { bind: () => ({ all: async () => { throw error; } }) };
    }
  };
  const response = await worker.fetch(
    new Request("https://starting9-auth.test/api/public/previous-result-game", {
      headers: { Origin: "https://starting9.pages.dev" }
    }),
    { AUTH_DB: db, AUTH_ALLOWED_ORIGINS: "https://starting9.pages.dev" },
    {}
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "D1_READ_LIMIT_EXCEEDED");
  assert.equal(prepareCount, 1, "quota errorでlegacy fallbackを追加実行しない");
});

test("D1読み取りエラー分類はquotaと一時DB障害を区別し、機密詳細を返さない", () => {
  assert.deepEqual(classifyD1ReadError(readLimitError()), {
    code: "D1_READ_LIMIT_EXCEEDED",
    status: 503,
    message: "データベースの読み取り上限に達しています。UTC日次リセット後に再試行してください。",
    retryAfter: "next_utc_day"
  });
  const failure = classifyD1ReadError(Object.assign(new Error("D1 database unavailable"), { code: "D1_ERROR" }));
  assert.equal(failure.code, "DB_UNAVAILABLE");
  assert.equal(failure.status, 503);
  assert.doesNotMatch(failure.message, /D1 database unavailable/);
});

test("admin/APIの読み取り上限対策は取得件数と時間窓を固定している", () => {
  const overview = workerSource.slice(workerSource.indexOf("async function handleAdminV3Overview"), workerSource.indexOf("async function handleAdminV3IdentityResolve"));
  const logs = workerSource.slice(workerSource.indexOf("async function handleAdminV3AutomationLogs"), workerSource.indexOf("function rankingResetAdminError"));
  const publicGames = workerSource.slice(workerSource.indexOf("async function handleGetPublicGames"), workerSource.indexOf("async function handleGetPreviousResultGame"));
  const previous = workerSource.slice(workerSource.indexOf("async function handleGetPreviousResultGame"), workerSource.indexOf("async function handleGetProbableStarter"));

  assert.match(overview, /limit: gameLimit/);
  assert.match(overview, /LIMIT \$\{ADMIN_V3_JOB_READ_LIMIT\}/);
  assert.match(logs, /occurred_at >= \?1/);
  assert.doesNotMatch(logs, /LIMIT 500/);
  assert.match(publicGames, /LIMIT \$\{PUBLIC_GAME_LIST_LIMIT\}/);
  assert.match(previous, /LIMIT \$\{PUBLIC_PREVIOUS_RESULT_CANDIDATE_LIMIT\}/);
  assert.match(previous, /ranking\.publication_status = 'published'/);
  assert.match(previous, /ranking\.ranking_eligibility_status <> 'eligible'/);
});

test("previous-result-gameは未公開gameに埋もれず公開済み候補をSQL側でboundedに絞る", () => {
  const start = workerSource.indexOf("async function handleGetPreviousResultGame");
  const end = workerSource.indexOf("async function handleGetProbableStarter", start);
  const handler = workerSource.slice(start, end);

  assert.match(handler, /ranking\.publication_status = 'published'/);
  assert.match(handler, /COALESCE\(ranking\.is_test_game, 0\) <> 1/);
  assert.match(handler, /LIMIT \$\{PUBLIC_PREVIOUS_RESULT_CANDIDATE_LIMIT\}/);
  assert.match(handler, /const directPublished =/);
  assert.doesNotMatch(handler, /LIMIT 30/);
});

test("previous-result-gameの通常系は公開済み候補を従来のレスポンス形で返す", async () => {
  const internalGameId = "11111111-1111-4111-8111-111111111111";
  let prepareCount = 0;
  const db = {
    prepare(sql) {
      prepareCount += 1;
      assert.match(sql, /ranking\.publication_status = 'published'/);
      return {
        bind() {
          return {
            all: async () => ({ results: [{
              internal_game_id: internalGameId,
              game_date: "2026-09-01",
              start_time: "2026-09-01T09:00:00.000Z",
              home_team: "fighters",
              away_team: "hawks",
              game_status: "scored",
              ranking_eligibility_status: "eligible",
              publication_status: "published",
              published_at: "2026-09-02T01:26:26.990Z",
              is_test_game: 0
            }] })
          };
        }
      };
    }
  };
  const response = await worker.fetch(
    new Request("https://starting9-auth.test/api/public/previous-result-game"),
    { AUTH_DB: db },
    {}
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(prepareCount, 1, "通常系でpublication判定のN+1を発生させない");
  assert.equal(body.game.internalGameId, internalGameId);
  assert.equal(body.game.state, "published");
  assert.equal(body.game.resultsPublished, true);
  assert.equal(body.game.resultPublishedAt, "2026-09-02T01:26:26.990Z");
  assert.equal(body.game.rankingEligibilityStatus, "eligible");
});

test("legacy schema fallbackもbounded取得と公開判定の互換経路を維持する", () => {
  const start = workerSource.indexOf("async function handleGetPreviousResultGame");
  const end = workerSource.indexOf("async function handleGetProbableStarter", start);
  const handler = workerSource.slice(start, end);

  assert.match(handler, /using canonical games fallback/);
  assert.match(handler, /LIMIT \$\{PUBLIC_PREVIOUS_RESULT_CANDIDATE_LIMIT\}/);
  assert.match(handler, /row\.publication_status === undefined && await isGameResultsPublished/);
  assert.match(handler, /if \(isD1ReadLimitError\(error\)\) throw error/);
});

test("auth.js変更時はindex.htmlの古いcache bustを再利用しない", () => {
  assert.match(indexSource, /auth\.js\?v=d1-read-limit-resilience-20260902/);
  assert.doesNotMatch(indexSource, /auth\.js\?v=auth-api-local-20260719/);
});

test("管理概要向けlistV3Gamesは対象gameと件数をSQLへ渡せる", async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          calls.push({ sql, params });
          return { all: async () => ({ results: [] }) };
        }
      };
    }
  };
  await listV3Games(db, new Date("2026-09-02T00:00:00.000Z"), {
    internalGameId: "target-game-id",
    limit: 7,
    recentFirst: true
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /games\.internal_game_id = \?2/);
  assert.match(calls[0].sql, /ORDER BY games\.start_time DESC/);
  assert.match(calls[0].sql, /LIMIT \?3/);
  assert.deepEqual(calls[0].params, ["2026-09-02", "target-game-id", 7]);
});

test("フロントは401/503/接続失敗を同じ接続不能表示にしない", () => {
  assert.match(authSource, /error\.status = response\.status/);
  assert.match(authSource, /error\.code = payload\?\.code/);
  assert.match(authSource, /toAuthConnectionStatus\(error\)/);
  assert.match(authSource, /ログイン状態を確認できません。未ログインとして利用できます。/);
  assert.match(authSource, /認証サービスが一時的に利用できません。時間をおいて再試行してください。/);
  assert.match(authSource, /認証APIに接続できません。時間をおいて再試行してください。/);
});
