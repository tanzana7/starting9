import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("public mobile prediction layout keeps order and roster in two panes", () => {
  assert.match(html, /style\.css\?v=public-mobile-two-pane-prediction-trial-1/);
  assert.match(html, /class="lineup-builder"/);
  assert.match(html, /id="predictionLineup" class="slot-list"/);
  assert.match(html, /id="predictionPlayers" class="player-list"/);
  assert.match(
    css,
    /@media \(max-width: 767px\)[\s\S]*?\.lineup-builder \{[\s\S]*?grid-template-columns: minmax\(0, 44fr\) minmax\(0, 56fr\)/,
  );
  assert.match(css, /max-height: min\(72vh, 620px\)/);
  assert.match(css, /overflow-y: auto/);
  assert.match(css, /\.player-list \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /min-height: 44px/);
});

test("desktop public player list remains a two-column grid", () => {
  assert.match(
    css,
    /@media \(min-width: 900px\)[\s\S]*?\.player-list \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)/,
  );
});
