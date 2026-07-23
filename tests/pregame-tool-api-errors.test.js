import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("試合前処理ツールの各APIは管理者ルートへ接続される", () => {
  const worker = read("auth-worker.js");
  const html = read("index.html");
  const script = read("script.js");

  for (const action of ["run-notice", "distribute-notice", "run-roster", "fix-roster", "run-lineup", "publish"]) {
    assert.match(worker, new RegExp(`pregame-automation/${action}`));
  }
  assert.match(worker, /auto-scoring\/run-now/);
  assert.match(worker, /const access = await requireAdminUser\(request, env, cors\)/);
  assert.match(worker, /route\.action === "predictions\/summary"/);
  assert.match(script, /buildAdminGameApiUrl\(gameId, `pregame-automation\/\$\{action\}`\)/);
  assert.match(script, /buildAdminGameApiUrl\(gameId, "auto-scoring\/run-now"\)/);
  assert.match(html, /id="runPregameNoticeButton"/);
  assert.match(html, /id="distributePregameNoticeButton"/);
  assert.match(html, /id="runPregameRosterButton"/);
  assert.match(html, /id="fixPregameRosterButton"/);
  assert.match(html, /id="runPregameLineupButton"/);
  assert.match(html, /id="runPregameScoringButton"/);
  assert.match(html, /id="publishPregameResultsButton"/);
});

test("NPB WorkerのHTTP・JSON失敗を上流status付きで個別処理する", () => {
  const worker = read("auth-worker.js");
  const npbWorker = read("cloudflare-worker.js");
  assert.match(worker, /response\.status/);
  assert.match(worker, /NPB_RESPONSE_INVALID/);
  assert.match(worker, /NPB_WORKER_TIMEOUT/);
  assert.match(worker, /upstreamStatus/);
  assert.match(worker, /NOTICE_FETCH_FAILED/);
  assert.match(worker, /NOTICE_PARSE_FAILED/);
  assert.match(worker, /ROSTER_FETCH_FAILED/);
  assert.match(worker, /ROSTER_PARSE_FAILED/);
  assert.match(worker, /NPB_WORKER_ROUTE_NOT_FOUND/);
  assert.match(worker, /upstreamPath/);
  assert.match(worker, /upstreamMode/);
  assert.match(worker, /LINEUP_FETCH_FAILED/);
  assert.match(worker, /LINEUP_NOT_PUBLISHED/);
  assert.match(worker, /LINEUP_INVALID/);
  assert.match(npbWorker, /code: "NOTICE_FETCH_FAILED"/);
  assert.match(npbWorker, /code: "NOTICE_PARSE_FAILED"/);
  assert.match(npbWorker, /code: "ROSTER_FETCH_FAILED"/);
  assert.match(npbWorker, /code: "ROSTER_PARSE_FAILED"/);
});

test("NPB Worker URLは環境変数の余分なpath・queryを捨て、ルート直下へ正規化する", async () => {
  const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;
  const { buildNpbWorkerUrl, getNpbFetchWorkerBaseUrl } = await import(authWorkerUrl);

  for (const baseUrl of [
    "https://starting9-npb-fetch.tanzana7.workers.dev",
    "https://starting9-npb-fetch.tanzana7.workers.dev/",
    "https://starting9-npb-fetch.tanzana7.workers.dev/api/legacy?old=1#stale"
  ]) {
    const roster = buildNpbWorkerUrl(getNpbFetchWorkerBaseUrl({ NPB_FETCH_WORKER_URL: baseUrl }), { mode: "roster" });
    assert.equal(roster.pathname, "/");
    assert.deepEqual([...roster.searchParams.entries()], [["mode", "roster"]]);
    assert.equal(roster.hash, "");
  }

  const notice = buildNpbWorkerUrl("https://starting9-npb-fetch.tanzana7.workers.dev/api", {
    mode: "notice",
    date: "2026-07-23"
  });
  assert.equal(notice.pathname, "/");
  assert.equal(notice.searchParams.get("mode"), "notice");
  assert.equal(notice.searchParams.get("date"), "2026-07-23");

  const lineup = buildNpbWorkerUrl("https://starting9-npb-fetch.tanzana7.workers.dev/api", {
    mode: "lineup",
    date: "2026-07-23",
    gameCode: "b-f-18",
    ignored: undefined
  });
  assert.equal(lineup.pathname, "/");
  assert.equal(lineup.searchParams.get("mode"), "lineup");
  assert.equal(lineup.searchParams.get("date"), "2026-07-23");
  assert.equal(lineup.searchParams.get("gameCode"), "b-f-18");
  assert.equal(lineup.searchParams.has("ignored"), false);
});

