const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..");
const workerPath = path.join(root, "cloudflare-worker.js");
const workerSource = fs.readFileSync(workerPath, "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");

function createOrderRows(rows) {
  return rows.map(([order, position, player]) => `
    <tr><th>${order}</th><th>${position}</th><td>${player}</td><td>&nbsp;</td></tr>`).join("");
}

function createOfficialScorePageHtml({ homeTeam = "北海道日本ハムファイターズ", awayTeam = "千葉ロッテマリーンズ", venue = "エスコンＦ", startTime = "14:00" } = {}) {
  const rows = [
    [1, "遊", "水野"], [2, "一", "清宮幸"], [3, "DH", "レイエス"],
    [4, "右", "万波"], [5, "左", "郡司"], [6, "三", "野村"],
    [7, "中", "五十幡"], [8, "二", "山縣"], [9, "捕", "清水優"]
  ];
  return `<time>2026年8月29日（土）</time><span class="place">${venue}</span>
    <h3>【パーソル パ・リーグ公式戦】 ${homeTeam} vs ${awayTeam}</h3>
    <p class="game_info">◇開始 ${startTime}</p>
    <div id="player-order"><h4>最新のオーダー</h4><h5>${homeTeam}</h5><table>${createOrderRows(rows)}</table></div>`;
}

function createScoreIndexHtml(candidates) {
  return `<div class="score_box date"><div>2026<br>8/29 Sat.</div></div>${candidates.map(({ code, homeTeam, awayTeam }) => `
    <div class="score_box"><a href="/scores/2026/0829/${code}/"><img alt="${homeTeam}" title="${homeTeam}"><img alt="${awayTeam}" title="${awayTeam}"></a></div>`).join("")}`;
}

async function loadWorkerHelpers() {
  return import(pathToFileURL(workerPath).href);
}

test("日付と試合コードからNPB公式スコアURLだけを生成する", async () => {
  const { createLineupSourceFromIdentity, validateTargetUrl } = await loadWorkerHelpers();
  const source = createLineupSourceFromIdentity("2026-07-20", "b-f-18");

  assert.deepEqual(source, {
    ok: true,
    date: "2026-07-20",
    gameCode: "b-f-18",
    url: "https://npb.jp/scores/2026/0720/b-f-18/"
  });
  assert.equal(createLineupSourceFromIdentity("2026-02-30", "b-f-18").ok, false);
  assert.equal(createLineupSourceFromIdentity("2026-07-20", "../../example").ok, false);
  assert.equal(validateTargetUrl("https://example.com/scores/2026/0720/b-f-18/").ok, false);
});

test("NPBの選手オーダー表から日本ハムの有効な9人だけを抽出する", async () => {
  const { extractNpbOrderText } = await loadWorkerHelpers();
  const rows = [
    [1, "遊", "水野"], [2, "一", "清宮幸"], [3, "DH", "レイエス"],
    [4, "右", "万波"], [5, "左", "郡司"], [6, "三", "野村"],
    [7, "中", "五十幡"], [8, "二", "山縣"], [9, "捕", "清水優"]
  ];
  const html = `<div id="player-order"><h4>最新のオーダー</h4><div class="half_left">
    <h5>北海道日本ハムファイターズ</h5><table><tbody>${createOrderRows(rows)}
    <tr><th>&nbsp;</th><th>投</th><td>伊藤</td></tr></tbody></table></div></div>`;
  const extraction = extractNpbOrderText(html);

  assert.equal(extraction.rows.length, 9);
  assert.equal(extraction.rows[0].player, "水野達稀");
  assert.match(extraction.lineupText, /^1 遊 水野達稀/m);
  assert.match(extraction.lineupText, /^9 捕 清水優/m);
});

