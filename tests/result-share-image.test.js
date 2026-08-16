const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const style = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("共有ハッシュタグはlovefightersとstarting9だけに統一される", () => {
  assert.match(script, /const SHARE_HASHTAGS = "#lovefighters #starting9"/);
  assert.match(script, /createPredictionShareText[\s\S]*SHARE_HASHTAGS/);
  assert.match(script, /createResultShareText[\s\S]*SHARE_HASHTAGS/);
  assert.doesNotMatch(script, /#日ハム|#スタメン予想|#fighters|#npb|#Starting9/);
});

test("結果共有UIに画像生成・保存・コピー・画像共有の導線がある", () => {
  assert.match(html, /id="resultSharePreview"[^>]*class="result-share-preview hidden"/);
  assert.match(html, /id="resultSharePreviewImage"[^>]*alt="結果共有画像プレビュー"/);
  assert.match(html, /id="generateResultImageButton"[^>]*>画像を再生成/);
  assert.match(html, /id="saveResultImageButton"[^>]*>結果画像を保存/);
  assert.match(html, /id="copyResultShareTextButton"[^>]*>投稿文をコピー/);
  assert.match(html, /id="shareResultImageButton"[^>]*>画像を共有/);
  assert.match(script, /addEventListener\("click", generateResultShareImage\)/);
  assert.match(script, /addEventListener\("click", saveResultShareImage\)/);
  assert.match(script, /addEventListener\("click", copyResultShareText\)/);
  assert.match(script, /void autoGenerateResultShareImage\(\)/);
  assert.match(script, /function autoGenerateResultShareImage\(\)/);
  assert.match(script, /renderResultShareImagePreview\(resultShareImageBlob\)/);
});

test("結果画像はCanvasの1200x630 PNGとして必要情報を描画する", () => {
  assert.match(script, /function drawResultShareImage\(canvas, result\)/);
  assert.match(script, /canvas\.width = width/);
  assert.match(script, /const width = 1200/);
  assert.match(script, /const height = 630/);
  assert.match(script, /canvas\.toBlob\([\s\S]*"image\/png"/);
  assert.match(script, /Starting9/);
  assert.match(script, /getResultShareGameMeta/);
  assert.match(script, /viewModel\.total/);
  assert.match(script, /getResultShareRows/);
  assert.match(script, /SHARE_HASHTAGS/);
  assert.match(script, /viewModel\.perfectLabel/);
});

test("画像共有はWeb Share APIの非対応時に保存・コピーへfallbackする", () => {
  assert.match(script, /navigator\.canShare\(\{ files: \[file\] \}\)/);
  assert.match(script, /navigator\.share\(\{[\s\S]*files: \[file\]/);
  assert.match(script, /saveResultShareImage\(\);[\s\S]*copyResultShareText\(\)/);
  assert.match(script, /画像を保存して、Xに貼り付けて投稿してください/);
  assert.doesNotMatch(script, /X API|oauth|OAuth|外部アップロード/);
});

test("共有UIは公開画面で折り返し可能で、モバイル横幅を圧迫しない", () => {
  assert.match(style, /\.result-share-actions\s*\{/);
  assert.match(style, /flex-wrap:\s*wrap/);
  assert.match(style, /\.result-share-actions button[\s\S]*min-width:\s*0/);
  assert.match(style, /@media \(max-width: 759px\)[\s\S]*\.result-share-actions button/);
  assert.match(html, /public-auto-render-result-share-image-1/);
});
