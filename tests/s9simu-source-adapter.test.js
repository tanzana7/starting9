import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSimulatorSourceUrl,
  classifyExternalGameStatus,
  fetchSimulatorSource,
  normalizeSimulatorBaseUrl,
  normalizeExternalGameStatus,
  parseSimulatorResponse,
  resolveNpbSource
} from "../backend/npb-source-adapter.js";
import { createOfficialLineupFromNpb, fetchNpbWorkerJson, findProbableStarterGame } from "../auth-worker.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIMULATOR = "https://s9simu.tanzana7.workers.dev";
const starterHtml = `<!doctype html><article data-game-code="m-f-25" data-game-date="2026-09-28" data-home-team="marines" data-away-team="fighters" data-game-status="probable_announced"><dl><dt>Home</dt><dd>S. Mori</dd><dt>Away</dt><dd>T. Kato</dd></dl></article>`;
const lineupRows = Array.from({ length: 9 }, (_, index) => {
  const position = ["CF", "2B", "1B", "DH", "3B", "SS", "RF", "C", "P"][index];
  return `<tr data-batting-order="${index + 1}"><td data-player-id="f-${index + 1}" data-player-name="Fighters Player ${index + 1}">Fighters Player ${index + 1}</td><td data-position="${position}">${position}</td><td data-jersey-number="${index + 1}">${index + 1}</td></tr>`;
}).join("");
const lineupHtml = `<div class="card" data-game-id="game-a" data-game-code="m-f-25" data-game-date="2026-09-28" data-home-team="marines" data-away-team="fighters" data-game-status="lineup_announced"><table data-lineup-team="fighters">${lineupRows}</table></div>`;

