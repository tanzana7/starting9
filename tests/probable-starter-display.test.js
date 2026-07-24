const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");

test("予告先発は未発表と取得失敗を異なる案内として表示する", () => {
  assert.match(script, /status = "unannounced"/);
  assert.match(script, /現在、次の試合の予告先発はまだ発表されていません。/);
  assert.match(script, /発表され次第、自動で表示されます。/);
  assert.match(script, /probableStarter\.status === "error"/);
  assert.match(script, /予告先発を取得できませんでした。/);
  assert.match(script, /次回の自動更新で再試行します。/);
});

test("予告先発カードは発表済み・未発表・失敗で同じ表示領域を維持する", () => {
  assert.match(script, /isPending \? "is-pending" : "is-success"/);
  assert.match(css, /\.probable-starter-card[\s\S]*?min-height: 128px/);
  assert.match(css, /\.probable-starter-card\.is-error/);
});
