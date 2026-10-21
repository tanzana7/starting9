const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("通常画面にアカウント保存専用パネルと専用ボタンを置かない", () => {
  assert.doesNotMatch(html, /predictionAccountPanel|(?:savePredictionTo|loadPredictionFrom)AccountButton/);
  assert.match(html, /id="savePredictionButton"/);
  assert.doesNotMatch(css, /\.prediction-account-panel|\.prediction-account-actions/);
  assert.doesNotMatch(script, /アカウントにも保存済みです。最終更新/);
});

const completeLineup = ["田宮裕涼", "清宮幸太郎", "上川畑大悟", "郡司裕也", "水野達稀", "水谷瞬", "五十幡亮汰", "万波中正", "レイエス"]
  .map((player, index) => ({ player, position: ["捕", "一", "二", "三", "遊", "左", "中", "右", "指"][index] }));

async function predictionApp(t, { lineup = completeLineup, user, save } = {}) {
  const calls = [];
  const app = createPublicRuntime({ ui: true, lineup, user, fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (new URL(url).pathname === "/api/game-day-roster") return { ok: true, json: async () => ({
      ok: true, internalGameId: "canonical-game", gameDate: "2099-07-21", status: "fresh",
      rosterUse: "official_live", canUseForPrediction: true, players: completeLineup.map(({ player }) => ({ name: player }))
    }) };
    const parsedUrl = new URL(url);
    assert.equal(parsedUrl.origin, "https://starting9.test");
    assert.equal(parsedUrl.pathname, "/api/predictions/current");
    assert.equal(parsedUrl.searchParams.get("internalGameId"), "canonical-game");
    assert.equal(parsedUrl.searchParams.get("contestId"), "contest_63616e6f6e6963616c2d67616d65_6669676874657273");
    assert.equal(options.method, "PUT");
    return save ? save() : { ok: true, json: async () => ({ ok: true }) };
  } });
  t.after(app.dispose);
  app.operations.bindEvents();
  app.operations.refreshPredictionDeadlineState();
  await app.operations.initializeRosterCandidateSync();
  // Model a submit button's default form activation as well as its click
  // listeners: a second click save path must not introduce a duplicate PUT.
  const submit = () => Promise.all([
    app.elements.get("savePredictionButton").emit("click"),
    app.elements.get("predictionForm").emit("submit")
  ]);
  return { app, calls, submit };
}

for (const [label, change, message] of [
  ["missing player", (lineup) => { lineup[8].player = ""; }, /1番から9番まで全て/],
  ["missing position", (lineup) => { lineup[8].position = ""; }, /守備位置を全て/],
  ["duplicate player", (lineup) => { lineup[8].player = lineup[0].player; }, /同じ選手/],
  ["duplicate defensive position", (lineup) => { lineup[8].position = lineup[1].position; }, /同じ守備位置/]
]) {
  test(`submit rejects ${label} without saving a draft or making a PUT`, async (t) => {
    const lineup = completeLineup.map((item) => ({ ...item }));
    change(lineup);
    const { app, calls, submit } = await predictionApp(t, { lineup });
    await submit();
    assert.match(app.elements.get("predictionError").textContent, message);
    assert.equal(app.state.prediction, null);
    assert.equal([...app.stored.keys()].some((key) => key.startsWith("hamStarting9Prediction")), false);
    assert.equal(calls.filter((call) => call.options.method === "PUT").length, 0);
  });
}

test("duplicate DH assignments remain allowed by the local lineup contract", async (t) => {
  const lineup = completeLineup.map((item) => ({ ...item }));
  lineup[7].position = "指";
  lineup[8].position = "指";
  const { app, calls, submit } = await predictionApp(t, { lineup });
  await submit();
  assert.equal(app.state.prediction.lineup.length, 9);
  assert.equal(calls.filter((call) => call.options.method === "PUT").length, 1);
});

