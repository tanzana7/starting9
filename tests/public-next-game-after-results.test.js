import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("公開済み試合の結果導線は結果セクションに残し、メイン予想欄には置かない", () => {
  for (const id of ["publishedGameActions", "publishedGameMessage", "showSelectedResultButton", "selectNextPredictionGameButton"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="predictionEditor"/);
  assert.match(script, /function renderPublicPredictionSurface\(selectedGame\)/);
  assert.match(script, /if \(!selectedGame\) \{/);
  assert.match(script, /if \(editor\) editor\.classList\.remove\("hidden"\)/);
  assert.doesNotMatch(script, /findResultHistoryGameForPublicGame|selectNextPredictionGame/);
});

test("メイン予想対象は公開済み・締切済み試合を避け、canonicalな受付可能試合だけを選ぶ", () => {
  assert.match(script, /function selectInitialPublicGame\(games = \[\], now = new Date\(\)\)/);
  assert.match(script, /!isPublicGamePublished\(game\)/);
  assert.match(script, /resolvePredictionDeadline\(game\.internalGameId \|\| game\.gameId, now\)\.status === "open"/);
  assert.match(script, /return todayUpcoming \|\| todayOpen \|\| nextOpen \|\| null/);
  assert.doesNotMatch(script, /selectNextPredictionGame|applyPublicPredictionTarget/);
});

test("通常の予想CTAは現在のcanonical予想対象だけへスクロールする", () => {
  assert.match(script, /button\.classList\.toggle\("hidden", !isLoggedIn \|\| !selectedGame\)/);
  assert.match(script, /button\.textContent = hasPrediction \? "予想を編集する" : "この試合を予想する"/);
  assert.match(script, /function handlePredictionCtaClick\(\)/);
  assert.match(script, /scrollToPredictionForm\(\);/);
  assert.doesNotMatch(script, /次の試合を予想する/);
  assert.match(html, /<h2 id="result-title">前回の採点結果<\/h2>/);
  assert.match(script, /<p class="result-label">合計点<\/p>/);
  assert.match(script, /perfectLabel: result\.total === SCORE_MAX \? "完全一致"/);
});

test("通常画面の結果と履歴は内部識別子を表示せず、メイン予想欄から独立する", () => {
  const publicMarkup = html;
  for (const internalLabel of ["internalGameId", "UUID", "Cron", "diagnostics", "reasonCode", "schema"]) {
    assert.doesNotMatch(publicMarkup, new RegExp(internalLabel, "i"));
  }
  assert.match(script, /data-result-history-toggle/);
  assert.match(script, /data-result-history-select/);
  assert.doesNotMatch(script.slice(script.indexOf("function renderResultHistory"), script.indexOf("function buildCurrentPredictionApiUrl")), /: game\.gameId/);
  assert.doesNotMatch(css, /published-game-actions/);
});

test("通常画面の次戦導線は新しいscript cache busterで配信する", () => {
  assert.match(html, /script\.js\?v=public-result-image-design-f-balance-1/);
});
