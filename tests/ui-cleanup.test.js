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
  assert.match(html, /id="result-title">最新の採点結果/);
});

test("年間ランキングはサービス開始年より前と当年より後へ移動するボタンを描画しない", () => {
  const script = read("script.js");

  assert.match(script, /const RANKING_SERVICE_START_YEAR = 2026/);
  assert.match(script, /nextYear >= RANKING_SERVICE_START_YEAR && nextYear <= currentYear/);
  assert.match(script, /canMoveToPreviousYear \? '<button[^']*data-yearly-ranking-move="-1"[^']*>前年<\/button>' : '<span aria-hidden="true"><\/span>'/);
  assert.match(script, /canMoveToNextYear \? '<button[^']*data-yearly-ranking-move="1"[^']*>翌年<\/button>' : '<span aria-hidden="true"><\/span>'/);
  assert.doesNotMatch(script, /data-yearly-ranking-move="-1"\$\{ranking\.year <= YEARLY_RANKING_MIN_YEAR \? " disabled"/);
  assert.match(read("style.css"), /grid-template-columns: minmax\(0, 1fr\) minmax\(120px, auto\) minmax\(0, 1fr\)/);
});
