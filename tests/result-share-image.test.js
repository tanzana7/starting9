const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const resultsRenderer = fs.readFileSync(path.join(root, "frontend", "public", "render-results.js"), "utf8");

test("予想共有のハッシュタグはlovefightersとstarting9だけに統一される", () => {
  assert.match(script, /const SHARE_HASHTAGS = "#lovefighters #starting9"/);
  assert.match(script, /createPredictionShareText[\s\S]*SHARE_HASHTAGS/);
  assert.doesNotMatch(script, /#日ハム|#スタメン予想|#fighters|#npb|#Starting9/);
});

test("結果発表エリアから共有UIと共有ボタンを除去する", () => {
  assert.doesNotMatch(html, /id="shareResultButton"/);
  assert.doesNotMatch(html, /resultShareActions|resultSharePreview|resultSharePreviewImage/);
  assert.doesNotMatch(html, /generateResultImageButton|saveResultImageButton|shareResultImageButton|copyResultShareTextButton|resultShareMessage/);
  assert.doesNotMatch(script, /shareResultButton|autoGenerateResultShareImage|generateResultShareImage|saveResultShareImage|shareResultImage|copyResultShareText/);
  assert.doesNotMatch(script, /function createResultShareText|function shareResult/);
});

test("結果描画は共有UIから独立して通常結果を維持できる", () => {
  assert.doesNotMatch(resultsRenderer, /shareResultButton|resultShare/);
  assert.match(resultsRenderer, /createResultView\(deps\.createResultViewModel\(displayedResult\)\)/);
});

test("結果共有用Canvas・Web Share処理は公開画面から呼び出されない", () => {
  assert.doesNotMatch(script, /drawResultShareImage|createResultShareImageBlob|navigator\.share|navigator\.canShare/);
  assert.doesNotMatch(html, /結果をXで共有|結果画像|画像を再生成|画像を共有|投稿文をコピー|共有画像/);
});