function response(body, status = 200, contentType = "text/html; charset=utf-8") {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

test("未設定・officialは既存official sourceを選ぶ", () => {
  assert.equal(resolveNpbSource({}).kind, "official");
  assert.equal(resolveNpbSource({ NPB_SOURCE: "official", ENABLE_DEVELOPMENT_MODE: "true" }).kind, "official");
});

test("development/testだけsimulator sourceを選べる", () => {
  assert.equal(resolveNpbSource({ NPB_SOURCE: "simulator", ENABLE_DEVELOPMENT_MODE: "true" }).kind, "simulator");
  assert.equal(resolveNpbSource({ NPB_SOURCE: "simulator", ENVIRONMENT: "test" }).kind, "simulator");
});

test("productionのsimulator指定はofficialへfail-closedする", () => {
  const result = resolveNpbSource({ NPB_SOURCE: "simulator", ENABLE_DEVELOPMENT_MODE: "false" });
  assert.deepEqual(result, { kind: "official", requested: "simulator", guarded: true, reason: "simulator_requires_non_production_environment" });
  assert.equal(resolveNpbSource({ NPB_SOURCE: "simulator", ENVIRONMENT: "production", ENABLE_DEVELOPMENT_MODE: "true" }).kind, "official");
});

test("simulator URLは設定されたoriginから安全に構成する", () => {
  assert.equal(normalizeSimulatorBaseUrl(`${SIMULATOR}/`), SIMULATOR);
  assert.equal(buildSimulatorSourceUrl(SIMULATOR, { mode: "starter" }), `${SIMULATOR}/simu-npb/announcement/starter/`);
  assert.equal(buildSimulatorSourceUrl(SIMULATOR, { mode: "roster", team: "marines" }), `${SIMULATOR}/simu-npb/announcement/roster/marines/`);
  assert.equal(buildSimulatorSourceUrl(SIMULATOR, { mode: "schedule", date: "2026-09-28", team: "all" }), `${SIMULATOR}/simu-npb/api/public/games?date=2026-09-28&team=all`);
  assert.equal(buildSimulatorSourceUrl(SIMULATOR, { mode: "lineup", date: "2026-09-28", gameCode: "M-F-25" }), `${SIMULATOR}/simu-npb/scores/2026/0928/m-f-25/`);
  assert.throws(() => normalizeSimulatorBaseUrl("https://example.test/proxy"), /not allowed|origin/);
  assert.throws(() => buildSimulatorSourceUrl(SIMULATOR, { mode: "lineup", date: "2026-09-28", gameCode: "../../secret" }), /identity is invalid/);
});

test("simulator starter HTMLはofficialと同じgames shapeへ変換される", async () => {
  const result = await parseSimulatorResponse(response(starterHtml), { mode: "starter" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.games[0], {
    date: "2026-09-28",
    gameCode: "m-f-25",
    npbGameCode: "m-f-25",
    homeTeam: "marines",
    awayTeam: "fighters",
    gameStatus: "probable_announced",
    homeStarter: { name: "S. Mori" },
    awayStarter: { name: "T. Kato" }
  });
});

test("simulator lineup HTMLは9人のcanonical lineupへ変換される", async () => {
  const result = await parseSimulatorResponse(response(lineupHtml), { mode: "lineup" });
  assert.equal(result.ok, true);
  assert.equal(result.payload.lineup.length, 9);
  assert.deepEqual(result.payload.lineup[0], { order: 1, playerId: "f-1", playerName: "Fighters Player 1", position: "CF", uniformNumber: "1" });
  assert.equal(result.payload.lineup[8].position, "指");
  assert.equal(result.payload.status, "lineup_announced");
  assert.equal(createOfficialLineupFromNpb(result.payload.lineup).ok, true);
});

test("simulator schedule JSONはformal sync candidate shapeと段階件数へ変換される", async () => {
  const result = await parseSimulatorResponse(response(JSON.stringify({ games: [{ gameId: "game-a", gameDate: "2026-09-28", startAt: "2026-09-28T18:00:00+09:00", homeTeam: "marines", awayTeam: "fighters", npbGameCode: "m-f-25", status: "scheduled" }] }), 200, "application/json"), { mode: "schedule", date: "2026-09-28", team: "all" });
  assert.equal(result.ok, true);
  assert.equal(result.payload.games[0].gameId, "game-a");
  assert.equal(result.payload.games[0].gameCode, "m-f-25");
  assert.equal(result.payload.games[0].startTime, "18:00");
  assert.deepEqual(result.payload.scheduleDiagnostics, {
    rawGamesCount: 1,
    parsedGamesCount: 1,
    filteredGamesCount: 1,
    normalizedGamesCount: 1
  });
});

test("simulator schedule JSON rejects rows outside the requested date", async () => {
  const result = await parseSimulatorResponse(response(JSON.stringify({ games: [
    { gameId: "wrong-date", gameDate: "2026-09-29", startAt: "2026-09-29T18:00:00+09:00", homeTeam: "marines", awayTeam: "fighters", npbGameCode: "m-f-25", status: "scheduled" }
  ] }), 200, "application/json"), { mode: "schedule", date: "2026-09-28", team: "all" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.games, []);
  assert.equal(result.payload.scheduleDiagnostics.rawGamesCount, 1);
  assert.equal(result.payload.scheduleDiagnostics.parsedGamesCount, 0);
});

test("S9simuの試合前中止とno-gameをcanonical statusへ正規化する", async () => {
  const result = await parseSimulatorResponse(response(JSON.stringify({ games: [
    { gameId: "cancelled", gameDate: "2026-09-28", startAt: "2026-09-28T18:00:00+09:00", homeTeam: "marines", awayTeam: "fighters", npbGameCode: "m-f-25", status: "canceled" },
    { gameId: "no-game", gameDate: "2026-09-29", startAt: "2026-09-29T18:00:00+09:00", homeTeam: "marines", awayTeam: "fighters", npbGameCode: "m-f-26", status: "no-game" }
  ] }), 200, "application/json"), { mode: "schedule", team: "all" });
  assert.deepEqual(result.payload.games.map((game) => game.status), ["cancelled", "no_game"]);
  assert.equal(classifyExternalGameStatus("no-game"), "no_game");
  assert.equal(normalizeExternalGameStatus("unknown-future-state"), "unknown_future_state");
  assert.equal(classifyExternalGameStatus("unknown-future-state"), "unknown");
});

test("probable starterはofficial/simulatorで同じmatch関数へ渡せる", async () => {
  const result = await parseSimulatorResponse(response(starterHtml), { mode: "starter" });
  const matched = findProbableStarterGame({ date: "2026-09-28", homeTeam: "marines", awayTeam: "fighters" }, result.payload.games);
  assert.equal(matched.homeStarter.name, "S. Mori");
  assert.equal(matched.awayStarter.name, "T. Kato");
});

test("simulator cancellation/no-game statusは上位へ渡せる", async () => {
  for (const [sourceStatus, canonicalStatus] of [["cancelled", "cancelled"], ["no-game", "no_game"]]) {
    const result = await parseSimulatorResponse(response(`<div class="card" data-game-code="m-f-25" data-game-status="${sourceStatus}"></div>`), { mode: "lineup" });
    assert.equal(result.ok, true);
    assert.equal(result.payload.status, canonicalStatus);
    assert.deepEqual(result.payload.lineup, []);
  }
});

test("simulator HTTP failureとHTML failureは成功扱いにならない", async () => {
  assert.equal((await parseSimulatorResponse(response("", 404), { mode: "lineup" })).code, "NPB_HTTP_ERROR");
  assert.equal((await parseSimulatorResponse(response("", 500), { mode: "starter" })).code, "NPB_HTTP_ERROR");
  assert.equal((await parseSimulatorResponse(response(""), { mode: "lineup" })).code, "LINEUP_NOT_PUBLISHED");
  assert.equal((await parseSimulatorResponse(response("<article><strong>malformed</strong>"), { mode: "starter" })).code, "NPB_RESPONSE_INVALID");
});

test("fetchNpbWorkerJsonのsimulator pathはpublic fetchだけを使う", async () => {
  const result = await fetchNpbWorkerJson({
    NPB_SOURCE: "simulator",
    ENABLE_DEVELOPMENT_MODE: "true",
    S9SIMU_BASE_URL: SIMULATOR,
    NPB_FETCH_WORKER: { fetch: async () => { throw new Error("official path must not run"); } }
  }, { mode: "starter" }, { fetchImpl: async () => response(starterHtml) });
  assert.equal(result.games[0].gameCode, "m-f-25");
  assert.equal(result.ok, true);
  assert.equal(result.__fetchMeta.source, "simulator");
});

test("production simulator指定はS9simuへfetchせずofficial bindingへ戻る", async () => {
  let bindingCalls = 0;
  const result = await fetchNpbWorkerJson({
    NPB_SOURCE: "simulator",
    ENABLE_DEVELOPMENT_MODE: "false",
    S9SIMU_BASE_URL: SIMULATOR,
    NPB_FETCH_WORKER: { fetch: async () => { bindingCalls += 1; return response(JSON.stringify({ ok: true, games: [] }), 200, "application/json"); } }
  }, { mode: "starter" });
  assert.equal(bindingCalls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.games.length, 0);
  assert.equal(result.__fetchMeta.source, undefined);
});

test("production configにsimulator source/base URLを追加していない", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const config = fs.readFileSync(path.join(root, "wrangler.auth.production.jsonc"), "utf8");
  const workerSource = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");
  assert.doesNotMatch(config, /NPB_SOURCE|S9SIMU_BASE_URL|s9simu\.tanzana7\.workers\.dev/);
  assert.doesNotMatch(workerSource, /s9simu\.tanzana7\.workers\.dev|S9SIMU_ADMIN_TOKEN/);
  assert.match(config, /"ENABLE_DEVELOPMENT_MODE":\s*"false"/);
  assert.match(config, /"ENABLE_AUTO_PROBABLE_STARTER":\s*"true"/);
  assert.match(config, /"ENABLE_AUTO_ROSTER_FETCH":\s*"false"/);
  assert.match(config, /"ENABLE_AUTO_LINEUP_FETCH":\s*"false"/);
  assert.match(config, /"ENABLE_SEMI_AUTO_LINEUP":\s*"true"/);
});

test("fetchSimulatorSourceはmock fetchで外部networkなしにURLを検証できる", async () => {
  let requested = "";
  const result = await fetchSimulatorSource({ S9SIMU_BASE_URL: SIMULATOR }, { mode: "lineup", date: "2026-09-28", gameCode: "m-f-25" }, {
    fetchImpl: async (url) => { requested = url; return response(lineupHtml); }
  });
  assert.equal(new URL(requested).pathname, "/simu-npb/scores/2026/0928/m-f-25/");
  assert.equal(result.response.status, 200);
});