test("NPB Worker接続先の未設定・不正値を個別コードで拒否する", async () => {
  const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;
  const { getNpbFetchWorkerBaseUrl } = await import(authWorkerUrl);

  assert.throws(
    () => getNpbFetchWorkerBaseUrl({}),
    (error) => error?.code === "NPB_WORKER_URL_MISSING"
  );
  assert.throws(
    () => getNpbFetchWorkerBaseUrl({ NPB_FETCH_WORKER_URL: "https://example.invalid/api" }),
    (error) => error?.code === "NPB_WORKER_URL_INVALID"
  );
});

test("NPB Workerはルート直下のmode指定を受け付け、404ルート誤りと混同しない", () => {
  const worker = read("cloudflare-worker.js");
  assert.match(worker, /const mode = requestUrl\.searchParams\.get\("mode"\)/);
  assert.match(worker, /mode === "roster"/);
  assert.match(worker, /mode === "notice"/);
  assert.match(worker, /mode !== "lineup"/);
  assert.match(read("auth-worker.js"), /Number\(error\?\.upstreamStatus\) === 404/);
});

test("生成したルート直下URLはNPB Workerのfetch handlerで404にならない", async () => {
  const workerModuleUrl = pathToFileURL(path.join(root, "cloudflare-worker.js")).href;
  const { default: worker } = await import(workerModuleUrl);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html><body></body></html>", { status: 200 });

  try {
    for (const query of [
      "?mode=roster",
      "?mode=notice&date=2026-07-23",
      "?mode=lineup&date=2026-07-23&gameCode=b-f-18"
    ]) {
      const response = await worker.fetch(new Request(`https://starting9-npb-fetch.tanzana7.workers.dev/${query}`), {});
      assert.notEqual(response.status, 404, query);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("D1不足を処理別schema errorとして返し、成功レスポンスでstatus再取得しない", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /function isPregameSchemaError\(error\)/);
  assert.match(worker, /NOTICE_SCHEMA_NOT_READY/);
  assert.match(worker, /ROSTER_SCHEMA_NOT_READY/);
  assert.match(worker, /LINEUP_SCHEMA_NOT_READY/);
  assert.match(worker, /PUBLISH_SCHEMA_NOT_READY/);
  assert.doesNotMatch(worker, /result, pregame: await getPregameAutomationStatus/);
  assert.match(worker, /function executePregameTool\(env, cors, gameId, action, operation\)/);
});

test("採点前提不足は409の安全なコードを返す", () => {
  const worker = read("auth-worker.js");
  assert.match(worker, /SCORING_LINEUP_REQUIRED/);
  assert.match(worker, /SCORING_IN_PROGRESS/);
  assert.match(worker, /httpStatus: 409/);
});

test("管理画面はエラーmessage・code・HTTP statusを表示する", () => {
  const script = read("script.js");
  assert.match(script, /function getSafePregameActionError\(response, payload, action = ""\)/);
  assert.match(script, /payload\?\.error/);
  assert.match(script, /コード：\$\{safeCode\}/);
  assert.match(script, /HTTP \$\{response\.status\}/);
});

test("migration 0009/0010が試合前処理のD1前提を定義する", () => {
  const migration0009 = read(path.join("migrations", "0009_pregame_automation.sql"));
  const migration0010 = read(path.join("migrations", "0010_game_day_schedule_flow.sql"));
  assert.match(migration0009, /CREATE TABLE IF NOT EXISTS game_roster_snapshots/);
  assert.match(migration0009, /CREATE TABLE IF NOT EXISTS game_pregame_automation/);
  assert.match(migration0010, /CREATE TABLE IF NOT EXISTS game_day_notices/);
  assert.match(migration0010, /CREATE TABLE IF NOT EXISTS game_day_notice_games/);
  assert.match(migration0010, /ALTER TABLE game_pregame_automation ADD COLUMN roster_fixed_at/);
  assert.match(migration0010, /ALTER TABLE game_lineups ADD COLUMN publication_status/);
});
