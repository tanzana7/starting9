const assert = require("node:assert/strict");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

const game = (id, date = "2026-09-08", startTime = "18:00", extra = {}) => ({
  internalGameId: id, date, startTime, homeTeam: "fighters", awayTeam: "eagles",
  displayLabel: "日本ハム vs 楽天", ...extra
});
const response = (payload) => ({ ok: true, status: 200, json: async () => payload });

for (const [label, now, games, expected] of [
  ["today before deadline", "2026-09-08T00:00:00Z", [game("next", "2026-09-09"), game("today")], "today"],
  ["today after deadline", "2026-09-08T12:00:00Z", [game("today"), game("next", "2026-09-09")], "today"],
  ["next day", "2026-09-08T00:00:00Z", [game("next", "2026-09-09")], "next"],
  ["chronological and non-test", "2026-09-08T00:00:00Z", [game("late", "2026-09-09"), game("early", "2026-09-09", "13:00"), game("test", "2026-09-09", "12:00", { isTestGame: true })], "early"]
]) {
  test(`catalog API selects ${label} and renders canonical game/deadline state`, async (t) => {
    const calls = [];
    const app = createPublicRuntime({ ui: true, now, fetchImpl: async (url) => {
      calls.push(url);
      assert.equal(url, "https://starting9.test/api/public/games");
      return response({ ok: true, games });
    } });
    t.after(app.dispose);
    await app.operations.initializePublicGameCatalog();
    assert.equal(app.state.predictionTargetGameId, expected);
    assert.equal(app.appState.currentGame.internalGameId, expected);
    const closed = label === "today after deadline";
    assert.equal(app.state.predictionDeadline.isClosed, closed);
    assert.equal(app.elements.get("predictionEditor").classList.contains("hidden"), closed);
    assert.match(app.elements.get("publicGameSelectionMeta")[closed ? "textContent" : "innerHTML"], closed ? /予想受付は終了しました/ : /日本ハム vs 楽天/);
    assert.equal(calls.length, 1);
  });
}

test("catalog rejects noncanonical rows and ignores legacy local game metadata", async (t) => {
  const app = createPublicRuntime({ ui: true, now: "2026-09-08T00:00:00Z",
    staticGames: [{ ...game("legacy"), matchupLabel: "古いカード" }],
    fetchImpl: async () => response({ ok: true, games: [game("canonical"), { date: "2026-09-08", displayLabel: "古いカード" }] }) });
  t.after(app.dispose);
  app.stored.set("hamStarting9GameInfo", JSON.stringify({ matchup: "古いカード", gameId: "legacy" }));
  await app.operations.initializePublicGameCatalog();
  assert.equal(app.state.publicGameCatalog.games.length, 1);
  assert.equal(app.state.predictionTargetGameId, "canonical");
  assert.match(app.elements.get("publicGameSelectionMeta").innerHTML, /日本ハム vs 楽天/);
  assert.doesNotMatch(app.elements.get("publicGameSelectionMeta").innerHTML, /古いカード/);
});

test("empty catalog hides editor; failed refresh retains canonical state and reports error", async (t) => {
  let payload = { ok: true, games: [] };
  const app = createPublicRuntime({ ui: true, now: "2026-09-08T00:00:00Z", fetchImpl: async () => {
    if (!payload) throw new Error("offline");
    return response(payload);
  } });
  t.after(app.dispose);
  await app.operations.initializePublicGameCatalog();
  assert.equal(app.state.predictionTargetGame, null);
  assert.equal(app.elements.get("predictionEditor").classList.contains("hidden"), true);
  assert.match(app.elements.get("publicGameSelectionMeta").textContent, /予想受付中の試合はありません/);
  payload = { ok: true, games: [game("canonical")] };
  await app.operations.initializePublicGameCatalog({ force: true });
  payload = null;
  await app.operations.initializePublicGameCatalog({ force: true });
  assert.equal(app.state.predictionTargetGameId, "canonical");
  assert.match(app.state.publicGameCatalog.message, /試合情報を取得できませんでした/);
});

function probableApp(t, now, games, probable = { status: "unannounced" }) {
  const calls = [];
  const app = createPublicRuntime({ ui: true, now, fetchImpl: async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/api/probable-starter");
    const id = parsed.searchParams.get("internalGameId");
    const selected = games.find((item) => item.internalGameId === id);
    assert.ok(selected, "requested game belongs to canonical catalog");
    return response({ ok: true, internalGameId: id, gameDate: selected.date,
      homeTeam: selected.homeTeam, awayTeam: selected.awayTeam,
      probableStarter: probable });
  } });
  t.after(app.dispose);
  app.state.publicGameCatalog.games = games.map((item) => ({ ...item, canonical: true }));
  return { app, calls };
}

