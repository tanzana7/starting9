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

test("公開ランキングは週間の開始週より前へ移動できず、月間・年間を表示しない", () => {
  const script = read("script.js");

  assert.match(script, /const firstServiceWeek = "2026-09-21"/);
  assert.match(script, /if \(nextWeek < firstServiceWeek \|\| nextWeek > currentWeek\.startAt\) return/);
  assert.match(script, /if \(view !== "weekly"\) return/);
  assert.doesNotMatch(read("index.html"), /showMonthlyRankingButton|showYearlyRankingButton/);
  assert.match(read("style.css"), /grid-template-columns: minmax\(0, 1fr\) minmax\(120px, auto\) minmax\(0, 1fr\)/);
});
