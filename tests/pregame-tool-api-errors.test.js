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

test("NPB Service Binding用Requestは完全修飾URLのルート直下へmodeを保持して生成する", async () => {
  const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;
  const { buildNpbServiceBindingRequest } = await import(authWorkerUrl);

  const roster = buildNpbServiceBindingRequest({ mode: "roster" });
  const rosterUrl = new URL(roster.url);
  assert.equal(roster.method, "GET");
  assert.equal(rosterUrl.protocol, "https:");
  assert.equal(rosterUrl.hostname, "npb-fetch.internal");
  assert.equal(rosterUrl.pathname, "/");
  assert.deepEqual([...rosterUrl.searchParams.entries()], [["mode", "roster"]]);
  assert.equal(roster.headers.get("Cache-Control"), "no-store");

  const notice = new URL(buildNpbServiceBindingRequest({
    mode: "notice",
    date: "2026-07-23"
  }).url);
  assert.equal(notice.pathname, "/");
  assert.equal(notice.searchParams.get("mode"), "notice");
  assert.equal(notice.searchParams.get("date"), "2026-07-23");

  const lineup = new URL(buildNpbServiceBindingRequest({
    mode: "lineup",
    date: "2026-07-23",
    gameCode: "b-f-18",
    ignored: undefined
  }).url);
  assert.equal(lineup.pathname, "/");
  assert.equal(lineup.searchParams.get("mode"), "lineup");
  assert.equal(lineup.searchParams.get("date"), "2026-07-23");
  assert.equal(lineup.searchParams.get("gameCode"), "b-f-18");
  assert.equal(lineup.searchParams.has("ignored"), false);
});

test("NPB Service Bindingの未設定・不正値を503の個別コードで拒否する", async () => {
  const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;
  const { fetchNpbWorkerJson, normalizePregameToolError } = await import(authWorkerUrl);

  await assert.rejects(
    fetchNpbWorkerJson({}, { mode: "roster" }),
    (error) => error?.code === "NPB_SERVICE_BINDING_MISSING"
  );
  await assert.rejects(
    fetchNpbWorkerJson({ NPB_FETCH_WORKER: {} }, { mode: "roster" }),
    (error) => error?.code === "NPB_SERVICE_BINDING_INVALID"
  );
  assert.equal(normalizePregameToolError("run-roster", { code: "NPB_SERVICE_BINDING_MISSING" }).status, 503);
  assert.equal(normalizePregameToolError("run-roster", { code: "NPB_SERVICE_BINDING_INVALID" }).status, 503);
});

test("Auth WorkerはNPB Workerを同一アカウントのService Bindingで参照する", () => {
  const authConfig = JSON.parse(read("wrangler.auth.production.jsonc"));
  const npbConfig = JSON.parse(read("wrangler.npb.jsonc"));
  const authWorker = read("auth-worker.js");

  assert.deepEqual(authConfig.services, [{ binding: "NPB_FETCH_WORKER", service: npbConfig.name }]);
  assert.equal(Object.hasOwn(authConfig.vars, "NPB_FETCH_WORKER_URL"), false);
  assert.match(authWorker, /typeof env\.NPB_FETCH_WORKER\.fetch !== "function"/);
  assert.match(authWorker, /binding\.fetch\(request/);
  assert.doesNotMatch(authWorker, /NPB_FETCH_WORKER_URL/);
  assert.match(authWorker, /transport=\$\{metadata\.transport/);
});

test("notice・roster・lineupは同じService Binding経由で取得し、上流statusを保持する", async () => {
  const authWorkerUrl = pathToFileURL(path.join(root, "auth-worker.js")).href;
  const { fetchNpbWorkerJson, normalizePregameToolError } = await import(authWorkerUrl);
  const receivedRequests = [];
  const env = {
    NPB_FETCH_WORKER: {
      async fetch(request) {
        receivedRequests.push(new URL(request.url));
        return new Response(JSON.stringify({ ok: true, source: "binding" }), { status: 200 });
      }
    }
  };

  await fetchNpbWorkerJson(env, { mode: "notice", date: "2026-07-23" });
  await fetchNpbWorkerJson(env, { mode: "roster" });
  await fetchNpbWorkerJson(env, { mode: "lineup", date: "2026-07-23", gameCode: "b-f-18" });

  assert.equal(receivedRequests.length, 3);
  assert.deepEqual(receivedRequests.map((url) => url.pathname), ["/", "/", "/"]);
  assert.deepEqual(receivedRequests.map((url) => url.searchParams.get("mode")), ["notice", "roster", "lineup"]);
  assert.equal(receivedRequests[0].searchParams.get("date"), "2026-07-23");
  assert.equal(receivedRequests[2].searchParams.get("gameCode"), "b-f-18");

  const errorBinding = {
    NPB_FETCH_WORKER: {
      async fetch() {
        return new Response(JSON.stringify({ ok: false, code: "NPB_HTTP_ERROR" }), { status: 404 });
      }
    }
  };
  await assert.rejects(
    fetchNpbWorkerJson(errorBinding, { mode: "notice", date: "2026-07-23" }),
    (error) => error?.upstreamStatus === 404 && error?.upstreamTransport === "service-binding"
  );
  const routeError = normalizePregameToolError("run-notice", { code: "NPB_HTTP_ERROR", upstreamStatus: 404 });
  assert.deepEqual(routeError, {
    code: "NPB_WORKER_ROUTE_NOT_FOUND",
    status: 502,
    message: "NPB取得WorkerのAPIルートが見つかりません。"
  });

  const lineupBinding = {
    NPB_FETCH_WORKER: {
      async fetch() {
        return new Response(JSON.stringify({ ok: false, code: "LINEUP_NOT_PUBLISHED" }), { status: 422 });
      }
    }
  };
  await assert.rejects(
    fetchNpbWorkerJson(lineupBinding, { mode: "lineup", date: "2026-07-23", gameCode: "b-f-18" }),
    (error) => error?.code === "LINEUP_NOT_PUBLISHED" && error?.upstreamStatus === 422
  );
  assert.equal(normalizePregameToolError("run-lineup", { code: "LINEUP_NOT_PUBLISHED", upstreamStatus: 422 }).status, 409);
});

test("NPB Workerはルート直下のmode指定を受け付け、404ルート誤りと混同しない", () => {
  const worker = read("cloudflare-worker.js");
  assert.match(worker, /const mode = requestUrl\.searchParams\.get\("mode"\)/);
  assert.match(worker, /mode === "roster"/);
  assert.match(worker, /mode === "notice"/);
  assert.match(worker, /mode !== "lineup"/);
  assert.match(read("auth-worker.js"), /Number\(error\?\.upstreamStatus\) === 404/);
});

test("Service BindingのOriginなしRequestもNPB Workerのfetch handlerでCORS拒否されない", async () => {
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
      assert.notEqual(response.status, 403, query);
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
