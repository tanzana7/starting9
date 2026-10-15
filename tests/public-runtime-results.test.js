const assert = require("node:assert/strict");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

test("history lists canonical result IDs, limits recent games to five, and starts collapsed", async (t) => {
  const calls = [];
  const app = createPublicRuntime({ ui: true, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(url, "https://starting9.test/api/results/games");
    return { ok: true, json: async () => ({ ok: true, games: Array.from({ length: 7 }, (_, i) => ({
      resultId: `canonical-${i}`, internalGameId: `canonical-${i}`, gameId: `legacy-${i}`,
      gameDate: `2026-09-${String(20 - i).padStart(2, "0")}`, homeTeam: "fighters", awayTeam: "eagles"
    })) }) };
  } });
  t.after(app.dispose);
  // The previous-game read has already completed; list loading must not invent
  // a participated result or request a detail when no previous game exists.
  app.state.previousResultGame = { isReady: true, isLoading: false, game: null };
  await app.operations.refreshResultHistory();
  assert.equal(app.state.resultHistory.games.length, 5);
  assert.equal(app.state.resultHistory.isExpanded, false);
  assert.match(app.elements.get("resultHistoryList").innerHTML, /aria-expanded="false"/);
  assert.equal(calls[0].options.credentials, "include");
  app.state.resultHistory.isExpanded = true;
  app.operations.renderAll();
  const markup = app.elements.get("resultHistoryList").innerHTML;
  assert.match(markup, /value="canonical-0"/);
  assert.doesNotMatch(markup, /value="legacy-|canonical-5/);
  assert.equal(app.state.resultHistory.result, null);
  assert.equal(calls.length, 1, "list rendering does not eagerly fetch result details");
});

test("anonymous history stays empty with login guidance and no authenticated request", async (t) => {
  let calls = 0;
  const app = createPublicRuntime({ ui: true, user: null, fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); } });
  t.after(app.dispose);
  await app.operations.refreshResultHistory();
  assert.equal(calls, 0);
  assert.equal(app.state.resultHistory.games.length, 0);
  assert.match(app.elements.get("resultHistoryList").innerHTML, /ログインすると過去の試合結果/);
});
