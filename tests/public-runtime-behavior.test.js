const assert = require("node:assert/strict");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

function roster(players, overrides = {}) {
  return { ok: true, internalGameId: "canonical-game", gameDate: "2099-07-21",
    status: "fresh", rosterUse: "official_live", canUseForPrediction: true,
    players, fingerprint: JSON.stringify(players), ...overrides };
}

async function mutationBreaksContract(options, assertion) {
  const app = createPublicRuntime(options);
  try {
    await assertion(app);
    return false;
  } catch {
    return true;
  } finally {
    app.dispose();
  }
}

test("late roster response cannot overwrite the new game's candidates or snapshot", async (t) => {
  const pending = [];
  const app = createPublicRuntime({ candidateNames: ["矢澤宏太", "水谷瞬"], fetchImpl: (url) => new Promise((resolve) => pending.push({ url, resolve })) });
  t.after(app.dispose);
  const first = app.operations.initializeRosterCandidateSync();
  app.state.predictionTargetGameId = "game-b";
  app.state.predictionTargetGame = { internalGameId: "game-b", date: "2099-07-22" };
  const second = app.operations.initializeRosterCandidateSync();
  pending[1].resolve({ ok: true, json: async () => roster([{ number: "53", name: "水谷瞬" }], { internalGameId: "game-b", gameDate: "2099-07-22" }) });
  await second;
  const adopted = JSON.stringify(app.state.publicRoster);
  const cached = [...app.stored.entries()];
  pending[0].resolve({ ok: true, json: async () => roster([{ number: "12", name: "矢澤宏太" }]) });
  await first;
  assert.equal(JSON.stringify(app.state.publicRoster), adopted);
  assert.deepEqual([...app.stored.entries()], cached);
  assert.equal(app.chips[0].classList.contains("hidden"), true);
  assert.equal(app.chips[1].classList.contains("hidden"), false);
  assert.equal(pending.length, 2);
});

test("roster refresh keeps selected prediction slots and uses the stored fallback on network failure", async (t) => {
  let offline = false;
  const app = createPublicRuntime({ ui: true, lineup: [{ player: "矢澤宏太", position: "右" }], candidateNames: ["矢澤宏太"], fetchImpl: async () => {
    if (offline) throw new Error("offline");
    return { ok: true, json: async () => roster([{ number: "12", name: "矢澤宏太" }]) };
  } });
  t.after(app.dispose);
  const prediction = { gameId: "canonical-game", lineup: [{ player: "矢澤宏太", position: "右" }] };
  app.state.prediction = prediction;
  const selection = JSON.stringify(app.slots.map((slot) => slot.dataset));
  await app.operations.initializeRosterCandidateSync();
  offline = true;
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.state.publicRoster.status, "stale");
  assert.equal(app.state.publicRoster.isLoading, false);
  assert.equal(app.chips[0].classList.contains("hidden"), false);
  assert.match(app.elements.get("predictionRosterStatus").textContent, /前回取得データ/);
  assert.equal(app.state.prediction, prediction);
  assert.equal(JSON.stringify(app.slots.map((slot) => slot.dataset)), selection);
});

test("latest roster refresh wins even when both requests belong to the same game", async (t) => {
  const pending = [];
  const app = createPublicRuntime({ fetchImpl: () => new Promise((resolve) => pending.push(resolve)) });
  t.after(app.dispose);
  const first = app.operations.initializeRosterCandidateSync();
  const second = app.operations.initializeRosterCandidateSync();
  pending[1]({ ok: true, json: async () => roster([{ number: "53", name: "水谷瞬" }]) });
  await second;
  const expected = JSON.stringify(app.state.publicRoster);
  pending[0]({ ok: true, json: async () => roster([{ number: "12", name: "矢澤宏太" }]) });
  await first;
  assert.equal(JSON.stringify(app.state.publicRoster), expected);
});

test("roster request is discarded if the target changes without starting another request", async (t) => {
  let resolve;
  const app = createPublicRuntime({ fetchImpl: () => new Promise((done) => { resolve = done; }) });
  t.after(app.dispose);
  const request = app.operations.initializeRosterCandidateSync();
  app.state.predictionTargetGame = { internalGameId: "game-b", date: "2099-07-22" };
  resolve({ ok: true, json: async () => roster([{ number: "12", name: "矢澤宏太" }]) });
  await request;
  assert.equal(app.state.publicRoster.players.length, 0);
  assert.equal(app.stored.size, 0);
});