test("open page switches probable target at start, not prediction/result target, and later picks up announcement", async (t) => {
  const games = [game("today", "2026-09-20", "14:00"), game("tomorrow", "2026-09-21")];
  const probable = { status: "announced", homePitcherName: "投手A", awayPitcherName: "投手B", fetchedAt: "2026-09-20T04:59:00Z" };
  const { app, calls } = probableApp(t, "2026-09-20T04:59:00Z", games, probable);
  app.state.predictionTargetGame = { ...games[0], canonical: true };
  app.state.predictionTargetGameId = "today";
  const result = { gameId: "previous", totalScore: 27 };
  app.state.result = result;
  await app.operations.initializeProbableStarter();
  assert.equal(app.state.probableStarter.nextGame.internalGameId, "today");
  assert.match(app.elements.get("probableStarterDisplay").innerHTML, /投手A/);
  probable.status = "unannounced";
  app.operations.startPredictionDeadlineTicker();
  assert.deepEqual(app.intervalDelays(), [30000]);
  app.setNow("2026-09-20T05:00:00Z");
  await app.tickIntervals();
  assert.equal(app.state.probableStarter.nextGame.internalGameId, "tomorrow");
  assert.match(app.elements.get("probableStarterDisplay").innerHTML, /予告先発 未発表/);
  assert.doesNotMatch(app.elements.get("probableStarterDisplay").innerHTML, /投手A/);
  assert.equal(app.state.predictionTargetGameId, "today");
  assert.equal(app.state.result, result);
  app.setNow("2026-09-20T05:00:30Z");
  await app.tickIntervals();
  assert.equal(calls.length, 2, "unannounced retry is not fetched on every ticker");
  app.setNow("2026-09-20T05:01:00Z");
  probable.status = "announced";
  probable.homePitcherName = "次戦投手";
  await app.tickIntervals();
  assert.match(app.elements.get("probableStarterDisplay").innerHTML, /次戦投手/);
  assert.equal(calls.length, 3);
});

test("probable selector honors actual start time and midnight, then shows no-next-game", async (t) => {
  const games = [game("delayed", "2026-09-20", "14:00", { actualStartAt: "2026-09-20T06:30:00Z" }), game("midnight", "2026-09-21", "00:10")];
  const { app } = probableApp(t, "2026-09-20T05:30:00Z", games);
  await app.operations.initializeProbableStarter();
  assert.equal(app.state.probableStarter.nextGame.internalGameId, "delayed");
  app.setNow("2026-09-20T06:30:00Z");
  await app.operations.initializeProbableStarter();
  assert.equal(app.state.probableStarter.nextGame.internalGameId, "midnight");
  app.setNow("2026-09-20T15:10:00Z");
  await app.operations.initializeProbableStarter();
  assert.equal(app.state.probableStarter.nextGame, null);
  assert.equal(app.state.probableStarter.status, "noGame");
  assert.equal(app.state.probableStarter.matchedGame, null);
  assert.doesNotMatch(app.elements.get("probableStarterDisplay").innerHTML, /投手A|投手B/);
});

test("cancelled games are skipped for probable starter", async (t) => {
  const { app } = probableApp(t, "2026-09-20T06:00:00Z", [game("cancelled", "2026-09-20", "18:00", { status: "cancelled" }), game("future", "2026-09-21")]);
  await app.operations.initializeProbableStarter();
  assert.equal(app.state.probableStarter.nextGame.internalGameId, "future");
});

for (const mode of ["missing", "malformed", "network"]) {
  test(`probable ${mode} response never displays a stale pitcher`, async (t) => {
    const app = createPublicRuntime({ ui: true, now: "2026-09-20T00:00:00Z", fetchImpl: async () => {
      if (mode === "network") throw new Error("offline");
      return response({ ok: true, internalGameId: "future", gameDate: "2026-09-21",
        homeTeam: "fighters", awayTeam: "eagles",
        probableStarter: mode === "missing" ? null : { status: "announced" } });
    } });
    t.after(app.dispose);
    app.state.publicGameCatalog.games = [{ ...game("future", "2026-09-21"), canonical: true }];
    await app.operations.initializeProbableStarter();
    assert.equal(app.state.probableStarter.matchedGame, null);
    assert.match(app.elements.get("probableStarterDisplay").textContent, mode === "network" ? /取得できませんでした/ : /予告先発 未発表/);
    assert.equal(app.state.probableStarter.isLoading, false);
  });
}
