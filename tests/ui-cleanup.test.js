import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("通常画面は開発用エリア見出しと番号バッジを表示しない", () => {
  const html = read("index.html");
  const css = read("style.css");

  assert.doesNotMatch(html, /プレイヤー用エリア|結果表示エリア|>PLAYER<|>RESULT</);
  assert.doesNotMatch(html, /class="step-badge/);
  assert.doesNotMatch(css, /\.step-badge|\.admin-step|\.area-heading|\.result-area-heading/);
  assert.match(html, /id="prediction-title">スタメン予想入力/);
  assert.match(html, /id="saved-title">あなたの予想/);
  assert.match(html, /id="result-title">前回の採点結果/);
});

test("公開画面は期間別ランキングの取得と切替を持たない", () => {
  const script = read("script.js");

  assert.doesNotMatch(script, /\/api\/rankings\/(weekly|monthly|yearly)|data-(weekly|monthly)-ranking-move/);
  assert.doesNotMatch(read("index.html"), /rankingPanel|showWeeklyRankingButton|showMonthlyRankingButton|showYearlyRankingButton/);
});