test("roster source compatibility and explicit acquisition stop preserve the current fallback boundary", async (t) => {
  let payload;
  const app = createPublicRuntime({ candidateNames: ["矢澤宏太"], fetchImpl: async () => ({ ok: true, json: async () => payload }) });
  t.after(app.dispose);
  for (const source of [
    { rosterUse: "verified_snapshot", canUseForPrediction: false },
    { rosterUse: "", sourceOfTruth: "", status: "fresh", displayRosterSource: "latest_official_live" },
    { rosterUse: "", sourceOfTruth: "", status: "stale", displayRosterSource: "stale_snapshot" }
  ]) {
    payload = roster([{ number: "12", name: "矢澤宏太" }], source);
    await app.operations.initializeRosterCandidateSync();
    assert.equal(app.chips[0].classList.contains("hidden"), false);
    assert.equal(app.state.publicRoster.players.length, 1);
  }
  payload = roster([], { externalFetchDisabled: true });
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.state.publicRoster.externalFetchDisabled, true);
  assert.equal(app.state.publicRoster.players.length, 0);
  assert.equal(app.chips[0].classList.contains("hidden"), true);
});

test("captured roster runtime reflects the current game's candidates and clears the update notice", async (t) => {
  const app = createPublicRuntime({
    ui: true,
    candidateNames: ["正式取得選手"],
    fetchImpl: async () => ({ ok: true, json: async () => roster([
      { name: "正式取得選手", number: "12", position: "外野手" }
    ], { status: "captured", displayRosterSource: "fresh_snapshot" }) })
  });
  t.after(app.dispose);

  await app.operations.initializeRosterCandidateSync();

  assert.equal(app.state.publicRoster.internalGameId, "canonical-game");
  assert.equal(app.state.publicRoster.players[0].name, "正式取得選手");
  assert.equal(app.state.publicRoster.players[0].number, "12");
  assert.equal(app.elements.get("predictionRosterStatus").textContent, "");
  assert.equal(app.chips[0].classList.contains("hidden"), false);
});

test("pending roster runtime hides static candidates and keeps the update notice", async (t) => {
  const app = createPublicRuntime({
    ui: true,
    candidateNames: ["静的候補"],
    fetchImpl: async () => ({ ok: true, json: async () => ({
      ok: true,
      internalGameId: "canonical-game",
      gameDate: "2099-07-21",
      status: "pending",
      players: []
    }) })
  });
  t.after(app.dispose);

  await app.operations.initializeRosterCandidateSync();

  assert.equal(app.state.publicRoster.status, "pending");
  assert.equal(app.state.publicRoster.players.length, 0);
  assert.equal(app.chips[0].classList.contains("hidden"), true);
  assert.match(app.elements.get("predictionRosterStatus").textContent, /選手情報を更新中/);
});

test("baseline roster runtime keeps usable candidates and shows the stale-data warning", async (t) => {
  const app = createPublicRuntime({
    ui: true,
    now: "2026-09-08T00:00:00Z",
    candidateNames: ["保存選手"],
    fetchImpl: async () => ({ ok: true, json: async () => roster([
      { name: "保存選手", number: "12", position: "外野手" }
    ], {
      status: "baseline",
      displayRosterSource: "baseline_snapshot",
      sourceOfTruth: "baseline_snapshot",
      rosterUse: "baseline_snapshot",
      usableUntil: "2099-07-22T00:00:00Z"
    }) })
  });
  t.after(app.dispose);

  await app.operations.initializeRosterCandidateSync();

  assert.equal(app.state.publicRoster.status, "baseline");
  assert.equal(app.state.publicRoster.players[0].name, "保存選手");
  assert.equal(app.chips[0].classList.contains("hidden"), false);
  assert.match(app.elements.get("predictionRosterStatus").textContent, /前回取得データの場合があります/);
});

test("roster refresh adopts normalized current players, deduplicates and reflects changes without append", async () => {
  let payload = roster([{ number: "01", name: "水谷　 瞬" }, { number: "01", name: "水谷 瞬" }, { number: "001", name: "同名 選手" }]);
  const calls = [];
  const app = createPublicRuntime({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => payload };
  } });
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.state.publicRoster.players.length, 2);
  assert.equal(app.state.publicRoster.players[0].name, "水谷瞬");
  assert.equal(app.state.publicRoster.players[0].number, "01");
  assert.equal(app.state.publicRoster.players[1].number, "001");
  const first = JSON.stringify(app.state.publicRoster);
  await app.operations.initializeRosterCandidateSync();
  assert.equal(JSON.stringify(app.state.publicRoster), first);
  payload = roster([{ number: "12", name: "矢澤 宏太" }]);
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.state.publicRoster.players.length, 1);
  assert.equal(app.state.publicRoster.players[0].name, "矢澤宏太");
  assert.equal(app.state.publicRoster.status, "fresh");
  assert.equal(app.appState.roster, app.state.publicRoster);
  assert.equal(calls[0].url, "https://starting9.test/api/game-day-roster?internalGameId=canonical-game");
  assert.equal(calls[0].options.credentials, "include");
});

