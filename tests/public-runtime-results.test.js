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
      if (id === "b" && failure === "cancelled-prediction") payload = {
        ok: true,
        internalGameId: id,
        gameStatus: "cancelled",
        rankingExcluded: true,
        updatedAt: "2026-09-19T10:00:00Z",
        prediction: { lineup: [{ player: "水谷 瞬", position: "中" }] }
      };
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
  const bestNineRequests = calls.filter((url) => url.includes("daily-best-nine"));
  assert.equal(bestNineRequests.length, 1);
  assert.equal(new URL(bestNineRequests[0]).search, "", "Best Nine uses the server-selected latest publication without a personal result ID");
});

test("Daily Best Nine initialization is idempotent and keeps one canonical state object", async (t) => {
  let finish;
  const calls = [];
  const app = createPublicRuntime({ ui: true, fetchImpl: async (url) => {
    calls.push(url);
    return new Promise((resolve) => { finish = resolve; });
  } });
  t.after(app.dispose);
  for (const id of ["dailyBestNineCard", "dailyBestNineContent"]) app.elements.set(id, app.createElement());
  const state = app.state.dailyBestNine;
  const firstInitialization = app.operations.initializeDailyBestNine();
  const secondInitialization = app.operations.initializeDailyBestNine();
  assert.equal(firstInitialization, secondInitialization);
  assert.equal(calls.filter((url) => url.includes("daily-best-nine")).length, 1);
  assert.equal(app.state.dailyBestNine.status, "loading");
  finish({ ok: true, status: 200, json: async () => ({ ok: true, published: true, internalGameId: "latest", bestNine: [{ rank: 1, username: "latest", score: 99 }] }) });
  await Promise.all([firstInitialization, secondInitialization]);
  assert.equal(app.state.dailyBestNine, state);
  assert.equal(app.state.dailyBestNine.gameId, "latest");
  assert.deepEqual(app.intervalDelays(), []);
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

test("prediction summary rendering owns no click listener and delegated player detail remains single after repeated renders", async (t) => {
  const { app, calls, select } = await resultsApp(t, { failure: "cancelled-prediction" });
  const detailsPanel = app.createElement();
  app.elements.set("predictionPlayerDetails", detailsPanel);
  let detailOpenCount = 0;
  const setAttribute = detailsPanel.setAttribute;
  detailsPanel.setAttribute = function(name, value) {
    if (name === "aria-hidden" && value === "false") detailOpenCount += 1;
    return setAttribute.call(this, name, value);
  };
  await select("b");

  const result = app.elements.get("scoreResult");
  const summary = result.querySelector(".saved-lineup-summary");
  const list = result.querySelector(".lineup-list");
  assert.ok(summary);
  assert.ok(list);
  assert.equal(list.listenerCount("click"), 0);
  const summaryMarkup = contents(summary);
  assert.match(summaryMarkup, /class="player-detail-inline-button"/);
  assert.match(summaryMarkup, /data-player-detail-only="水谷瞬"/);
  assert.equal(app.documentListenerCount("click"), 1);

  for (let i = 0; i < 100; i += 1) app.operations.renderAll();
  const rerenderedList = app.elements.get("scoreResult").querySelector(".lineup-list");
  assert.ok(rerenderedList);
  assert.equal(rerenderedList.listenerCount("click"), 0);
  assert.equal(app.documentListenerCount("click"), 1);
  assert.equal(contents(app.elements.get("scoreResult").querySelector(".saved-lineup-summary")), summaryMarkup);

  const menu = app.createElement();
  menu.className = "position-menu";
  app.body.appendChild(menu);
  const trigger = app.createElement();
  trigger.dataset.playerDetailOnly = "水谷瞬";
  const nestedChild = app.createElement();
  trigger.appendChild(nestedChild);
  list.children[0].appendChild(trigger);
  let closestCalls = 0;
  const closest = nestedChild.closest.bind(nestedChild);
  nestedChild.closest = (selector) => {
    closestCalls += 1;
    assert.equal(selector, "[data-player-detail-only]");
    return closest(selector);
  };
  await nestedChild.dispatchBubblingEvent({ type: "click" });

  assert.equal(closestCalls, 1);
  assert.equal(detailOpenCount, 1);
  assert.equal(detailsPanel.getAttribute("aria-hidden"), "false");
  assert.match(detailsPanel.innerHTML, /水谷 瞬/);
  assert.doesNotMatch(detailsPanel.innerHTML, /player-detail-select/);
  assert.equal(calls.filter((url) => url.includes("player-detail")).length, 0);
  assert.equal(menu.classList.contains("hidden"), true, "the same click keeps the existing outside-click menu close");
  assert.equal(list.listenerCount("click"), 0, "detached summary nodes do not own listeners");
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

test("result event binding is idempotent and a click toggles the history once", async (t) => {
  let calls = 0;
  const app = createPublicRuntime({ ui: true, fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); } });
  t.after(app.dispose);
  const root = app.elements.get("resultHistoryList");
  const registrations = [];
  const add = root.addEventListener;
  root.addEventListener = function(type, listener) { registrations.push(type); return add.call(this, type, listener); };
  app.state.resultHistory.isReady = true;
  app.operations.bindEvents();
  app.operations.bindEvents();
  await root.emit("click", { target: app.createElement({ resultHistoryToggle: "" }) });
  assert.deepEqual(registrations, ["click", "change"]);
  assert.equal(app.state.resultHistory.isExpanded, true);
  assert.equal(calls, 0);
  assert.deepEqual(app.intervalDelays(), []);
});

test("overlapping history refreshes share one in-flight list read", async (t) => {
  let finish;
  let calls = 0;
  const app = createPublicRuntime({ ui: true, fetchImpl: () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  } });
  t.after(app.dispose);
  app.state.previousResultGame = { isReady: true, isLoading: false, game: null };
  const first = app.operations.refreshResultHistory();
  await app.operations.refreshResultHistory();
  assert.equal(calls, 1);
  assert.equal(app.state.resultHistory.isLoading, true);
  finish({ ok: true, status: 200, json: async () => ({ ok: true, games: [] }) });
  await first;
  assert.equal(app.state.resultHistory.isLoading, false);
  assert.equal(calls, 1);
});

test("anonymous history replacement stays live and does not retain the old state object", async (t) => {
  const app = createPublicRuntime({ ui: true, user: null });
  t.after(app.dispose);
  const old = app.state.resultHistory;
  old.isExpanded = true;
  await app.operations.refreshResultHistory();
  assert.notEqual(app.state.resultHistory, old);
  assert.equal(app.state.resultHistory.isExpanded, false);
  assert.equal(app.appState.results.history, app.state.resultHistory);
  assert.match(app.elements.get("resultHistoryList").innerHTML, /aria-expanded="false"/);
});
