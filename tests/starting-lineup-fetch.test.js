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
