const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "auth-worker.js"), "utf8");

function sourceForFunction(source, name) {
  const start = source.indexOf(`function ${name}(`) !== -1
    ? source.indexOf(`function ${name}(`)
    : source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  const nextFunction = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, nextFunction === -1 ? source.length : nextFunction);
}

test("通常画面にはニックネーム入力と必須エラーを残さない", () => {
  assert.doesNotMatch(html, /id="nickname"/);
  assert.doesNotMatch(html, /ニックネーム/);
  assert.doesNotMatch(script, /ニックネームを入力してください/);
  assert.doesNotMatch(script, /getElementById\("nickname"\)/);
});

test("予想保存はニックネームなしで9人の入力検証と端末保存を行う", () => {
  const submit = sourceForFunction(script, "handlePredictionSubmit");
  assert.match(submit, /const validationError = validateLineup\(lineup, "予想"\)/);
  assert.match(submit, /saveToStorage\(STORAGE_KEYS\.prediction, state\.prediction\)/);
  assert.match(submit, /if \(getPredictionAccountUser\(\)\) \{\s+savePredictionToAccount/);
  assert.doesNotMatch(submit, /nickname/);
});

test("サーバーへ送るprediction_jsonとWorker検証はニックネームを使用しない", () => {
  const payload = sourceForFunction(script, "createPredictionPayload");
  const sanitize = sourceForFunction(worker, "sanitizePredictionPayload");
  assert.match(payload, /schemaVersion: 1/);
  assert.match(payload, /lineup: serializedLineup/);
  assert.doesNotMatch(payload, /nickname/);
  assert.match(sanitize, /lineup: lineup\.sort/);
  assert.doesNotMatch(sanitize, /nickname/);
});

test("サーバー保存はセッションのuser_idを使い、クライアント指定ユーザーを信用しない", () => {
  const save = sourceForFunction(worker, "handlePutCurrentPrediction");
  assert.match(save, /const session = await getSessionUser\(request, env\)/);
  assert.match(save, /\.bind\(\s*id,\s*session\.id,/);
  assert.doesNotMatch(save, /input\?\.userId|input\?\.user_id|input\?\.nickname/);
  assert.match(worker, /JOIN users ON users\.id = sessions\.user_id/);
});

test("X共有はニックネームなしで予想内容とサービスURLを使う", () => {
  const share = sourceForFunction(script, "createPredictionShareText");
  assert.match(share, /getPredictionShareUrl\(\)/);
  assert.match(share, /lineup\.map/);
  assert.doesNotMatch(share, /nickname/);
});
