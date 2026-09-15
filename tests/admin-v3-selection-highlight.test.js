import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manual lineupの選択中候補は黄色で左右端を示し、打席左右ラインと分離される", () => {
  const renderer = fs.readFileSync(path.join(root, "frontend", "admin-v3", "render-manual-lineup.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
  const page = fs.readFileSync(path.join(root, "admin-v3.html"), "utf8");

  assert.match(renderer, /manual-lineup-candidate\$\{selectedPlayer \? " selected" : ""\}/);
  assert.match(css, /\.manual-lineup-candidate\.selected\s*\{[\s\S]*border-color: #d5a52e[\s\S]*background: #fff8d6/);
  assert.match(css, /\.manual-lineup-candidate\.selected::before[\s\S]*\.manual-lineup-candidate\.selected::after/);
  assert.match(css, /\.manual-lineup-candidate\.selected \{[\s\S]*color: #654b0c/);
  assert.match(css, /\.manual-lineup-candidate:hover\s*\{[\s\S]*#eaf3fb/);
  assert.match(css, /\.manual-lineup-slot-player:has\(\.player-name--bat-right\)::before[\s\S]*background: #d64545/);
  assert.match(css, /\.manual-lineup-slot-player:has\(\.player-name--bat-left\)::before[\s\S]*background: #2878c8/);
  assert.match(css, /\.manual-lineup-slot-player:has\(\.player-name--bat-switch\)::before[\s\S]*background: #2f9a62/);
  assert.match(page, /admin-v3\.css\?v=.*-compact-parity-1/);
});

test("manual lineupはスマホ幅の1列レイアウトを維持する", () => {
  const css = fs.readFileSync(path.join(root, "admin-v3.css"), "utf8");
  assert.match(css, /\.manual-lineup-grid\s*\{\s*grid-template-columns: 1fr;/);
});
