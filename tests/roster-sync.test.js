const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const authWorker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "cloudflare-worker.js"), "utf8");
const players = fs.readFileSync(path.join(root, "players.js"), "utf8");

test("現在状態テキストを出さず、最新スナップショットで出場候補・その他を絞り込む", () => {
  // Candidate filtering is exercised through the shipped runtime. Keep only
  // the retired-UI/asset contract here, without extracting private functions.
  assert.match(html, /data-roster-filter="active"[^>]*>出場候補/);
  assert.match(html, /data-roster-filter="inactive"[^>]*>その他/);
  assert.doesNotMatch(html, />登録済み</);
  assert.doesNotMatch(html, />未登録</);
  assert.doesNotMatch(html, /predictionRosterFilterCurrent|現在：出場登録/);
  assert.doesNotMatch(script, /predictionRosterFilterCurrent|roster-status-badge/);
});

test("矢澤宏太は投手の公式登録区分でもroster在籍時は出場候補として扱う", () => {
  assert.match(players, /name:\s*"矢澤宏太"[\s\S]*?registeredPosition:\s*"投手"/);
  assert.match(players, /name:\s*"矢澤宏太"[\s\S]*?predictionCandidateRole:\s*"fielder"/);
  assert.match(players, /name:\s*"矢澤宏太"[\s\S]*?isBatterCandidate:\s*true/);
});

test("Workerは現在の出場選手一覧を直接取得し、ゼロ件を成功扱いにしない", () => {
  assert.match(worker, /https:\/\/npb\.jp\/announcement\/roster\//);
  assert.match(worker, /mode === "roster"/);
  assert.match(worker, /if \(!extraction\.players\.length\)/);
  assert.match(worker, /ROSTER_CACHE_TTL_SECONDS = 30 \* 60/);
  assert.match(worker, /cacheStatus: "stale-fallback"/);
});

test("正式roster refreshは取得Workerの30分Cacheを強制回避し、source取得情報を監査へ渡す", () => {
  assert.match(worker, /forceRefresh = \["1", "true", "yes"\]/);
  assert.match(worker, /if \(!forceRefresh\)/);
  assert.match(worker, /"Cache-Control": "no-cache, no-store, max-age=0"/);
  assert.match(worker, /cacheStatus: forceRefresh \? "bypass" : "miss"/);
  assert.match(authWorker, /mode: "roster",[\s\S]*force: force \|\| isV3 \? "1" : undefined/);
  assert.match(authWorker, /rosterSourceCacheStatus/);
  assert.match(authWorker, /rosterSourceFetchedAt/);
});

test("表示用rosterはNPB Workerの30分cacheへ収束し、TTL切れと明示forceだけ外部fetchを増やす", async () => {
  const { default: npbWorker } = await import(pathToFileURL(path.join(root, "cloudflare-worker.js")).href);
  const { fetchLatestPublicRoster } = await import(pathToFileURL(path.join(root, "auth-worker.js")).href);
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const cacheEntries = new Map();
  let externalFetchCount = 0;
  const cache = {
    async match(request) {
      return cacheEntries.get(String(request.url))?.clone() || undefined;
    },
    async put(request, response) {
      cacheEntries.set(String(request.url), response.clone());
    }
  };
  const rosterHtml = `<h5>北海道日本ハムファイターズ</h5><table>
    ${Array.from({ length: 20 }, (_, index) => `<tr><td>${index === 0 ? "投手" : "内野手"}</td><td>${String(index + 1)}</td><td>${index === 0 ? "柴田 獅子" : index === 1 ? "矢澤 宏太" : `選手${index + 1}`}</td></tr>`).join("")}
  </table>`;
  globalThis.caches = { default: cache };
  globalThis.fetch = async () => {
    externalFetchCount += 1;
    return new Response(rosterHtml, { status: 200, headers: { "content-type": "text/html" } });
  };
  const env = {
    NPB_FETCH_WORKER: {
      fetch: (request, options) => npbWorker.fetch(request, { NPB_ALLOWED_ORIGINS: "https://starting9.pages.dev" }, options)
    }
  };
  const game = { internal_game_id: "2f4d9ce8-f3fb-44d6-bc9e-05a3c0dff2e4", game_date: "2026-09-08" };
  const originalNow = Date.now;
  try {
    const first = await fetchLatestPublicRoster(env, game);
    const second = await fetchLatestPublicRoster(env, game);
    assert.equal(first.cacheStatus, "miss");
    assert.equal(second.cacheStatus, "hit");
    assert.equal(externalFetchCount, 1);
    assert.deepEqual(second.players.slice(0, 2).map((player) => player.name), ["柴田獅子", "矢澤宏太"]);
    const initialNow = originalNow();
    Date.now = () => initialNow + (30 * 60 * 1000) + 1;
    const expired = await fetchLatestPublicRoster(env, game);
    const forced = await fetchLatestPublicRoster(env, game, { force: true });
    assert.equal(expired.cacheStatus, "miss");
    assert.equal(forced.cacheStatus, "bypass");
    assert.equal(externalFetchCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
    Date.now = originalNow;
  }
});
