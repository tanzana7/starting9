const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("締切はJSTの試合開始60分前で判定し、境界時刻以降を締切後にする", async () => {
  const deadline = await import(pathToFileURL(path.join(root, "prediction-deadline.js")).href);
  const gameId = "2026-07-22-l-f-16";

  const before = deadline.getPredictionDeadlineStatus(gameId, new Date("2026-07-22T07:59:59.000Z"));
  const atDeadline = deadline.getPredictionDeadlineStatus(gameId, new Date("2026-07-22T08:00:00.000Z"));

  assert.equal(before.ok, true);
  assert.equal(before.isClosed, false);
  assert.equal(before.deadlineAt, "2026-07-22T08:00:00.000Z");
  assert.equal(atDeadline.ok, true);
  assert.equal(atDeadline.isClosed, true);
  assert.equal(atDeadline.code, "PREDICTION_DEADLINE_PASSED");
});

test("日程または開始時刻を確認できない試合は安全側で保存不可にする", async () => {
  const deadline = await import(pathToFileURL(path.join(root, "prediction-deadline.js")).href);
  const status = deadline.getPredictionDeadlineStatus("2026-12-31-f-h-99", new Date("2026-12-31T00:00:00.000Z"));

  assert.equal(status.ok, false);
  assert.equal(status.code, "PREDICTION_SCHEDULE_UNAVAILABLE");
});

test("Workerは予想のPUTとDELETEの両方でサーバー時刻の締切判定を通す", () => {
  const worker = read("auth-worker.js");
  const deadlinePolicy = read("prediction-deadline.js");
  const put = worker.slice(worker.indexOf("async function handlePutCurrentPrediction"), worker.indexOf("async function handleDeleteCurrentPrediction"));
  const remove = worker.slice(worker.indexOf("async function handleDeleteCurrentPrediction"), worker.indexOf("async function getPredictionRow"));

  assert.match(worker, /import \{ getPredictionDeadlineStatus \} from "\.\/prediction-deadline\.js"/);
  assert.match(put, /createPredictionDeadlineRejection\(metadata, cors\)/);
  assert.match(remove, /createPredictionDeadlineRejection\(metadata, cors\)/);
  assert.match(worker, /PREDICTION_SCHEDULE_UNAVAILABLE/);
  assert.match(deadlinePolicy, /PREDICTION_DEADLINE_PASSED/);
});

test("クライアントは締切後に入力・保存・リセットを止め、管理者テスト上書きは画面状態だけに限定する", () => {
  const script = read("script.js");
  const html = read("index.html");

  assert.match(script, /function getPredictionDeadlineMinutesBeforeStart\(\)/);
  assert.match(script, /predictionDeadlineMinutesBeforeStart/);
  assert.match(script, /setInterval\(\(\) => \{[\s\S]*?refreshPredictionDeadlineState\(\);[\s\S]*?refreshPredictionTarget\(\{ retryUnannounced: false \}\)/);
  assert.match(script, /function ensurePredictionEditingAllowed\(\)/);
  assert.match(script, /async function handlePredictionSubmit[\s\S]*?ensurePredictionEditingAllowed\(\)/);
  assert.match(script, /function resetPredictionInput\(\) \{\s*if \(!ensurePredictionEditingAllowed\(\)\)/);
  assert.match(script, /function canUsePredictionDeadlineOverride\(\) \{\s*return state\.appMode === "admin"/);
  assert.match(html, /id="predictionDeadlineStatus"/);
  assert.match(script, /function handlePredictionDeadlineOverrideClick\(event\)/);
  assert.match(script, /data-prediction-deadline-override/);
});

test("管理画面には締切の開始・締切・状態・テスト上書きを表示する", () => {
  const script = read("script.js");
  const html = read("index.html");

  assert.match(html, /id="adminPredictionDeadlineStatus"/);
  assert.match(html, /id="adminTestPredictionDeadlineStatus"/);
  assert.match(script, /function renderPredictionDeadlineAdmin\(\)/);
  for (const label of ["試合開始", "予想締切", "受付状態", "開発上書き"]) {
    assert.match(script, new RegExp(label));
  }
  assert.match(script, /state\.appMode === "admin"/);
  assert.match(script, /state\.appMode === "admin" && state\.adminAccess\.status === "authorized"/);
  assert.match(script, /function renderPredictionDeadlinePanel\(container, deadline, shouldShow\)/);
  assert.match(script, /\["auto", "自動"\]/);
  assert.match(script, /\["before", "締切前"\]/);
  assert.match(script, /\["after", "締切後"\]/);
  assert.doesNotMatch(html, /development-deadline-title/);
});
