import assert from "node:assert/strict";
import test from "node:test";
import worker from "../auth-worker.js";

const ALLOWED_ORIGINS = "https://starting9.pages.dev,https://preview.starting9.pages.dev";

class MemoryCache {
  constructor() {
    this.entries = new Map();
  }

  async match(request) {
    const response = this.entries.get(request.url);
    return response ? response.clone() : undefined;
  }

  async put(request, response) {
    this.entries.set(request.url, response.clone());
  }

  evictFresh(kind) {
    for (const key of this.entries.keys()) {
      if (key.includes(`/${kind}/fresh`)) this.entries.delete(key);
    }
  }

  keys() {
    return [...this.entries.keys()];
  }
}

function createContext() {
  const waits = [];
  return {
    waits,
    waitUntil(promise) {
      waits.push(Promise.resolve(promise));
    }
  };
}

function quotaError() {
  return Object.assign(new Error("Your account has exceeded D1's free tier daily row read limit"), { code: 7500 });
}

function createPublicDb({ rows, error = null }) {
  let prepareCount = 0;
  const db = {
    get prepareCount() {
      return prepareCount;
    },
    prepare(sql) {
      prepareCount += 1;
      return {
        bind() {
          return {
            all: async () => {
              if (error) throw error;
              if (sql.startsWith("PRAGMA table_info")) {
                return { results: [{ name: "ranking_eligibility_status" }] };
              }
              return { results: rows };
            }
          };
        }
      };
    }
  };
  return db;
}

function gameRow() {
  return {
    internal_game_id: "11111111-1111-4111-8111-111111111111",
    game_date: "2026-09-02",
    start_time: "2026-09-02T09:00:00.000Z",
    home_team: "fighters",
    away_team: "hawks",
    game_status: "scheduled",
    workflow_status: "scheduled",
    publication_status: "",
    published_at: "",
    ranking_eligibility_status: "eligible"
  };
}

function previousResultRow() {
  return {
    internal_game_id: "22222222-2222-4222-8222-222222222222",
    game_date: "2026-09-01",
    start_time: "2026-09-01T09:00:00.000Z",
    home_team: "fighters",
    away_team: "hawks",
    game_status: "scored",
    ranking_eligibility_status: "eligible",
    publication_status: "published",
    published_at: "2026-09-02T01:26:26.990Z",
    is_test_game: 0
  };
}

async function invoke(path, env, ctx = createContext(), origin = "https://starting9.pages.dev") {
  return worker.fetch(new Request(`https://starting9-auth.test${path}`, {
    headers: { Origin: origin }
  }), { AUTH_ALLOWED_ORIGINS: ALLOWED_ORIGINS, ...env }, ctx);
}

test("public gamesはcache missでbounded D1を読み、次回hitではD1を読まない", async () => {
  const cache = new MemoryCache();
  const db = createPublicDb({ rows: [gameRow()] });
  const first = await invoke("/api/public/games", { AUTH_DB: db, PUBLIC_CACHE: cache });
  const firstBody = await first.json();

  assert.equal(first.status, 200);
  assert.equal(firstBody.cacheStatus, "miss");
  assert.equal(firstBody.stale, false);
  assert.equal(firstBody.source, "d1");
  assert.equal(firstBody.games.length, 1);
  assert.equal(db.prepareCount, 2, "PRAGMAとbounded本体queryのみ");
  const freshKey = cache.keys().find((key) => key.includes("/games/fresh"));
  assert.ok(freshKey);
  const stored = await cache.match(new Request(freshKey));
  assert.match(stored.headers.get("Cache-Control") || "", /^public, max-age=60$/);
  assert.equal(stored.headers.get("Access-Control-Allow-Origin"), null, "保存データへCORSを持ち込まない");
  assert.equal(stored.headers.get("Set-Cookie"), null, "保存データへcookieを持ち込まない");

  const noReadDb = {
    prepare() {
      throw new Error("cache hit must not access D1");
    }
  };
  const second = await invoke("/api/public/games", { AUTH_DB: noReadDb, PUBLIC_CACHE: cache });
  const secondBody = await second.json();

  assert.equal(second.status, 200);
  assert.deepEqual(secondBody.games, firstBody.games);
  assert.equal(secondBody.cacheStatus, "hit");
  assert.equal(secondBody.stale, false);
  assert.equal(secondBody.source, "public_cache");
});

