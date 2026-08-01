const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

function sourceForFunction(name) {
  const start = script.indexOf(`function ${name}(`) !== -1
    ? script.indexOf(`function ${name}(`)
    : script.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  const next = script.indexOf("\nfunction ", start + 1);
  return script.slice(start, next === -1 ? script.length : next);
}

test("通常画面にアカウント保存専用パネルと専用ボタンを置かない", () => {
  assert.doesNotMatch(html, /predictionAccountPanel|savePredictionToAccountButton|loadPredictionFromAccountButton/);
  assert.match(html, /id="savePredictionButton"/);
  assert.doesNotMatch(css, /\.prediction-account-panel|\.prediction-account-actions/);
  assert.doesNotMatch(script, /アカウントにも保存済みです。最終更新/);
});

test("主保存ボタンはログイン時に端末保存後のアカウント保存へ統合する", () => {
  const submit = sourceForFunction("handlePredictionSubmit");
  assert.match(submit, /saveToStorage\(STORAGE_KEYS\.prediction, state\.prediction\)/);
  assert.match(submit, /if \(!getPredictionAccountUser\(\)\)/);
  assert.match(submit, /await savePredictionToAccount\(state\.prediction\)/);
  assert.match(submit, /この端末に予想を保存しました。/);
  assert.match(submit, /予想を保存しました。/);
  assert.match(submit, /state\.predictionRemote\.message/);
});

test("アカウント保存中は主保存ボタンを無効化して二重送信を防止する", () => {
  const updateButton = sourceForFunction("updatePredictionSaveButton");
  const save = sourceForFunction("savePredictionToAccount");
  assert.match(updateButton, /button\.disabled = isSaving \|\| isSubmitting \|\| isPredictionEditingLocked\(\)/);
  assert.match(updateButton, /保存中\.\.\./);
  assert.match(save, /state\.predictionRemote\.isSaving = true/);
  assert.match(save, /state\.predictionRemote\.isSaving = false/);
  assert.match(save, /credentials: "include"/);
  assert.match(save, /端末には保存しましたが、アカウント保存に失敗しました/);
});

test("1回の保存操作を送信中フラグで排他し、成功後に別同期の失敗を保存エラーへ変換しない", () => {
  const submit = sourceForFunction("handlePredictionSubmit");
  const sync = sourceForFunction("syncPredictionFromAccount");

  assert.match(submit, /if \(state\.predictionRemote\.isSaving \|\| state\.predictionRemote\.isSubmitting\)/);
  assert.match(submit, /state\.predictionRemote\.isSubmitting = true/);
  assert.match(submit, /finally \{[\s\S]*?state\.predictionRemote\.isSubmitting = false/);
  assert.equal((submit.match(/saveToStorage\(STORAGE_KEYS\.prediction, state\.prediction\)/g) || []).length, 1);
  assert.equal((submit.match(/savePredictionToAccount\(state\.prediction\)/g) || []).length, 1);
  assert.doesNotMatch(submit, /syncPredictionFromAccount/);
  assert.match(sync, /remoteState\.isLoading \|\| remoteState\.isSaving \|\| remoteState\.isSubmitting/);
});

test("保存はフォームsubmitだけで発火し、保存ボタンのclick経路を二重登録しない", () => {
  assert.equal((script.match(/getElementById\("predictionForm"\)\.addEventListener\("submit", handlePredictionSubmit\)/g) || []).length, 1);
  assert.doesNotMatch(script, /savePredictionButton[^\n]*addEventListener/);
});

test("アカウントの予想は端末予想がない場合だけ自動復元する", () => {
  const sync = sourceForFunction("syncPredictionFromAccount");
  assert.match(sync, /remoteState\.prediction && !state\.prediction/);
  assert.match(sync, /saveToStorage\(STORAGE_KEYS\.prediction, state\.prediction\)/);
});
