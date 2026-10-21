import assert from "node:assert/strict";
import test from "node:test";
import npbWorker from "../cloudflare-worker.js";
import { fetchLatestPublicRoster } from "../auth-worker.js";
import { normalizeAllNpbScheduleGames, normalizeTargetTeamScheduleGames } from "../game-schedule-detection.js";
import teamContext from "../frontend/shared/team-context.js";
import { TEST_TEAMS } from "../tooling/test-site/teams.js";

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;

function officialRosterHtml(teamName, prefix) {
  const rows = Array.from({ length: 18 }, (_, index) => {
    const number = String(index + 1);
    const playerId = `${prefix}${String(index + 1).padStart(4, "0")}`;
    const position = index === 0 ? "投手" : index === 1 ? "捕手" : index < 9 ? "内野手" : "外野手";
    return `<tr><td>${position}</td><td>${number}</td><td><a href="/bis/players/${playerId}.html">テスト選手${number}</a></td></tr>`;
  }).join("");
  return `<h5>${teamName}</h5><table>${rows}</table>`;
}

test("Marines schedule discovery accepts official name/code at home and away and preserves NPB identity", () => {
  const games = [
    { homeTeam: "marines", awayTeam: "fighters", startTime: "18:00", gameCode: "m-f-23" },
    { homeTeam: "fighters", awayTeam: "M", startTime: "18:00", gameCode: "f-m-24" },
    { homeTeam: "marines", awayTeam: "hawks", startTime: "18:00", gameCode: "m-h-12" },
    { homeTeam: "hawks", awayTeam: "lions", startTime: "18:00", gameCode: "h-l-12" }
  ];
  const bothSides = normalizeTargetTeamScheduleGames(games, "2026-10-01", teamContext.MARINES);
  assert.deepEqual(bothSides.map((game) => [game.homeTeam, game.awayTeam, game.gameId]), [
    ["marines", "fighters", "2026-10-01-m-f-23"],
    ["fighters", "marines", "2026-10-01-f-m-24"],
    ["marines", "hawks", "2026-10-01-m-h-12"]
  ]);
  assert.equal(normalizeTargetTeamScheduleGames([
    { homeTeam: "fighters", awayTeam: "千葉ロッテマリーンズ", startTime: "18:00", gameCode: "f-m-24" }
  ], "2026-10-02", teamContext.MARINES)[0].awayTeam, "marines");
});

test("league schedule normalization deduplicates each physical game across both participant teams", () => {
  const games = [
    { homeTeam: "giants", awayTeam: "tigers", startTime: "18:00", gameCode: "g-t-01" },
    { homeTeam: "fighters", awayTeam: "marines", startTime: "18:00", gameCode: "f-m-01" }
  ];
  const normalized = normalizeAllNpbScheduleGames(games, "2027-04-01");
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized.map((game) => game.gameId), ["2027-04-01-f-m-01", "2027-04-01-g-t-01"]);
  assert.deepEqual(normalized.map((game) => [game.homeTeam, game.awayTeam]), [["fighters", "marines"], ["giants", "tigers"]]);
});

