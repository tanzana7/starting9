const assert = require("node:assert/strict");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

const game = (id, extra = {}) => ({
  internalGameId: id, canonical: true, date: "2026-10-17", startTime: "18:00",
  homeTeam: "fighters", awayTeam: "eagles", ...extra
});
const response = (selected, probableStarter, extra = {}) => ({
  ok: true, status: 200, json: async () => ({
    ok: true, internalGameId: selected.internalGameId, gameDate: selected.date,
    homeTeam: selected.homeTeam, awayTeam: selected.awayTeam,
    probableStarter: { fetchedAt: "2026-10-16T00:00:00Z", ...probableStarter }, ...extra
  })
});

test("overlapping initialization shares the in-flight read and adds no timer or storage", async (t) => {
  const selected = game("next");
  let complete;
  const calls = [];
  const app = createPublicRuntime({ ui: true, now: "2026-10-16T00:00:00Z", fetchImpl: (url, options) => {
    calls.push({ url, options });
    return new Promise((resolve) => { complete = resolve; });
  } });
  t.after(app.dispose);
  app.state.publicGameCatalog.games = [selected];
  const first = app.operations.initializeProbableStarter();
  await app.operations.initializeProbableStarter();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://starting9.test/api/probable-starter?internalGameId=next");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(app.state.probableStarter.isLoading, true);
  assert.match(app.elements.get("probableStarterDisplay").textContent, /取得中/);
  complete(response(selected, { status: "announced", homePitcherName: "投手A", awayPitcherName: "投手B" }));
  await first;
  assert.equal(app.state.probableStarter.status, "success");
  assert.match(app.elements.get("probableStarterDisplay").textContent, /投手A/);
  assert.deepEqual(app.intervalDelays(), []);
  assert.equal(app.stored.size, 0);
});

test("a late response for the old target cannot overwrite the next target", async (t) => {
  const old = game("old");
  const next = game("next", { date: "2026-10-18" });
  let completeOld;
  let oldSignal;
  const calls = [];
  const app = createPublicRuntime({ ui: true, now: "2026-10-16T00:00:00Z", fetchImpl: (url, options) => {
    calls.push(url);
    if (new URL(url).searchParams.get("internalGameId") === "old") {
      oldSignal = options.signal;
      return new Promise((resolve) => { completeOld = resolve; });
    }
    return Promise.resolve(response(next, { status: "announced", homePitcherName: "次戦投手" }));
  } });
  t.after(app.dispose);
  app.state.publicGameCatalog.games = [old, next];
  const pending = app.operations.initializeProbableStarter();
  app.setNow("2026-10-17T09:00:00Z");
  await app.operations.initializeProbableStarter();
  assert.equal(oldSignal.aborted, true);
  completeOld(response(old, { status: "announced", homePitcherName: "旧投手" }));
  await pending;
  assert.equal(calls.length, 1);
  assert.equal(app.state.probableStarter.nextGame.internalGameId, "next");
  assert.equal(app.state.probableStarter.matchedGame, null);
  assert.doesNotMatch(app.elements.get("probableStarterDisplay").textContent, /旧投手/);
});

for (const [label, probable, extra, expected] of [
  ["partial", { status: "announced", awayPitcherName: "相手投手", partial: true }, {}, /未発表[\s\S]*相手投手/],
  ["disabled", { status: "external_fetch_disabled" }, {}, /取得を一時停止/],
  ["mismatched", { status: "announced", homePitcherName: "別試合投手" }, { homeTeam: "marines" }, /試合参照を確認できません/]
]) {
  test(`${label} response preserves its display contract`, async (t) => {
    const selected = game("next");
    const app = createPublicRuntime({ ui: true, now: "2026-10-16T00:00:00Z",
      fetchImpl: async () => response(selected, probable, extra) });
    t.after(app.dispose);
    app.state.publicGameCatalog.games = [selected];
    await app.operations.initializeProbableStarter();
    assert.match(app.elements.get("probableStarterDisplay").textContent, expected);
    assert.doesNotMatch(app.elements.get("probableStarterDisplay").textContent, /別試合投手/);
  });
}

test("synthetic target team on the away side owns starter resolution and display", async (t) => {
  const foxes = {
    key: "test-foxes", slug: "test-foxes", displayName: "TEST Foxes", shortName: "TEST Foxes",
    playerTeamId: "TX", providerTeamCode: "tx", aliases: ["TEST Foxes"], shareHashtags: "#starting9test",
    branding: { primary: "#774411", secondary: "#442211", accent: "#eebbaa", surface: "#fff5ee" }
  };
  const selected = game("foxes-away", { homeTeam: "marines", awayTeam: foxes.key });
  const app = createPublicRuntime({ targetTeam: foxes, ui: true, now: "2026-10-16T00:00:00Z",
    fetchImpl: async () => response(selected, { status: "announced", homePitcherName: "相手投手", awayPitcherName: "Foxes投手" }) });
  t.after(app.dispose);
  app.state.publicGameCatalog.games = [selected];
  await app.operations.initializeProbableStarter();
  assert.equal(app.state.probableStarter.status, "success");
  assert.equal(app.state.probableStarter.matchedGame.awayStarter.name, "Foxes投手");
  assert.match(app.elements.get("probableStarterDisplay").textContent, /TEST Foxes[\s\S]*Foxes投手/);
  assert.doesNotMatch(app.elements.get("probableStarterDisplay").textContent, /日本ハム/);
});
