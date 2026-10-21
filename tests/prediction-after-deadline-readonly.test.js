const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createPublicRuntime } = require("./helpers/public-runtime.cjs");

const root = path.join(__dirname, "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const roster = fs.readFileSync(path.join(root, "frontend", "public", "roster.js"), "utf8");

test("締切後も保存済み予想を表示し、編集CTAだけを隠す", () => {
  const saved = script.slice(script.indexOf("function renderSavedPrediction"), script.indexOf("function renderPredictionCta"));
  const cta = script.slice(script.indexOf("function renderPredictionCta"), script.indexOf("function handlePredictionCtaClick"));
  assert.match(saved, /isPredictionEditingLocked\(\)/);
  assert.match(saved, /editButton\?\.classList\.toggle\("hidden", isReadOnly\)/);
  assert.match(saved, /container\.className = `summary-box\$\{isReadOnly \? " is-read-only" : ""\}`/);
  assert.match(cta, /!selectedGame \|\| isPredictionEditingLocked\(\)/);
  assert.match(html, /id="predictionDeadlineStatus"/);
  assert.match(script, /return todayCurrent \|\| todayUpcoming \|\| todayOpen \|\| nextOpen/);
});

test("締切後のフォーム操作はボタン・候補を無効化する", () => {
  const picker = script.slice(script.indexOf("function renderPicker"), script.indexOf("function renderPredictionRosterFilter"));
  assert.match(picker, /positionButton\.disabled = isLocked/);
  assert.match(picker, /clearButton\.disabled = isLocked/);
  assert.match(picker, /chip\.disabled = isLocked/);
  assert.match(picker, /position-menu-option[\s\S]*disabled = isLocked/);
  assert.match(picker, /button\.disabled = isLocked/);
  assert.match(script, /if \(resetButton\) resetButton\.disabled = Boolean\(deadline\.isClosed\)/);
  assert.match(roster, /button\.setAttribute\("aria-pressed"/);
});

test("締切後のアカウント同期はサーバー値を正本にし、未保存なら端末値を消す", async (t) => {
  const app = createPublicRuntime({ fetchImpl: async () => ({ ok: true, json: async () => ({
    ok: true,
    prediction: { lineup: [{ battingOrder: 1, playerName: "サーバー予想", position: "右" }] }
  }) }) });
  t.after(app.dispose);
  app.state.predictionDeadline = { status: "closed", isClosed: true };
  app.state.prediction = { gameId: "canonical-game", lineup: [{ order: 1, player: "端末の古い予想", position: "左" }] };
  app.stored.set("hamStarting9Prediction:contest:fighters:game:canonical-game", JSON.stringify(app.state.prediction));

  await app.operations.initializePredictionRemoteSync();

  assert.equal(app.state.prediction.lineup[0].player, "サーバー予想");
  assert.equal(app.state.predictionRemote.status, "success");
  assert.equal(app.stored.has("hamStarting9Prediction:contest:fighters:game:canonical-game"), true);
  assert.equal(JSON.parse(app.stored.get("hamStarting9Prediction:contest:fighters:game:canonical-game")).lineup[0].player, "サーバー予想");

  const empty = createPublicRuntime({ fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, prediction: null }) }) });
  t.after(empty.dispose);
  empty.state.predictionDeadline = { status: "closed", isClosed: true };
  empty.state.prediction = { gameId: "canonical-game", lineup: [{ order: 1, player: "端末のみ", position: "左" }] };
  empty.stored.set("hamStarting9Prediction:contest:fighters:game:canonical-game", JSON.stringify(empty.state.prediction));
  await empty.operations.initializePredictionRemoteSync();
  assert.equal(empty.state.prediction, null);
  assert.equal(empty.stored.has("hamStarting9Prediction:contest:fighters:game:canonical-game"), false);
  assert.match(script, /isClosedWithoutSavedPrediction = getEffectivePredictionDeadline\(\)\.status === "closed"/);
});

test("公開assetは締切後read-only修正のcache busterを持つ", () => {
  assert.match(html, /script\.js\?v=[^"']*prediction-readonly-after-deadline-1/);
});