test("invalid roster is not adopted; failed refresh uses only the same game's successful snapshot", async () => {
  let payload = roster([{ name: "登録選手", number: "12" }]);
  const app = createPublicRuntime({ fetchImpl: async () => ({ ok: true, json: async () => payload }) });
  await app.operations.initializeRosterCandidateSync();
  payload = { ok: false, players: [] };
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.state.publicRoster.status, "stale");
  assert.equal(app.state.publicRoster.players[0].name, "登録選手");
  app.state.predictionTargetGameId = "another-game";
  app.state.predictionTargetGame = { internalGameId: "another-game", date: "2099-07-22" };
  payload = roster([{ name: "別試合選手", number: "1" }]);
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.state.publicRoster.status, "pending");
  assert.equal(app.state.publicRoster.players.length, 0);
});

test("explicit roster acquisition stop does not reuse stale candidates", async () => {
  const app = createPublicRuntime({ fetchImpl: async () => ({ ok: true, json: async () => roster([], { externalFetchDisabled: true }) }) });
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.state.publicRoster.canUseForPrediction, false);
  assert.equal(app.state.publicRoster.players.length, 0);
});

test("candidate visibility matches uniform numbers exactly, including the pitcher-registered batter", async () => {
  let payload = roster([{ number: "12", name: "矢澤 宏太" }]);
  const app = createPublicRuntime({ candidateNames: ["矢澤宏太", "水谷瞬"], fetchImpl: async () => ({ ok: true, json: async () => payload }) });
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.chips[0].classList.contains("hidden"), false);
  assert.equal(app.chips[1].classList.contains("hidden"), true);
  payload = roster([{ number: "012", name: "矢澤 宏太" }]);
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.chips[0].classList.contains("hidden"), true);
  app.state.candidateRosterFilter = "inactive";
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.chips[0].classList.contains("hidden"), false);
});

test("signed-in prediction sync calls current canonical endpoint and hydrates saved prediction", async () => {
  const calls = [];
  const app = createPublicRuntime({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, prediction: { lineup: [{ battingOrder: 1, playerName: "矢澤宏太", position: "右" }] } }) };
  } });
  await app.operations.initializePredictionRemoteSync();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://starting9.test/api/predictions/current?internalGameId=canonical-game");
  assert.equal(calls[0].options.credentials, "include");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(app.state.predictionRemote.status, "success");
  assert.equal(app.state.prediction.gameId, "canonical-game");
  assert.equal(app.state.prediction.lineup[0].player, "矢澤宏太");
  assert.equal(app.appState.account.status, "success");
});

test("signed-out prediction sync does not fetch or discard a local prediction", async () => {
  let calls = 0;
  const app = createPublicRuntime({ user: null, fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); } });
  const local = { gameId: "canonical-game", lineup: [] };
  app.state.prediction = local;
  await app.operations.initializePredictionRemoteSync();
  assert.equal(calls, 0);
  assert.equal(app.state.prediction, local);
  assert.equal(app.state.predictionRemote.status, "idle");
});

for (const failure of ["network", "unauthorized"]) {
  test(`prediction ${failure} failure preserves local draft and releases loading state`, async () => {
    const app = createPublicRuntime({ fetchImpl: async () => {
      if (failure === "network") throw new Error("offline");
      return { ok: false, status: 401, json: async () => ({ ok: false, code: "AUTH_REQUIRED" }) };
    } });
    const local = { gameId: "canonical-game", lineup: [] };
    app.state.prediction = local;
    await app.operations.initializePredictionRemoteSync();
    assert.equal(app.state.prediction, local);
    assert.equal(app.state.predictionRemote.status, "error");
    assert.equal(app.state.predictionRemote.isLoading, false);
    assert.equal(app.state.predictionRemote.prediction, null);
  });
}

test("pending roster hides even static active candidates, while baseline expires at its usableUntil", async (t) => {
  let payload = { ok: false, players: [] };
  const app = createPublicRuntime({ ui: true, now: "2026-09-08T00:00:00Z", candidateNames: ["矢澤宏太"], fetchImpl: async () => ({ ok: true, json: async () => payload }) });
  t.after(app.dispose);
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.chips[0].classList.contains("hidden"), true);
  assert.match(app.elements.get("predictionRosterStatus").textContent, /選手情報を更新中/);
  payload = roster([{ name: "矢澤宏太", number: "12", position: "投手" }], { status: "baseline", rosterUse: "baseline_snapshot", usableUntil: "2026-09-08T01:00:00Z" });
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.chips[0].classList.contains("hidden"), false);
  app.operations.startPredictionDeadlineTicker();
  app.setNow("2026-09-08T01:00:00Z");
  await app.tickIntervals();
  assert.equal(app.chips[0].classList.contains("hidden"), true);
});