test("complete submit saves locally and remotely once; in-flight button is disabled and double submit is ignored", async (t) => {
  let finish;
  const { app, calls, submit } = await predictionApp(t, { save: () => new Promise((resolve) => { finish = resolve; }) });
  assert.equal(app.elements.get("savePredictionButton").disabled, false);
  const pending = submit();
  await new Promise(setImmediate);
  assert.equal(app.elements.get("savePredictionButton").disabled, true);
  assert.match(app.elements.get("savePredictionButton").textContent, /保存中/);
  await submit();
  const put = calls.filter((call) => call.options.method === "PUT");
  assert.equal(put.length, 1);
  assert.equal(put[0].options.credentials, "include");
  assert.equal(JSON.parse(put[0].options.body).internalGameId, "canonical-game");
  assert.equal(JSON.parse(put[0].options.body).contestId, "contest_63616e6f6e6963616c2d67616d65_6669676874657273");
  assert.equal(JSON.parse(put[0].options.body).prediction.lineup.length, 9);
  assert.ok([...app.stored.values()].some((value) => JSON.parse(value)?.lineup?.length === 9));
  finish({ ok: true, json: async () => ({ ok: true }) });
  await pending;
  assert.equal(app.elements.get("savePredictionButton").disabled, false);
  assert.equal(app.elements.get("predictionSaveMessage").textContent, "予想を保存しました。");
  assert.equal(app.state.predictionRemote.isSubmitting, false);
  assert.equal(calls.length, 2, "saving does not launch a separate account resync");
});

test("anonymous submit retains local prediction and gives login guidance without PUT", async (t) => {
  const { app, calls, submit } = await predictionApp(t, { user: null });
  await submit();
  assert.equal(app.state.prediction.lineup.length, 9);
  assert.match(app.elements.get("predictionSaveMessage").textContent, /ログインするとアカウントにも保存/);
  assert.equal(calls.filter((call) => call.options.method === "PUT").length, 0);
});

for (const status of [401, 503]) {
  test(`save HTTP ${status} preserves local draft, releases button, and reports actionable error`, async (t) => {
    const { app, submit } = await predictionApp(t, { save: () => ({ ok: false, status, json: async () => ({ ok: false, code: status === 401 ? "AUTH_REQUIRED" : "D1_READ_LIMIT_EXCEEDED" }) }) });
    await submit();
    assert.equal(app.state.prediction.lineup.length, 9);
    assert.equal(app.elements.get("savePredictionButton").disabled, false);
    assert.match(app.elements.get("predictionError").textContent, status === 401 ? /再ログイン/ : /時間をおいて/);
  });
}

for (const scenario of [
  { name: "forbidden", status: 403, code: "FORBIDDEN", expected: /権限がありません/ },
  { name: "deadline conflict", status: 409, code: "PREDICTION_NOT_OPEN", expected: /アカウント保存に失敗しました/ },
  { name: "network failure", network: true, expected: /通信状況を確認/ },
  { name: "server failure", status: 500, code: "PREDICTION_SAVE_FAILED", expected: /時間をおいて再試行/ }
]) {
  test(`save ${scenario.name} retains the local prediction and actionable message`, async (t) => {
    const { app, submit } = await predictionApp(t, {
      save: () => scenario.network
        ? Promise.reject(new TypeError("offline"))
        : ({ ok: false, status: scenario.status, json: async () => ({ ok: false, code: scenario.code }) })
    });
    await submit();
    assert.equal(app.state.prediction.lineup.length, 9);
    assert.match(app.elements.get("predictionError").textContent, scenario.expected);
    assert.equal(app.state.predictionRemote.isSaving, false);
  });
}

test("account restore does not replace an existing local prediction", async (t) => {
  const app = createPublicRuntime({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, prediction: { lineup: [{ playerName: "別の予想", battingOrder: 1, position: "指" }] } }) }) });
  t.after(app.dispose);
  const draft = { gameId: "canonical-game", lineup: completeLineup };
  app.state.prediction = draft;
  app.state.predictionDeadline = { status: "open", isClosed: false };
  await app.operations.initializePredictionRemoteSync();
  assert.equal(app.state.prediction, draft);
  assert.equal(app.state.predictionRemote.conflict, true);
});
