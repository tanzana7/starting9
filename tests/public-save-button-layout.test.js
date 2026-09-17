const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("公開予想の保存ボタンだけを広げ、アクション領域を下げる", () => {
  assert.match(html, /style\.css\?v=[^"']*public-save-button-layout-1/);
  assert.match(css, /#savePredictionButton\s*\{[\s\S]*?width: min\(100%, 400px\);[\s\S]*?margin-top: 40px;/);
  assert.match(css, /#resetPredictionButton\s*\{[\s\S]*?margin-top: 36px;/);
  assert.match(css, /@media \(min-width: 1000px\)[\s\S]*?#savePredictionButton,[\s\S]*?#resetPredictionButton\s*\{[\s\S]*?margin-top: 24px;/);
});

test("保存ボタン調整は既存の入力領域寸法・構成を変更しない", () => {
  assert.match(css, /#predictionForm #predictionLineup[\s\S]*?min-height: 55px;/);
  assert.match(css, /\.player-list \.player-chip[\s\S]*?min-height: 51px;/);
  assert.match(css, /\.lineup-builder[\s\S]*?grid-template-columns: minmax\(380px, 480px\) minmax\(320px, 1fr\)/);
  assert.match(html, /id="savePredictionButton"[^>]*>予想を保存する/);
  assert.match(html, /id="resetPredictionButton"[^>]*>予想をリセット/);
});