test("pitcher-source batter is active while special DH stays in the other candidate filter", async (t) => {
  const app = createPublicRuntime({ ui: true, candidateNames: ["矢澤宏太", "山﨑福也"], fetchImpl: async () => ({ ok: true, json: async () => roster([{ name: "矢澤宏太", number: "12", position: "投手" }, { name: "山﨑福也", number: "18", position: "投手" }]) }) });
  t.after(app.dispose);
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.chips[0].classList.contains("hidden"), false);
  assert.equal(app.chips[1].classList.contains("hidden"), true);
  app.state.candidateRosterFilter = "inactive";
  await app.operations.initializeRosterCandidateSync();
  assert.equal(app.chips[0].classList.contains("hidden"), true);
  assert.equal(app.chips[1].classList.contains("hidden"), false);
});

test("roster runtime mutation probes catch the protected reflection boundaries", async () => {
  const wrongGameCaught = await mutationBreaksContract({
    scriptTransform: (file, source) => file === "roster.js"
      ? source.replace("gameSnapshot.internalGameId === internalGameId", "true")
      : source,
    fetchImpl: async () => ({ ok: true, json: async () => roster([
      { name: "別試合選手", number: "1", position: "外野手" }
    ], { internalGameId: "wrong-game" }) })
  }, async (app) => {
    await app.operations.initializeRosterCandidateSync();
    assert.equal(app.state.publicRoster.players.length, 0);
  });

  const duplicateCaught = await mutationBreaksContract({
    scriptTransform: (file, source) => file === "script.js"
      ? source.replace("if (!displayName || !key || seen.has(key))", "if (!displayName || !key)")
      : source,
    fetchImpl: async () => ({ ok: true, json: async () => roster([
      { name: "水谷　 瞬", number: "01", position: "外野手" },
      { name: "水谷 瞬", number: "01", position: "外野手" }
    ]) })
  }, async (app) => {
    await app.operations.initializeRosterCandidateSync();
    assert.equal(app.state.publicRoster.players.length, 1);
  });

  const jerseyCaught = await mutationBreaksContract({
    scriptTransform: (file, source) => file === "script.js"
      ? source.replace('number: String(source.number || "").trim(),', "number: Number(source.number || 0),")
      : source,
    fetchImpl: async () => ({ ok: true, json: async () => roster([
      { name: "背番号01", number: "01", position: "外野手" }
    ]) })
  }, async (app) => {
    await app.operations.initializeRosterCandidateSync();
    assert.equal(typeof app.state.publicRoster.players[0].number, "string");
    assert.equal(app.state.publicRoster.players[0].number, "01");
  });

  const selectionCaught = await mutationBreaksContract({
    lineup: [{ player: "選択中選手", position: "右" }],
    scriptTransform: (file, source) => file === "roster.js"
      ? source.replace("deps.state.publicRoster = nextRoster;", "deps.state.publicRoster = nextRoster;\n      deps.state.prediction = null;")
      : source,
    fetchImpl: async () => ({ ok: true, json: async () => roster([
      { name: "選択中選手", number: "12", position: "外野手" }
    ]) })
  }, async (app) => {
    const prediction = { gameId: "canonical-game", lineup: [{ player: "選択中選手", position: "右" }] };
    app.state.prediction = prediction;
    await app.operations.initializeRosterCandidateSync();
    assert.equal(app.state.prediction, prediction);
  });

  const pendingCaught = await mutationBreaksContract({
    scriptTransform: (file, source) => file === "roster.js"
      ? source.replace('if (status === "captured" || status === "fresh") return "fresh";', 'if (status === "captured" || status === "fresh" || status === "pending") return "fresh";')
      : source,
    fetchImpl: async () => ({ ok: true, json: async () => roster([
      { name: "未発表扱い選手", number: "12", position: "外野手" }
    ], { status: "pending" }) })
  }, async (app) => {
    await app.operations.initializeRosterCandidateSync();
    assert.equal(app.state.publicRoster.players.length, 0);
  });

  assert.equal(wrongGameCaught, true);
  assert.equal(duplicateCaught, true);
  assert.equal(jerseyCaught, true);
  assert.equal(selectionCaught, true);
  assert.equal(pendingCaught, true);
});