test("public gamesはD1 quota時にstale cacheを返し、cacheなしなら既存503分類を維持する", async () => {
  const cache = new MemoryCache();
  const seededDb = createPublicDb({ rows: [gameRow()] });
  await invoke("/api/public/games", { AUTH_DB: seededDb, PUBLIC_CACHE: cache });
  cache.evictFresh("games");

  const stale = await invoke("/api/public/games", { AUTH_DB: createPublicDb({ rows: [], error: quotaError() }), PUBLIC_CACHE: cache });
  const staleBody = await stale.json();
  assert.equal(stale.status, 200);
  assert.equal(staleBody.cacheStatus, "stale");
  assert.equal(staleBody.stale, true);
  assert.equal(staleBody.source, "public_cache_stale");
  assert.equal(staleBody.games.length, 1);

  const unavailable = await invoke("/api/public/games", { AUTH_DB: createPublicDb({ rows: [], error: quotaError() }) });
  const unavailableBody = await unavailable.json();
  assert.equal(unavailable.status, 503);
  assert.equal(unavailableBody.code, "D1_READ_LIMIT_EXCEEDED");
  assert.match(unavailable.headers.get("Retry-After") || "", /^\d+$/);
});

test("previous-result-gameもcache miss/hitとstale fallbackを持ち、レスポンス形を維持する", async () => {
  const cache = new MemoryCache();
  const db = createPublicDb({ rows: [previousResultRow()] });
  const first = await invoke("/api/public/previous-result-game", { AUTH_DB: db, PUBLIC_CACHE: cache });
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.cacheStatus, "miss");
  assert.equal(firstBody.game.state, "published");
  assert.equal(firstBody.game.resultsPublished, true);
  assert.equal(db.prepareCount, 1, "previous resultはbounded query一回");

  const hit = await invoke("/api/public/previous-result-game", {
    AUTH_DB: { prepare() { throw new Error("previous-result cache hit must not access D1"); } },
    PUBLIC_CACHE: cache
  });
  const hitBody = await hit.json();
  assert.equal(hit.status, 200);
  assert.deepEqual(hitBody.game, firstBody.game);
  assert.equal(hitBody.cacheStatus, "hit");
  assert.equal(hitBody.stale, false);

  cache.evictFresh("previous-result-game");
  const stale = await invoke("/api/public/previous-result-game", {
    AUTH_DB: createPublicDb({ rows: [], error: quotaError() }),
    PUBLIC_CACHE: cache
  });
  const staleBody = await stale.json();
  assert.equal(stale.status, 200);
  assert.equal(staleBody.cacheStatus, "stale");
  assert.equal(staleBody.stale, true);
  assert.equal(staleBody.game.internalGameId, firstBody.game.internalGameId);

  const unavailable = await invoke("/api/public/previous-result-game", {
    AUTH_DB: createPublicDb({ rows: [], error: quotaError() })
  });
  const unavailableBody = await unavailable.json();
  assert.equal(unavailable.status, 503);
  assert.equal(unavailableBody.code, "D1_READ_LIMIT_EXCEEDED");
});

test("public cache hitでもリクエストごとのCORSを再生成し、別originのヘッダーを混入させない", async () => {
  const cache = new MemoryCache();
  await invoke("/api/public/games", { AUTH_DB: createPublicDb({ rows: [gameRow()] }), PUBLIC_CACHE: cache });
  const response = await invoke(
    "/api/public/games",
    { AUTH_DB: createPublicDb({ rows: [], error: quotaError() }), PUBLIC_CACHE: cache },
    createContext(),
    "https://preview.starting9.pages.dev"
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://preview.starting9.pages.dev");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("auth/admin系はpublic cacheへ保存せず、認証系のcache keyを作らない", async () => {
  const cache = new MemoryCache();
  const env = { AUTH_DB: createPublicDb({ rows: [] }), PUBLIC_CACHE: cache };
  const first = await invoke("/api/auth/me", env);
  const second = await invoke("/api/auth/me", env);
  const admin = await invoke("/api/admin/me", env);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(admin.status, 401);
  assert.deepEqual(cache.keys(), []);
});

test("health endpointはD1なしで応答し、databaseを未確認として明示する", async () => {
  const response = await invoke("/health", {});
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.database, "not_checked");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});
