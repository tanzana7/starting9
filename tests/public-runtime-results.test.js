const assert = require("node:assert/strict");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

const positions = ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"];
const resultGames = ["a", "b"].map((id, index) => ({ resultId: id, internalGameId: id, gameId: `legacy-${id}`, gameDate: `2026-09-${20 - index}`, resultsPublished: true, homeTeam: "fighters", awayTeam: "eagles" }));
function detail(id) {
  const lineup = positions.map((position, index) => ({ battingOrder: index + 1, playerName: `選手${id}${index}`, position }));
  return { ok: true, gameId: `legacy-${id}`, internalGameId: id, resultsPublished: true, prediction: { lineup }, actualLineup: lineup, totalScore: 99, publishedAt: "2026-09-20T10:00:00Z" };
}
const contents = (node) => node.innerHTML + node.children.map(contents).join("");
async function resultsApp(t, { failure = "", pending, detailPayloads = {} } = {}) {
  const calls = [];
  const app = createPublicRuntime({ ui: true, fetchImpl: async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    let payload;
    if (parsed.pathname === "/api/public/previous-result-game") payload = { ok: true, game: resultGames[0] };
    else if (parsed.pathname === "/api/results/games") {
      if (failure === "list") throw new Error("offline");
      payload = { ok: true, games: failure === "empty" ? [] : resultGames };
    } else if (parsed.pathname === "/api/results/daily-best-nine") {
      if (failure === "best") throw new Error("offline");
      payload = { ok: true, published: true, internalGameId: "latest", bestNine: [{ rank: 1, username: "latest-winner", score: 99 }] };
    } else {
      assert.match(parsed.pathname, /^\/api\/results\/games\/[ab]$/);
      const id = parsed.pathname.split("/").at(-1);
      if (failure === id) throw new Error("offline");
      if (pending?.[id]) return pending[id];
      payload = detailPayloads[id] || detail(id);
      if (id === "b" && failure === "unpublished") payload.resultsPublished = false;
      if (id === "b" && failure === "cancelled") payload = { ok: true, internalGameId: id, gameStatus: "cancelled", rankingExcluded: true };
    }
    return { ok: true, status: 200, json: async () => payload };
  } });
  t.after(app.dispose);
  for (const id of ["scoreResult", "result-title", "result-legend", "dailyBestNineCard", "dailyBestNineContent"]) app.elements.set(id, app.createElement());
  app.operations.bindEvents();
  await app.operations.fetchPreviousResultGame();
  await app.operations.refreshResultHistory();
  await new Promise(setImmediate);
  await app.operations.initializeDailyBestNine();
  const select = async (id) => {
    const target = app.createElement({ resultHistorySelect: "" });
    target.value = id;
    await app.elements.get("resultHistoryList").emit("change", { target });
  };
  const toggle = () => app.elements.get("resultHistoryList").emit("click", { target: app.createElement({ resultHistoryToggle: "" }) });
  return { app, calls, select, toggle };
}

