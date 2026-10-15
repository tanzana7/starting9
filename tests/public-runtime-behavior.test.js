const assert = require("node:assert/strict");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

function roster(players, overrides = {}) {
  return { ok: true, internalGameId: "canonical-game", gameDate: "2099-07-21",
    status: "fresh", rosterUse: "official_live", canUseForPrediction: true,
    players, fingerprint: JSON.stringify(players), ...overrides };
}

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