test("代打を含む不完全な最新オーダーは相手チームの行を混ぜずINVALID_LINEUP用に失敗する", async () => {
  const { extractNpbOrderText } = await loadWorkerHelpers();
  const rows = [
    [1, "遊", "水野"], [2, "一", "清宮幸"], [3, "DH", "レイエス"],
    [4, "右", "万波"], [5, "左", "郡司"], [6, "三", "野村"],
    [7, "打", "上川畑"], [8, "二", "山縣"], [9, "捕", "清水優"]
  ];
  const html = `<div id="player-order"><h4>最新のオーダー</h4><div class="half_left">
    <h5>北海道日本ハムファイターズ</h5><table><tbody>${createOrderRows(rows)}</tbody></table></div>
    <div class="half_right"><h5>オリックス・バファローズ</h5><table><tbody>${createOrderRows([[1, "一", "山中"]])}</tbody></table></div></div>`;
  const extraction = extractNpbOrderText(html);

  assert.equal(extraction.lineupText, "");
  assert.equal(extraction.debug.failedAt, "table-invalid");
  assert.equal(extraction.debug.foundFightersTeam, true);
});

test("通常公開bundleは専用Workerへ直接lineup取得を行わず、保存済みV3結果を表示する", () => {
  assert.doesNotMatch(script, /NPB_WORKER_PRODUCTION_URL|workerUrl\.searchParams\.set\("mode", "lineup"\)|showNpbFetchFailure/);
  assert.match(script, /fetchStoredProbableStarter|fetchGameDayRosterSnapshot/);
});

