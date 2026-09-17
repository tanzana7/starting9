const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const predictionForm = fs.readFileSync(path.join(root, "frontend", "public", "prediction-form.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

function sourceForFunction(source, name) {
  const start = source.indexOf(`function ${name}(`) !== -1
    ? source.indexOf(`function ${name}(`)
    : source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} が見つかりません`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("public候補の詳細導線は選手名を主役にし、選択と分離されている", () => {
  assert.match(script, /detailButton\.className = "player-chip-detail-button"/);
  assert.match(script, /detailButton\.textContent = "詳細"/);
  assert.match(script, /detailButton\.addEventListener\("pointerdown", \(event\) => event\.stopPropagation\(\)\)/);
  assert.match(script, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*if \(!button\.disabled\) showPlayerDetails/);
  assert.match(css, /#predictionForm \.player-chip-detail-button[\s\S]*?opacity: 0\.78/);
});

test("締切表示は残り時間、締切日時、試合開始までの順で同じ計算値を使う", () => {
  const deadline = sourceForFunction(script, "renderPredictionDeadline");
  assert.ok(deadline.indexOf("deadline-countdown-primary") < deadline.indexOf("deadline-time"));
  assert.ok(deadline.indexOf("deadline-time") < deadline.indexOf("deadline-start"));
  assert.match(deadline, /formatPublicRemainingTime\(deadline\.deadlineAt\)/);
  assert.match(deadline, /formatPublicJstDateTime|formatPredictionDeadlineDateTime/);
  assert.match(deadline, /formatPublicRemainingTime\(deadline\.startAt\)/);
  assert.match(css, /\.deadline-countdown-primary/);
});

test("保存状態は既存remote stateを使い、送信中表示と成功チェックを持つ", () => {
  const submit = sourceForFunction(predictionForm, "handleSubmit");
  const save = sourceForFunction(script, "savePredictionToAccount");
  const status = sourceForFunction(script, "isCurrentPredictionSaved");
  assert.match(submit, /deps\.showPredictionSaveMessage\("予想を保存しました。 ✓"\)/);
  assert.match(script, /button\.textContent = isSaving \|\| isSubmitting \? "保存中\.\.\."/);
  assert.match(save, /state\.predictionRemote\.isSaving = true/);
  assert.match(save, /state\.predictionRemote\.isSaving = false/);
  assert.match(status, /predictionsMatch\(\{ lineup: getLineupValues\("prediction"\) \}, savedPrediction\)/);
  assert.match(script, /clearPredictionSaveMessageIfDraftChanged/);
});

test("試合切替通知は描画後に消費され、通常再描画で繰り返さない", () => {
  const notice = sourceForFunction(script, "renderPredictionTargetNotice");
  assert.match(notice, /container\.textContent = message/);
  assert.match(notice, /state\.predictionTargetNotice = ""/);
});

test("空の公開フォームメッセージ行は余白を作らず、admin側へ波及しない", () => {
  assert.match(css, /body:not\(:has\(\.app-layout\.is-admin-screen\)\):has\(#predictionForm\) #predictionForm > \.message:empty/);
  assert.match(html, /style\.css\?v=[^"']*public-prediction-ux-polish-1/);
  assert.match(html, /frontend\/public\/prediction-form\.js\?v=[^"']*public-prediction-ux-polish-1/);
  assert.match(html, /script\.js\?v=[^"']*public-prediction-ux-polish-1/);
});
