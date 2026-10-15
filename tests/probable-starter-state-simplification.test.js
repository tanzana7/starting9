const assert = require("node:assert/strict");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

const game = (id, extra = {}) => ({
  internalGameId: id,
  canonical: true,
  date: "2026-10-15",
  startTime: "18:00",
  homeTeam: "fighters",
  awayTeam: "eagles",
  displayLabel: "日本ハム vs 楽天",
  ...extra
});

const response = (payload) => ({ ok: true, status: 200, json: async () => payload });

function runtimeFor(gameCatalog, probableStarter = { status: "unannounced" }, t) {
  const calls = [];
  const app = createPublicRuntime({
    ui: true,
    now: "2026-10-15T00:00:00Z",
    fetchImpl: async (url) => {
      calls.push(url);
      const selected = gameCatalog.find((item) => item.internalGameId === new URL(url).searchParams.get("internalGameId"));
      assert.ok(selected, "probable starter request must target a catalog game");
      return response({
        ok: true,
        internalGameId: selected.internalGameId,
        gameDate: selected.date,
        homeTeam: selected.homeTeam,
        awayTeam: selected.awayTeam,
        probableStarter
      });
    }
  });
  t.after(app.dispose);
  app.state.publicGameCatalog.games = gameCatalog;
  return { app, calls };
}

test("試合がない場合は予告先発領域を非表示にし、未発表へfall throughしない", async (t) => {
  const { app, calls } = runtimeFor([], { status: "announced", homePitcherName: "古い投手" }, t);
  await app.operations.initializeProbableStarter();

  const display = app.elements.get("probableStarterDisplay");
  assert.equal(app.state.probableStarter.status, "noGame");
  assert.equal(display.classList.contains("hidden"), true);
  assert.equal(display.innerHTML, "");
  assert.doesNotMatch(display.textContent, /未発表|古い投手/);
  assert.equal(calls.length, 0);
});

test("試合があり予告先発が未発表の場合は従来どおり表示する", async (t) => {
  const { app } = runtimeFor([game("unannounced")], { status: "unannounced" }, t);
  await app.operations.initializeProbableStarter();

  const display = app.elements.get("probableStarterDisplay");
  assert.equal(app.state.probableStarter.status, "unannounced");
  assert.equal(display.classList.contains("hidden"), false);
  assert.match(display.textContent, /未発表/);
});

test("試合と予告先発がある場合は発表済み選手を表示する", async (t) => {
  const { app } = runtimeFor([game("announced")], {
    status: "announced",
    homePitcherName: "発表投手A",
    awayPitcherName: "発表投手B",
    fetchedAt: "2026-10-15T01:00:00Z"
  }, t);
  await app.operations.initializeProbableStarter();

  const display = app.elements.get("probableStarterDisplay");
  assert.equal(app.state.probableStarter.status, "success");
  assert.equal(display.classList.contains("hidden"), false);
  assert.match(display.textContent, /発表投手A/);
  assert.doesNotMatch(display.textContent, /未発表/);
});

test("表示対象が試合なしへ切り替わった場合は旧試合の予告先発を消去する", async (t) => {
  const oldGame = game("old");
  const catalog = [oldGame];
  const { app } = runtimeFor(catalog, {
    status: "announced",
    homePitcherName: "旧投手",
    awayPitcherName: "旧相手投手",
    fetchedAt: "2026-10-15T01:00:00Z"
  }, t);
  await app.operations.initializeProbableStarter();
  assert.match(app.elements.get("probableStarterDisplay").textContent, /旧投手/);

  catalog.length = 0;
  app.setNow("2026-10-16T00:00:00Z");
  await app.operations.initializeProbableStarter();

  const display = app.elements.get("probableStarterDisplay");
  assert.equal(app.state.probableStarter.status, "noGame");
  assert.equal(app.state.probableStarter.matchedGame, null);
  assert.equal(display.classList.contains("hidden"), true);
  assert.doesNotMatch(display.textContent, /旧投手|未発表/);

  catalog.push(game("next", { date: "2026-10-17" }));
  await app.operations.initializeProbableStarter();
  assert.equal(display.classList.contains("hidden"), false);
});