test("WorkerはPagesとローカルだけをCORS許可し、診断コードを返す", () => {
  assert.match(workerSource, /NPB_ALLOWED_ORIGINS/);
  assert.match(workerSource, /https:\/\/starting9\.pages\.dev/);
  assert.match(workerSource, /http:\/\/localhost:4173/);
  assert.match(workerSource, /http:\/\/127\.0\.0\.1:4173/);
  assert.match(workerSource, /LINEUP_NOT_PUBLISHED/);
  assert.match(workerSource, /INVALID_LINEUP/);
  assert.match(workerSource, /TIMEOUT/);
  assert.match(workerSource, /LINEUP_CACHE_TTL_SECONDS = 5 \* 60/);
  assert.match(workerSource, /cacheStatus: "hit"/);
  assert.doesNotMatch(workerSource, /Access-Control-Allow-Origin": "\*"/);
});

test("WorkerのlineupルートはCORS付きの正規化済みスタメンを返す", async () => {
  const { default: worker } = await loadWorkerHelpers();
  const originalFetch = globalThis.fetch;
  const rows = [
    [1, "遊", "水野"], [2, "一", "清宮幸"], [3, "DH", "レイエス"],
    [4, "右", "万波"], [5, "左", "郡司"], [6, "三", "野村"],
    [7, "中", "五十幡"], [8, "二", "山縣"], [9, "捕", "清水優"]
  ];

  globalThis.fetch = async () => new Response(
    `<div id="player-order"><h4>最新のオーダー</h4><h5>北海道日本ハムファイターズ</h5><table>${createOrderRows(rows)}</table></div>`,
    { status: 200 }
  );

  try {
    const response = await worker.fetch(
      new Request("https://worker.example/?mode=lineup&date=2026-07-20&gameCode=b-f-18", {
        headers: { Origin: "https://starting9.pages.dev" }
      }),
      { NPB_ALLOWED_ORIGINS: "https://starting9.pages.dev" }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://starting9.pages.dev");
    assert.equal(body.lineup.length, 9);
    assert.equal(body.lineup[0].playerName, "水野達稀");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("保存コードが404の場合、公式同日スコアインデックスから試合一致するコードへfallbackする", async () => {
  const { default: worker } = await loadWorkerHelpers();
  const originalFetch = globalThis.fetch;
  const indexUrl = "https://npb.jp/scores/2026/0829/";
  const resolvedUrl = "https://npb.jp/scores/2026/0829/f-m-20/";
  globalThis.fetch = async (request) => {
    const url = String(request.url || request);
    if (url.endsWith("/f-m-21/")) return new Response("", { status: 404 });
    if (url === indexUrl) return new Response(createScoreIndexHtml([
      { code: "f-m-20", homeTeam: "北海道日本ハムファイターズ", awayTeam: "千葉ロッテマリーンズ" }
    ]), { status: 200 });
    if (url === resolvedUrl) return new Response(createOfficialScorePageHtml(), { status: 200 });
    return new Response("", { status: 404 });
  };

  try {
    const response = await worker.fetch(new Request(
      "https://worker.example/?mode=lineup&date=2026-08-29&gameCode=f-m-21&homeTeam=fighters&awayTeam=marines&startAt=2026-08-29T05:00:00.000Z&venue=%E3%82%A8%E3%82%B9%E3%82%B3%E3%83%B3%EF%BC%A6",
      { headers: { Origin: "https://starting9.pages.dev" } }
    ), { NPB_ALLOWED_ORIGINS: "https://starting9.pages.dev" });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.sourceUrl, resolvedUrl);
    assert.equal(body.gameCode, "f-m-20");
    assert.equal(body.lineup.length, 9);
    assert.equal(body.diagnostics.attemptedUrl, "https://npb.jp/scores/2026/0829/f-m-21/");
    assert.equal(body.diagnostics.finalSelectedUrl, resolvedUrl);
    assert.equal(body.diagnostics.originalStoredGameCode, "f-m-21");
    assert.equal(body.diagnostics.resolvedScorePageCode, "f-m-20");
    assert.equal(body.diagnostics.originStatus, 404);
    assert.equal(body.diagnostics.fetchWorkerStatus, 200);
    assert.equal(body.diagnostics.fallbackUsed, true);
    assert.equal(body.diagnostics.fallbackCandidateCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("公式候補が対象試合と一致しない場合は誤採用せず、reject理由を返す", async () => {
  const { default: worker } = await loadWorkerHelpers();
  const originalFetch = globalThis.fetch;
  const indexUrl = "https://npb.jp/scores/2026/0829/";
  globalThis.fetch = async (request) => {
    const url = String(request.url || request);
    if (url.endsWith("/f-m-21/")) return new Response("", { status: 404 });
    if (url === indexUrl) return new Response(createScoreIndexHtml([
      { code: "f-m-20", homeTeam: "北海道日本ハムファイターズ", awayTeam: "千葉ロッテマリーンズ" }
    ]), { status: 200 });
    if (url.endsWith("/f-m-20/")) return new Response(createOfficialScorePageHtml({ startTime: "18:00" }), { status: 200 });
    return new Response("", { status: 404 });
  };

  try {
    const response = await worker.fetch(new Request(
      "https://worker.example/?mode=lineup&date=2026-08-29&gameCode=f-m-21&homeTeam=fighters&awayTeam=marines&startAt=2026-08-29T05:00:00.000Z",
      { headers: { Origin: "https://starting9.pages.dev" } }
    ), { NPB_ALLOWED_ORIGINS: "https://starting9.pages.dev" });
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.code, "NPB_HTTP_ERROR");
    assert.equal(body.diagnostics.fallbackUsed, false);
    assert.match(body.diagnostics.fallbackRejectReasons.join(" "), /START_TIME_MISMATCH/);
    assert.equal(body.diagnostics.resolvedScorePageCode, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("公式候補が複数一致する場合は曖昧なまま採用せず、再試行可能なエラーにする", async () => {
  const { default: worker } = await loadWorkerHelpers();
  const originalFetch = globalThis.fetch;
  const indexUrl = "https://npb.jp/scores/2026/0829/";
  globalThis.fetch = async (request) => {
    const url = String(request.url || request);
    if (url.endsWith("/f-m-19/")) return new Response("", { status: 404 });
    if (url === indexUrl) return new Response(createScoreIndexHtml([
      { code: "f-m-20", homeTeam: "北海道日本ハムファイターズ", awayTeam: "千葉ロッテマリーンズ" },
      { code: "f-m-21", homeTeam: "北海道日本ハムファイターズ", awayTeam: "千葉ロッテマリーンズ" }
    ]), { status: 200 });
    if (url.endsWith("/f-m-20/") || url.endsWith("/f-m-21/")) return new Response(createOfficialScorePageHtml(), { status: 200 });
    return new Response("", { status: 404 });
  };

  try {
    const response = await worker.fetch(new Request(
      "https://worker.example/?mode=lineup&date=2026-08-29&gameCode=f-m-19&homeTeam=fighters&awayTeam=marines&startAt=2026-08-29T05:00:00.000Z",
      { headers: { Origin: "https://starting9.pages.dev" } }
    ), { NPB_ALLOWED_ORIGINS: "https://starting9.pages.dev" });
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.code, "NPB_SCORE_PAGE_AMBIGUOUS");
    assert.equal(body.diagnostics.fallbackUsed, false);
    assert.equal(body.diagnostics.fallbackCandidateCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
