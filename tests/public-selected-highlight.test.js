const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const publicScript = fs.readFileSync(path.join(root, "script.js"), "utf8");

test("通常画面の選択中スロットは黄色系で表示する", () => {
  assert.match(
    css,
    /body:not\(:has\(\.app-layout\.is-admin-screen\)\):has\(#predictionForm\) #predictionForm \.lineup-slot\.is-active,[\s\S]*body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.lineup-slot\.is-active\s*\{[\s\S]*border-color: #d5a11e;[\s\S]*background: #fff8e5;[\s\S]*outline: 1px solid rgba\(213, 161, 30, 0\.45\);/
  );
  assert.match(publicScript, /slot\.classList\.toggle\("is-active", state\.activeOrder\[pickerName\] === index\)/);
  assert.match(html, /style\.css\?v=[^"']*public-selected-highlight-1/);
});

test("選択中表示と打席左右ラインの色定義は独立して共存する", () => {
  assert.match(css, /\.lineup-slot:has\(\.player-name--bat-right\)::before[\s\S]*background: #d64545/);
  assert.match(css, /\.lineup-slot:has\(\.player-name--bat-left\)::before[\s\S]*background: #2878c8/);
  assert.match(css, /\.lineup-slot:has\(\.player-name--bat-switch\)::before[\s\S]*background: #2f9a62/);
  assert.match(
    css,
    /body:not\(:has\(\.app-layout\.is-admin-screen\)\) \.lineup-slot\.is-active\s*\{[\s\S]*background: #fff8e5;/
  );
});

test("通常画面の守備位置メニューの現在値も黄色系で表示する", () => {
  assert.match(
    css,
    /body:not\(:has\(\.app-layout\.is-admin-screen\)\):has\(#predictionForm\) #predictionForm \.position-menu-option\.is-current\s*\{[\s\S]*border-color: #d5a11e;[\s\S]*background: #fff8e5;/
  );
});