test("NPB schedule endpoint remains Fighters-default and supports all registered NPB teams", async () => {
  globalThis.fetch = async () => new Response(`
    <html><title>試合日程</title><table>
      <tr><th>10/1</th></tr>
      <tr><td>千葉ロッテマリーンズ</td><td>北海道日本ハムファイターズ</td><td>18:00</td>
      <a href="/scores/2026/1001/m-f-23/">試合</a></td></tr>
      <tr><td>千葉ロッテマリーンズ</td><td>福岡ソフトバンクホークス</td><td>18:00</td>
      <a href="/scores/2026/1001/m-h-12/">試合</a></td></tr>
      <tr><td>福岡ソフトバンクホークス</td><td>埼玉西武ライオンズ</td><td>18:00</td></tr>
    </table></html>`);
  try {
    const defaultResponse = await npbWorker.fetch(new Request("https://npb.internal/?mode=schedule&date=2026-10-01"), {});
    const defaultBody = await defaultResponse.json();
    assert.deepEqual(defaultBody.games.map((game) => game.gameCode), ["m-f-23"]);
    const pilotResponse = await npbWorker.fetch(new Request("https://npb.internal/?mode=schedule&date=2026-10-01&team=marines"), {});
    const pilotBody = await pilotResponse.json();
    assert.equal(pilotResponse.status, 200);
    assert.deepEqual(pilotBody.games.map((game) => [game.homeTeam, game.awayTeam, game.gameCode]), [
      ["marines", "fighters", "m-f-23"], ["marines", "hawks", "m-h-12"]
    ]);
    const hawksResponse = await npbWorker.fetch(new Request("https://npb.internal/?mode=schedule&date=2026-10-01&team=hawks"), {});
    assert.equal(hawksResponse.status, 200);
    assert.ok((await hawksResponse.json()).games.some((game) => game.gameCode === "m-h-12"));
    const giantsAlias = await npbWorker.fetch(new Request("https://npb.internal/?mode=schedule&date=2026-10-01&team=G"), {});
    assert.equal(giantsAlias.status, 200);
    assert.deepEqual((await giantsAlias.json()).games, []);
    const allTeamsResponse = await npbWorker.fetch(new Request("https://npb.internal/?mode=schedule&date=2026-10-01&team=all"), {});
    assert.equal(allTeamsResponse.status, 200);
    const allTeamsBody = await allTeamsResponse.json();
    assert.equal(allTeamsBody.games.length, 3);
    assert.equal(new Set(allTeamsBody.games.map((game) => game.gameId)).size, 3);
    const unknown = await npbWorker.fetch(new Request("https://npb.internal/?mode=schedule&date=2026-10-01&team=not-a-team"), {});
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).code, "SCHEDULE_TEAM_UNSUPPORTED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("NPB roster provider resolves each registered team and fails closed instead of returning Fighters", async () => {
  let html = `${officialRosterHtml("北海道日本ハムファイターズ", "1111")}${officialRosterHtml("千葉ロッテマリーンズ", "2222")}`;
  globalThis.caches = { default: { async match() { return undefined; }, async put() {} } };
  globalThis.fetch = async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  try {
    const response = await npbWorker.fetch(new Request("https://npb.internal/?mode=roster&team=marines&force=1"), {});
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.team, "marines");
    assert.equal(body.players.length, 18);
    assert.ok(body.players.every((player) => player.playerId.startsWith("npb:2222")));
    assert.equal(body.players.some((player) => player.playerId.startsWith("npb:1111")), false);
    html += officialRosterHtml("福岡ソフトバンクホークス", "3333");
    const hawksResponse = await npbWorker.fetch(new Request("https://npb.internal/?mode=roster&team=hawks&force=1"), {});
    const hawksBody = await hawksResponse.json();
    assert.equal(hawksResponse.status, 200);
    assert.equal(hawksBody.team, "hawks");
    assert.ok(hawksBody.players.every((player) => player.playerId.startsWith("npb:3333")));
    html = officialRosterHtml("北海道日本ハムファイターズ", "1111");
    const missing = await npbWorker.fetch(new Request("https://npb.internal/?mode=roster&team=marines&force=1"), {});
    assert.equal(missing.status, 422);
    assert.equal((await missing.json()).code, "ROSTER_PARSE_FAILED");
    const unsupported = await npbWorker.fetch(new Request("https://npb.internal/?mode=roster&team=not-a-team"), {});
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).code, "ROSTER_TEAM_UNSUPPORTED");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("official probable-starter parser resolves Marines without a Fighters-only assumption", async () => {
  globalThis.fetch = async () => new Response(`<h4>2026年10月20日</h4><section>
    <div class="unit cl_1">
      <div class="team_left"><img alt="千葉ロッテマリーンズ"><span>投手テストA</span></div>
      <div class="team_right"><img alt="北海道日本ハムファイターズ"><span>投手テストB</span></div>
      <div class="info">18:00（ZOZOマリンスタジアム）</div>
    </div>
  </section>`, { status: 200 });
  try {
    const fixture = await npbWorker.fetch(new Request("https://npb.internal/?mode=starter"), {});
    const parsed = await fixture.json();
    assert.equal(parsed.games.length, 1);
    assert.equal(parsed.games[0].homeTeam, "marines");
    assert.equal(parsed.games[0].awayTeam, "fighters");
    assert.equal(parsed.games[0].homeStarter.name, "投手テストA");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Auth public roster requests Marines explicitly, applies M identity, and rejects wrong-team provider responses", async () => {
  const requestedTeams = [];
  const players = Array.from({ length: 20 }, (_, index) => ({
    playerId: `npb:2222${String(index + 1).padStart(4, "0")}`,
    name: `テスト選手${index + 1}`, number: String(index + 1), position: index === 0 ? "投手" : "内野手"
  }));
  const env = {
    ENVIRONMENT: "test", TEST_SITE_ID: "starting9-isolated-v1", TEST_WORKER_NAME: "starting9-test-auth",
    TARGET_TEAM_CONTEXT: TEST_TEAMS.marines,
    NPB_FETCH_WORKER: { async fetch(request) {
      const url = new URL(request.url);
      requestedTeams.push(url.searchParams.get("team"));
      return Response.json({ ok: true, team: "marines", players, fetchedAt: "2026-10-18T00:00:00.000Z" });
    } }
  };
  const roster = await fetchLatestPublicRoster(env, { internal_game_id: "pilot-game", game_date: "2026-10-20" });
  assert.deepEqual(requestedTeams, ["marines"]);
  assert.equal(roster.playerCount, 20);
  assert.ok(roster.players.every((player) => player.teamCode === "marines" && player.teamId === "M"));
  env.NPB_FETCH_WORKER.fetch = async () => Response.json({ ok: true, team: "fighters", players });
  assert.equal(await fetchLatestPublicRoster(env, { internal_game_id: "pilot-game" }), null);
});
