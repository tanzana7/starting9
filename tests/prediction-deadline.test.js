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
  assert.match(put, /const writeNow = getPredictionWriteNow\(env\);[\s\S]*?createPredictionDeadlineRejection\(metadata, cors, writeNow\)/);
  assert.match(remove, /createPredictionDeadlineRejection\(metadata, cors\)/);
  assert.match(worker, /PREDICTION_SCHEDULE_UNAVAILABLE/);
  assert.match(deadlinePolicy, /PREDICTION_DEADLINE_PASSED/);
});

test("クライアントは締切後に入力・保存・リセットを止める", () => {
  const script = read("script.js");
  const predictionForm = read("frontend/public/prediction-form.js");
  const html = read("index.html");

  assert.match(script, /function getPredictionDeadlineMinutesBeforeStart\(\)/);
  assert.match(script, /predictionDeadlineMinutesBeforeStart/);
  assert.match(script, /setInterval\(\(\) => \{[\s\S]*?refreshPredictionDeadlineState\(\);[\s\S]*?refreshPredictionTarget\(\{ retryUnannounced: false \}\)/);
  assert.match(script, /function ensurePredictionEditingAllowed\(\)/);
  assert.match(predictionForm, /async function handleSubmit[\s\S]*?deps\.ensurePredictionEditingAllowed\(\)/);
  assert.match(predictionForm, /function reset\(\) \{\s*if \(!deps\.ensurePredictionEditingAllowed\(\)\)/);
  assert.match(html, /id="predictionDeadlineStatus"/);
  assert.doesNotMatch(script, /canUsePredictionDeadlineOverride|handlePredictionDeadlineOverrideClick|data-prediction-deadline-override/);
});

test("通常公開画面に管理者向け締切テストUIを含めない", () => {
  const script = read("script.js");
  const html = read("index.html");

  assert.doesNotMatch(html, /adminPredictionDeadlineStatus|adminTestPredictionDeadlineStatus|development-deadline-title/);
  assert.doesNotMatch(script, /renderPredictionDeadlineAdmin|renderPredictionDeadlinePanel|appMode|adminAccess/);
});
