import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");

test("public mobile prediction layout keeps order and roster in two panes", () => {
  assert.match(html, /style\.css\?v=public-saved-lineup-tight-spacing-1/);
  assert.match(html, /class="lineup-builder"/);
  assert.match(html, /id="predictionLineup" class="slot-list"/);
  assert.match(html, /id="predictionPlayers" class="player-list"/);
  assert.match(
    css,
    /@media \(max-width: 767px\)[\s\S]*?\.lineup-builder \{[\s\S]*?grid-template-columns: minmax\(0, 60fr\) minmax\(0, 40fr\)/,
  );
  assert.match(css, /max-height: min\(72vh, 620px\)/);
  assert.match(css, /overflow-y: auto/);
  assert.match(css, /\.player-list \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /grid-template-columns: 28px minmax\(0, 1fr\) 40px auto/);
  assert.match(css, /grid-template-areas: "order player position clear"/);
});

test("mobile drag feedback and position menu stay within the viewport", () => {
  assert.match(script, /function createMobileDragGhost\(interaction\)/);
  assert.match(script, /function updateMobileDragGhost\(interaction, clientX, clientY\)/);
  assert.match(script, /function clearMobileDragGhost\(interaction\)/);
  assert.match(script, /createMobileDragGhost\(interaction\)/);
  assert.match(script, /clearMobileDragGhost\(interaction\)/);
  assert.match(script, /const ghostOffset = 40/);
  assert.match(script, /clientX - ghost\.offsetWidth \/ 2/);
  assert.match(script, /clientY - ghost\.offsetHeight - ghostOffset/);
  assert.match(script, /Math\.max\(viewportPadding, preferredLeft\)/);
  assert.match(script, /Math\.max\(viewportPadding, preferredTop\)/);
  assert.match(script, /function positionMobilePositionMenu\(menu, button\)/);
  assert.match(script, /window\.innerWidth - menuRect\.width - viewportPadding/);
  assert.match(css, /\.mobile-drag-ghost \{/);
  assert.match(css, /\.position-menu\.is-mobile-position-menu \{/);
  assert.match(css, /max-width: calc\(100vw - 16px\)/);
  assert.match(css, /\.player-panel \{[\s\S]*?display: flex;[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.player-panel \.player-list \{[\s\S]*?overflow: hidden auto;[\s\S]*?-webkit-overflow-scrolling: touch;/);
});

test("mobile player list header and tabs stay compact above the first card", () => {
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.player-panel \{[\s\S]*?padding: 2px 6px 6px/);
  assert.match(css, /\.player-panel \.roster-filter \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)/);
  assert.match(css, /\.player-panel \.roster-filter-button \{[\s\S]*?min-width: 0;[\s\S]*?min-height: 44px/);
});

test("desktop public player list remains a two-column grid", () => {
  assert.match(
    css,
    /@media \(min-width: 900px\)[\s\S]*?\.player-list \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)/,
  );
});

test("mobile roster controls sit above an independent player list frame", () => {
  assert.match(html, /class="player-list-frame"/);
  assert.match(
    css,
    /@media \(max-width: 767px\)[\s\S]*?\.player-panel \{[\s\S]*?border: 0;[\s\S]*?background: transparent;/,
  );
  assert.match(css, /\.player-list-frame \{[\s\S]*?border: 1px solid var\(--border\)/);
  assert.match(
    css,
    /\.player-list-frame \.player-list \{[\s\S]*?overflow: hidden auto;[\s\S]*?-webkit-overflow-scrolling: touch;/,
  );
});
