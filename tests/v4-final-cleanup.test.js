import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("2026-09-27 Marines vs FightersはNPB canonical code m-f-23を使う", () => {
  const schedule = JSON.parse(fs.readFileSync(path.join(root, "game-schedule-2026.json"), "utf8"));
  const game = schedule.find((entry) => entry.date === "2026-09-27" && entry.homeTeam === "marines" && entry.awayTeam === "fighters");
  assert.ok(game);
  assert.equal(game.gameId, "2026-09-27-m-f-23");
  assert.equal(game.round, 23);
  assert.match(game.npbScoreUrl, /\/0927\/m-f-23\//);
});

test("V4候補UIは入力ズームを維持し、通常のviewport操作を使う", () => {
  const html = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
  assert.doesNotMatch(html, /user-scalable\s*=\s*["']?no/i);
  assert.doesNotMatch(html, /maximum-scale\s*=\s*1(?:\.0+)?/i);
  assert.match(css, /\.manual-lineup-candidate,[\s\S]*\.manual-roster-candidate \{ touch-action: manipulation; \}/);
});

test("V4診断は自動取得停止を旧V3障害として扱わない", () => {
  const source = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-diagnostics.js"), "utf8");
  assert.match(source, /V4_MANUAL_ROSTER/);
  assert.match(source, /自動取得OFF \/ 手動スタメン運用 \/ 手動確定待ち/);
  assert.match(source, /canonical\?\.lineupReady === true/);
});
