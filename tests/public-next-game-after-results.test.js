import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("公開済み試合では結果導線を表示し、予想入力面を分ける", () => {
  for (const id of ["publishedGameActions", "publishedGameMessage", "showSelectedResultButton", "selectNextPredictionGameButton", "predictionEditor"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(script, /function renderPublicPredictionSurface\(selectedGame, view\)/);
  assert.match(script, /editor\.classList\.toggle\("hidden", published\)/);
  assert.match(script, /actions\.classList\.toggle\("hidden", !published\)/);
  assert.match(script, /この試合の予想受付は終了しました。/);
  assert.match(html, /結果を見る/);
  assert.match(html, /次の試合を予想する/);
});

test("次戦は既存カタログと締切判定から選び、公開済み試合を避ける", () => {
  assert.match(script, /function findNextPredictionGame\(now = new Date\(\)\)/);
  assert.match(script, /getPublicSelectableGames\(state\.publicGameCatalog\.games, now\)/);
  assert.match(script, /!isPublicGamePublished\(game\)/);
  assert.match(script, /resolvePredictionDeadline\(gameId, now\)\.status === "open"/);
  assert.match(script, /async function selectNextPredictionGame\(\)/);
  assert.match(script, /await selectPublicGame\(nextGame\.internalGameId \|\| nextGame\.gameId/);
});

test("公開済み選択時の結果表示と通常の予想CTAを自然な文言へ切り替える", () => {
  assert.match(script, /function showSelectedResult\(\)/);
  assert.match(script, /scoreResult"\)\?\.scrollIntoView/);
  assert.match(script, /button\.textContent = published \? "次の試合を予想する"/);
  assert.match(script, /function handlePredictionCtaClick\(\)/);
  assert.match(html, /<h2 id="result-title">最新の採点結果<\/h2>/);
  assert.match(script, /<p class="result-label">合計点<\/p>/);
  assert.match(script, /perfectLabel: result\.total === SCORE_MAX \? "完全一致"/);
});

test("通常画面の結果と履歴は内部識別子を表示せず、モバイルでは操作ボタンを縦積みにする", () => {
  const publicMarkup = html.slice(0, html.indexOf('<details id="adminDetails"'));
  for (const internalLabel of ["internalGameId", "UUID", "Cron", "diagnostics", "reasonCode", "schema"]) {
    assert.doesNotMatch(publicMarkup, new RegExp(internalLabel, "i"));
  }
  assert.match(script, /data-result-game-id="\$\{escapeHtml\(gameId\)\}"/);
  assert.doesNotMatch(script.slice(script.indexOf("function renderResultHistory"), script.indexOf("function buildCurrentPredictionApiUrl")), /: game\.gameId/);
  assert.match(css, /\.published-game-actions-buttons \{[\s\S]*display: grid;[\s\S]*grid-template-columns: 1fr;/);
});

test("通常画面の次戦導線は新しいscript cache busterで配信する", () => {
  assert.match(html, /script\.js\?v=public-next-game-after-results-1/);
});