test("previous result, detail selection, collapse/reopen and cache preserve the displayed game independently of latest Best Nine", async (t) => {
  const { app, calls, select, toggle } = await resultsApp(t);
  assert.equal(app.state.resultHistory.selectedGameId, "a");
  assert.equal(app.elements.get("result-title").textContent, "前回（9/20）の採点結果");
  assert.match(contents(app.elements.get("scoreResult")), /選手a0/);
  assert.match(contents(app.elements.get("scoreResult")), /score-total"><strong>99<\/strong>/);
  const best = JSON.stringify(app.state.dailyBestNine);
  await toggle();
  assert.match(app.elements.get("resultHistoryList").innerHTML, /aria-expanded="true"/);
  await select("b");
  assert.equal(app.elements.get("result-title").textContent, "9/19の採点結果");
  assert.match(contents(app.elements.get("scoreResult")), /選手b0/);
  assert.doesNotMatch(contents(app.elements.get("scoreResult")), /選手a0/);
  await toggle();
  assert.equal(app.state.resultHistory.isExpanded, false);
  assert.match(contents(app.elements.get("scoreResult")), /選手b0/);
  await toggle();
  await select("a");
  assert.equal(calls.filter((url) => url.endsWith("/games/a")).length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/games/b")).length, 1);
  assert.equal(app.state.resultHistory.result.internalGameId, "a");
  assert.equal(JSON.stringify(app.state.dailyBestNine), best);
  assert.match(app.elements.get("dailyBestNineContent").innerHTML, /latest-winner/);
  assert.equal(calls.filter((url) => url.includes("daily-best-nine")).length, 1);
});

test("result detail renders the actual lineup rows, score states and positions through the public runtime", async (t) => {
  const actualLineup = positions.map((position, index) => ({ battingOrder: index + 1, playerName: `実際${index + 1}`, position }));
  const predictionLineup = positions.map((position, index) => ({ battingOrder: index + 1, playerName: index === 0 ? "別選手" : `実際${index + 1}`, position: index === 1 ? "中" : position }));
  const payload = {
    ok: true,
    gameId: "legacy-a",
    internalGameId: "a",
    resultsPublished: true,
    prediction: { lineup: predictionLineup },
    actualLineup,
    publishedAt: "2026-09-20T10:00:00Z"
  };
  const { app, select } = await resultsApp(t, { detailPayloads: { a: payload } });
  await select("a");

  const markup = contents(app.elements.get("scoreResult"));
  assert.equal((markup.match(/result-order-cell/g) || []).length, positions.length);
  assert.match(markup, /別選手/);
  assert.match(markup, /実際1/);
  assert.match(markup, /守備位置 捕/);
  assert.match(markup, /判定/);
  assert.match(markup, /点数/);
  assert.match(markup, /aria-label="出場：不一致"/);
  assert.match(markup, /aria-label="打順：不一致"/);
  assert.match(markup, /aria-label="守備：不一致"/);
  assert.doesNotMatch(markup, /undefined/);
});

test("history list failure leaves its error visible without crashing the results shell", async (t) => {
  const { app } = await resultsApp(t, { failure: "list" });
  assert.match(app.elements.get("resultHistoryList").innerHTML, /過去の試合結果を取得できませんでした/);
  assert.equal(app.state.resultHistory.games.length, 0);
});

test("Best Nine failure does not discard a successfully loaded personal result", async (t) => {
  const { app } = await resultsApp(t, { failure: "best" });
  assert.equal(app.state.resultHistory.result.internalGameId, "a");
  assert.match(contents(app.elements.get("scoreResult")), /選手a0/);
  assert.equal(app.elements.get("dailyBestNineCard").classList.contains("hidden"), true);
});

test("detail failure does not reset the independent latest Best Nine widget", async (t) => {
  const { app, select } = await resultsApp(t, { failure: "b" });
  const latest = JSON.stringify(app.state.dailyBestNine);
  await select("b");
  assert.equal(app.state.resultHistory.result, null);
  assert.match(contents(app.elements.get("scoreResult")), /結果を読み込めませんでした/);
  assert.equal(JSON.stringify(app.state.dailyBestNine), latest);
  assert.match(app.elements.get("dailyBestNineContent").innerHTML, /latest-winner/);
});

test("cached A selection supersedes a slower B detail response", async (t) => {
  let finish;
  const { app, select } = await resultsApp(t, { pending: { b: new Promise((resolve) => { finish = resolve; }) } });
  const loadingB = select("b");
  await new Promise(setImmediate);
  await select("a");
  finish({ ok: true, status: 200, json: async () => detail("b") });
  await loadingB;
  assert.equal(app.state.resultHistory.selectedGameId, "a");
  assert.equal(app.state.resultHistory.result.internalGameId, "a");
  assert.match(contents(app.elements.get("scoreResult")), /選手a0/);
  assert.doesNotMatch(contents(app.elements.get("scoreResult")), /選手b0/);
  assert.equal(app.state.dailyBestNine.gameId, "latest");
});

test("empty personal history keeps its empty message and latest public Best Nine", async (t) => {
  const { app } = await resultsApp(t, { failure: "empty" });
  assert.equal(app.state.resultHistory.games.length, 0);
  assert.match(app.elements.get("resultHistoryList").innerHTML, /採点済みの過去試合はありません/);
  assert.match(contents(app.elements.get("scoreResult")), /前回は参加していません/);
  assert.equal(app.state.dailyBestNine.gameId, "latest");
});

for (const status of ["unpublished", "cancelled"]) {
  test(`${status} personal result never resets latest published Best Nine`, async (t) => {
    const { app, select } = await resultsApp(t, { failure: status });
    const latest = JSON.stringify(app.state.dailyBestNine);
    await select("b");
    if (status === "unpublished") assert.match(app.state.resultHistory.message, /まだ公開されていません/);
    else {
      assert.match(contents(app.elements.get("scoreResult")), /中止/);
      await select("a");
      await select("b");
      assert.equal(app.state.resultHistory.result.internalGameId, "b");
    }
    assert.equal(JSON.stringify(app.state.dailyBestNine), latest);
  });
}

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
